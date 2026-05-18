// W274 - 5 new comparison pages: kolm vs OpenPipe (post-CoreWeave 2026),
// Predibase + Rubrik (post-acquisition 2026), Together AI (2026),
// AWS Bedrock model distillation, and Proxis (YC W26).
//
// Behavior assertions for: existence, hero positioning, >= 8 axis matrix rows,
// "when X is the right answer" section, brand-anchor span, canonical URL,
// JSON-LD payload, vercel.json rewrites, sw.js cache floor, no em-dash in body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMPARE_DIR = path.join(ROOT, 'public', 'compare');

const PAGES = [
  {
    file: 'kolm-vs-openpipe-2026.html',
    slug: '/compare/kolm-vs-openpipe-2026',
    rightAnswerOf: 'OpenPipe',
    competitorMentions: ['OpenPipe', 'CoreWeave'],
    minMatrixRows: 8,
  },
  {
    file: 'kolm-vs-predibase-2026.html',
    slug: '/compare/kolm-vs-predibase-2026',
    rightAnswerOf: 'Predibase',
    competitorMentions: ['Predibase', 'Rubrik'],
    minMatrixRows: 8,
  },
  {
    file: 'kolm-vs-together-2026.html',
    slug: '/compare/kolm-vs-together-2026',
    rightAnswerOf: 'Together',
    competitorMentions: ['Together'],
    minMatrixRows: 8,
  },
  {
    file: 'kolm-vs-bedrock-distill.html',
    slug: '/compare/kolm-vs-bedrock-distill',
    rightAnswerOf: 'AWS Bedrock',
    competitorMentions: ['Bedrock', 'AWS'],
    minMatrixRows: 8,
  },
  {
    file: 'kolm-vs-proxis.html',
    slug: '/compare/kolm-vs-proxis',
    rightAnswerOf: 'Proxis',
    competitorMentions: ['Proxis'],
    minMatrixRows: 8,
  },
];

function readPage(file) {
  return fs.readFileSync(path.join(COMPARE_DIR, file), 'utf8');
}

function countMatrixRows(html) {
  // Count <tr> rows inside the <tbody> of the matrix tables (excluding the header thead row).
  const tbodyMatches = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)];
  let total = 0;
  for (const m of tbodyMatches) {
    const rows = m[1].match(/<tr[\s>]/g);
    if (rows) total += rows.length;
  }
  return total;
}

function bodyText(html) {
  // Strip <head>...</head>, then strip tags so we look only at visible body copy.
  const noHead = html.replace(/<head[\s\S]*?<\/head>/i, '');
  return noHead.replace(/<[^>]+>/g, ' ');
}

