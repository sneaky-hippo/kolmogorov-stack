// Team learning event log.
//
// A kolm tenant can split its membership into one or more *teams* (e.g.,
// claims-ops vs. provider-relations vs. compliance) and collect a shared,
// append-only learning event stream per team. Subsequent compiles fold the
// team's events into the next artifact's seeds + comparator policy so the
// student keeps closing the gap on whatever real inputs the team is seeing.
//
// What this module gives you:
//
//   - append(team, event)          add an event to the team's log
//   - read(team, opts)             read the team's log (filter by kind, since)
//   - chain(team)                  recompute the rolling hash chain
//   - exportSeeds(team, opts)      flatten event log into seeds.jsonl rows
//                                    (positives + corrections only)
//   - redactForExport(events, fn)  drop / mask any payload field a redactor
//                                    classifies as PHI/PII before crossing
//                                    a tenant boundary
//
// What this module does NOT do:
//
//   - It does not sync between tenants or across the network. That belongs
//     to src/federated-learning.js (this wave).
//   - It does not run the redactor. It just calls whatever redactor function
//     you pass in. That keeps redaction policy a separate concern.
//   - It does not write to a hosted log or a SaaS. Storage is local files
//     under KOLM_HOME/teams/<team>/events.jsonl. Tenants can stand up their
//     own object-store backed implementation by replacing the storage
//     adapter.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TEAM_EVENTS_VERSION = 'team-events-v2';

// Kinds an event can be. Adding a kind here is a contract change — bump
// TEAM_EVENTS_VERSION and migrate.
export const EVENT_KINDS = Object.freeze({
  POSITIVE:           'positive',            // a captured input/output pair
                                              // the operator confirmed is right
  CORRECTION:         'correction',          // an artifact output that needs
                                              // replacement with a fixed value
  REGRESSION_FLAG:    'regression_flag',     // a holdout row that started
                                              // failing after an upgrade
  DRIFT_OBSERVATION:  'drift_observation',   // distributional shift signal
                                              // (e.g., new payer, new code set)
  CAPABILITY_REQUEST: 'capability_request',  // ask for a feature the artifact
                                              // can't currently express
  CONFIG_CHANGE:      'config_change',       // change to comparator / gate
  REVIEW_DECISION:    'review_decision',     // (W293) a reviewer's decision
                                              // on another event's review state
});

// Review states a (non-review_decision) event can be in. Set on append to
// 'pending'; mutated by appending a review_decision event referencing the
// target event's hash. Last-write-wins.
export const REVIEW_STATES = Object.freeze(['pending', 'approved', 'rejected', 'needs_revision']);

// Per-kind payload schemas (W293). `required` lists payload fields that
// must be present + non-empty strings (unless typed otherwise via _types).
// We reject anything else so that downstream readers can rely on the
// contract without per-event guards.
export const EVENT_SCHEMAS = Object.freeze({
  positive:            Object.freeze({ required: ['input', 'output'] }),
  correction:          Object.freeze({ required: ['input', 'bad_output', 'good_output'] }),
  regression_flag:     Object.freeze({ required: ['holdout_row_id'] }),
  drift_observation:   Object.freeze({ required: ['signal'] }),
  capability_request:  Object.freeze({ required: ['description'] }),
  config_change:       Object.freeze({ required: ['change'] }),
  review_decision:     Object.freeze({ required: ['event_hash', 'state', 'reviewer'] }),
});

const REQUIRED = ['kind', 'actor', 'artifact_version', 'payload'];

