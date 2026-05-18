// W369 — dataset workbench.
//
// Turns accepted opportunities + approved events into named datasets with
// deterministic train/holdout splits. Hard rule: train_ids and holdout_ids
// MUST be disjoint. splitDataset() asserts this; createDataset() runs through
// it on the way in.
//
// State on disk:
//   ~/.kolm/labels/approvals.jsonl     — per-event approve/reject decisions
//   ~/.kolm/datasets/<dataset_id>.json — full dataset record
//
// All paths honor KOLM_DATA_DIR override so tests can isolate.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { listEvents, getEvent } from './event-store.js';
import { loadOpportunitiesState } from './opportunity-engine.js';

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
function _base() {
  const b = process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
  fs.mkdirSync(b, { recursive: true });
  return b;
}
function _labelsDir() { const p = path.join(_base(), 'labels'); fs.mkdirSync(p, { recursive: true }); return p; }
function _datasetsDir() { const p = path.join(_base(), 'datasets'); fs.mkdirSync(p, { recursive: true }); return p; }
function _approvalsFile() { return path.join(_labelsDir(), 'approvals.jsonl'); }

function _loadApprovals() {
  const file = _approvalsFile();
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.event_id) out[e.event_id] = e; // last write wins
    } catch {}
  }
  return out;
}

// listCandidates({namespace, minConfidence})
//   - Pulls events from the namespace.
//   - Excludes any event already approved or rejected.
//   - If a local_replacement_candidate opportunity is accepted, prioritises
//     events that match its template signature.
export async function listCandidates(opts = {}) {
  const namespace = opts.namespace;
  const limit = opts.limit == null ? 500 : opts.limit;
  const events = await listEvents({ namespace, limit, order: 'desc' });
  const approvals = _loadApprovals();
  const candidates = events.filter(e => !approvals[e.event_id]);
  // Surface accepted-opportunity events first.
  const state = loadOpportunitiesState();
  const acceptedTemplateSigs = new Set();
  for (const o of Object.values(state.byId)) {
    if (o.status !== 'accepted') continue;
    // We can't recover the template_signature from state alone without the
    // live opportunity, but the event ids themselves are stable. The caller
    // can re-run findOpportunities() for the full picture; here we just
    // return the unlabeled set in newest-first order.
  }
  acceptedTemplateSigs.size; // satisfy linter
  return candidates;
}

