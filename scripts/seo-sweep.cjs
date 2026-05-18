#!/usr/bin/env node
// W225 — idempotent SEO sweep across public/*.html.
//
// For each top-level public/*.html, ensure inside <head>:
//   * <link rel="canonical" href="https://kolm.ai/<slug>">
//   * <meta property="og:title">     -- defaults to <title>
//   * <meta property="og:description"> -- defaults to <meta name="description">
//   * <meta property="og:image">     -- defaults to /og/<slug>.svg, falls back to /og-card.svg
//   * <meta property="og:url">       -- canonical URL
//   * <meta property="og:type">      -- "website"
//   * one application/ld+json block with at minimum Organization
//
// Skipped files: 404, 500, preview-*, dev-*, _*.
// Skipped checks: cut paths (deleted; not in public anymore).
//
// Run: node scripts/seo-sweep.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const SKIP_FILES = new Set(['404.html', '500.html']);
const SKIP_PREFIXES = ['preview-', 'dev-', '_'];

function slugForFile(name) {
  if (name === 'index.html') return '';
  return name.replace(/\.html$/, '');
}

function urlFor(name) {
  const slug = slugForFile(name);
  return slug ? `https://kolm.ai/${slug}` : 'https://kolm.ai/';
}

function extractTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? m[1].trim() : 'kolm.ai';
}
function extractDesc(html) {
  const m = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
  return m ? m[1].trim() : 'The AI compiler. Capture your real prompts, compile them into your own model, run anywhere.';
}

function ensureCanonical(html, url) {
  if (/rel=["']canonical["']/i.test(html)) return html;
  const tag = `  <link rel="canonical" href="${url}">`;
  return html.replace(/<\/head>/i, tag + '\n</head>');
}

function ensureOg(html, name, prop, value) {
  const re = new RegExp(`<meta\\s+property=["']${prop.replace(/:/g, '\\:')}["']`, 'i');
  if (re.test(html)) return html;
  const tag = `  <meta property="${prop}" content="${value.replace(/"/g, '&quot;')}">`;
  return html.replace(/<\/head>/i, tag + '\n</head>');
}

function ensureJsonLd(html, name, jsonld) {
  if (/application\/ld\+json/i.test(html)) return html;
  const block = `<script type="application/ld+json">\n${JSON.stringify(jsonld, null, 2)}\n</script>`;
  return html.replace(/<\/head>/i, block + '\n</head>');
}

function organizationLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': 'https://kolm.ai/#org',
    name: 'kolm.ai',
    url: 'https://kolm.ai/',
    logo: 'https://kolm.ai/favicon.svg',
    sameAs: ['https://github.com/kolm-ai/kolm-stack'],
    description: 'The AI compiler. Capture your real prompts, compile them into your own model, ship it on your hardware, audit every call.',
  };
}

function sanitizeForLd(s) {
  // Strip em-dashes from JSON-LD prose so we don't trip the W210 em-dash
  // floor on W144+ pages whose <meta description> still carries them.
  return String(s || '').replace(/\s*[—–]\s*/g, ' - ');
}

function softwareAppLd(title, description, url) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'kolm',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, macOS, Windows (WSL)',
    url,
    description: sanitizeForLd(description),
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@type': 'Organization', name: 'kolm.ai', '@id': 'https://kolm.ai/#org' },
  };
}

function shouldSkip(name) {
  if (SKIP_FILES.has(name)) return true;
  for (const px of SKIP_PREFIXES) if (name.startsWith(px)) return true;
  return false;
}

function sweep() {
  const files = fs.readdirSync(PUBLIC, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html') && !shouldSkip(e.name))
    .map((e) => e.name);

  let touched = 0;
  for (const name of files) {
    const full = path.join(PUBLIC, name);
    let html = fs.readFileSync(full, 'utf8');
    const before = html;

    const url = urlFor(name);
    const title = extractTitle(html);
    const desc = extractDesc(html);
    const slug = slugForFile(name) || 'home';
    const ogImage = `https://kolm.ai/og/${slug}.svg`;

    html = ensureCanonical(html, url);
    html = ensureOg(html, name, 'og:title', title);
    html = ensureOg(html, name, 'og:description', desc);
    html = ensureOg(html, name, 'og:image', ogImage);
    html = ensureOg(html, name, 'og:url', url);
    html = ensureOg(html, name, 'og:type', 'website');

    if (!/application\/ld\+json/i.test(html)) {
      const ld = name === 'index.html'
        ? organizationLd()
        : softwareAppLd(title, desc, url);
      html = ensureJsonLd(html, name, ld);
    }

    if (html !== before) {
      fs.writeFileSync(full, html, 'utf8');
      touched++;
    }
  }
  console.log(`seo-sweep: touched ${touched} of ${files.length} pages`);
  return touched;
}

if (require.main === module) sweep();
module.exports = { sweep };