function _now() { return new Date().toISOString(); }
function _shortHash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function _validateEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('event must be an object');
  for (const f of REQUIRED) {
    if (event[f] === undefined) throw new Error(`event missing field: ${f}`);
  }
  if (!Object.values(EVENT_KINDS).includes(event.kind)) {
    throw new Error(`unknown event kind: ${event.kind}`);
  }
  if (typeof event.actor !== 'string' || !event.actor) throw new Error('event.actor must be non-empty string');
  if (typeof event.artifact_version !== 'string' || !event.artifact_version) {
    throw new Error('event.artifact_version must be non-empty string');
  }
  if (!event.payload || typeof event.payload !== 'object') {
    throw new Error('event.payload must be an object');
  }
  // Strict per-kind payload schema (W293).
  const schema = EVENT_SCHEMAS[event.kind];
  if (schema && Array.isArray(schema.required)) {
    for (const f of schema.required) {
      const v = event.payload[f];
      if (v === undefined || v === null || v === '') {
        throw new Error(`event.payload missing required field for kind=${event.kind}: ${f}`);
      }
    }
  }
  // review_decision payload.state must be in REVIEW_STATES.
  if (event.kind === EVENT_KINDS.REVIEW_DECISION) {
    if (!REVIEW_STATES.includes(event.payload.state)) {
      throw new Error(`unknown review state: ${event.payload.state} (must be one of ${REVIEW_STATES.join(', ')})`);
    }
  }
}

function _validateTeam(team) {
  if (typeof team !== 'string') throw new Error('team id must be a string');
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(team)) {
    throw new Error('team id must match [a-zA-Z0-9_.-]{1,64}');
  }
}

function _teamDir(team) {
  const home = process.env.KOLM_HOME
    || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kolm');
  return path.join(home, 'teams', team);
}

function _teamFile(team) {
  return path.join(_teamDir(team), 'events.jsonl');
}

