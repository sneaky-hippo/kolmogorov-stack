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

export const TEAM_EVENTS_VERSION = 'team-events-v1';

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
});

// Append-only events have a strict shape. We reject anything else so that
// a downstream reader can rely on the contract without per-event guards.
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
  // The chain hash binds the entire enriched event (minus its own hash field).
  enriched.hash = _shortHash(JSON.stringify(enriched));

  await fs.appendFile(file, JSON.stringify(enriched) + '\n', 'utf8');
  return enriched;
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
// {input, output} pair (or legacy {prompt, completion}, which we normalize).
//
// The artifact compile path uses this to fold a team's accumulated learning
// into the next training set without the team having to manage a separate
// seeds.jsonl by hand.
export async function exportSeeds(team, opts = {}) {
  const events = await read(team, { kinds: [EVENT_KINDS.POSITIVE, EVENT_KINDS.CORRECTION], ...opts });
  const rows = [];
  for (const e of events) {
    const p = e.payload;
    let input, output;
    if (p && typeof p.input === 'string') { input = p.input; output = p.output; }
    else if (p && typeof p.prompt === 'string') { input = p.prompt; output = p.completion; }
    if (typeof input !== 'string' || typeof output !== 'string') continue;
    const tags = Array.isArray(p.tags) ? p.tags.slice() : [];
    tags.push(`team:${team}`);
    tags.push(`event:${e.kind}`);
    rows.push({ input, output, tags, source_seq: e.seq, source_event_hash: e.hash });
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
  append,
  read,
  chain,
  exportSeeds,
  redactForExport,
  stats,
  _resetForTest,
};
