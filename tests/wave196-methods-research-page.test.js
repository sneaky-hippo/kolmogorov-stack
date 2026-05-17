// Wave 196 -- Shift 5: frontier methods research page. Locks in the
// /research/methods-2026-q2 public surface that grounds kolm in the
// 2026-Q2 state of the art (distillation, sample efficiency, quantization,
// data synthesis, NL-to-recipe). Each assertion ties one piece of rendered
// prose to a primary citation (paper, repo, vendor blog) or a kolm source
// file (src/tune.js, src/synthesis.js, src/assistant.js, src/recipe-class.js,
// or the three not-yet-shipped roadmap modules) so the page cannot drift
// from the research dump it is meant to surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const PAGE = path.join(PUBLIC, 'research', 'methods-2026-q2.html');
const SW = path.join(PUBLIC, 'sw.js');
const VERCEL = path.join(REPO, 'vercel.json');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /research/methods-2026-q2 page exists on disk and is non-trivial size', () => {
  assert.ok(fs.existsSync(PAGE), `methods-2026-q2.html missing at ${PAGE}`);
  const stat = fs.statSync(PAGE);
  assert.ok(stat.size > 18432,
    `methods-2026-q2.html too small (${stat.size} bytes; expected > 18 KB)`);
});

test('2. page declares canonical URL https://kolm.ai/research/methods-2026-q2', () => {
  const html = read(PAGE);
  assert.match(html,
    /<link rel="canonical" href="https:\/\/kolm\.ai\/research\/methods-2026-q2"/,
    'methods-2026-q2.html must declare canonical https://kolm.ai/research/methods-2026-q2');
});

test('3. all seven section headings present (mirrors source 7-section structure)', () => {
  const html = read(PAGE);
  const SECTIONS = [
    'id="distillation"',
    'id="sample-efficiency"',
    'id="base-models"',
    'id="quantization"',
    'id="data-creation"',
    'id="nl-to-recipe"',
    'id="rule-of-thumb"',
  ];
  for (const s of SECTIONS) {
    assert.ok(html.includes(s),
      `methods-2026-q2.html missing section anchor "${s}"`);
  }
});

test('4. page cites at least 25 of the 26 named primary methods/models/tools', () => {
  const html = read(PAGE);
  const REQUIRED = [
    'QLoRA',
    'SimPO',
    'KTO',
    'ORPO',
    'Quiet-STaR',
    'EAGLE-3',
    'Medusa',
    'On-Policy Distillation',
    'LIMA',
    'UltraFeedback',
    'Tulu',                 // matches Tulu-3 / Tulu 3
    'SmolLM2',
    'Qwen2.5',
    'Llama-3.2',
    'Phi-4',
    'Gemma 3',              // matches Gemma 3 / Gemma-3 — source uses both
    'GGUF',
    'AWQ',
    'Unsloth',
    'Self-Instruct',
    'Evol-Instruct',
    'Magpie',
    'Persona-Hub',          // matches Persona Hub / Persona-Hub
    'Constitutional AI',
    'BFCL',
    'XGrammar',
    'AlphaCodium',
  ];
  const hits = REQUIRED.filter((needle) => {
    // Try multiple casings/punctuations for known variants
    if (needle === 'Persona-Hub') return html.includes('Persona-Hub') || html.includes('Persona Hub');
    if (needle === 'Tulu') return html.includes('Tulu-3') || html.includes('Tulu 3') || html.includes('Tulu&nbsp;3');
    if (needle === 'On-Policy Distillation') return html.includes('On-Policy Distillation') || html.includes('on-policy distillation');
    if (needle === 'Gemma 3') return html.includes('Gemma 3') || html.includes('Gemma-3') || html.includes('Gemma&nbsp;3');
    return html.includes(needle);
  });
  assert.ok(hits.length >= 25,
    `methods-2026-q2.html cites only ${hits.length}/${REQUIRED.length} required methods; missing: ${REQUIRED.filter((n, i) => !hits.includes(n)).join(', ')}`);
});

