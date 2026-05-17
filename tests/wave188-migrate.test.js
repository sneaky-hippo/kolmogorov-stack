// Wave 188 — /migrate index + 5 per-competitor migration guides.
// Locks in the W144 Doc 3 Shift 3 migration-from-competitor surface so the
// 5-competitor /how-vs-* series (W169) now has a paired migration path
// at /migrate/<slug>. Each assertion ties one piece of rendered prose to a
// frozen W169 honesty pattern (complement framing for LoRAX, Rubrik mention
// for Predibase, capture-then-compile for OpenPipe, named DIY components,
// always-safe --teacher=local: for hyperscaler), or to a load-bearing
// design token / theme switch / cache-floor / cross-link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const MIGRATE_INDEX = path.join(PUBLIC, 'migrate.html');
const MIGRATE_DIR = path.join(PUBLIC, 'migrate');
const SW = path.join(PUBLIC, 'sw.js');

const SLUGS = ['lorax', 'predibase', 'openpipe', 'diy', 'hyperscaler'];
const COMPETITOR_PAGES = Object.fromEntries(
  SLUGS.map((s) => [s, path.join(MIGRATE_DIR, `${s}.html`)]),
);

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /migrate index exists on disk and is > 14 KB', () => {
  assert.ok(fs.existsSync(MIGRATE_INDEX), `migrate.html missing at ${MIGRATE_INDEX}`);
  const stat = fs.statSync(MIGRATE_INDEX);
  assert.ok(stat.size > 14 * 1024,
    `migrate.html too small (${stat.size} bytes; expected > 14 KB)`);
});

test('2. All five per-competitor pages exist and are > 8 KB each', () => {
  for (const slug of SLUGS) {
    const p = COMPETITOR_PAGES[slug];
    assert.ok(fs.existsSync(p), `migrate/${slug}.html missing at ${p}`);
    const stat = fs.statSync(p);
    assert.ok(stat.size > 8 * 1024,
      `migrate/${slug}.html too small (${stat.size} bytes; expected > 8 KB)`);
  }
});

test('3. Each page declares the correct canonical URL', () => {
  const idx = read(MIGRATE_INDEX);
  assert.match(idx, /<link rel="canonical" href="https:\/\/kolm\.ai\/migrate"/,
    'migrate.html must declare canonical https://kolm.ai/migrate');
  for (const slug of SLUGS) {
    const html = read(COMPETITOR_PAGES[slug]);
    const expected = new RegExp(`<link rel="canonical" href="https://kolm\\.ai/migrate/${slug}"`);
    assert.match(html, expected,
      `migrate/${slug}.html must declare canonical https://kolm.ai/migrate/${slug}`);
  }
});

test('4. Every page carries the Wave 188 self-stamp', () => {
  const all = [MIGRATE_INDEX, ...SLUGS.map((s) => COMPETITOR_PAGES[s])];
  for (const p of all) {
    const html = read(p).toLowerCase();
    assert.ok(html.includes('wave 188'),
      `${path.basename(p)} must self-stamp wave 188`);
  }
});

test('5. /migrate index links to all five per-competitor pages', () => {
  const html = read(MIGRATE_INDEX);
  for (const slug of SLUGS) {
    const expected = new RegExp(`href="/migrate/${slug}"`);
    assert.match(html, expected,
      `migrate.html must link to /migrate/${slug}`);
  }
});

test('6. Each per-competitor page back-links to /migrate AND to its /how-vs-<slug>', () => {
  for (const slug of SLUGS) {
    const html = read(COMPETITOR_PAGES[slug]);
    assert.match(html, /href="\/migrate"/,
      `migrate/${slug}.html must back-link to /migrate index`);
    const howVs = new RegExp(`href="/how-vs-${slug}"`);
    assert.match(html, howVs,
      `migrate/${slug}.html must link to its matching /how-vs-${slug} teardown`);
  }
});

test('7. /migrate index links to /compare, /recipe-classes, /k-score-explained, /format/v2', () => {
  const html = read(MIGRATE_INDEX);
  for (const href of ['/compare', '/recipe-classes', '/k-score-explained', '/format/v2']) {
    const expected = new RegExp(`href="${href.replace(/\//g, '\\/')}"`);
    assert.match(html, expected,
      `migrate.html must link to ${href}`);
  }
});

test('8. Each per-competitor page has a 4-step CLI flow (four step cards)', () => {
  for (const slug of SLUGS) {
    const html = read(COMPETITOR_PAGES[slug]);
    for (const n of ['01', '02', '03', '04']) {
      const tag = new RegExp(`${n}\\s*&middot;`);
      assert.match(html, tag,
        `migrate/${slug}.html must include step "${n}" of the 4-step CLI flow`);
    }
  }
});

