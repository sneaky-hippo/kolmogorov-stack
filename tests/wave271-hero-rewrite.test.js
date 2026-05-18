// W271 - homepage hero rewrite per outside audit feedback (3-second value prop).
//
// Audit said the hero failed to communicate value in 3 seconds and was too dense.
// W271 lands a pain-led H1 ("Stop renting intelligence. Stop leaking PHI. Stop
// rewriting your stack when GPT-5 ships."), a 3-column sub-hero comparison strip
// (Renting GPT / Hosting open-source / kolm compile + own), a persistent above-
// the-fold CTA ("Compile a free .kolm in 60 seconds" -> /quickstart), a tiny
// time-to-magic-moment counter, and a live K-score widget hydrated from
// /kscore-leaderboard.json with a graceful static fallback row.
//
// The "AI compiler" SEO category claim moves out of the H1 into a chip; the W260
// hero-thesis paragraph (data-w260="thesis") and v0.2-strip marker
// (data-w260="v02-strip") are preserved as the W260 lock-in suite requires.
//
// Tests assert behavior (grep, not byte-exact):
//   - pain-led H1 text present, with all three "Stop X" beats
//   - sub-hero strip is a 3-column comparison with the three named columns
//   - persistent CTA exists with the required copy + /quickstart href
//   - time-to-magic-moment counter present and references the <60s anchor
//   - inline script fetches /kscore-leaderboard.json
//   - existing W260 markers (data-w260="thesis", data-w260="v02-strip") preserved
//   - phi-redactor.kolm proof still in the hero
//   - sw.js CACHE wave-floor >= 271

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

function heroSlice(n) {
  const i = INDEX.search(/<h1[\s>]/i);
  assert.ok(i >= 0, 'hero H1 must exist');
  return INDEX.slice(i, i + n);
}

function countEmdash(html) {
  const raw = (html.match(/—/g) || []).length;
  const ent = (html.match(/&mdash;/g) || []).length;
  return raw + ent;
}

// =====================================================================
// Pain-led H1
// =====================================================================

test('W271 #1 - hero H1 leads with "Stop renting intelligence" pain beat', () => {
  const HERO = heroSlice(2000);
  assert.match(HERO, /Stop renting intelligence/i,
    'H1 region must include "Stop renting intelligence" pain beat');
});

test('W271 #2 - hero H1 includes an ownership pain beat (W334: PHI dropped as niche)', () => {
  // W334 dropped "Stop leaking PHI" — user said PHI is too niche for the hero.
  // The H1 now leads with the rent-vs-own framing; the second beat names the
  // ownership outcome ("Ship your own model and own it forever") which keeps
  // the two-beat rhythm without the PHI niche.
  const HERO = heroSlice(2000);
  assert.match(HERO, /Ship your own model|own it forever/i,
    'H1 region must carry the ownership pain beat after the W334 rescue');
});

test('W271 #3 - hero H1 is a two-beat rent-vs-own pair (W334: 3rd GPT-5 beat dropped)', () => {
  // W334 trimmed the H1 from three stacked "Stop X" beats down to two so the
  // hero reads cleanly. The dropped third beat ("Stop rewriting your stack
  // when GPT-5 ships") was the weakest of the three; the rent-vs-own framing
  // now carries the message in two lines without piling up.
  const HERO = heroSlice(2000);
  const h1Match = HERO.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  assert.ok(h1Match, 'H1 must exist');
  const beats = (h1Match[1].match(/<span\s+class="(stop|pain)"/g) || []).length;
  assert.ok(beats === 2,
    `H1 must carry exactly 2 rent-vs-own beats after W334 (saw ${beats})`);
});

test('W271 #4 - hero H1 is marked data-w271="pain-h1"', () => {
  const HERO = heroSlice(2000);
  assert.match(HERO, /<h1[^>]*data-w271="pain-h1"/i,
    'H1 must carry data-w271="pain-h1" marker');
});

// =====================================================================
// Sub-hero comparison strip: 3 columns
// =====================================================================

test('W271 #5 - sub-hero strip exists with data-w271="rent-vs-host" marker', () => {
  assert.match(INDEX, /data-w271="rent-vs-host"/,
    'three-column comparison strip must carry the rent-vs-host marker');
});

test('W271 #6 - sub-hero strip has the "Renting GPT / Claude" column', () => {
  assert.match(INDEX, /data-w271="vs-rent"/,
    'rent column must carry data-w271="vs-rent"');
  assert.match(INDEX, /Renting GPT \/ Claude/i,
    'rent column must be titled "Renting GPT / Claude"');
});

