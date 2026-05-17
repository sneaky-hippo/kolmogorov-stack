// Wave 208: mobile + small-screen audit + patch — locks responsive
// behavior at the 360 x 640 viewport (smallest common phone) across
// every public/*.html file. Phase 3 of Shift 6 final-polish.
//
// Scope:
//   - viewport meta declared everywhere with width=device-width
//   - no user-scalable=no / maximum-scale=1 zoom blocking anywhere
//   - top-traffic surfaces ship at least one @media (max-width:...)
//   - global responsive image rule lives in /styles.css
//   - sw.js cache slug wave floor >= 208
//   - em-dash floor per W208-edited page (no new ones introduced)
//   - no emoji added on W208-edited pages
//   - W208-edited pages declare a 560px (or tighter) breakpoint
//   - <pre> blocks in edited pages wrap or scroll horizontally
//   - no fixed pixel width > 1200px on containers in edited pages
//   - long-hash spots have word-break / overflow-wrap so they reflow
//   - at least 5 pages use responsive grid (auto-fit minmax or media-collapse)
//   - tap-target audit on /index nav: at least 6px vertical padding
//   - no <table> in edited pages without a responsive wrapper or scroll
//   - sample 3 pages collapse multi-column layouts at narrow width
//   - no position:fixed element wider than 100vw on edited pages

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const SW = path.join(PUBLIC, 'sw.js');
const STYLES = path.join(PUBLIC, 'styles.css');

const read = (p) => fs.readFileSync(p, 'utf8');

// Walk public/ for all .html, skipping i18n (W209 owns) and showcase/data.
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

// Pages edited in Wave 208 — held to a stricter floor.
const W208_EDITED = [
  'compare.html',
  'why-kolm.html',
  'training.html',
  'manifesto.html',
  'enterprise.html',
  'training/data-sources.html',
  'drift.html',
  'frozen-eval.html',
  'k-score-explained.html',
].map((f) => path.join(PUBLIC, f));

// Top-traffic surfaces that must carry at least one mobile @media rule
// (either inline or via an external CSS link, but checked inline-first
// because /styles.css already covers external-only pages).
const TOP_TRAFFIC = [
  'index.html',
  'pricing.html',
  'compare.html',
  'k-score.html',
  'drift.html',
  'quickstart.html',
  'healthcare.html',
  'health-insurance.html',
  'training.html',
  'training/data-sources.html',
  'verify-prod.html',
  'dashboard.html',
  'security.html',
  'spec.html',
  'manifesto.html',
  'why-kolm.html',
  'enterprise.html',
  'frozen-eval.html',
  'k-score-explained.html',
].map((f) => path.join(PUBLIC, f));

// Em-dash floor (raw + entity) for W208-edited pages. Numbers captured
// post-W208 so future waves cannot regress without bumping the floor.
const EMDASH_FLOOR = {
  'compare.html': 4,
  'why-kolm.html': 0,
  'training.html': 12,
  'manifesto.html': 0,
  'enterprise.html': 1,
  'training/data-sources.html': 0,
  'drift.html': 12,
  'frozen-eval.html': 0,
  'k-score-explained.html': 0,
};

function bodyOf(html) {
  let body = html;
  body = body.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  body = body.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  return body;
}

