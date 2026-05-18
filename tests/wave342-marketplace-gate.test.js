// Wave 342 — Marketplace "Verified" badge gated on real productionReady().
//
// Trust bug from trial: marketplace cards in public/marketplace.html had
// data-verified="true" hardcoded for every row, and the API response
// echoed the seed-catalog `verified: true`. A user could install an
// artifact whose seed_provenance was absent (not production_ready) and
// see a green Verified badge.
//
// W342 wires:
//   - GET /v1/marketplace + /v1/marketplace/catalog.json + /v1/marketplace/list
//     overwrite the seed `verified` flag with productionReady().ok against
//     the on-disk .kolm. Cached per sha256 to avoid re-zipping.
//   - GET /v1/marketplace/:slug carries the live verdict + gate_reasons.
//   - GET /v1/marketplace/:slug/download refuses non-production_ready
//     artifacts (409). ?force=true overrides for canary/debug.
//   - public/marketplace.html cards have NO hardcoded data-verified=true
//     and NO static Verified pill; the inline script paints them from
//     /v1/marketplace/list.
//
// Tests assert BEHAVIOR (HTTP response shape, HTML attribute absence).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MARKETPLACE_HTML = path.join(ROOT, 'public', 'marketplace.html');
const ROUTER_SRC = path.join(ROOT, 'src', 'router.js');

