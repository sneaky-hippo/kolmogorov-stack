// Wave 322-325 — /quickstart/{cli,api,sdk,embed} surface pages.
//
// Each page is a focused 5-step walkthrough for one developer surface.
// All four pages share an invariant set:
//   - file exists at public/quickstart/<surface>.html
//   - <title> ends with "· kolm.ai" (W228 brand-disambig contract)
//   - <link rel=canonical> points at https://kolm.ai/quickstart/<surface>
//   - JSON-LD TechArticle block present
//   - W221 nav has all 5 anchors (Product/Models/Docs/Pricing/Enterprise)
//   - skip-link present (W207 a11y contract)
//   - first 1200 body chars contain "kolm.ai" (W228)
//   - cross-links to the OTHER three quickstart surfaces present
//
// Per-page assertions cover the unique value of each surface so the test
// fails if someone deletes the meat of the page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QS_DIR = path.resolve(__dirname, '..', 'public', 'quickstart');

const SURFACES = ['cli', 'api', 'sdk', 'embed'];

function read(surface) {
  return fs.readFileSync(path.join(QS_DIR, surface + '.html'), 'utf8');
}

for (const surface of SURFACES) {
  test(`W32x ${surface} — file exists, parses to non-trivial size`, () => {
    const p = path.join(QS_DIR, surface + '.html');
    assert.ok(fs.existsSync(p), `${p} must exist`);
    const html = read(surface);
    assert.ok(html.length > 4000, `${surface} must have meaningful content (got ${html.length} bytes)`);
  });

  test(`W32x ${surface} — invariants: title, canonical, nav, skip-link, JSON-LD`, () => {
    const html = read(surface);
    assert.match(html, /<title>[^<]*kolm\.ai<\/title>/, 'title must end with "· kolm.ai" (W228)');
    assert.match(html, new RegExp(`<link rel="canonical" href="https://kolm\\.ai/quickstart/${surface}"`),
      'canonical must point at the kolm.ai surface URL');
    // Skip-link a11y
    assert.match(html, /<a class="skip" href="#main">Skip to content<\/a>/, 'skip-link required by W207 a11y contract');
    assert.match(html, /<main id="main">/, 'main landmark required');
    // 5-anchor consolidated nav (W221)
    for (const v of ['Product', 'Models', 'Docs', 'Pricing', 'Enterprise']) {
      assert.match(html, new RegExp(`<a href="/${v.toLowerCase()}">${v}</a>`),
        `nav must include ${v} (W221 5-link consolidation)`);
    }
    // JSON-LD TechArticle
    assert.match(html, /"@type":"TechArticle"/, 'JSON-LD TechArticle block required (W225/W226)');
    // Brand anchor (W228) — kolm.ai appears in first 1200 chars of body
    const bodyStart = html.split('<body>')[1] || '';
    assert.ok(bodyStart.slice(0, 1200).includes('kolm.ai'),
      'kolm.ai must appear in first 1200 body chars (W228 brand disambig)');
  });

  test(`W32x ${surface} — cross-links to the other three quickstart surfaces`, () => {
    const html = read(surface);
    for (const other of SURFACES) {
      if (other === surface) continue;
      assert.match(html, new RegExp(`<a href="/quickstart/${other}"`),
        `${surface} must link to /quickstart/${other}`);
    }
  });
}

// ---------- W322 (cli) — must include the five named verbs ----------
test('W322 — /quickstart/cli walks through 5 named verbs in order', () => {
  const html = read('cli');
  for (const v of ['kolm signup', 'kolm whoami', 'kolm tail captures', 'kolm distill --from-captures', 'kolm verify']) {
    assert.ok(html.includes(v), `cli quickstart must include "${v}"`);
  }
  // The CLI page is the one that calls out the 5-step exit-code-friendly nature
  assert.match(html, /[Ff]ive[\s-](commands|step|terminal)/, 'cli must claim "five commands/steps"');
});

// ---------- W323 (api) — must include the cheat sheet table + curl pattern ----------
test('W323 — /quickstart/api shows the curl flow + endpoint cheat sheet', () => {
  const html = read('api');
  // 5 step curl pattern
  for (const endpoint of ['/v1/auth/anon', '/v1/capture/log', '/v1/distill/from-captures', '/v1/artifacts', '/v1/replay']) {
    assert.ok(html.includes(endpoint), `api quickstart must include endpoint ${endpoint}`);
  }
  // Cheat sheet has the receipt header callout
  assert.match(html, /x-kolm-capture-durable/, 'api must call out the durable receipt header');
  // Endpoint table exists
  assert.match(html, /class="endpoint-table"/, 'api must include the endpoint cheat-sheet table');
});

// ---------- W324 (sdk) — must show both TS and Python in tabs ----------
test('W324 — /quickstart/sdk shows TypeScript + Python tabs and the swap-the-import sell', () => {
  const html = read('sdk');
  // Strip syntax-highlight spans before matching import patterns
  const stripped = html.replace(/<[^>]+>/g, ' ').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
  assert.match(stripped, /import\s+Kolm\s+from\s+['"]@kolm\/sdk['"]/, 'sdk page must show the TS import');
  assert.match(stripped, /from\s+kolm\s+import\s+Kolm/, 'sdk page must show the Python import');
  assert.match(html, /captureNamespace/, 'sdk page must show capture wiring (TS)');
  assert.match(html, /capture_namespace/, 'sdk page must show capture wiring (Python)');
  // Tab handler (lightweight, no framework)
  assert.match(html, /role="tablist"/, 'sdk must use real tablist role for the language toggle');
  assert.match(html, /aria-selected/, 'tabs must use aria-selected');
});

// ---------- W325 (embed) — must list the 3 host environments ----------
test('W325 — /quickstart/embed lists browser + node + edge targets and verify-before-bundle', () => {
  const html = read('embed');
  for (const host of ['browser', 'node', 'edge', 'Cloudflare', 'verify']) {
    assert.ok(html.toLowerCase().includes(host.toLowerCase()),
      `embed page must mention "${host}"`);
  }
  // The three target cards
  assert.match(html, /class="target-card"/, 'embed must have target cards');
  // The verify-before-bundle policy
  assert.match(html, /[Vv]erify before/, 'embed must enforce verify-before-bundle');
});

// ---------- vercel rewrites must be present for all 4 surfaces ----------
test('W322-325 — vercel.json has rewrites for all 4 quickstart surfaces', () => {
  const vercel = fs.readFileSync(path.resolve(__dirname, '..', 'vercel.json'), 'utf8');
  for (const s of SURFACES) {
    assert.match(vercel, new RegExp(`"source":\\s*"/quickstart/${s}"`),
      `vercel.json must have rewrite for /quickstart/${s}`);
    assert.match(vercel, new RegExp(`"destination":\\s*"/quickstart/${s}\\.html"`),
      `vercel.json must point /quickstart/${s} to the .html file`);
  }
});

// ---------- sw.js bumped past wave321 ----------
test('W322-325 — sw.js cache slug bumped past wave321', () => {
  const sw = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const m = sw.match(/const CACHE = '([^']+)'/);
  assert.ok(m, 'sw.js must define CACHE');
  const slug = m[1];
  const waveMatch = slug.match(/wave(\d+)/);
  assert.ok(waveMatch, 'cache slug must contain waveN');
  const n = parseInt(waveMatch[1], 10);
  assert.ok(n >= 322, `sw.js cache must be >= wave322 (got wave${n})`);
});
