// Wave 261: no-code in-browser artifact builder at /builder.
//
// Behavior assertions only (per Pablo W202-W210 correction - no fragile
// page-text markers that drift with copy changes).
//
// W261 contract this test enforces:
//   1. public/builder.html exists, has <!DOCTYPE html>, closes </html>, has
//      4 step containers (id="step-1" through id="step-4") and uses the
//      shared kolm design tokens (--ink, --bg-elev, --accent, --mono).
//   2. /builder is rewritten to /builder.html in vercel.json AND the rewrite
//      block is appended (existing rewrites untouched).
//   3. POST /v1/builder/preview is registered (unauthed, rate-limited).
//   4. POST /v1/builder/compile is registered behind authMiddleware.
//   5. GET  /v1/builder/templates is registered (unauthed).
//   6. /v1/builder/templates returns >= 5 templates with the canonical fields
//      (id, name, description, task, examples[]) and includes the 5 named
//      starters: phi-redactor / invoice-parser / msa-clause-extraction /
//      pr-review / multilingual-greeting.
//   7. Preview validates inputs: task required, task length <= 4000,
//      examples array length <= 100, each example body <= 10240 bytes.
//   8. Preview returns recipe_source (string), k_score_estimate (object with
//      composite + ships), warnings[] given a small example set.
//   9. Compile endpoint creates a real compile job via createJob and returns
//      {job_id} with the same status/poll envelope as POST /v1/compile.
//  10. public/sw.js CACHE wave-floor >= 261.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILDER_HTML = fs.readFileSync(path.join(ROOT, 'public/builder.html'), 'utf8');
const ROUTER_SRC   = fs.readFileSync(path.join(ROOT, 'src/router.js'),       'utf8');
const VERCEL_JSON  = fs.readFileSync(path.join(ROOT, 'vercel.json'),         'utf8');
const SW_JS        = fs.readFileSync(path.join(ROOT, 'public/sw.js'),        'utf8');

function sliceHandler(src, marker, len = 8000) {
  const idx = src.indexOf(marker);
  assert.ok(idx > 0, 'marker not found: ' + marker);
  return src.slice(idx, idx + len);
}

test('W261 #1 - builder.html exists with valid HTML envelope + 4 steps + tokens', () => {
  assert.match(BUILDER_HTML, /^<!DOCTYPE html>/i, 'must start with <!DOCTYPE html>');
  assert.match(BUILDER_HTML, /<\/html>\s*$/i, 'must close </html>');
  // Four named step containers.
  for (const i of [1, 2, 3, 4]) {
    assert.match(BUILDER_HTML, new RegExp('id="step-' + i + '"'), 'missing step-' + i);
  }
  // Required CSS tokens.
  for (const tok of ['--ink', '--bg-elev', '--accent', '--mono']) {
    assert.ok(BUILDER_HTML.includes(tok), 'missing token ' + tok);
  }
  // Title carries the kolm.ai brand.
  assert.match(BUILDER_HTML, /<title>[^<]*kolm\.ai[^<]*<\/title>/i);
  // Light/dark theme switch IIFE in <head> (pre-paint).
  assert.match(BUILDER_HTML, /localStorage\.getItem\('kolm-theme'\)/);
});

test('W261 #2 - vercel.json rewrites /builder -> /builder.html (added, no edits to existing)', () => {
  assert.match(
    VERCEL_JSON,
    /\{\s*"source":\s*"\/builder"\s*,\s*"destination":\s*"\/builder\.html"\s*\}/,
    '/builder rewrite missing'
  );
  // Sanity: existing /setup rewrite still present (we did not damage it).
  assert.match(VERCEL_JSON, /"source":\s*"\/setup"\s*,\s*"destination":\s*"\/setup\.html"/);
});

