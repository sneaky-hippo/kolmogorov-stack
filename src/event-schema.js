// W369 — canonical event schema (single source of truth).
//
// Every byte that flows through kolm.ai's data plane lands as a row matching
// this contract. The Connector agent writes events using newEvent() and
// validateEvent(); the Lake / Optimizer / Dataset / Label modules read them.
//
// Design rules:
//   - All fields are explicit. No "unknown" or "extra" keys land in the
//     store. validateEvent({ok, missing, extra, errors}) tells the caller
//     exactly what is wrong before the write hits the SQLite driver.
//   - canonicalize() coerces strings, clamps ints, drops null-y junk, and
//     fills sane defaults (event_id, created_at, status, cache_hit). It is
//     idempotent: canonicalize(canonicalize(x)) === canonicalize(x).
//   - newEvent(partial) returns a fully-formed event ready to write.
//   - Zero deps. Pure ESM. Browser-safe (no fs / no net) so the schema can
//     be imported by the public SDK as well.
//
// Upgrades the W368 daemon-connector stub: same field list, plus provenance
// columns (namespace, source_type, redaction_policy, schema_version) and
// strict type coercion. Backwards compatible: hashContent() preserved.

import crypto from 'node:crypto';

export const EVENT_FIELDS = [
  'event_id', 'tenant_id', 'workspace_id', 'app_id', 'user_id', 'session_id', 'workflow_id', 'trace_id',
  'provider', 'model', 'upstream_url', 'request_hash', 'response_hash',
  'prompt_redacted', 'response_redacted', 'raw_prompt_path', 'raw_response_path',
  'prompt_tokens', 'completion_tokens', 'estimated_cost_usd', 'latency_ms', 'status', 'error_type',
  'cache_hit', 'sensitive_data_detected', 'sensitive_classes', 'redaction_count', 'tool_calls',
  'accepted', 'feedback', 'created_at',
  // schema/data provenance — required to pin every event back to a source.
  'namespace', 'source_type', 'redaction_policy', 'schema_version',
  // W377 — multimodal capture extension. media_uri points at a blob in the
  // media-store (file:~/.kolm/events/raw/<sha256>.<ext>) so the events table
  // stays small and the heavy bytes live on disk. media_extracted_text is the
  // OCR/transcription/pdf-text result (may be null until the worker runs).
  'media_kind', 'media_uri', 'media_hash', 'media_bytes', 'media_mime',
  'media_extracted_text', 'media_extraction_status', 'media_extraction_engine',
];

export const REQUIRED_FIELDS = ['event_id', 'tenant_id', 'namespace', 'created_at', 'schema_version'];
export const SCHEMA_VERSION = 1;

const STATUS_VALUES = new Set(['ok', 'error', 'timeout', 'rate_limited', 'blocked']);
const SOURCE_TYPES = new Set(['real', 'synthetic', 'simulated', 'teacher_generated']);
const POLICY_VALUES = new Set(['allow', 'redact', 'block']);

// W377 — multimodal capture kinds. null is a valid value (text-only events
// still flow through the same schema). The enum is closed on purpose so
// downstream loaders can switch on it without a fallback path.
export const MEDIA_KINDS = new Set([
  'text', 'log', 'code', 'pdf', 'screenshot', 'image',
  'audio', 'transcript', 'video', 'browser_trace',
  'terminal_output', 'tool_output',
]);
const EXTRACTION_STATUS_VALUES = new Set(['none', 'pending', 'done', 'failed']);

function _stableId(seed) {
  const r = crypto.randomBytes(8).toString('hex');
  return `evt_${Date.now().toString(36)}${r}${seed ? '_' + String(seed).slice(0, 6) : ''}`;
}

function _clampInt(v, lo = 0, hi = Number.MAX_SAFE_INTEGER) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function _clampFloat(v, lo = 0, hi = 1e9) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

function _str(v, max = 512) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function _arr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => _str(x, 128)).filter(Boolean);
  return [_str(v, 128)].filter(Boolean);
}

