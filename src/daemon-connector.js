// W368 — local daemon-connector. THE WEDGE.
//
// Usage from the user's POV:
//
//   npm install -g kolm
//   kolm connect start
//   export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
//   export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
//   export OPENROUTER_BASE_URL=http://127.0.0.1:8787/v1
//   # ANY existing OpenAI/Anthropic/OpenRouter SDK call gets captured,
//   # redacted, costed, latency-tracked, written to ~/.kolm/events/, and
//   # forwarded upstream with the user's own API key.
//
// This module owns the local proxy. It runs in-process (kolm connect start)
// or detached (kolm connect start --detach). It writes a PID file at
// ~/.kolm/daemon.pid so `kolm connect status|stop` can find it.
//
// The daemon mounts a slim express app with new "direct forwarding" routes
// and a /v1/health snapshot. It does NOT mount the big buildRouter() — the
// connector daemon is a focused local proxy, not the full kolm.ai surface.
// (The same direct-forwarding routes are also added to buildRouter() so the
// cloud deployment supports them, see src/router.js.)
//
// Persistence: every captured round-trip is written via insertCapture() from
// src/capture-store.js. The default driver is the local SQLite store under
// ~/.kolm/events/events.sqlite — durable, queryable, survives reboots.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import express from 'express';

import { PROVIDERS, summarizeProviders } from './provider-registry.js';
import { estimateCost, extractUsage } from './cost-estimator.js';
import { newEvent, hashContent } from './event-schema.js';
import { scan as privacyScan, redact as privacyRedact, reinsert as privacyReinsert } from './privacy-membrane.js';
import { insertCapture, isDurable as captureIsDurable, driverName as captureDriverName, health as captureStoreHealth } from './capture-store.js';

const HOME = os.homedir();
const KOLM_DIR = path.join(HOME, '.kolm');
const PID_PATH = path.join(KOLM_DIR, 'daemon.pid');
const CONFIG_PATH = path.join(KOLM_DIR, 'config.json');
const EVENTS_DIR = path.join(KOLM_DIR, 'events');
const RAW_DIR = path.join(EVENTS_DIR, 'raw');

const DAEMON_VERSION = '0.2.6';
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';

function ensureDirs(dataDir) {
  const base = dataDir || KOLM_DIR;
  for (const d of [base, path.join(base, 'events'), path.join(base, 'events', 'raw')]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function loadDaemonConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

function readPidRecord() {
  if (!fs.existsSync(PID_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(PID_PATH, 'utf-8')); } catch { return null; }
}

function writePidRecord(rec) {
  ensureDirs();
  fs.writeFileSync(PID_PATH, JSON.stringify(rec, null, 2));
  try { fs.chmodSync(PID_PATH, 0o600); } catch (_) {}
}

function removePidRecord() {
  try { fs.unlinkSync(PID_PATH); } catch (_) {}
}

// Resolve the upstream key the daemon will forward with. Priority:
//   1. Authorization header from the app (Bearer ... or raw key)
//   2. x-upstream-api-key header (legacy)
//   3. Env var (per provider registry)
//   4. Stored config ~/.kolm/config.json upstream_keys.<provider>
export function resolveUpstreamKey(provider, req) {
  const auth = String(req && req.headers && req.headers.authorization || '');
  if (auth) {
    const m = auth.match(/^Bearer\s+(\S+)$/i);
    if (m) return m[1];
    return auth.trim();
  }
  const xKey = String(req && req.headers && req.headers['x-upstream-api-key'] || '');
  if (xKey) return xKey;
  const cfg = PROVIDERS[provider];
  if (cfg && cfg.env_key && process.env[cfg.env_key]) return process.env[cfg.env_key];
  const stored = loadDaemonConfig();
  if (stored && stored.upstream_keys && stored.upstream_keys[provider]) {
    return stored.upstream_keys[provider];
  }
  return null;
}

// Read privacy policy from ~/.kolm/config.json. Defaults to 'allow'.
function loadPolicy() {
  const cfg = loadDaemonConfig();
  const p = String((cfg && cfg.privacy_policy) || process.env.KOLM_PRIVACY_POLICY || 'allow').toLowerCase();
  if (p === 'redact' || p === 'block' || p === 'allow') return p;
  return 'allow';
}

// Fire an HTTPS request to the upstream. Native node:http(s) so we don't
// inherit the W305 libuv-fetch trap on Windows when the daemon shuts down.
function forwardRaw({ url, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const hdr = { ...headers };
    if (payload) hdr['content-length'] = Buffer.byteLength(payload).toString();
    const t0 = process.hrtime.bigint();
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: method || 'POST',
      headers: hdr,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        const elapsed_us = Math.round(Number(process.hrtime.bigint() - t0) / 1000);
        let json;
        try { json = JSON.parse(buf); } catch (_) { json = { _raw: buf }; }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw_text: buf, elapsed_us });
      });
    });
    req.setTimeout(120_000, () => { try { req.destroy(new Error('upstream_timeout')); } catch (_) {} });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Extract the "prompt" string from a request body for hashing + redaction.
