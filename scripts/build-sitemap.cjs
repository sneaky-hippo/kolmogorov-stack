#!/usr/bin/env node
// W225 — auto-build public/sitemap.xml from public/*.html.
//
// Scans every top-level public/*.html plus selected nested directories
// (public/docs/, public/articles/, public/compare/, public/how-vs-*) and
// emits one <url> entry per public surface. Excludes:
//   * W224 cut paths (so we don't re-list a 301'd surface)
//   * auth / dashboard / settings / account
//   * 404 / 500 / preview templates
//   * legacy fragments under /compare/legacy
//
// lastmod is taken from `git log -1 --format=%cI -- <file>` if available;
// otherwise stat().mtime ISO date.
//
// Run: node scripts/build-sitemap.cjs

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'sitemap.xml');

const CUT_PATHS = new Set([
  '/agents', '/defense', '/evolve', '/bounty', '/bounties', '/cloud',
  '/distill', '/edge', '/cookbook', '/serve', '/playground', '/onboarding',
  '/recall', '/anatomy', '/showcase', '/openai',
  // W248: cut bloat — duplicate compare pages, thin translation stubs,
  // synonym pages superseded by canonical surfaces.
  '/vs-fine-tune', '/vs-hindsight', '/vs-langsmith', '/vs-mem0', '/vs-ollama',
  '/vs-openai-fine-tune', '/vs-openpipe', '/vs-predibase', '/vs-rag', '/vs-together',
  '/setup-with-ai', '/run', '/train', '/upgrade', '/tunnels',
  '/teams-accept', '/sbom', '/trust', '/roadmap', '/why-now',
]);

const EXCLUDE_PREFIXES = [
  '/dashboard', '/admin', '/signin', '/signup', '/account', '/settings',
  '/auth', '/onboarding', '/verify-email', '/reset-password',
  '/404', '/500', '/_', '/preview-', '/dev-', '/cron-',
  '/docs/i18n',
];

const PRIORITY_HINTS = {
  '/': 1.0,
  '/product': 0.95,
  '/captures': 0.9,
  '/quickstart': 0.9,
  '/models': 0.9,
  '/runtimes': 0.85,
  '/tui': 0.85,
  '/pricing': 0.9,
  '/enterprise': 0.9,
  '/docs': 0.85,
  '/security': 0.8,
  '/compare': 0.8,
  '/foundations': 0.85,
  '/what-is-an-ai-compiler': 0.85,
};

function walkHtml(dir, relBase = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...walkHtml(full, rel));
    } else if (ent.name.endsWith('.html')) {
      out.push({ full, rel });
    }
  }
  return out;
}

function urlPathFor(rel) {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'/index.html'.length);
  return '/' + rel.replace(/\.html$/, '');
}

function lastmodFor(full) {
  try {
    const iso = execSync(`git log -1 --format=%cI -- "${full}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (iso) return iso.slice(0, 10);
  } catch (_) {}
  try {
    return fs.statSync(full).mtime.toISOString().slice(0, 10);
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

function isIncluded(urlPath) {
  if (CUT_PATHS.has(urlPath)) return false;
  for (const px of EXCLUDE_PREFIXES) {
    if (urlPath === px || urlPath.startsWith(px + '/')) return false;
  }
  if (urlPath.startsWith('/compare/legacy')) return false;
  if (urlPath.startsWith('/preview')) return false;
  if (urlPath.includes('.well-known')) return false;
  return true;
}

function priorityFor(urlPath) {
  if (PRIORITY_HINTS[urlPath] !== undefined) return PRIORITY_HINTS[urlPath];
  if (urlPath.startsWith('/docs/')) return 0.7;
  if (urlPath.startsWith('/articles/')) return 0.7;
  if (urlPath.startsWith('/how-vs-')) return 0.7;
  if (urlPath.startsWith('/compare/')) return 0.65;
  if (urlPath.startsWith('/use-cases/')) return 0.7;
  if (urlPath.startsWith('/foundations/')) return 0.7;
  return 0.6;
}

function build() {
  const files = walkHtml(PUBLIC);
  const entries = [];
  for (const { full, rel } of files) {
    const urlPath = urlPathFor(rel);
    if (!isIncluded(urlPath)) continue;
    const loc = `https://kolm.ai${urlPath}`;
    const lastmod = lastmodFor(full);
    const priority = priorityFor(urlPath);
    entries.push({ loc, lastmod, priority, urlPath });
  }
  entries.sort((a, b) => b.priority - a.priority || a.loc.localeCompare(b.loc));

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const e of entries) {
    lines.push(`  <url><loc>${e.loc}</loc><lastmod>${e.lastmod}</lastmod><changefreq>weekly</changefreq><priority>${e.priority.toFixed(1)}</priority></url>`);
  }
  lines.push('</urlset>', '');
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  console.log(`sitemap.xml written with ${entries.length} URLs`);
  return entries.length;
}

if (require.main === module) build();
module.exports = { build, isIncluded, urlPathFor, CUT_PATHS, EXCLUDE_PREFIXES };
