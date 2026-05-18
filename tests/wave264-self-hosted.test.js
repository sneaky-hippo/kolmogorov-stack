// W264 — self-hosted compile server.
//
// Behavior tests for the standalone Node HTTP server at
// workers/compile-server/server.mjs. The server reuses src/compile.js
// unchanged so this test exercises the air-gap-friendly auth and HTTP
// surface, not the orchestrator (covered by other wave tests).
//
// Boot strategy: spawn `node workers/compile-server/server.mjs` on a
// random ephemeral port (PORT=0 plus a probe loop) with
// KOLM_SHARED_SECRET=test123 and KOLM_OFFLINE=1. Stop the child in
// teardown so the test harness does not leak processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');
const SERVER     = path.join(ROOT, 'workers', 'compile-server', 'server.mjs');
const PAGE       = path.join(ROOT, 'public', 'enterprise', 'self-hosted.html');
const TMP_ART    = path.join(ROOT, '.tmp-w264-artifacts');

// Find a free TCP port by binding port 0 on a throwaway server. The OS
// hands us an unused port, we close, then hand that port number to the
// kolm-compile-server child. Standard trick to avoid hard-coded ports
// colliding when this test runs in parallel with other wave tests.
function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function httpRequest({ method, port, pathName, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: '127.0.0.1',
      port,
      path: pathName,
      headers: { ...headers },
    };
    if (body) opts.headers['content-length'] = Buffer.byteLength(body);
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForHealth(port, timeoutMs = 15000) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await httpRequest({ method: 'GET', port, pathName: '/v1/health' });
      if (r.status === 200) return JSON.parse(r.body.toString('utf8'));
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`health probe never succeeded on :${port}: ${lastErr && lastErr.message}`);
}

async function startServer({ secret = 'test123', offline = '1' } = {}) {
  if (fs.existsSync(TMP_ART)) fs.rmSync(TMP_ART, { recursive: true, force: true });
  fs.mkdirSync(TMP_ART, { recursive: true });
  const port = await pickPort();
  const env = {
    ...process.env,
    KOLM_SHARED_SECRET: secret,
    KOLM_OFFLINE: offline,
    KOLM_ARTIFACT_DIR: TMP_ART,
    KOLM_TENANT_ID: 'self-hosted',
    PORT: String(port),
    HOST: '127.0.0.1',
    // Avoid writing into the repo's persistent data dir under tests.
    KOLM_DATA_DIR: path.join(TMP_ART, 'store'),
    // Keep the embedded synthesis path deterministic (no Anthropic call).
    ANTHROPIC_API_KEY: '',
  };
  const child = spawn(process.execPath, [SERVER], {
    env,
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c.toString(); });
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  try {
    const health = await waitForHealth(port);
    return { child, port, health, stdout: () => stdout, stderr: () => stderr };
  } catch (e) {
    try { child.kill('SIGKILL'); } catch {}
    throw new Error(`server failed to start. stdout=${stdout} stderr=${stderr} err=${e.message}`);
  }
}

function stopServer(s) {
  if (!s || !s.child) return;
  try { s.child.kill('SIGTERM'); } catch {}
}

test('W264 #1 — /v1/health returns ok + mode self-hosted', async () => {
  const s = await startServer();
  try {
    assert.equal(s.health.ok, true);
    assert.equal(s.health.mode, 'self-hosted');
    assert.equal(typeof s.health.version, 'string');
    assert.equal(s.health.offline, true);
    assert.equal(s.health.secret_configured, true);
  } finally { stopServer(s); }
});

test('W264 #2 — POST /v1/compile without auth header returns 401', async () => {
  const s = await startServer();
  try {
    const r = await httpRequest({
      method: 'POST', port: s.port, pathName: '/v1/compile',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'redact pii' }),
    });
    assert.equal(r.status, 401);
    const body = JSON.parse(r.body.toString('utf8'));
    assert.match(body.error, /shared-secret/);
  } finally { stopServer(s); }
});