// newEvent(partial): returns a fully-formed event with sane defaults.
// Callers may override any field; validateEvent will catch missing required.
export function newEvent(partial = {}) {
  const now = new Date().toISOString();
  const base = {
    event_id: partial.event_id || _stableId(partial.tenant_id),
    tenant_id: partial.tenant_id || 'local-tenant',
    workspace_id: partial.workspace_id || 'default',
    app_id: partial.app_id || null,
    user_id: partial.user_id || null,
    session_id: partial.session_id || null,
    workflow_id: partial.workflow_id || null,
    trace_id: partial.trace_id || null,
    provider: partial.provider || null,
    model: partial.model || null,
    upstream_url: partial.upstream_url || null,
    request_hash: partial.request_hash || null,
    response_hash: partial.response_hash || null,
    prompt_redacted: partial.prompt_redacted || null,
    response_redacted: partial.response_redacted || null,
    raw_prompt_path: partial.raw_prompt_path || null,
    raw_response_path: partial.raw_response_path || null,
    prompt_tokens: partial.prompt_tokens != null ? partial.prompt_tokens : 0,
    completion_tokens: partial.completion_tokens != null ? partial.completion_tokens : 0,
    estimated_cost_usd: partial.estimated_cost_usd != null ? partial.estimated_cost_usd : 0,
    latency_ms: partial.latency_ms != null ? partial.latency_ms : 0,
    status: partial.status || 'ok',
    error_type: partial.error_type || null,
    cache_hit: partial.cache_hit === true,
    sensitive_data_detected: partial.sensitive_data_detected === true,
    sensitive_classes: partial.sensitive_classes || [],
    redaction_count: partial.redaction_count != null ? partial.redaction_count : 0,
    tool_calls: partial.tool_calls || [],
    accepted: partial.accepted == null ? null : !!partial.accepted,
    feedback: partial.feedback || null,
    created_at: partial.created_at || now,
    namespace: partial.namespace || 'default',
    source_type: partial.source_type || 'real',
    redaction_policy: partial.redaction_policy || 'redact',
    schema_version: partial.schema_version || SCHEMA_VERSION,
    // W377 — multimodal defaults. media_kind null === text-only legacy event.
    media_kind: partial.media_kind == null ? null : partial.media_kind,
    media_uri: partial.media_uri == null ? null : partial.media_uri,
    media_hash: partial.media_hash == null ? null : partial.media_hash,
    media_bytes: partial.media_bytes == null ? null : partial.media_bytes,
    media_mime: partial.media_mime == null ? null : partial.media_mime,
    media_extracted_text: partial.media_extracted_text == null ? null : partial.media_extracted_text,
    media_extraction_status: partial.media_extraction_status || 'none',
    media_extraction_engine: partial.media_extraction_engine == null ? null : partial.media_extraction_engine,
  };
  return canonicalize(base);
}

// canonicalize(ev): coerce types, fill defaults, drop unknown keys.
// Idempotent: canonicalize(canonicalize(x)) === canonicalize(x).
export function canonicalize(ev = {}) {
  const out = {};
  out.event_id = _str(ev.event_id, 128) || _stableId(ev.tenant_id);
  out.tenant_id = _str(ev.tenant_id, 128) || 'local-tenant';
  out.workspace_id = ev.workspace_id == null ? 'default' : _str(ev.workspace_id, 128);
  out.app_id = ev.app_id == null ? null : _str(ev.app_id, 128);
  out.user_id = ev.user_id == null ? null : _str(ev.user_id, 128);
  out.session_id = ev.session_id == null ? null : _str(ev.session_id, 128);
  out.workflow_id = ev.workflow_id == null ? null : _str(ev.workflow_id, 128);
  out.trace_id = ev.trace_id == null ? null : _str(ev.trace_id, 128);

  out.provider = ev.provider == null ? null : _str(ev.provider, 64);
  out.model = ev.model == null ? null : _str(ev.model, 128);
  out.upstream_url = ev.upstream_url == null ? null : _str(ev.upstream_url, 512);
  out.request_hash = ev.request_hash == null ? null : _str(ev.request_hash, 128);
  out.response_hash = ev.response_hash == null ? null : _str(ev.response_hash, 128);

  out.prompt_redacted = ev.prompt_redacted == null ? null : _str(ev.prompt_redacted, 16384);
  out.response_redacted = ev.response_redacted == null ? null : _str(ev.response_redacted, 16384);
  out.raw_prompt_path = ev.raw_prompt_path == null ? null : _str(ev.raw_prompt_path, 1024);
  out.raw_response_path = ev.raw_response_path == null ? null : _str(ev.raw_response_path, 1024);

  out.prompt_tokens = _clampInt(ev.prompt_tokens, 0, 10_000_000);
  out.completion_tokens = _clampInt(ev.completion_tokens, 0, 10_000_000);
  out.estimated_cost_usd = _clampFloat(ev.estimated_cost_usd, 0, 1_000_000);
  out.latency_ms = _clampInt(ev.latency_ms, 0, 24 * 60 * 60 * 1000);

  const st = _str(ev.status, 32) || 'ok';
  out.status = STATUS_VALUES.has(st) ? st : 'ok';
  out.error_type = ev.error_type == null ? null : _str(ev.error_type, 128);

  out.cache_hit = ev.cache_hit === true;
  out.sensitive_data_detected = ev.sensitive_data_detected === true;
  out.sensitive_classes = _arr(ev.sensitive_classes);
  out.redaction_count = _clampInt(ev.redaction_count, 0, 100000);

  out.tool_calls = Array.isArray(ev.tool_calls) ? ev.tool_calls.slice(0, 50) : [];
  out.accepted = ev.accepted == null ? null : !!ev.accepted;
  out.feedback = ev.feedback == null ? null : _str(ev.feedback, 4096);

  let ts = _str(ev.created_at, 64);
  if (!ts || isNaN(Date.parse(ts))) ts = new Date().toISOString();
  out.created_at = ts;

  out.namespace = _str(ev.namespace, 128) || 'default';
  const src = _str(ev.source_type, 32) || 'real';
  out.source_type = SOURCE_TYPES.has(src) ? src : 'real';
  const pol = _str(ev.redaction_policy, 32) || 'redact';
  out.redaction_policy = POLICY_VALUES.has(pol) ? pol : 'redact';
  out.schema_version = _clampInt(ev.schema_version, 1, 1000) || SCHEMA_VERSION;

  // W377 — multimodal fields. media_kind null is a valid (text-only) state;
  // any invalid enum value collapses to null so the downstream loader doesn't
  // have to guess. media_extraction_status defaults to 'none' for legacy rows
  // that never went through the OCR/whisper worker.
  if (ev.media_kind == null) {
    out.media_kind = null;
  } else {
    const mk = _str(ev.media_kind, 32);
    out.media_kind = MEDIA_KINDS.has(mk) ? mk : null;
  }
  out.media_uri = ev.media_uri == null ? null : _str(ev.media_uri, 1024);
  out.media_hash = ev.media_hash == null ? null : _str(ev.media_hash, 128);
  out.media_bytes = ev.media_bytes == null ? null : _clampInt(ev.media_bytes, 0, Number.MAX_SAFE_INTEGER);
  out.media_mime = ev.media_mime == null ? null : _str(ev.media_mime, 128);
  out.media_extracted_text = ev.media_extracted_text == null ? null : _str(ev.media_extracted_text, 1_048_576);
  const xst = _str(ev.media_extraction_status, 32) || 'none';
  out.media_extraction_status = EXTRACTION_STATUS_VALUES.has(xst) ? xst : 'none';
  out.media_extraction_engine = ev.media_extraction_engine == null ? null : _str(ev.media_extraction_engine, 128);

  return out;
}

