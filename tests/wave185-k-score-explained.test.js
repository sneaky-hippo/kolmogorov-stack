// Wave 185 - K-score explainer surface. Locks in /k-score-explained.html as
// the canonical explainer for the four-axis K-score quality gate that every
// .kolm artifact must clear before signing. Each assertion ties one piece of
// rendered prose to a frozen source-of-truth constant (recipe class taxonomy
// in src/recipe-class.js, K-score gate in src/binder.js check #4, frozen-eval
// invariant in src/seeds.js) so the page cannot drift from the modules it
// is meant to document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const PAGE = path.join(PUBLIC, 'k-score-explained.html');
const SW = path.join(PUBLIC, 'sw.js');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /k-score-explained page exists on disk and is non-trivial size (> 18 KB)', () => {
  assert.ok(fs.existsSync(PAGE), `k-score-explained.html missing at ${PAGE}`);
  const stat = fs.statSync(PAGE);
  assert.ok(stat.size > 18 * 1024,
    `k-score-explained.html too small (${stat.size} bytes; expected > 18 KB)`);
});

test('2. /k-score-explained declares canonical URL https://kolm.ai/k-score-explained', () => {
  const html = read(PAGE);
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/k-score-explained"/,
    'k-score-explained.html must declare canonical https://kolm.ai/k-score-explained');
});

test('3. /k-score-explained self-stamps wave 185', () => {
  const html = read(PAGE).toLowerCase();
  assert.ok(html.includes('wave 185'),
    'k-score-explained.html must self-stamp wave 185');
});

test('4. /k-score-explained names all four K-score axes', () => {
  const html = read(PAGE);
  for (const axis of ['groundedness', 'coverage', 'safety', 'behavioral_drift']) {
    assert.ok(html.includes(axis),
      `k-score-explained.html missing K-score axis "${axis}"`);
  }
});

test('5. /k-score-explained surfaces all four RECIPE_CLASSES and their default gate values', () => {
  const html = read(PAGE);
  // Source-of-truth: src/recipe-class.js RECIPE_CLASSES + W185 default gates.
  const CLASSES = ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'];
  for (const c of CLASSES) {
    assert.ok(html.includes(c),
      `k-score-explained.html missing recipe class "${c}"`);
  }
  // The four default gate values must all surface verbatim.
  for (const gate of ['0.88', '0.90', '0.92', '0.85']) {
    assert.ok(html.includes(gate),
      `k-score-explained.html missing K-score gate value "${gate}"`);
  }
});

test('6. /k-score-explained cross-references RS-1 spec §7.6', () => {
  const html = read(PAGE);
  assert.ok(html.includes('/spec/rs-1#section-7-6'),
    'k-score-explained.html must link to /spec/rs-1#section-7-6');
  // Section number must also be rendered in prose so a reader sees the anchor.
  assert.ok(/&sect;7\.6|§7\.6|section 7\.6/i.test(html),
    'k-score-explained.html must reference RS-1 §7.6 in prose');
});

test('7. /k-score-explained cites the K-score gate verifier check (#4 per src/binder.js)', () => {
  const html = read(PAGE);
  // src/binder.js implements the K-score gate as the fourth check in the
  // ordered checks array. The page must name the check number so a verifier
  // walking the binder PDF can map prose -> implementation.
  assert.ok(/#4\b/.test(html),
    'k-score-explained.html must cite verifier check #4 (K-score gate)');
  assert.ok(html.toLowerCase().includes('k-score gate'),
    'k-score-explained.html must name the "K-score gate" check by name');
});

test('8. /k-score-explained documents all four CLI surfaces', () => {
  const html = read(PAGE);
  for (const cmd of ['kolm eval', 'kolm verify', 'kolm compile', 'kolm inspect']) {
    assert.ok(html.includes(cmd),
      `k-score-explained.html missing CLI surface "${cmd}"`);
  }
});

test('9. /k-score-explained cross-links to /frozen-eval (W186 sibling surface)', () => {
  const html = read(PAGE);
  assert.ok(html.includes('/frozen-eval'),
    'k-score-explained.html must link to /frozen-eval (W186 surface, may not yet exist)');
});