test('9. Each per-competitor page has the survives/adds two-column comparison', () => {
  for (const slug of SLUGS) {
    const html = read(COMPETITOR_PAGES[slug]);
    assert.ok(html.includes('Survives the migration'),
      `migrate/${slug}.html must include "Survives the migration" column`);
    assert.ok(html.includes('kolm adds on top'),
      `migrate/${slug}.html must include "kolm adds on top" column`);
  }
});

test('10. Each per-competitor page names at least one "stay with competitor" honest-scope case', () => {
  // Per W169 lesson: every competitor surface should name 2-4 cases
  // where the competitor is the right answer. The honest-scope section is
  // marked by the "Where ... is the right answer" h2 plus the .honest block.
  for (const slug of SLUGS) {
    const html = read(COMPETITOR_PAGES[slug]);
    assert.match(html, /Where[\s\S]{0,80}is the right answer\./i,
      `migrate/${slug}.html must include a "Where ... is the right answer" honest-scope section`);
    assert.match(html, /<div class="honest">/,
      `migrate/${slug}.html must include a styled .honest block citing at least one stay-with-competitor case`);
  }
});

test('11. Light-theme switch IIFE appears in <head> BEFORE body styles on all 6 pages', () => {
  const all = [MIGRATE_INDEX, ...SLUGS.map((s) => COMPETITOR_PAGES[s])];
  for (const p of all) {
    const html = read(p);
    const iifeIdx = html.indexOf("kolm-theme");
    const bodyStyleIdx = html.indexOf('body{background:var(--bg)');
    assert.ok(iifeIdx > 0,
      `${path.basename(p)} must include the kolm-theme localStorage IIFE`);
    assert.ok(bodyStyleIdx > 0,
      `${path.basename(p)} must define body styles`);
    assert.ok(iifeIdx < bodyStyleIdx,
      `${path.basename(p)} must have the theme IIFE before body styles (pre-paint)`);
    // IIFE must appear in the <head>
    const headEnd = html.indexOf('</head>');
    assert.ok(iifeIdx < headEnd,
      `${path.basename(p)} theme IIFE must be inside <head>`);
  }
});

test('12. Design tokens --accent, --warn, --bad present on all 6 pages', () => {
  const all = [MIGRATE_INDEX, ...SLUGS.map((s) => COMPETITOR_PAGES[s])];
  for (const p of all) {
    const html = read(p);
    for (const token of ['--accent:', '--warn:', '--bad:']) {
      assert.ok(html.includes(token),
        `${path.basename(p)} must define design token "${token}"`);
    }
  }
});

test('13. sw.js cache-floor wave >= 188 (regex-derived, monotonic)', () => {
  // Per W171 lesson: lock-in tests on monotonically-increasing values must
  // use >= not equality so future cache bumps don't regress.
  const sw = read(SW);
  const m = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, `sw.js cache constant must match the expected slug pattern`);
  const wave = parseInt(m[1], 10);
  assert.ok(wave >= 188,
    `sw.js cache wave must be >= 188 (found wave ${wave} in slug "${m[0]}")`);
});

test('14. No em-dashes in load-bearing copy on any page', () => {
  const all = [MIGRATE_INDEX, ...SLUGS.map((s) => COMPETITOR_PAGES[s])];
  for (const p of all) {
    const html = read(p);
    assert.ok(!html.includes('—'),
      `${path.basename(p)} must not contain em-dashes (\\u2014)`);
  }
});

test('15. Hyperscaler page cites --teacher=local: licensing fallback (W169 honesty)', () => {
  const html = read(COMPETITOR_PAGES.hyperscaler);
  assert.ok(html.includes('--teacher=local:'),
    'migrate/hyperscaler.html must cite the --teacher=local: always-safe licensing fallback');
  assert.match(html, /licensing|license/i,
    'migrate/hyperscaler.html must discuss licensing posture for the carve-out');
});

test('16. LoRAX page uses complement framing (verb "add" present, not "replace"/"vs")', () => {
  const html = read(COMPETITOR_PAGES.lorax);
  const lower = html.toLowerCase();
  // Must use "add to" framing (the W169 complement pattern)
  assert.ok(lower.includes('add kolm to your lorax'),
    'migrate/lorax.html must use the W169 "add kolm to your LoRAX stack" complement framing');
  assert.ok(lower.includes('complement'),
    'migrate/lorax.html must name the complement-not-replacement positioning');
  // Hero h1 must not read as a rip-and-replace
  const heroH1 = html.match(/<h1>([^<]*)<\/h1>/);
  assert.ok(heroH1, 'migrate/lorax.html must have an <h1>');
  assert.ok(!/replace/i.test(heroH1[1]),
    `migrate/lorax.html hero h1 must not use "replace" framing (got: "${heroH1[1]}")`);
});