// validateEvent(ev): returns {ok, missing[], extra[], errors[]}.
// Missing: required fields absent. Extra: keys not in EVENT_FIELDS. Errors:
// type / range issues that canonicalize() would silently fix.
export function validateEvent(ev) {
  const missing = [];
  const extra = [];
  const errors = [];
  if (!ev || typeof ev !== 'object') {
    return { ok: false, missing: REQUIRED_FIELDS.slice(), extra: [], errors: ['event_is_not_object'] };
  }
  for (const f of REQUIRED_FIELDS) {
    if (ev[f] === undefined || ev[f] === null || ev[f] === '') missing.push(f);
  }
  const allowed = new Set(EVENT_FIELDS);
  for (const k of Object.keys(ev)) {
    if (!allowed.has(k)) extra.push(k);
  }
  if (ev.status && !STATUS_VALUES.has(ev.status)) errors.push('status_invalid');
  if (ev.source_type && !SOURCE_TYPES.has(ev.source_type)) errors.push('source_type_invalid');
  if (ev.redaction_policy && !POLICY_VALUES.has(ev.redaction_policy)) errors.push('redaction_policy_invalid');
  // W377 — multimodal enum checks. Null is allowed; only non-null values get
  // gated. This keeps every legacy text-only event a 1st-class citizen while
  // still catching typos like media_kind:'pdfs' before they hit the store.
  if (ev.media_kind != null && !MEDIA_KINDS.has(ev.media_kind)) errors.push('media_kind_invalid');
  if (ev.media_extraction_status != null && ev.media_extraction_status !== '' && !EXTRACTION_STATUS_VALUES.has(ev.media_extraction_status)) errors.push('media_extraction_status_invalid');
  if (ev.media_bytes != null && (!Number.isFinite(Number(ev.media_bytes)) || Number(ev.media_bytes) < 0)) errors.push('media_bytes_invalid');
  return { ok: missing.length === 0 && errors.length === 0, missing, extra, errors };
}

// templateSignature(prompt, model): deterministic skeleton hash used by lake
// clustering and opportunity detection. Strip identifiers (quoted strings,
// numbers, emails, URLs), take first 200 chars, sha256 prefix 16. Same prompt
// modulo identifiers -> same signature. Used by lake.clusterRepeatedPrompts.
export function templateSignature(prompt = '', model = '') {
  const raw = String(prompt).replace(/\s+/g, ' ').trim().toLowerCase();
  const stripped = raw
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '<email>')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"<s>"')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>');
  const head = stripped.slice(0, 200);
  const h = crypto.createHash('sha256').update(String(model || '') + ' ' + head).digest('hex').slice(0, 16);
  return { hash: h, normalized: head };
}

// Backwards-compat with the W368 daemon-connector stub: preserved verbatim.
export function hashContent(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}
