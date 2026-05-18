#!/usr/bin/env node
// scripts/completions-server.mjs
//
// Wave Y — minimal Node http server exposing the OpenAI-compatible
// chat completions endpoint from src/completions-api.js. Lets a tenant
// point any existing OpenAI-SDK client (the openai npm package,
// LangChain, LlamaIndex, LiteLLM, Continue.dev, Cursor) at a local
// process and silently get kolm artifacts in the loop.
//
// Routes:
//   POST /v1/chat/completions        OpenAI chat completions
//                                    (set "stream": true for SSE)
//   GET  /v1/models                  list bridge-able models
//   GET  /healthz                    cheap liveness probe
//
// CLI:
//   node scripts/completions-server.mjs
//     [--port=11453]
//     [--host=127.0.0.1]
//     [--registry=<dir>] (repeatable; default: cwd + cwd/examples + cwd/tmp)
//     [--api-key=<key>]  (if set, requires Bearer <key> on every request;
//                         also reads KOLM_COMPLETIONS_API_KEY env)
//
// Env:
//   KOLM_COMPLETIONS_PORT     overrides --port  (default 11453)
//   KOLM_COMPLETIONS_HOST     overrides --host  (default 127.0.0.1)
//   KOLM_COMPLETIONS_API_KEY  overrides --api-key
//   KOLM_COMPLETIONS_REGISTRY ':'-separated list overrides --registry
//   ANTHROPIC_API_KEY         enables anthropic: bridge
//   OPENAI_API_KEY            enables openai: bridge

import http from 'node:http';
import url from 'node:url';
import path from 'node:path';
import process from 'node:process';
import {
  handleChatCompletion,
  handleListModels,
  streamChatCompletion,
} from '../src/completions-api.js';

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.KOLM_COMPLETIONS_PORT || 11453);
const HOST = args.host || process.env.KOLM_COMPLETIONS_HOST || '127.0.0.1';
const API_KEY = args['api-key'] || process.env.KOLM_COMPLETIONS_API_KEY || null;
const REGISTRY_DIRS = (() => {
  const envDirs = process.env.KOLM_COMPLETIONS_REGISTRY
    ? process.env.KOLM_COMPLETIONS_REGISTRY.split(path.delimiter).filter(Boolean)
    : null;
  const cliDirs = args.registry
    ? (Array.isArray(args.registry) ? args.registry : [args.registry])
    : null;
  if (cliDirs && cliDirs.length) return cliDirs;
  if (envDirs && envDirs.length) return envDirs;
  return null; // let completions-api use its defaults
})();

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS preflight (matches what OpenAI's API allows so any in-browser
  // client behaves identically).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-max-age': '600',
    });
    res.end();
    return;
  }

  // Auth gate (optional).
  if (API_KEY && pathname !== '/healthz') {
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (got !== API_KEY) {
      return sendJson(res, 401, openaiErr('unauthorized', 'invalid_api_key', 'missing or wrong Bearer token'));
    }
  }

  try {
    if (req.method === 'GET' && pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, ts: Date.now() });
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      const out = await handleListModels({ registryDirs: REGISTRY_DIRS });
      return sendJson(res, 200, out);
    }

    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      const body = await readJsonBody(req);
      if (body.stream === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'access-control-allow-origin': '*',
        });
        try {
          for await (const chunk of streamChatCompletion(body, { registryDirs: REGISTRY_DIRS })) {
            res.write(chunk);
          }
        } catch (e) {
          // Mid-stream errors are surfaced as a terminal SSE error event then
          // [DONE], which is what well-behaved OpenAI clients expect.
          res.write(`data: ${JSON.stringify({ error: openaiErr(e.code || 'stream_error', e.code || 'stream_error', e.message).error })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
        res.end();
        return;
      }
      const resp = await handleChatCompletion(body, { registryDirs: REGISTRY_DIRS });
      return sendJson(res, 200, resp);
    }

    return sendJson(res, 404, openaiErr('not_found', 'not_found', `no route for ${req.method} ${pathname}`));
  } catch (e) {
    const status = typeof e.status === 'number' ? e.status : 500;
    const code = e.code || 'internal_error';
    return sendJson(res, status, openaiErr(code, code, e.message));
  }
});

server.listen(PORT, HOST, () => {
  const actualPort = server.address().port;
  const dirHint = REGISTRY_DIRS ? REGISTRY_DIRS.join(', ') : '<default: cwd + cwd/examples + cwd/tmp>';
  const authHint = API_KEY ? `Bearer auth required` : 'no auth (set --api-key or KOLM_COMPLETIONS_API_KEY to require it)';
  process.stderr.write(`kolm completions: listening on http://${HOST}:${actualPort}\n`);
  process.stderr.write(`  registry: ${dirHint}\n`);
  process.stderr.write(`  auth:     ${authHint}\n`);
  process.stderr.write(`  routes:   GET /healthz, GET /v1/models, POST /v1/chat/completions\n`);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(obj));
}

function openaiErr(_type, code, message) {
  return { error: { message, type: code, code, param: null } };
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  const MAX = 4 * 1024 * 1024; // 4 MiB cap
  for await (const c of req) {
    total += c.length;
    if (total > MAX) {
      const e = new Error(`request body exceeds ${MAX} bytes`);
      e.status = 413;
      e.code = 'payload_too_large';
      throw e;
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); }
  catch (e) {
    const err = new Error(`invalid JSON body: ${e.message}`);
    err.status = 400;
    err.code = 'invalid_request';
    throw err;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      pushArg(out, k, v);
    } else {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        pushArg(out, k, next);
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}

function pushArg(out, k, v) {
  if (out[k] === undefined) out[k] = v;
  else if (Array.isArray(out[k])) out[k].push(v);
  else out[k] = [out[k], v];
}
