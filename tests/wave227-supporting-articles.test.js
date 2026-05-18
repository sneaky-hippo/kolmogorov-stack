// Wave 227: SEO supporting articles for /what-is-an-ai-compiler pillar.
//
// W227 ships 5 supporting articles linked from the W226 pillar:
//   1. articles/hipaa-ai-from-prompts.html
//   2. articles/fine-tune-vs-compile.html
//   3. articles/kolm-artifact-walkthrough.html
//   4. articles/ai-compiler-comparison.html
//   5. articles/kolm-ai-vs-kolm-therapeutics.html
//
// Tests assert BEHAVIOR (file exists, JSON-LD has Article + BreadcrumbList,
// canonical/og/* present, cross-links pillar, word count floor, hygiene),
// not copy markers. The pillar W226 already cross-links each slug, so once
// W227 ships the internal link graph is complete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const ART_DIR = path.join(PUBLIC, 'articles');
const PILLAR = path.join(PUBLIC, 'what-is-an-ai-compiler.html');
const SW = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const SITEMAP = fs.readFileSync(path.join(PUBLIC, 'sitemap.xml'), 'utf8');

const SLUGS = [
  'hipaa-ai-from-prompts',
  'fine-tune-vs-compile',
  'kolm-artifact-walkthrough',
  'ai-compiler-comparison',
  'kolm-ai-vs-kolm-therapeutics',
];

function read(slug) {
  return fs.readFileSync(path.join(ART_DIR, `${slug}.html`), 'utf8');
}

function plainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

test('W227 #1 - all 5 supporting article files exist', () => {
  for (const slug of SLUGS) {
    const p = path.join(ART_DIR, `${slug}.html`);
    assert.ok(fs.existsSync(p), `missing supporting article: ${slug}.html`);
  }
});

test('W227 #2 - each article has canonical URL pointing at /articles/<slug>', () => {
  for (const slug of SLUGS) {
    const html = read(slug);
    const re = new RegExp(`<link\\s+rel="canonical"\\s+href="https://kolm\\.ai/articles/${slug}"`);
    assert.match(html, re, `canonical wrong on ${slug}`);
  }
});

test('W227 #3 - each article has all 5 og:* meta tags', () => {
  for (const slug of SLUGS) {
    const html = read(slug);
    for (const prop of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) {
      const re = new RegExp(`property="${prop.replace(':', '\\:')}"`);
      assert.match(html, re, `${slug} missing ${prop}`);
    }
    const urlRe = new RegExp(`property="og:url"\\s+content="https://kolm\\.ai/articles/${slug}"`);
    assert.match(html, urlRe, `${slug} og:url wrong`);
  }
});

test('W227 #4 - each article JSON-LD includes Article + BreadcrumbList', () => {
  for (const slug of SLUGS) {
    const html = read(slug);
    const m = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(m, `${slug} missing JSON-LD`);
    const parsed = JSON.parse(m[1]);
    const graph = parsed['@graph'] || [parsed];
    const types = graph.map((n) => n['@type']);
    assert.ok(types.includes('Article'), `${slug} JSON-LD missing Article (saw ${types.join(',')})`);
    assert.ok(types.includes('BreadcrumbList'), `${slug} JSON-LD missing BreadcrumbList`);
  }
});

test('W227 #5 - each article cross-links the pillar /what-is-an-ai-compiler', () => {
  for (const slug of SLUGS) {
    const html = read(slug);
    assert.match(html, /href="\/what-is-an-ai-compiler"/,
      `${slug} must cross-link the pillar`);
  }
});

test('W227 #6 - each article word count >= 800 (article depth floor)', () => {
  for (const slug of SLUGS) {
    const text = plainText(read(slug));
    const words = text.split(/\s+/).filter(Boolean);
    assert.ok(words.length >= 800,
      `${slug} should be >= 800 words; was ${words.length}`);
  }
});

test('W227 #7 - 0 em-dashes in any supporting article (W210 hygiene)', () => {
  for (const slug of SLUGS) {
    const html = read(slug);
    const count = (html.match(/—/g) || []).length;
    assert.equal(count, 0, `${slug} must have 0 em-dashes; saw ${count}`);
  }
});

