#!/usr/bin/env node
// W225 — per-page OG card generator (SVG-only, no image deps).
//
// For each public/*.html page, extract <title> + <meta name="description">
// and emit public/og/<slug>.svg. The og:image meta tag is left untouched on
// pages that already point at /og-card.svg or any /og/*.svg; pages missing
// og:image entirely get a hint stamped to point at the per-page card.
//
// Modern crawlers (Twitter, Discord, Slack, Mastodon) render SVG OG cards.
// Where SVG is unsupported, the page still has og:title + og:description
// fallback, so the share card degrades but does not break.
//
// Run: node scripts/build-og.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OG_DIR = path.join(PUBLIC, 'og');

function slugFor(rel) {
  if (rel === 'index.html') return 'home';
  return rel.replace(/\.html$/, '').replace(/[\/\\]/g, '-');
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function wrap(text, perLine = 32) {
  if (!text) return [''];
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > perLine && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur ? cur + ' ' : '') + w;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

function extractMeta(html) {
  const titleM = html.match(/<title>([^<]*)<\/title>/i);
  const descM = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
  return {
    title: titleM ? titleM[1].trim() : 'kolm.ai',
    description: descM ? descM[1].trim() : 'The AI compiler. Capture, distill, compile, ship.',
  };
}

function renderSvg(title, description) {
  const titleClean = title.replace(/\s*[·|]\s*kolm(?:\.ai)?\s*$/i, '').trim() || 'kolm.ai';
  const titleLines = wrap(titleClean, 26);
  const descLines = wrap(description, 60);
  const titleY = 350;
  const titleFontSize = titleLines.length > 2 ? 56 : 64;
  const titleStep = titleFontSize + 12;
  const descY = titleY + titleStep * titleLines.length + 12;

  const titleTspans = titleLines.map((ln, i) =>
    `<text x="96" y="${titleY + i * titleStep}" fill="#ece7dc" font-family="-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Segoe UI',system-ui,sans-serif" font-size="${titleFontSize}" font-weight="640" letter-spacing="-1.6">${escapeXml(ln)}</text>`
  ).join('\n  ');

  const descTspans = descLines.map((ln, i) =>
    `<text x="96" y="${descY + i * 30}" fill="#a8b0bb" font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter','Segoe UI',system-ui,sans-serif" font-size="22" font-weight="400">${escapeXml(ln)}</text>`
  ).join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeXml(titleClean)} | kolm.ai">
  <defs>
    <radialGradient id="glow" cx="22%" cy="18%" r="60%">
      <stop offset="0%" stop-color="#faf2e1" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#faf2e1" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="topfade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#11151b" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#11151b" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="#0b0d10"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect width="1200" height="180" fill="url(#topfade)"/>
  <g transform="translate(96 96)">
    <rect x="0" y="2" width="14" height="60" fill="#ece7dc"/>
    <path d="M42 6 L54 6 L24 32 L12 32 Z" fill="#ece7dc"/>
    <path d="M12 32 L24 32 L54 58 L42 58 Z" fill="#ece7dc"/>
    <rect x="3" y="29" width="8" height="8" fill="#faf2e1"/>
    <text x="78" y="50" fill="#ece7dc" font-family="-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Segoe UI',system-ui,sans-serif" font-size="40" font-weight="600" letter-spacing="-1.2">kolm.ai</text>
  </g>
  ${titleTspans}
  ${descTspans}
  <text x="96" y="600" fill="#5a6471" font-family="ui-monospace,'SF Mono',Menlo,Consolas,monospace" font-size="14" letter-spacing="1.6">the AI compiler</text>
</svg>
`;
}

function walkHtmlTop(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => e.name);
}

// W227 — also generate OG cards for selected subdirectories so that
// /articles/*.html pages get their per-page card (referenced as
// /og/articles-<slug>.svg from each article's og:image meta).
const NESTED_DIRS = ['articles', 'docs', 'how-vs-lorax', 'how-vs-predibase', 'foundations', 'quickstart'];

function walkNested(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html') && e.name !== 'index.html')
    .map((e) => ({
      full: path.join(dir, e.name),
      slug: `${prefix}-${e.name.replace(/\.html$/, '')}`,
    }));
}

function build() {
  if (!fs.existsSync(OG_DIR)) fs.mkdirSync(OG_DIR, { recursive: true });
  const files = walkHtmlTop(PUBLIC);
  let written = 0;
  for (const rel of files) {
    const full = path.join(PUBLIC, rel);
    const html = fs.readFileSync(full, 'utf8');
    const { title, description } = extractMeta(html);
    const slug = slugFor(rel);
    const svg = renderSvg(title, description);
    const outFile = path.join(OG_DIR, `${slug}.svg`);
    fs.writeFileSync(outFile, svg, 'utf8');
    written++;
  }
  for (const sub of NESTED_DIRS) {
    const subDir = path.join(PUBLIC, sub);
    for (const { full, slug } of walkNested(subDir, sub)) {
      const html = fs.readFileSync(full, 'utf8');
      const { title, description } = extractMeta(html);
      const svg = renderSvg(title, description);
      const outFile = path.join(OG_DIR, `${slug}.svg`);
      fs.writeFileSync(outFile, svg, 'utf8');
      written++;
    }
  }
  console.log(`og/ cards written: ${written}`);
  return written;
}

if (require.main === module) build();
module.exports = { build, slugFor, extractMeta, renderSvg };
