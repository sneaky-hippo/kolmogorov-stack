// Wave 186 - W144 Doc 3 Shift 3 frozen-eval surface. Locks in the dedicated
// /frozen-eval page that documents the train/holdout disjoint check shipped
// in W144 (Q+2). The seed gate (binder check #7 in src/binder.js) is the
// frozen anchor every K-score on the site depends on; this page exists so
// the contract is visible to a regulated buyer without reading source.
//
// Every assertion ties one piece of rendered prose to a frozen backend
// constant (src/seeds.js + src/binder.js + RS-1 spec section number) so
// the page cannot drift from the contract it documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const FROZEN = path.join(PUBLIC, 'frozen-eval.html');
const SW = path.join(PUBLIC, 'sw.js');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /frozen-eval page exists on disk and is non-trivial size', () => {
  assert.ok(fs.existsSync(FROZEN), `frozen-eval.html missing at ${FROZEN}`);
  const stat = fs.statSync(FROZEN);
  assert.ok(stat.size > 18 * 1024,
    `frozen-eval.html too small (${stat.size} bytes; expected > 18 KB)`);
});

test('2. /frozen-eval declares canonical URL https://kolm.ai/frozen-eval', () => {
  const html = read(FROZEN);
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/frozen-eval"/,
    'frozen-eval.html must declare canonical https://kolm.ai/frozen-eval');
});

test('3. /frozen-eval self-stamps wave 186', () => {
  const html = read(FROZEN);
  assert.ok(html.toLowerCase().includes('wave 186'),
    'frozen-eval.html must self-stamp wave 186');
});

test('4. /frozen-eval names the three invariants (disjoint, pinned, sufficient)', () => {
  const html = read(FROZEN).toLowerCase();
  for (const name of ['disjoint', 'pinned', 'sufficient']) {
    assert.ok(html.includes(name),
      `frozen-eval.html must name invariant "${name}"`);
  }
});

test('5. /frozen-eval names every manifest field (holdout_hash, holdout_size, train_size, seeds_hash, eval_spec)', () => {
  const html = read(FROZEN);
  for (const field of ['holdout_hash', 'holdout_size', 'train_size', 'seeds_hash', 'eval_spec']) {
    assert.ok(html.includes(field),
      `frozen-eval.html must surface manifest field "${field}"`);
  }
});

test('6. /frozen-eval cross-references RS-1 spec sections that anchor the contract', () => {
  const html = read(FROZEN);
  // §4 = "Eval independence: seeds.jsonl train/holdout split" (the canonical
  // anchor for the disjoint check). §6 = "The K-score" (computed against the
  // holdout). §7.12 = "External + adversarial holdouts" (extends the same
  // disjointness rule). These are the actual section numbers in the live
  // public/spec/rs-1.html, NOT the placeholder numbers in the planning doc.
  for (const href of ['/spec/rs-1#section-4', '/spec/rs-1#section-7-12']) {
    assert.ok(html.includes(href),
      `frozen-eval.html must cross-link to ${href}`);
  }
  // §6 and §7.15 (supersession) referenced inline in prose.
  for (const phrase of ['&sect;4', '&sect;6', '&sect;7.12']) {
    assert.ok(html.includes(phrase),
      `frozen-eval.html must cite RS-1 ${phrase}`);
  }
});

test('7. /frozen-eval surfaces all four ship-block scenarios', () => {
  const html = read(FROZEN).toLowerCase();
  for (const phrase of [
    'train and holdout overlap',
    'holdout size below threshold',
    'holdout hash changed',
    'k-score on frozen holdout below gate',
  ]) {
    assert.ok(html.includes(phrase),
      `frozen-eval.html missing ship-block scenario "${phrase}"`);
  }
});

test('8. /frozen-eval claims NO --force flag exists (override-audit honest-scope)', () => {
  const html = read(FROZEN);
  // The page must explicitly tell the reader there is no --force flag.
  assert.ok(/no <code>--force<\/code> flag/i.test(html)
    || /there is no <code>--force<\/code>/i.test(html)
    || /no .*--force.* flag/i.test(html),
    'frozen-eval.html must explicitly declare "there is no --force flag" in the override-audit section');
  // And must NOT claim any --force / --skip-checks / --bypass override exists.
  assert.ok(!/--force\s+(silences|overrides|bypasses)/i.test(html),
    'frozen-eval.html must not describe a --force flag that overrides the gate');
});

