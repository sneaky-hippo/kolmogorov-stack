#!/usr/bin/env node
// W240 — standalone HTTP capture-and-forward proxy service.
//
// node src/services/proxy.js --port=7403 [--host=127.0.0.1]
//                             [--upstream=https://api.openai.com]
//                             [--namespace=default]
//                             [--redact=auto|off]
//
// Drops in front of OpenAI / Anthropic / vLLM / Together / Fireworks /
// any HTTP API. Captures the request prompt + upstream response, writes
// them to ~/.kolm/captures/<namespace>.jsonl as a JSONL durable log,
// and forwards the response to the caller.
//
// Routes:
//   GET  /health                        -> { ok, service: 'proxy', version }
//   ANY  /v1/<path>                     -> forwards to UPSTREAM/v1/<path>, captures
//   GET  /captures/:namespace           -> { count, head: [...], tail: [...] }
//
// Response headers added:
//   x-kolm-capture-id          -> capture row id
//   x-kolm-capture-durable     -> true if persisted, false if not
//   x-kolm-capture-namespace   -> namespace this row landed in
//
// Used in the kolm proxy pattern: point your OpenAI SDK at the proxy
// URL, capture starts streaming, when threshold N pairs is reached
// kolm fires a click-to-distill webhook.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { URL as NodeURL } from 'node:url';
import { parseServiceArgv } from '../services.js';
import * as redactor from '../phi-redactor.js';

const VERSION = 'w240-proxy-1.0.0';
const DEFAULT_UPSTREAM = process.env.KOLM_PROXY_UPSTREAM || 'https://api.openai.com';
const CAPTURE_DIR = process.env.KOLM_CAPTURE_DIR || path.join(os.homedir(), '.kolm', 'captures');

function ensureCaptureDir() {
  if (!fs.existsSync(CAPTURE_DIR)) fs.mkdirSync(CAPTURE_DIR, { recursive: true });
}

function captureFile(namespace) {
  const safe = String(namespace || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
  return path.join(CAPTURE_DIR, `${safe}.jsonl`);
}

function newCaptureId() {
  return 'cap_' + crypto.randomBytes(8).toString('hex');
}

function writeCapture(namespace, row) {
  ensureCaptureDir();
  const f = captureFile(namespace);
  try {
    fs.appendFileSync(f, JSON.stringify(row) + '\n', 'utf8');
    return { durable: true, file: f };
  } catch (e) {
    return { durable: false, error: e.message, file: f };
  }
}

function reply(res, code, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'x-kolm-service': 'proxy',
    'x-kolm-service-version': VERSION,
    ...extraHeaders,
  });
  res.end(json);
}

function readBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overCap = false;
    req.on('data', (c) => {
      if (overCap) return;
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        overCap = true;
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!overCap) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!overCap) reject(e); });
  });
}

function forwardRequest(upstreamUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new NodeURL(upstreamUrl);
    const isHttps = u.protocol === 'https:';
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: { ...headers, host: u.host },
      timeout: 120000,
    };
    delete opts.headers['content-length'];
    if (body && body.length) opts.headers['content-length'] = String(body.length);
    const client = isHttps ? https : http;
    const req = client.request(opts, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve({
        statusCode: resp.statusCode,
        headers: resp.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    if (body && body.length) req.write(body);
    req.end();
  });
}

function summarize(s, max = 400) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function extractPromptFromBody(bodyJson) {
  if (!bodyJson || typeof bodyJson !== 'object') return '';
  if (Array.isArray(bodyJson.messages)) {
    return bodyJson.messages
      .map((m) => `${m.role || '?'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')}`)
      .join('\n');
  }
  if (typeof bodyJson.prompt === 'string') return bodyJson.prompt;
  if (typeof bodyJson.input === 'string') return bodyJson.input;
  return '';
}

function extractResponseText(bodyJson) {
  if (!bodyJson || typeof bodyJson !== 'object') return '';
  if (Array.isArray(bodyJson.choices) && bodyJson.choices[0]) {
    const c = bodyJson.choices[0];
    if (c.message && typeof c.message.content === 'string') return c.message.content;
    if (typeof c.text === 'string') return c.text;
  }
  if (Array.isArray(bodyJson.content) && bodyJson.content[0]) {
    const c = bodyJson.content[0];
    if (typeof c.text === 'string') return c.text;
  }
  if (typeof bodyJson.output_text === 'string') return bodyJson.output_text;
  return '';
}