test('17. DIY page names LLaMA-Factory, Axolotl, or Unsloth (W169 stack)', () => {
  const html = read(COMPETITOR_PAGES.diy);
  const named = ['LLaMA-Factory', 'Axolotl', 'Unsloth'];
  const present = named.filter((n) => html.includes(n));
  assert.ok(present.length >= 1,
    `migrate/diy.html must name at least one of ${named.join(', ')} (found: ${present.join(', ') || 'none'})`);
  // All three should be named since the W169 page does
  assert.ok(present.length === 3,
    `migrate/diy.html should name all three DIY stack components (found: ${present.join(', ')})`);
});

test('18. Predibase page mentions Rubrik acquisition (W169 named June 2025)', () => {
  const html = read(COMPETITOR_PAGES.predibase);
  assert.match(html, /Rubrik/,
    'migrate/predibase.html must mention Rubrik (the June 2025 acquirer per W169)');
  assert.match(html, /June 2025|June\s*2025/i,
    'migrate/predibase.html must cite the June 2025 acquisition date per W169');
});

test('19. Each page includes the kolm site header navigation', () => {
  const all = [MIGRATE_INDEX, ...SLUGS.map((s) => COMPETITOR_PAGES[s])];
  for (const p of all) {
    const html = read(p);
    assert.match(html, /<header class="site">/,
      `${path.basename(p)} must include the standard site header`);
    assert.match(html, /class="logo"[^>]*>k o l m</,
      `${path.basename(p)} must include the kolm logo link`);
  }
});

test('20. Amber verbs ("kolm import"/"kolm wrap"/"kolm proxy") used as CLI carry "verify before ship" pill', () => {
  // Verbs that do NOT ship and must carry "verify before ship" pill where used as CLI.
  // Detection: match `<b>kolm <amber_verb></b>` or `kolm <amber_verb>` followed by
  // whitespace + a CLI-style argument (--flag, identifier with dashes, or a path).
  // This avoids false-positives from prose like "the kolm wrap is engineering cost".
  const AMBER = ['import', 'wrap', 'proxy'];
  for (const slug of SLUGS) {
    const html = read(COMPETITOR_PAGES[slug]);
    for (const v of AMBER) {
      // CLI-shape match: kolm <verb> inside a <b> tag (terminal/cli convention)
      const cliShape = new RegExp(
        `<b>\\s*kolm\\s+${v}\\b|kolm\\s+${v}\\s+(?:--|[a-z][a-z0-9_-]*\\s|<)`,
        'gi',
      );
      const cliMatches = [...html.matchAll(cliShape)];
      if (cliMatches.length > 0) {
        assert.ok(/verify before ship/i.test(html),
          `migrate/${slug}.html uses amber CLI verb "kolm ${v}" (${cliMatches.length} match(es)) but is missing the "verify before ship" pill`);
      }
    }
  }
});

test('21. Index page enumerates the 4-bullet "what gets preserved" and "what kolm adds" sections', () => {
  const html = read(MIGRATE_INDEX);
  // Both required headers
  assert.match(html, /What gets preserved when you migrate\./i,
    'migrate.html must include the "What gets preserved" section');
  assert.match(html, /What kolm adds on top|kolm adds/,
    'migrate.html must include the "What kolm adds" column');
  // The 4 preserved bullets named in the spec
  for (const term of ['Training data', 'Recipe semantics', 'Eval set', 'Team workflow']) {
    assert.ok(html.includes(term),
      `migrate.html "What gets preserved" must name "${term}"`);
  }
  // The 4 added bullets named in the spec
  for (const term of ['Receipt chain', 'K-score gate', 'Signed artifact', 'Portable']) {
    assert.ok(html.includes(term),
      `migrate.html "What kolm adds" must name "${term}"`);
  }
});

test('22. Index CLI reference table marks import/wrap/proxy as "verify before ship"', () => {
  const html = read(MIGRATE_INDEX);
  for (const verb of ['kolm import', 'kolm wrap', 'kolm proxy']) {
    assert.ok(html.includes(verb),
      `migrate.html CLI reference must surface "${verb}" so the per-competitor guides line up`);
  }
  // The amber-pill convention must be present
  assert.match(html, /verify before ship/i,
    'migrate.html CLI reference table must use the "verify before ship" amber-pill convention for unshipped verbs');
});
