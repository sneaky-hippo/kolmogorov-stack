// Wave 225: SEO infrastructure lock-in.
//
// W225 ships sitemap auto-build, OG per-page card generator, and an
// idempotent SEO sweep that guarantees canonical + og:* + JSON-LD on every
// indexable public/*.html surface. These tests assert BEHAVIOR (file exists,
// xml parses, every top-level page has the four expected tags, every cut
// path is absent from sitemap) — not page-copy markers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SCRIPTS = path.join(ROOT, 'scripts');
const SITEMAP = path.join(PUBLIC, 'sitemap.xml');
const ROBOTS = path.join(PUBLIC, 'robots.txt');
const SW = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

const W224_CUTS = [
  '/agents', '/defense', '/evolve', '/bounty', '/bounties', '/cloud',
  '/distill', '/edge', '/cookbook', '/serve', '/playground', '/onboarding',
  '/recall', '/anatomy', '/showcase', '/openai',
];

function topLevelHtml() {
  return fs.readdirSync(PUBLIC, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => e.name);
}

test('W225 #1 - sitemap.xml exists and is non-empty', () => {
  assert.ok(fs.existsSync(SITEMAP), 'public/sitemap.xml must exist');
  const stat = fs.statSync(SITEMAP);
  assert.ok(stat.size > 1000, `sitemap.xml too small (${stat.size} bytes)`);
});