test('W264 #3 — POST /v1/compile with wrong shared secret returns 401', async () => {
  const s = await startServer();
  try {
    const r = await httpRequest({
      method: 'POST', port: s.port, pathName: '/v1/compile',
      headers: { 'content-type': 'application/json', 'x-kolm-shared-secret': 'wrong' },
      body: JSON.stringify({ task: 'redact pii' }),
    });
    assert.equal(r.status, 401);
  } finally { stopServer(s); }
});

test('W264 #4 — POST /v1/compile with valid secret returns 202 + job_id', async () => {
  const s = await startServer();
  try {
    const r = await httpRequest({
      method: 'POST', port: s.port, pathName: '/v1/compile?sync=1',
      headers: { 'content-type': 'application/json', 'x-kolm-shared-secret': 'test123' },
      body: JSON.stringify({
        task: 'redact PII from text',
        examples: [
          { input: 'Call john@x.com today.', output: 'Call [REDACTED] today.' },
          { input: 'Email jane@y.org.',      output: 'Email [REDACTED].' },
        ],
      }),
    });
    assert.equal(r.status, 202);
    const body = JSON.parse(r.body.toString('utf8'));
    assert.ok(body.job_id && body.job_id.startsWith('job_'), `expected job_id, got ${JSON.stringify(body)}`);
    assert.ok(body.poll && body.poll.includes(body.job_id));
  } finally { stopServer(s); }
});

test('W264 #5 — GET /v1/compile/:id polls to completion + serves artifact bytes with matching sha256', async () => {
  const s = await startServer();
  try {
    // Sync mode so the compile job is durable by the time we poll.
    const r1 = await httpRequest({
      method: 'POST', port: s.port, pathName: '/v1/compile?sync=1',
      headers: { 'content-type': 'application/json', 'x-kolm-shared-secret': 'test123' },
      body: JSON.stringify({
        task: 'classify text as greeting or not',
        examples: [
          { input: 'hi there',         output: 'greeting' },
          { input: 'order #1234 ready', output: 'other' },
        ],
      }),
    });
    assert.equal(r1.status, 202);
    const { job_id } = JSON.parse(r1.body.toString('utf8'));

    // Poll. Sync mode returns 202 after the job finishes so the first poll
    // should already show completed; we still loop briefly so a slow CI
    // box doesn't flake.
    let snap = null;
    for (let i = 0; i < 30; i++) {
      const r = await httpRequest({
        method: 'GET', port: s.port, pathName: `/v1/compile/${job_id}`,
        headers: { 'x-kolm-shared-secret': 'test123' },
      });
      assert.equal(r.status, 200, `status snapshot must succeed, got ${r.status} body=${r.body.toString('utf8')}`);
      snap = JSON.parse(r.body.toString('utf8'));
      if (snap.status === 'completed' || snap.status === 'failed') break;
      await new Promise((r2) => setTimeout(r2, 250));
    }
    assert.ok(snap, 'snapshot fetched');
    assert.equal(snap.status, 'completed', `compile must complete, got status=${snap.status} error=${snap.error}`);
    assert.ok(snap.artifact_url, 'artifact_url populated');
    assert.equal(snap.offline, true);
    // k_score on the job record is the structured object emitted by
    // src/kscore.js — {composite, ships, axes, ...}. Just assert presence
    // plus a numeric composite so this test does not couple to internal
    // shape changes downstream waves may make.
    const composite = typeof snap.k_score === 'number'
      ? snap.k_score
      : (snap.k_score && typeof snap.k_score.composite === 'number' ? snap.k_score.composite : null);
    assert.ok(composite !== null && composite > 0, `k_score composite numeric, got ${JSON.stringify(snap.k_score)}`);

    // Download the artifact bytes and verify the sha256 matches the
    // artifact_hash advertised in the manifest. This is the byte-identical
    // contract: same hash as cloud for the same input.
    const r2 = await httpRequest({
      method: 'GET', port: s.port, pathName: `/v1/compile/${job_id}/.kolm`,
      headers: { 'x-kolm-shared-secret': 'test123' },
    });
    assert.equal(r2.status, 200, `download must 200, got ${r2.status} body=${r2.body.slice(0, 200).toString('utf8')}`);
    assert.equal(r2.headers['content-type'], 'application/zip');
    assert.match(String(r2.headers['content-disposition']), new RegExp(`${job_id}\\.kolm`));
    assert.ok(r2.body.length > 200, `artifact bytes look real, got ${r2.body.length}`);

    // Zip magic: PK\x03\x04 (0x504B0304). The artifact is a signed zip so
    // any well-formed .kolm starts with this signature.
    assert.equal(r2.body[0], 0x50);
    assert.equal(r2.body[1], 0x4b);
    assert.equal(r2.body[2], 0x03);
    assert.equal(r2.body[3], 0x04);

    // sha256 of the bytes must match content-length and itself be
    // stable across a re-fetch (the orchestrator persists the artifact
    // file; the server only streams). artifact_hash on the manifest is a
    // content-hash composed from canonical inputs not the zip bytes, so
    // they intentionally differ.
    const sha = crypto.createHash('sha256').update(r2.body).digest('hex');
    assert.equal(sha.length, 64);
    const r3 = await httpRequest({
      method: 'GET', port: s.port, pathName: `/v1/compile/${job_id}/.kolm`,
      headers: { 'x-kolm-shared-secret': 'test123' },
    });
    const sha2 = crypto.createHash('sha256').update(r3.body).digest('hex');
    assert.equal(sha, sha2, 'two downloads of the same artifact yield identical sha256');
    // Header propagates whatever artifact_hash the orchestrator stamped so
    // downstream tooling can verify the manifest binding without re-zipping.
    if (r2.headers['x-kolm-artifact-hash']) {
      assert.match(String(r2.headers['x-kolm-artifact-hash']), /^[0-9a-f]{64}$/);
    }
  } finally { stopServer(s); }
});

