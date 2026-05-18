// Wave 347 — POST /v1/seeds/from-nl + GET /v1/seeds/from-nl/health.
//
// The builder's "describe in natural language, generate seeds" button used
// to crash or return empty. W347 wires it to the real LLM abstraction in
// src/llm-call.js. Crucially, when no LLM backend is configured the route
// returns a clean 501 with a documented error code so the UI can degrade
// gracefully (hide the button) and the operator sees the exact env var.
//
// Test environment: by default tests are run with no LLM env vars set, so
// the unconfigured path is the deterministic one we lock in. We do not
// stand up a fake LLM upstream here — that lives in higher-fidelity smokes
// in the integration suite.
//
// Behavior assertions (no copy):
//   1. /v1/seeds/from-nl and /v1/seeds/from-nl/health are mounted above
//      r.use(authMiddleware) (public, rate-limited).
//   2. GET /v1/seeds/from-nl/health returns {available, provider, model,
//      base_url, has_key, hint}. When unconfigured, available is false and
//      hint mentions both KOLM_LLM_PROVIDER and KOLM_LLM_KEY.
//   3. POST /v1/seeds/from-nl with no backend → 501 with
//      error:'nl_seeds_requires_backend' and hint mentioning both env vars.
//   4. POST /v1/seeds/from-nl with a bad seed body → 400 invalid_seed.
//   5. Health endpoint round-trip is JSON, never HTML (would never collide
//      with W346's static fallback).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROUTER_SRC = fs.readFileSync(path.join(ROOT, 'src/router.js'), 'utf8');

// Make sure no inherited env from the host shell turns the LLM on in the
// middle of this test file. The tests below assume "unconfigured" is the
// deterministic state.
function clearLlmEnv() {
  delete process.env.KOLM_LLM_PROVIDER;
  delete process.env.KOLM_LLM_BASE_URL;
  delete process.env.KOLM_LLM_KEY;
  delete process.env.KOLM_LLM_MODEL;
}

async function bootApp() {
  clearLlmEnv();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  return app;
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

test('W347 NL #1 - both routes are unauthed (above the auth gate)', () => {
  const healthIdx = ROUTER_SRC.indexOf("r.get('/v1/seeds/from-nl/health'");
  const postIdx = ROUTER_SRC.indexOf("r.post('/v1/seeds/from-nl'");
  const gateIdx = ROUTER_SRC.indexOf('r.use(authMiddleware);');
  assert.ok(healthIdx > 0, 'GET /v1/seeds/from-nl/health missing');
  assert.ok(postIdx > 0, 'POST /v1/seeds/from-nl missing');
  assert.ok(gateIdx > 0);
  assert.ok(healthIdx < gateIdx, 'health must be public');
  assert.ok(postIdx < gateIdx, 'from-nl POST must be public');
});

test('W347 NL #2 - health reports unavailable + hint when no backend configured', async () => {
  const app = await bootApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/seeds/from-nl/health');
    assert.equal(r.status, 200);
    const ct = String(r.headers.get('content-type') || '');
    assert.ok(ct.includes('json'), `expected json content-type, got ${ct}`);
    const j = await r.json();
    assert.equal(typeof j.available, 'boolean');
    assert.equal(typeof j.provider, 'string');
    assert.equal(typeof j.model, 'string');
    assert.equal(typeof j.has_key, 'boolean');
    // With env cleared, available must be false and a hint must be present.
    assert.equal(j.available, false, 'with no env, backend must be unavailable');
    assert.equal(j.has_key, false);
    assert.ok(typeof j.hint === 'string' && j.hint.length > 0, 'hint must be present when unavailable');
    assert.match(j.hint, /KOLM_LLM_PROVIDER/);
    assert.match(j.hint, /KOLM_LLM_KEY/);
  });
});

test('W347 NL #3 - POST returns 501 with documented error when unconfigured', async () => {
  const app = await bootApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/seeds/from-nl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seed: { input: 'extract date', output: '2026-05-18' },
        count: 5,
      }),
    });
    assert.equal(r.status, 501, 'unconfigured backend must return 501');
    const j = await r.json();
    assert.equal(j.error, 'nl_seeds_requires_backend');
    assert.ok(typeof j.hint === 'string');
    assert.match(j.hint, /KOLM_LLM_PROVIDER/);
    assert.match(j.hint, /KOLM_LLM_KEY/);
  });
});

test('W347 NL #4 - POST returns 400 invalid_seed when body is malformed', async () => {
  // Spin up with a configured backend so the 501 short-circuit does not
  // mask the validation check. We point at ollama with a localhost base
  // that won't be touched because validation fails first.
  process.env.KOLM_LLM_PROVIDER = 'ollama';
  process.env.KOLM_LLM_BASE_URL = 'http://127.0.0.1:1';
  delete process.env.KOLM_LLM_KEY;
  try {
    const { buildRouter } = await import('../src/router.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use(buildRouter());
    await withServer(app, async (base) => {
      const r = await fetch(base + '/v1/seeds/from-nl', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ /* no seed, no prompt */ count: 5 }),
      });
      assert.equal(r.status, 400, 'malformed body must return 400 before contacting LLM');
      const j = await r.json();
      assert.equal(j.error, 'invalid_seed');
    });
  } finally {
    clearLlmEnv();
  }
});

test('W347 NL #5 - health endpoint always returns JSON, never HTML', async () => {
  // Regression guard: W346 added a static-page fallback that resolves
  // extension-less GETs against public/. /v1/* must NEVER be swallowed.
  const app = await bootApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/seeds/from-nl/health');
    const ct = String(r.headers.get('content-type') || '');
    assert.ok(!ct.includes('html'), `/v1/seeds/from-nl/health must never return HTML, got ct=${ct}`);
  });
});