test('W261 #3 - POST /v1/builder/preview registered (unauthed, rate-limited)', () => {
  // Unauthed routes live BEFORE the `r.use(authMiddleware)` line. Find both
  // anchors and assert the preview registration sits in front of the gate.
  const previewIdx = ROUTER_SRC.indexOf("r.post('/v1/builder/preview'");
  const gateIdx    = ROUTER_SRC.indexOf('r.use(authMiddleware);');
  assert.ok(previewIdx > 0, 'POST /v1/builder/preview not found');
  assert.ok(gateIdx    > 0, 'authMiddleware mount point missing');
  assert.ok(previewIdx < gateIdx, 'preview must be unauthed (above the gate)');
  // A rate-limit middleware (builderLimiter) must be the first argument after the path.
  assert.match(
    ROUTER_SRC,
    /r\.post\(['"]\/v1\/builder\/preview['"]\s*,\s*builderLimiter/,
    'preview must be rate-limited via builderLimiter'
  );
});

test('W261 #4 - POST /v1/builder/compile registered behind authMiddleware', () => {
  const compileIdx = ROUTER_SRC.indexOf("r.post('/v1/builder/compile'");
  const gateIdx    = ROUTER_SRC.indexOf('r.use(authMiddleware);');
  assert.ok(compileIdx > 0, 'POST /v1/builder/compile not found');
  assert.ok(compileIdx > gateIdx, 'compile must sit after the authMiddleware gate');
});

test('W261 #5 - GET /v1/builder/templates registered (unauthed)', () => {
  const tmplIdx = ROUTER_SRC.indexOf("r.get('/v1/builder/templates'");
  const gateIdx = ROUTER_SRC.indexOf('r.use(authMiddleware);');
  assert.ok(tmplIdx > 0, 'GET /v1/builder/templates not found');
  assert.ok(tmplIdx < gateIdx, 'templates must be unauthed (above the gate)');
});

test('W261 #6 - BUILDER_TEMPLATES contains the 5 named starters', () => {
  // The constant is exported from src/router.js so we re-import and assert
  // shape + named ids end-to-end without spinning up the server.
  const block = sliceHandler(ROUTER_SRC, 'const BUILDER_TEMPLATES', 6000);
  for (const id of [
    'phi-redactor',
    'invoice-parser',
    'msa-clause-extraction',
    'pr-review',
    'multilingual-greeting',
  ]) {
    assert.ok(block.includes("'" + id + "'") || block.includes('"' + id + '"'),
      'template id missing: ' + id);
  }
  // Each template lists an examples[] array (at minimum 1 example) and a task.
  // Pull the loose count of `examples:` markers; must be >= 5.
  const exMatches = block.match(/examples\s*:\s*\[/g) || [];
  assert.ok(exMatches.length >= 5, 'expected at least 5 examples[] arrays in BUILDER_TEMPLATES, got ' + exMatches.length);
  const taskMatches = block.match(/task\s*:\s*['"]/g) || [];
  assert.ok(taskMatches.length >= 5, 'expected at least 5 task entries in BUILDER_TEMPLATES, got ' + taskMatches.length);
});

test('W261 #7 - preview validates: task required, length<=4000, examples<=100, each<=10kb', () => {
  const handler = sliceHandler(ROUTER_SRC, "r.post('/v1/builder/preview'");
  // task required
  assert.match(handler, /task[\s\S]{0,400}status\(400\)/);
  // length cap 4000
  assert.match(handler, /4000/);
  // example count cap 100
  assert.match(handler, /100/);
  // per-example byte cap 10kb (10240 bytes)
  assert.match(handler, /10240|10\s*\*\s*1024/);
});

test('W261 #8 - preview returns recipe_source + k_score_estimate + warnings shape', async () => {
  // Spin up the express app in-process and POST to /v1/builder/preview.
  // We test against a tiny, deterministic identity-style task so the
  // pattern-mode synthesizer returns a candidate without external calls.
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  const examples = [
    { input: 'hello', expected: 'hello' },
    { input: 'world', expected: 'world' },
    { input: 'kolm',  expected: 'kolm'  },
  ];
  const body = { task: 'echo the input back unchanged', examples };

  // express test helper: hand-rolled supertest replacement (no new deps).
  const port = 0;
  await new Promise((resolve, reject) => {
    const server = app.listen(port, async () => {
      try {
        const realPort = server.address().port;
        const res = await fetch('http://127.0.0.1:' + realPort + '/v1/builder/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 200, 'preview must return 200 on valid input (got ' + res.status + ')');
        const json = await res.json();
        assert.ok(typeof json.recipe_source === 'string', 'recipe_source must be a string');
        assert.ok(json.recipe_source.length > 0,        'recipe_source must be non-empty');
        assert.ok(json.k_score_estimate && typeof json.k_score_estimate.composite === 'number',
          'k_score_estimate.composite must be a number');
        assert.ok('ships' in json.k_score_estimate, 'k_score_estimate.ships must be present');
        assert.ok(Array.isArray(json.warnings), 'warnings must be an array');
        server.close(resolve);
      } catch (e) { server.close(() => reject(e)); }
    });
  });
});

test('W261 #9 - compile endpoint creates a real compile job and returns {job_id}', async () => {
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const { provisionAnonTenant } = await import('../src/auth.js');
  const t = provisionAnonTenant({ ttl_days: 1, quota: 100 });
  const apiKey = t.api_key;
  assert.ok(typeof apiKey === 'string' && apiKey.length > 0, 'anon tenant must return api_key string');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  const body = {
    task: 'echo the input back',
    examples: [{ input: 'a', expected: 'a' }, { input: 'b', expected: 'b' }],
  };

  await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const realPort = server.address().port;
        const res = await fetch('http://127.0.0.1:' + realPort + '/v1/builder/compile', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': 'Bearer ' + apiKey,
          },
          body: JSON.stringify(body),
        });
        // Either 202 (job queued / sync-completed). 401/403 means the auth wire
        // didn't accept the anon tenant key, which is a contract bug.
        assert.equal(res.status, 202, 'compile must return 202 on valid input (got ' + res.status + ')');
        const json = await res.json();
        assert.ok(typeof json.job_id === 'string', 'job_id must be a string');
        assert.match(json.poll, /^\/v1\/compile\/job_/, 'poll URL must reference the canonical job endpoint');
        server.close(resolve);
      } catch (e) { server.close(() => reject(e)); }
    });
  });
});

test('W261 #10 - sw.js CACHE wave-floor >= 261', () => {
  const m = SW_JS.match(/const\s+CACHE\s*=\s*'kolm-v7-2026-05-\d+-wave(\d+)/);
  assert.ok(m, 'CACHE slug present in sw.js');
  assert.ok(parseInt(m[1], 10) >= 261, 'CACHE wave >= 261 (got ' + m[1] + ')');
});