function extractPromptText(body, provider) {
  if (!body || typeof body !== 'object') return '';
  if (provider === 'anthropic') {
    const sys = typeof body.system === 'string' ? body.system : '';
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const turns = msgs.map((m) => {
      if (!m) return '';
      const role = m.role || 'user';
      const c = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((x) => (x && (x.text || x.content)) || '').join('\n')
          : '';
      return role + ': ' + c;
    }).filter(Boolean).join('\n\n');
    return (sys ? 'system: ' + sys + '\n\n' : '') + turns;
  }
  // openai / openrouter
  if (Array.isArray(body.messages)) {
    return body.messages.map((m) => {
      const role = m && m.role || 'user';
      const c = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((x) => (x && (x.text || x.content)) || '').join('\n')
          : '';
      return role + ': ' + c;
    }).join('\n\n');
  }
  if (typeof body.input === 'string') return body.input;
  if (typeof body.prompt === 'string') return body.prompt;
  return '';
}

function extractCompletionText(json, provider) {
  if (!json || typeof json !== 'object') return '';
  if (provider === 'anthropic') {
    const blocks = Array.isArray(json.content) ? json.content : [];
    return blocks.map((b) => (b && b.text) || '').join('').trim();
  }
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const first = choices[0] || {};
  const msg = first.message || {};
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map((c) => (c && c.text) || '').join('');
  return String(first.text || '');
}