for (const page of PAGES) {
  test(`W274 ${page.file} exists`, () => {
    const fp = path.join(COMPARE_DIR, page.file);
    assert.ok(fs.existsSync(fp), `${page.file} missing`);
    const stat = fs.statSync(fp);
    assert.ok(stat.size > 8000, `${page.file} too small (${stat.size} bytes)`);
  });

  test(`W274 ${page.file} canonical URL points to ${page.slug}`, () => {
    const html = readPage(page.file);
    const re = new RegExp(`<link rel="canonical" href="https://kolm\\.ai${page.slug}"`);
    assert.match(html, re, `canonical for ${page.slug} not found`);
  });

  test(`W274 ${page.file} has hero with H1 and lede`, () => {
    const html = readPage(page.file);
    assert.match(html, /<section class="hero">/, 'hero section missing');
    assert.match(html, /<h1>[^<]+kolm[^<]*<\/h1>/i, 'hero h1 missing or not branded');
    assert.match(html, /<p class="lede">/, 'lede missing');
  });

  test(`W274 ${page.file} has axis matrix with >= ${page.minMatrixRows} rows`, () => {
    const html = readPage(page.file);
    assert.match(html, /<table class="matrix">/, 'matrix table missing');
    const n = countMatrixRows(html);
    assert.ok(
      n >= page.minMatrixRows,
      `${page.file} has only ${n} matrix rows, need >= ${page.minMatrixRows}`,
    );
  });

  test(`W274 ${page.file} matrix has kolm column highlighted`, () => {
    const html = readPage(page.file);
    // td.kolm class used for the kolm-column cell; ensure at least minMatrixRows occurrences.
    const kolmCells = html.match(/<td class="kolm">/g) || [];
    assert.ok(
      kolmCells.length >= page.minMatrixRows,
      `${page.file} kolm-column cells (${kolmCells.length}) < matrix rows`,
    );
  });

  test(`W274 ${page.file} has "When ${page.rightAnswerOf} is the right answer" section`, () => {
    const html = readPage(page.file);
    const re = new RegExp(`When\\s+${page.rightAnswerOf.replace(/[+\s]/g, '\\s+')}[^<]*is the right answer`, 'i');
    assert.match(html, re, `'When ${page.rightAnswerOf} is the right answer' heading missing`);
  });

  test(`W274 ${page.file} has "When kolm is the right answer" honesty mirror`, () => {
    const html = readPage(page.file);
    // Allow either "When kolm is the right answer" or "When kolm + X is the right shape" framings.
    assert.match(html, /When kolm[\s\S]{0,80}is the right (answer|shape)/i, 'kolm-side honesty section missing');
  });

  test(`W274 ${page.file} mentions ${page.competitorMentions.join(' + ')} multiple times`, () => {
    const html = readPage(page.file);
    for (const term of page.competitorMentions) {
      const re = new RegExp(term, 'g');
      const hits = (html.match(re) || []).length;
      assert.ok(hits >= 3, `${term} appears only ${hits} times in ${page.file}, expected >= 3`);
    }
  });

  test(`W274 ${page.file} has brand-anchor disambiguation span`, () => {
    const html = readPage(page.file);
    assert.match(html, /<span class="brand-anchor"[^>]*>/, 'brand-anchor span missing');
    assert.match(html, /Kolm therapeutics/, 'brand-anchor body missing therapeutics disambiguation');
  });

  test(`W274 ${page.file} ships JSON-LD with Article + BreadcrumbList`, () => {
    const html = readPage(page.file);
    assert.match(html, /<script type="application\/ld\+json">/, 'JSON-LD script missing');
    const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(ldMatch, 'JSON-LD payload not extractable');
    const ld = JSON.parse(ldMatch[1]);
    assert.equal(ld['@context'], 'https://schema.org');
    assert.ok(Array.isArray(ld['@graph']), 'JSON-LD @graph not present');
    const types = ld['@graph'].map(n => n['@type']);
    assert.ok(types.includes('Article'), 'Article node missing in JSON-LD');
    assert.ok(types.includes('BreadcrumbList'), 'BreadcrumbList node missing in JSON-LD');
  });

  test(`W274 ${page.file} body copy ships zero em-dashes (mdash)`, () => {
    const html = readPage(page.file);
    const body = bodyText(html);
    // Forbid both the literal U+2014 and the &mdash; entity in visible body text.
    assert.ok(!body.includes('—'), `${page.file} body contains literal em-dash U+2014`);
    assert.ok(!body.includes('&mdash;'), `${page.file} body contains &mdash; entity in visible copy`);
  });

  test(`W274 ${page.file} ships header nav + footer cross-links`, () => {
    const html = readPage(page.file);
    assert.match(html, /<header class="site">/, 'site header missing');
    assert.match(html, /<footer class="site">/, 'site footer missing');
    assert.match(html, /\/compare/, 'cross-link to /compare missing');
  });

  test(`W274 ${page.file} has at least one cross-link to a sibling W274 page`, () => {
    const html = readPage(page.file);
    const siblings = PAGES.filter(p => p.file !== page.file).map(p => p.slug);
    const hits = siblings.filter(s => html.includes(s));
    assert.ok(hits.length >= 1, `${page.file} has no cross-link to a sibling W274 page`);
  });
}