test('9. /frozen-eval cross-links to /k-score-explained (W185), /drift (W171), and recipe-class taxonomy (W172)', () => {
  // W380d: /recipe-classes rewrites to /taxonomy.html in vercel.json — accept
  // either surface URL per feedback-tests-assert-behavior-not-page-copy.
  const html = read(FROZEN);
  for (const href of ['/k-score-explained', '/drift']) {
    assert.ok(html.includes(`href="${href}"`),
      `frozen-eval.html missing cross-link to ${href}`);
  }
  const taxonomyLink = /href=["'](?:\/recipe-classes|\/taxonomy|\/docs)["']/.test(html);
  assert.ok(taxonomyLink, 'frozen-eval.html must cross-link to the recipe-class taxonomy surface');
});

test('10. /frozen-eval cross-links to /spec/rs-1#section-7-12 (W164 external holdout)', () => {
  const html = read(FROZEN);
  assert.ok(html.includes('href="/spec/rs-1#section-7-12"'),
    'frozen-eval.html must cross-link to /spec/rs-1#section-7-12 (external holdout extension)');
});

test('11. /frozen-eval documents the four CLI verbs (seeds split, eval, verify, inspect)', () => {
  const html = read(FROZEN);
  for (const cmd of ['kolm seeds split', 'kolm eval', 'kolm verify', 'kolm inspect']) {
    assert.ok(html.includes(cmd),
      `frozen-eval.html missing CLI surface "${cmd}"`);
  }
});

test('12. /frozen-eval ships the light-theme switch IIFE in <head> before body styles', () => {
  const html = read(FROZEN);
  const headIdx = html.indexOf('<head>');
  const bodyIdx = html.indexOf('<body');
  assert.ok(headIdx >= 0 && bodyIdx > headIdx,
    'frozen-eval.html must have <head> before <body>');
  const headBlock = html.slice(headIdx, bodyIdx);
  // The IIFE pattern from /drift: reads localStorage 'kolm-theme', sets
  // data-theme=light + html background pre-paint. Must live inside <head>
  // so the theme is applied before the first paint, not after.
  assert.ok(/localStorage\.getItem\(['"]kolm-theme['"]\)/.test(headBlock),
    'frozen-eval.html <head> must include the kolm-theme localStorage IIFE');
  assert.ok(/data-theme.*light/i.test(headBlock),
    'frozen-eval.html <head> IIFE must set data-theme=light');
});

test('13. /frozen-eval uses the consistent design system tokens', () => {
  const html = read(FROZEN);
  assert.match(html, /--ink:/, 'frozen-eval.html must declare --ink');
  assert.match(html, /--ink-mute:/, 'frozen-eval.html must declare --ink-mute');
  assert.match(html, /--bg:/, 'frozen-eval.html must declare --bg');
  assert.match(html, /--bg-elev:/, 'frozen-eval.html must declare --bg-elev');
  assert.match(html, /--accent:/, 'frozen-eval.html must declare --accent');
  assert.match(html, /--warn:/, 'frozen-eval.html must declare --warn');
  assert.match(html, /--bad:/, 'frozen-eval.html must declare --bad');
  assert.match(html, /--mono:/, 'frozen-eval.html must declare --mono');
});

test('14. sw.js CACHE bumped to wave186 or later slug (wave-floor regex, not literal)', () => {
  const sw = read(SW);
  // Wave 186 is the floor for this test; later waves bump the slug forward.
  // Match any kolm-v7-YYYY-MM-DD-wave<N>- CACHE and assert N >= 186 numerically
  // so a later wave bumping the slug does not regress this test (the trap that
  // W169 test #12 fell into and W171 fixed).
  const m = sw.match(/const CACHE = 'kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(Number(m[1]) >= 186,
    `sw.js CACHE wave segment must be >= 186 (saw wave${m[1]})`);
});

test('15. /frozen-eval contains no em-dashes in load-bearing copy', () => {
  const html = read(FROZEN);
  // Both literal Unicode em-dash AND the &mdash; entity are forbidden.
  // Hyphens (-) and middle-dots (&middot;) are the substitute.
  assert.ok(!html.includes('—'),
    'frozen-eval.html must not use literal Unicode em-dash (U+2014); use hyphen or middle-dot');
  assert.ok(!html.includes('&mdash;'),
    'frozen-eval.html must not use the &mdash; entity; use hyphen or middle-dot');
});

test('16. /frozen-eval cites SHA-256 as the hash function for hash-set membership', () => {
  const html = read(FROZEN);
  // The canonical-input + split_seed hash uses SHA-256; the disjointness
  // check is a SHA-256 hash-set intersection. Both must be named verbatim
  // so the page documents the algorithm, not just the property.
  assert.ok(html.includes('SHA-256') || html.includes('sha256') || html.includes('sha-256'),
    'frozen-eval.html must cite SHA-256 as the hash function');
});

test('17. /frozen-eval cites the supersession block path for override audit (cross-ref W167)', () => {
  const html = read(FROZEN);
  assert.ok(html.toLowerCase().includes('supersession'),
    'frozen-eval.html must cite the supersession block in the override-audit section');
  // The cross-ref must point at the W167 dedicated surface or the spec section.
  assert.ok(html.includes('/drift') || html.includes('#section-7-15'),
    'frozen-eval.html override-audit must link to /drift or RS-1 §7.15');
});

test('18. /frozen-eval names BOTH the absolute holdout floor (50 examples) and the per-train floor (ceil(N_train / 8))', () => {
  const html = read(FROZEN);
  assert.ok(/50 examples?/i.test(html),
    'frozen-eval.html must surface the 50-examples minimum');
  assert.ok(/ceil\(N_train ?\/ ?8\)/i.test(html),
    'frozen-eval.html must surface the ceil(N_train / 8) per-train floor');
});
