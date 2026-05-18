// Wave 212: capture durability lock-in.
//
// Behavior assertions (per Pablo correction — no page-text markers).
//
// Pablo W211 receipt (2026-05-18):
//   src/router.js:3959 was `try { insert('observations', obs); } catch (_) {}`
//   — a silent swallow. If the DB write failed the customer still got 200 +
//   x-kolm-capture-id for a row that was never stored.
//
// W212 contract this test enforces:
//   1. The silent-swallow pattern is structurally absent from src/router.js
//      (the only occurrence allowed is the commented-out historical reference
//      inside the W212 patch comment).
//   2. recordCapture in router.js is async (uses await + can throw).
//   3. Every capture handler awaits recordCapture and surfaces 503 with an
//      actionable error code on write failure.
//   4. Capture response sets x-kolm-capture-durable header only on persist
//      success; not present (or "false") on failure.
//   5. capture-store.js exports insertCapture, listCaptures, countCaptures,
//      isDurable, driverName, health.
//   6. Vercel Postgres + Vercel KV drivers exist with the required surface.
//   7. With KOLM_STORE_DRIVER=vercel_postgres and missing @vercel/postgres,
//      insertCapture throws with DRIVER_PACKAGE_MISSING (actionable).
//   8. /v1/capture/health endpoint registered in router.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROUTER_SRC = fs.readFileSync(path.join(ROOT, 'src/router.js'), 'utf8');
const CAPTURE_STORE_SRC = fs.readFileSync(path.join(ROOT, 'src/capture-store.js'), 'utf8');
const PG_DRIVER_SRC = fs.readFileSync(path.join(ROOT, 'src/store-drivers/vercel-postgres.js'), 'utf8');
const KV_DRIVER_SRC = fs.readFileSync(path.join(ROOT, 'src/store-drivers/vercel-kv.js'), 'utf8');

