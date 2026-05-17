// src/drift-supersession.js
//
// Wave 167 (M+3 + M+4) — drift detection + supersession chain. The lifecycle
// roadmap Wave 144 Doc 3 §7 named four tiers; M+3 and M+4 close them:
//
//   M+1 (W14x)  - stale notification (artifact age vs ship date)
//   M+2 (W14x)  - re-distillation cadence (configurable per recipe)
//   M+3         - DRIFT DETECTION cron (this module, drift half)
//   M+4         - SUPERSESSION CHAIN (this module, supersession half)
//
// The two halves are tightly coupled by design: a drift detection job
// produces a DriftReport; when the report's status is 'breach' a tenant
// re-distills the recipe and ships a new artifact carrying a
// SupersessionBlock that names the predecessor's artifact_hash plus the
// reason ('drift_detected') plus the failing drift signals. A third-party
// verifier walking the supersession chain can confirm: (a) the predecessor
// existed and verified at the time it was superseded, (b) the new artifact
// is a legitimate successor (signed by the same builder or by an entity
// authorized in the predecessor's lineage), and (c) the reason given for
// supersession (drift, security patch, etc.) is accompanied by enough
// evidence to justify retiring the predecessor.
//
// What this module ships:
//
//   SUPERSESSION (M+4):
//     buildSupersessionBlock     - build a supersession block for embedding
//                                  in a new artifact's manifest
//     validateSupersessionBlock  - re-validate a block from the wire
//     snapshotFromManifest       - extract a portable drift snapshot from
//                                  a manifest (used by both halves)
//
//   DRIFT (M+3):
//     buildDriftSnapshot         - build a portable K-score snapshot
//     validateDriftSnapshot      - re-validate snapshot from the wire
//     detectDrift                - compare two snapshots, return signals
//     buildDriftReport           - build a drift report
//     validateDriftReport        - re-validate report from the wire
//     writeDriftReport           - persist to disk
//     loadDriftReport            - load from disk
//
//   CRON (M+3 scheduler scaffold):
//     buildDriftCronConfig       - emit a JSON config a tenant can drop
//                                  into their OS scheduler (cron, systemd
//                                  timer, k8s CronJob) — does NOT itself
//                                  fork a daemon
//     validateDriftCronConfig    - re-validate config from the wire
//     toCrontabLine              - emit a crontab-syntax line invoking
//                                  `kolm drift detect ... > out.json`
//
// Honest scope: this module BUILDS, VALIDATES, COMPARES, and EMITS scheduler
// scaffolding. It does NOT itself fork a daemon, schedule an OS job, or
// re-run a distillation pipeline. Those are downstream concerns — kolm
// gives the tenant the manifest blocks + verifier semantics + scheduler
// config; the tenant wires it into their own cron / k8s / systemd. This
// keeps kolm pure: every effect a tenant relies on is captured by a
// manifest field and a verifier check that re-derives that field.

import fs from 'node:fs';
import crypto from 'node:crypto';

export const SUPERSESSION_SPEC_VERSION = 'supersession-v1';
export const DRIFT_SNAPSHOT_SPEC_VERSION = 'drift-snapshot-v1';
export const DRIFT_REPORT_SPEC_VERSION = 'drift-report-v1';
export const DRIFT_CRON_SPEC_VERSION = 'drift-cron-v1';

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;

// Reasons a new artifact can declare for superseding a previous one. Kept
// short and explicit so a verifier can reason about the chain without
// parsing free text.
export const SUPERSESSION_REASONS = Object.freeze([
  'drift_detected',     // M+3 detected breach; predecessor's K-score axes
                        //   moved past tolerance against a tenant baseline
  'scheduled_rebuild',  // M+2 cadence triggered routine re-distillation
  'security_patch',     // upstream model/runtime CVE; retire stale weights
  'recipe_revision',    // spec.json changed shape; not a pure retrain
  'policy_change',      // legal/compliance policy update (e.g., new redactor
                        //   class, license terms shift, regulator request)
  'tenant_request',     // explicit tenant or operator command
]);

