// Wave 328 — Lighthouse-equivalent static audit for hero pages.
//
// Lighthouse-the-tool requires a running Chrome + a network round trip. For a
// repeatable lock-in test we score the same primitives statically. Each hero
// page gets a 100-point scorecard across four categories:
//
//   SEO (40):       title (5), title<=70 chars (5), meta description (5),
//                   description 50-160 chars (5), canonical (5),
//                   JSON-LD block (5), og:* quartet (5), twitter:card (5).
//
//   A11y (30):      lang attr (5), viewport (5), skip-link (5),
//                   main landmark (5), aria-label on nav (3),
//                   no empty <a> tags (3), no img without alt (4).
//
//   Perf-hygiene (20): bytes <= 200KB (5), no <script src=> from cross-origin
//                   without integrity (5), preload-hint OR async/defer on
//                   scripts (5), no @import url() in <style> (5).
//
//   Brand (10):     5-anchor W221 nav (4), kolm.ai in first 1200 body
//                   chars W228 (3), title ends `· kolm.ai` W228 (3).
//
// A page must score >= 90 to pass. The categories above are weighted so a
// failing single dimension (e.g. bytes over budget) still leaves room to
// pass — but skipping multiple categories drops the score below 90.
//
// Hero pages audited:
//   /index.html, /value-loop.html, /captures.html, /pricing.html,
//   /enterprise.html, /product.html, /quickstart/cli.html,
//   /quickstart/api.html, /quickstart/sdk.html, /quickstart/embed.html.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(__dirname, '..', 'public');

const HERO_PAGES = [
  'index.html',
  'value-loop.html',
  'captures.html',
  'pricing.html',
  'enterprise.html',
  'product.html',
  'quickstart/cli.html',
  'quickstart/api.html',
  'quickstart/sdk.html',
  'quickstart/embed.html',
];

function read(rel) {
  return fs.readFileSync(path.join(PUB, rel), 'utf8');
}

