// Agent / workflow trace capture.
//
// Records the structured trace that an agent or multi-step workflow emits as
// it runs. The trace is what src/workflow-ir.js compiles into the workflow
// IR — and ultimately into a frozen .kolm artifact that replays the same
// logic deterministically without round-tripping to a frontier API for every
// step.
//
// Span kinds we capture:
//   LLM_CALL    — request to a model (vendor, model, prompt, response,
//                  latency, tokens, cost)
//   TOOL_CALL   — function/tool invocation (name, args, return, latency)
//   BRANCH      — control-flow decision (condition value, taken edge)
//   IO          — external I/O (HTTP, DB, filesystem) with redacted payloads
//   STATE       — workflow-state mutation (scratchpad / memory write)
//   USER_INPUT  — user message arriving into the workflow
//   ARTIFACT    — sub-artifact invocation (existing kolm artifact called as
//                  a step; lets us nest workflows)
//
// Trace identity follows W3C Trace Context: trace_id (16 bytes, 32 hex),
// span_id (8 bytes, 16 hex), parent_span_id. This makes downstream OTel
// export feasible without remapping.
//
// Privacy: each span carries a `payload` object. If the trace is going to
// leave the tenant boundary (federated learning round, hosted hub, shared
// dataset) it MUST go through redactForExport first. Raw spans NEVER cross
// the boundary by default.
//
// Storage: jsonl under KOLM_HOME/traces/<trace_id>.jsonl. One file per
// trace_id. Append-only; chain hashes link spans.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TRACE_SPEC_VERSION = 'trace-v1';

export const SPAN_KINDS = Object.freeze({
  LLM_CALL:   'llm_call',
  TOOL_CALL:  'tool_call',
  BRANCH:     'branch',
  IO:         'io',
  STATE:      'state',
  USER_INPUT: 'user_input',
  ARTIFACT:   'artifact',
});

const REQUIRED = ['kind', 'trace_id', 'span_id', 'started_at', 'payload'];

function _now() { return new Date().toISOString(); }
function _shortHash(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function _canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_canonicalize).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _canonicalize(v[k])).join(',') + '}';
}

// Generators that match W3C Trace Context spec (16-byte trace, 8-byte span).
export function newTraceId() {
  return crypto.randomBytes(16).toString('hex');
}
export function newSpanId() {
  return crypto.randomBytes(8).toString('hex');
}

function _validateSpan(span) {
  if (!span || typeof span !== 'object') throw new Error('span must be an object');
  for (const f of REQUIRED) {
    if (span[f] === undefined) throw new Error(`span missing field: ${f}`);
  }
  if (!Object.values(SPAN_KINDS).includes(span.kind)) {
    throw new Error(`unknown span kind: ${span.kind}`);
  }
  if (!/^[0-9a-f]{32}$/.test(span.trace_id)) throw new Error('trace_id must be 32 hex chars');
  if (!/^[0-9a-f]{16}$/.test(span.span_id)) throw new Error('span_id must be 16 hex chars');
  if (span.parent_span_id != null && !/^[0-9a-f]{16}$/.test(span.parent_span_id)) {
    throw new Error('parent_span_id must be 16 hex chars or null');
  }
  if (typeof span.payload !== 'object' || span.payload === null) {
    throw new Error('span.payload must be an object');
  }
}

function _traceFile(trace_id) {
  const home = process.env.KOLM_HOME
    || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kolm');
  return path.join(home, 'traces', `${trace_id}.jsonl`);
}

