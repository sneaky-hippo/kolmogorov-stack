// Wave 301 — /value-loop public page documenting the 5-rung ladder.
//
// W298 shipped `kolm loop`; W300 made it discoverable; W301 is the public
// surface that documents what each rung does, what HTTP endpoint it hits,
// and what receipt it returns. Asserts behavior + structure, not page copy
// (per Pablo correction).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.resolve(__dirname, '..', 'public', 'value-loop.html');
const VERCEL = path.resolve(__dirname, '..', 'vercel.json');
const SW = path.resolve(__dirname, '..', 'public', 'sw.js');
const SITEMAP = path.resolve(__dirname, '..', 'public', 'sitemap.xml');

const html = fs.readFileSync(PAGE, 'utf8');

test('W301 #1 — public/value-loop.html exists and is non-trivial', () => {
  assert.ok(fs.existsSync(PAGE), 'value-loop.html must exist in public/');
  assert.ok(html.length > 4000, `page should be substantial; got ${html.length} bytes`);
});

test('W301 #2 — canonical URL + brand-suffixed title + kolm.ai anchor', () => {
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/value-loop">/);
  assert.match(html, /<title>[^<]*· kolm\.ai<\/title>/);
});

test('W301 #3 — references every HTTP endpoint that makes up the loop', () => {
  for (const endpoint of [
    '/v1/capture/log',
    '/v1/capture/health',
    '/v1/bridges/observations',
    '/v1/distill/from-captures',
    '/v1/replay',
  ]) {
    assert.ok(html.includes(endpoint), `value-loop page must reference ${endpoint}`);
  }
});

test('W301 #4 — names the kolm CLI verb that runs the loop', () => {
  assert.match(html, /kolm loop/);
  assert.match(html, /kolm doctor --loop/);
});

test('W301 #5 — names the W212 durable receipt header that gates rung 1', () => {
  assert.match(html, /x-kolm-capture-durable/);
});

test('W301 #6 — covers all 5 rungs with anchor IDs for in-page navigation', () => {
  for (const id of ['id="capture"', 'id="health"', 'id="bridges"', 'id="distill"', 'id="replay"']) {
    assert.ok(html.includes(id), `value-loop page must include anchor ${id}`);
  }
});

test('W301 #7 — JSON-LD includes Article + HowTo + BreadcrumbList', () => {
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ld, 'JSON-LD block must exist');
  const parsed = JSON.parse(ld[1]);
  const types = parsed['@graph'].map(g => g['@type']);
  assert.ok(types.includes('Article'), 'JSON-LD must include Article');
  assert.ok(types.includes('HowTo'), 'JSON-LD must include HowTo for the 5-rung sequence');
  assert.ok(types.includes('BreadcrumbList'), 'JSON-LD must include BreadcrumbList');
  const howto = parsed['@graph'].find(g => g['@type'] === 'HowTo');
  assert.equal(howto.step.length, 5, 'HowTo must have 5 steps (one per rung)');
});

test('W301 #8 — vercel.json rewrites /value-loop to /value-loop.html', () => {
  const vercel = JSON.parse(fs.readFileSync(VERCEL, 'utf8'));
  const found = (vercel.rewrites || []).some(r => r.source === '/value-loop' && r.destination === '/value-loop.html');
  assert.ok(found, 'vercel.json must rewrite /value-loop → /value-loop.html');
});

test('W301 #9 — sw.js cache bumped to wave301 slug', () => {
  const sw = fs.readFileSync(SW, 'utf8');
  const m = sw.match(/const CACHE = 'kolm-v7-2026-05-18-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a versioned CACHE constant');
  assert.ok(Number(m[1]) >= 301, `sw.js CACHE wave must be >= 301; got ${m[1]}`);
});

test('W301 #10 — sitemap.xml includes /value-loop', () => {
  const sm = fs.readFileSync(SITEMAP, 'utf8');
  assert.match(sm, /<loc>https:\/\/kolm\.ai\/value-loop<\/loc>/);
});

test('W301 #11 — 5-anchor W221 nav is intact (Product/Models/Docs/Pricing/Enterprise)', () => {
  for (const a of ['/product', '/models', '/docs', '/pricing', '/enterprise']) {
    assert.ok(html.includes(`href="${a}"`), `nav must include href="${a}"`);
  }
});

test('W301 #12 — links to related surfaces in Related section', () => {
  for (const link of ['/what-is-an-ai-compiler', '/captures', '/docs/cli', '/spec/rs-1', '/foundations']) {
    assert.ok(html.includes(`href="${link}"`), `Related section must link to ${link}`);
  }
});

test('W301 #13 — page is em-dash budget compliant (W205 ≤1)', () => {
  const emDashes = (html.match(/—/g) || []).length;
  assert.ok(emDashes <= 1, `page must have ≤1 em-dash; got ${emDashes}`);
});

test('W301 #14 — brand-disambig footer link to /articles/kolm-ai-vs-kolm-therapeutics', () => {
  assert.match(html, /href="\/articles\/kolm-ai-vs-kolm-therapeutics"/);
});
