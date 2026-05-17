// Wave 169 — O+3 competitive surfaces. Locks in the W144 Doc 7 §10
// commitment: a canonical /compare differentiation matrix citing every
// shipping wave + five /how-vs-* teardown pages (LoRAX, Predibase, OpenPipe,
// DIY, hyperscaler). Each page must exist, ship the consistent design
// language, cite at least one shipping wave, and cross-link to its siblings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

const PAGES = {
  compare: path.join(PUBLIC, 'compare.html'),
  lorax: path.join(PUBLIC, 'how-vs-lorax.html'),
  predibase: path.join(PUBLIC, 'how-vs-predibase.html'),
  openpipe: path.join(PUBLIC, 'how-vs-openpipe.html'),
  diy: path.join(PUBLIC, 'how-vs-diy.html'),
  hyperscaler: path.join(PUBLIC, 'how-vs-hyperscaler.html'),
};

const read = (key) => fs.readFileSync(PAGES[key], 'utf8');

test('1. all six surfaces exist on disk', () => {
  for (const [name, p] of Object.entries(PAGES)) {
    assert.ok(fs.existsSync(p), `${name} page missing at ${p}`);
    const stat = fs.statSync(p);
    assert.ok(stat.size > 4096, `${name} page too small (${stat.size} bytes)`);
  }
});

test('2. /compare hosts the canonical 10-axis matrix with all expected axes', () => {
  const html = read('compare');
  const expected = [
    'Multi-LoRA serving',
    'Build fine-tune from your data',
    'Capture-from-production traffic',
    'Compiled native binary',
    'Runs offline / air-gapped',
    'Cryptographically signed',
    'Frozen-eval-gated ship',
    'Receipt chain',
    'PHI/PII redactor for teacher call',
    'Cross-vendor teacher catalog',
    'External + adversarial holdouts',
    'Tenant shadow corpus',
    'Third-party auditor attestation',
    'Drift detection + supersession chain',
    '.kolm portable format',
  ];
  for (const axis of expected) {
    assert.ok(html.includes(axis), `compare.html missing axis "${axis}"`);
  }
});

test('3. /compare cites every wave that shipped a moat axis (W144, W157-167)', () => {
  const html = read('compare');
  const requiredWaves = ['wave 144', 'wave 157', 'wave 158', 'wave 160', 'wave 161', 'wave 162', 'wave 163', 'wave 164', 'wave 165', 'wave 166', 'wave 167'];
  for (const w of requiredWaves) {
    assert.ok(html.toLowerCase().includes(w),
      `compare.html missing wave citation "${w}"`);
  }
});

test('4. /compare links to all five /how-vs-* sibling pages', () => {
  const html = read('compare');
  assert.match(html, /href="\/how-vs-lorax"/);
  assert.match(html, /href="\/how-vs-predibase"/);
  assert.match(html, /href="\/how-vs-openpipe"/);
  assert.match(html, /href="\/how-vs-diy"/);
  assert.match(html, /href="\/how-vs-hyperscaler"/);
});

test('5. /compare has columns for all six competitor categories', () => {
  const html = read('compare');
  for (const col of ['LoRAX', 'Predibase', 'OpenPipe', 'DIY LoRA', 'Hyperscaler', 'kolm']) {
    assert.ok(html.includes(`<th>${col}</th>`) || html.includes(`<th class="kolm-col">${col}</th>`),
      `compare.html missing competitor column "${col}"`);
  }
});

test('6. each /how-vs-* page declares its canonical URL', () => {
  const cases = {
    lorax: 'https://kolm.ai/how-vs-lorax',
    predibase: 'https://kolm.ai/how-vs-predibase',
    openpipe: 'https://kolm.ai/how-vs-openpipe',
    diy: 'https://kolm.ai/how-vs-diy',
    hyperscaler: 'https://kolm.ai/how-vs-hyperscaler',
  };
  for (const [key, url] of Object.entries(cases)) {
    const html = read(key);
    assert.ok(html.includes(`<link rel="canonical" href="${url}"`) || html.includes(`canonical" href="${url}"`),
      `${key} page missing canonical link to ${url}`);
  }
});

test('7. each /how-vs-* page cites at least one shipping wave from W144-167', () => {
  for (const key of ['lorax', 'predibase', 'openpipe', 'diy', 'hyperscaler']) {
    const html = read(key);
    const hasWave = /wave\s+(144|145|146|147|148|149|150|151|152|153|154|155|156|157|158|159|160|161|162|163|164|165|166|167)/i.test(html);
    assert.ok(hasWave, `${key} page must cite a shipping wave from W144-167`);
  }
});

