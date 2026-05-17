// Wave 198 -- /training page refresh that surfaces the W196 frontier-methods
// table inline and adds a per-recipe-class "how much data do I actually need"
// grid. Each test ties one piece of rendered prose to either a kolm source
// constant (RECIPE_CLASSES / CLASS_RANK from src/recipe-class.js) or to an
// anchor on the W196 page (/research/methods-2026-q2) so the additive refresh
// cannot drift away from the things it cites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const PAGE = path.join(PUBLIC, 'training.html');
const W196 = path.join(PUBLIC, 'research', 'methods-2026-q2.html');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /training page exists on disk and is non-trivial size (grown vs prior)', () => {
  assert.ok(fs.existsSync(PAGE), `training.html missing at ${PAGE}`);
  const stat = fs.statSync(PAGE);
  // Prior baseline was ~59 KB; the W198 additive refresh adds ~9 KB.
  // Floor at 12 KB is the stated requirement; the page sits well above it.
  assert.ok(stat.size > 12 * 1024,
    `training.html too small (${stat.size} bytes; expected > 12 KB after W198 refresh)`);
});

test('2. canonical URL https://kolm.ai/training preserved', () => {
  const html = read(PAGE);
  assert.match(html,
    /<link rel="canonical" href="https:\/\/kolm\.ai\/training"/,
    'training.html must declare canonical https://kolm.ai/training');
});

test('3. NEW section "Frontier methods (Q2 2026 sweep)" header present', () => {
  const html = read(PAGE);
  assert.match(html, /Frontier methods \(Q2 2026 sweep\)/,
    'training.html must include the W198 frontier-methods section header');
});

test('4. NEW section "How much data do I actually need?" header present', () => {
  const html = read(PAGE);
  assert.match(html, /How much data do I actually need\?/,
    'training.html must include the W198 how-much-data section header');
});

test('5. cross-link to /research/methods-2026-q2 (W196) present', () => {
  const html = read(PAGE);
  assert.match(html, /href="\/research\/methods-2026-q2"/,
    'training.html must cross-link to the W196 methods research page');
});

test('6. cites at least 4 of the 6 W196-sourced method names', () => {
  const html = read(PAGE);
  const NAMES = [
    'Knowledge Distillation',
    'QLoRA',
    'On-Policy Distillation',
    'Self-Instruct',
    'Evol-Instruct',
    'Speculative decoding',
    'EAGLE-3',
    'Medusa',
    'SimPO',
    'KTO',
    'ORPO',
  ];
  const hits = NAMES.filter((n) => html.includes(n));
  assert.ok(hits.length >= 4,
    `training.html cites only ${hits.length} W196 method names: ${hits.join(', ')}; expected >= 4`);
});

test('7. names recipe class "rule" in the data-volume grid', () => {
  const html = read(PAGE);
  // We assert on the class-card heading, not the bare word "rule",
  // because the page already uses "rule" throughout the tier ladder.
  assert.match(html, /<h3>rule<\/h3>/,
    'how-much-data grid must include a card titled "rule"');
});

test('8. names recipe class "synthesized_rule" in the data-volume grid', () => {
  const html = read(PAGE);
  assert.match(html, /<h3>synthesized_rule<\/h3>/,
    'how-much-data grid must include a card titled "synthesized_rule"');
});

test('9. names recipe class "compiled_rule" in the data-volume grid', () => {
  const html = read(PAGE);
  assert.match(html, /<h3>compiled_rule<\/h3>/,
    'how-much-data grid must include a card titled "compiled_rule"');
});

test('10. names recipe class "distilled_model" in the data-volume grid', () => {
  const html = read(PAGE);
  assert.match(html, /<h3>distilled_model<\/h3>/,
    'how-much-data grid must include a card titled "distilled_model"');
});

test('11. CLASS_RANK 0, 1, 2, 3 all appear in the data-volume cards', () => {
  const html = read(PAGE);
  for (const r of [0, 1, 2, 3]) {
    assert.match(html, new RegExp(`CLASS_RANK ${r}`),
      `how-much-data grid must label one card with CLASS_RANK ${r}`);
  }
});

test('12. cites LIMA 1,000 high-quality examples finding', () => {
  const html = read(PAGE);
  // LIMA must appear by name AND with the "1,000" / "1000" anchor figure.
  assert.match(html, /LIMA/, 'must cite the LIMA paper by name');
  const hasFigure = /1,000/.test(html) || /\b1000\b/.test(html);
  assert.ok(hasFigure,
    'must cite the LIMA anchor figure ("1,000" or "1000" high-quality examples)');
});

