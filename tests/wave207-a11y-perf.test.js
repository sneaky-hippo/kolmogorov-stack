// Wave 207: a11y + perf audit + patch — locks WCAG 2.2 AA basics and
// Lighthouse-perf soft floors across every public/*.html file (top-level
// and nested). Phase 2 of Shift 6 final-polish.
//
// Scope:
//   - lang attribute, viewport meta, non-empty <title>, single <h1>
//   - bare "here" / "click here" / "read more" link text
//   - <img alt> coverage (spot-check)
//   - positive tabindex anti-pattern (none allowed)
//   - sw.js cache slug wave floor >= 207
//   - no em-dashes or emoji added on pages edited this wave
//   - <main> landmark on at least 6 brief-listed pages
//   - skip-link present on / (landing)
//   - inputs have aria-label or wrapping label (spot-check)
//   - SVG icons have aria-hidden OR role=img on sampled pages
//   - no forbidden marketing fluff added on edited pages
//   - viewport contains width=device-width
//   - largest inline <script> on edited pages stays under 40 KB (soft floor)

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

// Walk public/ for all .html, skipping i18n (W209) and showcase/data.
function walkHtml(dir) {
  const out = [];
  function rec(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'i18n' || ent.name === 'showcase') continue;
        rec(full);
      } else if (/\.html$/i.test(ent.name)) {
        out.push(full);
      }
    }
  }
  rec(dir);
  return out;
}

const ALL_HTML = walkHtml(PUBLIC);
const rel = (p) => path.relative(PUBLIC, p).replace(/\\/g, '/');

// Pages edited in Wave 207 — held to a stricter floor (no em-dash or emoji
// added, plus the specific fix asserted).
const W207_EDITED = [
  'index.html',
  'pricing.html',
  'k-score.html',
  'verify-prod.html',
  'training.html',
  'privacy.html',
  'terms.html',
  'account.html',
  'dashboard.html',
  'quickstart.html',
  'receipt.html',
  'registry.html',
  'hub.html',
].map((f) => path.join(PUBLIC, f));

// Pages required to expose a <main> landmark after Wave 207.
const MAIN_REQUIRED = [
  'index.html',
  'pricing.html',
  'k-score.html',
  'verify-prod.html',
  'training.html',
  'privacy.html',
  'terms.html',
  'compare.html',
  'manifesto.html',
  'why-kolm.html',
  'spec.html',
  'taxonomy.html',
].map((f) => path.join(PUBLIC, f));

// Em-dash floor (raw + entity) for W207-edited pages. Numbers captured
// post-W207 so future waves cannot regress without bumping the floor.
// 0 means: page had no em-dashes; future copy must keep it that way.
const EMDASH_FLOOR = {
  'index.html': 1,
  'pricing.html': 6,
  'k-score.html': 0,
  'verify-prod.html': 6,
  'training.html': 12,
  'privacy.html': 0,
  'terms.html': 0,
  'account.html': 0,
  'dashboard.html': 17,
  'quickstart.html': 5,
  'receipt.html': 4,
  'registry.html': 6,
  'hub.html': 1,
};

const FLUFF = [
  'game-changing', 'revolutionary', 'world-class', 'best-in-class',
  'next-gen', 'blazing fast', 'blazing-fast', '10x marketing',
  'industry-leading', 'industry leading', 'enterprise-grade',
];

function bodyOf(html) {
  let body = html;
  body = body.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  body = body.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  return body;
}

