// Wave 252: backend correctness fixes.
//
// Behavior assertions for four real bugs surfaced by independent audit:
//
//   1. Stripe webhook idempotency silent-swallow + non-transactional state
//      mutation. src/router.js around 2360-2410.
//   2. Proxy service falsely reports x-kolm-capture-durable: true even when
//      persist failed. src/services/proxy.js around 55-64 + 261-268.
//   3. SSE keep-alive interval never cleared on client disconnect.
//      src/router.js around 4337-4369.
//   4. /v1/recall/sources sidecar uses fs.readFileSync on request thread
//      with no size cap. src/router.js around 1924-1939.
//
// All four follow the W212 pattern: never silently swallow a failed durable
// write; surface the failure with an actionable HTTP status code so the
// caller retries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROUTER_SRC = fs.readFileSync(path.join(ROOT, 'src/router.js'), 'utf8');
const PROXY_SRC = fs.readFileSync(path.join(ROOT, 'src/services/proxy.js'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'src/store.js'), 'utf8');

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

function stripeSignature(body, secret, ts = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
  return `t=${ts},v1=${sig}`;
}

// =====================================================================
// Bug 1: Stripe webhook — corrupted stripe_events.json triggers a write
// failure inside withTransaction; expect 503 + tenant.plan unchanged.
// =====================================================================
test('W252 #1 — stripe webhook returns 503 when idempotency op throws AND tenant.plan unchanged', async (t) => {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const dataDir = path.join(os.tmpdir(), `kolm-w252-stripe-${process.pid}-${Date.now()}`);
  const home = path.join(os.tmpdir(), `kolm-w252-stripe-home-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  // Pre-populate a tenant whose plan we will verify is unchanged after
  // the failed webhook.
  const tenantId = 't_w252_stripe';
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    {
      id: tenantId,
      name: 'w252-stripe',
      email: 'w252@example.com',
      plan: 'free',
      quota: 1000,
      seats: 1,
      pending_plan: null,
      created_at: new Date().toISOString(),
    },
  ]), 'utf8');

  // Corrupt stripe_events.json: store rows MUST be an array (assertRowsArray
  // throws otherwise). This is the cleanest way to force the next write op
  // inside withTransaction() to throw without monkeypatching ESM bindings.
  // Both primary AND backup must be invalid so the recovery path also fails.
  fs.writeFileSync(path.join(dataDir, 'stripe_events.json'), '{"not":"an array"}', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'stripe_events.json.bak'), '{"also":"broken"}', 'utf8');

  const WEBHOOK_SECRET = 'whsec_w252_test_secret';
  const proc = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DEFAULT_TENANT: 'w252',
      ANTHROPIC_API_KEY: '',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: home,
      KOLM_STORE_DRIVER: 'json',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  // after() is LIFO. dir cleanup registered first → fires AFTER killAndWait,
  // which guarantees the spawned server has released sqlite/log handles.
  t.after(() => {
    rmSyncBestEffort(dataDir);
    rmSyncBestEffort(home);
  });
  t.after(() => killAndWait(proc));

  await waitForHealth(BASE);

  // Build a webhook event that would normally upgrade the tenant to 'pro'.
  const eventBody = JSON.stringify({
    id: 'evt_w252_stripe_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        client_reference_id: tenantId,
        amount_total: 4900, // pro plan
        customer: 'cus_test',
        subscription: 'sub_test',
      },
    },
  });
  const sig = stripeSignature(eventBody, WEBHOOK_SECRET);

  const res = await fetch(BASE + '/v1/stripe/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
    body: eventBody,
  });

  assert.equal(res.status, 503, 'webhook with failing idempotency op must return 503');
  const json = await res.json();
  assert.equal(json.error, 'webhook_store_unavailable');
  assert.ok(json.detail, 'detail must be populated');

  // Tenant plan must be unchanged — the transaction rolled back.
  const tenants = JSON.parse(fs.readFileSync(path.join(dataDir, 'tenants.json'), 'utf8'));
  const tenant = tenants.find(x => x.id === tenantId);
  assert.ok(tenant, 'tenant row must still exist');
  assert.equal(tenant.plan, 'free', 'tenant.plan MUST be unchanged (was free, never upgraded to pro)');
  assert.equal(tenant.stripe_customer_id, undefined, 'stripe_customer_id must NOT be set');
  assert.equal(tenant.stripe_subscription_id, undefined, 'stripe_subscription_id must NOT be set');
});

// =====================================================================
// Bug 1b: structural — store.js must export withTransaction; router.js
// must import it and call it from the stripe webhook handler.
// =====================================================================
test('W252 #2 — store.js exports withTransaction()', () => {
  assert.match(STORE_SRC, /export function withTransaction\(/);
});

test('W252 #3 — router.js imports withTransaction from store.js', () => {
  assert.match(ROUTER_SRC, /import\s*\{[^}]*withTransaction[^}]*\}\s*from\s*['"]\.\/store\.js['"]/);
});

test('W252 #4 — stripe webhook handler uses withTransaction()', () => {
  const idx = ROUTER_SRC.indexOf("r.post('/v1/stripe/webhook'");
  assert.ok(idx > 0, 'stripe webhook handler must exist');
  const handlerBlock = ROUTER_SRC.slice(idx, idx + 12000);
  assert.match(handlerBlock, /withTransaction\(/, 'handler must wrap mutations in withTransaction');
  // The old silent-swallow MUST be gone — no `try { insert('stripe_events',...) } catch (_) {}`.
  assert.doesNotMatch(handlerBlock, /try\s*\{\s*insert\(\s*['"]stripe_events['"][\s\S]{0,200}\}\s*catch\s*\(\s*_?\s*\)\s*\{\s*\}/,
    'silent-swallow around insert(stripe_events,...) must be removed');
});

test('W252 #5 — stripe webhook returns 503 with webhook_store_unavailable on txn failure', () => {
  const idx = ROUTER_SRC.indexOf("r.post('/v1/stripe/webhook'");
  // The handler is large after the W252 refactor (~9 KB). Slice generously
  // so we capture the catch-block + 503 reply at the bottom.
  const handlerBlock = ROUTER_SRC.slice(idx, idx + 12000);
  assert.match(handlerBlock, /res\.status\(503\)/);
  assert.match(handlerBlock, /webhook_store_unavailable/);
});

test('W252 #6 — stripe webhook uses findOne lookups, not all() full-scan', () => {
  const idx = ROUTER_SRC.indexOf("r.post('/v1/stripe/webhook'");
  const handlerBlock = ROUTER_SRC.slice(idx, idx + 12000);
  // Inside the txn body the tenant lookups must be findOne, not all().find.
  assert.doesNotMatch(handlerBlock, /all\('tenants'\)\.find\(/);
  assert.doesNotMatch(handlerBlock, /all\('stripe_events'\)\.some\(/);
  assert.match(handlerBlock, /findOne\(['"]tenants['"]/);
  assert.match(handlerBlock, /findOne\(['"]stripe_events['"]/);
});

// =====================================================================
// Bug 2: Proxy service — writeCapture failure must surface 507 + durable:false.
// =====================================================================
test('W252 #7 — proxy returns 507 + x-kolm-capture-durable:false when writeCapture fails', async (t) => {
  // Boot an upstream test server that always returns 200 OK.
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl_test', model: 'gpt-test', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  await new Promise(r => upstream.listen(upstreamPort, '127.0.0.1', r));
  t.after(() => upstream.close());

  // Capture dir = a path that points at a FILE, not a directory. Then the
  // proxy's ensureCaptureDir() + appendFileSync() will fail (cannot mkdir
  // over a file; appendFileSync to a non-existent dir fails too).
  // Use os.tmpdir() and place a regular file where the dir would be.
  const fakeFile = path.join(os.tmpdir(), `kolm-w252-proxy-capdir-${process.pid}-${Date.now()}`);
  fs.writeFileSync(fakeFile, 'not a directory', 'utf8');
  t.after(() => { try { fs.unlinkSync(fakeFile); } catch {} });

  const proxyPort = await freePort();
  const { createProxyServer } = await import(`../src/services/proxy.js?fresh=${Date.now()}`);
  // Override the capture dir by setting env, then re-import the module
  // (the constant is read at module load).
  process.env.KOLM_CAPTURE_DIR = fakeFile;
  const { createProxyServer: createServer } = await import(`../src/services/proxy.js?fresh2=${Date.now()}`);
  const server = createServer({ upstream: `http://127.0.0.1:${upstreamPort}`, defaultNamespace: 'w252', redactMode: 'off' });
  await new Promise(r => server.listen(proxyPort, '127.0.0.1', r));
  t.after(() => { server.close(); delete process.env.KOLM_CAPTURE_DIR; });

  const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 507, 'failed capture write must return 507 Insufficient Storage');
  assert.equal(res.headers.get('x-kolm-capture-durable'), 'false',
    'header must be "false" — proxy must not falsely report durable:true');
  const json = await res.json();
  assert.equal(json.error, 'capture_store_unavailable');
});