// Append-only writer. The rolling hash chain links event N to event N-1
// via prev_hash; the verifier can detect any rewrite/truncation by walking
// the chain.
export async function append(team, event) {
  _validateTeam(team);
  _validateEvent(event);
  const dir = _teamDir(team);
  await fs.mkdir(dir, { recursive: true });
  const file = _teamFile(team);

  // Read last line (if any) to get prev_hash. Append is O(1) but reading the
  // tail to compute the chain link is O(file size); for high-throughput
  // tenants the storage adapter should be swapped for an indexed backend.
  let prevHash = 'genesis';
  let seq = 0;
  try {
    const buf = await fs.readFile(file, 'utf8');
    const lines = buf.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > 0) {
      const last = JSON.parse(lines[lines.length - 1]);
      prevHash = last.hash;
      seq = (last.seq || 0) + 1;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const ts = event.timestamp || _now();
  const enriched = {
    spec: TEAM_EVENTS_VERSION,
    team,
    seq,
    timestamp: ts,
    kind: event.kind,
    actor: event.actor,
    artifact_version: event.artifact_version,
    payload: event.payload,
    prev_hash: prevHash,
  };
  // Every non-review_decision event lands in the 'pending' review state
  // (W293). review_decision events do not themselves have a review state
  // — they describe one for the event they reference.
  if (event.kind !== EVENT_KINDS.REVIEW_DECISION) {
    enriched.review = { state: 'pending', created_at: ts };
  }
  // The chain hash binds the entire enriched event (minus its own hash field).
  enriched.hash = _shortHash(JSON.stringify(enriched));

  await fs.appendFile(file, JSON.stringify(enriched) + '\n', 'utf8');
  return enriched;
}

// Append a review_decision event for `event_hash`. The decision is the
// authoritative state for that event from this point forward (last-write-
// wins). Reviewers can override prior reviewers; the chain is the audit
// trail. (W293)
export async function setReview(team, opts = {}) {
  const { event_hash, state, reviewer, note, artifact_version, actor } = opts;
  if (!event_hash) throw new Error('setReview: event_hash required');
  if (!REVIEW_STATES.includes(state)) {
    throw new Error(`unknown review state: ${state} (must be one of ${REVIEW_STATES.join(', ')})`);
  }
  if (!reviewer || typeof reviewer !== 'string') throw new Error('setReview: reviewer required');
  // Resolve artifact_version from the target event if not supplied.
  let av = artifact_version;
  if (!av) {
    const events = await read(team);
    const target = events.find(e => e.hash === event_hash);
    av = target ? target.artifact_version : 'unknown';
  }
  const payload = { event_hash, state, reviewer };
  if (note) payload.note = note;
  return await append(team, {
    kind: EVENT_KINDS.REVIEW_DECISION,
    actor: actor || reviewer,
    artifact_version: av,
    payload,
  });
}

// Walk the chain forward and return the latest review_decision for
// event_hash. Returns {state, reviewer, note?, decision_hash?, timestamp?}.
// Defaults to the event's own .review (typically `pending`) if no
// decisions have landed yet. (W293)
export async function getReview(team, event_hash) {
  const events = await read(team);
  const target = events.find(e => e.hash === event_hash);
  if (!target) return null;
  let latest = target.review || { state: 'pending', created_at: target.timestamp };
  let latestDecisionHash = null;
  for (const e of events) {
    if (e.kind !== EVENT_KINDS.REVIEW_DECISION) continue;
    if (!e.payload || e.payload.event_hash !== event_hash) continue;
    latest = {
      state: e.payload.state,
      reviewer: e.payload.reviewer,
      note: e.payload.note,
      created_at: e.timestamp,
    };
    latestDecisionHash = e.hash;
  }
  if (latestDecisionHash) latest.decision_hash = latestDecisionHash;
  return latest;
}

// Read events from the team's log. Filters: kind, since (ISO timestamp),
// artifact_version. Returns an array in append order.
export async function read(team, opts = {}) {
  _validateTeam(team);
  const file = _teamFile(team);
  let buf;
  try { buf = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  let events = buf.split('\n').filter(l => l.trim()).map(JSON.parse);
  if (opts.kind) events = events.filter(e => e.kind === opts.kind);
  if (opts.kinds) events = events.filter(e => opts.kinds.includes(e.kind));
  if (opts.since) events = events.filter(e => e.timestamp >= opts.since);
  if (opts.artifact_version) events = events.filter(e => e.artifact_version === opts.artifact_version);
  if (opts.actor) events = events.filter(e => e.actor === opts.actor);
  return events;
}

// Walk the chain and report the first link that breaks. Used by the verifier
// when a team's event log is bundled into an artifact's receipt.
export async function chain(team) {
  const events = await read(team);
  let prev = 'genesis';
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.prev_hash !== prev) {
      return { ok: false, broke_at: i, reason: 'prev_hash_mismatch', expected: prev, got: e.prev_hash };
    }
    const recomputed = _shortHash(JSON.stringify({
      spec: e.spec, team: e.team, seq: e.seq, timestamp: e.timestamp,
      kind: e.kind, actor: e.actor, artifact_version: e.artifact_version,
      payload: e.payload, prev_hash: e.prev_hash,
    }));
    if (recomputed !== e.hash) {
      return { ok: false, broke_at: i, reason: 'hash_mismatch', expected: recomputed, got: e.hash };
    }
    prev = e.hash;
  }
  return { ok: true, length: events.length, head: prev === 'genesis' ? null : prev };
}