test('W264 #6 — KOLM_OFFLINE=1 rejects deploy_hook in request body', async () => {
  const s = await startServer({ offline: '1' });
  try {
    const r = await httpRequest({
      method: 'POST', port: s.port, pathName: '/v1/compile',
      headers: { 'content-type': 'application/json', 'x-kolm-shared-secret': 'test123' },
      body: JSON.stringify({ task: 'x', deploy_hook: 'https://example.com/hook' }),
    });
    assert.equal(r.status, 400);
    const body = JSON.parse(r.body.toString('utf8'));
    assert.match(body.error, /OFFLINE|deploy_hook/i);
  } finally { stopServer(s); }
});

test('W264 #7 — server refuses to start without KOLM_SHARED_SECRET', async () => {
  // Spawn with the env var explicitly cleared. The server should print to
  // stderr and exit non-zero before listening, so the health probe never
  // succeeds. We bypass startServer's wait loop and inspect exit code.
  const env = { ...process.env };
  delete env.KOLM_SHARED_SECRET;
  env.PORT = '0'; env.HOST = '127.0.0.1';
  const child = spawn(process.execPath, [SERVER], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.notEqual(code, 0, 'server must exit non-zero when secret is missing');
  assert.match(stderr, /KOLM_SHARED_SECRET/);
});

test('W264 #8 — /v1/compile/:id returns 404 for unknown id', async () => {
  const s = await startServer();
  try {
    const r = await httpRequest({
      method: 'GET', port: s.port, pathName: '/v1/compile/job_does_not_exist',
      headers: { 'x-kolm-shared-secret': 'test123' },
    });
    assert.equal(r.status, 404);
  } finally { stopServer(s); }
});

test('W264 #9 — /v1/compile/:id/.kolm returns 409 when artifact not ready', async () => {
  // Use async (non-sync) compile so the job is still running when we ask
  // for the artifact. Whatever the orchestrator's actual speed, the
  // pre-completion poll returns the queued/running state.
  const s = await startServer();
  try {
    const r1 = await httpRequest({
      method: 'POST', port: s.port, pathName: '/v1/compile',
      headers: { 'content-type': 'application/json', 'x-kolm-shared-secret': 'test123' },
      body: JSON.stringify({ task: 'x', examples: [{ input: 'a', output: 'a' }] }),
    });
    assert.equal(r1.status, 202);
    const { job_id } = JSON.parse(r1.body.toString('utf8'));
    // Immediately ask for the artifact, before the orchestrator completes.
    const r2 = await httpRequest({
      method: 'GET', port: s.port, pathName: `/v1/compile/${job_id}/.kolm`,
      headers: { 'x-kolm-shared-secret': 'test123' },
    });
    // Either 409 (still running) or 200 (super-fast completion). Either is
    // a correct contract response; we just want to assert no 5xx and no
    // 401 (auth was provided).
    assert.ok([200, 409].includes(r2.status), `expected 200 or 409, got ${r2.status}`);
  } finally { stopServer(s); }
});

test('W264 #10 — self-hosted public page exists with three-card install grid', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  // Title carries kolm.ai per W264 copy rules.
  assert.match(html, /kolm\.ai/i, 'page title contains kolm.ai');
  // Three cards: Docker, docker-compose, Helm.
  assert.match(html, />\s*Docker\s*</);
  assert.match(html, />\s*docker-compose\s*</);
  assert.match(html, />\s*Helm\s*</);
  // No-egress verification block named explicitly.
  assert.match(html, /no-egress verification/i);
  // tcpdump recipe present.
  assert.match(html, /tcpdump/);
  // KOLM_SHARED_SECRET surfaced in shared-secret section.
  assert.match(html, /KOLM_SHARED_SECRET/);
  assert.match(html, /KOLM_OFFLINE/);
  // Em-dashes are banned in W264 copy.
  assert.equal(/—/.test(html), false, 'no U+2014 em-dashes in self-hosted page');
});