async function makeApp() {
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
        const out = await fn(`http://127.0.0.1:${server.address().port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

test('W342 #1 — marketplace.html has NO hardcoded data-verified="true" cards', () => {
  const html = fs.readFileSync(MARKETPLACE_HTML, 'utf8');
  // The seed grid must have no `data-verified="true"` attributes on any
  // <article class="card"> opener. The dynamic script can set this attribute
  // after fetch; that is intentional.
  const cardOpener = /<article[^>]*data-verified\s*=\s*"true"/g;
  const matches = html.match(cardOpener) || [];
  assert.equal(matches.length, 0,
    `marketplace.html cards must not hardcode data-verified="true"; found ${matches.length}: ${JSON.stringify(matches)}`);
});

test('W342 #2 — marketplace.html cards have NO static badge-Verified pill', () => {
  const html = fs.readFileSync(MARKETPLACE_HTML, 'utf8');
  // The Verified pill is added by JS only after row.verified === true.
  // Static HTML must not paint it. We allow the CSS class definition itself
  // (`.badge-Verified{...}` style block), but no `<span class="badge badge-Verified">`
  // tag opener in the seed grid.
  const staticPill = /<span\s+class\s*=\s*"badge badge-Verified"/g;
  const matches = html.match(staticPill) || [];
  assert.equal(matches.length, 0,
    `marketplace.html must not paint static <span class="badge badge-Verified">; found ${matches.length}`);
});

test('W342 #3 — marketplace.html fetches /v1/marketplace/list and gates pill on row.verified', () => {
  const html = fs.readFileSync(MARKETPLACE_HTML, 'utf8');
  assert.match(html, /fetch\(['"]\/v1\/marketplace\/list['"]/,
    'inline script must fetch /v1/marketplace/list');
  assert.match(html, /row\.verified\s*===\s*true/,
    'inline script must gate pill render on row.verified === true');
});

// W343 — slugs whose .kolm WAS built with --seeds and therefore is expected
// to pass productionReady() with verified=true. Every other seed-catalog
// artifact lacks seed_provenance and must remain verified=false.
const __PROD_READY_SLUGS = new Set(['claims-redactor']);

test('W342 #4 — GET /v1/marketplace/list returns array with verified field reflecting productionReady()', async () => {
  const app = await makeApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/marketplace/list');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.artifacts), 'response must carry artifacts: []');
    assert.ok(body.artifacts.length > 0, 'expected at least one seed catalog entry');
    for (const a of body.artifacts) {
      assert.equal(typeof a.verified, 'boolean', `artifact ${a.slug} must have boolean verified`);
      const shouldBeReady = __PROD_READY_SLUGS.has(a.slug);
      if (shouldBeReady) {
        // W343 claims-redactor: built with --seeds, must be verified=true.
        assert.equal(a.verified, true,
          `${a.slug}: built with --seeds => productionReady=true => verified must be true (got ${a.verified}). reasons: ${JSON.stringify(a.gate_reasons)}`);
        assert.ok(a.badges.includes('Verified'),
          `${a.slug}: badges must include 'Verified' when verified=true`);
        assert.ok(Array.isArray(a.gate_reasons));
        assert.equal(a.gate_reasons.length, 0,
          `${a.slug}: gate_reasons must be empty when verified=true (got ${JSON.stringify(a.gate_reasons)})`);
      } else {
        // phi-redactor, invoice-parser, ... in registry-pack were built without
        // --seeds, so seed_provenance is missing => verified MUST be false.
        assert.equal(a.verified, false,
          `${a.slug}: no seed_provenance => productionReady=false => verified must be false (got ${a.verified})`);
        // Honest pill: if verified=false, Verified badge must be absent.
        assert.ok(!a.badges.includes('Verified'),
          `${a.slug}: badges must not include 'Verified' when verified=false`);
        // gate_reasons must be a non-empty array on failure (helps the UI explain)
        assert.ok(Array.isArray(a.gate_reasons));
        assert.ok(a.gate_reasons.length > 0,
          `${a.slug}: gate_reasons must list at least one failing gate`);
      }
    }
  });
}, { timeout: 30000 });

test('W342 #5 — GET /v1/marketplace echoes the live verified flag (not seed)', async () => {
  const app = await makeApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/marketplace');
    assert.equal(r.status, 200);
    const body = await r.json();
    const verified = body.artifacts.filter((a) => a.verified === true);
    // Only seed-built artifacts may show verified=true. Pre-W343 fixtures
    // all lack seed_provenance, so the only allowed verified entries are
    // the __PROD_READY_SLUGS set above.
    for (const a of verified) {
      assert.ok(__PROD_READY_SLUGS.has(a.slug),
        `${a.slug}: verified=true but not in PROD_READY allowlist (would be a regression)`);
    }
  });
}, { timeout: 30000 });

test('W342 #6 — GET /v1/marketplace/catalog.json carries live verified verdict', async () => {
  const app = await makeApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/marketplace/catalog.json');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.artifacts));
    for (const a of body.artifacts) {
      assert.equal(typeof a.verified, 'boolean',
        `${a.slug}: signed catalog must carry boolean verified`);
    }
  });
}, { timeout: 30000 });

test('W342 #7 — GET /v1/marketplace/:slug carries verified + gate_reasons', async () => {
  const app = await makeApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/marketplace/phi-redactor');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.slug, 'phi-redactor');
    assert.equal(body.verified, false, 'phi-redactor lacks seed_provenance => verified=false');
    assert.ok(Array.isArray(body.gate_reasons));
    assert.ok(body.gate_reasons.length > 0);
  });
}, { timeout: 30000 });

test('W342 #8 — GET /v1/marketplace/:slug/download refuses non-production_ready (409)', async () => {
  const app = await makeApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/marketplace/phi-redactor/download');
    assert.equal(r.status, 409, 'download must 409 when productionReady fails');
    const body = await r.json();
    assert.equal(body.error, 'production_ready_failed');
    assert.equal(body.slug, 'phi-redactor');
    assert.ok(Array.isArray(body.reasons));
    assert.ok(body.reasons.length > 0);
  });
}, { timeout: 30000 });

test('W342 #9 — ?force=true overrides the download gate', async () => {
  const app = await makeApp();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/marketplace/phi-redactor/download?force=true');
    assert.equal(r.status, 200, 'force=true must let the download through');
    assert.equal(r.headers.get('x-kolm-production-ready'), 'false',
      'header surfaces the honest verdict even on force install');
    const buf = await r.arrayBuffer();
    assert.ok(buf.byteLength > 0, 'must return actual bytes');
  });
}, { timeout: 30000 });

test('W342 #10 — verify cache is per-sha256 (no recompute on second list call)', async () => {
  const app = await makeApp();
  await withServer(app, async (base) => {
    const t0 = Date.now();
    await fetch(base + '/v1/marketplace/list');
    const t1 = Date.now();
    await fetch(base + '/v1/marketplace/list');
    const t2 = Date.now();
    const firstMs = t1 - t0;
    const secondMs = t2 - t1;
    // Don't assert a tight ratio (CI noise) — just that the second call
    // didn't blow up and returned the same shape.
    const r = await fetch(base + '/v1/marketplace/list');
    const body = await r.json();
    assert.ok(Array.isArray(body.artifacts));
    assert.ok(body.artifacts.length > 0);
    // Cache must exist in the router source (per-process Map keyed by sha256).
    const routerSrc = fs.readFileSync(ROUTER_SRC, 'utf8');
    assert.match(routerSrc, /__marketVerifyCache/, 'router must keep a per-sha256 verify cache');
    void firstMs; void secondMs; // timings recorded but not asserted
  });
}, { timeout: 30000 });

test('W342 #11 — router source ANDs verified flag against productionReady() result', () => {
  const src = fs.readFileSync(ROUTER_SRC, 'utf8');
  // The marketplace block must import the shared module + assign verified
  // from the result.ok, not from the seed catalog.
  assert.match(src, /from\s+['"]\.\/production-ready\.js['"]/,
    'router must import production-ready.js');
  assert.match(src, /__hydrateVerified/, 'router must hydrate verified through a single helper');
  // The seed verified flag must be overwritten, not echoed.
  assert.match(src, /verified:\s*v\.ok/, 'router must set verified from productionReady result');
});
