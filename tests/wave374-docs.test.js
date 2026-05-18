// Wave 374: Docs tree restructure (19 real pages).
//
// W374 mints 19 pages under public/docs/{,connect/}. These tests assert
// BEHAVIOR (files exist, invariants hold, vercel rewrites are wired, the
// detector/opportunity/bakeoff inventories all render) — they do not pin
// prose copy (W366 lesson: copy churns; markup contracts do not).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DOCS = path.join(PUBLIC, 'docs');
const CONNECT = path.join(DOCS, 'connect');

const PAGES = [
  { rel: 'docs/quickstart.html', urlPath: '/docs/quickstart', title: 'Quickstart' },
  { rel: 'docs/connect/openai.html', urlPath: '/docs/connect/openai', title: 'Connect OpenAI' },
  { rel: 'docs/connect/anthropic.html', urlPath: '/docs/connect/anthropic', title: 'Connect Anthropic' },
  { rel: 'docs/connect/openrouter.html', urlPath: '/docs/connect/openrouter', title: 'Connect OpenRouter' },
  { rel: 'docs/connect/gemini.html', urlPath: '/docs/connect/gemini', title: 'Connect Gemini' },
  { rel: 'docs/privacy.html', urlPath: '/docs/privacy', title: 'Privacy' },
  { rel: 'docs/lake.html', urlPath: '/docs/lake', title: 'Lake' },
  { rel: 'docs/optimizer.html', urlPath: '/docs/optimizer', title: 'Optimizer' },
  { rel: 'docs/datasets.html', urlPath: '/docs/datasets', title: 'Datasets' },
  { rel: 'docs/training.html', urlPath: '/docs/training', title: 'Training' },
  { rel: 'docs/distillation.html', urlPath: '/docs/distillation', title: 'Distillation' },
  { rel: 'docs/evals.html', urlPath: '/docs/evals', title: 'Evals' },
  { rel: 'docs/runtime.html', urlPath: '/docs/runtime', title: 'Runtime' },
  { rel: 'docs/devices.html', urlPath: '/docs/devices', title: 'Devices' },
  { rel: 'docs/storage.html', urlPath: '/docs/storage', title: 'Storage' },
  { rel: 'docs/cloud-sync.html', urlPath: '/docs/cloud-sync', title: 'Cloud sync' },
  { rel: 'docs/team.html', urlPath: '/docs/team', title: 'Team' },
  { rel: 'docs/enterprise.html', urlPath: '/docs/enterprise', title: 'Enterprise docs' },
  { rel: 'docs/api.html', urlPath: '/docs/api', title: 'API' },
];

function readPage(rel) {
  return fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
}

function bodyOf(html) {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}

test('W374 #1 - all 19 pages exist with non-trivial byte counts', () => {
  for (const p of PAGES) {
    const full = path.join(PUBLIC, p.rel);
    assert.ok(fs.existsSync(full), `missing page: ${p.rel}`);
    const stat = fs.statSync(full);
    assert.ok(stat.size > 4000, `${p.rel} too small (${stat.size} bytes)`);
  }
});

test('W374 #2 - every page has the " · kolm.ai" title suffix (W228)', () => {
  for (const p of PAGES) {
    const html = readPage(p.rel);
    const m = html.match(/<title>([^<]+)<\/title>/i);
    assert.ok(m, `${p.rel}: no <title>`);
    const t = m[1];
    assert.ok(
      / (?:&middot;|·) kolm\.ai$/.test(t),
      `${p.rel}: title "${t}" does not end with " · kolm.ai"`
    );
  }
});

test('W374 #3 - every page has a canonical link pointing at its kolm.ai URL', () => {
  for (const p of PAGES) {
    const html = readPage(p.rel);
    const expected = `https://kolm.ai${p.urlPath}`;
    assert.ok(
      html.includes(`<link rel="canonical" href="${expected}">`),
      `${p.rel}: canonical missing or wrong (want ${expected})`
    );
  }
});