test('1. every public/*.html declares <html lang="en"> (or correct localized lang for /lang/<locale>/* pages)', () => {
  // W277 shipped internationalization scaffolding under public/lang/<locale>/
  // where each localized page declares <html lang="<locale>">. The a11y rule
  // is "every page declares a lang", not "every page declares en" — so accept
  // the localized variant on the locale-prefixed paths.
  const offenders = [];
  for (const f of ALL_HTML) {
    const html = read(f);
    const tag = html.match(/<html\b[^>]*>/i);
    if (!tag) { offenders.push(rel(f) + ' (no <html>)'); continue; }
    const relPath = rel(f).replace(/\\/g, '/');
    const localeMatch = relPath.match(/^lang\/([a-z]{2}(?:-[A-Z]{2})?)\//);
    if (localeMatch) {
      const allowed = new RegExp(`\\blang\\s*=\\s*["']${localeMatch[1]}["']`, 'i');
      if (!allowed.test(tag[0])) offenders.push(rel(f) + ` (expected lang="${localeMatch[1]}")`);
    } else if (!/\blang\s*=\s*["']en["']/i.test(tag[0])) {
      offenders.push(rel(f));
    }
  }
  assert.equal(offenders.length, 0,
    `pages missing <html lang="en">: ${offenders.slice(0, 8).join(', ')}`);
});

test('2. every public/*.html has viewport meta with width=device-width', () => {
  const offenders = [];
  for (const f of ALL_HTML) {
    const html = read(f);
    const vp = html.match(/<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/i);
    if (!vp) { offenders.push(rel(f) + ' (no viewport)'); continue; }
    if (!/width\s*=\s*device-width/i.test(vp[0])) offenders.push(rel(f) + ' (no device-width)');
  }
  assert.equal(offenders.length, 0,
    `viewport offenders: ${offenders.slice(0, 8).join(', ')}`);
});

test('3. every public/*.html has a non-empty <title>', () => {
  const offenders = [];
  for (const f of ALL_HTML) {
    const html = read(f);
    const m = html.match(/<title>([\s\S]*?)<\/title>/i);
    if (!m || !m[1].trim()) offenders.push(rel(f));
  }
  assert.equal(offenders.length, 0,
    `pages with empty/missing title: ${offenders.slice(0, 8).join(', ')}`);
});

test('4. every public/*.html has at most one <h1>', () => {
  const offenders = [];
  for (const f of ALL_HTML) {
    const html = read(f);
    const opens = (html.match(/<h1\b/gi) || []).length;
    if (opens > 1) offenders.push(`${rel(f)} (n=${opens})`);
  }
  assert.equal(offenders.length, 0,
    `multiple-h1 offenders: ${offenders.slice(0, 8).join(', ')}`);
});

test('5. every content page has at least one <h1>', () => {
  // Allowance: 404.html and pure scaffolds may omit. We assert at least 200
  // pages out of 299 surface have an h1; nearly all do.
  let withH1 = 0;
  for (const f of ALL_HTML) {
    if (/<h1\b/i.test(read(f))) withH1++;
  }
  assert.ok(withH1 >= 200,
    `expected >= 200 pages with <h1>, got ${withH1} of ${ALL_HTML.length}`);
});

test('6. no bare "click here" link text site-wide', () => {
  const offenders = [];
  for (const f of ALL_HTML) {
    const html = read(f);
    const links = html.match(/<a\b[^>]*>([^<]{1,40})<\/a>/gi) || [];
    for (const a of links) {
      const txtM = a.match(/>([^<]*)</);
      const txt = (txtM ? txtM[1] : '').trim().toLowerCase();
      if (txt === 'click here') { offenders.push(rel(f)); break; }
    }
  }
  assert.equal(offenders.length, 0,
    `bare "click here" link in: ${offenders.slice(0, 8).join(', ')}`);
});

test('7. no bare "here" link text site-wide', () => {
  const offenders = [];
  for (const f of ALL_HTML) {
    const html = read(f);
    const links = html.match(/<a\b[^>]*>([^<]{1,12})<\/a>/gi) || [];
    for (const a of links) {
      const txtM = a.match(/>([^<]*)</);
      const txt = (txtM ? txtM[1] : '').trim().toLowerCase();
      if (txt === 'here') { offenders.push(rel(f)); break; }
    }
  }
  assert.equal(offenders.length, 0,
    `bare "here" link in: ${offenders.slice(0, 8).join(', ')}`);
});

test('8. every <img> has an alt attribute (site-wide spot-check)', () => {
  let totalImgs = 0;
  const offenders = [];
  for (const f of ALL_HTML) {
    const html = read(f);
    const imgs = html.match(/<img\b[^>]*>/gi) || [];
    totalImgs += imgs.length;
    for (const img of imgs) {
      if (!/\balt\s*=/i.test(img)) {
        offenders.push(`${rel(f)} ${img.slice(0, 80)}`);
        break;
      }
    }
  }
  assert.ok(totalImgs > 0, 'expected at least some <img> tags');
  assert.equal(offenders.length, 0,
    `<img> missing alt: ${offenders.slice(0, 5).join(' | ')}`);
});

test('9. no positive tabindex (2+) anti-pattern anywhere', () => {
  const offenders = [];
  for (const f of ALL_HTML) {
    const html = read(f);
    if (/\btabindex\s*=\s*["'](?:[2-9]|[1-9]\d+)["']/i.test(html)) {
      offenders.push(rel(f));
    }
  }
  assert.equal(offenders.length, 0,
    `positive tabindex in: ${offenders.slice(0, 5).join(', ')}`);
});

test('10. sw.js cache slug wave floor >= 207', () => {
  const sw = read(SW);
  const m = sw.match(/wave(\d+)/i);
  assert.ok(m, 'sw.js must contain wave<NNN> slug');
  const n = parseInt(m[1], 10);
  assert.ok(n >= 207, `sw.js wave floor ${n} below 207 (coordinator bump pending)`);
});

test('11. W207-edited pages did not introduce new em-dashes (floor lock)', () => {
  for (const f of W207_EDITED) {
    const html = read(f);
    const body = bodyOf(html);
    const hits = (body.match(/—|&mdash;|&#8212;|&#x2014;/g) || []).length;
    const slug = path.basename(f);
    const floor = EMDASH_FLOOR[slug] ?? 0;
    assert.ok(hits <= floor,
      `${slug}: em-dash count ${hits} exceeds W207 floor ${floor}`);
  }
});

test('12. W207-edited pages contain no emoji in visible body', () => {
  const offenders = [];
  for (const f of W207_EDITED) {
    const body = bodyOf(read(f));
    const hits = body.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F1FF}]/gu);
    if (hits && hits.length) offenders.push(`${path.basename(f)} (${hits.length})`);
  }
  assert.equal(offenders.length, 0,
    `emoji on W207-edited pages: ${offenders.join(', ')}`);
});

test('13. at least 12 pages expose a <main> landmark', () => {
  const offenders = [];
  for (const f of MAIN_REQUIRED) {
    if (!/<main\b/i.test(read(f))) offenders.push(path.basename(f));
  }
  assert.equal(offenders.length, 0,
    `<main> missing on: ${offenders.join(', ')}`);
});

test('14. landing /index.html exposes skip-to-content link with #main target', () => {
  const html = read(path.join(PUBLIC, 'index.html'));
  assert.match(html, /href=["']#main["']/, 'index.html missing #main skip-link target');
  assert.match(html, /<main\b[^>]*id\s*=\s*["']main["']/i,
    'index.html <main> missing id="main"');
  assert.match(html, /skip[\s-]?to[\s-]?content/i,
    'index.html skip-link text not found');
});

test('15. spot-check: account.html paste input has aria-label after fix', () => {
  const html = read(path.join(PUBLIC, 'account.html'));
  // Match the acct-paste input and confirm aria-label is present on same tag.
  const m = html.match(/<input[^>]*id=["']acct-paste["'][^>]*>/i);
  assert.ok(m, 'acct-paste input not found in account.html');
  assert.match(m[0], /aria-label\s*=/i,
    'account.html acct-paste input still missing aria-label');
});

test('16. spot-check: index.html ROI inputs gained aria-label', () => {
  const html = read(path.join(PUBLIC, 'index.html'));
  for (const id of ['vrc-calls', 'vrc-tin', 'vrc-tout', 'vrc-pin', 'vrc-pout']) {
    const re = new RegExp(`<input[^>]*id=["']${id}["'][^>]*>`, 'i');
    const m = html.match(re);
    assert.ok(m, `index.html input #${id} not found`);
    assert.match(m[0], /aria-label\s*=/i,
      `index.html #${id} still missing aria-label`);
  }
});

test('17. SVG icon a11y: sampled pages use aria-hidden OR role=img on every <svg>', () => {
  // Bare <svg> is acceptable when wrapped by an aria-hidden parent.
  const sampled = ['index.html', 'pricing.html', 'k-score.html'];
  for (const slug of sampled) {
    const html = read(path.join(PUBLIC, slug));
    const svgs = [...html.matchAll(/<svg\b[^>]*>/gi)];
    for (const m of svgs) {
      const tag = m[0];
      if (/aria-hidden\s*=\s*["']true["']/i.test(tag)) continue;
      if (/role\s*=\s*["']img["']/i.test(tag)) continue;
      // Check that the parent span/div within 200 chars before is aria-hidden.
      const back = html.slice(Math.max(0, m.index - 200), m.index);
      assert.match(back, /aria-hidden\s*=\s*["']true["']/i,
        `${slug}: bare <svg> without aria-hidden parent: ${tag.slice(0, 100)}`);
    }
  }
});

test('18. no marketing fluff added on W207-edited pages', () => {
  const offenders = [];
  for (const f of W207_EDITED) {
    const text = read(f).toLowerCase();
    for (const word of FLUFF) {
      if (text.includes(word.toLowerCase())) offenders.push(`${path.basename(f)} :: "${word}"`);
    }
  }
  assert.equal(offenders.length, 0,
    `fluff on W207-edited: ${offenders.slice(0, 5).join(' | ')}`);
});

test('19. largest inline <script> on W207-edited pages stays under 50 KB (soft floor)', () => {
  // Hard ceiling chosen above current largest (dashboard.html ~39 KB,
  // index.html ~37 KB) so future waves can grow without violating but
  // catastrophic bloat is flagged.
  const offenders = [];
  for (const f of W207_EDITED) {
    const html = read(f);
    const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    let largest = 0;
    for (const s of scripts) if (s[1].length > largest) largest = s[1].length;
    if (largest > 50 * 1024) offenders.push(`${path.basename(f)} (${largest} bytes)`);
  }
  assert.equal(offenders.length, 0,
    `inline-script bloat: ${offenders.join(', ')}`);
});

test('20. no <meta name="viewport"> tag uses user-scalable=no (a11y anti-pattern)', () => {
  const offenders = [];
  for (const f of ALL_HTML) {
    const html = read(f);
    const vp = html.match(/<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/i);
    if (!vp) continue;
    if (/user-scalable\s*=\s*["']?no["']?/i.test(vp[0])) offenders.push(rel(f));
    if (/maximum-scale\s*=\s*["']?1(\.0)?["']?/i.test(vp[0])) offenders.push(rel(f) + ' (max-scale=1)');
  }
  assert.equal(offenders.length, 0,
    `viewport blocks zoom: ${offenders.slice(0, 5).join(', ')}`);
});