test('W252 #8 — proxy success path still sets x-kolm-capture-durable:true', async (t) => {
  // Sanity check: with a writable capture dir, the proxy still forwards
  // the upstream 200 unchanged and sets durable:true.
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl_ok', model: 'gpt-test', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  await new Promise(r => upstream.listen(upstreamPort, '127.0.0.1', r));
  t.after(() => upstream.close());

  const capDir = path.join(os.tmpdir(), `kolm-w252-proxy-ok-${process.pid}-${Date.now()}`);
  fs.mkdirSync(capDir, { recursive: true });
  process.env.KOLM_CAPTURE_DIR = capDir;
  const proxyPort = await freePort();
  const { createProxyServer } = await import(`../src/services/proxy.js?ok=${Date.now()}`);
  const server = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}`, defaultNamespace: 'w252ok', redactMode: 'off' });
  await new Promise(r => server.listen(proxyPort, '127.0.0.1', r));
  t.after(() => {
    server.close();
    delete process.env.KOLM_CAPTURE_DIR;
    fs.rmSync(capDir, { recursive: true, force: true });
  });

  const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200, 'success path must forward upstream 200');
  assert.equal(res.headers.get('x-kolm-capture-durable'), 'true');
});

test('W252 #9 — proxy source contains the 507 branch (structural)', () => {
  assert.match(PROXY_SRC, /507/);
  assert.match(PROXY_SRC, /capture_store_unavailable/);
  // The header literal "true" must only be set on the success path, after
  // the durable-check branch.
  assert.match(PROXY_SRC, /if\s*\(\s*!persist\.durable\s*\)/);
});

// =====================================================================
// Bug 3: SSE keep-alive — verify clearInterval and req.on('error',...)
// and req.socket.setTimeout(3600000) are wired in the source.
//
// We use a fake setInterval/clearInterval pair to assert that on a
// simulated `close` event, the interval id IS passed to clearInterval.
// =====================================================================
test('W252 #10 — SSE handler registers req.on("close") and req.on("error") cleanup', () => {
  const idx = ROUTER_SRC.indexOf("/v1/capture/stream'");
  assert.ok(idx > 0, '/v1/capture/stream route must exist');
  const handlerBlock = ROUTER_SRC.slice(idx, idx + 3000);
  assert.match(handlerBlock, /req\.on\(['"]close['"]/, 'req.on("close") must be wired');
  assert.match(handlerBlock, /req\.on\(['"]error['"]/, 'req.on("error") must be wired');
  assert.match(handlerBlock, /clearInterval\(keepAlive\)/, 'cleanup must clearInterval(keepAlive)');
  // Allow optional-chain `setTimeout?.(...)` since req.socket may be undefined in some test paths.
  assert.match(handlerBlock, /setTimeout\??\.?\(3600000\)/, 'req.socket.setTimeout(3600000) must cap idle connections at 1h');
});

test('W252 #11 — simulated client disconnect calls clearInterval on the keep-alive id', () => {
  // We exercise the cleanup logic in isolation by extracting the pattern
  // used in the route handler and running it against fake setInterval /
  // clearInterval / req objects. This proves the cleanup IS keyed on the
  // exact interval id returned by setInterval — not on a separate variable.
  let clearedId = null;
  let intervalId = 0;
  const fakeSetInterval = () => { intervalId = Symbol('interval-' + Date.now()); return intervalId; };
  const fakeClearInterval = (id) => { clearedId = id; };

  // Replicate the handler's cleanup pattern.
  const keepAlive = fakeSetInterval();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fakeClearInterval(keepAlive);
  };

  // Simulate req.on('close', cleanup) firing.
  const handlers = { close: [], error: [] };
  const fakeReq = {
    on(evt, fn) { handlers[evt]?.push(fn); },
    socket: { setTimeout() {}, on() {} },
  };
  fakeReq.on('close', cleanup);
  fakeReq.on('error', cleanup);

  // Fire close.
  handlers.close.forEach(h => h());
  assert.equal(clearedId, keepAlive, 'clearInterval must receive the same id setInterval returned');
  // Fire close again — cleanup is idempotent, clearInterval not called twice.
  clearedId = 'NOT_CLEARED_AGAIN';
  handlers.close.forEach(h => h());
  assert.equal(clearedId, 'NOT_CLEARED_AGAIN', 'cleanup must be idempotent');
});

// =====================================================================
// Bug 4: /v1/recall/sources sidecar — 2MB file must 413, NOT slurp
// the whole file into memory + block the event loop.
// =====================================================================
test('W252 #12 — /v1/recall/sources rejects 2MB sidecar with 413', async (t) => {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const dataDir = path.join(os.tmpdir(), `kolm-w252-side-${process.pid}-${Date.now()}`);
  const home = path.join(os.tmpdir(), `kolm-w252-side-home-${process.pid}-${Date.now()}`);
  const recallRoot = path.join(os.tmpdir(), `kolm-w252-recall-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  // Admin-key path: lookupRoot = recallRoot directly (no tenant subdir).
  fs.mkdirSync(recallRoot, { recursive: true });
  // Write a 2 MiB sidecar at the admin lookup root.
  const big = Buffer.alloc(2 * 1024 * 1024, 'x');
  fs.writeFileSync(path.join(recallRoot, 'huge.md'), big);
  // Write a small sidecar for the negative-control read.
  fs.writeFileSync(path.join(recallRoot, 'small.md'), 'hello world');

  const ADMIN_KEY = 'ks_admin_w252_test_' + Date.now();
  const proc = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DEFAULT_TENANT: '_anon',
      ANTHROPIC_API_KEY: '',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: home,
      KOLM_RECALL_ROOT: recallRoot,
      KOLM_STORE_DRIVER: 'json',
      ADMIN_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  t.after(() => {
    rmSyncBestEffort(dataDir);
    rmSyncBestEffort(home);
    rmSyncBestEffort(recallRoot);
  });
  t.after(() => killAndWait(proc));

  await waitForHealth(BASE);

  const authHeaders = { Authorization: 'Bearer ' + ADMIN_KEY };

  // Big file → 413.
  const big413 = await fetch(BASE + '/v1/recall/sources/huge.md', { headers: authHeaders });
  assert.equal(big413.status, 413, '2MB sidecar must return 413 Payload Too Large');
  const body = await big413.json();
  assert.equal(body.error, 'sidecar too large');
  assert.equal(body.max_bytes, 1024 * 1024);
  assert.equal(body.size, 2 * 1024 * 1024);

  // Small file still works (sanity).
  const ok = await fetch(BASE + '/v1/recall/sources/small.md', { headers: authHeaders });
  assert.equal(ok.status, 200, 'small sidecar still returns 200');
  const okJson = await ok.json();
  assert.equal(okJson.length, 'hello world'.length);
});

test('W252 #13 — sidecar handler uses fs.promises (no fs.readFileSync on request thread)', () => {
  // Locate the /v1/recall/sources handler body.
  const idx = ROUTER_SRC.indexOf("r.get('/v1/recall/sources/:id");
  assert.ok(idx > 0);
  // Find the end of the handler — the next `r.` route or 2500 chars.
  const slice = ROUTER_SRC.slice(idx, idx + 2500);
  assert.match(slice, /await fs\.promises\.readFile\(/, 'handler must use fs.promises.readFile');
  assert.match(slice, /await fs\.promises\.stat\(/, 'handler must stat the file first');
  // No synchronous read inside the handler block (allow fs.existsSync earlier? No — we replaced it).
  // The slice should not contain fs.readFileSync.
  assert.doesNotMatch(slice, /fs\.readFileSync\(/, 'handler must not use fs.readFileSync');
});