test('W225 #2 - sitemap.xml parses as XML urlset with >= 100 url entries', () => {
  const raw = fs.readFileSync(SITEMAP, 'utf8');
  assert.match(raw, /<\?xml\s+version=/, 'must start with XML declaration');
  assert.match(raw, /<urlset\s+xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  const urlCount = (raw.match(/<url>/g) || []).length;
  assert.ok(urlCount >= 100, `expected >= 100 URLs, saw ${urlCount}`);
  const locCount = (raw.match(/<loc>/g) || []).length;
  assert.equal(urlCount, locCount, 'every <url> must have a <loc>');
});

test('W225 #3 - sitemap.xml excludes every W224 cut path', () => {
  const raw = fs.readFileSync(SITEMAP, 'utf8');
  for (const cut of W224_CUTS) {
    const re = new RegExp(`<loc>https://kolm\\.ai${cut.replace(/\//g, '\\/')}</loc>`);
    assert.ok(!re.test(raw),
      `sitemap.xml still lists cut path ${cut} — would advertise a 301 destination`);
  }
});

test('W225 #4 - sitemap.xml includes the high-priority canonical surfaces', () => {
  const raw = fs.readFileSync(SITEMAP, 'utf8');
  for (const p of ['/', '/product', '/captures', '/quickstart', '/models', '/pricing', '/enterprise', '/tui', '/runtimes', '/docs']) {
    const loc = p === '/' ? 'https://kolm.ai/' : `https://kolm.ai${p}`;
    assert.ok(raw.includes(`<loc>${loc}</loc>`),
      `sitemap missing canonical surface ${p} (expected <loc>${loc}</loc>)`);
  }
});

test('W225 #5 - robots.txt allows /, names Sitemap, blocks /v1/ and /admin', () => {
  const r = fs.readFileSync(ROBOTS, 'utf8');
  assert.match(r, /User-agent:\s*\*/);
  assert.match(r, /^Allow:\s*\/$/m);
  assert.match(r, /^Sitemap:\s*https:\/\/kolm\.ai\/sitemap\.xml/m);
  assert.match(r, /^Disallow:\s*\/v1\//m);
  assert.match(r, /^Disallow:\s*\/admin/m);
  assert.match(r, /^Disallow:\s*\/dashboard/m);
});

test('W225 #6 - every top-level public/*.html (except 404) has <link rel="canonical">', () => {
  const missing = [];
  for (const name of topLevelHtml()) {
    if (name === '404.html') continue;
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    if (!/rel=["']canonical["']/i.test(html)) missing.push(name);
  }
  assert.deepEqual(missing, [], `pages missing canonical: ${missing.join(', ')}`);
});

test('W225 #7 - every top-level public/*.html (except 404) has og:title + og:description + og:image + og:url + og:type', () => {
  const missing = { 'og:title': [], 'og:description': [], 'og:image': [], 'og:url': [], 'og:type': [] };
  for (const name of topLevelHtml()) {
    if (name === '404.html') continue;
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    for (const prop of Object.keys(missing)) {
      const re = new RegExp(`property=["']${prop.replace(':', '\\:')}["']`, 'i');
      if (!re.test(html)) missing[prop].push(name);
    }
  }
  for (const [prop, list] of Object.entries(missing)) {
    assert.deepEqual(list, [], `pages missing ${prop}: ${list.slice(0, 5).join(', ')}${list.length > 5 ? ' ...' : ''}`);
  }
});

test('W225 #8 - every top-level public/*.html (except 404) has at least one JSON-LD block', () => {
  const missing = [];
  for (const name of topLevelHtml()) {
    if (name === '404.html') continue;
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    if (!/application\/ld\+json/i.test(html)) missing.push(name);
  }
  assert.deepEqual(missing, [], `pages missing JSON-LD: ${missing.slice(0, 5).join(', ')}`);
});

test('W225 #9 - public/og/ directory contains >= 100 SVG OG cards', () => {
  const OG_DIR = path.join(PUBLIC, 'og');
  assert.ok(fs.existsSync(OG_DIR), 'public/og/ must exist');
  const svgs = fs.readdirSync(OG_DIR).filter((f) => f.endsWith('.svg'));
  assert.ok(svgs.length >= 100, `expected >= 100 OG SVGs, saw ${svgs.length}`);
  for (const f of svgs.slice(0, 5)) {
    const raw = fs.readFileSync(path.join(OG_DIR, f), 'utf8');
    assert.match(raw, /^<svg /m, `${f} should start with <svg>`);
    assert.match(raw, /viewBox="0 0 1200 630"/, `${f} should be 1200x630 (OG canonical)`);
  }
});

test('W225 #10 - sitemap, OG, and SEO-sweep scripts all exist and are runnable', () => {
  for (const f of ['build-sitemap.cjs', 'build-og.cjs', 'seo-sweep.cjs']) {
    const p = path.join(SCRIPTS, f);
    assert.ok(fs.existsSync(p), `scripts/${f} missing`);
    const raw = fs.readFileSync(p, 'utf8');
    assert.match(raw, /^#!\/usr\/bin\/env node|^\/\/ W225/, `scripts/${f} should be a node script`);
  }
});

test('W225 #11 - sw.js cache slug at or beyond wave 225', () => {
  const m = SW.match(/const CACHE = 'kolm-v7-[^']+-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE must follow the wave-N slug pattern');
  const waveN = parseInt(m[1], 10);
  assert.ok(waveN >= 225, `sw.js wave-slug must be >= 225 (saw ${waveN})`);
});

test('W225 #12 - index page JSON-LD declares Organization with kolm.ai URL', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim());
  assert.ok(blocks.length >= 1, 'index.html must have at least one JSON-LD block');
  let hasOrg = false;
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b);
      const arr = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
      for (const node of arr) {
        if (node['@type'] === 'Organization' &&
            (node.url === 'https://kolm.ai/' || node.url === 'https://kolm.ai')) {
          hasOrg = true;
        }
      }
    } catch (_) { /* skip non-parseable JSON-LD (some pages use comment-wrapped LD) */ }
  }
  assert.ok(hasOrg, 'index.html JSON-LD must include Organization with url=https://kolm.ai/');
});

test('W225 #13 - seo-sweep.cjs is idempotent (second run touches 0)', () => {
  // first run normalizes any drift; second run must touch nothing.
  const script = path.join(SCRIPTS, 'seo-sweep.cjs');
  spawnSync(process.execPath, [script], { encoding: 'utf8' });
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 0, `seo-sweep exit non-zero on second run: ${r.stderr}`);
  assert.match(r.stdout, /touched 0 of/,
    `seo-sweep must be idempotent; second run stdout: ${r.stdout}`);
});

test('W225 #14 - sitemap entries use the priority hint table (head pages > 0.8)', () => {
  const raw = fs.readFileSync(SITEMAP, 'utf8');
  // index.html "/" should have priority 1.0
  assert.match(raw,
    /<loc>https:\/\/kolm\.ai\/<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod><changefreq>weekly<\/changefreq><priority>1\.0<\/priority>/,
    'homepage must have priority 1.0');
});