test('W227 #8 - 0 emoji in any supporting article prose (W210 hygiene)', () => {
  for (const slug of SLUGS) {
    const stripped = read(slug)
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<svg[\s\S]*?<\/svg>/g, '');
    const emoji = stripped.match(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu) || [];
    assert.equal(emoji.length, 0,
      `${slug} must have 0 emoji; saw ${emoji.length}: ${emoji.slice(0,5).join('')}`);
  }
});

test('W227 #9 - sw.js cache wave-floor >= 227', () => {
  const m = SW.match(/const CACHE = 'kolm-v7-[^']+-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE must follow wave-N slug pattern');
  const waveN = parseInt(m[1], 10);
  assert.ok(waveN >= 227, `sw.js wave-slug must be >= 227 (saw ${waveN})`);
});

test('W227 #10 - sitemap includes every supporting article URL', () => {
  for (const slug of SLUGS) {
    const re = new RegExp(`<loc>https://kolm\\.ai/articles/${slug}</loc>`);
    assert.match(SITEMAP, re, `sitemap missing /articles/${slug}`);
  }
});

test('W227 #11 - pillar W226 still cross-links every W227 article', () => {
  const pillar = fs.readFileSync(PILLAR, 'utf8');
  for (const slug of SLUGS) {
    const re = new RegExp(`href="/articles/${slug}"`);
    assert.match(pillar, re, `pillar must cross-link /articles/${slug}`);
  }
});

test('W227 #12 - each article has the 5-anchor canonical W221 nav', () => {
  for (const slug of SLUGS) {
    const html = read(slug);
    for (const anchor of ['/product', '/models', '/docs', '/pricing', '/enterprise']) {
      const re = new RegExp(`href="${anchor.replace(/\//g, '\\/')}"`);
      assert.match(html, re, `${slug} missing W221 nav anchor ${anchor}`);
    }
  }
});

test('W227 #13 - each article has skip-to-content link (W207 a11y)', () => {
  for (const slug of SLUGS) {
    const html = read(slug);
    assert.match(html, /href="#main"/, `${slug} missing skip-to-content link`);
    assert.match(html, /<main[^>]+id="main"/, `${slug} missing main#main target`);
  }
});

test('W227 #14 - each article has 560px responsive breakpoint (W208 mobile sweep)', () => {
  for (const slug of SLUGS) {
    const html = read(slug);
    assert.match(html, /@media\s*\(max-width:\s*560px\)/,
      `${slug} missing 560px mobile breakpoint`);
  }
});

test('W227 #15 - each article OG card SVG exists at /og/articles-<slug>.svg', () => {
  for (const slug of SLUGS) {
    const p = path.join(PUBLIC, 'og', `articles-${slug}.svg`);
    assert.ok(fs.existsSync(p), `missing OG card: og/articles-${slug}.svg`);
  }
});

test('W227 #16 - comparison article has YES/NO matrix structure (behavior, not copy)', () => {
  const html = read('ai-compiler-comparison');
  const yesCount = (html.match(/class="yes"/g) || []).length;
  const noCount = (html.match(/class="no"/g) || []).length;
  assert.ok(yesCount >= 8, `comparison article must have >= 8 YES cells; saw ${yesCount}`);
  assert.ok(noCount >= 4, `comparison article must have >= 4 NO cells; saw ${noCount}`);
});

test('W227 #17 - brand-disambig article names every confused Kolm entity', () => {
  const html = read('kolm-ai-vs-kolm-therapeutics');
  for (const name of ['Kolm therapeutics', 'Petter Kolm', 'Kolm engines', 'Kolm Stack']) {
    assert.ok(html.includes(name), `brand-disambig article must name "${name}"`);
  }
});

test('W227 #18 - articles cross-link each other (>=2 sibling article links each)', () => {
  for (const slug of SLUGS) {
    const html = read(slug);
    let siblingCount = 0;
    for (const other of SLUGS) {
      if (other === slug) continue;
      if (html.includes(`/articles/${other}`)) siblingCount++;
    }
    assert.ok(siblingCount >= 2,
      `${slug} should link >= 2 sibling articles; saw ${siblingCount}`);
  }
});