// Drift signal status. 'within' is the noop; 'drift' means the value moved
// but stayed inside the configured warn band; 'breach' means it left the
// configured fail band (the actionable case).
export const DRIFT_STATUSES = Object.freeze(['within', 'drift', 'breach']);

// Default tolerances. eval_score is the tightest because it's a normalized
// scalar in [0, 1]. composite is sum of weighted axes so float noise across
// architectures can shift it by 1e-4 even with bit-identical recompute.
// Holdout hashes use 'exact' comparison (any byte change = breach) because
// they identify the corpus the score was computed over.
export const DEFAULT_TOLERANCES = Object.freeze({
  eval_score: { warn: 0.02, fail: 0.05 },
  k_score_composite: { warn: 0.03, fail: 0.08 },
  k_score_axis: { warn: 0.05, fail: 0.10 },
  external_holdout_hash: { mode: 'exact' },
  tenant_shadow_corpus_hash: { mode: 'exact' },
  artifact_hash: { mode: 'exact-information' },
});

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');
}

function blockHash(obj) {
  const { hash: _ignored, ...rest } = obj;
  return sha256Hex(canonicalJson(rest));
}

// ---------------------------------------------------------------------------
// Supersession block (M+4).
//
// Embedded in a new artifact's manifest as manifest.supersession_provenance.
// Names exactly ONE predecessor artifact_hash (chains form by walking
// predecessor → predecessor.supersession_provenance.predecessor_artifact_hash
// recursively until the genesis artifact). A predecessor's CID is optional
// — when present a tenant can fetch the predecessor binder from IPFS to
// confirm it actually verified before being superseded.
//
// drift_signals is an OPTIONAL array of objects, populated when
// reason === 'drift_detected'. Each entry mirrors the DriftReport signal
// shape (axis, baseline, current, delta, status) so the supersession block
// is self-contained — a verifier doesn't need the original DriftReport
// JSON to understand WHY the supersession happened.
// ---------------------------------------------------------------------------

export function buildSupersessionBlock(input = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('supersession input must be object');
  }
  const allowedFields = new Set([
    'predecessor_artifact_hash', 'predecessor_cid', 'reason',
    'supersession_date', 'drift_signals', 'drift_report_hash',
    'authorized_by', 'notes',
  ]);
  for (const k of Object.keys(input)) {
    if (!allowedFields.has(k)) {
      throw new Error(`unknown supersession field: ${k}`);
    }
  }
  if (!input.predecessor_artifact_hash) {
    throw new Error('supersession.predecessor_artifact_hash required');
  }
  if (!HEX64.test(input.predecessor_artifact_hash)) {
    throw new Error('supersession.predecessor_artifact_hash must be hex64');
  }
  if (!input.reason) {
    throw new Error('supersession.reason required');
  }
  if (!SUPERSESSION_REASONS.includes(input.reason)) {
    throw new Error(`unknown supersession.reason: ${input.reason} (valid: ${SUPERSESSION_REASONS.join(', ')})`);
  }
  if (!input.supersession_date) {
    throw new Error('supersession.supersession_date required (ISO 8601)');
  }
  if (typeof input.supersession_date !== 'string') {
    throw new Error('supersession.supersession_date must be string');
  }
  // Parse loose ISO 8601; reject if Date can't parse.
  if (Number.isNaN(Date.parse(input.supersession_date))) {
    throw new Error('supersession.supersession_date not parseable as ISO 8601');
  }
  const out = {
    spec: SUPERSESSION_SPEC_VERSION,
    predecessor_artifact_hash: input.predecessor_artifact_hash,
    reason: input.reason,
    supersession_date: input.supersession_date,
  };
  if (input.predecessor_cid) {
    if (typeof input.predecessor_cid !== 'string') {
      throw new Error('supersession.predecessor_cid must be string');
    }
    out.predecessor_cid = input.predecessor_cid;
  }
  if (input.drift_report_hash) {
    if (!HEX64.test(input.drift_report_hash)) {
      throw new Error('supersession.drift_report_hash must be hex64');
    }
    out.drift_report_hash = input.drift_report_hash;
  }
  if (input.authorized_by) {
    if (typeof input.authorized_by !== 'string') {
      throw new Error('supersession.authorized_by must be string');
    }
    if (!SAFE_ID.test(input.authorized_by)) {
      throw new Error('supersession.authorized_by must match SAFE_ID');
    }
    out.authorized_by = input.authorized_by;
  }
  if (input.drift_signals) {
    if (!Array.isArray(input.drift_signals)) {
      throw new Error('supersession.drift_signals must be array');
    }
    out.drift_signals = input.drift_signals.map((s, i) => {
      if (!s || typeof s !== 'object') {
        throw new Error(`supersession.drift_signals[${i}] must be object`);
      }
      if (!s.axis || typeof s.axis !== 'string') {
        throw new Error(`supersession.drift_signals[${i}].axis required`);
      }
      if (typeof s.baseline === 'undefined' || typeof s.current === 'undefined') {
        throw new Error(`supersession.drift_signals[${i}] requires baseline + current`);
      }
      if (!DRIFT_STATUSES.includes(s.status)) {
        throw new Error(`supersession.drift_signals[${i}].status invalid: ${s.status}`);
      }
      const signal = { axis: s.axis, baseline: s.baseline, current: s.current, status: s.status };
      if (typeof s.delta === 'number') signal.delta = s.delta;
      if (typeof s.tolerance_fail === 'number') signal.tolerance_fail = s.tolerance_fail;
      return signal;
    });
  }
  if (input.notes) {
    if (typeof input.notes !== 'string') {
      throw new Error('supersession.notes must be string');
    }
    out.notes = input.notes;
  }
  // reason-specific evidence requirements. drift_detected MUST carry
  // either drift_signals or drift_report_hash so the claim is auditable.
  if (out.reason === 'drift_detected' && !out.drift_signals && !out.drift_report_hash) {
    throw new Error("supersession.reason='drift_detected' requires drift_signals or drift_report_hash");
  }
  out.hash = blockHash(out);
  return out;
}

