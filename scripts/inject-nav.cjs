// W221 — single source of truth for the site nav. Idempotent: writes the
// canonical 5-item nav between HTML-comment delimiters so re-runs are safe.
//
// Plan-mandated 5-item nav (replaces the legacy 6-item Use-cases/Training/
// Docs/Research/Enterprise/Pricing stack):
//
//     Product · Models · Docs · Pricing · Enterprise
//
// - Product collapses Use cases (mega-menu will land later; for W221 just the
//   single link to /product).
// - Models is the W217 frontier-models catalog (/models).
// - Docs absorbs Training (/training) + Research (/research) as sidebar pages.
// - Pricing + Enterprise unchanged.
//
// Run: node scripts/inject-nav.cjs
//
// The script edits ONLY the block between BEGIN/END markers; everything else
// in the file is left alone. If a page doesn't have a <nav class="site-nav">
// block yet, the script skips it (those pages use the legacy <header class="site">
// 3-link variant — Wave 224 slop sweep handles those).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const SKIP_DIRS = new Set(['_archive', '_generations']);
const BEGIN = '<!-- KOLM_NAV_BEGIN (W221) -->';
const END = '<!-- KOLM_NAV_END (W221) -->';

const NAV_ITEMS = [
  { href: '/product', label: 'Product' },
  { href: '/models', label: 'Models' },
  { href: '/docs', label: 'Docs' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/enterprise', label: 'Enterprise' },
];

function canonicalBlock() {
  const links = NAV_ITEMS.map(i => `      <a href="${i.href}">${i.label}</a>`).join('\n');
  return [
    `    ${BEGIN}`,
    '    <nav class="site-nav" aria-label="Primary">',
    links,
    '    </nav>',
    `    ${END}`,
  ].join('\n');
}

// Match either:
//   (a) a previously-injected block delimited by BEGIN/END
//   (b) the legacy `<nav class="site-nav"...>...</nav>` block (one-shot upgrade)
const LEGACY_RE = /(?:[ \t]*)<nav class="site-nav"[^>]*>[\s\S]*?<\/nav>(?:\s*<!--[^>]*-->)?/;
const MARKED_RE = new RegExp(
  '(?:[ \\t]*)' +
  BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
  '[\\s\\S]*?' +
  END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
);

let touched = 0, already = 0, skipped = 0, missing = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.html')) continue;
    let s;
    try { s = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const block = canonicalBlock();
    if (MARKED_RE.test(s)) {
      // Idempotent path: replace existing marked block.
      const replaced = s.replace(MARKED_RE, block);
      if (replaced === s) { already++; continue; }
      fs.writeFileSync(full, replaced);
      touched++;
      continue;
    }
    if (LEGACY_RE.test(s)) {
      // One-shot upgrade: swap legacy <nav class="site-nav"> for the marked block.
      const replaced = s.replace(LEGACY_RE, block);
      fs.writeFileSync(full, replaced);
      touched++;
      continue;
    }
    if (/<header[^>]*class="site-header/.test(s)) {
      // Page has the new header but no site-nav yet — skip and report.
      missing++;
      continue;
    }
    skipped++;
  }
}

walk(ROOT);
console.log(`nav inject (W221): ${touched} touched, ${already} idempotent-noop, ${missing} have site-header but no site-nav, ${skipped} legacy (no site-header).`);
