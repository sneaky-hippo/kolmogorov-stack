#!/usr/bin/env node
// W240 — standalone HTTP redactor service.
//
// node src/services/redactor.js --port=7401 [--host=127.0.0.1]
//
// Routes:
//   GET  /health                 -> { ok: true, service: 'redactor', version }
//   GET  /v1/redact/classes      -> { classes: [...] }
//   POST /v1/redact              -> { redacted, map, map_hash }
//                                   body: { input, classes?, names?, addresses?, ids? }
//   POST /v1/reinject            -> { text }
//                                   body: { input, map }
//   POST /v1/redact/verify       -> { ok, missing_tokens, leaked_tokens }
//                                   body: { redacted_input, teacher_response }
//
// Stateless. Pure CPU. Safe to scale horizontally behind a load balancer.

import http from 'node:http';
import { parseServiceArgv } from '../services.js';
import * as redactor from '../phi-redactor.js';

const VERSION = 'w240-redactor-1.0.0';
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB per request

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let overCap = false;
    req.on('data', (c) => {
      if (overCap) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        overCap = true;
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (overCap) return;
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) return resolve({});
      try { resolve(JSON.parse(buf.toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('invalid JSON: ' + e.message), { statusCode: 400 })); }
    });
    req.on('error', (e) => { if (!overCap) reject(e); });
  });
}

function reply(res, code, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'x-kolm-service': 'redactor',
    'x-kolm-service-version': VERSION,
    ...extraHeaders,
  });
  res.end(json);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === 'GET /health' || route === 'GET /v1/health') {
      return reply(res, 200, { ok: true, service: 'redactor', version: VERSION, uptime_s: Math.floor(process.uptime()) });
    }

    if (route === 'GET /v1/redact/classes') {
      return reply(res, 200, { classes: [...redactor.CLASSES] });
    }

    if (route === 'POST /v1/redact') {
      const body = await readBody(req);
      if (typeof body.input !== 'string') {
        return reply(res, 400, { error: 'body.input must be a string' });
      }
      const opts = {};
      if (Array.isArray(body.classes)) opts.classes = body.classes;
      if (Array.isArray(body.names)) opts.names = body.names;
      if (Array.isArray(body.addresses)) opts.addresses = body.addresses;
      if (body.ids && typeof body.ids === 'object') opts.ids = body.ids;
      const { redacted, map } = redactor.redact(body.input, opts);
      return reply(res, 200, {
        redacted,
        map,
        map_hash: redactor.mapHash(map),
        redacted_bytes: Buffer.byteLength(redacted, 'utf8'),
        token_count: Object.keys(map).length,
      });
    }

    if (route === 'POST /v1/reinject') {
      const body = await readBody(req);
      if (typeof body.input !== 'string') {
        return reply(res, 400, { error: 'body.input must be a string' });
      }
      if (!body.map || typeof body.map !== 'object') {
        return reply(res, 400, { error: 'body.map must be an object' });
      }
      const text = redactor.reinject(body.input, body.map);
      return reply(res, 200, { text });
    }

    if (route === 'POST /v1/redact/verify') {
      const body = await readBody(req);
      if (typeof body.redacted_input !== 'string' || typeof body.teacher_response !== 'string') {
        return reply(res, 400, { error: 'body.redacted_input and body.teacher_response must be strings' });
      }
      const result = redactor.verifyTokenPreservation(body.redacted_input, body.teacher_response);
      return reply(res, 200, result);
    }

    return reply(res, 404, { error: `unknown route: ${route}`, hint: 'GET /health, POST /v1/redact, POST /v1/reinject, POST /v1/redact/verify' });
  } catch (e) {
    const code = e.statusCode || 500;
    return reply(res, code, { error: e.message || String(e) });
  }
}

export function createRedactorServer() {
  return http.createServer(handle);
}

function main() {
  const { port, host } = parseServiceArgv();
  if (!port) {
    console.error('error: --port=<n> required (or KOLM_SERVICE_PORT)');
    process.exit(64);
  }
  const server = createRedactorServer();
  server.listen(port, host, () => {
    console.log(`[redactor] listening on http://${host}:${port} (version=${VERSION})`);
  });
  const shutdown = (sig) => {
    console.log(`[redactor] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1] || '';
    return import.meta.url.endsWith(argv1.replace(/\\/g, '/').replace(/^.*?(?=src\/services)/, ''))
      || argv1.includes('services/redactor.js')
      || argv1.includes('services\\redactor.js');
  } catch { return false; }
})();

if (isMain) main();
