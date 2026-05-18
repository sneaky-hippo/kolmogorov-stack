// W378 — cloud-sync: privacy-gated outbound event sync.
//
// The local daemon writes every captured round-trip to the local event-store
// (src/event-store.js). This module is the (opt-in) bridge that pushes those
// rows to a cloud namespace so a team can share a corpus across machines.
//
// SECURITY POSTURE: the default state is `disabled` — *nothing* leaves the
// device until the user actively sets a state. Even after opt-in, the per-
// privacy-class blocklist gives the user a kill-switch per class (e.g.
// "never send rows that touched SSN") which is enforced before the HTTP
// upload, not server-side.
//
// =============================================================================
// 4-STATE SYNC MATRIX
// =============================================================================
//   state            | what is uploaded per event
//   -----------------+----------------------------------------------------------
//   disabled         | nothing. shouldSync returns false. (default)
//   metadata_only    | event_id, created_at, provider, model, prompt_tokens,
//                    | completion_tokens, estimated_cost_usd, latency_ms,
//                    | status, namespace. NEVER prompt or response text.
//   redacted_only    | metadata + prompt_redacted + response_redacted +
//                    | sensitive_classes + redaction_count. VAR_* placeholders
//                    | only — never the original strings from the vault.
//   raw_enabled      | everything in the canonical event (including
//                    | raw_prompt_path / raw_response_path pointers).
//                    | still gated by per-class blocklist.
//
// Per-class blocklist applies on top of the state filter: if any class in
// event.sensitive_classes appears in classes_blocked_from_sync, the event is
// dropped from this push (counted as `blocked`, audit-logged with the class).
//
// =============================================================================
// STORAGE
// =============================================================================
//   ~/.kolm/sync/state.json   - current state config (atomic write, 0600)
//   ~/.kolm/sync/audit.jsonl  - append-only log of every push/pull operation
// Honors $KOLM_DATA_DIR override (used by tests to point at a tmp dir).
//
// =============================================================================
// HTTP
// =============================================================================
// node:http(s) directly — NOT fetch (W305 lesson: undici's keep-alive socket
// pool crashes libuv on process.exit() under Windows). Per-request agent.
// Auth: Bearer api_key read from ~/.kolm/config.json. Missing key for a non-
// localhost cloud_base throws CloudSyncError('not_configured').
//
// POST ${cloud_base}/v1/sync/inbox   { events: [...], namespace, source_device_id }
//   2xx          -> { pushed, skipped, blocked, audit_id, reasons }
//   non-2xx      -> throws CloudSyncError with status + body snippet
//   socket error -> throws CloudSyncError('cloud_unreachable')

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

import { listEvents } from './event-store.js';
import { ALL_CLASSES as MEMBRANE_CLASSES } from './privacy-membrane.js';

// PRIVACY_CLASSES — single source of truth for class identifiers used in:
//   1. event.sensitive_classes (written by the daemon via privacy-membrane.scan)
//   2. classes_blocked_from_sync (user's per-class kill switch)
//   3. settings UI checkboxes
//
// We re-export privacy-membrane.ALL_CLASSES so the blocklist semantics match
// the detector exactly. If scan() emits class 'ssn' the blocklist key MUST
// be 'ssn' — earlier the cloud-sync constant was the HIPAA Safe Harbor
// uppercase set ('SSN', 'NAME', ...) which silently broke the gate because
// no event ever carried those class strings. Reconciled W380.
export const PRIVACY_CLASSES = Object.freeze([...MEMBRANE_CLASSES]);

// HIPAA Safe Harbor grouping for UI display. The /settings page groups the
// per-class checkboxes under these buckets so a HIPAA-aware reviewer can find
// the controls they expect. Each bucket lists the canonical lowercase class
// IDs that map to that Safe Harbor identifier. Buckets are display-only —
// the wire format is always the lowercase canonical class.
export const HIPAA_SAFE_HARBOR = Object.freeze({
  NAME:  ['name'],
  GEO:   ['address', 'internal_hostname'],
  DATE:  ['dob'],
  PHONE: ['phone'],
  FAX:   [],
  EMAIL: ['email'],
  SSN:   ['ssn', 'malformed_ssn'],
  MRN:   ['mrn'],
  ACCT:  ['account_number', 'customer_id'],
  IP:    ['ip_address'],
  URL:   ['database_url'],
  KEYS:  ['api_key', 'bearer_token', 'private_key'],
  OTHER: ['proprietary_term'],
});