test('W374 #4 - every page emits TechArticle JSON-LD with author + publisher', () => {
  for (const p of PAGES) {
    const html = readPage(p.rel);
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(m, `${p.rel}: no JSON-LD <script>`);
    const ld = JSON.parse(m[1]);
    assert.equal(ld['@type'], 'TechArticle', `${p.rel}: wrong @type`);
    assert.ok(ld.author && ld.author.name === 'kolm.ai', `${p.rel}: bad author`);
    assert.ok(ld.publisher && ld.publisher.name === 'kolm.ai', `${p.rel}: bad publisher`);
    assert.equal(ld.url, `https://kolm.ai${p.urlPath}`, `${p.rel}: wrong url`);
  }
});

test('W374 #5 - every page has a skip-link, main#main, and 5-anchor W221 nav', () => {
  const ANCHORS = ['/product', '/models', '/docs', '/pricing', '/enterprise'];
  for (const p of PAGES) {
    const html = readPage(p.rel);
    assert.ok(/<a[^>]+class="skip-link"[^>]+href="#main"/.test(html), `${p.rel}: skip-link missing`);
    assert.ok(/<main[^>]+id="main"[^>]+tabindex="-1"/.test(html), `${p.rel}: <main id=main tabindex=-1> missing`);
    for (const a of ANCHORS) {
      assert.ok(html.includes(`href="${a}"`), `${p.rel}: nav anchor ${a} missing`);
    }
  }
});

test('W374 #6 - every page mentions kolm.ai in first 1200 body chars (W228)', () => {
  for (const p of PAGES) {
    const html = readPage(p.rel);
    const head = bodyOf(html).slice(0, 1200);
    assert.ok(head.includes('kolm.ai'), `${p.rel}: kolm.ai missing in first 1200 body chars`);
  }
});

test('W374 #7 - em-dash count is at most 1 per page (W210 floor)', () => {
  for (const p of PAGES) {
    const html = readPage(p.rel);
    const emDashCount = (html.match(/—/g) || []).length;
    assert.ok(emDashCount <= 1, `${p.rel}: ${emDashCount} em-dashes (max 1)`);
  }
});

test('W374 #8 - every page has at least one <pre><code> example', () => {
  for (const p of PAGES) {
    const html = readPage(p.rel);
    assert.ok(/<pre[^>]*>\s*<code/.test(html), `${p.rel}: no <pre><code> example`);
  }
});

test('W374 #9 - every page cross-links to /docs/quickstart (the spine)', () => {
  for (const p of PAGES) {
    if (p.urlPath === '/docs/quickstart') continue;
    const html = readPage(p.rel);
    assert.ok(
      html.includes('href="/docs/quickstart"'),
      `${p.rel}: missing link back to /docs/quickstart`
    );
  }
});

test('W374 #10 - every page cross-links to at least 2 sibling /docs/* pages', () => {
  const sibSet = new Set(PAGES.map((p) => p.urlPath));
  for (const p of PAGES) {
    const html = readPage(p.rel);
    const hits = new Set();
    for (const s of sibSet) {
      if (s === p.urlPath) continue;
      if (html.includes(`href="${s}"`)) hits.add(s);
    }
    assert.ok(hits.size >= 2, `${p.rel}: only ${hits.size} sibling links (need >= 2)`);
  }
});

test('W374 #11 - no forbidden coming-soon / TODO / Beta strings', () => {
  const FORBIDDEN = [/\bcoming\s+soon\b/i, /\bTODO\b/, /\bBeta\b/, /\bnot[_-]yet[_-]wired\b/i, /@kolmogorov\//];
  for (const p of PAGES) {
    const html = readPage(p.rel);
    for (const rx of FORBIDDEN) {
      assert.ok(!rx.test(html), `${p.rel}: forbidden token ${rx} present`);
    }
  }
});

test('W374 #12 - sw.js has a wave-current cache slug for 2026-05-18', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  assert.ok(/const CACHE = '[^']+wave\d+[^']+';/.test(sw), 'sw.js: CACHE constant missing or malformed');
  assert.ok(/2026-05-18/.test(sw), 'sw.js: 2026-05-18 date missing');
});

