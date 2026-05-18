// Wave 313 — /value-loop "try it now" form + public /v1/loop/try endpoint.
//
// W312 added the live status badge; W313 adds an inline form where any
// anonymous visitor can post a prompt+response and see the exact same
// receipt envelope a real /v1/bridges/observe would emit, with
// `demo:true` + `x-kolm-capture-durable: false` so the body cannot lie.
//
// Lock-ins:
//   1. /v1/loop/try is mounted, anonymous, returns the demo envelope.
//   2. Missing prompt OR response returns 400.
//   3. Oversized payload (>2000 chars either field) returns 413.
//   4. Receipt body always carries demo:true and durable:false.
//   5. Receipt headers always carry x-kolm-capture-durable:false +
//      x-kolm-capture-demo:true (so the demo cannot pretend to persist).
//   6. The form exists in value-loop.html with the right ids.
//   7. The form submit JS posts JSON to /v1/loop/try, not /v1/bridges/observe.
//   8. The page is honest about the endpoint being a demo — copy mentions
//      both demo:true and x-kolm-capture-durable: false.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import { buildRouter } from '../src/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VL_PATH = path.resolve(__dirname, '..', 'public', 'value-loop.html');

function readVL() { return fs.readFileSync(VL_PATH, 'utf8'); }

function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, () => {
      resolve({ srv, port: srv.address().port });
    });
  });
}

async function tryIt(port, body) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/loop/try`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch (_) { parsed = null; }
  return { status: r.status, headers: r.headers, body: parsed };
}

test('W313 #1 — /v1/loop/try is anonymous and returns the demo envelope', async () => {
  const { srv, port } = await startServer();
  try {
    const r = await tryIt(port, { prompt: 'demo prompt', response: 'demo response', model: 'kolm-demo' });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    assert.equal(r.body.demo, true, 'body.demo must be true');
    assert.equal(r.body.durable, false, 'body.durable must be false');
    assert.ok(typeof r.body.observation_id === 'string' && r.body.observation_id.startsWith('demo_'), 'observation_id must start with demo_');
    assert.ok(typeof r.body.template_hash === 'string' && r.body.template_hash.length >= 8, 'template_hash must be present');
    assert.equal(r.body.cluster_size, 1);
    assert.equal(r.body.ready_for_synthesis, false);
  } finally {
    srv.close();
  }
});

test('W313 #2 — missing prompt OR response returns 400', async () => {
  const { srv, port } = await startServer();
  try {
    const a = await tryIt(port, { response: 'no prompt' });
    assert.equal(a.status, 400, 'missing prompt must 400');
    const b = await tryIt(port, { prompt: 'no response' });
    assert.equal(b.status, 400, 'missing response must 400');
    const c = await tryIt(port, {});
    assert.equal(c.status, 400, 'empty body must 400');
  } finally {
    srv.close();
  }
});

test('W313 #3 — oversized payload (>2000 chars) returns 413', async () => {
  const { srv, port } = await startServer();
  try {
    const big = 'x'.repeat(2001);
    const a = await tryIt(port, { prompt: big, response: 'ok' });
    assert.equal(a.status, 413, 'oversized prompt must 413');
    const b = await tryIt(port, { prompt: 'ok', response: big });
    assert.equal(b.status, 413, 'oversized response must 413');
  } finally {
    srv.close();
  }
});

test('W313 #4 — receipt body always carries demo:true and durable:false', async () => {
  const { srv, port } = await startServer();
  try {
    // Multiple shapes — never persist, always demo flagged.
    for (const payload of [
      { prompt: 'a', response: 'b' },
      { prompt: 'long prompt here', response: 'long response here', model: 'gpt-4' },
      { prompt: 'unicode · em-dash — works', response: 'yes', model: 'claude-3' },
    ]) {
      const r = await tryIt(port, payload);
      assert.equal(r.status, 200);
      assert.equal(r.body.demo, true, `demo must be true for ${JSON.stringify(payload)}`);
      assert.equal(r.body.durable, false, `durable must be false for ${JSON.stringify(payload)}`);
    }
  } finally {
    srv.close();
  }
});

test('W313 #5 — receipt headers carry x-kolm-capture-durable:false + x-kolm-capture-demo:true', async () => {
  const { srv, port } = await startServer();
  try {
    const r = await tryIt(port, { prompt: 'hdr', response: 'check' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-kolm-capture-durable'), 'false', 'x-kolm-capture-durable header must be exactly "false"');
    assert.equal(r.headers.get('x-kolm-capture-demo'), 'true', 'x-kolm-capture-demo header must be exactly "true"');
  } finally {
    srv.close();
  }
});

test('W313 #6 — the form exists in value-loop.html with the right ids', () => {
  const html = readVL();
  assert.match(html, /id="try-form"/, 'form#try-form missing');
  assert.match(html, /id="try-prompt"/, 'textarea#try-prompt missing');
  assert.match(html, /id="try-response"/, 'textarea#try-response missing');
  assert.match(html, /id="try-submit"/, 'button#try-submit missing');
  assert.match(html, /id="try-result"/, 'pre#try-result missing');
  assert.match(html, /id="try-status"/, 'span#try-status missing');
  assert.match(html, /id="try-it"/, '<h2 id="try-it"> anchor missing');
});

test('W313 #7 — form submit JS posts JSON to /v1/loop/try, not /v1/bridges/observe', () => {
  const html = readVL();
  // The W313 form must hit the demo endpoint, not the real observe endpoint
  // (which would 401 anonymously anyway and would also pollute prod).
  assert.match(html, /fetch\(\s*['"]\/v1\/loop\/try['"]/, 'form must POST /v1/loop/try');
  assert.ok(!/fetch\(\s*['"]\/v1\/bridges\/observe['"]/.test(html), 'form must NOT post to /v1/bridges/observe');
  assert.match(html, /method:\s*['"]POST['"]/, 'must use POST');
  assert.match(html, /content-type/i, 'must set content-type header');
});

test('W313 #8 — page copy is honest about it being a demo (no persistence claim)', () => {
  const html = readVL();
  // The visible copy must name both signals (demo:true and the
  // x-kolm-capture-durable: false header) so a visitor cannot believe
  // their capture was stored.
  assert.match(html, /demo:true/, 'copy must mention demo:true to set expectations');
  assert.match(html, /x-kolm-capture-durable:\s*false/, 'copy must mention durable:false header');
  assert.match(html, /no\s+(key|write)/i, 'copy should mention no key or no write');
});