test('5. page cites src/tune.js, src/synthesis.js, src/assistant.js, src/recipe-class.js as landing surfaces', () => {
  const html = read(PAGE);
  const SHIPPED = [
    'src/tune.js',
    'src/synthesis.js',
    'src/assistant.js',
    'src/recipe-class.js',
  ];
  for (const f of SHIPPED) {
    assert.ok(html.includes(f),
      `methods-2026-q2.html missing shipped landing surface "${f}"`);
  }
});

test('6. page cites distill-onpolicy.js, distill-preference.js, spec-decode.js as roadmap-only', () => {
  const html = read(PAGE);
  const ROADMAP = [
    'distill-onpolicy.js',
    'distill-preference.js',
    'spec-decode.js',
  ];
  for (const f of ROADMAP) {
    assert.ok(html.includes(f),
      `methods-2026-q2.html missing roadmap module "${f}"`);
  }
  // The phrase "not yet shipped" must appear so readers cannot misread
  // the roadmap modules as shipped.
  assert.ok(html.includes('not yet shipped') || html.includes('Not yet shipped') || html.includes('roadmap'),
    'methods-2026-q2.html must label roadmap modules as "not yet shipped" or "roadmap"');
  // Stronger: assert "Not yet shipped" appears at least three times (one per roadmap card)
  const occurrences = (html.match(/Not yet shipped/g) || []).length;
  assert.ok(occurrences >= 3,
    `methods-2026-q2.html should label all three roadmap modules as "Not yet shipped"; found ${occurrences} occurrence(s)`);
});

test('7. vercel.json has the /research/methods-2026-q2 rewrite', () => {
  const cfg = read(VERCEL);
  assert.ok(
    cfg.includes('"/research/methods-2026-q2"'),
    'vercel.json missing explicit /research/methods-2026-q2 rewrite source');
  // Verify destination is paired correctly
  assert.match(cfg,
    /"source":\s*"\/research\/methods-2026-q2",\s*"destination":\s*"\/research\/methods-2026-q2\.html"/,
    'vercel.json /research/methods-2026-q2 rewrite must map to /research/methods-2026-q2.html');
});

test('8. sw.js CACHE wave segment is >= 175 (wave-floor regex; never literal match)', () => {
  const sw = read(SW);
  // Pattern: const CACHE = 'kolm-vN-YYYY-MM-DD-waveNNN-...'
  // Lock-in tests for monotonically-increasing values MUST use >= comparison,
  // not equality, to avoid the known regression trap of pinning a literal
  // wave slug that breaks on every subsequent wave bump.
  const match = sw.match(/const\s+CACHE\s*=\s*'[^']*wave(\d+)/);
  assert.ok(match,
    'sw.js must declare const CACHE with embedded waveNNN slug');
  const wave = Number(match[1]);
  assert.ok(wave >= 175,
    `sw.js CACHE wave segment must be >= 175 (found wave${wave})`);
});

test('9. canonical citations carry a verifiable hyperlink to arXiv / HF / GitHub / vendor blog', () => {
  const html = read(PAGE);
  // At least the foundational sources must be hyperlinked, not just named.
  const REQUIRED_HREFS = [
    'arxiv.org/abs/2305.14314',     // QLoRA
    'arxiv.org/abs/2305.18290',     // DPO
    'arxiv.org/abs/2405.14734',     // SimPO
    'arxiv.org/abs/2305.11206',     // LIMA
    'thinkingmachines.ai/blog/on-policy-distillation',
    'github.com/magpie-align/magpie',
    'gorilla.cs.berkeley.edu/leaderboard',  // BFCL
    'arxiv.org/abs/2401.08500',     // AlphaCodium
  ];
  for (const href of REQUIRED_HREFS) {
    assert.ok(html.includes(href),
      `methods-2026-q2.html missing canonical hyperlink containing "${href}"`);
  }
});

