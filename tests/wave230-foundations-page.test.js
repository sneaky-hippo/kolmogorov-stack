// W230 — /foundations integration page + 5 recipe pages.
// Assertions are about file existence, structure, cross-linkage, JSON-LD,
// the W221 5-anchor nav, the W225 SEO infra (sitemap + sw.js wave-floor +
// vercel rewrites + per-page OG cards), and skip-to-content a11y.
//
// Behavior over copy: assertions key off structural facts (rewrite present,
// canonical URL set, JSON-LD types present, cross-link href present) rather
// than marketing prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const RECIPES = ['tailscale', 'termius', 'tmux', 'git', 'scripts'];
const HUB = path.join(PUBLIC, 'foundations.html');
const RECIPE_FILES = RECIPES.map((s) => path.join(PUBLIC, 'foundations', `${s}.html`));

function read(p) { return fs.readFileSync(p, 'utf8'); }

test('W230 hub page exists', () => {
  assert.ok(fs.existsSync(HUB), 'public/foundations.html must exist');
  const html = read(HUB);
  assert.ok(html.length > 4000, 'hub page should be substantive');
});

test('W230 all 5 recipe files exist', () => {
  for (const f of RECIPE_FILES) {
    assert.ok(fs.existsSync(f), `${f} must exist`);
    assert.ok(read(f).length > 3500, `${f} should be substantive`);
  }
});

test('W230 hub has canonical pointing at /foundations', () => {
  const html = read(HUB);
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/foundations">/);
});

test('W230 each recipe has canonical pointing at its own URL', () => {
  for (const slug of RECIPES) {
    const html = read(path.join(PUBLIC, 'foundations', `${slug}.html`));
    const re = new RegExp(`<link rel="canonical" href="https://kolm\\.ai/foundations/${slug}">`);
    assert.match(html, re, `${slug} canonical must be /foundations/${slug}`);
  }
});

test('W230 hub has JSON-LD Article + BreadcrumbList', () => {
  const html = read(HUB);
  assert.match(html, /"@type":\s*"Article"/);
  assert.match(html, /"@type":\s*"BreadcrumbList"/);
});

test('W230 each recipe has JSON-LD Article + BreadcrumbList with 3-level breadcrumb', () => {
  for (const slug of RECIPES) {
    const html = read(path.join(PUBLIC, 'foundations', `${slug}.html`));
    assert.match(html, /"@type":\s*"Article"/, `${slug} missing Article JSON-LD`);
    assert.match(html, /"@type":\s*"BreadcrumbList"/, `${slug} missing BreadcrumbList JSON-LD`);
    assert.match(html, /"position":\s*3/, `${slug} breadcrumb should reach position 3`);
  }
});

test('W230 each recipe cross-links to all 4 sibling recipes', () => {
  for (const slug of RECIPES) {
    const html = read(path.join(PUBLIC, 'foundations', `${slug}.html`));
    const siblings = RECIPES.filter((s) => s !== slug);
    for (const sib of siblings) {
      const re = new RegExp(`href="/foundations/${sib}"`);
      assert.match(html, re, `${slug} must link to sibling /foundations/${sib}`);
    }
  }
});

test('W230 hub links to all 5 recipes', () => {
  const html = read(HUB);
  for (const slug of RECIPES) {
    const re = new RegExp(`href="/foundations/${slug}"`);
    assert.match(html, re, `hub must link to /foundations/${slug}`);
  }
});

test('W230 every page links back up to /foundations', () => {
  for (const slug of RECIPES) {
    const html = read(path.join(PUBLIC, 'foundations', `${slug}.html`));
    assert.match(html, /href="\/foundations"/, `${slug} must link back to /foundations`);
  }
});

test('W230 hub uses W221 5-anchor canonical nav', () => {
  const html = read(HUB);
  for (const anchor of ['Product', 'Models', 'Docs', 'Pricing', 'Enterprise']) {
    assert.match(html, new RegExp(`>${anchor}<`), `hub nav missing ${anchor}`);
  }
});

