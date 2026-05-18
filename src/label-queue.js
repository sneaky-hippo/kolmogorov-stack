// W369 — label queue.
//
// Pulls the next N events that have no decision in ~/.kolm/labels/approvals.jsonl,
// records a verdict (good / bad / edit) per submission. Verdicts are stored
// both as the dataset-workbench approval row AND as per-event label files at
// ~/.kolm/labels/<event_id>.json so callers (training, audit, replay) can
// look up a single event without scanning the whole jsonl.
//
// Priority: events from accepted local_replacement_candidate opportunities
// surface first; the rest fall back to newest-first order.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listEvents, getEvent } from './event-store.js';
import { approveEvent, rejectEvent, editEvent } from './dataset-workbench.js';
import { loadOpportunitiesState, findOpportunities } from './opportunity-engine.js';

function _home() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }
function _base() {
  const b = process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
  fs.mkdirSync(b, { recursive: true });
  return b;
}
function _labelsDir() { const p = path.join(_base(), 'labels'); fs.mkdirSync(p, { recursive: true }); return p; }
function _approvalsFile() { return path.join(_labelsDir(), 'approvals.jsonl'); }
function _labelFile(eventId) { return path.join(_labelsDir(), eventId + '.json'); }

function _loadApprovals() {
  const file = _approvalsFile();
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.event_id) out[e.event_id] = e;
    } catch {}
  }
  return out;
}

// nextToLabel({reviewer, workflowId, namespace, n}): up to N events that
// have no decision. Prioritises events whose template-signature matches an
// accepted opportunity.
export async function nextToLabel(opts = {}) {
  const n = opts.n == null ? 1 : Math.max(1, Math.min(200, Math.trunc(opts.n)));
  const namespace = opts.namespace || opts.workflowId || null;
  const workflowId = opts.workflowId || null;
  const events = await listEvents({
    namespace,
    workflow_id: workflowId,
    limit: 1000,
    order: 'desc',
  });
  const approvals = _loadApprovals();
  const undecided = events.filter(e => !approvals[e.event_id]);

  // Boost: events appearing in an accepted opportunity's sample_event_ids
  // bubble up first.
  const state = loadOpportunitiesState();
  const accepted = Object.values(state.byId).filter(s => s.status === 'accepted').map(s => s.id);
  let boost = new Set();
  if (accepted.length) {
    try {
      const opps = await findOpportunities({ namespace, limit: 5000 });
      for (const o of opps) {
        if (accepted.includes(o.id) && Array.isArray(o.sample_event_ids)) {
          for (const id of o.sample_event_ids) boost.add(id);
        }
      }
    } catch {}
  }
  const head = undecided.filter(e => boost.has(e.event_id));
  const tail = undecided.filter(e => !boost.has(e.event_id));
  return head.concat(tail).slice(0, n);
}

// submitLabel(eventId, {verdict, fixedOutput, sensitive, holdoutOnly, workflow, reviewer})
// verdict: 'good' | 'bad' | 'edit'. 'edit' requires fixedOutput.
export async function submitLabel(eventId, opts = {}) {
  if (!eventId) throw new Error('submitLabel requires an event_id');
  const verdict = (opts.verdict || 'good').toLowerCase();
  if (!['good', 'bad', 'edit'].includes(verdict)) throw new Error('verdict must be good|bad|edit');
  const ev = await getEvent(eventId);
  if (!ev) throw new Error('event not found: ' + eventId);
  const reviewer = opts.reviewer || 'local-user';
  const ts = new Date().toISOString();

  let approvalRow;
  if (verdict === 'good') {
    approvalRow = await approveEvent(eventId, {
      sensitive: opts.sensitive,
      holdoutOnly: opts.holdoutOnly,
      workflow: opts.workflow,
      reviewer,
    });
  } else if (verdict === 'bad') {
    approvalRow = await rejectEvent(eventId, { reason: opts.reason, reviewer });
  } else {
    if (opts.fixedOutput == null) throw new Error('verdict=edit requires fixedOutput');
    approvalRow = await editEvent(eventId, String(opts.fixedOutput), {
      sensitive: opts.sensitive,
      holdoutOnly: opts.holdoutOnly,
      workflow: opts.workflow,
      reviewer,
    });
  }

  const label = {
    event_id: eventId,
    verdict,
    fixed_output: opts.fixedOutput != null ? String(opts.fixedOutput) : null,
    sensitive: opts.sensitive === true,
    holdout_only: opts.holdoutOnly === true,
    workflow: opts.workflow || null,
    reviewer,
    labeled_at: ts,
  };
  fs.writeFileSync(_labelFile(eventId), JSON.stringify(label, null, 2));
  return { label, approval: approvalRow };
}

// labelStats(): pending / approved / rejected / edited counts, plus per-
// reviewer and per-workflow rollups. Computes pending by reading all
// events in the store and subtracting decided ones.
export async function labelStats() {
  const approvals = _loadApprovals();
  let approved = 0, rejected = 0, edited = 0;
  const byReviewer = {};
  const byWorkflow = {};
  for (const a of Object.values(approvals)) {
    if (a.decision === 'reject') rejected++;
    else if (a.fixed_output) edited++;
    else approved++;
    const r = a.reviewer || 'unknown';
    byReviewer[r] = (byReviewer[r] || 0) + 1;
    const w = a.workflow || '_none';
    byWorkflow[w] = (byWorkflow[w] || 0) + 1;
  }
  const total = await listEvents({ limit: 0 });
  const decided = new Set(Object.keys(approvals));
  let pending = 0;
  for (const e of total) {
    if (!decided.has(e.event_id)) pending++;
  }
  return {
    pending,
    approved,
    rejected,
    edited,
    total_events: total.length,
    decided: decided.size,
    by_reviewer: byReviewer,
    by_workflow: byWorkflow,
  };
}

// getLabel(eventId): return the persisted label record or null.
export function getLabel(eventId) {
  const file = _labelFile(eventId);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
