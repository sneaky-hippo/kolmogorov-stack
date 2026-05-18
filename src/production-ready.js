// Wave 339 — single source-of-truth productionReady() verdict.
//
// Trust bug surfaced in design-partner trial: compile, run, verify, and
// marketplace each had their own gate logic and could disagree (a K-score
// could pass while verify failed). This module collapses those into one
// pure function used by ALL callers:
//
//   - cli/kolm.js cmdCompile (post-build print + --json envelope)
//   - cli/kolm.js cmdRun     (default warns, --strict exits non-zero)
//   - cli/kolm.js cmdVerify  (replaces ad-hoc seed/drift checks)
//   - src/router.js GET /v1/marketplace/list  (verified pill)
//   - src/router.js POST /v1/marketplace/install (refuses fail)
//
// Verdict shape (stable contract; CI scripts MAY parse `gates.*.ok`):
//   {
//     ok: boolean,                  // AND of every gate.ok
//     gates: {
//       seed_provenance: { ok, reason? },
//       k_score:         { ok, value, threshold, reason? },
//       holdout_split:   { ok, train_count, holdout_count, reason? },
//       drift:           { ok, drift_score?, reason? },
//       durability:      { ok, driver?, reason? }
//     },
//     reasons: [ "...human readable strings for failing gates only..." ]
//   }
//
// Reads a .kolm file OR an already-parsed manifest object. Optional opts:
//   { kGate, capture }  — kGate overrides KOLM_K_GATE / 0.85; capture is the
//                         capture-store module (DI for tests).

import fs from 'node:fs';
import path from 'node:path';
import { MIN_PRODUCTION_HOLDOUT, MIN_PRODUCTION_TRAIN } from './seeds.js';

// Re-export so spec-compile.js can keep importing from one place.
export { MIN_PRODUCTION_HOLDOUT, MIN_PRODUCTION_TRAIN };

// Default ship gate — matches src/kscore.js GATE and cli/kolm.js kGate().
// Kept here so spec-compile.js, cmdRun, cmdVerify, and the marketplace all
// resolve the same value when KOLM_K_GATE is unset.
export const DEFAULT_K_GATE = 0.85;

// Default drift threshold. drift_score is a [0..1] distance metric where
// higher = more drift; ship gate is "below this floor".
export const DEFAULT_DRIFT_MAX = 0.30;

export function resolveKGate(override) {
  if (typeof override === 'number' && override >= 0 && override <= 1) return override;
  const env = Number(process.env.KOLM_K_GATE);
  if (Number.isFinite(env) && env >= 0 && env <= 1) return env;
  return DEFAULT_K_GATE;
}

// Compute the production_ready boolean from a hydrated seedSplit record.
// Mirrors the AND gate in src/spec-compile.js (extracted so compile and the
// other callers share one definition — see W339 #2). Returns true when:
//   - train_count >= MIN_PRODUCTION_TRAIN
//   - holdout_count >= MIN_PRODUCTION_HOLDOUT
//   - every leakage channel is clean (input/output/near-dup/grouped overlap)
export function computeSeedProductionReady(seedSplit) {
  if (!seedSplit || typeof seedSplit !== 'object') return false;
  const lr = seedSplit.leakage_report || {};
  return (
    (seedSplit.train_count || 0) >= MIN_PRODUCTION_TRAIN
    && (seedSplit.holdout_count || 0) >= MIN_PRODUCTION_HOLDOUT
    && (lr.input_overlap_count || 0) === 0
    && (lr.output_overlap_count || 0) === 0
    && (lr.near_duplicate_count || 0) === 0
    && (lr.grouped_overlap_count || 0) === 0
  );
}

// Loader: open a .kolm zip and return its parsed manifest. Defers to adm-zip
// (already a root dep). Throws on missing manifest.json so a corrupt file
// fails loud instead of silently returning ok:false.
async function loadManifestFromArtifact(artifactPath) {
  const { default: AdmZip } = await import('adm-zip');
  const buf = fs.readFileSync(artifactPath);
  const zip = new AdmZip(buf);
  const entry = zip.getEntry('manifest.json');
  if (!entry) throw new Error(`malformed .kolm: missing manifest.json (${path.basename(artifactPath)})`);
  return JSON.parse(entry.getData().toString('utf8'));
}

// Per-gate evaluators. Each returns { ok, reason?, ...extras }.

function evalSeedProvenance(manifest) {
  const sp = manifest.seed_provenance;
  if (!sp) {
    return { ok: false, reason: 'no seed_provenance in manifest (built without --seeds)' };
  }
  if (typeof sp.seeds_hash !== 'string' || sp.seeds_hash.length < 16) {
    return { ok: false, reason: 'seed_provenance.seeds_hash missing or malformed' };
  }
  if (typeof sp.split_seed !== 'string' || sp.split_seed.length === 0) {
    return { ok: false, reason: 'seed_provenance.split_seed missing' };
  }
  if (sp.production_ready === false) {
    return { ok: false, reason: 'seed_provenance.production_ready=false (leakage or under-sized split)' };
  }
  return { ok: true };
}

function evalKScore(manifest, kGate) {
  const k = manifest.k_score;
  if (!k || typeof k.composite !== 'number') {
    return { ok: false, value: null, threshold: kGate, reason: 'k_score missing or has no composite' };
  }
  if (k.composite >= kGate) return { ok: true, value: k.composite, threshold: kGate };
  return { ok: false, value: k.composite, threshold: kGate, reason: `k_score composite ${k.composite.toFixed(4)} below gate ${kGate}` };
}

