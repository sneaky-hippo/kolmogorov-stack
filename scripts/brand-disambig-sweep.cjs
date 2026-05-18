#!/usr/bin/env node
// W228 — idempotent brand-disambiguation sweep across public/*.html.
//
// Three checks, applied to every top-level HTML page:
//   1. <title> ends with the exact suffix " · kolm.ai". If it ends with a
//      bare " · kolm" suffix (no TLD), upgrade to " · kolm.ai". If no kolm
//      suffix exists at all, append " · kolm.ai".
//   2. First 1200 chars of <body> contain the literal string "kolm.ai" at
//      least once. If not, insert a span.brand-anchor right after <body>
//      that names kolm.ai by trade name. (The site nav already names kolm.ai
//      in the logo, so this check should pass on every navable page; the
//      injection covers pages with custom headers.)
//   3. On /enterprise, /pricing, /signup (and /signin), the page contains a
//      link to /articles/kolm-ai-vs-kolm-therapeutics. If not, append one
//      to the footer (a <footer> element near the end of <body>).
//
// Skipped files: 404, 500, preview-*, dev-*, _*.
//
// Run: node scripts/brand-disambig-sweep.cjs
// Exit: 0 on clean run; prints touched count per category.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const SKIP_FILES = new Set(['404.html', '500.html']);
const SKIP_PREFIXES = ['preview-', 'dev-', '_'];

const DISAMBIG_TARGETS = new Set([
  'enterprise.html', 'pricing.html', 'signup.html', 'signin.html',
]);
const DISAMBIG_HREF = '/articles/kolm-ai-vs-kolm-therapeutics';
const DISAMBIG_LINK_TEXT = 'kolm.ai vs Kolm therapeutics';

function shouldSkip(name) {
  if (SKIP_FILES.has(name)) return true;
  for (const px of SKIP_PREFIXES) if (name.startsWith(px)) return true;
  return false;
}

function normalizeTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  if (!m) return { html, changed: false };
  const orig = m[1];
  let next = orig.trim();

  if (/[·|]\s*kolm\.ai\s*$/i.test(next)) {
    return { html, changed: false };
  }
  if (/[·|]\s*kolm\s*$/i.test(next)) {
    next = next.replace(/([·|])\s*kolm\s*$/i, '$1 kolm.ai');
  } else {
    next = `${next} · kolm.ai`;
  }

  const updated = html.replace(/<title>[^<]*<\/title>/i, `<title>${next}</title>`);
  return { html: updated, changed: updated !== html };
}

function ensureBrandAnchor(html) {
  const bodyOpenIdx = html.search(/<body[^>]*>/i);
  if (bodyOpenIdx === -1) return { html, changed: false };
  const after = html.slice(bodyOpenIdx);
  const head = after.slice(0, 1200);
  if (/kolm\.ai/.test(head)) return { html, changed: false };

  const insert = '<span class="brand-anchor" style="position:absolute;left:-9999px" aria-hidden="true">kolm.ai - the AI compiler. Not Kolm therapeutics, Kolm band, Kolm engines, or Petter Kolm.</span>';
  const updated = html.replace(/(<body[^>]*>)/i, `$1\n${insert}`);
  return { html: updated, changed: updated !== html };
}

function ensureDisambigLink(html, name) {
  if (!DISAMBIG_TARGETS.has(name)) return { html, changed: false };
  if (html.includes(DISAMBIG_HREF)) return { html, changed: false };

  const link = `<a href="${DISAMBIG_HREF}">${DISAMBIG_LINK_TEXT}</a>`;
  const footerRe = /(<footer[^>]*>)([\s\S]*?)(<\/footer>)/i;
  if (footerRe.test(html)) {
    const updated = html.replace(footerRe, (_full, open, body, close) => {
      return `${open}${body} &middot; ${link}${close}`;
    });
    return { html: updated, changed: updated !== html };
  }
  const updated = html.replace(/<\/body>/i, `<footer>kolm.ai &middot; ${link}</footer>\n</body>`);
  return { html: updated, changed: updated !== html };
}

function sweep() {
  const files = fs.readdirSync(PUBLIC, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html') && !shouldSkip(e.name))
    .map((e) => e.name);

  const stats = { title: 0, anchor: 0, link: 0, files: files.length };
  for (const name of files) {
    const full = path.join(PUBLIC, name);
    let html = fs.readFileSync(full, 'utf8');
    const before = html;

    const t = normalizeTitle(html);
    if (t.changed) { html = t.html; stats.title++; }

    const a = ensureBrandAnchor(html);
    if (a.changed) { html = a.html; stats.anchor++; }

    const l = ensureDisambigLink(html, name);
    if (l.changed) { html = l.html; stats.link++; }

    if (html !== before) fs.writeFileSync(full, html, 'utf8');
  }
  console.log(`brand-disambig-sweep: titles=${stats.title} anchors=${stats.anchor} links=${stats.link} of ${stats.files} files`);
  return stats;
}

if (require.main === module) sweep();
module.exports = { sweep, normalizeTitle, ensureBrandAnchor, ensureDisambigLink };
