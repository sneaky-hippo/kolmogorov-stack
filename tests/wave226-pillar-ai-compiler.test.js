// Wave 226: SEO pillar /what-is-an-ai-compiler lock-in.
//
// W226 ships the categorical pillar that targets the head keyword "AI
// compiler" + long-tails "what is an ai compiler", "ai compiler tool",
// "compile your own ai model". Tests assert BEHAVIOR (page exists, has
// canonical/og/JSON-LD, word count floor, anchors hot, brand-disambig
// section present, rewrite wired, sitemap includes it) - not copy markers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PILLAR = path.join(PUBLIC, 'what-is-an-ai-compiler.html');
const SW = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const SITEMAP = fs.readFileSync(path.join(PUBLIC, 'sitemap.xml'), 'utf8');

const HTML = fs.readFileSync(PILLAR, 'utf8');

test('W226 #1 - pillar page exists at public/what-is-an-ai-compiler.html', () => {
  assert.ok(fs.existsSync(PILLAR), 'pillar page must exist');
  const stat = fs.statSync(PILLAR);
  assert.ok(stat.size > 15000, `pillar should be > 15 KB, was ${stat.size}`);
});

test('W226 #2 - word count >= 1800 (plan floor)', () => {
  const text = HTML
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const words = text.split(/\s+/).filter(Boolean);
  assert.ok(words.length >= 1800,
    `pillar should be >= 1800 words for SEO depth; was ${words.length}`);
});

test('W226 #3 - canonical URL points at /what-is-an-ai-compiler', () => {
  assert.match(HTML, /<link\s+rel="canonical"\s+href="https:\/\/kolm\.ai\/what-is-an-ai-compiler">/);
});

test('W226 #4 - all 5 og:* meta tags present and reference the pillar', () => {
  for (const prop of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) {
    const re = new RegExp(`property="${prop.replace(':', '\\:')}"`);
    assert.match(HTML, re, `missing ${prop}`);
  }
  assert.match(HTML, /property="og:url"\s+content="https:\/\/kolm\.ai\/what-is-an-ai-compiler"/);
});

test('W226 #5 - JSON-LD includes Article + BreadcrumbList + FAQPage', () => {
  const m = HTML.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, 'JSON-LD block must exist');
  const parsed = JSON.parse(m[1]);
  const graph = parsed['@graph'] || [parsed];
  const types = graph.map((n) => n['@type']);
  for (const t of ['Article', 'BreadcrumbList', 'FAQPage']) {
    assert.ok(types.includes(t), `JSON-LD must include ${t}; saw ${types.join(',')}`);
  }
});

test('W226 #6 - FAQPage has >= 5 questions including brand-disambig', () => {
  const m = HTML.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/);
  const parsed = JSON.parse(m[1]);
  const graph = parsed['@graph'] || [parsed];
  const faq = graph.find((n) => n['@type'] === 'FAQPage');
  assert.ok(faq, 'FAQPage entry must exist in @graph');
  assert.ok(faq.mainEntity.length >= 5,
    `FAQPage should carry >= 5 Question entries; saw ${faq.mainEntity.length}`);
  const names = faq.mainEntity.map((q) => q.name).join(' ');
  assert.match(names, /Kolm therapeutics|Kolm band|Petter Kolm/,
    'FAQPage must include a brand-disambig question');
});

test('W226 #7 - vercel.json has rewrite /what-is-an-ai-compiler -> /what-is-an-ai-compiler.html', () => {
  const rw = VERCEL.rewrites.find((r) => r.source === '/what-is-an-ai-compiler');
  assert.ok(rw, 'rewrite for /what-is-an-ai-compiler must exist');
  assert.equal(rw.destination, '/what-is-an-ai-compiler.html');
});

test('W226 #8 - sitemap.xml includes the pillar URL with priority >= 0.7', () => {
  const re = /<loc>https:\/\/kolm\.ai\/what-is-an-ai-compiler<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod><changefreq>weekly<\/changefreq><priority>(0\.[789]|1\.0)<\/priority>/;
  assert.match(SITEMAP, re, 'pillar must appear in sitemap with priority >= 0.7');
});

test('W226 #9 - sw.js cache slug wave-floor >= 226', () => {
  const m = SW.match(/const CACHE = 'kolm-v7-[^']+-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE must follow wave-N slug pattern');
  const waveN = parseInt(m[1], 10);
  assert.ok(waveN >= 226, `sw.js wave-slug must be >= 226 (saw ${waveN})`);
});

test('W226 #10 - pillar names "AI compiler" in the H1 (head keyword in primary heading)', () => {
  const h1 = HTML.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  assert.ok(h1, 'must have an H1');
  assert.match(h1[1], /AI compiler/i, 'H1 must contain "AI compiler"');
});

test('W226 #11 - pillar has >= 8 section <h2> anchors (TOC-grade depth)', () => {
  const h2s = HTML.match(/<h2[^>]*>/g) || [];
  assert.ok(h2s.length >= 8,
    `pillar should have >= 8 <h2> sections; saw ${h2s.length}`);
});

test('W226 #12 - cross-links to /product, /quickstart, /captures, /models, /compare, /drift, /runtimes, /spec/rs-1, /format/v2 present', () => {
  for (const href of ['/product', '/quickstart', '/captures', '/models', '/compare', '/drift', '/runtimes', '/spec/rs-1', '/format/v2']) {
    const re = new RegExp(`href="${href.replace(/\//g, '\\/')}"`);
    assert.match(HTML, re, `pillar must cross-link to ${href}`);
  }
});

test('W226 #13 - brand-disambig section names Kolm therapeutics + Kolm band + Petter Kolm + kolm.ai', () => {
  for (const name of ['Kolm therapeutics', 'Kolm band', 'Petter Kolm', 'kolm.ai']) {
    assert.ok(HTML.includes(name),
      `pillar brand-disambig must mention "${name}"`);
  }
});

test('W226 #14 - no em-dashes in load-bearing prose (W210 hygiene)', () => {
  const count = (HTML.match(/—/g) || []).length;
  assert.equal(count, 0, `pillar must have 0 em-dashes; saw ${count}`);
});

test('W226 #15 - no emoji in pillar (W210 hygiene)', () => {
  // Strip SVG/script/style to avoid false positives from inline icon font glyphs
  const stripped = HTML
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '');
  const emoji = stripped.match(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu) || [];
  assert.equal(emoji.length, 0,
    `pillar must have 0 emoji in prose; saw ${emoji.length}: ${emoji.slice(0,5).join('')}`);
});
