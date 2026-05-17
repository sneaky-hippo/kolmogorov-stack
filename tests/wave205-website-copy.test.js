// Wave 205 - website copy audit + patch (hero/CTA/microcopy per persona).
// Locks the 10 high-traffic public surfaces against marketing fluff,
// em-dash inflation, persona-irrelevance, missing cross-links, and
// emoji creep. The 10 pages are read-only outside this wave so the
// floor each assertion enforces should hold across W202-W209.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const SW = path.join(PUBLIC, 'sw.js');

const read = (p) => fs.readFileSync(p, 'utf8');

// The 10 surfaces in scope and their size-floor budgets (bytes).
// Floors set well below the live size as of W205 baseline so future
// trims do not break the lock, while still catching catastrophic delete.
const PAGES = [
  { slug: 'index',           file: 'index.html',           floor: 200 * 1024 },
  { slug: 'why-kolm',        file: 'why-kolm.html',        floor: 16 * 1024 },
  { slug: 'manifesto',       file: 'manifesto.html',       floor: 16 * 1024 },
  { slug: 'pricing',         file: 'pricing.html',         floor: 60 * 1024 },
  { slug: 'enterprise',      file: 'enterprise.html',      floor: 24 * 1024 },
  { slug: 'healthcare',      file: 'healthcare.html',      floor: 28 * 1024 },
  { slug: 'health-insurance',file: 'health-insurance.html',floor: 28 * 1024 },
  { slug: 'quickstart',      file: 'quickstart.html',      floor: 32 * 1024 },
  { slug: 'k-score',         file: 'k-score.html',         floor: 32 * 1024 },
  { slug: 'compare',         file: 'compare.html',         floor: 22 * 1024 },
];

// Em-dash budgets captured at W205 baseline (raw + entity). Tests assert
// post-edit counts are <= these budgets so future copy edits cannot
// silently grow em-dash usage on these 10 surfaces.
const EMDASH_BUDGET = {
  'index.html':            1,
  'why-kolm.html':         0,
  'manifesto.html':        0,
  'pricing.html':          7,
  'enterprise.html':       1,
  'healthcare.html':       1,
  'health-insurance.html': 6,
  'quickstart.html':       5,
  'k-score.html':          0,
  'compare.html':          4,
};

// Forbidden marketing fluff. Each must have ZERO hits in any of the 10
// pages. 'enterprise-grade' is allowed only when naming a product tier
// (kolm does not ship one), so it stays forbidden here.
const FLUFF = [
  'game-changing', 'revolutionary', 'world-class', 'best-in-class',
  'next-gen', 'blazing fast', 'blazing-fast', '10x', '100x',
  'industry-leading', 'industry leading', 'enterprise-grade',
];

// Persona signal vocabulary. Each hero must hit at least ONE of these
// in the first ~3KB of body so a developer / procurement / data
// scientist / compliance reader can self-identify on first scroll.
const PERSONA = [
  'developer', 'engineer', 'procurement', 'compliance', 'data',
  'architect', 'security', 'regulated', 'HIPAA', 'SOC2',
  'enterprise', 'install', 'CLI', 'model', 'distill', 'distillation',
];

// Honest-scope vocabulary. The kolm brand voice promises verifiability;
// at least 5 of 10 pages must surface one of these tokens.
const HONEST_SCOPE = ['verify', 'honest', 'real'];

function bodyOf(html) {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}

function firstHero(html) {
  // Best-effort: take from first <h1 ...> through ~3000 chars so we
  // capture the hero h1 + lede + first CTA block without pulling in
  // late-page sections.
  const idx = html.search(/<h1[\s>]/i);
  if (idx < 0) return '';
  return html.slice(idx, idx + 3000);
}

function countEmdash(html) {
  const raw = (html.match(/—/g) || []).length;
  const ent = (html.match(/&mdash;/g) || []).length;
  return raw + ent;
}