export function validateSupersessionBlock(block) {
  if (!block || typeof block !== 'object') {
    throw new Error('supersession block must be object');
  }
  if (block.spec !== SUPERSESSION_SPEC_VERSION) {
    throw new Error(`bad supersession spec: ${block.spec}`);
  }
  if (!HEX64.test(block.predecessor_artifact_hash || '')) {
    throw new Error('supersession.predecessor_artifact_hash invalid');
  }
  if (!SUPERSESSION_REASONS.includes(block.reason)) {
    throw new Error(`unknown supersession.reason: ${block.reason}`);
  }
  if (!block.supersession_date || Number.isNaN(Date.parse(block.supersession_date))) {
    throw new Error('supersession.supersession_date invalid');
  }
  if (block.reason === 'drift_detected' && !block.drift_signals && !block.drift_report_hash) {
    throw new Error("supersession.reason='drift_detected' missing evidence");
  }
  const expectedHash = blockHash(block);
  if (block.hash !== expectedHash) {
    throw new Error(`supersession block hash mismatch: expected ${expectedHash}, got ${block.hash}`);
  }
  return Object.freeze({ ...block });
}

// ---------------------------------------------------------------------------
// Drift snapshot (M+3).
//
// A portable record of every K-score-bearing field of a manifest at a
// point in time. Two snapshots (baseline + current) feed detectDrift to
// produce signals. snapshotFromManifest extracts one straight from a
// manifest in memory.
// ---------------------------------------------------------------------------