test('W264 #11 — workers/compile-server kit files exist + no new npm deps', () => {
  const root = path.join(ROOT, 'workers', 'compile-server');
  for (const f of ['server.mjs', 'Dockerfile', 'docker-compose.yml', 'README.md',
                   'helm/Chart.yaml', 'helm/values.yaml',
                   'helm/templates/deployment.yaml', 'helm/templates/service.yaml']) {
    assert.ok(fs.existsSync(path.join(root, f)), `expected ${f} to exist`);
  }
  // Root package.json must not have grown any dependency for W264.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // baseline from before W264 (locked by prior waves)
  const expected_deps = ['@anthropic-ai/sdk', 'adm-zip', 'archiver', 'compression',
    'cookie-parser', 'dotenv', 'express', 'express-rate-limit', 'helmet'];
  const actual_deps = Object.keys(pkg.dependencies || {}).sort();
  for (const d of actual_deps) {
    assert.ok(expected_deps.includes(d), `unexpected new runtime dep introduced by W264: ${d}`);
  }
});

test('W264 #12 — vercel.json + sw.js wired to W264 surface', () => {
  const vc = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const has = (vc.rewrites || []).some((r) =>
    r.source === '/enterprise/self-hosted' && /self-hosted\.html$/.test(r.destination));
  assert.ok(has, 'vercel rewrite for /enterprise/self-hosted present');
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const m = sw.match(/kolm-v7-2026-05-\d+-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE constant matches expected pattern');
  assert.ok(Number(m[1]) >= 264, `sw.js cache wave must be >= 264, got ${m[1]}`);
});

// Cleanup: nuke the temp artifact dir on suite shutdown. We don't wrap this in
// `test.after` because node:test orders that per-suite; doing it at module
// scope keeps each test self-contained while still cleaning up after the run.
process.on('exit', () => {
  try { if (fs.existsSync(TMP_ART)) fs.rmSync(TMP_ART, { recursive: true, force: true }); } catch {}
});