// Append a span to the trace's log. Chain hash links to prior span.
export async function appendSpan(span) {
  _validateSpan(span);
  const file = _traceFile(span.trace_id);
  await fs.mkdir(path.dirname(file), { recursive: true });

  let prev_hash = 'genesis';
  let seq = 0;
  try {
    const buf = await fs.readFile(file, 'utf8');
    const lines = buf.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > 0) {
      const last = JSON.parse(lines[lines.length - 1]);
      prev_hash = last.hash;
      seq = (last.seq || 0) + 1;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const enriched = {
    spec: TRACE_SPEC_VERSION,
    seq,
    kind: span.kind,
    trace_id: span.trace_id,
    span_id: span.span_id,
    parent_span_id: span.parent_span_id || null,
    started_at: span.started_at,
    ended_at: span.ended_at || null,
    duration_ms: span.duration_ms != null ? span.duration_ms : null,
    payload: span.payload,
    attributes: span.attributes || {},
    status: span.status || 'ok',
    error: span.error || null,
    prev_hash,
  };
  enriched.hash = _shortHash(_canonicalize(enriched));
  await fs.appendFile(file, JSON.stringify(enriched) + '\n', 'utf8');
  return enriched;
}

// Read all spans for a trace, ordered by seq. Returns [] if the file does
// not exist.
export async function readTrace(trace_id) {
  if (!/^[0-9a-f]{32}$/.test(trace_id)) throw new Error('bad trace_id');
  const file = _traceFile(trace_id);
  let buf;
  try { buf = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return buf.split('\n').filter(Boolean).map(JSON.parse).sort((a, b) => a.seq - b.seq);
}

// Walk the chain. Returns ok=true if every span's prev_hash + recomputed
// hash matches; otherwise reports the first break.
export async function chain(trace_id) {
  const spans = await readTrace(trace_id);
  let prev = 'genesis';
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (s.prev_hash !== prev) {
      return { ok: false, broke_at: i, reason: 'prev_hash_mismatch', expected: prev, got: s.prev_hash };
    }
    const { hash: _ignore, ...withoutHash } = s;
    const recomputed = _shortHash(_canonicalize(withoutHash));
    if (recomputed !== s.hash) {
      return { ok: false, broke_at: i, reason: 'hash_mismatch', expected: recomputed, got: s.hash };
    }
    prev = s.hash;
  }
  return { ok: true, length: spans.length, head: spans.length > 0 ? prev : null };
}

// Builder helpers for the four most common span kinds. Each returns a span
// object ready for appendSpan (you can also build spans by hand).

export function llmCallSpan({ trace_id, span_id, parent_span_id, vendor, model, prompt, response, tokens_in, tokens_out, latency_ms, cost_usd, redacted_input_ids = [] }) {
  return {
    kind: SPAN_KINDS.LLM_CALL,
    trace_id, span_id, parent_span_id,
    started_at: _now(),
    ended_at: _now(),
    duration_ms: latency_ms,
    payload: { vendor, model, prompt, response, tokens_in, tokens_out, cost_usd, redacted_input_ids },
    attributes: { 'kolm.vendor': vendor, 'kolm.model': model, 'kolm.tokens.in': tokens_in, 'kolm.tokens.out': tokens_out },
  };
}

export function toolCallSpan({ trace_id, span_id, parent_span_id, tool_name, args, result, latency_ms, error }) {
  return {
    kind: SPAN_KINDS.TOOL_CALL,
    trace_id, span_id, parent_span_id,
    started_at: _now(),
    ended_at: _now(),
    duration_ms: latency_ms,
    payload: { tool_name, args, result },
    attributes: { 'kolm.tool.name': tool_name },
    status: error ? 'error' : 'ok',
    error: error || null,
  };
}

export function branchSpan({ trace_id, span_id, parent_span_id, condition_id, value, taken_edge }) {
  return {
    kind: SPAN_KINDS.BRANCH,
    trace_id, span_id, parent_span_id,
    started_at: _now(),
    payload: { condition_id, value, taken_edge },
    attributes: { 'kolm.branch.taken': taken_edge },
  };
}

export function userInputSpan({ trace_id, span_id, parent_span_id, role, text, channel }) {
  return {
    kind: SPAN_KINDS.USER_INPUT,
    trace_id, span_id, parent_span_id,
    started_at: _now(),
    payload: { role, text, channel },
  };
}

export function artifactSpan({ trace_id, span_id, parent_span_id, artifact_hash, recipe_id, input, output, latency_ms }) {
  return {
    kind: SPAN_KINDS.ARTIFACT,
    trace_id, span_id, parent_span_id,
    started_at: _now(),
    ended_at: _now(),
    duration_ms: latency_ms,
    payload: { artifact_hash, recipe_id, input, output },
    attributes: { 'kolm.artifact.hash': artifact_hash, 'kolm.recipe.id': recipe_id },
  };
}

// Redact ALL payload fields per the caller's redactor before exporting.
// The redactor function receives (payload) and returns { redacted, map }.
// The chain hash IS NOT recomputed after redaction — the resulting spans
// are explicitly marked `redacted: true` and the original chain integrity
// is preserved by leaving `hash` and `prev_hash` intact for cross-checks
// against the original trace file.
export function redactForExport(spans, redactor) {
  if (typeof redactor !== 'function') throw new Error('redactor must be a function');
  return spans.map(s => {
    const { redacted: payload, map } = redactor(s.payload || {});
    return {
      ...s,
      payload,
      redacted: true,
      redaction_summary: {
        classes: Array.from(new Set(Object.values(map || {}).map(v => v.class || 'other'))),
        count: Object.keys(map || {}).length,
      },
    };
  });
}

// Summary statistics — used by the CLI `kolm trace stats` command.
export async function stats(trace_id) {
  const spans = await readTrace(trace_id);
  const by_kind = {};
  let total_llm_ms = 0;
  let total_tool_ms = 0;
  let total_cost = 0;
  let llm_calls = 0;
  for (const s of spans) {
    by_kind[s.kind] = (by_kind[s.kind] || 0) + 1;
    if (s.kind === SPAN_KINDS.LLM_CALL) {
      llm_calls += 1;
      total_llm_ms += s.duration_ms || 0;
      total_cost += (s.payload?.cost_usd || 0);
    } else if (s.kind === SPAN_KINDS.TOOL_CALL) {
      total_tool_ms += s.duration_ms || 0;
    }
  }
  return {
    trace_id,
    total_spans: spans.length,
    by_kind,
    llm_calls,
    total_llm_ms,
    total_tool_ms,
    total_cost_usd: Number(total_cost.toFixed(6)),
    started_at: spans[0]?.started_at || null,
    finished_at: spans[spans.length - 1]?.ended_at || spans[spans.length - 1]?.started_at || null,
  };
}

// Helper for tests.
export async function _resetForTest(trace_id) {
  if (process.env.NODE_ENV !== 'test' && process.env.KOLM_ALLOW_DESTRUCTIVE !== '1') {
    throw new Error('_resetForTest blocked outside NODE_ENV=test');
  }
  const file = _traceFile(trace_id);
  try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

export default {
  TRACE_SPEC_VERSION,
  SPAN_KINDS,
  newTraceId,
  newSpanId,
  appendSpan,
  readTrace,
  chain,
  llmCallSpan,
  toolCallSpan,
  branchSpan,
  userInputSpan,
  artifactSpan,
  redactForExport,
  stats,
  _resetForTest,
};