test('W274 vercel.json contains explicit rewrites for all 5 pages', () => {
  const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const rewrites = vj.rewrites || [];
  for (const page of PAGES) {
    const found = rewrites.some(
      r => r.source === page.slug && r.destination === `${page.slug}.html`,
    );
    assert.ok(found, `vercel.json rewrite missing for ${page.slug}`);
  }
});

test('W274 vercel.json catch-all /compare/(.*) still present', () => {
  const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const rewrites = vj.rewrites || [];
  const catchAll = rewrites.find(r => r.source === '/compare/(.*)' && r.destination === '/compare/$1.html');
  assert.ok(catchAll, '/compare/(.*) catch-all rewrite missing');
});

test('W274 sw.js cache slug is at or past wave274 floor', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const m = sw.match(/const CACHE = 'kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)/);
  assert.ok(m, 'sw.js CACHE constant not parseable');
  const wave = parseInt(m[1], 10);
  assert.ok(wave >= 274, `sw.js wave=${wave} is below W274 floor`);
});

test('W274 does not clobber existing /public/compare/kolm-vs-openpipe.html', () => {
  // The original (pre-acquisition) OpenPipe page must still exist untouched.
  const old = path.join(COMPARE_DIR, 'kolm-vs-openpipe.html');
  assert.ok(fs.existsSync(old), 'existing kolm-vs-openpipe.html must remain');
});

test('W274 does not clobber existing /public/compare/kolm-vs-predibase.html', () => {
  const old = path.join(COMPARE_DIR, 'kolm-vs-predibase.html');
  assert.ok(fs.existsSync(old), 'existing kolm-vs-predibase.html must remain');
});

test('W274 does not clobber existing /public/compare/kolm-vs-together.html', () => {
  const old = path.join(COMPARE_DIR, 'kolm-vs-together.html');
  assert.ok(fs.existsSync(old), 'existing kolm-vs-together.html must remain');
});

test('W274 does not clobber /public/how-vs-predibase.html (different template surface)', () => {
  const old = path.join(ROOT, 'public', 'how-vs-predibase.html');
  assert.ok(fs.existsSync(old), 'existing how-vs-predibase.html must remain');
});

test('W274 each new page has at least one CTA button to /quickstart', () => {
  for (const page of PAGES) {
    const html = readPage(page.file);
    assert.match(html, /<a class="btn primary" href="\/quickstart"/, `${page.file} missing /quickstart primary CTA`);
  }
});

test('W274 Bedrock page explicitly names AWS lock-in', () => {
  const html = readPage('kolm-vs-bedrock-distill.html');
  assert.match(html, /lock-in/i, 'Bedrock page must call out lock-in');
  // The Bedrock comparison page must mention vendor exit constraints.
  assert.match(html, /not exportable|cannot export|bound to Bedrock|Bedrock-only/i,
    'Bedrock page must name the AWS portability constraint');
});

test('W274 Proxis page frames as complement rather than pure competitor', () => {
  const html = readPage('kolm-vs-proxis.html');
  assert.match(html, /complement(ary)?/i, 'Proxis page should use complement framing');
});

test('W274 Predibase-2026 page covers Rubrik agentic governance pivot', () => {
  const html = readPage('kolm-vs-predibase-2026.html');
  assert.match(html, /agentic[\s-]+(AI[\s-]+)?governance/i, 'Predibase-2026 page must mention agentic governance pivot');
  assert.match(html, /Rubrik/, 'Predibase-2026 page must name Rubrik');
});

test('W274 OpenPipe-2026 page covers CoreWeave acquisition', () => {
  const html = readPage('kolm-vs-openpipe-2026.html');
  assert.match(html, /CoreWeave/, 'OpenPipe-2026 page must name CoreWeave');
  assert.match(html, /(acquired|acquisition)/i, 'OpenPipe-2026 page must mention the acquisition');
  assert.match(html, /April\s+2026|Apr\s+2026|2026[-/]04/i, 'OpenPipe-2026 page must date the acquisition');
});