// The HEAVY lifting: read the inbound request, redact, forward upstream,
// extract usage/cost, write the event to the capture store. Returns
// {status, headers, body, event} or {status, body, event:null} on error.
async function proxyOne({ provider, upstreamPath, req }) {
  const pcfg = PROVIDERS[provider];
  if (!pcfg) return { status: 400, body: { error: { type: 'unknown_provider', message: provider } }, event: null };
  const upstreamKey = resolveUpstreamKey(provider, req);
  if (!upstreamKey) {
    return {
      status: 401,
      body: {
        error: {
          type: 'missing_upstream_credentials',
          message: `no upstream credentials for ${provider}; set ${pcfg.env_key} in env or run: kolm connect config --set ${provider.toLowerCase()}_api_key=<key>`,
        },
      },
      event: null,
    };
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const model = String(body.model || '').slice(0, 128);
  const policy = loadPolicy();
  const promptText = extractPromptText(body, provider);
  const scan = privacyScan(promptText);
  if (policy === 'block' && scan.sensitive && req.headers['x-kolm-privacy-override'] !== 'true') {
    return {
      status: 451,
      body: {
        error: {
          type: 'privacy_blocked',
          classes: scan.classes,
          message: 'sensitive data detected; pass x-kolm-privacy-override: true to allow',
        },
      },
      event: null,
    };
  }
  let forwardBody = body;
  let placeholderMap = null;
  if (policy === 'redact' && scan.sensitive) {
    const r = privacyRedact(promptText);
    placeholderMap = r.map;
    // Best-effort: replace the prompt text in messages[].content with redacted text.
    if (Array.isArray(forwardBody.messages)) {
      forwardBody = JSON.parse(JSON.stringify(body));
      for (const m of forwardBody.messages) {
        if (typeof m.content === 'string') {
          for (const [ph, val] of Object.entries(placeholderMap)) {
            m.content = m.content.split(val).join(ph);
          }
        }
      }
    }
  }
  const upstreamUrl = pcfg.upstream.replace(/\/+$/, '') + upstreamPath;
  const headers = { 'content-type': 'application/json' };
  if (pcfg.auth === 'bearer') {
    headers['authorization'] = `Bearer ${upstreamKey}`;
  } else if (pcfg.auth === 'x-api-key') {
    headers['x-api-key'] = upstreamKey;
    headers['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
  }
  // OpenRouter helpful headers (referer + title) for ranking.
  if (provider === 'openrouter') {
    headers['http-referer'] = req.headers['http-referer'] || 'https://kolm.ai';
    headers['x-title'] = req.headers['x-title'] || 'kolm.ai';
  }
  let upstreamResp;
  try {
    upstreamResp = await forwardRaw({ url: upstreamUrl, method: 'POST', headers, body: forwardBody });
  } catch (e) {
    const ev = newEvent({
      tenant_id: 'local',
      namespace: 'default',
      provider,
      model,
      upstream_url: upstreamUrl,
      request_hash: hashContent(promptText + '|' + model),
      response_hash: null,
      prompt_redacted: policy === 'redact' && placeholderMap ? privacyRedact(promptText).redacted_text : null,
      response_redacted: null,
      latency_ms: 0,
      status: 'error',
      error_type: 'upstream_error',
      sensitive_data_detected: scan.sensitive,
      sensitive_classes: scan.classes,
      redaction_policy: policy,
      source_type: 'real',
    });
    let durable = true;
    try { await insertCapture(eventToObservationRow(ev, promptText, '')); } catch (_) { durable = false; }
    return {
      status: 502,
      body: { error: { type: 'upstream_error', message: String(e.message || e) } },
      event: ev,
      durable,
      http_status: 0,
    };
  }
  let respText = extractCompletionText(upstreamResp.body, provider);
  // If we redacted on the way out, reinsert placeholders in the response.
  if (placeholderMap && respText) {
    respText = privacyReinsert(respText, placeholderMap);
  }
  const usage = extractUsage(upstreamResp.body, provider);
  const cost = estimateCost({ provider, model, prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens });
  const httpStatus = upstreamResp.status;
  let canonStatus = 'ok';
  if (httpStatus === 429) canonStatus = 'rate_limited';
  else if (httpStatus === 408 || httpStatus === 504) canonStatus = 'timeout';
  else if (httpStatus >= 400) canonStatus = 'error';
  const ev = newEvent({
    tenant_id: 'local',
    namespace: 'default',
    provider,
    model,
    upstream_url: upstreamUrl,
    request_hash: hashContent(promptText + '|' + model),
    response_hash: hashContent(respText),
    prompt_redacted: policy === 'redact' && placeholderMap ? privacyRedact(promptText).redacted_text : null,
    response_redacted: policy === 'redact' && placeholderMap ? privacyRedact(respText).redacted_text : null,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    estimated_cost_usd: cost,
    latency_ms: Math.round((upstreamResp.elapsed_us || 0) / 1000),
    status: canonStatus,
    error_type: httpStatus >= 400 ? 'upstream_status_' + httpStatus : null,
    sensitive_data_detected: scan.sensitive,
    sensitive_classes: scan.classes,
    redaction_count: placeholderMap ? Object.keys(placeholderMap).length : 0,
    redaction_policy: policy,
    source_type: 'real',
  });
  // Persist via the capture store. Failure → still return the upstream result
  // to the app, but mark the event as undurable; this preserves end-user UX
  // (their LLM call succeeded) while making the storage problem visible via
  // x-kolm-event-durable: false header.
  let durable = true;
  try {
    await insertCapture(eventToObservationRow(ev, promptText, respText));
  } catch (_) {
    durable = false;
  }
  return {
    status: httpStatus,
    http_status: httpStatus,
    headers: upstreamResp.headers,
    body: upstreamResp.body,
    event: ev,
    durable,
  };
}

// Adapt the canonical event row to the legacy 'observations' shape used by
// src/capture-store.js insertCapture. Keeps the dashboard + distill paths
// reading the same store.
function eventToObservationRow(ev, promptText, respText) {
  return {
    id: ev.event_id,
    tenant: ev.tenant_id,
    template_hash: ev.request_hash,
    template_preview: String(promptText || '').slice(0, 200),
    model: ev.model,
    prompt: String(promptText || '').slice(0, 8000),
    variable_input: null,
    response: String(respText || '').slice(0, 16000),
    latency_ms: ev.latency_ms,
    latency_us: ev.latency_ms * 1000,
    cost_usd: ev.estimated_cost_usd,
    provider: ev.provider,
    corpus_namespace: ev.workspace_id || 'default',
    status: ev.status,
    sensitive_classes: ev.sensitive_classes,
    redaction_count: ev.redaction_count,
    event_id: ev.event_id,
    created_at: ev.created_at,
  };
}

// Build the express app the daemon listens on.
export function buildDaemonApp({ dataDir } = {}) {
  ensureDirs(dataDir);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true }));

  let totalEvents = 0;
  const startedAt = Date.now();

  // Permissive CORS for SDK calls from browser-side apps (when the user
  // points window.OPENAI_BASE_URL at the local daemon).
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Upstream-Api-Key, anthropic-version, x-kolm-privacy-override');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  async function handlePassthrough(provider, upstreamPath, req, res) {
    const out = await proxyOne({ provider, upstreamPath, req });
    if (out.event) {
      res.set('x-kolm-event-id', out.event.event_id);
      res.set('x-kolm-provider', out.event.provider || provider);
      res.set('x-kolm-model', String(out.event.model || ''));
      res.set('x-kolm-event-durable', String(out.durable !== false));
      if (out.event.sensitive_data_detected) {
        res.set('x-kolm-sensitive-classes', (out.event.sensitive_classes || []).join(','));
      }
      totalEvents += 1;
    }
    res.status(out.status).json(out.body);
  }

  // OpenAI-compatible direct.
  for (const p of ['/v1/chat/completions', '/v1/responses', '/v1/embeddings', '/v1/audio/transcriptions', '/v1/audio/translations', '/v1/audio/speech', '/v1/moderations']) {
    app.post(p, (req, res) => handlePassthrough('openai', p, req, res));
  }

  // OpenRouter direct + capture alias for SDKs whose base URL is .../v1.
  app.post('/v1/capture/openrouter', (req, res) => handlePassthrough('openrouter', '/v1/chat/completions', req, res));
  app.post('/v1/capture/openrouter/v1/chat/completions', (req, res) => handlePassthrough('openrouter', '/v1/chat/completions', req, res));
  app.post('/openrouter/v1/chat/completions', (req, res) => handlePassthrough('openrouter', '/v1/chat/completions', req, res));

  // Anthropic direct.
  app.post('/v1/messages', (req, res) => handlePassthrough('anthropic', '/v1/messages', req, res));
  app.post('/anthropic/v1/messages', (req, res) => handlePassthrough('anthropic', '/v1/messages', req, res));

  // Gemini (key passed as ?key= param, not header).
  app.post(/^\/v1beta\/models\/[^/]+:(generate|streamGenerate)Content$/, (req, res) => {
    const upstreamPath = req.path + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
    handlePassthrough('gemini', upstreamPath, req, res);
  });

  // /v1/health — daemon snapshot for `kolm connect status|doctor`.
  app.get('/v1/health', async (_req, res) => {
    let storage = path.join(KOLM_DIR, 'events', 'events.sqlite');
    let storageHealth = null;
    try { storageHealth = await captureStoreHealth(); } catch (_) {}
    const providers = summarizeProviders();
    const reach = await Promise.all(Object.entries(PROVIDERS).map(async ([id, cfg]) => {
      try {
        const url = new URL(cfg.upstream);
        const lib = url.protocol === 'https:' ? https : http;
        return await new Promise((resolve) => {
          const t = setTimeout(() => resolve([id, false]), 2000);
          const r = lib.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: '/',
            method: 'HEAD',
            timeout: 2000,
          }, (resp) => { clearTimeout(t); resolve([id, !!resp.statusCode]); resp.resume(); });
          r.on('error', () => { clearTimeout(t); resolve([id, false]); });
          r.end();
        });
      } catch (_) { return [id, false]; }
    }));
    for (const [id, ok] of reach) {
      providers[id].upstream_reachable = !!ok;
    }
    res.json({
      ok: true,
      version: DAEMON_VERSION,
      port: res.app.get('kolm:port') || DEFAULT_PORT,
      host: res.app.get('kolm:host') || DEFAULT_HOST,
      pid: process.pid,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      captured_events: totalEvents,
      storage_path: storage,
      storage_driver: captureDriverName(),
      storage_durable: captureIsDurable(),
      storage_health: storageHealth,
      providers,
      policy: loadPolicy(),
    });
  });

  // /health — public lightweight probe, no secrets, matches `kolm health` shape.
  app.get('/health', (_req, res) => res.json({ status: 'ok', version: DAEMON_VERSION, kind: 'connector_daemon' }));

  return { app, getTotal: () => totalEvents };
}

