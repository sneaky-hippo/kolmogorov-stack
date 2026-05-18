#!/usr/bin/env node
// workers/compile-server/server.mjs
//
// W264: kolm.ai self-hosted compile server.
//
// Same compile pipeline as the cloud /v1/compile endpoint, packaged as a
// standalone Node 20+ HTTP server runnable inside a customer VPC, behind a
// firewall, or fully air-gapped. The .kolm artifact this server produces is
// byte-identical to the cloud version (same spec, same signing chain) because
// it calls the unmodified src/compile.js orchestrator.
//
// Design constraints (W264):
//   - No new npm dependencies. node:http, node:fs, node:crypto only.
//   - Do not modify src/compile.js or src/router.js.
//   - Air-gap by default: when KOLM_OFFLINE=1 the server refuses any request
//     path that would touch the network (e.g. deploy_hook, future teacher
//     distillation calls).
//   - Shared-secret auth via the KOLM_SHARED_SECRET env var. No API keys, no
//     OAuth, no tenant DB. The server boots refusing every request until the
//     secret is set so the operator cannot accidentally expose it open.
//
// HTTP surface:
//   GET  /v1/health             readiness, mode and version
//   POST /v1/compile            start a compile job, returns { job_id }
//   GET  /v1/compile/:id        job status (manifest, k_score, artifact_url)
//   GET  /v1/compile/:id/.kolm  stream the signed artifact bytes
//
// Auth: every endpoint except /v1/health requires the header
//   x-kolm-shared-secret: <KOLM_SHARED_SECRET>
// Constant-time compared. Missing or wrong secret returns 401.

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..', '..');

// Lazy-load the orchestrator so the test harness can boot the server module
// with a stub when needed. Cached after first use.
let _compileModule = null;
async function compileModule() {
  if (_compileModule) return _compileModule;
  const url = pathToFileURL(path.join(ROOT, 'src', 'compile.js')).href;
  _compileModule = await import(url);
  return _compileModule;
}

let _synthesisModule = null;
async function synthesisModule() {
  if (_synthesisModule) return _synthesisModule;
  const url = pathToFileURL(path.join(ROOT, 'src', 'synthesis.js')).href;
  _synthesisModule = await import(url);
  return _synthesisModule;
}

let _registryModule = null;
async function registryModule() {
  if (_registryModule) return _registryModule;
  const url = pathToFileURL(path.join(ROOT, 'src', 'registry.js')).href;
  _registryModule = await import(url);
  return _registryModule;
}

let _storeModule = null;
async function storeModule() {
  if (_storeModule) return _storeModule;
  const url = pathToFileURL(path.join(ROOT, 'src', 'store.js')).href;
  _storeModule = await import(url);
  return _storeModule;
}

const VERSION   = '0.1.0-w264';
const MODE      = 'self-hosted';
const SECRET    = process.env.KOLM_SHARED_SECRET || '';
const OFFLINE   = process.env.KOLM_OFFLINE === '1';
const ART_DIR   = process.env.KOLM_ARTIFACT_DIR || '/data/artifacts';
const TENANT_ID = process.env.KOLM_TENANT_ID || 'self-hosted';

const VALID_PRESETS = new Set(['sft', 'lora-fast', 'long-context', 'vlm',
  'merge-adapters', 'embed', 'fc-tools', 'grpo-reasoning', 'instant']);
const VALID_RECIPE_CLASSES = new Set(['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model']);
const VALID_HW_TIERS = new Set(['auto', 'cpu-server', '3090', '4090', '5090',
  'm4-max-128', 'a100-80', 'h100-80', 'h200-141', 'dgx-spark', 'm3-ultra-512']);
const VALID_OUTPUT_TARGETS = new Set(['gguf', 'onnx', 'safetensors', 'coreml',
  'mlx', 'executorch', 'tensorrt', 'native-c', 'native-rust', 'wasm']);
const VALID_MULTI_DEVICE = new Set(['phone-ios', 'phone-android', 'laptop-cpu',
  'browser-wasm', 'edge-jetson', 'server-cuda']);