test('W374 #13 - vercel.json has rewrites for all 19 docs paths', () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const rewrites = new Map(v.rewrites.map((r) => [r.source, r.destination]));
  for (const p of PAGES) {
    assert.ok(rewrites.has(p.urlPath), `vercel.json: missing rewrite for ${p.urlPath}`);
    assert.equal(rewrites.get(p.urlPath), `/${p.rel}`, `vercel.json: wrong destination for ${p.urlPath}`);
  }
});

test('W374 #14 - privacy page names all 17 detector classes', () => {
  const html = readPage('docs/privacy.html');
  const CLASSES = [
    'email', 'phone', 'ssn', 'credit_card', 'iban', 'us_passport',
    'dob', 'street_address', 'mrn', 'npi', 'icd10', 'cpt', 'rxnorm',
    'ip_v4', 'mac', 'jwt', 'api_key',
  ];
  for (const c of CLASSES) {
    assert.ok(html.includes(`<code>${c}</code>`), `privacy: detector class ${c} missing`);
  }
});

test('W374 #15 - privacy page names allow/redact/block/override and policy.json', () => {
  const html = readPage('docs/privacy.html');
  for (const action of ['allow', 'redact', 'block', 'override']) {
    assert.ok(html.includes(action), `privacy: action ${action} missing`);
  }
  assert.ok(html.includes('policy.json'), 'privacy: policy.json path missing');
  assert.ok(html.includes('audit.log'), 'privacy: audit.log path missing');
  assert.ok(html.includes('VAR_'), 'privacy: VAR_ placeholder family missing');
});

test('W374 #16 - optimizer page names all 11 opportunity types', () => {
  const html = readPage('docs/optimizer.html');
  const OPPS = [
    'cache', 'cheaper_model', 'local_replacement', 'privacy_leak',
    'prompt_compression', 'repeated_extraction', 'repeated_classification',
    'log_triage', 'routing_policy', 'dataset_ready', 'training_ready',
  ];
  for (const o of OPPS) {
    assert.ok(html.includes(o), `optimizer: opportunity ${o} missing`);
  }
});

test('W374 #17 - evals page names all 8 bakeoff contestants', () => {
  const html = readPage('docs/evals.html');
  const BAKEOFF = [
    'cache', 'rule', 'prompt_only', 'gemma-3n-e2b',
    'qwen-0.5b', 'phi-mini', 'claude-haiku-4-5', 'gpt-4o-mini',
  ];
  for (const b of BAKEOFF) {
    assert.ok(html.includes(b), `evals: contestant ${b} missing`);
  }
});

test('W374 #18 - lake page references the 35-field event and events.sqlite', () => {
  const html = readPage('docs/lake.html');
  assert.ok(/35[\s-]*field/i.test(html), 'lake: 35-field event schema not named');
  assert.ok(html.includes('events.sqlite'), 'lake: events.sqlite path missing');
});

test('W374 #19 - quickstart cites OPENAI_BASE_URL and the local proxy port', () => {
  const html = readPage('docs/quickstart.html');
  assert.ok(html.includes('OPENAI_BASE_URL'), 'quickstart: OPENAI_BASE_URL missing');
  assert.ok(html.includes('127.0.0.1:8787'), 'quickstart: proxy 127.0.0.1:8787 missing');
  assert.ok(html.includes('kolm connect'), 'quickstart: kolm connect verb missing');
});

test('W374 #20 - meta description on every page is 60-200 chars', () => {
  for (const p of PAGES) {
    const html = readPage(p.rel);
    const m = html.match(/<meta name="description" content="([^"]+)"/);
    assert.ok(m, `${p.rel}: meta description missing`);
    const len = m[1].length;
    assert.ok(len >= 60 && len <= 200, `${p.rel}: meta description ${len} chars (want 60..200)`);
  }
});