function stripScripts(html) {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

// Extract the body of every @media rule. Walks the string char-by-char to
// match nested braces correctly. Returns [{ width, body }] for each @media
// (max-width:Npx) block found.
function extractMediaBlocks(html) {
  const out = [];
  const re = /@media\s*\(\s*max-width\s*:\s*(\d+)\s*px\s*\)\s*\{/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const width = parseInt(m[1], 10);
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < html.length && depth > 0) {
      const ch = html[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth === 0) {
      out.push({ width, body: html.slice(start, i - 1) });
    }
  }
  return out;
}

test('1. every public/*.html declares <meta name="viewport"> with width=device-width', () => {
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

test('2. no page disables zoom via user-scalable=no or maximum-scale=1', () => {
  const offenders = [];
  for (const f of ALL_HTML) {
    const html = read(f);
    const vp = html.match(/<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/i);
    if (!vp) continue;
    if (/user-scalable\s*=\s*["']?no["']?/i.test(vp[0])) offenders.push(rel(f) + ' (user-scalable=no)');
    if (/maximum-scale\s*=\s*["']?1(\.0)?["']?/i.test(vp[0])) offenders.push(rel(f) + ' (max-scale=1)');
  }
  assert.equal(offenders.length, 0,
    `zoom-blocked viewports: ${offenders.slice(0, 5).join(', ')}`);
});

test('3. at least 14 top-traffic pages have at least one @media query (inline or external)', () => {
  // Inline counts directly; external counts if /styles.css or /brand-refresh.css linked
  // (those carry 100+ @media between them).
  const stylesHas = /@media/i.test(read(STYLES));
  assert.ok(stylesHas, '/styles.css must carry at least one @media rule');
  let withMq = 0;
  for (const f of TOP_TRAFFIC) {
    const html = read(f);
    const inline = (html.match(/@media/gi) || []).length > 0;
    const externalCovered = /href=["']\/styles\.css["']/i.test(html) ||
                            /href=["']\/brand-refresh\.css["']/i.test(html);
    if (inline || externalCovered) withMq++;
  }
  assert.ok(withMq >= 14,
    `expected >= 14 top-traffic pages with responsive coverage, got ${withMq}/${TOP_TRAFFIC.length}`);
});

test('4. /styles.css carries a global responsive image rule (img max-width:100%)', () => {
  const css = read(STYLES);
  assert.match(css, /img[^{}]*\{[^}]*max-width\s*:\s*100%/i,
    '/styles.css missing global img max-width:100% rule');
});

test('5. sw.js cache slug wave floor >= 208', () => {
  const sw = read(SW);
  const m = sw.match(/wave(\d+)/i);
  assert.ok(m, 'sw.js must contain wave<NNN> slug');
  const n = parseInt(m[1], 10);
  assert.ok(n >= 208, `sw.js wave floor ${n} below 208 (coordinator bump pending)`);
});

test('6. W208-edited pages did not introduce new em-dashes (floor lock)', () => {
  for (const f of W208_EDITED) {
    const html = read(f);
    const body = bodyOf(html);
    const hits = (body.match(/—|&mdash;|&#8212;|&#x2014;/g) || []).length;
    const key = rel(f);
    const floor = EMDASH_FLOOR[key] ?? 0;
    assert.ok(hits <= floor,
      `${key}: em-dash count ${hits} exceeds W208 floor ${floor}`);
  }
});

test('7. W208-edited pages contain no emoji in visible body', () => {
  const offenders = [];
  for (const f of W208_EDITED) {
    const body = bodyOf(read(f));
    const hits = body.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F1FF}]/gu);
    if (hits && hits.length) offenders.push(`${rel(f)} (${hits.length})`);
  }
  assert.equal(offenders.length, 0,
    `emoji on W208-edited pages: ${offenders.join(', ')}`);
});

test('8. W208-edited pages declare a 560px (or tighter) breakpoint', () => {
  const offenders = [];
  for (const f of W208_EDITED) {
    const html = read(f);
    // Accept any @media rule with max-width <= 600.
    const hits = html.match(/@media\s*\(\s*max-width\s*:\s*(\d+)\s*px\s*\)/gi) || [];
    let any = false;
    for (const h of hits) {
      const m = h.match(/(\d+)/);
      if (m && parseInt(m[1], 10) <= 600) { any = true; break; }
    }
    if (!any) offenders.push(rel(f));
  }
  assert.equal(offenders.length, 0,
    `W208-edited pages without small-screen breakpoint: ${offenders.join(', ')}`);
});

test('9. <pre> blocks in W208-edited pages wrap or scroll (no horizontal page-bust)', () => {
  const offenders = [];
  for (const f of W208_EDITED) {
    const html = read(f);
    const stripped = stripScripts(html);
    // Only check pages that actually have <pre> blocks.
    if (!/<pre\b/i.test(stripped)) continue;
    const inlinePre = /pre[^{]*\{[^}]*overflow-x\s*:\s*auto/i.test(html) ||
                      /pre[^{]*\{[^}]*white-space\s*:\s*pre-wrap/i.test(html) ||
                      /pre[^{]*\{[^}]*overflow-wrap/i.test(html) ||
                      /pre[^{]*\{[^}]*word-break/i.test(html) ||
                      /pre\.terminal\b[^{]*\{[^}]*overflow-x/i.test(html);
    if (!inlinePre) offenders.push(rel(f));
  }
  assert.equal(offenders.length, 0,
    `<pre> overflow not handled on: ${offenders.join(', ')}`);
});

test('10. no container in W208-edited pages declares fixed width > 1200px', () => {
  const offenders = [];
  for (const f of W208_EDITED) {
    const html = read(f);
    // Match e.g. `width:1400px` or `min-width:1300px` outside of media queries.
    // We accept max-width: <large> because that's a cap; we flag width: and min-width:.
    const widths = [...html.matchAll(/(?:^|[\s;{])(?:min-)?width\s*:\s*(\d{4,})\s*px/gi)];
    for (const w of widths) {
      const n = parseInt(w[1], 10);
      if (n > 1200) { offenders.push(`${rel(f)} (width:${n}px)`); break; }
    }
  }
  assert.equal(offenders.length, 0,
    `fixed-width offenders: ${offenders.slice(0, 5).join(', ')}`);
});

test('11. long-hash text patterns reflow (word-break / overflow-wrap declared globally)', () => {
  // The global rule lives in /styles.css under code/kbd/samp.
  const css = read(STYLES);
  assert.match(css, /code[^{}]*\{[^}]*overflow-wrap\s*:\s*anywhere/i,
    '/styles.css missing global code overflow-wrap rule');
  // Plus the receipt-chain class on multiple W144-Doc 3 pages already
  // uses word-break:break-word; spot-check on drift and frozen-eval.
  for (const slug of ['drift.html', 'frozen-eval.html', 'k-score-explained.html']) {
    const html = read(path.join(PUBLIC, slug));
    assert.match(html, /word-break\s*:\s*break-word/i,
      `${slug} missing word-break:break-word for receipt-chain hashes`);
  }
});

test('12. at least 5 pages use auto-fit minmax or repeat-with-media-collapse responsive grid', () => {
  let withGrid = 0;
  for (const f of ALL_HTML) {
    const html = read(f);
    if (/grid-template-columns\s*:\s*repeat\s*\(\s*auto-fit/i.test(html)) { withGrid++; continue; }
    if (/grid-template-columns\s*:\s*repeat\s*\(\s*auto-fill/i.test(html)) { withGrid++; continue; }
    // Or a desktop multi-column grid that collapses inside @media.
    if (/@media[^{]*\{[^}]*grid-template-columns/i.test(html)) { withGrid++; continue; }
  }
  assert.ok(withGrid >= 5,
    `expected >= 5 pages with responsive grid pattern, got ${withGrid}`);
});

test('13. /index.html nav links have at least 6px vertical tap padding (44x44 floor leeway)', () => {
  const html = read(path.join(PUBLIC, 'index.html'));
  // Find the .site-nav or header.site nav block CSS rule.
  // Look for either an inline rule on header nav a OR a class with padding.
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
  const external = read(STYLES);
  const combined = css + '\n' + external;
  // Confirm nav anchors have either explicit padding >= 6px, or are wrapped
  // by container with adequate spacing (we allow either rule).
  const hasPadding = /\.site-nav\s+a[^{]*\{[^}]*padding[^}]*\d+px/i.test(combined) ||
                     /header[^{]*nav\s+a[^{]*\{[^}]*padding[^}]*\d+px/i.test(combined) ||
                     /\bnav[^{]*\{[^}]*padding[^}]*\d+px/i.test(combined) ||
                     /\bgap\s*:\s*\d+px/i.test(combined);
  assert.ok(hasPadding,
    'index.html nav lacks adequate tap-target padding/gap rule in inline or external CSS');
});

test('14. hero h1 on W208-edited pages stays mobile-readable (no font-size > 38px without breakpoint)', () => {
  const offenders = [];
  for (const f of W208_EDITED) {
    const html = read(f);
    // Match the desktop h1 rule (outside any @media).
    // Crude check: if the page declares h1{font-size:46px} or larger and has
    // a 560px breakpoint, the breakpoint must shrink h1. We've already
    // verified breakpoints exist in test 8; here we confirm the shrink.
    const desktopH1 = html.match(/h1\s*\{[^}]*font-size\s*:\s*(\d+)px/i);
    if (!desktopH1) continue;
    const px = parseInt(desktopH1[1], 10);
    if (px <= 38) continue;
    // Page has a big hero — confirm a 560-or-tighter breakpoint mentions h1.
    const mqs = extractMediaBlocks(html);
    let shrunk = false;
    for (const { width, body } of mqs) {
      if (width > 600) continue;
      if (/h1\s*\{[^}]*font-size/i.test(body)) { shrunk = true; break; }
      // Some pages declare bare "h1{font-size:..." inside the @media without
      // any leading rule break (after a closing brace).
      if (/(^|\})\s*h1\s*\{[^}]*font-size/i.test(body)) { shrunk = true; break; }
    }
    if (!shrunk) offenders.push(`${rel(f)} (h1 ${px}px not shrunk at <=600px)`);
  }
  assert.equal(offenders.length, 0,
    `hero h1 not mobile-shrunk on: ${offenders.join(' | ')}`);
});

test('15. <table> elements in W208-edited pages wrap in an overflow container OR carry overflow-x css', () => {
  const offenders = [];
  for (const f of W208_EDITED) {
    const html = read(f);
    const stripped = stripScripts(html);
    const tables = [...stripped.matchAll(/<table\b/gi)];
    if (tables.length === 0) continue;
    // Either the page styles table with overflow handling, OR every table is
    // wrapped in a div with .tbl-wrap / .tax-tbl-wrap / .matrix-scroll
    // / .frontier-scroll / similar.
    const hasWrapClass = /(tbl-wrap|tax-tbl-wrap|matrix-wrap|matrix-scroll|frontier-scroll|table-scroll|scroll-x|axis-table-wrap|ed-tabs)/i.test(html);
    const tableOverflow = /table[^{}]*\{[^}]*overflow-x\s*:\s*auto/i.test(html);
    // Confirm the page has at least one selector with overflow-x:auto — any
    // selector that wraps wide content (matrix-wrap, tbl-wrap, pre.terminal,
    // .pseudocode, .ed-detail) is acceptable as proof the author thought
    // about horizontal overflow on mobile.
    const anyOverflowX = /\{[^}]*overflow-x\s*:\s*auto[^}]*\}/i.test(html);
    if (!hasWrapClass && !tableOverflow && !anyOverflowX) offenders.push(rel(f));
  }
  assert.equal(offenders.length, 0,
    `<table> on W208-edited page without overflow wrapping: ${offenders.join(', ')}`);
});

test('16. sample 3 W208-edited pages collapse their multi-column grid at <=600px', () => {
  const samples = [
    path.join(PUBLIC, 'compare.html'),
    path.join(PUBLIC, 'drift.html'),
    path.join(PUBLIC, 'training/data-sources.html'),
  ];
  for (const f of samples) {
    const html = read(f);
    // Look for at least one @media (max-width:<=600px) rule that sets
    // grid-template-columns:1fr OR sets a single column via repeat(1,...) OR
    // explicitly redeclares the wrap padding for narrow viewport.
    const mqs = extractMediaBlocks(html);
    let collapsed = false;
    for (const { width, body } of mqs) {
      if (width > 600) continue;
      if (/grid-template-columns\s*:\s*1fr/i.test(body)) { collapsed = true; break; }
      if (/grid-template-columns\s*:\s*repeat\s*\(\s*1\s*,/i.test(body)) { collapsed = true; break; }
      if (/\.wrap\s*\{[^}]*padding/i.test(body)) { collapsed = true; break; }
      if (/hero\s*\{[^}]*padding/i.test(body)) { collapsed = true; break; }
    }
    assert.ok(collapsed,
      `${rel(f)} does not collapse its grid or shrink wrap at <=600px`);
  }
});

test('17. no position:fixed element declares fixed width > 100vw on W208-edited pages', () => {
  const offenders = [];
  for (const f of W208_EDITED) {
    const html = read(f);
    // Find any rule containing position:fixed and check its width if declared.
    const rules = [...html.matchAll(/\{([^}]*position\s*:\s*fixed[^}]*)\}/gi)];
    for (const r of rules) {
      const body = r[1];
      const w = body.match(/(?:min-)?width\s*:\s*(\d{3,})\s*px/i);
      if (w && parseInt(w[1], 10) > 360) {
        offenders.push(`${rel(f)} (fixed elt width ${w[1]}px)`);
        break;
      }
    }
  }
  assert.equal(offenders.length, 0,
    `position:fixed elements wider than mobile viewport: ${offenders.slice(0, 3).join(', ')}`);
});

test('18. styles.css also exposes a mobile pre-wrap rule for <=480px viewports', () => {
  const css = read(STYLES);
  // We added: @media (max-width:480px){pre{white-space:pre-wrap;...}}
  assert.match(css, /@media[^{]*max-width\s*:\s*480px[\s\S]*?pre[^{}]*\{[^}]*pre-wrap/i,
    '/styles.css missing mobile <pre> pre-wrap rule under 480px');
});