export function buildDriftSnapshot(input = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('drift snapshot input must be object');
  }
  if (!input.artifact_hash) {
    throw new Error('drift snapshot artifact_hash required');
  }
  if (!HEX64.test(input.artifact_hash)) {
    throw new Error('drift snapshot artifact_hash must be hex64');
  }
  if (!input.captured_at) {
    throw new Error('drift snapshot captured_at required');
  }
  const out = {
    spec: DRIFT_SNAPSHOT_SPEC_VERSION,
    artifact_hash: input.artifact_hash,
    captured_at: input.captured_at,
  };
  if (input.cid) out.cid = String(input.cid);
  if (typeof input.eval_score === 'number') out.eval_score = input.eval_score;
  if (input.k_score && typeof input.k_score === 'object') {
    out.k_score = {};
    if (typeof input.k_score.composite === 'number') {
      out.k_score.composite = input.k_score.composite;
    }
    if (input.k_score.axes && typeof input.k_score.axes === 'object') {
      out.k_score.axes = {};
      for (const [axis, val] of Object.entries(input.k_score.axes)) {
        if (typeof val === 'number') out.k_score.axes[axis] = val;
      }
    }
  }
  if (input.external_holdout_hash) {
    if (typeof input.external_holdout_hash !== 'string') {
      throw new Error('drift snapshot external_holdout_hash must be string');
    }
    out.external_holdout_hash = input.external_holdout_hash;
  }
  if (input.tenant_shadow_corpus_hash) {
    if (typeof input.tenant_shadow_corpus_hash !== 'string') {
      throw new Error('drift snapshot tenant_shadow_corpus_hash must be string');
    }
    out.tenant_shadow_corpus_hash = input.tenant_shadow_corpus_hash;
  }
  if (input.recipe_class) out.recipe_class = String(input.recipe_class);
  out.hash = blockHash(out);
  return out;
}

export function validateDriftSnapshot(snap) {
  if (!snap || typeof snap !== 'object') {
    throw new Error('drift snapshot must be object');
  }
  if (snap.spec !== DRIFT_SNAPSHOT_SPEC_VERSION) {
    throw new Error(`bad drift snapshot spec: ${snap.spec}`);
  }
  if (!HEX64.test(snap.artifact_hash || '')) {
    throw new Error('drift snapshot artifact_hash invalid');
  }
  const expectedHash = blockHash(snap);
  if (snap.hash !== expectedHash) {
    throw new Error(`drift snapshot hash mismatch: expected ${expectedHash}, got ${snap.hash}`);
  }
  return Object.freeze({ ...snap });
}

// Extract a snapshot from a manifest object. The third arg lets the caller
// override captured_at (default: now) for deterministic test fixtures.
export function snapshotFromManifest(manifest, receipt = null, opts = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('snapshotFromManifest requires manifest object');
  }
  const artifactHash = (receipt && receipt.artifact_hash)
    || manifest.artifact_hash
    || (manifest.__artifact_hash || null);
  if (!artifactHash || !HEX64.test(artifactHash)) {
    throw new Error('snapshotFromManifest: cannot find artifact_hash in manifest/receipt');
  }
  const capturedAt = opts.captured_at || new Date().toISOString();
  const input = {
    artifact_hash: artifactHash,
    captured_at: capturedAt,
  };
  if (manifest.cid) input.cid = manifest.cid;
  if (typeof manifest.eval_score === 'number') input.eval_score = manifest.eval_score;
  if (manifest.k_score && typeof manifest.k_score === 'object') {
    const ks = manifest.k_score;
    input.k_score = {};
    if (typeof ks.composite === 'number') input.k_score.composite = ks.composite;
    // collect every numeric top-level k_score field as an axis
    const axes = {};
    for (const [k, v] of Object.entries(ks)) {
      if (k === 'composite') continue;
      if (typeof v === 'number') axes[k] = v;
    }
    if (Object.keys(axes).length > 0) input.k_score.axes = axes;
  }
  if (manifest.external_holdout_provenance && manifest.external_holdout_provenance.hash) {
    input.external_holdout_hash = manifest.external_holdout_provenance.hash;
  }
  if (manifest.tenant_shadow_corpus_provenance) {
    const blocks = Array.isArray(manifest.tenant_shadow_corpus_provenance)
      ? manifest.tenant_shadow_corpus_provenance
      : [manifest.tenant_shadow_corpus_provenance];
    if (blocks.length > 0) {
      input.tenant_shadow_corpus_hash = sha256Hex(canonicalJson(
        blocks.map(b => ({ tenant_id: b.tenant_id, corpus_id: b.corpus_id, hash: b.hash }))
      ));
    }
  }
  if (manifest.artifact_class) input.recipe_class = manifest.artifact_class;
  return buildDriftSnapshot(input);
}

