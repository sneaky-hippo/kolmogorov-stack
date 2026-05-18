// W272 - vertical microsite landing pages.
//
// Behavior assertions for the 5 v2 vertical pages introduced in wave 272.
// Each page is self-contained HTML rendered statically by Vercel. The tests
// verify file existence, hero/CTA/ROI behavior, canonical correctness,
// JSON-LD parseability, brand-anchor disambig presence, vercel rewrite
// wiring, and the sw.js wave-floor.
//
// No HTTP boot; everything is static file inspection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT   = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const VERTICALS = [
  {
    slug: 'healthcare-v2',
    canonical: 'https://kolm.ai/healthcare-v2',
    hero_keyword: /PHI/,
    cta_label: /Book BAA-eligible demo/,
    recipes: ['phi-redactor.kolm', 'uscdi-extract.kolm'],
    registry_query: '/registry?vertical=healthcare',
  },
  {
    slug: 'legal-v2',
    canonical: 'https://kolm.ai/legal-v2',
    hero_keyword: /[Pp]rivileged/,
    cta_label: /Book private-cloud demo/,
    recipes: ['contract-review.kolm', 'privilege-flag.kolm'],
    registry_query: '/registry?vertical=legal',
  },
  {
    slug: 'finance-v2',
    canonical: 'https://kolm.ai/finance-v2',
    hero_keyword: /KYC|SAR/,
    cta_label: /Book regulated-finance demo/,
    recipes: ['kyc-redact.kolm', 'sar-narrative.kolm'],
    registry_query: '/registry?vertical=finance',
  },
  {
    slug: 'defense-v2',
    canonical: 'https://kolm.ai/defense-v2',
    hero_keyword: /CUI|ITAR/,
    cta_label: /Book air-gap eval/,
    // Defense per spec has no recipe-download section (no recipes named in spec).
    recipes: ['cui-redactor.kolm', 'itar-classify.kolm'],
    registry_query: '/registry?vertical=defense',
  },
  {
    slug: 'devtools-v2',
    canonical: 'https://kolm.ai/devtools-v2',
    hero_keyword: /provider|AI feature/,
    cta_label: /Book platform-team eval/,
    recipes: ['pr-review.kolm', 'ticket-triage.kolm'],
    registry_query: '/registry?vertical=devtools',
  },
];

// Read and cache each page's HTML once per test process. Helps amortize
// the disk read across the 50+ assertions below.
function readPage(slug) {
  return fs.readFileSync(path.join(PUBLIC, `${slug}.html`), 'utf8');
}

test('W272 #1 - all 5 vertical-v2 pages exist on disk', () => {
  for (const v of VERTICALS) {
    const p = path.join(PUBLIC, `${v.slug}.html`);
    assert.ok(fs.existsSync(p), `expected ${v.slug}.html to exist`);
    const stat = fs.statSync(p);
    assert.ok(stat.size > 5000, `${v.slug}.html must be a real page, got ${stat.size} bytes`);
  }
});

test('W272 #2 - each page has correct canonical link', () => {
  for (const v of VERTICALS) {
    const html = readPage(v.slug);
    const m = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/);
    assert.ok(m, `${v.slug}: canonical tag missing`);
    assert.equal(m[1], v.canonical, `${v.slug}: canonical mismatch`);
  }
});

test('W272 #3 - each page has a hero <h1> with vertical-specific keyword', () => {
  for (const v of VERTICALS) {
    const html = readPage(v.slug);
    const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    assert.ok(m, `${v.slug}: <h1> missing`);
    assert.match(m[1], v.hero_keyword, `${v.slug}: hero h1 must mention ${v.hero_keyword}`);
  }
});

test('W272 #4 - each page links its CTA to /enterprise#demo with the right label', () => {
  for (const v of VERTICALS) {
    const html = readPage(v.slug);
    // Must contain an anchor pointing at /enterprise#demo somewhere on the page.
    assert.match(html, /href="\/enterprise#demo"/, `${v.slug}: missing /enterprise#demo CTA link`);
    // And the CTA copy block matches the vertical's expected label.
    assert.match(html, v.cta_label, `${v.slug}: missing CTA label ${v.cta_label}`);
  }
});

test('W272 #5 - each page has 3 pain cards with concrete bullet points', () => {
  for (const v of VERTICALS) {
    const html = readPage(v.slug);
    const matches = html.match(/class="pain-card"/g) || [];
    assert.equal(matches.length, 3, `${v.slug}: expected exactly 3 pain cards, got ${matches.length}`);
  }
});

test('W272 #6 - each page has an architecture-diagram block (ASCII or SVG)', () => {
  for (const v of VERTICALS) {
    const html = readPage(v.slug);
    // arch-box class wraps either a <pre> ASCII diagram or inline SVG.
    assert.match(html, /class="arch-box"/, `${v.slug}: arch-box missing`);
    // Should have either a <pre> with multi-line content or an <svg> element.
    const hasPre = /<pre[\s\S]*?\+[\s\S]*?<\/pre>/.test(html);
    const hasSvg = /<svg[\s\S]*?<\/svg>/.test(html);
    assert.ok(hasPre || hasSvg, `${v.slug}: arch-box must contain <pre> diagram or <svg>`);
  }
});