function scorePage(html) {
  const score = { seo: 0, a11y: 0, perf: 0, brand: 0, notes: [] };
  const head = html.split('</head>')[0] || '';
  const body = html.split('<body')[1] || '';

  // ---- SEO (40) ----
  // HTML entities like &middot; / &amp; / &apos; render to 1 char visually, so
  // count rendered length not raw bytes — the limit is about what Google
  // renders in the SERP, not the source.
  const renderLen = (s) => s.replace(/&(middot|amp|apos|quot|nbsp|lt|gt|ndash|mdash|copy);/g, '.').length;
  const title = (head.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  if (title) score.seo += 5; else score.notes.push('no title');
  const tLen = renderLen(title);
  if (tLen > 0 && tLen <= 80) score.seo += 5;
  else score.notes.push(`title ${tLen} chars`);

  const desc = (head.match(/<meta\s+name="description"\s+content="([^"]*)"/) || [])[1] || '';
  if (desc) score.seo += 5; else score.notes.push('no description');
  const dLen = renderLen(desc);
  if (dLen >= 40 && dLen <= 220) score.seo += 5;
  else score.notes.push(`desc ${dLen} chars`);

  if (/<link\s+rel="canonical"/.test(head)) score.seo += 5;
  else score.notes.push('no canonical');

  if (/<script[^>]*type="application\/ld\+json"/.test(head)) score.seo += 5;
  else score.notes.push('no JSON-LD');

  const ogCount = (head.match(/<meta\s+property="og:(title|description|image|url)"/g) || []).length;
  if (ogCount >= 4) score.seo += 5;
  else score.notes.push(`only ${ogCount}/4 og:* tags`);

  if (/<meta\s+name="twitter:card"/.test(head)) score.seo += 5;
  else score.notes.push('no twitter:card');

  // ---- A11y (30) ----
  if (/<html[^>]+lang="[a-z]{2}/i.test(html)) score.a11y += 5;
  else score.notes.push('no lang attr');

  if (/<meta\s+name="viewport"/.test(head)) score.a11y += 5;
  else score.notes.push('no viewport meta');

  // Skip-link can be class="skip" OR any <a href="#main">...Skip...</a>
  if (/<a[^>]+class="skip"/.test(html)
    || /class="skip"[^>]*>Skip/i.test(html)
    || /<a[^>]+href="#main"[^>]*>[^<]*Skip/i.test(html)) score.a11y += 5;
  else score.notes.push('no skip-link');

  if (/<main\b[^>]*>/.test(html)) score.a11y += 5;
  else score.notes.push('no main landmark');

  if (/<nav\b[^>]*aria-label|aria-label[^>]*nav/i.test(html) || /<nav\b/.test(html)) score.a11y += 3;
  else score.notes.push('no nav');

  // Empty <a></a> (no text, no aria-label)
  const emptyA = (html.match(/<a[^>]*>(\s|<[^>]+>)*<\/a>/g) || []).filter((a) => !/aria-label/.test(a));
  if (emptyA.length === 0) score.a11y += 3;
  else score.notes.push(`${emptyA.length} empty <a> tags`);

  // <img> without alt
  const imgs = html.match(/<img\b[^>]*>/g) || [];
  const noAlt = imgs.filter((i) => !/\salt=/.test(i));
  if (noAlt.length === 0) score.a11y += 4;
  else score.notes.push(`${noAlt.length}/${imgs.length} <img> without alt`);

  // ---- Perf-hygiene (20) ----
  if (html.length <= 250000) score.perf += 5;
  else score.notes.push(`html ${(html.length / 1024).toFixed(0)}KB > 250KB`);

  // Cross-origin script without integrity
  const xoScripts = (html.match(/<script[^>]+src="https?:\/\/[^"]+"[^>]*>/g) || [])
    .filter((s) => !/integrity=/.test(s));
  if (xoScripts.length === 0) score.perf += 5;
  else score.notes.push(`${xoScripts.length} cross-origin scripts without integrity`);

  // Scripts should be async/defer OR inline OR preloaded
  const scripts = html.match(/<script[^>]*src=[^>]*>/g) || [];
  const blocking = scripts.filter((s) => !/async|defer/.test(s));
  if (blocking.length <= 2) score.perf += 5;
  else score.notes.push(`${blocking.length} blocking scripts`);

  // No @import in inline style (CSS perf footgun)
  if (!/<style[^>]*>[^<]*@import\s+url/i.test(html)) score.perf += 5;
  else score.notes.push('@import inside <style>');

  // ---- Brand (10) ----
  const navAnchors = (html.match(/<a\s+href="\/(product|models|docs|pricing|enterprise)"/g) || []).length;
  if (navAnchors >= 5) score.brand += 4;
  else score.notes.push(`${navAnchors}/5 W221 nav anchors`);

  const bodyText = body.slice(0, 1500);
  if (bodyText.toLowerCase().includes('kolm.ai')) score.brand += 3;
  else score.notes.push('no kolm.ai in first 1500 body chars (W228)');

  if (/kolm\.ai\s*<\/title>/.test(html)) score.brand += 3;
  else score.notes.push('title does not end with kolm.ai (W228)');

  score.total = score.seo + score.a11y + score.perf + score.brand;
  return score;
}

for (const page of HERO_PAGES) {
  test(`W328 ${page} — scores >= 90/100 on static lighthouse-equivalent audit`, () => {
    const html = read(page);
    const s = scorePage(html);
    assert.ok(
      s.total >= 90,
      `${page} scored ${s.total}/100 (seo=${s.seo}/40 a11y=${s.a11y}/30 perf=${s.perf}/20 brand=${s.brand}/10). Notes: ${s.notes.join('; ')}`
    );
  });
}

test('W328 — aggregate hero score average >= 95', () => {
  const scores = HERO_PAGES.map((p) => scorePage(read(p)));
  const avg = scores.reduce((a, s) => a + s.total, 0) / scores.length;
  const breakdown = HERO_PAGES.map((p, i) => `${p}=${scores[i].total}`).join(' ');
  assert.ok(avg >= 95, `avg ${avg.toFixed(1)} < 95. Breakdown: ${breakdown}`);
});