export const STATES = Object.freeze([
  'disabled', 'metadata_only', 'redacted_only', 'raw_enabled',
]);

const METADATA_FIELDS = Object.freeze([
  'event_id', 'created_at', 'provider', 'model',
  'prompt_tokens', 'completion_tokens', 'estimated_cost_usd',
  'latency_ms', 'status', 'namespace',
]);

const REDACTED_FIELDS = Object.freeze([
  ...METADATA_FIELDS,
  'prompt_redacted', 'response_redacted',
  'sensitive_classes', 'redaction_count',
]);

// Raw mode uploads the canonical event verbatim (every key the schema knows).
// We don't whitelist a field list — we ship what the event-store gave us.
const RAW_MODE_SENTINEL = '__ALL_FIELDS__';

export class CloudSyncError extends Error {
  constructor(message, { code, status, body } = {}) {
    super(message);
    this.name = 'CloudSyncError';
    this.code = code || message;
    if (status != null) this.status = status;
    if (body != null) this.body = body;
  }
}

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _baseDir() {
  return process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
}

function _syncDir() {
  return path.join(_baseDir(), 'sync');
}

function _statePath() {
  return path.join(_syncDir(), 'state.json');
}

function _auditPath() {
  return path.join(_syncDir(), 'audit.jsonl');
}

function _configPath() {
  return path.join(_baseDir(), 'config.json');
}

function _deviceIdPath() {
  return path.join(_syncDir(), 'device.id');
}

function _ensureDirs() {
  const dir = _syncDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _atomicWrite(p, body, mode = 0o600) {
  _ensureDirs();
  const tmp = p + '.tmp.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, body, 'utf8');
  try { fs.chmodSync(tmp, mode); } catch {}
  fs.renameSync(tmp, p);
}

function _readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

function _getDeviceId() {
  _ensureDirs();
  const p = _deviceIdPath();
  if (fs.existsSync(p)) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch {}
  }
  const id = 'dev_' + crypto.randomBytes(8).toString('hex');
  try { _atomicWrite(p, id, 0o600); } catch {}
  return id;
}

function _loadApiKey() {
  const c = _readJson(_configPath(), {});
  if (process.env.KOLM_API_KEY) return process.env.KOLM_API_KEY;
  return (c && c.api_key) || null;
}

const DEFAULT_STATE = Object.freeze({
  state: 'disabled',
  last_push_at: null,
  last_pull_at: null,
  cloud_base: '',
  namespace: 'default',
  classes_blocked_from_sync: [],
});

export function validateClass(className) {
  if (typeof className !== 'string') return false;
  return PRIVACY_CLASSES.includes(className);
}

function _validateState(state) {
  return typeof state === 'string' && STATES.includes(state);
}

// getSyncState() — returns the persisted config, falling back to defaults if
// the state file is missing or corrupt. Always returns the full shape.
export function getSyncState() {
  const raw = _readJson(_statePath(), null);
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
  const out = { ...DEFAULT_STATE, ...raw };
  // Sanitize: classes_blocked_from_sync must be an array of valid class strings.
  if (!Array.isArray(out.classes_blocked_from_sync)) out.classes_blocked_from_sync = [];
  out.classes_blocked_from_sync = out.classes_blocked_from_sync.filter(validateClass);
  if (!_validateState(out.state)) out.state = 'disabled';
  return out;
}

// setSyncState({state?, cloud_base?, namespace?, classes_blocked_from_sync?})
// Partial update — only provided keys overwrite. Throws CloudSyncError on
// invalid state enum or unknown privacy class.
export function setSyncState(patch = {}) {
  const cur = getSyncState();
  const next = { ...cur };
  if (patch.state !== undefined) {
    if (!_validateState(patch.state)) {
      throw new CloudSyncError(
        'invalid_state:' + String(patch.state) + ' (must be one of: ' + STATES.join(', ') + ')',
        { code: 'invalid_state' },
      );
    }
    next.state = patch.state;
  }
  if (patch.cloud_base !== undefined) {
    next.cloud_base = String(patch.cloud_base || '');
  }
  if (patch.namespace !== undefined) {
    next.namespace = String(patch.namespace || 'default');
  }
  if (patch.classes_blocked_from_sync !== undefined) {
    if (!Array.isArray(patch.classes_blocked_from_sync)) {
      throw new CloudSyncError('classes_blocked_from_sync must be an array', { code: 'invalid_classes' });
    }
    for (const c of patch.classes_blocked_from_sync) {
      if (!validateClass(c)) {
        throw new CloudSyncError(
          'invalid_class:' + String(c) + ' (must be one of: ' + PRIVACY_CLASSES.join(', ') + ')',
          { code: 'invalid_class' },
        );
      }
    }
    next.classes_blocked_from_sync = patch.classes_blocked_from_sync.slice();
  }
  _atomicWrite(_statePath(), JSON.stringify(next, null, 2));
  return next;
}