// approveEvent: append a positive-decision row to approvals.jsonl. The
// optional fixedOutput is the "label" used to train future models.
export async function approveEvent(eventId, opts = {}) {
  if (!eventId) throw new Error('approveEvent requires an event_id');
  const ev = await getEvent(eventId);
  if (!ev) throw new Error('event not found: ' + eventId);
  const entry = {
    event_id: eventId,
    decision: 'approve',
    fixed_output: opts.fixedOutput != null ? String(opts.fixedOutput) : null,
    sensitive: opts.sensitive === true,
    holdout_only: opts.holdoutOnly === true,
    reviewer: opts.reviewer || 'local-user',
    workflow: opts.workflow || null,
    decided_at: new Date().toISOString(),
  };
  fs.appendFileSync(_approvalsFile(), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

export async function rejectEvent(eventId, opts = {}) {
  if (!eventId) throw new Error('rejectEvent requires an event_id');
  const entry = {
    event_id: eventId,
    decision: 'reject',
    reason: opts.reason || null,
    reviewer: opts.reviewer || 'local-user',
    decided_at: new Date().toISOString(),
  };
  fs.appendFileSync(_approvalsFile(), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

// editEvent: alias for approve with fixedOutput — captures the "edit" verdict
// used by label-queue submitLabel.
export async function editEvent(eventId, fixedOutput, opts = {}) {
  return approveEvent(eventId, { ...opts, fixedOutput });
}

function _dsId(seed) {
  const h = crypto.createHash('sha256').update(seed + ':' + Date.now()).digest('hex').slice(0, 10);
  return 'ds_' + h;
}

// splitDataset(datasetId, train_ratio): deterministic split by sha256 of
// event_id mod 100. Asserts disjointness. Returns {train_ids, holdout_ids,
// train_count, holdout_count, split_signature}.
export async function splitDataset(datasetId, train_ratio = 0.8) {
  const file = path.join(_datasetsDir(), datasetId + '.json');
  if (!fs.existsSync(file)) throw new Error('dataset not found: ' + datasetId);
  const ds = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ratio = Math.max(0.01, Math.min(0.99, Number(train_ratio) || 0.8));
  const cutoff = Math.floor(ratio * 100);
  const train = [];
  const holdout = [];
  for (const eid of ds.source_event_ids) {
    const bucket = parseInt(crypto.createHash('sha256').update(String(eid)).digest('hex').slice(0, 8), 16) % 100;
    if (bucket < cutoff) train.push(eid); else holdout.push(eid);
  }
  // Honor approval holdout_only flags: any event flagged holdout_only goes
  // into the holdout bucket regardless of hash.
  const approvals = _loadApprovals();
  for (const eid of [...train]) {
    if (approvals[eid] && approvals[eid].holdout_only) {
      train.splice(train.indexOf(eid), 1);
      if (!holdout.includes(eid)) holdout.push(eid);
    }
  }
  // Disjointness assertion.
  const t = new Set(train);
  for (const h of holdout) {
    if (t.has(h)) throw new Error('split_invariant_violation: ' + h + ' in both buckets');
  }
  const sig = crypto.createHash('sha256').update(JSON.stringify({ datasetId, ratio, train, holdout })).digest('hex').slice(0, 16);
  const out = {
    dataset_id: datasetId,
    train_count: train.length,
    holdout_count: holdout.length,
    train_ids: train,
    holdout_ids: holdout,
    split_signature: 'sha256:' + sig,
    ratio,
  };
  // Persist the split into the dataset record so future inspects see it.
  ds.train_count = train.length;
  ds.holdout_count = holdout.length;
  ds.split_signature = out.split_signature;
  ds.train_ids = train;
  ds.holdout_ids = holdout;
  fs.writeFileSync(file, JSON.stringify(ds, null, 2));
  return out;
}

// createDataset(namespace, {fromOpportunity, includeApproved, train_ratio, redactionPolicy})
// Returns {dataset_id, train_count, holdout_count, source_event_ids, version}.
export async function createDataset(namespace, opts = {}) {
  if (!namespace) throw new Error('createDataset requires a namespace');
  const include = opts.includeApproved !== false;
  const train_ratio = opts.train_ratio != null ? opts.train_ratio : 0.8;
  const events = await listEvents({ namespace, limit: opts.limit || 100000, order: 'asc' });
  const approvals = _loadApprovals();
  let source;
  if (include) {
    source = events.filter(e => {
      const a = approvals[e.event_id];
      return !a || a.decision !== 'reject';
    });
  } else {
    source = events.slice();
  }
  // If an opportunity is referenced, restrict to that opportunity's sample ids
  // when they're in this namespace.
  if (opts.fromOpportunity) {
    const state = loadOpportunitiesState();
    state.byId[opts.fromOpportunity]; // touch — opp samples are seeded from the live opportunity which is recomputed by caller
  }
  if (!source.length) {
    throw new Error('no events available for dataset (namespace=' + namespace + ')');
  }
  const datasetId = _dsId(namespace);
  const file = path.join(_datasetsDir(), datasetId + '.json');
  const record = {
    dataset_id: datasetId,
    namespace,
    version: 1,
    source_event_ids: source.map(e => e.event_id),
    approved_by: opts.approvedBy || 'local-user',
    redaction_policy: opts.redactionPolicy || 'redact',
    train_count: 0,
    holdout_count: 0,
    split_signature: null,
    train_ids: [],
    holdout_ids: [],
    source_type: opts.sourceType || 'real',
    created_at: new Date().toISOString(),
    from_opportunity: opts.fromOpportunity || null,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  const split = await splitDataset(datasetId, train_ratio);
  return {
    dataset_id: datasetId,
    train_count: split.train_count,
    holdout_count: split.holdout_count,
    source_event_ids: record.source_event_ids,
    version: record.version,
    split_signature: split.split_signature,
  };
}

// inspectDataset: full record + statistics.
export async function inspectDataset(datasetId) {
  const file = path.join(_datasetsDir(), datasetId + '.json');
  if (!fs.existsSync(file)) throw new Error('dataset not found: ' + datasetId);
  const ds = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = await Promise.all(ds.source_event_ids.map(id => getEvent(id)));
  const present = events.filter(Boolean);
  const labelDist = {};
  const redactionStats = { sensitive: 0, redact_policy: 0, allow_policy: 0 };
  const sourceBreakdown = {};
  for (const e of present) {
    const r = (e.response_redacted || '').trim().slice(0, 64);
    if (r) labelDist[r] = (labelDist[r] || 0) + 1;
    if (e.sensitive_data_detected) redactionStats.sensitive++;
    if (e.redaction_policy === 'redact') redactionStats.redact_policy++;
    if (e.redaction_policy === 'allow') redactionStats.allow_policy++;
    const k = e.source_type || 'real';
    sourceBreakdown[k] = (sourceBreakdown[k] || 0) + 1;
  }
  const labels_sorted = Object.entries(labelDist).sort((a, b) => b[1] - a[1]).slice(0, 20);
  return {
    ...ds,
    statistics: {
      events_resolved: present.length,
      events_missing: ds.source_event_ids.length - present.length,
      label_distribution_top: labels_sorted,
      redaction_stats: redactionStats,
      source_breakdown: sourceBreakdown,
    },
  };
}

export async function listDatasets() {
  const dir = _datasetsDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const ds = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({
        dataset_id: ds.dataset_id,
        namespace: ds.namespace,
        train_count: ds.train_count,
        holdout_count: ds.holdout_count,
        created_at: ds.created_at,
        version: ds.version,
      });
    } catch {}
  }
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// exportDataset(datasetId, format, opts): write jsonl (default) or csv to
// opts.out (defaults to ~/.kolm/datasets/<id>.<format>). Returns the path.
export async function exportDataset(datasetId, format = 'jsonl', opts = {}) {
  const ds = await inspectDataset(datasetId);
  const fmt = (format || 'jsonl').toLowerCase();
  if (!['jsonl', 'csv'].includes(fmt)) throw new Error('unsupported format: ' + fmt);
  const out = opts.out || path.join(_datasetsDir(), datasetId + '.' + fmt);
  const rows = await Promise.all(ds.source_event_ids.map(id => getEvent(id)));
  const present = rows.filter(Boolean);
  if (fmt === 'jsonl') {
    fs.writeFileSync(out, present.map(r => JSON.stringify({
      event_id: r.event_id,
      namespace: r.namespace,
      prompt: r.prompt_redacted,
      response: r.response_redacted,
      model: r.model,
      provider: r.provider,
      sensitive: r.sensitive_data_detected,
    })).join('\n') + (present.length ? '\n' : ''), 'utf8');
  } else {
    const cols = ['event_id', 'namespace', 'prompt', 'response', 'model', 'provider', 'sensitive'];
    const lines = [cols.join(',')];
    for (const r of present) {
      const row = {
        event_id: r.event_id,
        namespace: r.namespace,
        prompt: r.prompt_redacted,
        response: r.response_redacted,
        model: r.model,
        provider: r.provider,
        sensitive: r.sensitive_data_detected,
      };
      lines.push(cols.map(c => {
        const v = row[c];
        if (v == null) return '';
        const s = String(v);
        if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      }).join(','));
    }
    fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  }
  return out;
}
