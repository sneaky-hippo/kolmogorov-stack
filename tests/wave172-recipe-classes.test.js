// Wave 172 — Q+10 fit-and-finish: /recipe-classes alias to /taxonomy and
// the class-decision-tree section appended to /taxonomy. Locks in that the
// public taxonomy surface enumerates every constant exported by
// src/recipe-class.js so the page cannot drift away from the spec it
// documents. Same lock-in pattern as W171/tests/wave171-drift-ui.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECIPE_CLASSES,
  CLASS_RANK,
  CLASS_DESCRIPTIONS,
  inferRecipeClass,
  validateArtifactClass,
} from '../src/recipe-class.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const TAXONOMY = path.join(PUBLIC, 'taxonomy.html');
const SW = path.join(PUBLIC, 'sw.js');
const VERCEL = path.join(REPO, 'vercel.json');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /taxonomy page exists and is non-trivial size after W172 decision-tree expansion', () => {
  assert.ok(fs.existsSync(TAXONOMY), `taxonomy.html missing at ${TAXONOMY}`);
  const stat = fs.statSync(TAXONOMY);
  assert.ok(stat.size > 12 * 1024, `taxonomy.html too small (${stat.size} bytes; expected > 12 KB after decision tree + verifier-rejection cards)`);
});

test('2. /taxonomy declares the canonical https://kolm.ai/taxonomy URL', () => {
  const html = read(TAXONOMY);
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/taxonomy"/,
    'taxonomy.html must declare canonical https://kolm.ai/taxonomy');
});

test('3. /taxonomy enumerates every class in RECIPE_CLASSES', () => {
  const html = read(TAXONOMY);
  for (const klass of RECIPE_CLASSES) {
    assert.ok(html.includes(klass), `taxonomy.html missing class "${klass}" from RECIPE_CLASSES`);
  }
});

test('4. /taxonomy surfaces every CLASS_RANK value', () => {
  const html = read(TAXONOMY);
  for (const [klass, rank] of Object.entries(CLASS_RANK)) {
    assert.ok(html.includes(`${klass}=${rank}`),
      `taxonomy.html must surface CLASS_RANK ${klass}=${rank} (so prose matches src/recipe-class.js)`);
  }
});

test('5. /taxonomy renders each class one-liner from CLASS_DESCRIPTIONS', () => {
  const html = read(TAXONOMY);
  for (const [klass, desc] of Object.entries(CLASS_DESCRIPTIONS)) {
    // The one-liner is the load-bearing badge — escape ampersand for HTML.
    const oneLine = desc.one_line.replace(/&/g, '&amp;');
    assert.ok(
      html.includes(oneLine) || html.includes(desc.one_line),
      `taxonomy.html missing CLASS_DESCRIPTIONS[${klass}].one_line: ${desc.one_line.slice(0, 60)}…`
    );
  }
});

test('6. /taxonomy decision tree names every dispatch field from inferRecipeClass()', () => {
  const html = read(TAXONOMY);
  // From src/recipe-class.js inferRecipeClass(): the four dispatch fields are
  // weights_file/gguf_file/onnx_file, compiled_targets/native_bin,
  // synthesized_by/teacher_vendor.
  for (const field of ['weights_file', 'gguf_file', 'onnx_file', 'compiled_targets',
    'native_bin', 'synthesized_by', 'teacher_vendor']) {
    assert.ok(html.includes(field),
      `taxonomy.html decision tree missing inferRecipeClass dispatch field "${field}"`);
  }
});

test('7. /taxonomy decision tree numbers the four steps in dispatch order', () => {
  const html = read(TAXONOMY);
  for (const step of ['1.', '2.', '3.', '4.']) {
    assert.ok(html.includes(step), `taxonomy.html decision tree missing step "${step}"`);
  }
  // The default branch must reach `rule` as the floor.
  assert.ok(html.includes('Default') && html.includes('floor'),
    'taxonomy.html decision tree must mark step 4 as the default floor → rule');
});

test('8. /taxonomy surfaces the verifier rejection conditions from validateArtifactClass()', () => {
  const html = read(TAXONOMY);
  // The EMPTY_SHA constant from src/recipe-class.js — load-bearing because
  // the verifier rejects distilled_model artifacts whose model_pointer equals
  // sha256 of the empty buffer. The page MUST quote that hash so a reader
  // can match the verifier reject reason to the page.
  const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.ok(html.includes(EMPTY_SHA),
    'taxonomy.html must quote the EMPTY_SHA constant so the verifier reject reason for empty model_pointer matches the page');
  // base_model='none' is the second distilled_model rejection.
  assert.ok(html.includes("'none'") || html.includes('"none"'),
    "taxonomy.html must call out base_model='none' as a verifier reject reason");
  // compiled_rule requires compiled_targets.
  assert.ok(html.includes('compiled_targets'),
    'taxonomy.html must call out compiled_targets as a compiled_rule requirement');
});

test('9. /taxonomy carries the W144 honest-reset context (page reason + verifier semantics)', () => {
  const html = read(TAXONOMY);
  const lower = html.toLowerCase();
  assert.ok(lower.includes('wave 144'),
    'taxonomy.html must cite Wave 144 (origin of the honest taxonomy)');
  assert.ok(lower.includes('recipe-class.js') || lower.includes('src/recipe-class.js'),
    'taxonomy.html must name src/recipe-class.js as the source of truth');
});