// Internal helper exported for tests + the wire-up consolidator. Returns
// {sync:true, fields:[...]} or {sync:false, reason}. Mirrors the state matrix
// at the top of this file 1:1.
export function shouldSync(event, state, classesBlocked = []) {
  if (state === 'disabled') return { sync: false, reason: 'disabled' };
  if (Array.isArray(event && event.sensitive_classes) && Array.isArray(classesBlocked) && classesBlocked.length) {
    for (const cls of event.sensitive_classes) {
      if (classesBlocked.includes(cls)) {
        return { sync: false, reason: 'class_blocked:' + cls };
      }
    }
  }
  if (state === 'metadata_only') return { sync: true, fields: METADATA_FIELDS.slice() };
  if (state === 'redacted_only') return { sync: true, fields: REDACTED_FIELDS.slice() };
  if (state === 'raw_enabled') return { sync: true, fields: RAW_MODE_SENTINEL };
  return { sync: false, reason: 'unknown_state' };
}

function _projectEvent(event, fields) {
  if (fields === RAW_MODE_SENTINEL) return { ...event };
  const out = {};
  for (const f of fields) {
    if (event[f] !== undefined) out[f] = event[f];
  }
  return out;
}

// _appendAudit({op, state, count, reasons, audit_id?, extra}) — append a
// single row to audit.jsonl. Audit IDs are generated here so callers don't
// have to construct them. Each row gets a wall-clock timestamp.
function _appendAudit(row) {
  _ensureDirs();
  const audit_id = row.audit_id || ('aud_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'));
  const entry = {
    audit_id,
    ts: new Date().toISOString(),
    op: row.op,
    state: row.state,
    count: row.count || 0,
    reasons: row.reasons || {},
    ...row.extra,
  };
  fs.appendFileSync(_auditPath(), JSON.stringify(entry) + '\n', 'utf8');
  return audit_id;
}

// auditLog({limit=50}) — return recent audit rows in reverse-chrono order.
export function auditLog({ limit = 50 } = {}) {
  const p = _auditPath();
  if (!fs.existsSync(p)) return [];
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch {}
  }
  rows.reverse();
  const n = Math.max(0, Math.min(Number(limit) || 0, rows.length));
  return rows.slice(0, n);
}

// _httpRequest({base, method, path, headers, body}) -> {status, body, headers}
// Promise-wraps node:http(s). NEVER uses fetch (W305 libuv crash on exit).
function _httpRequest({ base, method = 'POST', pathSuffix = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(pathSuffix, base.endsWith('/') ? base : base + '/'); }
    catch (e) {
      reject(new CloudSyncError('invalid_cloud_base:' + base, { code: 'invalid_cloud_base' }));
      return;
    }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const opts = {
      host: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        ...headers,
      },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: buf.toString('utf8'),
        });
      });
      res.on('error', (e) => reject(new CloudSyncError('cloud_unreachable:' + e.message, { code: 'cloud_unreachable' })));
    });
    req.on('error', (e) => reject(new CloudSyncError('cloud_unreachable:' + e.message, { code: 'cloud_unreachable' })));
    req.setTimeout(15_000, () => {
      try { req.destroy(new Error('timeout')); } catch {}
      reject(new CloudSyncError('cloud_unreachable:timeout', { code: 'cloud_unreachable' }));
    });
    if (body) req.write(body);
    req.end();
  });
}

function _isLocalBase(base) {
  if (!base) return true;
  try {
    const u = new URL(base);
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  } catch { return true; }
  return false;
}