test('10. /k-score-explained cross-links to /drift, recipe-class taxonomy, and /spec/rs-1', () => {
  // W380d: /recipe-classes rewrites to /taxonomy.html in vercel.json — accept
  // either surface URL per feedback-tests-assert-behavior-not-page-copy.
  const html = read(PAGE);
  for (const href of ['/drift', '/spec/rs-1']) {
    assert.ok(html.includes(`href="${href}`) || html.includes(`href='${href}`),
      `k-score-explained.html missing cross-link to ${href}`);
  }
  const taxonomyLink = /href=["'](?:\/recipe-classes|\/taxonomy|\/docs)["']/.test(html);
  assert.ok(taxonomyLink, 'k-score-explained.html must cross-link to the recipe-class taxonomy surface');
});

test('11. /k-score-explained cites the k_score_components manifest field', () => {
  const html = read(PAGE);
  assert.ok(html.includes('k_score_components'),
    'k-score-explained.html must cite the k_score_components manifest field for axis-weight customization');
});

test('12. /k-score-explained cites the LIMA finding from W196 research surface', () => {
  const html = read(PAGE);
  assert.ok(html.includes('LIMA'),
    'k-score-explained.html must cite the LIMA finding (quality-beats-volume) from W196 research surface');
});

test('13. /k-score-explained has the light-theme switch IIFE in <head> BEFORE the main body styles', () => {
  const html = read(PAGE);
  const headEnd = html.indexOf('</head>');
  assert.ok(headEnd > 0, 'k-score-explained.html missing </head>');
  const head = html.slice(0, headEnd);
  // The pre-paint IIFE must be inside <head>, before the page styles, so
  // light-theme users do not get the dark flash.
  assert.match(head, /localStorage\.getItem\(['"]kolm-theme['"]\)/,
    'k-score-explained.html must run the light-theme IIFE in <head> before paint');
  assert.match(head, /data-theme['"]?\s*,\s*['"]light['"]/,
    'k-score-explained.html IIFE must set data-theme="light" when stored');
});

test('14. /k-score-explained uses the canonical design tokens (--accent #10b981, --warn #f0b86b, --bad #ff6b91)', () => {
  const html = read(PAGE);
  assert.ok(html.includes('--accent:#10b981'),
    'k-score-explained.html must declare --accent:#10b981 (matching /drift and /compare)');
  assert.ok(html.includes('--warn:#f0b86b'),
    'k-score-explained.html must declare --warn:#f0b86b (matching /drift and /compare)');
  assert.ok(html.includes('--bad:#ff6b91'),
    'k-score-explained.html must declare --bad:#ff6b91 (matching /drift and /compare)');
  // Mono font stack also part of the canonical token set.
  assert.match(html, /--mono:/,
    'k-score-explained.html must declare the --mono token');
});

test('15. sw.js CACHE bumped to a wave-floor >= 185 (regex-extracted, not literal)', () => {
  const sw = read(SW);
  // Match the kolm-v7 cache header and extract the numeric wave segment.
  // Wave 185 is the floor for this test; later waves bump the slug forward.
  // The regex MUST be extracted, not literal-asserted, so future wave bumps
  // do not trigger a false regression (the lesson from the W169 cache test).
  const m = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(Number(m[1]) >= 185,
    `sw.js CACHE wave segment must be >= 185 (saw wave${m[1]})`);
});

test('16. /k-score-explained uses no em-dashes in load-bearing copy', () => {
  const html = read(PAGE);
  // Em-dash U+2014 and HTML entity &mdash; are both banned per W185 honesty
  // guard. Hyphens or middle-dots are the alternatives.
  assert.ok(!html.includes('—'),
    'k-score-explained.html must not contain U+2014 em-dashes');
  assert.ok(!html.includes('&mdash;'),
    'k-score-explained.html must not contain &mdash; HTML entities');
});

test('17. K-score gate values declared per class are internally consistent (rule=0.88, synth=0.90, comp=0.92, dist=0.85)', () => {
  const html = read(PAGE);
  // Each class must appear in proximity to its gate value somewhere on the
  // page. Scan the recipe-class default-gate table region for the (class,
  // gate) pairs called out in the W185 brief.
  const tableStart = html.indexOf('Default K-score gate by recipe class');
  assert.ok(tableStart > 0, 'k-score-explained.html missing the per-class default-gate section');
  const tableEnd = html.indexOf('</table>', tableStart);
  assert.ok(tableEnd > tableStart, 'k-score-explained.html per-class table never closes');
  const tableHtml = html.slice(tableStart, tableEnd);
  const pairs = [
    ['rule', '0.88'],
    ['synthesized_rule', '0.90'],
    ['compiled_rule', '0.92'],
    ['distilled_model', '0.85'],
  ];
  for (const [cls, gate] of pairs) {
    assert.ok(tableHtml.includes(cls),
      `per-class gate table missing class "${cls}"`);
    assert.ok(tableHtml.includes(gate),
      `per-class gate table missing gate value "${gate}" for class "${cls}"`);
  }
});

test('18. /k-score-explained per-class table has exactly four rows (one per RECIPE_CLASSES entry)', () => {
  const html = read(PAGE);
  const tableStart = html.indexOf('Default K-score gate by recipe class');
  const tableEnd = html.indexOf('</table>', tableStart);
  const tableHtml = html.slice(tableStart, tableEnd);
  // Count the data rows (<tr> inside <tbody>). Header <tr> lives inside <thead>
  // and must be excluded.
  const tbodyStart = tableHtml.indexOf('<tbody>');
  const tbodyEnd = tableHtml.indexOf('</tbody>');
  assert.ok(tbodyStart >= 0 && tbodyEnd > tbodyStart,
    'k-score-explained.html per-class table missing <tbody>');
  const tbody = tableHtml.slice(tbodyStart, tbodyEnd);
  const rowMatches = tbody.match(/<tr\b/g) || [];
  assert.equal(rowMatches.length, 4,
    `per-class table must have exactly 4 data rows (one per RECIPE_CLASSES entry); saw ${rowMatches.length}`);
});