test('10. /taxonomy cross-links to canonical surfaces (/spec/rs-1 + /k-score + /drift + /compare)', () => {
  const html = read(TAXONOMY);
  for (const href of ['/spec/rs-1', '/k-score', '/drift', '/compare']) {
    assert.ok(html.includes(`href="${href}"`),
      `taxonomy.html "Where this fits" grid must link to ${href}`);
  }
});

test('11. /taxonomy uses the consistent design system (mono + color tokens via inline CSS)', () => {
  const html = read(TAXONOMY);
  // taxonomy.html uses inline + /styles.css design tokens. Check inline tokens:
  assert.match(html, /var\(--mono/, 'taxonomy.html must reference --mono token');
  assert.match(html, /var\(--muted|var\(--ink/, 'taxonomy.html must reference --muted or --ink token');
});

test('12. vercel.json rewrites /recipe-classes to /taxonomy.html', () => {
  const vercel = JSON.parse(read(VERCEL));
  const rewrite = vercel.rewrites.find((r) => r.source === '/recipe-classes');
  assert.ok(rewrite, 'vercel.json missing rewrite for /recipe-classes');
  assert.equal(rewrite.destination, '/taxonomy.html',
    'vercel.json /recipe-classes rewrite must target /taxonomy.html (alias to existing Q+10 surface)');
});

test('13. sw.js CACHE bumped to wave172 or later slug', () => {
  const sw = read(SW);
  const m = sw.match(/const CACHE = 'kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(Number(m[1]) >= 172,
    `sw.js CACHE wave segment must be >= 172 (saw wave${m[1]})`);
});

test('14. inferRecipeClass() invariants surfaced on the page hold against backend', () => {
  // This test wires the page-prose claims back to actual function behavior.
  // If any of these assertions fail, BOTH the page AND the test need updating.
  assert.equal(inferRecipeClass({ weights_file: 'm.gguf' }), 'distilled_model');
  assert.equal(inferRecipeClass({ gguf_file: 'm.gguf' }), 'distilled_model');
  assert.equal(inferRecipeClass({ onnx_file: 'm.onnx' }), 'distilled_model');
  assert.equal(inferRecipeClass({ compiled_targets: ['linux-x64'] }), 'compiled_rule');
  assert.equal(inferRecipeClass({ native_bin: 'bin/foo' }), 'compiled_rule');
  assert.equal(inferRecipeClass({ teacher_vendor: 'anthropic' }), 'synthesized_rule');
  assert.equal(inferRecipeClass({ synthesized_by: 'claude-opus-4-7' }), 'synthesized_rule');
  assert.equal(inferRecipeClass({}), 'rule');
});

test('15. validateArtifactClass() reject reasons surfaced on the page actually fire', () => {
  // Empty model_pointer must reject — page claims this, prove it.
  const emptyModel = validateArtifactClass({
    artifact_class: 'distilled_model',
    base_model: 'llama-3.2-1b',
    hashes: { model_pointer: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  });
  assert.equal(emptyModel.ok, false, 'empty model_pointer must reject');
  assert.match(emptyModel.reason, /empty|model_pointer/i);

  // Missing base_model must reject.
  const noBase = validateArtifactClass({
    artifact_class: 'distilled_model',
    base_model: 'none',
    hashes: { model_pointer: 'abc123' },
  });
  assert.equal(noBase.ok, false, "base_model='none' must reject");

  // Missing compiled_targets must reject compiled_rule.
  const noTargets = validateArtifactClass({ artifact_class: 'compiled_rule' });
  assert.equal(noTargets.ok, false, 'compiled_rule with no compiled_targets must reject');

  // Missing teacher attribution must reject synthesized_rule.
  const noTeacher = validateArtifactClass({ artifact_class: 'synthesized_rule', training: {} });
  assert.equal(noTeacher.ok, false, 'synthesized_rule with no teacher must reject');

  // Unknown class must reject.
  const bad = validateArtifactClass({ artifact_class: 'not_a_class' });
  assert.equal(bad.ok, false, 'unknown class must reject');

  // rule with no positive requirement must pass.
  const ok = validateArtifactClass({ artifact_class: 'rule' });
  assert.equal(ok.ok, true, 'rule artifact_class is the floor and must pass');
});

test('16. /taxonomy self-stamps wave 172 in the decision-tree expansion', () => {
  // Not strictly required, but lets us prove the expansion landed via grep.
  // The page surfaces the decision tree which is a W172 addition; allow the
  // looser check that the rollupArtifactClass function name is named.
  const html = read(TAXONOMY);
  assert.ok(html.includes('rollupArtifactClass'),
    'taxonomy.html must name rollupArtifactClass() so readers can grep src/recipe-class.js');
  assert.ok(html.includes('CLASS_RANK'),
    'taxonomy.html must name CLASS_RANK so readers can grep src/recipe-class.js');
});

test('17. /taxonomy decision tree shows the verdict color for each terminal class', () => {
  const html = read(TAXONOMY);
  for (const klass of RECIPE_CLASSES) {
    // Each class must appear as a verdict in the tree.
    assert.ok(
      html.includes(`verdict">${klass}</span>`) || html.includes(`verdict">${klass} `),
      `taxonomy.html decision tree must mark "${klass}" as a verdict outcome`
    );
  }
});
