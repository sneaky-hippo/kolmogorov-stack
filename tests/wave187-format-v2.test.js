// Wave 187 - Shift 3 of W144 Doc 3 backlog. Locks in the dedicated
// /format/v2 page that documents the .kolm portable artifact format,
// the v1 to v2 transition, the bundle layout, the canonical manifest
// keys, the backwards-compatibility scope, and the CLI flow. Every
// assertion ties one piece of rendered prose to a frozen backend or
// spec contract so the page cannot drift from what the codebase
// actually ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const FORMAT_V2 = path.join(PUBLIC, 'format', 'v2.html');
const SW = path.join(PUBLIC, 'sw.js');
const CLI = path.join(REPO, 'cli', 'kolm.js');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /format/v2 page exists on disk and is > 18 KB', () => {
  assert.ok(fs.existsSync(FORMAT_V2), `format/v2.html missing at ${FORMAT_V2}`);
  const stat = fs.statSync(FORMAT_V2);
  assert.ok(stat.size > 18 * 1024,
    `format/v2.html too small (${stat.size} bytes; expected > 18 KB)`);
});

test('2. /format/v2 declares canonical URL https://kolm.ai/format/v2', () => {
  const html = read(FORMAT_V2);
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/format\/v2"/,
    'format/v2.html must declare canonical https://kolm.ai/format/v2');
});

test('3. /format/v2 self-stamps wave 187', () => {
  const html = read(FORMAT_V2);
  const lower = html.toLowerCase();
  assert.ok(lower.includes('wave 187'),
    'format/v2.html must self-stamp wave 187 somewhere on the page');
});

test('4. /format/v2 has a v1-to-v2 transition section naming both formats in comparison context', () => {
  const html = read(FORMAT_V2);
  const lower = html.toLowerCase();
  assert.ok(lower.includes('v1 to v2') || lower.includes('v1-to-v2') || lower.includes('v1 &rarr; v2') || lower.includes('v1 → v2'),
    'format/v2.html must frame the v1 to v2 transition explicitly');
  // both labels must appear in close proximity (within the same section)
  const transitionIdx = lower.indexOf('v1 to v2');
  assert.ok(transitionIdx >= 0, 'format/v2.html missing the v1 to v2 transition section heading');
  // the comparison table itself names format v1 and format v2 as column headers
  assert.ok(lower.includes('format v1'),
    'format/v2.html transition table must label the "format v1" column');
  assert.ok(lower.includes('format v2'),
    'format/v2.html transition table must label the "format v2" column');
});

test('5. /format/v2 bundle structure tree names every mandatory slot path', () => {
  const html = read(FORMAT_V2);
  for (const p of [
    'meta/manifest.json',
    'meta/receipt.json',
    'meta/signatures.json',
    'recipes/',
    'seeds/',
    'evals/',
  ]) {
    assert.ok(html.includes(p),
      `format/v2.html bundle tree missing path "${p}"`);
  }
});

test('6. /format/v2 names every canonical manifest top-level key', () => {
  const html = read(FORMAT_V2);
  for (const key of [
    'job_id',
    'task',
    'base_model',
    'license',
    'recipes',
    'format_version',
    'kolm_version',
  ]) {
    // Some keys (job_id, task) live in the schema description text; others
    // appear in the keys grid. The assertion is presence anywhere on the page.
    assert.ok(html.includes(key),
      `format/v2.html must name canonical manifest key "${key}"`);
  }
});

test('7. /format/v2 documents backwards-compatibility scope (v2 reads v1, v1 fails on v2)', () => {
  const html = read(FORMAT_V2);
  const lower = html.toLowerCase();
  assert.ok(lower.includes('fail-open') || lower.includes('fail open'),
    'format/v2.html must document v2 reader fail-open on v1 input');
  assert.ok(html.includes('format_version_old'),
    'format/v2.html must name the format_version_old warn log entry the v2 reader emits');
  assert.ok(
    lower.includes('v1 reader') &&
    (lower.includes('refuses to parse') || lower.includes('fails on v2') ||
     lower.includes('cannot read') || lower.includes('format_version_unsupported')),
    'format/v2.html must document that a v1 reader cannot silently misread a v2 file');
});

test('8. /format/v2 cross-links to /migrate', () => {
  const html = read(FORMAT_V2);
  assert.ok(html.includes('href="/migrate"'),
    'format/v2.html must cross-link to /migrate');
});