test('W230 every page has skip-to-content a11y link', () => {
  const all = [HUB, ...RECIPE_FILES];
  for (const f of all) {
    const html = read(f);
    assert.match(html, /Skip to content/, `${path.basename(f)} missing skip-to-content`);
    assert.match(html, /id="main"/, `${path.basename(f)} missing #main target`);
  }
});

test('W230 vercel rewrites for /foundations and 5 recipe routes', () => {
  const v = JSON.parse(read(path.join(ROOT, 'vercel.json')));
  const sources = v.rewrites.map((r) => r.source);
  assert.ok(sources.includes('/foundations'), 'missing /foundations rewrite');
  for (const slug of RECIPES) {
    assert.ok(sources.includes(`/foundations/${slug}`), `missing /foundations/${slug} rewrite`);
  }
});

test('W230 sw.js cache slug wave-floor >= 230', () => {
  const sw = read(path.join(PUBLIC, 'sw.js'));
  const m = sw.match(/const CACHE = 'kolm-v\d+-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE slug must follow wave naming');
  const n = parseInt(m[1], 10);
  assert.ok(n >= 230, `expected wave >= 230, got ${n}`);
});

test('W230 sitemap.xml includes all 6 foundations URLs', () => {
  const sm = read(path.join(PUBLIC, 'sitemap.xml'));
  assert.match(sm, /https:\/\/kolm\.ai\/foundations<\/loc>/, 'sitemap missing /foundations');
  for (const slug of RECIPES) {
    const re = new RegExp(`https:\\/\\/kolm\\.ai\\/foundations\\/${slug}<\\/loc>`);
    assert.match(sm, re, `sitemap missing /foundations/${slug}`);
  }
});

test('W230 each page references its per-page OG card under /og/foundations-*.svg', () => {
  for (const slug of RECIPES) {
    const html = read(path.join(PUBLIC, 'foundations', `${slug}.html`));
    const re = new RegExp(`/og/foundations-${slug}\\.svg`);
    assert.match(html, re, `${slug} must reference /og/foundations-${slug}.svg`);
  }
  const hubHtml = read(HUB);
  assert.match(hubHtml, /\/og\/foundations\.svg/, 'hub must reference /og/foundations.svg');
});

test('W230 OG SVG files exist for all 6 pages', () => {
  const og = path.join(PUBLIC, 'og');
  assert.ok(fs.existsSync(path.join(og, 'foundations.svg')), 'foundations.svg missing');
  for (const slug of RECIPES) {
    assert.ok(fs.existsSync(path.join(og, `foundations-${slug}.svg`)), `foundations-${slug}.svg missing`);
  }
});

test('W230 each recipe references one of the 4 native verbs from W229', () => {
  // tailscale + git → kolm sync; termius → kolm tail; tmux → kolm watch; scripts → kolm profile / doctor
  const verbCheck = {
    tailscale: /kolm sync/,
    termius:   /kolm tail captures/,
    tmux:      /kolm watch/,
    git:       /kolm sync/,
    scripts:   /kolm (profile|doctor)/,
  };
  for (const [slug, re] of Object.entries(verbCheck)) {
    const html = read(path.join(PUBLIC, 'foundations', `${slug}.html`));
    assert.match(html, re, `${slug} must reference its native verb`);
  }
});

test('W230 hub matrix names all 5 stack tools', () => {
  const html = read(HUB);
  for (const tool of ['Tailscale', 'Termius', 'tmux', 'git', 'script']) {
    assert.match(html, new RegExp(tool), `hub missing tool ${tool}`);
  }
});

test('W230 brand-disambig: every page title ends with · kolm.ai', () => {
  const all = [HUB, ...RECIPE_FILES];
  for (const f of all) {
    const html = read(f);
    const m = html.match(/<title>([^<]+)<\/title>/);
    assert.ok(m, `${path.basename(f)} has no <title>`);
    assert.match(m[1], /·\s*kolm\.ai\s*$/, `${path.basename(f)} title must end with · kolm.ai`);
  }
});