// ---------------------------------------------------------------------------
// Drift detection — compare two snapshots, emit signals.
// ---------------------------------------------------------------------------

function classify(delta, warnTh, failTh) {
  const abs = Math.abs(delta);
  if (abs >= failTh) return 'breach';
  if (abs >= warnTh) return 'drift';
  return 'within';
}

export function detectDrift(baselineSnap, currentSnap, userTolerances = {}) {
  validateDriftSnapshot(baselineSnap);
  validateDriftSnapshot(currentSnap);
  const tol = { ...DEFAULT_TOLERANCES, ...userTolerances };
  const signals = [];

  // eval_score axis
  if (typeof baselineSnap.eval_score === 'number' && typeof currentSnap.eval_score === 'number') {
    const delta = currentSnap.eval_score - baselineSnap.eval_score;
    const status = classify(delta, tol.eval_score.warn, tol.eval_score.fail);
    signals.push({
      axis: 'eval_score',
      baseline: baselineSnap.eval_score,
      current: currentSnap.eval_score,
      delta,
      tolerance_warn: tol.eval_score.warn,
      tolerance_fail: tol.eval_score.fail,
      status,
    });
  }

  // k_score.composite
  if (baselineSnap.k_score && currentSnap.k_score
      && typeof baselineSnap.k_score.composite === 'number'
      && typeof currentSnap.k_score.composite === 'number') {
    const delta = currentSnap.k_score.composite - baselineSnap.k_score.composite;
    const status = classify(delta, tol.k_score_composite.warn, tol.k_score_composite.fail);
    signals.push({
      axis: 'k_score.composite',
      baseline: baselineSnap.k_score.composite,
      current: currentSnap.k_score.composite,
      delta,
      tolerance_warn: tol.k_score_composite.warn,
      tolerance_fail: tol.k_score_composite.fail,
      status,
    });
  }

  // per-axis k_score (R, F, E, Z, T, A, S, L, C, V — whatever the manifest carries)
  if (baselineSnap.k_score && currentSnap.k_score
      && baselineSnap.k_score.axes && currentSnap.k_score.axes) {
    const allAxes = new Set([
      ...Object.keys(baselineSnap.k_score.axes),
      ...Object.keys(currentSnap.k_score.axes),
    ]);
    for (const axis of [...allAxes].sort()) {
      const b = baselineSnap.k_score.axes[axis];
      const c = currentSnap.k_score.axes[axis];
      if (typeof b !== 'number' || typeof c !== 'number') {
        signals.push({
          axis: `k_score.${axis}`,
          baseline: b ?? null,
          current: c ?? null,
          delta: null,
          status: 'drift',
          reason: 'axis present on one side but not the other',
        });
        continue;
      }
      const delta = c - b;
      const status = classify(delta, tol.k_score_axis.warn, tol.k_score_axis.fail);
      signals.push({
        axis: `k_score.${axis}`,
        baseline: b,
        current: c,
        delta,
        tolerance_warn: tol.k_score_axis.warn,
        tolerance_fail: tol.k_score_axis.fail,
        status,
      });
    }
  }

  // external_holdout_hash (exact)
  if (baselineSnap.external_holdout_hash || currentSnap.external_holdout_hash) {
    const b = baselineSnap.external_holdout_hash || null;
    const c = currentSnap.external_holdout_hash || null;
    const status = (b === c) ? 'within' : 'breach';
    signals.push({
      axis: 'external_holdout_hash',
      baseline: b,
      current: c,
      status,
      reason: status === 'breach' ? 'external holdout corpus identity changed' : undefined,
    });
  }

  // tenant_shadow_corpus_hash (exact)
  if (baselineSnap.tenant_shadow_corpus_hash || currentSnap.tenant_shadow_corpus_hash) {
    const b = baselineSnap.tenant_shadow_corpus_hash || null;
    const c = currentSnap.tenant_shadow_corpus_hash || null;
    const status = (b === c) ? 'within' : 'breach';
    signals.push({
      axis: 'tenant_shadow_corpus_hash',
      baseline: b,
      current: c,
      status,
      reason: status === 'breach' ? 'tenant shadow corpus identity changed' : undefined,
    });
  }

  // artifact_hash is informational only (a new artifact ALWAYS has a new
  // hash; that's the point of redistilling). Report but don't gate on it.
  signals.push({
    axis: 'artifact_hash',
    baseline: baselineSnap.artifact_hash,
    current: currentSnap.artifact_hash,
    status: baselineSnap.artifact_hash === currentSnap.artifact_hash ? 'within' : 'drift',
    reason: 'informational — artifact_hash drift is expected on rebuild',
  });

  return signals;
}

