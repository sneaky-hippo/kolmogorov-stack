// W263 — kolm.ai marketplace lock-in.
// Asserts:
//   * public/marketplace.html exists + has the filter bar + cards grid
//   * 6 per-slug pages exist with K-score badge + install snippet
//   * src/marketplace.js exposes listArtifacts / getArtifact / getCatalogManifest
//     with the right shapes and that the filter honors category / license /
//     min_k_score / verified
//   * the signed catalog manifest's signature is a recomputable sha256 over
//     the canonical JSON of the manifest body
//   * the wave265-marketplace sw.js slug is monotonic >= 263
//   * the new vercel rewrites are in place
//   * the kolm CLI `marketplace search --json` returns valid JSON and the 404
//     path returns a NOT_FOUND exit code

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const CLI = path.join(ROOT, 'cli', 'kolm.js');

const SLUGS = [
  'phi-redactor',
  'invoice-parser',
  'legal-clause-extractor',
  'code-issue-classifier',
  'multilingual-greeter',
  'cs-intent-classifier',
];

function read(p) { return fs.readFileSync(p, 'utf8'); }

test('W263 #1 marketplace.html hub page exists and is substantive', () => {
  const p = path.join(PUBLIC, 'marketplace.html');
  assert.ok(fs.existsSync(p), 'public/marketplace.html must exist');
  const html = read(p);
  assert.ok(html.length > 4000, `expected substantive page, got ${html.length} bytes`);
  assert.match(html, /<title>[^<]*kolm\.ai[^<]*<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/marketplace">/);
});

test('W263 #2 hub page has a filter bar with category / license / min-k / verified controls', () => {
  const html = read(path.join(PUBLIC, 'marketplace.html'));
  assert.match(html, /id="f-category"/);
  assert.match(html, /id="f-license"/);
  assert.match(html, /id="f-min-k"/);
  assert.match(html, /id="f-verified"/);
});

test('W263 #3 hub page has a card grid that names every seed slug', () => {
  const html = read(path.join(PUBLIC, 'marketplace.html'));
  assert.match(html, /id="cards"/);
  for (const s of SLUGS) {
    assert.match(html, new RegExp(`href="/marketplace/${s}"`), `hub must link to /marketplace/${s}`);
  }
});

test('W263 #4 every per-slug detail page exists', () => {
  for (const s of SLUGS) {
    const p = path.join(PUBLIC, 'marketplace', `${s}.html`);
    assert.ok(fs.existsSync(p), `missing detail page ${p}`);
    const html = read(p);
    assert.ok(html.length > 2500, `detail page ${s} too small: ${html.length}`);
  }
});

test('W263 #5 every detail page has the K-score badge + install snippet + verify snippet', () => {
  for (const s of SLUGS) {
    const html = read(path.join(PUBLIC, 'marketplace', `${s}.html`));
    assert.match(html, /K-score/, `${s} missing K-score copy`);
    assert.match(html, /class="kbox"/, `${s} missing K-score badge box`);
    assert.match(html, new RegExp(`kolm marketplace install ${s}`), `${s} missing install snippet`);
    assert.match(html, /kolm verify/, `${s} missing verify snippet`);
    assert.match(html, /K-score \d\.\d{4}/, `${s} K-score value must show 4 decimals`);
  }
});

test('W263 #6 every detail page has the "compile your own variant" CTA', () => {
  for (const s of SLUGS) {
    const html = read(path.join(PUBLIC, 'marketplace', `${s}.html`));
    assert.match(html, new RegExp(`/build-your-own\\?template=${s}`), `${s} missing build-your-own CTA`);
  }
});

test('W263 #7 every detail page has Article/SoftwareApplication + BreadcrumbList JSON-LD', () => {
  for (const s of SLUGS) {
    const html = read(path.join(PUBLIC, 'marketplace', `${s}.html`));
    assert.match(html, /"@type":\s*"SoftwareApplication"/, `${s} missing SoftwareApplication JSON-LD`);
    assert.match(html, /"@type":\s*"BreadcrumbList"/, `${s} missing BreadcrumbList JSON-LD`);
    assert.match(html, /"position":\s*3/, `${s} breadcrumb must reach position 3`);
  }
});

test('W263 #8 src/marketplace.js loads and exports the documented surface', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'marketplace.js')).href);
  assert.equal(typeof mod.listArtifacts, 'function');
  assert.equal(typeof mod.getArtifact, 'function');
  assert.equal(typeof mod.getCatalogManifest, 'function');
  assert.equal(typeof mod.resolveArtifactPath, 'function');
  assert.equal(typeof mod.verifyCatalogManifest, 'function');
  assert.ok(Array.isArray(mod.MARKETPLACE_CATEGORIES));
  assert.ok(mod.MARKETPLACE_BADGES.includes('Verified'));
  assert.ok(mod.MARKETPLACE_BADGES.includes('HIPAA'));
});

