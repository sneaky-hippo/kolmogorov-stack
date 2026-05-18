// Wave 346 — Local static-page rewrites mirror vercel.json.
//
// Bug: vercel.json has `/marketplace -> /marketplace.html` (plus dozens of
// peers), but `src/router.js` had no equivalent fallback. A local dev server
// (or any harness that mounts buildRouter() alone) 404s on /marketplace,
// /captures, /models, /tui, /value-loop, /foundations etc. Fix: a final
// r.get('*') in buildRouter() resolves extension-less GETs against the
// public/ directory, mirroring Vercel's "try public/<path>.html first, then
// public/<path>/index.html" behavior.
//
// Behavior assertions (no copy):
//   1. GET /marketplace returns 200 + text/html + body contains <html.
//   2. The six headline clean URLs (/marketplace, /captures, /models, /tui,
//      /value-loop, /foundations) all return 200 with HTML body.
//   3. Traversal attempts (/..%2fserver, /a/../b) still 404.
//   4. /v1/* paths are NOT swallowed by the static fallback (they hit the
//      API router and return either JSON or 401).
//   5. Unknown extension-less paths fall through to next() (caller's 404).

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function bootApp() {
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  // Last-resort 404 so assertions on "unknown page" return a deterministic
  // 404 instead of express's default html.
  app.use((_req, res) => res.status(404).type('text/plain').send('not found'));
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

test('W346 #1 - GET /marketplace returns 200 with marketplace.html body', async () => {
  const app = await bootApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/marketplace');
    assert.equal(r.status, 200, 'expected 200 for /marketplace');
    const ct = String(r.headers.get('content-type') || '');
    assert.ok(ct.includes('html'), `expected html content-type, got ${ct}`);
    const body = await r.text();
    assert.ok(body.length > 1000, `expected non-trivial body, got ${body.length} bytes`);
    assert.match(body, /<html/i);
  });
});

test('W346 #2 - core clean URLs all serve their .html locally', async () => {
  const app = await bootApp();
  await withServer(app, async (base) => {
    for (const p of ['/marketplace', '/captures', '/models', '/tui', '/value-loop', '/foundations']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, `expected 200 for ${p}, got ${r.status}`);
      const body = await r.text();
      assert.ok(body.length > 500, `expected non-trivial html for ${p}, got ${body.length} bytes`);
      assert.match(body, /<html/i, `expected html body for ${p}`);
    }
  });
});

test('W346 #3 - traversal and weird paths do not escape public/', async () => {
  const app = await bootApp();
  await withServer(app, async (base) => {
    // Path with .. is rejected by the fallback's `includes('..')` guard.
    const r1 = await fetch(base + '/a/../b');
    assert.notEqual(r1.status, 200, '/a/../b must not serve a 200 page');
    // URL-encoded traversal: express decodes once; our guard catches '..' literal.
    const r2 = await fetch(base + '/..%2fserver');
    assert.notEqual(r2.status, 200, '/..%2fserver must not serve a 200 page');
  });
});

test('W346 #4 - /v1/* paths still hit the API router (not the static fallback)', async () => {
  const app = await bootApp();
  await withServer(app, async (base) => {
    // /health is exposed publicly by buildRouter() and returns JSON.
    const h = await fetch(base + '/health');
    assert.equal(h.status, 200);
    const j = await h.json();
    assert.equal(typeof j.status, 'string');

    // /v1/concepts is auth-gated; without bearer it returns 401, NOT 200 HTML.
    const r = await fetch(base + '/v1/concepts');
    assert.notEqual(r.status, 200);
    const ct = String(r.headers.get('content-type') || '');
    assert.ok(!ct.includes('html'), `/v1/* must never return HTML, got ct=${ct}`);
  });
});

test('W346 #5 - unknown extension-less path falls through to host 404', async () => {
  const app = await bootApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/this-page-does-not-exist-w346');
    assert.equal(r.status, 404);
  });
});