// ---------------------------------------------------------------------------
// Drift report — the persisted artifact of a drift detection run.
// ---------------------------------------------------------------------------

export function buildDriftReport(input = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('drift report input must be object');
  }
  if (!input.baseline_snapshot) throw new Error('drift report baseline_snapshot required');
  if (!input.current_snapshot) throw new Error('drift report current_snapshot required');
  // Validate embedded snapshots so a corrupt input can't slip through.
  validateDriftSnapshot(input.baseline_snapshot);
  validateDriftSnapshot(input.current_snapshot);
  if (!Array.isArray(input.signals)) throw new Error('drift report signals must be array');
  const now = input.computed_at || new Date().toISOString();
  const breach = input.signals.filter(s => s.status === 'breach').length;
  const drift = input.signals.filter(s => s.status === 'drift').length;
  // Verdict: any breach → breach; any drift (no breach) → drift; else within.
  let verdict;
  if (breach > 0) verdict = 'breach';
  else if (drift > 0) verdict = 'drift';
  else verdict = 'within';
  const out = {
    spec: DRIFT_REPORT_SPEC_VERSION,
    computed_at: now,
    baseline_snapshot: input.baseline_snapshot,
    current_snapshot: input.current_snapshot,
    signals: input.signals,
    verdict,
    breach_count: breach,
    drift_count: drift,
  };
  if (input.tolerances) {
    out.tolerances = input.tolerances;
  }
  if (input.notes) {
    if (typeof input.notes !== 'string') throw new Error('drift report notes must be string');
    out.notes = input.notes;
  }
  out.hash = blockHash(out);
  return out;
}

export function validateDriftReport(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('drift report must be object');
  }
  if (report.spec !== DRIFT_REPORT_SPEC_VERSION) {
    throw new Error(`bad drift report spec: ${report.spec}`);
  }
  if (!report.baseline_snapshot || !report.current_snapshot) {
    throw new Error('drift report missing snapshots');
  }
  validateDriftSnapshot(report.baseline_snapshot);
  validateDriftSnapshot(report.current_snapshot);
  if (!Array.isArray(report.signals)) {
    throw new Error('drift report signals must be array');
  }
  if (!['within', 'drift', 'breach'].includes(report.verdict)) {
    throw new Error(`invalid drift report verdict: ${report.verdict}`);
  }
  const expectedHash = blockHash(report);
  if (report.hash !== expectedHash) {
    throw new Error(`drift report hash mismatch: expected ${expectedHash}, got ${report.hash}`);
  }
  return Object.freeze({ ...report });
}

export function writeDriftReport(filePath, report) {
  validateDriftReport(report);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
}

export function loadDriftReport(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return validateDriftReport(JSON.parse(raw));
}

// ---------------------------------------------------------------------------
// Drift cron scaffold (M+3 scheduler half).
//
// Emits a JSON config a tenant drops into their scheduler. Does NOT itself
// fork a daemon. Reason: kolm should not own a long-running scheduler
// process — that's the OS's job, and every regulated tenant already has
// their own (cron, systemd timer, k8s CronJob, Airflow DAG, GitHub Actions
// schedule). The config carries enough information for `kolm drift detect`
// to be re-run on schedule with the same baseline + tolerances.
// ---------------------------------------------------------------------------

const CRON_FIELD_RE = /^[*0-9,\-/]+$/;

function isValidCronExpr(expr) {
  if (typeof expr !== 'string') return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every(p => CRON_FIELD_RE.test(p));
}