function evalHoldoutSplit(manifest) {
  const sp = manifest.seed_provenance;
  if (!sp) {
    return { ok: false, train_count: 0, holdout_count: 0, reason: 'no holdout split — built without --seeds' };
  }
  const train = Number(sp.train_count) || 0;
  const holdout = Number(sp.holdout_count) || 0;
  if (train < MIN_PRODUCTION_TRAIN) {
    return { ok: false, train_count: train, holdout_count: holdout, reason: `train_count ${train} < MIN_PRODUCTION_TRAIN ${MIN_PRODUCTION_TRAIN}` };
  }
  if (holdout < MIN_PRODUCTION_HOLDOUT) {
    return { ok: false, train_count: train, holdout_count: holdout, reason: `holdout_count ${holdout} < MIN_PRODUCTION_HOLDOUT ${MIN_PRODUCTION_HOLDOUT}` };
  }
  // Leakage channels — re-check so a tampered seed_provenance.production_ready
  // can't lie about a clean split. Same AND as computeSeedProductionReady().
  const lr = sp || {};
  const channels = ['input_overlap_count', 'output_overlap_count', 'near_duplicate_count', 'grouped_overlap_count'];
  for (const c of channels) {
    if ((lr[c] || 0) > 0) {
      return { ok: false, train_count: train, holdout_count: holdout, reason: `${c}=${lr[c]} (holdout contamination)` };
    }
  }
  return { ok: true, train_count: train, holdout_count: holdout };
}

function evalDrift(manifest, driftMax) {
  // drift_report block is optional. When present, prefer its top-level
  // drift_score (drift-supersession.js convention). When absent the gate is
  // vacuously ok — drift is opt-in, not a blocker for first compile.
  const block = manifest.drift_report;
  if (!block || typeof block !== 'object') return { ok: true };
  const dscore = typeof block.drift_score === 'number'
    ? block.drift_score
    : (typeof block.score === 'number' ? block.score : null);
  if (dscore == null) return { ok: true };
  if (dscore <= driftMax) return { ok: true, drift_score: dscore };
  return { ok: false, drift_score: dscore, reason: `drift_score ${dscore.toFixed(4)} exceeds max ${driftMax}` };
}

async function evalDurability(opts) {
  // capture-store reports honest durability for the live deploy. Tests can
  // inject opts.capture to stub. When the module isn't importable (e.g. a
  // bare CLI invocation with no router context), default ok:true so this
  // gate doesn't fail a perfectly good local compile.
  try {
    const mod = opts && opts.capture
      ? opts.capture
      : await import('./capture-store.js');
    const durable = typeof mod.isDurable === 'function' ? mod.isDurable() : true;
    const driver = typeof mod.driverName === 'function' ? mod.driverName() : null;
    if (durable) return { ok: true, driver };
    return { ok: false, driver, reason: `store driver ${driver || '?'} is ephemeral (writes do not survive process restart)` };
  } catch (_e) {
    // capture-store unavailable — local-only artifacts pass through.
    return { ok: true };
  }
}

// PUBLIC: productionReady(artifactPathOrManifest, opts?) -> Promise<verdict>
export async function productionReady(artifactPathOrManifest, opts = {}) {
  let manifest;
  if (typeof artifactPathOrManifest === 'string') {
    manifest = await loadManifestFromArtifact(artifactPathOrManifest);
  } else if (artifactPathOrManifest && typeof artifactPathOrManifest === 'object') {
    manifest = artifactPathOrManifest;
  } else {
    throw new Error('productionReady: pass a .kolm path or a manifest object');
  }

  const kGate = resolveKGate(opts.kGate);
  const driftMax = typeof opts.driftMax === 'number' ? opts.driftMax : DEFAULT_DRIFT_MAX;

  const seed_provenance = evalSeedProvenance(manifest);
  const k_score = evalKScore(manifest, kGate);
  const holdout_split = evalHoldoutSplit(manifest);
  const drift = evalDrift(manifest, driftMax);
  const durability = await evalDurability(opts);

  const gates = { seed_provenance, k_score, holdout_split, drift, durability };
  const reasons = [];
  for (const [name, g] of Object.entries(gates)) {
    if (!g.ok && g.reason) reasons.push(`${name}: ${g.reason}`);
  }
  const ok = Object.values(gates).every((g) => g.ok === true);
  return { ok, gates, reasons };
}

// Synchronous variant for spec-compile.js (already has the manifest object
// in memory). Skips the durability gate because that requires async import.
export function productionReadySync(manifest, opts = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('productionReadySync: manifest must be an object');
  }
  const kGate = resolveKGate(opts.kGate);
  const driftMax = typeof opts.driftMax === 'number' ? opts.driftMax : DEFAULT_DRIFT_MAX;
  const seed_provenance = evalSeedProvenance(manifest);
  const k_score = evalKScore(manifest, kGate);
  const holdout_split = evalHoldoutSplit(manifest);
  const drift = evalDrift(manifest, driftMax);
  const durability = { ok: true, _skipped: 'sync-mode' };
  const gates = { seed_provenance, k_score, holdout_split, drift, durability };
  const reasons = [];
  for (const [name, g] of Object.entries(gates)) {
    if (!g.ok && g.reason) reasons.push(`${name}: ${g.reason}`);
  }
  const ok = Object.values(gates).every((g) => g.ok === true);
  return { ok, gates, reasons };
}