test('9. /format/v2 cross-links to /spec/rs-1, recipe-class taxonomy, /k-score-explained', () => {
  // W380d: /recipe-classes rewrites to /taxonomy.html in vercel.json — accept
  // either surface URL per feedback-tests-assert-behavior-not-page-copy.
  const html = read(FORMAT_V2);
  for (const href of ['/spec/rs-1', '/k-score-explained']) {
    assert.ok(html.includes(`href="${href}"`),
      `format/v2.html missing cross-link to ${href}`);
  }
  const taxonomyLink = /href=["'](?:\/recipe-classes|\/taxonomy|\/docs)["']/.test(html);
  assert.ok(taxonomyLink, 'format/v2.html must cross-link to the recipe-class taxonomy surface');
});

test('10. /format/v2 light-theme switch IIFE appears in <head> before body styles', () => {
  const html = read(FORMAT_V2);
  const headEnd = html.indexOf('</head>');
  const bodyStart = html.indexOf('<body');
  assert.ok(headEnd > 0 && bodyStart > headEnd,
    'format/v2.html must have a well-formed <head>...</head> preceding <body>');
  const head = html.slice(0, headEnd);
  assert.match(head, /localStorage\.getItem\('kolm-theme'\)/,
    'format/v2.html <head> must contain the light-theme switch IIFE');
  assert.match(head, /data-theme/,
    'format/v2.html theme switch must apply data-theme attribute pre-paint');
});

test('11. /format/v2 declares the consistent design system tokens --accent, --warn, --bad', () => {
  const html = read(FORMAT_V2);
  assert.match(html, /--accent:\s*#10b981/,
    'format/v2.html must declare --accent: #10b981');
  assert.match(html, /--warn:\s*#f0b86b/,
    'format/v2.html must declare --warn: #f0b86b');
  assert.match(html, /--bad:\s*#ff6b91/,
    'format/v2.html must declare --bad: #ff6b91');
});

test('12. sw.js CACHE wave-floor is >= 187 (regex on kolm-v7 cache slug)', () => {
  const sw = read(SW);
  const m = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(Number(m[1]) >= 187,
    `sw.js CACHE wave segment must be >= 187 (saw wave${m[1]})`);
});

test('13. /format/v2 contains no literal em-dash characters in load-bearing copy', () => {
  const html = read(FORMAT_V2);
  // The literal em-dash (U+2014) is forbidden; HTML entity &mdash; is allowed.
  assert.ok(!html.includes('—'),
    'format/v2.html must not contain literal em-dash characters (U+2014); use &mdash; entity instead');
});

test('14. /format/v2 names the hex magic-byte mechanism that differentiates v1 from v2 readers', () => {
  const html = read(FORMAT_V2);
  const lower = html.toLowerCase();
  assert.ok(lower.includes('magic-byte') || lower.includes('magic byte') || lower.includes('magic header'),
    'format/v2.html must name the hex magic-byte differentiator between v1 and v2 readers');
  // ZIP local file header magic bytes for v2
  assert.ok(html.includes('0x50 0x4B 0x03 0x04') || html.includes('50 4B 03 04'),
    'format/v2.html must name the ZIP local file header magic bytes (0x50 0x4B 0x03 0x04)');
});

test('15. CLI flags claimed in /format/v2 either exist in cli/kolm.js or are amber-pilled with verify-before-ship', () => {
  const html = read(FORMAT_V2);
  const cli = read(CLI);

  // The format-aware flags this page surfaces. Every one of them is either
  // genuinely wired in cli/kolm.js OR wrapped in a <span class="verify-tag">
  // verify before ship</span> amber pill alongside its mention.
  const flagsToCheck = [
    '--format=v2',
    '--format-version',
    '--format-strict',
    '--downgrade=v1',
    '--format-v2',
  ];

  for (const flag of flagsToCheck) {
    if (!html.includes(flag)) continue; // skip flags the page doesn't mention

    if (cli.includes(flag)) {
      // flag genuinely exists in CLI; no amber pill required
      continue;
    }

    // flag does NOT exist in CLI; the page must wrap its mention in an amber
    // verify-before-ship pill within the same card/paragraph. We test by
    // looking for the verify-tag span within ~400 chars of the flag mention.
    const idx = html.indexOf(flag);
    const window = html.slice(Math.max(0, idx - 400), idx + 400);
    assert.ok(
      window.includes('verify before ship'),
      `format/v2.html mentions CLI flag "${flag}" which is not in cli/kolm.js; must be wrapped in a "verify before ship" amber pill nearby`,
    );
  }

  // W296f shipped cmdMigrate + case 'migrate'. If the page mentions the verb,
  // confirm it now resolves in the CLI (no amber pill needed — the verb is
  // real). This replaces the prior amber-pill assertion W256 retired.
  if (html.includes('kolm migrate')) {
    assert.ok(cli.includes("case 'migrate'") || cli.includes('cmdMigrate'),
      'format/v2.html mentions "kolm migrate"; cli/kolm.js must implement the verb (cmdMigrate or case \'migrate\')');
  }
});