export function buildDriftCronConfig(input = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('drift cron input must be object');
  }
  if (!input.cadence_cron) {
    throw new Error('drift cron cadence_cron required (5-field crontab expression)');
  }
  if (!isValidCronExpr(input.cadence_cron)) {
    throw new Error(`drift cron cadence_cron invalid: ${input.cadence_cron} (expected 5 fields)`);
  }
  if (!input.baseline_artifact_path) {
    throw new Error('drift cron baseline_artifact_path required');
  }
  if (typeof input.baseline_artifact_path !== 'string') {
    throw new Error('drift cron baseline_artifact_path must be string');
  }
  if (!input.current_artifact_path) {
    throw new Error('drift cron current_artifact_path required');
  }
  if (typeof input.current_artifact_path !== 'string') {
    throw new Error('drift cron current_artifact_path must be string');
  }
  if (!input.out_report_path) {
    throw new Error('drift cron out_report_path required');
  }
  const out = {
    spec: DRIFT_CRON_SPEC_VERSION,
    cadence_cron: input.cadence_cron,
    baseline_artifact_path: input.baseline_artifact_path,
    current_artifact_path: input.current_artifact_path,
    out_report_path: input.out_report_path,
  };
  if (input.tolerances) {
    out.tolerances = input.tolerances;
  }
  if (input.alert_webhook) {
    if (typeof input.alert_webhook !== 'string') {
      throw new Error('drift cron alert_webhook must be string');
    }
    out.alert_webhook = input.alert_webhook;
  }
  if (input.alert_on) {
    if (!Array.isArray(input.alert_on)) {
      throw new Error('drift cron alert_on must be array');
    }
    for (const v of input.alert_on) {
      if (!DRIFT_STATUSES.includes(v)) {
        throw new Error(`drift cron alert_on invalid verdict: ${v}`);
      }
    }
    out.alert_on = input.alert_on;
  }
  if (input.notes) {
    if (typeof input.notes !== 'string') {
      throw new Error('drift cron notes must be string');
    }
    out.notes = input.notes;
  }
  out.hash = blockHash(out);
  return out;
}

export function validateDriftCronConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('drift cron config must be object');
  }
  if (cfg.spec !== DRIFT_CRON_SPEC_VERSION) {
    throw new Error(`bad drift cron spec: ${cfg.spec}`);
  }
  if (!isValidCronExpr(cfg.cadence_cron)) {
    throw new Error('drift cron cadence_cron invalid');
  }
  const expectedHash = blockHash(cfg);
  if (cfg.hash !== expectedHash) {
    throw new Error(`drift cron hash mismatch: expected ${expectedHash}, got ${cfg.hash}`);
  }
  return Object.freeze({ ...cfg });
}

// Emit a crontab-syntax line. Quotes the paths so spaces don't break the
// scheduler. The wrapped command exits non-zero on breach so cron's mail
// behavior surfaces the alert to the operator without needing a webhook.
export function toCrontabLine(cfg, kolmBin = 'kolm') {
  validateDriftCronConfig(cfg);
  const baseline = JSON.stringify(cfg.baseline_artifact_path);
  const current = JSON.stringify(cfg.current_artifact_path);
  const out = JSON.stringify(cfg.out_report_path);
  return `${cfg.cadence_cron} ${kolmBin} drift detect ${current} --baseline ${baseline} --out ${out}`;
}

export default {
  SUPERSESSION_SPEC_VERSION,
  DRIFT_SNAPSHOT_SPEC_VERSION,
  DRIFT_REPORT_SPEC_VERSION,
  DRIFT_CRON_SPEC_VERSION,
  SUPERSESSION_REASONS,
  DRIFT_STATUSES,
  DEFAULT_TOLERANCES,
  buildSupersessionBlock,
  validateSupersessionBlock,
  buildDriftSnapshot,
  validateDriftSnapshot,
  snapshotFromManifest,
  detectDrift,
  buildDriftReport,
  validateDriftReport,
  writeDriftReport,
  loadDriftReport,
  buildDriftCronConfig,
  validateDriftCronConfig,
  toCrontabLine,
};