test('10. seven-section structure is rendered in order (TOC matches headings)', () => {
  const html = read(PAGE);
  // The TOC items must appear in the same order as the section anchors
  // so readers cannot jump to a misnumbered section.
  const tocOrder = [
    'href="#distillation"',
    'href="#sample-efficiency"',
    'href="#base-models"',
    'href="#quantization"',
    'href="#data-creation"',
    'href="#nl-to-recipe"',
    'href="#rule-of-thumb"',
    'href="#what-ships"',
  ];
  let cursor = 0;
  for (const item of tocOrder) {
    const idx = html.indexOf(item, cursor);
    assert.ok(idx > cursor,
      `methods-2026-q2.html TOC out of order at "${item}"`);
    cursor = idx;
  }
});

test('11. closing "what ships today" section separates shipped from roadmap', () => {
  const html = read(PAGE);
  assert.ok(html.includes('id="what-ships"'),
    'methods-2026-q2.html missing closing #what-ships section');
  // The section must visually mark shipped vs roadmap with the ships-card pattern.
  const shippedCards = (html.match(/ships-card shipped/g) || []).length;
  const roadmapCards = (html.match(/ships-card roadmap/g) || []).length;
  assert.ok(shippedCards >= 4,
    `methods-2026-q2.html should mark 4 shipped modules; found ${shippedCards}`);
  assert.ok(roadmapCards >= 3,
    `methods-2026-q2.html should mark 3 roadmap modules; found ${roadmapCards}`);
});

test('12. footer signpost grid cross-links to /training, /research/eval-set-drift, /research/provenance-data-generation, /spec/rs-1, /drift', () => {
  const html = read(PAGE);
  // Pull just the signpost grid to avoid matching footer-nav coincidental links.
  const m = html.match(/<div class="signpost">([\s\S]*?)<\/div>\s*<\/div>/);
  assert.ok(m, 'methods-2026-q2.html missing signpost grid');
  const signpost = m[1];
  for (const href of [
    'href="/training"',
    'href="/research/eval-set-drift"',
    'href="/research/provenance-data-generation"',
    'href="/spec/rs-1"',
    'href="/drift"',
  ]) {
    assert.ok(signpost.includes(href),
      `methods-2026-q2.html signpost grid missing required cross-link "${href}"`);
  }
});

test('13. light-theme switch IIFE present in <head> before paint', () => {
  const html = read(PAGE);
  // The pre-paint IIFE that reads localStorage and applies data-theme=light
  // must run inside <head> before body styles paint to avoid dark-flash for
  // light-mode users. This is the canonical pattern from eval-set-drift.html.
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /localStorage\.getItem\('kolm-theme'\)/,
    'methods-2026-q2.html missing light-theme pre-paint IIFE in <head>');
  assert.match(head, /data-theme/,
    'methods-2026-q2.html pre-paint IIFE must set data-theme attribute');
});

test('14. "verify before ship" annotations carried over for unverified claims (not silently promoted)', () => {
  const html = read(PAGE);
  // Source doc had specific items marked [verify before ship]. The page
  // must either omit them or carry the same annotation visible to readers.
  // At minimum, SpQR + Variational Speculative Decoding (named below) must
  // either be absent or accompanied by the verify-before-ship marker.
  const hasVerifyTag = html.includes('verify before ship');
  assert.ok(hasVerifyTag,
    'methods-2026-q2.html must surface at least one "verify before ship" annotation visible to readers (or omit all unverified claims)');
  // If SpQR is mentioned, verify-before-ship must appear in the same paragraph
  // or list item to avoid silent promotion.
  if (html.includes('SpQR')) {
    const spqrIdx = html.indexOf('SpQR');
    const window = html.slice(spqrIdx, spqrIdx + 500);
    assert.ok(window.includes('verify before ship'),
      'methods-2026-q2.html mentions SpQR but omits its [verify before ship] annotation from the source dump');
  }
  // Same constraint for Variational Speculative Decoding.
  if (html.includes('Variational Speculative')) {
    const vIdx = html.indexOf('Variational Speculative');
    const window = html.slice(vIdx, vIdx + 500);
    assert.ok(window.includes('verify before ship'),
      'methods-2026-q2.html mentions Variational Speculative Decoding but omits its [verify before ship] annotation');
  }
});
