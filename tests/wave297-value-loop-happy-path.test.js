// Wave 297 — Value-loop happy-path lock-in (insertCapture → SSE → distill).
//
// W213-W216 each shipped a slice of the observe→optimize→compile ladder,
// but no test exercises the four slices in one HTTP harness against the
// real router. This file boots buildRouter() in-process, provisions a fresh
// anon tenant, walks the loop end-to-end, and asserts BEHAVIOR (response
// codes + receipt headers + body shapes) — not page copy.
//
// Coverage:
//   1. POST /v1/capture/log persists rows and emits x-kolm-capture-durable.
//   2. GET  /v1/capture/health reports a structured driver/durable/thresholds shape.
//   3. GET  /v1/capture/stream attaches with the receipt headers from W258-BE-6.
//   4. GET  /v1/bridges/observations (W258-BE-7 indexed read) surfaces the new rows
//      under the namespace they were captured in (W297 corpus_namespace bugfix).
//   5. POST /v1/distill/from-captures with mode=recipe synthesizes and returns a job.
//   6. POST /v1/distill/from-captures with namespace having <4 rows returns 400 not_enough_captures.
//   7. POST /v1/replay with no concept_id_or_version_id returns 400.

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function makeAppAndTenant() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  return { app, apiKey: t.api_key };
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const realPort = server.address().port;
        const out = await fn(`http://127.0.0.1:${realPort}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

test('W297 #1 — POST /v1/capture/log persists rows and emits durable receipt headers', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const ns = 'w297_ns_' + Date.now().toString(36);
    const items = Array.from({ length: 8 }, (_, i) => ({
      input: `prompt-${i}`,
      output: `response-${i}`,
      latency_us: 5000 + i,
    }));
    const r = await fetch(base + '/v1/capture/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ namespace: ns, items, provider: 'manual', model: 'kolm-w297' }),
    });
    assert.equal(r.status, 201, 'capture/log should return 201 on full success');
    assert.equal(r.headers.get('x-kolm-capture-durable'), 'true',
      'all items persisted means x-kolm-capture-durable=true');
    assert.equal(r.headers.get('x-kolm-namespace'), ns,
      'namespace receipt header echoes the sanitized namespace');
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.namespace, ns);
    assert.equal(body.count, 8);
    assert.ok(Array.isArray(body.ids) && body.ids.length === 8);
  });
});

test('W297 #2 — GET /v1/capture/health returns the structured durability shape', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/capture/health', {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.ok, true);
    assert.equal(typeof json.driver, 'string', 'health must name the driver');
    assert.equal(typeof json.durable, 'boolean', 'health must report durable boolean');
    assert.equal(typeof json.subscriber_count, 'number', 'health must report subscriber_count');
    assert.ok(json.thresholds, 'health must expose the threshold catalog');
  });
});

test('W297 #3 — GET /v1/capture/stream attaches with W258-BE-6 receipt headers', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    // Open the SSE connection with a short abort so we just read headers + close.
    const controller = new AbortController();
    const r = await fetch(base + '/v1/capture/stream', {
      headers: { authorization: 'Bearer ' + apiKey, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(r.status, 200, 'stream should attach with 200');
    assert.match(String(r.headers.get('content-type') || ''), /text\/event-stream/);
    assert.ok(r.headers.get('x-kolm-capture-driver'),
      'stream must echo the capture-driver receipt header');
    // Abort the long-lived stream so the test process can exit.
    controller.abort();
    try { await r.body?.cancel?.(); } catch (_) { /* expected */ }
  });
});

test('W297 #4 — bridges/observations indexed read returns the rows just captured (namespace bugfix)', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const ns = 'w297_ns2_' + Date.now().toString(36);
    const items = Array.from({ length: 5 }, (_, i) => ({
      input: `p-${i}`,
      output: `r-${i}`,
    }));
    const post = await fetch(base + '/v1/capture/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ namespace: ns, items }),
    });
    assert.equal(post.status, 201);

    // Filter by namespace — the W297 bugfix maps corpus_namespace → namespace
    // so this should surface the 5 rows we just inserted.
    const r = await fetch(base + `/v1/bridges/observations?namespace=${encodeURIComponent(ns)}&limit=50`, {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.total, 5,
      `bridges/observations must surface all 5 captures (got ${body.total}); ` +
      `if this regresses, the corpus_namespace ↔ namespace fallback in router.js is back`);
    assert.ok(body.namespaces.includes(ns),
      `namespaces list must include ${ns} (got ${JSON.stringify(body.namespaces)})`);
    assert.equal(body.observations.length, 5);
  });
});

test('W297 #5 — POST /v1/distill/from-captures synthesizes a recipe in mode=recipe', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const ns = 'w297_distill_' + Date.now().toString(36);
    // template_hash = sha256(prompt + '|' + model) — so the cluster needs
    // identical prompts to land in one bucket. Send 10 identical prompts.
    const items = Array.from({ length: 10 }, (_, i) => ({
      input: `translate to french: hello`,
      output: `bonjour-${i}`,
    }));
    const post = await fetch(base + '/v1/capture/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ namespace: ns, items, model: 'gpt-test' }),
    });
    assert.equal(post.status, 201);

    const r = await fetch(base + '/v1/distill/from-captures', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ namespace: ns, mode: 'recipe', min_pairs: 4 }),
    });
    // 200 (synth accepted) or 422 (synth rejected) are both contract-valid;
    // anything else (e.g. 500 from broken plumbing) is a regression.
    assert.ok(r.status === 200 || r.status === 422,
      `distill/from-captures returned ${r.status}; expected 200 or 422 (synth accepted or rejected)`);
    const body = await r.json();
    assert.equal(body.mode, 'recipe', 'distill mode must be recipe for <1000 captures');
    assert.equal(body.namespace, ns, 'namespace round-trips in response');
    assert.ok('accepted' in body, 'response must carry accepted boolean');
    assert.ok('synth' in body, 'response must include synth detail');
  });
});

test('W297 #6 — distill/from-captures returns 400 not_enough_captures below min_pairs', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const ns = 'w297_short_' + Date.now().toString(36);
    const post = await fetch(base + '/v1/capture/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ namespace: ns, items: [{ input: 'a', output: 'A' }] }),
    });
    assert.equal(post.status, 201);
    const r = await fetch(base + '/v1/distill/from-captures', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ namespace: ns, mode: 'recipe', min_pairs: 4 }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error, 'not_enough_captures');
    assert.equal(body.namespace, ns);
    assert.equal(body.min_pairs, 4);
    assert.equal(body.count, 1);
  });
});

test('W297 #7 — POST /v1/replay requires concept_id or version_id (400)', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ namespace: 'default' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error, 'concept_id_or_version_id_required');
  });
});

test('W297 #8 — cross-tenant isolation: tenant A captures do NOT leak into tenant B reads', async () => {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const A = provisionAnonTenant({ ttl_days: 1, quota: 100 });
  const B = provisionAnonTenant({ ttl_days: 1, quota: 100 });
  assert.notEqual(A.api_key, B.api_key);

  await withServer(app, async (base) => {
    const ns = 'w297_iso_' + Date.now().toString(36);
    // Tenant A writes 3 captures in namespace ns.
    const postA = await fetch(base + '/v1/capture/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + A.api_key },
      body: JSON.stringify({
        namespace: ns,
        items: [
          { input: 'A-1', output: 'a1' },
          { input: 'A-2', output: 'a2' },
          { input: 'A-3', output: 'a3' },
        ],
      }),
    });
    assert.equal(postA.status, 201);

    // Tenant B reads bridges/observations — must NOT see tenant A's rows even
    // when filtering by the same namespace, because findByTenant is tenant-keyed.
    const rB = await fetch(base + `/v1/bridges/observations?namespace=${encodeURIComponent(ns)}&limit=50`, {
      headers: { authorization: 'Bearer ' + B.api_key },
    });
    assert.equal(rB.status, 200);
    const bodyB = await rB.json();
    assert.equal(bodyB.total, 0,
      `tenant B must see 0 rows in namespace shared with tenant A; saw ${bodyB.total} — cross-tenant leak via findByTenant`);
  });
});