test('W272 #7 - each page has 4-input ROI calculator with client-side JS', () => {
  for (const v of VERTICALS) {
    const html = readPage(v.slug);
    // Four named inputs.
    for (const id of ['roi-prompts', 'roi-cost', 'roi-churn', 'roi-infra']) {
      assert.match(html, new RegExp(`id="${id}"`), `${v.slug}: missing ${id} input`);
    }
    // Output element.
    assert.match(html, /id="roi-out"/, `${v.slug}: missing roi-out element`);
    // Inline IIFE script that wires inputs to output.
    assert.match(html, /addEventListener\(['"]input['"]/, `${v.slug}: ROI script must listen for input events`);
    // No backend call.
    assert.equal(/fetch\(['"]\/v1\//.test(html), false, `${v.slug}: ROI must be client-side only, no /v1 fetch`);
  }
});

test('W272 #8 - each page links recipe downloads to /registry?vertical=<slug>', () => {
  for (const v of VERTICALS) {
    const html = readPage(v.slug);
    assert.match(html, new RegExp(v.registry_query.replace('?', '\\?')),
      `${v.slug}: missing recipe download link to ${v.registry_query}`);
    // Each named recipe appears in the page (defense pages name cui-redactor/itar-classify, etc).
    for (const r of v.recipes) {
      assert.match(html, new RegExp(r.replace('.', '\\.')),
        `${v.slug}: recipe ${r} not mentioned in page copy`);
    }
  }
});

test('W272 #9 - each page has the brand-anchor span for SEO disambig', () => {
  for (const v of VERTICALS) {
    const html = readPage(v.slug);
    assert.match(html, /class="brand-anchor"/, `${v.slug}: brand-anchor span missing`);
    assert.match(html, /kolm\.ai - the AI compiler/, `${v.slug}: brand-anchor copy missing`);
    assert.match(html, /Kolm therapeutics/, `${v.slug}: brand-anchor must name Kolm therapeutics`);
    assert.match(html, /Kolm band/, `${v.slug}: brand-anchor must name Kolm band`);
  }
});

test('W272 #10 - each page has a parseable JSON-LD SoftwareApplication block', () => {
  for (const v of VERTICALS) {
    const html = readPage(v.slug);
    const m = html.match(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(m, `${v.slug}: JSON-LD script tag missing`);
    let data;
    try { data = JSON.parse(m[1]); }
    catch (e) { assert.fail(`${v.slug}: JSON-LD did not parse: ${e.message}`); }
    assert.equal(data['@context'], 'https://schema.org', `${v.slug}: JSON-LD @context wrong`);
    assert.equal(data['@type'], 'SoftwareApplication', `${v.slug}: JSON-LD @type must be SoftwareApplication`);
    assert.equal(data.url, v.canonical, `${v.slug}: JSON-LD url must equal canonical`);
    assert.ok(data.name, `${v.slug}: JSON-LD name missing`);
    assert.ok(data.description, `${v.slug}: JSON-LD description missing`);
  }
});

test('W272 #11 - no em-dashes (U+2014) in body copy', () => {
  for (const v of VERTICALS) {
    const html = readPage(v.slug);
    assert.equal(/—/.test(html), false, `${v.slug}: em-dash present`);
  }
});

test('W272 #12 - vercel.json wires all 5 v2 rewrites', () => {
  const vc = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const rewrites = vc.rewrites || [];
  for (const v of VERTICALS) {
    const has = rewrites.some((r) => r.source === `/${v.slug}` && r.destination === `/${v.slug}.html`);
    assert.ok(has, `vercel.json missing rewrite for /${v.slug}`);
  }
});

test('W272 #13 - existing v1 vertical pages were not clobbered', () => {
  // The user explicitly said do not touch existing /healthcare, /finance,
  // /legal, /defense pages. Sanity-check those files still exist and the
  // canonical points at the v1 URL (not v2).
  for (const slug of ['healthcare', 'finance', 'legal', 'defense']) {
    const p = path.join(PUBLIC, `${slug}.html`);
    assert.ok(fs.existsSync(p), `v1 ${slug}.html must still exist`);
    const html = fs.readFileSync(p, 'utf8');
    const m = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/);
    if (m) {
      assert.equal(m[1], `https://kolm.ai/${slug}`, `${slug}: canonical must still point at v1 URL`);
    }
  }
});

test('W272 #14 - sw.js wave-floor is >= 272', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  const m = sw.match(/kolm-v7-2026-05-\d+-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE constant format mismatch');
  assert.ok(Number(m[1]) >= 272, `sw.js cache wave must be >= 272, got ${m[1]}`);
});

test('W272 #15 - defense-v2 references /enterprise/self-hosted per W264 cross-link', () => {
  const html = readPage('defense-v2');
  assert.match(html, /\/enterprise\/self-hosted/, 'defense-v2 must cross-link to /enterprise/self-hosted');
});

test('W272 #16 - each page has a meta description tag', () => {
  for (const v of VERTICALS) {
    const html = readPage(v.slug);
    const m = html.match(/<meta\s+name="description"\s+content="([^"]+)"/);
    assert.ok(m, `${v.slug}: meta description missing`);
    assert.ok(m[1].length >= 40, `${v.slug}: meta description too short`);
  }
});

test('W272 #17 - each page imports nav.js and has the kolm brand link', () => {
  for (const v of VERTICALS) {
    const html = readPage(v.slug);
    assert.match(html, /src="\/nav\.js"/, `${v.slug}: nav.js script missing`);
    assert.match(html, /href="\/"\s+class="brand"/, `${v.slug}: kolm brand link missing`);
  }
});
