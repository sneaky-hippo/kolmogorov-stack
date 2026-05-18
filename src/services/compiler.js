#!/usr/bin/env node
// W240 — standalone HTTP compiler service.
//
// node src/services/compiler.js --port=7402 [--host=127.0.0.1]
//
// Routes:
//   GET  /health                       -> { ok, service: 'compiler', version, queue_depth }
//   POST /v1/compile                   -> { job_id, status }
//                                          body: { task, examples, base_model?, preset?, hw_tier?, ... }
//   GET  /v1/compile/:job_id           -> full job record
//   GET  /v1/compile/:job_id/log       -> tail of job log
//   GET  /v1/compile                   -> { jobs: [...] }       (limit=25)
//   POST /v1/compile/:job_id/cancel    -> { ok, status: 'cancelled' }
//   GET  /v1/compile/presets           -> { presets: [...] }    (from compile.VALID_PRESETS)
//   GET  /v1/compile/tiers             -> { tiers: [...] }      (from compile.HW_TIERS)
//
// Stateful: persists to src/store.js (default JSON, SQLite in prod).

import http from 'node:http';
import { parseServiceArgv } from '../services.js';
import * as compile from '../compile.js';

const VERSION = 'w240-compiler-1.0.0';
const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32MB to fit reasonable seeds payloads

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
    'x-kolm-service': 'compiler',
    'x-kolm-service-version': VERSION,
    ...extraHeaders,
  });
  res.end(json);
}

function reqTenant(req) {
  return req.headers['x-kolm-tenant'] || req.headers['x-tenant'] || 'svc-compiler';
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === 'GET /health' || route === 'GET /v1/health') {
      let queueDepth = 0;
      try {
        const jobs = compile.listJobs(null, 1000);
        queueDepth = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
      } catch {}
      return reply(res, 200, {
        ok: true,
        service: 'compiler',
        version: VERSION,
        uptime_s: Math.floor(process.uptime()),
        queue_depth: queueDepth,
      });
    }

    if (route === 'GET /v1/compile/presets') {
      return reply(res, 200, { presets: [...(compile.VALID_PRESETS || [])] });
    }

    if (route === 'GET /v1/compile/tiers') {
      return reply(res, 200, { tiers: [...(compile.HW_TIERS || [])] });
    }

    if (route === 'GET /v1/compile') {
      const tenant = reqTenant(req);
      const limit = Math.min(Number(url.searchParams.get('limit')) || 25, 200);
      const jobs = compile.listJobs(tenant, limit);
      return reply(res, 200, { jobs, count: jobs.length });
    }

    if (route === 'POST /v1/compile') {
      const tenant = reqTenant(req);
      const body = await readBody(req);
      if (!body.task) {
        return reply(res, 400, { error: 'body.task required' });
      }
      const job = compile.createJob({
        task: body.task,
        examples: Array.isArray(body.examples) ? body.examples : [],
        corpus_namespace: body.corpus_namespace || null,
        base_model: body.base_model,
        tenant,
        tenant_id: body.tenant_id || null,
        deploy_hook: body.deploy_hook,
        preset: body.preset,
        lora_rank: body.lora_rank,
        k_threshold: body.k_threshold,
        recipe_class: body.recipe_class,
        hw_tier: body.hw_tier,
        output_target: body.output_target,
        multi_device: body.multi_device,
        chat_template: body.chat_template,
        thinking_mode: body.thinking_mode,
      });
      compile.runJob(job, { tenant }).catch((e) => {
        console.error('[compiler] runJob failed:', e && e.stack || e);
      });
      return reply(res, 202, { job_id: job.id, status: job.status });
    }

    const jobMatch = url.pathname.match(/^\/v1\/compile\/([a-zA-Z0-9_-]+)(?:\/(log|cancel))?$/);
    if (jobMatch) {
      const tenant = reqTenant(req);
      const id = jobMatch[1];
      const sub = jobMatch[2];
      const job = compile.getJob(id, tenant);
      if (!job) return reply(res, 404, { error: `job ${id} not found` });
      if (req.method === 'GET' && !sub) return reply(res, 200, { job });
      if (req.method === 'GET' && sub === 'log') {
        const log = (job.stages || []).map((s) => `[${s.at}] ${s.name} ${JSON.stringify({ ...s, name: undefined, at: undefined })}`).join('\n');
        return reply(res, 200, { job_id: id, log_lines: (job.stages || []).length, log });
      }
      if (req.method === 'POST' && sub === 'cancel') {
        try {
          if (typeof compile.cancelJob === 'function') {
            compile.cancelJob(id, tenant);
          }
        } catch {}
        return reply(res, 200, { ok: true, job_id: id, status: 'cancelled' });
      }
    }

    return reply(res, 404, { error: `unknown route: ${route}` });
  } catch (e) {
    const code = e.statusCode || 500;
    return reply(res, code, { error: e.message || String(e) });
  }
}

export function createCompilerServer() {
  return http.createServer(handle);
}

function main() {
  const { port, host } = parseServiceArgv();
  if (!port) {
    console.error('error: --port=<n> required (or KOLM_SERVICE_PORT)');
    process.exit(64);
  }
  const server = createCompilerServer();
  server.listen(port, host, () => {
    console.log(`[compiler] listening on http://${host}:${port} (version=${VERSION})`);
  });
  const shutdown = (sig) => {
    console.log(`[compiler] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1] || '';
    return argv1.includes('services/compiler.js') || argv1.includes('services\\compiler.js');
  } catch { return false; }
})();

if (isMain) main();