// Start the daemon. Returns {server, port, pid}.
export async function startDaemon({ port, host, dataDir } = {}) {
  // port=0 must round-trip as 0 so the OS picks a free port; only fall back to
  // DEFAULT_PORT when the caller passed undefined/null.
  const portRaw = (port == null) ? (process.env.KOLM_DAEMON_PORT || DEFAULT_PORT) : port;
  const p = parseInt(portRaw, 10);
  const h = host || process.env.KOLM_DAEMON_HOST || DEFAULT_HOST;
  ensureDirs(dataDir);
  const { app } = buildDaemonApp({ dataDir });
  app.set('kolm:port', p);
  app.set('kolm:host', h);
  return await new Promise((resolve, reject) => {
    const server = app.listen(p, h, () => {
      const addr = server.address();
      const actualPort = (typeof addr === 'object' && addr && addr.port) ? addr.port : p;
      writePidRecord({
        pid: process.pid,
        port: actualPort,
        host: h,
        started_at: new Date().toISOString(),
        version: DAEMON_VERSION,
      });
      resolve({ server, port: actualPort, host: h, pid: process.pid });
    });
    server.on('error', reject);
  });
}

// Stop the daemon. Accepts a server instance (in-process) or a PID record.
export async function stopDaemon(target) {
  if (target && typeof target.close === 'function') {
    return await new Promise((resolve) => target.close(() => { removePidRecord(); resolve(true); }));
  }
  const rec = target && target.pid ? target : readPidRecord();
  if (!rec || !rec.pid) {
    removePidRecord();
    return false;
  }
  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch (e) {
    if (e && e.code !== 'ESRCH') throw e;
  }
  removePidRecord();
  return true;
}

// Check daemon status — reads PID file + checks if alive.
export function daemonStatus() {
  const rec = readPidRecord();
  if (!rec) return { running: false };
  let alive = false;
  try {
    process.kill(rec.pid, 0);
    alive = true;
  } catch (_) { alive = false; }
  return { running: alive, ...rec, pid_file: PID_PATH };
}

export const _internals = {
  KOLM_DIR,
  PID_PATH,
  CONFIG_PATH,
  EVENTS_DIR,
  proxyOne,
  eventToObservationRow,
  resolveUpstreamKey,
  loadPolicy,
};