test('W212 #1 — silent-swallow pattern is structurally absent', () => {
  // Allow the historical reference in the W212 patch comment, but the live
  // pattern `try { insert('observations'...) } catch (_) {}` must not exist
  // as executable code.
  const pattern = /try\s*\{\s*insert\(\s*['"]observations['"][\s\S]{0,200}\}\s*catch\s*\(\s*_?\s*\)\s*\{\s*\}/g;
  const matches = [];
  let m;
  while ((m = pattern.exec(ROUTER_SRC)) !== null) {
    const offset = m.index;
    // Check if this match is inside a comment (line starts with //)
    const lineStart = ROUTER_SRC.lastIndexOf('\n', offset) + 1;
    const line = ROUTER_SRC.slice(lineStart, ROUTER_SRC.indexOf('\n', offset));
    if (!line.trim().startsWith('//')) {
      matches.push({ offset, line });
    }
  }
  assert.equal(matches.length, 0, `silent-swallow pattern must not exist as live code: ${JSON.stringify(matches)}`);
});

test('W212 #2 — recordCapture is async', () => {
  assert.match(ROUTER_SRC, /async function recordCapture\(/);
});

test('W212 #3 — recordCapture uses insertCapture (durable path), not insert()', () => {
  // The function body must contain await insertCapture(...)
  const fnIdx = ROUTER_SRC.indexOf('async function recordCapture(');
  assert.ok(fnIdx > 0);
  const fnBody = ROUTER_SRC.slice(fnIdx, fnIdx + 2000);
  assert.match(fnBody, /await insertCapture\(/);
});

test('W212 #4 — capture/anthropic handler awaits + has 503 fallback', () => {
  const idx = ROUTER_SRC.search(/r\.post\(\/\^\\\/v1\\\/capture\\\/anthropic/);
  assert.ok(idx > 0, 'capture/anthropic route must exist');
  const handlerBlock = ROUTER_SRC.slice(idx, idx + 3500);
  // W258-BE-1: 503 + capture_store_unavailable logic moved into the shared
  // recordCaptureWithReceipt envelope. The handler must await it and not
  // forward upstream when the envelope already wrote a 503 response.
  assert.match(handlerBlock, /obs = await recordCaptureWithReceipt\(/);
  assert.match(handlerBlock, /res\.headersSent/);
});

test('W212 #5 — capture/openai handler awaits + has 503 fallback', () => {
  const idx = ROUTER_SRC.search(/r\.post\(\/\^\\\/v1\\\/capture\\\/openai/);
  assert.ok(idx > 0, 'capture/openai route must exist');
  const handlerBlock = ROUTER_SRC.slice(idx, idx + 3500);
  assert.match(handlerBlock, /obs = await recordCaptureWithReceipt\(/);
  assert.match(handlerBlock, /res\.headersSent/);
});

test('W212 #4b — recordCaptureWithReceipt envelope itself handles 503', () => {
  const idx = ROUTER_SRC.indexOf('async function recordCaptureWithReceipt(');
  assert.ok(idx > 0);
  const block = ROUTER_SRC.slice(idx, idx + 2000);
  assert.match(block, /res\.status\(503\)/);
  assert.match(block, /capture_store_unavailable|capture_store_ephemeral/);
});

test('W212 #6 — capture/log handler awaits + has 503 fallback', () => {
  const idx = ROUTER_SRC.indexOf("r.post('/v1/capture/log'");
  assert.ok(idx > 0, '/v1/capture/log route must exist');
  const handlerBlock = ROUTER_SRC.slice(idx, idx + 3000);
  assert.match(handlerBlock, /await recordCapture\(/);
  assert.match(handlerBlock, /res\.status\(503\)/);
  assert.match(handlerBlock, /capture_store_unavailable/);
});

test('W212 #7 — bridges/observe handler also durable (no silent insert)', () => {
  const idx = ROUTER_SRC.indexOf("r.post('/v1/bridges/observe'");
  assert.ok(idx > 0);
  const handlerBlock = ROUTER_SRC.slice(idx, idx + 2500);
  assert.match(handlerBlock, /await insertCapture\(/);
  assert.match(handlerBlock, /res\.status\(503\)/);
});

test('W212 #8 — every capture handler sets x-kolm-capture-durable on success', () => {
  // W258-BE-1: durable header is now set inside recordCaptureWithReceipt
  // using the runtime captureIsDurable() value (`String(obs.durable !== false)`)
  // rather than hard-coded 'true'. Assert at least one runtime-driven setter
  // (envelope) AND that the bridges/observe handler also sets it (since it
  // does not go through the proxy envelope).
  const runtimeSetters = ROUTER_SRC.match(/res\.set\(\s*['"]x-kolm-capture-durable['"]/g) || [];
  assert.ok(runtimeSetters.length >= 3,
    `expected ≥3 x-kolm-capture-durable setters, got ${runtimeSetters.length}`);
  // Envelope-based: String(obs.durable !== false) for the proxy handlers.
  assert.match(ROUTER_SRC, /res\.set\(\s*['"]x-kolm-capture-durable['"]\s*,\s*String\(obs\.durable\s*!==\s*false\)/);
});

test('W212 #9 — capture-store.js exports the required surface', () => {
  for (const name of ['insertCapture', 'listCaptures', 'countCaptures', 'isDurable', 'driverName', 'health']) {
    assert.match(CAPTURE_STORE_SRC, new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`), `${name} must be exported`);
  }
});

test('W212 #10 — capture-store.js routes to vercel_postgres driver via dynamic import', () => {
  assert.match(CAPTURE_STORE_SRC, /import\(.*store-drivers\/vercel-postgres\.js/);
  assert.match(CAPTURE_STORE_SRC, /import\(.*store-drivers\/vercel-kv\.js/);
});

test('W212 #11 — Vercel Postgres driver exposes insert/all/findByTenantNamespace/count/health', () => {
  for (const name of ['insert', 'all', 'findByTenantNamespace', 'count', 'health']) {
    assert.match(PG_DRIVER_SRC, new RegExp(`export\\s+async\\s+function\\s+${name}\\b`), `pg driver export ${name}`);
  }
  assert.match(PG_DRIVER_SRC, /export const IS_DURABLE = true/);
  assert.match(PG_DRIVER_SRC, /export const DRIVER_NAME = 'vercel_postgres'/);
});

test('W212 #12 — Vercel KV driver exposes the same surface', () => {
  for (const name of ['insert', 'all', 'findByTenantNamespace', 'count', 'health']) {
    assert.match(KV_DRIVER_SRC, new RegExp(`export\\s+async\\s+function\\s+${name}\\b`), `kv driver export ${name}`);
  }
  assert.match(KV_DRIVER_SRC, /export const IS_DURABLE = true/);
  assert.match(KV_DRIVER_SRC, /export const DRIVER_NAME = 'vercel_kv'/);
});

test('W212 #13 — missing @vercel/postgres surfaces DRIVER_PACKAGE_MISSING', async () => {
  // Import the driver in isolation; loading the client should fail with the
  // actionable error code. We cannot install @vercel/postgres in CI, so the
  // absence proves the error path is reachable.
  const mod = await import('../src/store-drivers/vercel-postgres.js');
  await assert.rejects(
    () => mod.insert('observations', { id: 'cap_test', tenant: 't1' }),
    (err) => {
      // Either the package is missing (DRIVER_PACKAGE_MISSING) or the env
      // var is missing (DRIVER_ENV_MISSING). Both are actionable, neither
      // silently swallows.
      assert.ok(['DRIVER_PACKAGE_MISSING', 'DRIVER_ENV_MISSING'].includes(err.code),
        `unexpected error code: ${err.code} (${err.message})`);
      return true;
    }
  );
});

test('W212 #14 — missing @vercel/kv surfaces DRIVER_PACKAGE_MISSING', async () => {
  const mod = await import('../src/store-drivers/vercel-kv.js');
  await assert.rejects(
    () => mod.insert('observations', { id: 'cap_test', tenant: 't1' }),
    (err) => {
      assert.ok(['DRIVER_PACKAGE_MISSING', 'DRIVER_ENV_MISSING'].includes(err.code));
      return true;
    }
  );
});

test('W212 #15 — capture-store.isDurable returns true off-Vercel (local dev default)', async () => {
  delete process.env.VERCEL;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  delete process.env.KOLM_STORE_DRIVER;
  delete process.env.KOLM_CAPTURE_DRIVER;
  // Force module re-evaluation by clearing the cache.
  const captureStore = await import('../src/capture-store.js?fresh=' + Math.random());
  captureStore._resetDriverCache?.();
  // Off-Vercel: legacy synchronous JSON store is durable.
  assert.equal(captureStore.isDurable(), true);
});

test('W212 #16 — insertCapture is async (returns a promise)', async () => {
  const captureStore = await import('../src/capture-store.js');
  const ret = captureStore.insertCapture({
    id: 'cap_test_' + Date.now(),
    tenant: 'w212-test-tenant',
    template_hash: 'abc',
    prompt: 'hello',
    response: 'world',
    corpus_namespace: 'w212',
    created_at: new Date().toISOString(),
  });
  assert.ok(ret && typeof ret.then === 'function', 'insertCapture must return a Promise');
  await ret; // drain
});

test('W212 #17 — driverName returns vercel_postgres when KOLM_STORE_DRIVER=vercel_postgres', async () => {
  const prev = process.env.KOLM_STORE_DRIVER;
  process.env.KOLM_STORE_DRIVER = 'vercel_postgres';
  const captureStore = await import('../src/capture-store.js');
  captureStore._resetDriverCache?.();
  assert.equal(captureStore.driverName(), 'vercel_postgres');
  // Restore.
  if (prev === undefined) delete process.env.KOLM_STORE_DRIVER;
  else process.env.KOLM_STORE_DRIVER = prev;
  captureStore._resetDriverCache?.();
});

test('W212 #18 — /v1/capture/health route registered in router', () => {
  assert.match(ROUTER_SRC, /r\.get\(['"]\/v1\/capture\/health['"]/);
});

test('W212 #19 — capture-store exposes _resetDriverCache hook for tests', () => {
  assert.match(CAPTURE_STORE_SRC, /export function _resetDriverCache/);
});

test('W212 #20 — synthesize-corpus reads via listCaptures (same backend as writes)', () => {
  const idx = ROUTER_SRC.indexOf("r.get('/v1/labels/synthesize-corpus'");
  assert.ok(idx > 0);
  const handlerBlock = ROUTER_SRC.slice(idx, idx + 2000);
  // listCaptures is the durable capture-store reader (W212 contract).
  assert.match(handlerBlock, /await\s+listCaptures\(/);
});