// pushEvents({since, limit=100, dryRun=false}) — read events from event-store,
// filter by state + per-class blocklist, POST to cloud. Returns
// {pushed, skipped, blocked, audit_id, reasons}.
export async function pushEvents({ since, limit = 100, dryRun = false } = {}) {
  const cfg = getSyncState();
  const reasons = {};

  // Disabled is a hard short-circuit, regardless of dryRun.
  if (cfg.state === 'disabled') {
    reasons['disabled'] = 1;
    const audit_id = _appendAudit({
      op: 'push', state: cfg.state, count: 0, reasons,
      extra: { pushed: 0, skipped: 0, blocked: 0, dry_run: !!dryRun },
    });
    return { pushed: 0, skipped: 1, blocked: 0, audit_id, reasons };
  }

  const events = await listEvents({
    namespace: cfg.namespace,
    since,
    limit: Math.max(1, Number(limit) || 100),
    order: 'asc',
  });

  const payloadEvents = [];
  let skipped = 0;
  let blocked = 0;
  for (const ev of events) {
    const decision = shouldSync(ev, cfg.state, cfg.classes_blocked_from_sync);
    if (!decision.sync) {
      const r = decision.reason || 'skipped';
      reasons[r] = (reasons[r] || 0) + 1;
      if (r.startsWith('class_blocked:')) blocked += 1;
      else skipped += 1;
      continue;
    }
    payloadEvents.push(_projectEvent(ev, decision.fields));
  }

  if (dryRun) {
    const audit_id = _appendAudit({
      op: 'push', state: cfg.state, count: payloadEvents.length, reasons,
      extra: {
        pushed: payloadEvents.length, skipped, blocked,
        dry_run: true, cloud_base: cfg.cloud_base, namespace: cfg.namespace,
      },
    });
    return {
      pushed: payloadEvents.length,
      skipped,
      blocked,
      audit_id,
      reasons,
    };
  }

  // Nothing to push? still log it so the audit trail records the no-op.
  if (payloadEvents.length === 0) {
    const audit_id = _appendAudit({
      op: 'push', state: cfg.state, count: 0, reasons,
      extra: {
        pushed: 0, skipped, blocked, dry_run: false,
        cloud_base: cfg.cloud_base, namespace: cfg.namespace,
      },
    });
    // Refresh last_push_at even on no-op to mark "the daemon checked in".
    setSyncState({}); // no-op preserve
    const cur = getSyncState();
    cur.last_push_at = new Date().toISOString();
    _atomicWrite(_statePath(), JSON.stringify(cur, null, 2));
    return { pushed: 0, skipped, blocked, audit_id, reasons };
  }

  // Network mode requires an api_key unless the base is localhost (test mode).
  const apiKey = _loadApiKey();
  if (!cfg.cloud_base) {
    throw new CloudSyncError('not_configured: cloud_base is empty', { code: 'not_configured' });
  }
  const local = _isLocalBase(cfg.cloud_base);
  if (!local && !apiKey) {
    throw new CloudSyncError('not_configured: no api_key in ~/.kolm/config.json (run `kolm login`)', { code: 'not_configured' });
  }

  const body = JSON.stringify({
    events: payloadEvents,
    namespace: cfg.namespace,
    source_device_id: _getDeviceId(),
    state: cfg.state,
  });

  const headers = {
    'X-Kolm-Sync-State': cfg.state,
    'X-Kolm-Source-Device': _getDeviceId(),
  };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  let res;
  try {
    res = await _httpRequest({
      base: cfg.cloud_base,
      method: 'POST',
      pathSuffix: '/v1/sync/inbox',
      headers,
      body,
    });
  } catch (e) {
    // Even on transport failure we record an audit row so the operator can see
    // the attempt. Re-throw the original CloudSyncError so callers can handle.
    _appendAudit({
      op: 'push', state: cfg.state, count: payloadEvents.length,
      reasons: { ...reasons, transport_error: 1 },
      extra: {
        pushed: 0, skipped, blocked, dry_run: false,
        cloud_base: cfg.cloud_base, namespace: cfg.namespace,
        error: e && e.message ? e.message : String(e),
      },
    });
    throw e;
  }

  if (res.status < 200 || res.status >= 300) {
    const snippet = (res.body || '').slice(0, 512);
    _appendAudit({
      op: 'push', state: cfg.state, count: payloadEvents.length,
      reasons: { ...reasons, http_error: 1 },
      extra: {
        pushed: 0, skipped, blocked, dry_run: false,
        cloud_base: cfg.cloud_base, namespace: cfg.namespace,
        status: res.status, body_snippet: snippet,
      },
    });
    throw new CloudSyncError(
      'cloud_http_error: ' + res.status + ' ' + snippet,
      { code: 'cloud_http_error', status: res.status, body: snippet },
    );
  }

  // Success — update last_push_at + write audit.
  const cur = getSyncState();
  cur.last_push_at = new Date().toISOString();
  _atomicWrite(_statePath(), JSON.stringify(cur, null, 2));

  const audit_id = _appendAudit({
    op: 'push', state: cfg.state, count: payloadEvents.length, reasons,
    extra: {
      pushed: payloadEvents.length, skipped, blocked, dry_run: false,
      cloud_base: cfg.cloud_base, namespace: cfg.namespace,
      status: res.status,
    },
  });

  return {
    pushed: payloadEvents.length,
    skipped,
    blocked,
    audit_id,
    reasons,
  };
}