// Export learning events as seeds.jsonl rows. Only POSITIVE and CORRECTION
// kinds contribute, and only when the payload carries the canonical
// fields per the W293 strict schema (positive: {input, output};
// correction: {input, bad_output, good_output}).
//
// Review gate (W294):
//   - by default ONLY events whose latest review_decision is 'approved'
//     export as seeds. Pending/rejected/needs_revision events are dropped.
//   - opts.include_pending=true keeps pending (for audit/debug dumps);
//     it still drops rejected + needs_revision.
//   - every emitted seed carries source_event_hash + review_decision_hash
//     so the verifier can prove the approval link from the seed back to
//     the chained event log.
//
// The artifact compile path uses this to fold a team's accumulated
// reviewed learning into the next training set without the team having to
// manage a separate seeds.jsonl by hand.
export async function exportSeeds(team, opts = {}) {
  const includePending = opts.include_pending === true;
  // Pull the full log once so we can also resolve review decisions per
  // event in a single pass (the chain is small per team).
  const all = await read(team);
  // Pre-compute latest review state per event_hash from the full chain.
  const latestReview = new Map();
  for (const e of all) {
    if (e.kind === EVENT_KINDS.REVIEW_DECISION && e.payload && e.payload.event_hash) {
      latestReview.set(e.payload.event_hash, {
        state: e.payload.state,
        decision_hash: e.hash,
        reviewer: e.payload.reviewer,
      });
    }
  }
  let events = all.filter(e => e.kind === EVENT_KINDS.POSITIVE || e.kind === EVENT_KINDS.CORRECTION);
  if (opts.since) events = events.filter(e => e.timestamp >= opts.since);
  if (opts.artifact_version) events = events.filter(e => e.artifact_version === opts.artifact_version);
  if (opts.actor) events = events.filter(e => e.actor === opts.actor);
  const rows = [];
  for (const e of events) {
    const review = latestReview.get(e.hash) || (e.review || { state: 'pending' });
    if (review.state === 'rejected' || review.state === 'needs_revision') continue;
    if (review.state === 'pending' && !includePending) continue;
    if (review.state !== 'approved' && review.state !== 'pending') continue;
    const p = e.payload || {};
    let input, output;
    if (e.kind === EVENT_KINDS.CORRECTION) {
      if (typeof p.input === 'string' && typeof p.good_output === 'string') {
        input = p.input; output = p.good_output;
      }
    } else {
      if (typeof p.input === 'string' && typeof p.output === 'string') {
        input = p.input; output = p.output;
      } else if (typeof p.prompt === 'string' && typeof p.completion === 'string') {
        input = p.prompt; output = p.completion;
      }
    }
    if (typeof input !== 'string' || typeof output !== 'string') continue;
    const tags = Array.isArray(p.tags) ? p.tags.slice() : [];
    tags.push(`team:${team}`);
    tags.push(`event:${e.kind}`);
    tags.push(`review:${review.state}`);
    const row = {
      input,
      output,
      tags,
      source_seq: e.seq,
      source_event_hash: e.hash,
      review_state: review.state,
    };
    if (review.decision_hash) row.review_decision_hash = review.decision_hash;
    rows.push(row);
  }
  return rows;
}

// Redaction pass — caller supplies the redactor (so privacy policy stays
// pluggable). The redactor function gets (event.payload) and returns a new
// payload + a redaction_map. The result event is identical except for the
// payload and a `redaction.kept` array listing kept-token classes.
export function redactForExport(events, redactor) {
  if (typeof redactor !== 'function') throw new Error('redactor must be a function');
  return events.map(e => {
    const { redacted, map } = redactor(e.payload || {});
    return {
      ...e,
      payload: redacted,
      redaction: {
        applied: true,
        token_classes: Array.from(new Set(Object.values(map || {}).map(v => v.class || 'other'))),
        map_size: Object.keys(map || {}).length,
      },
    };
  });
}

// Stats helper — gives the compile pipeline a quick view of what's in the
// team log so it can decide whether to retrain.
export async function stats(team) {
  const events = await read(team);
  const byKind = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return {
    team,
    total: events.length,
    by_kind: byKind,
    head_hash: events.length > 0 ? events[events.length - 1].hash : null,
    last_timestamp: events.length > 0 ? events[events.length - 1].timestamp : null,
  };
}

// Used by tests + a future REPL command. NEVER call this from a code path
// that touches a real tenant's log. The CLI surface should refuse this in
// non-dev contexts.
export async function _resetForTest(team) {
  if (process.env.NODE_ENV !== 'test' && process.env.KOLM_ALLOW_DESTRUCTIVE !== '1') {
    throw new Error('_resetForTest blocked outside NODE_ENV=test');
  }
  _validateTeam(team);
  const file = _teamFile(team);
  try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

export default {
  TEAM_EVENTS_VERSION,
  EVENT_KINDS,
  EVENT_SCHEMAS,
  REVIEW_STATES,
  append,
  setReview,
  getReview,
  read,
  chain,
  exportSeeds,
  redactForExport,
  stats,
  _resetForTest,
};