test('W271 #7 - sub-hero strip has the "Hosting open-source" column', () => {
  assert.match(INDEX, /data-w271="vs-host"/,
    'host column must carry data-w271="vs-host"');
  assert.match(INDEX, /Hosting open-source/i,
    'host column must be titled "Hosting open-source"');
});

test('W271 #8 - sub-hero strip has the "kolm.ai (compile + own)" column', () => {
  assert.match(INDEX, /data-w271="vs-kolm"/,
    'kolm column must carry data-w271="vs-kolm"');
  assert.match(INDEX, /kolm\.ai \(compile \+ own\)/i,
    'kolm column must be titled "kolm.ai (compile + own)"');
});

test('W271 #9 - sub-hero strip has exactly 3 columns (data-w271="vs-*" cells)', () => {
  const cells = INDEX.match(/data-w271="vs-(rent|host|kolm)"/g) || [];
  assert.equal(cells.length, 3,
    `sub-hero strip must have 3 named columns (saw ${cells.length})`);
});

// =====================================================================
// Persistent above-the-fold CTA
// =====================================================================

test('W271 #10 - persistent CTA exists with /quickstart href', () => {
  const HERO = heroSlice(4500);
  assert.match(HERO, /<a[^>]*href="\/quickstart"[^>]*data-w271="cta-primary"/i,
    'primary CTA must be an anchor to /quickstart with data-w271="cta-primary"');
});

test('W271 #11 - primary CTA copy is "Compile a free .kolm in 60 seconds"', () => {
  const HERO = heroSlice(4500);
  assert.match(HERO, /Compile a free \.kolm in 60 seconds/i,
    'primary CTA copy must be "Compile a free .kolm in 60 seconds"');
});

// =====================================================================
// Time-to-magic-moment counter
// =====================================================================

test('W271 #12 - time-to-magic-moment counter present with data-w271="ttmm-counter"', () => {
  const HERO = heroSlice(4500);
  assert.match(HERO, /data-w271="ttmm-counter"/,
    'time-to-magic-moment counter must carry data-w271="ttmm-counter"');
});

test('W271 #13 - ttmm counter quotes the <60s fallback anchor', () => {
  const HERO = heroSlice(4500);
  // We assert presence of the &lt;60s entity (rendered: <60s) because no bench
  // fixture exists in src/compile.js to measure compile wall-time.
  assert.match(HERO, /first signed artifact in[\s\S]{0,80}&lt;60s/i,
    'ttmm counter must include "first signed artifact in <60s" copy');
});

// =====================================================================
// Live K-score widget
// =====================================================================

test('W271 #14 - K-score widget container exists with data-w271="kscore-widget"', () => {
  assert.match(INDEX, /data-w271="kscore-widget"/,
    'K-score widget container must carry data-w271="kscore-widget"');
});

test('W271 #15 - K-score widget has a fallback row keyed to data-w271="kscore-fallback"', () => {
  assert.match(INDEX, /data-w271="kscore-fallback"/,
    'K-score widget must include a graceful-degradation fallback row');
});