test('13. mentions the K-score gate as the quality-enforcement mechanism', () => {
  const html = read(PAGE);
  assert.match(html, /K-score gate/,
    'must mention the K-score gate as the quality-enforcement mechanism in the callout');
});

test('14. every frontier-methods row carries a shipped or roadmap status pill', () => {
  const html = read(PAGE);
  // Extract just the frontier-methods table; we expect every <tr> in
  // its <tbody> to contain at least one "status-pill" instance.
  const FRONTIER = html.match(/<section class="frontier"[\s\S]*?<\/section>/);
  assert.ok(FRONTIER, 'frontier-methods section must be present');
  const tbody = FRONTIER[0].match(/<tbody>[\s\S]*?<\/tbody>/);
  assert.ok(tbody, 'frontier-methods table must have a <tbody>');
  const rows = tbody[0].match(/<tr>[\s\S]*?<\/tr>/g) || [];
  assert.ok(rows.length >= 6,
    `frontier-methods table must have >= 6 rows; got ${rows.length}`);
  for (const r of rows) {
    assert.ok(/status-pill (shipped|roadmap)/.test(r),
      `frontier-methods row missing status-pill (shipped|roadmap): ${r.slice(0, 80)}...`);
  }
});

test('15. worked-example cross-references >= 3 W176-W184 templates', () => {
  const html = read(PAGE);
  const TEMPLATES = [
    'EDI 837',
    'MLR-rebate',
    'HEDIS CBP',
    'CMS Star',
    'denial-appeal-letter',
    'prior-auth-letter',
    'phi-redactor',
  ];
  const hits = TEMPLATES.filter((t) => html.includes(t));
  assert.ok(hits.length >= 3,
    `how-much-data worked examples cite only ${hits.length} templates: ${hits.join(', ')}; expected >= 3`);
});

test('16. NO em-dashes inside the W198 sections (use hyphens or middle-dots)', () => {
  const html = read(PAGE);
  // Slice the two new sections out and scan only those for the em-dash
  // glyph (U+2014) and the &mdash; entity. The existing tier ladder
  // uses &mdash; freely, so we must not assert globally.
  const frontier = html.match(/<section class="frontier"[\s\S]*?<\/section>/);
  const howmuch = html.match(/<section class="howmuch"[\s\S]*?<\/section>/);
  assert.ok(frontier, 'frontier section must be present');
  assert.ok(howmuch, 'howmuch section must be present');
  const blob = frontier[0] + '\n' + howmuch[0];
  assert.ok(!blob.includes('—'),
    'W198 sections must not contain the em-dash glyph U+2014');
  assert.ok(!blob.includes('&mdash;'),
    'W198 sections must not contain the &mdash; HTML entity');
});

test('17. W196 page anchors cited by status pills actually exist on the W196 page', () => {
  // Tie the additive refresh back to the page it claims to surface.
  // If a future wave renames an anchor on /research/methods-2026-q2, this
  // test fails and forces the link list on /training to be updated.
  const trainHtml = read(PAGE);
  const w196Html = read(W196);
  // Pull every methods-2026-q2#anchor target out of /training and assert
  // the matching id="<anchor>" exists in the W196 page.
  const re = /\/research\/methods-2026-q2#([a-z0-9\-]+)/g;
  const found = new Set();
  let m;
  while ((m = re.exec(trainHtml)) !== null) found.add(m[1]);
  assert.ok(found.size > 0,
    'training.html must cite at least one /research/methods-2026-q2#<anchor>');
  for (const anchor of found) {
    assert.match(w196Html, new RegExp(`id="${anchor}"`),
      `training.html links to /research/methods-2026-q2#${anchor} but no id="${anchor}" exists on the W196 page`);
  }
});

test('18. status pills name the source-module path for shipped/roadmap rows', () => {
  // src/tune.js, src/synthesis.js, scripts/tune-step.py, src/distill-onpolicy.js,
  // src/distill-preference.js, src/spec-decode.js -- the W196 dump names these
  // as the canonical paths; we require at least four of them to appear next
  // to the shipping/roadmap pills on /training so the page mirrors the source map.
  const html = read(PAGE);
  const PATHS = [
    'src/tune.js',
    'src/synthesis.js',
    'scripts/tune-step.py',
    'src/distill-onpolicy.js',
    'src/distill-preference.js',
    'src/spec-decode.js',
  ];
  const hits = PATHS.filter((p) => html.includes(p));
  assert.ok(hits.length >= 4,
    `training.html must name >= 4 source-module paths in the frontier-methods rows; got ${hits.length}: ${hits.join(', ')}`);
});