function countEmoji(html) {
  // BMP and supplementary emoji ranges. ZWJ (U+200D) and VS16 (U+FE0F)
  // are not themselves emoji codepoints; we only count base glyphs.
  let n = 0;
  for (const ch of html) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1F300 && cp <= 0x1FAFF) ||
      (cp >= 0x1F600 && cp <= 0x1F64F) ||
      (cp >= 0x2600  && cp <= 0x27BF)
    ) n++;
  }
  return n;
}

// =====================================================================
// 1-10. All 10 pages exist and clear their size floor.
// =====================================================================
for (const p of PAGES) {
  test(`${p.slug}: file exists and clears ${(p.floor / 1024) | 0} KB floor`, () => {
    const fp = path.join(PUBLIC, p.file);
    assert.ok(fs.existsSync(fp), `${p.file} missing at ${fp}`);
    const sz = fs.statSync(fp).size;
    assert.ok(sz >= p.floor,
      `${p.file} too small (${sz} bytes; floor ${p.floor})`);
  });
}

// =====================================================================
// 11. No forbidden fluff phrases in any of the 10 pages.
// =====================================================================
test('11. zero forbidden fluff phrases across all 10 pages', () => {
  const hits = [];
  for (const p of PAGES) {
    const html = read(path.join(PUBLIC, p.file));
    for (const phrase of FLUFF) {
      const re = new RegExp(phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
      const m = html.match(re);
      if (m && m.length > 0) hits.push(`${p.file}: "${phrase}" x${m.length}`);
    }
  }
  assert.equal(hits.length, 0,
    `forbidden fluff phrases found:\n  ${hits.join('\n  ')}`);
});

// =====================================================================
// 12. Em-dash count per page <= W205 baseline budget.
// =====================================================================
test('12. em-dash count per page does not exceed baseline budget', () => {
  const over = [];
  for (const p of PAGES) {
    const html = read(path.join(PUBLIC, p.file));
    const n = countEmdash(html);
    const budget = EMDASH_BUDGET[p.file];
    if (n > budget) over.push(`${p.file}: ${n} > budget ${budget}`);
  }
  assert.equal(over.length, 0,
    `em-dash budget exceeded:\n  ${over.join('\n  ')}`);
});

// =====================================================================
// 13. Hero <h1> present on every page.
// =====================================================================
test('13. each page renders a hero <h1>', () => {
  const missing = [];
  for (const p of PAGES) {
    const html = read(path.join(PUBLIC, p.file));
    if (!/<h1[\s>]/i.test(html)) missing.push(p.file);
  }
  assert.equal(missing.length, 0,
    `pages missing <h1>: ${missing.join(', ')}`);
});

// =====================================================================
// 14. First CTA (anchor or button) present within first 1500 chars
// of body on every page.
// =====================================================================
test('14. each page has at least one CTA in first 1500 chars of body', () => {
  const missing = [];
  for (const p of PAGES) {
    const html = read(path.join(PUBLIC, p.file));
    const head1500 = bodyOf(html).slice(0, 1500);
    const hasA = /<a\s/i.test(head1500);
    const hasBtn = /<button\s/i.test(head1500);
    if (!hasA && !hasBtn) missing.push(p.file);
  }
  assert.equal(missing.length, 0,
    `pages with no CTA in first 1500 body chars: ${missing.join(', ')}`);
});

// =====================================================================
// 15. Each page hero surfaces at least one persona keyword.
// =====================================================================
test('15. each page hero surfaces >=1 persona keyword', () => {
  const missing = [];
  for (const p of PAGES) {
    const html = read(path.join(PUBLIC, p.file));
    const hero = firstHero(html);
    const hit = PERSONA.some((k) =>
      new RegExp('\\b' + k + '\\b', 'i').test(hero));
    if (!hit) missing.push(p.file);
  }
  assert.equal(missing.length, 0,
    `pages missing persona signal in hero: ${missing.join(', ')}`);
});

// =====================================================================
// 16. /quickstart cross-link on at least 5 of the 10 pages.
// =====================================================================
test('16. at least 5 of 10 pages link to /quickstart (developer next-action)', () => {
  let hits = 0;
  const present = [];
  for (const p of PAGES) {
    const html = read(path.join(PUBLIC, p.file));
    if (/href=["']\/quickstart/.test(html)) { hits++; present.push(p.slug); }
  }
  assert.ok(hits >= 5,
    `only ${hits} pages link to /quickstart (need >= 5); present: ${present.join(', ')}`);
});

// =====================================================================
// 17. /enterprise cross-link on at least 3 of the 10 pages.
// =====================================================================
test('17. at least 3 of 10 pages link to /enterprise (procurement)', () => {
  let hits = 0;
  const present = [];
  for (const p of PAGES) {
    const html = read(path.join(PUBLIC, p.file));
    if (/href=["']\/enterprise/.test(html)) { hits++; present.push(p.slug); }
  }
  assert.ok(hits >= 3,
    `only ${hits} pages link to /enterprise (need >= 3); present: ${present.join(', ')}`);
});

// =====================================================================
// 18. /security cross-link on at least 3 of the 10 pages.
// =====================================================================
test('18. at least 3 of 10 pages link to /security (compliance)', () => {
  let hits = 0;
  const present = [];
  for (const p of PAGES) {
    const html = read(path.join(PUBLIC, p.file));
    if (/href=["']\/security/.test(html)) { hits++; present.push(p.slug); }
  }
  assert.ok(hits >= 3,
    `only ${hits} pages link to /security (need >= 3); present: ${present.join(', ')}`);
});

// =====================================================================
// 19. /training or /k-score cross-link on at least 3 of the 10 pages.
// =====================================================================
test('19. at least 3 of 10 pages link to /training or /k-score (data scientist)', () => {
  let hits = 0;
  const present = [];
  for (const p of PAGES) {
    const html = read(path.join(PUBLIC, p.file));
    if (/href=["']\/(training|k-score)/.test(html)) {
      hits++; present.push(p.slug);
    }
  }
  assert.ok(hits >= 3,
    `only ${hits} pages link to /training or /k-score (need >= 3); present: ${present.join(', ')}`);
});

// =====================================================================
// 20. sw.js wave-floor regex >= 205 (catches W205+ cache bumps).
// =====================================================================
test('20. sw.js cache slug embeds wave >= 205', () => {
  assert.ok(fs.existsSync(SW), `sw.js missing at ${SW}`);
  const sw = read(SW);
  const m = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, `sw.js does not match expected cache-slug pattern`);
  const wave = parseInt(m[1], 10);
  assert.ok(wave >= 205,
    `sw.js wave slug is wave${wave}; expected >= 205. Coordinator must bump sw.js`);
});

// =====================================================================
// 21. Zero emoji codepoints in any of the 10 pages.
// =====================================================================
test('21. zero emoji codepoints across all 10 pages', () => {
  const hits = [];
  for (const p of PAGES) {
    const html = read(path.join(PUBLIC, p.file));
    const n = countEmoji(html);
    if (n > 0) hits.push(`${p.file}: ${n} emoji codepoints`);
  }
  assert.equal(hits.length, 0,
    `emoji codepoints found:\n  ${hits.join('\n  ')}`);
});

// =====================================================================
// 22. Honest-scope: "verify" or "honest" or "real" appears on at least
// 5 of the 10 pages (kolm brand voice).
// =====================================================================
test('22. honest-scope token on >= 5 of 10 pages (kolm voice)', () => {
  let hits = 0;
  const present = [];
  for (const p of PAGES) {
    const html = read(path.join(PUBLIC, p.file));
    const has = HONEST_SCOPE.some((k) =>
      new RegExp('\\b' + k + '\\b', 'i').test(html));
    if (has) { hits++; present.push(p.slug); }
  }
  assert.ok(hits >= 5,
    `only ${hits} pages carry honest-scope vocabulary (need >= 5); present: ${present.join(', ')}`);
});