test('W263 #9 listArtifacts returns the 6 seed artifacts and every entry has real sha256/bytes', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'marketplace.js')).href);
  const all = mod.listArtifacts();
  assert.equal(all.length, SLUGS.length, `expected ${SLUGS.length} artifacts, got ${all.length}`);
  for (const a of all) {
    assert.ok(SLUGS.includes(a.slug), `unexpected slug ${a.slug}`);
    assert.match(a.sha256, /^[0-9a-f]{64}$/, `${a.slug} sha256 must be 64-hex`);
    assert.ok(a.bytes > 0, `${a.slug} bytes must be > 0`);
    assert.ok(typeof a.k_score === 'number' && a.k_score > 0 && a.k_score <= 1, `${a.slug} k_score must be in (0,1]`);
    assert.ok(Array.isArray(a.badges), `${a.slug} badges must be array`);
  }
});

test('W263 #10 listArtifacts honors category / license / verified / min-k-score filters', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'marketplace.js')).href);
  const compliance = mod.listArtifacts({ filter: { category: 'compliance' } });
  assert.ok(compliance.length >= 1, 'expected at least one compliance entry');
  for (const a of compliance) assert.equal(a.category, 'compliance');

  const verifiedOnly = mod.listArtifacts({ filter: { verified: true } });
  for (const a of verifiedOnly) assert.equal(a.verified, true);

  const highK = mod.listArtifacts({ filter: { min_k_score: 0.99 } });
  for (const a of highK) assert.ok(a.k_score >= 0.99);

  const apache = mod.listArtifacts({ filter: { license: 'Apache-2.0' } });
  assert.equal(apache.length, mod.listArtifacts().length, 'every seed should be Apache-2.0');

  const none = mod.listArtifacts({ filter: { category: '__nonsense__' } });
  assert.equal(none.length, 0);
});

test('W263 #11 getArtifact returns the entry for a known slug, null for unknown', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'marketplace.js')).href);
  const a = mod.getArtifact('phi-redactor');
  assert.ok(a, 'phi-redactor must resolve');
  assert.equal(a.slug, 'phi-redactor');
  assert.equal(mod.getArtifact('does-not-exist'), null);
  assert.equal(mod.getArtifact(null), null);
});

test('W263 #12 getCatalogManifest returns a signed manifest with sha256-anchor signature that verifies', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'marketplace.js')).href);
  const mani = mod.getCatalogManifest();
  assert.equal(mani.spec, 'kolm-marketplace-1');
  assert.equal(mani.signature_algo, 'sha256-anchor');
  assert.match(mani.signature, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(mani.artifacts));
  assert.equal(mani.artifacts.length, SLUGS.length);

  // Recompute the signature and confirm it matches what the manifest carries.
  const ver = mod.verifyCatalogManifest(mani);
  assert.equal(ver.ok, true, `signature should verify; expected=${ver.expected} got=${ver.got}`);

  // Tamper: flipping a single byte must invalidate the signature.
  const tampered = JSON.parse(JSON.stringify(mani));
  tampered.artifacts[0].sha256 = '0'.repeat(64);
  const verT = mod.verifyCatalogManifest(tampered);
  assert.equal(verT.ok, false, 'tampered manifest must NOT verify');
});

test('W263 #13 resolveArtifactPath returns an existing absolute path for known slugs', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'marketplace.js')).href);
  for (const s of SLUGS) {
    const p = mod.resolveArtifactPath(s);
    assert.ok(p, `${s} must resolve to a path`);
    assert.ok(fs.existsSync(p), `${s} path must exist on disk`);
  }
  assert.equal(mod.resolveArtifactPath('unknown'), null);
});

test('W263 #14 router.js wires the marketplace endpoints', () => {
  const src = read(path.join(ROOT, 'src', 'router.js'));
  assert.match(src, /\/v1\/marketplace\/catalog\.json/);
  assert.match(src, /\/v1\/marketplace\/:slug/);
  assert.match(src, /\/v1\/marketplace\/:slug\/download/);
  assert.match(src, /\/v1\/marketplace\/publish-request/);
  assert.match(src, /from '\.\/marketplace\.js'/);
});

test('W263 #15 cli/kolm.js wires cmdMarketplace into the dispatcher and completion list', () => {
  const src = read(CLI);
  assert.match(src, /case 'marketplace':/, 'dispatcher must route the marketplace verb');
  assert.match(src, /async function cmdMarketplace/, 'cmdMarketplace must be defined');
  assert.match(src, /'marketplace'/, 'COMPLETION_VERBS must include marketplace');
});

test('W263 #16 vercel.json has rewrites for /marketplace and every per-slug page', () => {
  const v = JSON.parse(read(path.join(ROOT, 'vercel.json')));
  const sources = v.rewrites.map((r) => r.source);
  assert.ok(sources.includes('/marketplace'), 'missing /marketplace rewrite');
  for (const s of SLUGS) {
    assert.ok(sources.includes(`/marketplace/${s}`), `missing /marketplace/${s} rewrite`);
  }
});