test('8. each /how-vs-* page contains a comparison matrix', () => {
  for (const key of ['lorax', 'predibase', 'openpipe', 'diy', 'hyperscaler']) {
    const html = read(key);
    assert.match(html, /<table[^>]*>/, `${key} page must contain a <table> element`);
    assert.match(html, /<th[^>]*>[^<]*kolm[^<]*<\/th>/i,
      `${key} page must have a column header naming kolm`);
  }
});

test('9. each /how-vs-* page cross-links to its sibling /how-vs-* pages', () => {
  const siblings = ['lorax', 'predibase', 'openpipe', 'diy', 'hyperscaler'];
  for (const key of siblings) {
    const html = read(key);
    const linksToOthers = siblings.filter(s => s !== key)
      .filter(s => html.includes(`/how-vs-${s}`));
    assert.ok(linksToOthers.length >= 2,
      `${key} page should link to >= 2 sibling /how-vs-* pages, found ${linksToOthers.length}`);
  }
});

test('10. /compare and every /how-vs-* page link back to /spec/rs-1', () => {
  for (const key of Object.keys(PAGES)) {
    const html = read(key);
    assert.ok(html.includes('/spec/rs-1'),
      `${key} page must reference /spec/rs-1`);
  }
});

test('11. vercel.json routes /how-vs-* to corresponding html files', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8'));
  const rewrites = vercel.rewrites;
  const expected = [
    { source: '/how-vs-lorax', destination: '/how-vs-lorax.html' },
    { source: '/how-vs-predibase', destination: '/how-vs-predibase.html' },
    { source: '/how-vs-openpipe', destination: '/how-vs-openpipe.html' },
    { source: '/how-vs-diy', destination: '/how-vs-diy.html' },
    { source: '/how-vs-hyperscaler', destination: '/how-vs-hyperscaler.html' },
    { source: '/compare', destination: '/compare.html' },
  ];
  for (const e of expected) {
    const found = rewrites.find(r => r.source === e.source && r.destination === e.destination);
    assert.ok(found, `vercel.json missing rewrite ${e.source} → ${e.destination}`);
  }
});

test('12. sw.js CACHE bumped to wave169 or later slug', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  // Wave 169 was the floor for this test; later waves bump the slug forward.
  // Match any kolm-v7-* CACHE with a numeric wave segment >= 169.
  const m = sw.match(/const CACHE = 'kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(Number(m[1]) >= 169,
    `sw.js CACHE wave segment must be >= 169 (saw wave${m[1]})`);
});

test('13. /compare hero copy names the defensible moat bundle', () => {
  const html = read('compare');
  assert.match(html, /signed \+ compiled \+ frozen-eval-gated \+ receipt chain \+ PHI redactor \+ cross-vendor \+ portable/);
});

test('14. each /how-vs-* page is part of the consistent design system (mono stamp + accent color)', () => {
  for (const key of ['lorax', 'predibase', 'openpipe', 'diy', 'hyperscaler']) {
    const html = read(key);
    assert.match(html, /--mono:/, `${key} page must declare the --mono CSS custom property`);
    assert.match(html, /--accent:/, `${key} page must declare the --accent CSS custom property`);
  }
});

test('15. /how-vs-lorax describes the complement-not-competitor positioning', () => {
  const html = read('lorax');
  assert.match(html, /complement|build.*serve|adapter.*serve|kolm builds.*LoRAX serves/i);
});

test('16. /how-vs-predibase names the Rubrik acquisition (June 2025)', () => {
  const html = read('predibase');
  assert.match(html, /Rubrik/);
  assert.match(html, /June 2025|2025/);
});

test('17. /how-vs-openpipe captures the capture-then-compile-vs-capture-then-hosted-endpoint contrast', () => {
  const html = read('openpipe');
  assert.match(html, /capture|seeds\.jsonl/i);
  assert.match(html, /endpoint|hosted/i);
});

test('18. /how-vs-diy names the underlying LLaMA-Factory / Unsloth / TRL stack', () => {
  const html = read('diy');
  assert.ok(/LLaMA-Factory|Unsloth|TRL|PEFT/i.test(html),
    'diy page must name the underlying DIY stack');
});

test('19. /how-vs-hyperscaler frames the closed-weight structural impossibility', () => {
  const html = read('hyperscaler');
  assert.match(html, /structural|impossib|closed[- ]weight|file you OWN|file you own/i);
});

test('20. /compare audit-trail section names every receipt-chain extension wave', () => {
  const html = read('compare');
  for (const wave of ['Wave 157', 'Wave 158', 'Wave 160', 'Wave 161', 'Wave 162', 'Wave 163', 'Wave 164', 'Wave 165', 'Wave 166', 'Wave 167']) {
    assert.ok(html.includes(wave), `compare.html audit trail missing ${wave}`);
  }
});