export function createProxyServer({ upstream = DEFAULT_UPSTREAM, defaultNamespace = 'default', redactMode = 'auto' } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /health' || route === 'GET /v1/health') {
        return reply(res, 200, {
          ok: true,
          service: 'proxy',
          version: VERSION,
          upstream,
          uptime_s: Math.floor(process.uptime()),
          capture_dir: CAPTURE_DIR,
        });
      }

      const nsMatch = url.pathname.match(/^\/captures\/([a-zA-Z0-9_-]+)$/);
      if (nsMatch && req.method === 'GET') {
        const ns = nsMatch[1];
        const f = captureFile(ns);
        if (!fs.existsSync(f)) return reply(res, 200, { namespace: ns, count: 0, head: [], tail: [] });
        const text = fs.readFileSync(f, 'utf8');
        const lines = text.split(/\r?\n/).filter(Boolean);
        const parse = (ln) => { try { return JSON.parse(ln); } catch { return null; } };
        const rows = lines.map(parse).filter(Boolean);
        const head = rows.slice(0, 5);
        const tail = rows.slice(-5);
        return reply(res, 200, { namespace: ns, count: rows.length, head, tail });
      }

      // capture-and-forward path. anything starting with /v1/ goes upstream.
      if (url.pathname.startsWith('/v1/')) {
        const namespace = req.headers['x-kolm-namespace'] || url.searchParams.get('namespace') || defaultNamespace;
        const requestBody = await readBuffer(req);
        const upstreamUrl = upstream.replace(/\/$/, '') + url.pathname + (url.search || '');
        const forwardHeaders = { ...req.headers };
        delete forwardHeaders.host;
        delete forwardHeaders['x-kolm-namespace'];
        delete forwardHeaders['content-length'];

        // perform upstream call
        const started = Date.now();
        let upstreamResp;
        try {
          upstreamResp = await forwardRequest(upstreamUrl, req.method, forwardHeaders, requestBody);
        } catch (e) {
          // upstream failure path. still capture the attempt.
          const captureId = newCaptureId();
          const row = {
            capture_id: captureId,
            namespace,
            ts: new Date().toISOString(),
            method: req.method,
            path: url.pathname,
            upstream_error: e.message,
            latency_us: (Date.now() - started) * 1000,
            request_summary: summarize(requestBody.toString('utf8'), 400),
          };
          const persist = writeCapture(namespace, row);
          return reply(res, 502, { error: 'upstream_failed', detail: e.message }, {
            'x-kolm-capture-id': captureId,
            'x-kolm-capture-durable': String(Boolean(persist.durable)),
            'x-kolm-capture-namespace': namespace,
          });
        }

        // parse + extract for capture
        let reqJson = null, respJson = null;
        try { reqJson = JSON.parse(requestBody.toString('utf8') || '{}'); } catch {}
        try { respJson = JSON.parse(upstreamResp.body.toString('utf8') || '{}'); } catch {}
        const prompt = extractPromptFromBody(reqJson) || summarize(requestBody.toString('utf8'), 400);
        const response = extractResponseText(respJson) || summarize(upstreamResp.body.toString('utf8'), 400);

        const captureId = newCaptureId();
        let promptOut = prompt;
        let responseOut = response;
        let mapHash = null;
        if (redactMode === 'auto' && prompt) {
          try {
            const { redacted, map } = redactor.redact(prompt);
            promptOut = redacted;
            mapHash = redactor.mapHash(map);
          } catch {}
        }
        const row = {
          capture_id: captureId,
          namespace,
          ts: new Date().toISOString(),
          method: req.method,
          path: url.pathname,
          upstream_status: upstreamResp.statusCode,
          upstream_model: (respJson && (respJson.model || respJson.id)) || null,
          latency_us: (Date.now() - started) * 1000,
          prompt: promptOut,
          response: summarize(responseOut, 8000),
          redacted: redactMode === 'auto',
          map_hash: mapHash,
        };
        const persist = writeCapture(namespace, row);

        // W252: never falsely report durable when the write failed. Mirrors
        // the W212 capture-path contract in src/router.js — failed durable
        // write must surface 507 Insufficient Storage + x-kolm-capture-durable:
        // false, NOT a 2xx with durable:true (which silently dropped the row).
        if (!persist.durable) {
          console.error('[proxy] capture write failed:', persist.error);
          return reply(res, 507, {
            error: 'capture_store_unavailable',
            detail: persist.error || 'write failed',
            capture_id: captureId,
            namespace,
            file: persist.file,
          }, {
            'x-kolm-capture-id': captureId,
            'x-kolm-capture-durable': 'false',
            'x-kolm-capture-namespace': namespace,
          });
        }

        // forward response back to caller, preserve headers + status
        const respHeaders = { ...upstreamResp.headers };
        delete respHeaders['content-length'];
        delete respHeaders['transfer-encoding'];
        respHeaders['x-kolm-capture-id'] = captureId;
        respHeaders['x-kolm-capture-durable'] = 'true';
        respHeaders['x-kolm-capture-namespace'] = namespace;
        respHeaders['x-kolm-service'] = 'proxy';
        respHeaders['x-kolm-service-version'] = VERSION;
        res.writeHead(upstreamResp.statusCode, respHeaders);
        res.end(upstreamResp.body);
        return;
      }

      return reply(res, 404, { error: `unknown route: ${route}` });
    } catch (e) {
      const code = e.statusCode || 500;
      return reply(res, code, { error: e.message || String(e) });
    }
  });
}

function main() {
  const { port, host, extra } = parseServiceArgv();
  if (!port) {
    console.error('error: --port=<n> required (or KOLM_SERVICE_PORT)');
    process.exit(64);
  }
  const upstream = extra.upstream || DEFAULT_UPSTREAM;
  const defaultNamespace = extra.namespace || 'default';
  const redactMode = extra.redact || 'auto';
  const server = createProxyServer({ upstream, defaultNamespace, redactMode });
  server.listen(port, host, () => {
    console.log(`[proxy] listening on http://${host}:${port} (version=${VERSION})`);
    console.log(`[proxy] upstream=${upstream} namespace=${defaultNamespace} redact=${redactMode}`);
  });
  const shutdown = (sig) => {
    console.log(`[proxy] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1] || '';
    return argv1.includes('services/proxy.js') || argv1.includes('services\\proxy.js');
  } catch { return false; }
})();

if (isMain) main();