test('W263 #17 sw.js CACHE slug wave-floor is >= 263', () => {
  const sw = read(path.join(PUBLIC, 'sw.js'));
  const m = sw.match(/const CACHE = 'kolm-v\d+-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE slug must follow wave naming');
  const n = parseInt(m[1], 10);
  assert.ok(n >= 263, `expected wave >= 263, got ${n}`);
});

test('W263 #18 hub page brand-disambig: <title> ends with kolm.ai', () => {
  const html = read(path.join(PUBLIC, 'marketplace.html'));
  const m = html.match(/<title>([^<]+)<\/title>/);
  assert.ok(m, 'no <title>');
  assert.match(m[1], /kolm\.ai\s*$/);
});

test('W263 #19 CLI: kolm marketplace search --json returns valid JSON with the expected shape', () => {
  // Run with KOLM_BASE pointing nowhere so the network path fails and the
  // on-disk fallback kicks in — keeps the test offline-friendly. We force a
  // localhost port that should refuse connection.
  const env = { ...process.env, KOLM_BASE: 'http://127.0.0.1:1', KOLM_CONFIG_DIR: path.join(ROOT, '.tmp-w263-cli') };
  const res = spawnSync(process.execPath, [CLI, 'marketplace', 'search', '--json'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0, `cli failed: status=${res.status} stderr=${res.stderr}`);
  const data = JSON.parse(res.stdout);
  assert.ok(Array.isArray(data.artifacts), 'expected .artifacts array');
  assert.ok(data.artifacts.length === SLUGS.length, `expected ${SLUGS.length} artifacts, got ${data.artifacts.length}`);
  for (const a of data.artifacts) {
    assert.ok(typeof a.slug === 'string');
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
  }
});

test('W263 #20 CLI: kolm marketplace install <unknown-slug> exits with NOT_FOUND', () => {
  const env = { ...process.env, KOLM_BASE: 'http://127.0.0.1:1', KOLM_CONFIG_DIR: path.join(ROOT, '.tmp-w263-cli') };
  const res = spawnSync(process.execPath, [CLI, 'marketplace', 'install', 'does-not-exist-xyz'], { env, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(res.status, 0, 'unknown slug must exit non-zero');
  assert.equal(res.status, 5, `expected exit code 5 (NOT_FOUND), got ${res.status}`);
});

test('W263 #21 detail pages carry the K-score in the JSON-LD aggregateRating ratingValue', () => {
  for (const s of SLUGS) {
    const html = read(path.join(PUBLIC, 'marketplace', `${s}.html`));
    assert.match(html, /"@type":\s*"AggregateRating"/, `${s} missing AggregateRating`);
    assert.match(html, /"ratingValue":\s*"0\.\d{4}"/, `${s} ratingValue must show 4 decimals`);
  }
});

test('W263 #22 every detail page references its per-slug OG card under /og/marketplace-*.svg', () => {
  const og = path.join(PUBLIC, 'og');
  assert.ok(fs.existsSync(path.join(og, 'marketplace.svg')), 'hub OG card missing');
  for (const s of SLUGS) {
    const html = read(path.join(PUBLIC, 'marketplace', `${s}.html`));
    const re = new RegExp(`/og/marketplace-${s}\\.svg`);
    assert.match(html, re, `${s} must reference /og/marketplace-${s}.svg`);
    assert.ok(fs.existsSync(path.join(og, `marketplace-${s}.svg`)), `marketplace-${s}.svg missing`);
  }
});

test('W263 #23 catalog manifest sha256 anchor matches a re-computation', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'marketplace.js')).href);
  const mani = mod.getCatalogManifest();
  // Replicate the canonical-json + hash recipe end to end here so the test
  // does not depend on the module's own helper.
  const { signature, signed_at: _sa, signature_algo: _sal, ...body } = mani;
  const sortRecursive = (x) => {
    if (Array.isArray(x)) return x.map(sortRecursive);
    if (x && typeof x === 'object') {
      const out = {};
      for (const k of Object.keys(x).sort()) out[k] = sortRecursive(x[k]);
      return out;
    }
    return x;
  };
  const recomputed = crypto.createHash('sha256').update(JSON.stringify(sortRecursive(body))).digest('hex');
  assert.equal(recomputed, signature, 'recomputed signature must match what the manifest carries');
});

test('W263 #24 no em-dashes in marketplace.html or detail pages (copy hygiene)', () => {
  // Em-dash policy: load-bearing em-dashes are out per W244 lede / W245 lock-in.
  // We allow them in CLI snippets within <pre> blocks since those reproduce
  // server output verbatim. So we strip <pre>...</pre> first.
  const files = [path.join(PUBLIC, 'marketplace.html'), ...SLUGS.map((s) => path.join(PUBLIC, 'marketplace', `${s}.html`))];
  for (const f of files) {
    const html = read(f).replace(/<pre[\s\S]*?<\/pre>/g, '');
    const em = (html.match(/—/g) || []).length;
    assert.equal(em, 0, `${path.basename(f)} contains ${em} em-dash(es) outside <pre>`);
  }
});