// pullEvents({since, limit=100}) — for Team-tier shared-namespace pulls. Issues
// GET ${cloud_base}/v1/sync/outbox?namespace=...&since=...&limit=... and
// returns {pulled, audit_id}. The caller is responsible for writing the pulled
// rows back into the local event-store (the consolidator wires this).
export async function pullEvents({ since, limit = 100 } = {}) {
  const cfg = getSyncState();
  if (cfg.state === 'disabled') {
    const audit_id = _appendAudit({
      op: 'pull', state: cfg.state, count: 0,
      reasons: { disabled: 1 },
      extra: { pulled: 0, cloud_base: cfg.cloud_base, namespace: cfg.namespace },
    });
    return { pulled: 0, audit_id, events: [] };
  }
  if (!cfg.cloud_base) {
    throw new CloudSyncError('not_configured: cloud_base is empty', { code: 'not_configured' });
  }
  const apiKey = _loadApiKey();
  const local = _isLocalBase(cfg.cloud_base);
  if (!local && !apiKey) {
    throw new CloudSyncError('not_configured: no api_key in ~/.kolm/config.json (run `kolm login`)', { code: 'not_configured' });
  }

  const q = new URLSearchParams();
  q.set('namespace', cfg.namespace);
  if (since) q.set('since', String(since));
  q.set('limit', String(Math.max(1, Number(limit) || 100)));
  const pathSuffix = '/v1/sync/outbox?' + q.toString();

  const headers = {};
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  let res;
  try {
    res = await _httpRequest({
      base: cfg.cloud_base,
      method: 'GET',
      pathSuffix,
      headers,
      body: '',
    });
  } catch (e) {
    _appendAudit({
      op: 'pull', state: cfg.state, count: 0,
      reasons: { transport_error: 1 },
      extra: {
        pulled: 0, cloud_base: cfg.cloud_base, namespace: cfg.namespace,
        error: e && e.message ? e.message : String(e),
      },
    });
    throw e;
  }

  if (res.status < 200 || res.status >= 300) {
    const snippet = (res.body || '').slice(0, 512);
    _appendAudit({
      op: 'pull', state: cfg.state, count: 0,
      reasons: { http_error: 1 },
      extra: {
        pulled: 0, cloud_base: cfg.cloud_base, namespace: cfg.namespace,
        status: res.status, body_snippet: snippet,
      },
    });
    throw new CloudSyncError(
      'cloud_http_error: ' + res.status + ' ' + snippet,
      { code: 'cloud_http_error', status: res.status, body: snippet },
    );
  }

  let parsed;
  try { parsed = JSON.parse(res.body || '{}'); }
  catch {
    throw new CloudSyncError('cloud_bad_response: not_json', { code: 'cloud_bad_response', body: (res.body || '').slice(0, 256) });
  }
  const events = Array.isArray(parsed.events) ? parsed.events : [];

  const cur = getSyncState();
  cur.last_pull_at = new Date().toISOString();
  _atomicWrite(_statePath(), JSON.stringify(cur, null, 2));

  const audit_id = _appendAudit({
    op: 'pull', state: cfg.state, count: events.length,
    reasons: {},
    extra: {
      pulled: events.length, cloud_base: cfg.cloud_base, namespace: cfg.namespace,
      status: res.status,
    },
  });

  return { pulled: events.length, audit_id, events };
}

// Reset hook for tests — wipes the on-disk state + audit log. Does NOT touch
// the event-store (callers reset that themselves).
export function _resetForTests() {
  const dir = _syncDir();
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