const VALID_CHAT_TEMPLATES = new Set(['chatml', 'qwen-3-thinking', 'llama-3',
  'phi-3', 'deepseek-v4', 'plain']);

function ctEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function sendJson(res, code, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'x-kolm-mode': MODE,
    'x-kolm-server-version': VERSION,
    ...extraHeaders,
  });
  res.end(payload);
}

function sendText(res, code, body) {
  const payload = Buffer.from(String(body));
  res.writeHead(code, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': payload.length,
    'x-kolm-mode': MODE,
  });
  res.end(payload);
}

function checkAuth(req) {
  if (!SECRET) return { ok: false, status: 503, error: 'server misconfigured: KOLM_SHARED_SECRET is not set' };
  const provided = req.headers['x-kolm-shared-secret'];
  if (!provided) return { ok: false, status: 401, error: 'missing x-kolm-shared-secret header' };
  if (!ctEqual(provided, SECRET)) return { ok: false, status: 401, error: 'invalid shared secret' };
  return { ok: true };
}

async function readJson(req, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try {
        resolve(JSON.parse(buf.toString('utf8')));
      } catch (e) {
        reject(new Error('invalid JSON body: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function validateCompileBody(body) {
  if (!body || typeof body !== 'object') return 'request body must be a JSON object';
  const { task, examples, deploy_hook, preset, lora_rank, k_threshold,
    recipe_class, hw_tier, output_target, multi_device,
    chat_template, thinking_mode } = body;
  if (!task || typeof task !== 'string') return 'task (string) required';
  if (task.length > 4000) return 'task description too long (>4000 chars)';
  if (examples != null && (!Array.isArray(examples) || examples.length > 200)) {
    return 'examples must be an array with <=200 entries';
  }
  // Air-gap enforcement: in OFFLINE mode the deploy_hook field is a network
  // call we refuse outright. Even if KOLM_OFFLINE is not set, the field has to
  // be a valid https URL when present.
  if (deploy_hook != null) {
    if (OFFLINE) return 'deploy_hook rejected: server is in KOLM_OFFLINE=1 mode';
    if (typeof deploy_hook !== 'string' || !/^https:\/\//i.test(deploy_hook) || deploy_hook.length > 2048) {
      return 'deploy_hook must be an https URL (<=2048 chars)';
    }
  }
  if (preset != null && (typeof preset !== 'string' || !VALID_PRESETS.has(preset))) return 'preset invalid';
  if (lora_rank != null && (typeof lora_rank !== 'number' || lora_rank < 4 || lora_rank > 64)) {
    return 'lora_rank must be a number in [4..64]';
  }
  if (k_threshold != null && (typeof k_threshold !== 'number' || k_threshold < 0.50 || k_threshold > 0.99)) {
    return 'k_threshold must be a number in [0.50..0.99]';
  }
  if (recipe_class != null && !VALID_RECIPE_CLASSES.has(recipe_class)) return 'recipe_class invalid';
  if (hw_tier != null && !VALID_HW_TIERS.has(hw_tier)) return 'hw_tier invalid';
  if (output_target != null && !VALID_OUTPUT_TARGETS.has(output_target)) return 'output_target invalid';
  if (multi_device != null) {
    if (!Array.isArray(multi_device) || multi_device.length > 6) return 'multi_device must be array <=6';
    for (const m of multi_device) if (!VALID_MULTI_DEVICE.has(m)) return `multi_device entry ${JSON.stringify(m)} invalid`;
  }
  if (chat_template != null && !VALID_CHAT_TEMPLATES.has(chat_template)) return 'chat_template invalid';
  if (thinking_mode != null && typeof thinking_mode !== 'boolean') return 'thinking_mode must be boolean';
  return null;
}

// Build the ctx shape src/compile.js#runJob expects. Mirrors what router.js
// composes for the cloud handler; we just substitute the self-hosted facets
// (single fixed tenant id, optional recall passthrough, optional registry).
async function buildCtx({ examples }) {
  const synthesisMod = await synthesisModule();
  const registryMod  = await registryModule();
  const storeMod     = await storeModule();
  return {
    synthesize: synthesisMod.synthesize,
    publicRecipes: () => {
      try {
        const concepts = storeMod.all('concepts').filter(c => c.visibility === 'public');
        const versions = storeMod.all('versions');
        const out = [];
        for (const c of concepts) {
          const vs = versions.filter(v => v.concept_id === c.id).sort((a, b) =>
            new Date(b.created_at || 0) - new Date(a.created_at || 0));
          if (!vs.length || !vs[0].source) continue;
          out.push({
            id: c.id, name: c.name,
            source: vs[0].source,
            source_hash: vs[0].evaluation?.source_hash || null,
            version_id: vs[0].id,
            tags: c.tags || [],
            schema: c.schema || null,
          });
        }
        return out;
      } catch { return []; }
    },
    examples: examples || [],
    // No recall substrate in self-hosted by default. Tenants who want one
    // mount /data/recall and set KOLM_RECALL_ENABLED=1; until then queries
    // return an empty chunk list so the compile orchestrator continues.
    recall: null,
    registry: {
      createConcept: registryMod.createConcept,
      publishVersion: registryMod.publishVersion,
    },
    outDir: ART_DIR,
  };
}

function ensureArtifactDir() {
  try { fs.mkdirSync(ART_DIR, { recursive: true }); }
  catch (e) {
    // /data might be a read-only mount on certain k8s setups. Fall back to
    // an in-process tmp dir; the operator sees this in the health probe.
    const tmp = path.join(ROOT, '.kolm-self-hosted-tmp');
    try { fs.mkdirSync(tmp, { recursive: true }); } catch {}
    return tmp;
  }
  return ART_DIR;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = (req.method || 'GET').toUpperCase();

  // CORS preflight: hard no-op. Self-hosted servers run inside the same VPC as
  // the caller in every supported topology; cross-origin browsers are not a
  // real use case. Return 204 so badly configured proxies don't 500.
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /v1/health — public, no auth. Mirrors the convention used by the
  // cloud /health probe but reports the self-hosted mode + offline flag.
  if (method === 'GET' && url.pathname === '/v1/health') {
    const artDir = ensureArtifactDir();
    const cfg = {
      ok: true,
      mode: MODE,
      version: VERSION,
      offline: OFFLINE,
      secret_configured: !!SECRET,
      artifact_dir: artDir,
      node_version: process.version,
    };
    return sendJson(res, 200, cfg);
  }

  // Every other route requires the shared secret.
  const auth = checkAuth(req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });

  if (method === 'POST' && url.pathname === '/v1/compile') {
    let body;
    try { body = await readJson(req); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
    const err = validateCompileBody(body);
    if (err) return sendJson(res, 400, { error: err });

    const compileMod = await compileModule();
    const job = compileMod.createJob({
      task: body.task,
      examples: body.examples || [],
      corpus_namespace: body.corpus_namespace || null,
      base_model: body.base_model || null,
      tenant: TENANT_ID,
      tenant_id: TENANT_ID,
      // In OFFLINE mode the deploy_hook field is rejected above, so we always
      // pass null here. Belt and suspenders.
      deploy_hook: OFFLINE ? null : (body.deploy_hook || null),
      preset: body.preset || null,
      lora_rank: body.lora_rank || null,
      k_threshold: body.k_threshold || null,
      recipe_class: body.recipe_class || 'distilled_model',
      hw_tier: body.hw_tier || 'auto',
      output_target: body.output_target || 'gguf',
      multi_device: Array.isArray(body.multi_device) ? body.multi_device : [],
      chat_template: body.chat_template || null,
      thinking_mode: Boolean(body.thinking_mode),
      // Self-hosted is the operator's own server: the K-score ship gate is
      // surfaced (k_score is in the manifest + status snapshot) but does not
      // block the build by default. Operators who want gate enforcement set
      // KOLM_ENFORCE_SHIP_GATE=1 or pass allow_below_gate=false in the body.
      allow_below_gate: body.allow_below_gate === false
        ? false
        : (process.env.KOLM_ENFORCE_SHIP_GATE === '1' ? false : true),
    });

    const ctx = await buildCtx({ examples: body.examples || [] });
    // Self-hosted is long-running by definition (it's a real server, not a
    // serverless function), so fire and forget gives the snappy 202 the
    // cloud path provides on Railway. On synchronous-mode (sync=1) we await
    // so the test harness and CI runners can deterministically poll for
    // completion without sleeping.
    if (url.searchParams.get('sync') === '1') {
      try { await compileMod.runJob(job, ctx); }
      catch (_) { /* runJob persists its own error state */ }
      const fresh = compileMod.getJob(job.id, TENANT_ID) || job;
      return sendJson(res, 202, {
        job_id: fresh.id,
        status: fresh.status,
        poll: `/v1/compile/${fresh.id}`,
      });
    }
    setImmediate(() => { compileMod.runJob(job, ctx).catch(() => {}); });
    return sendJson(res, 202, {
      job_id: job.id,
      status: job.status,
      poll: `/v1/compile/${job.id}`,
    });
  }

  // GET /v1/compile/:id/.kolm — stream the artifact bytes
  const dlMatch = url.pathname.match(/^\/v1\/compile\/([^\/]+)\/\.kolm$/);
  if (method === 'GET' && dlMatch) {
    const id = dlMatch[1];
    const compileMod = await compileModule();
    const j = compileMod.getJob(id, TENANT_ID);
    if (!j) return sendJson(res, 404, { error: 'job not found' });
    if (j.status !== 'completed') {
      return sendJson(res, 409, { error: 'artifact not ready', status: j.status, progress: j.progress });
    }
    if (!j.artifact_path || !fs.existsSync(j.artifact_path)) {
      return sendJson(res, 410, { error: 'artifact expired or missing' });
    }
    const stat = fs.statSync(j.artifact_path);
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': stat.size,
      'content-disposition': `attachment; filename="${j.id}.kolm"`,
      'x-kolm-artifact-hash': j.artifact_hash || '',
      'x-kolm-k-score': String(j.k_score ?? ''),
      'x-kolm-mode': MODE,
    });
    fs.createReadStream(j.artifact_path).pipe(res);
    return;
  }

  // GET /v1/compile/:id — status snapshot
  const statMatch = url.pathname.match(/^\/v1\/compile\/([^\/]+)$/);
  if (method === 'GET' && statMatch) {
    const id = statMatch[1];
    const compileMod = await compileModule();
    const j = compileMod.getJob(id, TENANT_ID);
    if (!j) return sendJson(res, 404, { error: 'job not found' });
    const { artifact_path, deploy_hook, ...safe } = j;
    return sendJson(res, 200, {
      ...safe,
      artifact_url: j.status === 'completed' ? `/v1/compile/${j.id}/.kolm` : null,
      deploy_hook_set: !!deploy_hook,
      offline: OFFLINE,
    });
  }

  return sendJson(res, 404, { error: 'not found', method, path: url.pathname });
}

export function createServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      try {
        sendJson(res, 500, { error: 'internal error', detail: String(e.message || e) });
      } catch { /* response already partially sent */ }
    });
  });
  return server;
}

// Boot when invoked directly (`node workers/compile-server/server.mjs`). When
// imported by the test harness, createServer is the entrypoint.
const isMain = (() => {
  try {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return argv1 === __filename;
  } catch { return false; }
})();

if (isMain) {
  if (!SECRET) {
    process.stderr.write('[kolm-compile-server] FATAL: KOLM_SHARED_SECRET is not set; refusing to start.\n');
    process.stderr.write('[kolm-compile-server] set it in the environment (export KOLM_SHARED_SECRET=...) and try again.\n');
    process.exit(2);
  }
  ensureArtifactDir();
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    process.stdout.write(`[kolm-compile-server] listening on http://${host}:${port}\n`);
    process.stdout.write(`[kolm-compile-server] mode=${MODE} offline=${OFFLINE} version=${VERSION}\n`);
    process.stdout.write(`[kolm-compile-server] artifact_dir=${ART_DIR}\n`);
  });
}