test('W271 #16 - K-score widget script fetches /kscore-leaderboard.json', () => {
  assert.match(INDEX, /fetch\(['"]\/kscore-leaderboard\.json['"]/,
    'inline script must call fetch("/kscore-leaderboard.json")');
});

test('W271 #17 - /kscore-leaderboard.json file ships and has a non-empty rows array', () => {
  const lbPath = path.join(PUBLIC, 'kscore-leaderboard.json');
  assert.ok(fs.existsSync(lbPath), '/kscore-leaderboard.json must exist');
  const data = JSON.parse(fs.readFileSync(lbPath, 'utf8'));
  assert.ok(Array.isArray(data.rows) && data.rows.length > 0,
    'leaderboard JSON must include a non-empty rows[] for the widget to render');
  assert.ok(data.rows[0].artifact, 'top row must have an artifact name');
});

// =====================================================================
// SEO category claim retained (no longer in H1)
// =====================================================================

test('W271 #18 - "the AI compiler" category claim still present as a SEO chip (not H1)', () => {
  // The SEO chip sits just above the H1 inside the hero <section>; we scan the
  // hero section block from <section ... data-w271="hero"> through the H1 region.
  const secStart = INDEX.search(/<section[^>]*data-w271="hero"/i);
  assert.ok(secStart >= 0, 'hero section with data-w271="hero" must exist');
  const HERO_FULL = INDEX.slice(secStart, secStart + 6000);
  assert.match(HERO_FULL, /data-w271="seo-chip"/,
    'SEO chip must exist as the new home for the "AI compiler" claim');
  assert.match(HERO_FULL, /the AI compiler/i,
    '"the AI compiler" must remain prominent in the hero region');
  // And it must NOT be inside the H1 element itself.
  const h1Match = HERO_FULL.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  assert.ok(h1Match, 'H1 must exist');
  assert.ok(!/the AI compiler/i.test(h1Match[1]),
    '"the AI compiler" must no longer be inside the H1 element itself');
});

// =====================================================================
// W260 anchors preserved (data-w260 markers carried by W271)
// =====================================================================

test('W271 #19 - data-w260="thesis" paragraph preserved by W271 rewrite', () => {
  assert.match(INDEX, /data-w260="thesis"/,
    'W260 thesis marker must be preserved on the rewritten hero');
});

test('W271 #20 - data-w260="v02-strip" marker preserved by W271 rewrite', () => {
  assert.match(INDEX, /data-w260="v02-strip"/,
    'W260 v02-strip marker must be preserved on the rewritten hero');
});

// =====================================================================
// phi-redactor.kolm proof still visible
// =====================================================================

test('W271 #21 - phi-redactor.kolm proof artifact still visible somewhere in the hero', () => {
  // The proof appears both in the hero thesis (as the proof anchor) and lower
  // in the existing hero-artifact strip. Both keep working as proof signals.
  const HERO = heroSlice(8000);
  assert.match(HERO, /phi-redactor\.kolm/,
    'phi-redactor.kolm must remain a visible proof artifact in the hero region');
});

// =====================================================================
// Hard constraints
// =====================================================================

test('W271 #22 - index.html em-dash budget <= 1 (W205 lock; user hard rule)', () => {
  assert.ok(countEmdash(INDEX) <= 1,
    `index.html em-dash count ${countEmdash(INDEX)} > budget 1`);
});

test('W271 #23 - existing JSON-LD block preserved (Organization + WebSite + SoftwareApplication)', () => {
  const ld = INDEX.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ld, 'index.html must still ship a JSON-LD block');
  assert.match(ld[1], /"Organization"/, 'JSON-LD Organization preserved');
  assert.match(ld[1], /"WebSite"/, 'JSON-LD WebSite preserved');
  assert.match(ld[1], /"SoftwareApplication"/, 'JSON-LD SoftwareApplication preserved');
});

test('W271 #24 - hero section is marked data-w271="hero" for downstream lockup', () => {
  assert.match(INDEX, /<section[^>]*class="[^"]*hero[^"]*"[^>]*data-w271="hero"/i,
    'top hero <section> must carry data-w271="hero" marker');
});

// =====================================================================
// sw.js cache slug bump (wave-floor lock)
// =====================================================================

test('W271 #25 - sw.js CACHE slug bumped to wave-floor >= 271', () => {
  const m = SW.match(/const\s+CACHE\s*=\s*'kolm-v7-2026-05-\d+-wave(\d+)-([a-z0-9-]+)'/);
  assert.ok(m, 'CACHE slug must follow kolm-v7-YYYY-MM-DD-waveN-slug pattern');
  const waveN = parseInt(m[1], 10);
  assert.ok(waveN >= 271, `sw.js wave-slug must be >= 271 (saw ${waveN})`);
});

// =====================================================================
// Structural preservation: existing sections below the hero must remain
// (we explicitly do not rewrite the full page).
// =====================================================================

test('W271 #26 - existing demo-anchor section still ships below the hero', () => {
  assert.match(INDEX, /<section class="demo-anchor"/,
    'demo-anchor section below the hero must remain');
});

test('W271 #27 - existing "What ships in v0.2 today." section preserved', () => {
  assert.match(INDEX, /What ships in v0\.2 today\./,
    'v0.2 heading must remain (W260 #5 anchor lives here)');
});

test('W271 #28 - existing 4-verb v0.2 grid (moe compose / tokenize / extract / doc check) preserved', () => {
  assert.match(INDEX, /kolm moe compose/, 'v0.2 strip names moe compose');
  assert.match(INDEX, /kolm tokenize/, 'v0.2 strip names tokenize');
  assert.match(INDEX, /kolm extract/, 'v0.2 strip names extract');
  assert.match(INDEX, /kolm doc check/, 'v0.2 strip names doc check');
});
