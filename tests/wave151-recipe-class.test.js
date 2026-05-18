// Wave 151 — honest recipe-class taxonomy tests.
//
// This wave makes the four recipe classes (rule / synthesized_rule /
// compiled_rule / distilled_model) load-bearing in code. These tests pin the
// contract so future waves cannot quietly drift a "distilled_model" claim
// into shipping empty model.gguf bytes again — that was the exact failure
// the Wave 144 audit caught.
//
// Test surface, in order:
//   1-4.  Taxonomy module exports the four classes + ranks correctly
//   5-9.  validateRecipeClass throws on each misdeclared shape
//   10-14. validateArtifactClass rejects each manifest-vs-bytes mismatch
//   15-16. rollupArtifactClass picks the MAX class
//   17-18. classBadge returns a one-line honest summary
//   19-21. buildPayload integration — recipes get per-class field, manifest
//          gets artifact_class_breakdown, misdeclared artifact is rejected
//          before signing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RECIPE_CLASSES,
  CLASS_RANK,
  CLASS_DESCRIPTIONS,
  inferRecipeClass,
  validateRecipeClass,
  rollupArtifactClass,
  validateArtifactClass,
  classBadge,
} from '../src/recipe-class.js';

const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// --- 1-4. Taxonomy module ----------------------------------------------------

test('Wave151 / RECIPE_CLASSES contains the honest classes (W286 promoted workflow_capsule to 5th)', () => {
  // Wave 151 originally shipped four classes; Wave 286 promoted workflow_capsule
  // from a dead comment in src/workflow-ir.js to a real fifth class with full
  // verifier semantics. Keep the four pre-W286 classes in the asserted prefix.
  assert.deepEqual(
    RECIPE_CLASSES.slice(0, 4),
    ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'],
  );
  assert.ok(RECIPE_CLASSES.includes('workflow_capsule'),
    'W286 promoted workflow_capsule to a real class');
});

test('Wave151 / CLASS_RANK orders rule < synthesized_rule < compiled_rule < distilled_model', () => {
  assert.equal(CLASS_RANK.rule, 0);
  assert.equal(CLASS_RANK.synthesized_rule, 1);
  assert.equal(CLASS_RANK.compiled_rule, 2);
  assert.equal(CLASS_RANK.distilled_model, 3);
});

test('Wave151 / CLASS_DESCRIPTIONS carries the load-bearing flags per class', () => {
  // The product surfaces (badges, docs, /taxonomy page) pull these directly.
  // If any of them drift, the marketing copy and the verifier reasons drift apart.
  assert.equal(CLASS_DESCRIPTIONS.rule.teacher_required, false);
  assert.equal(CLASS_DESCRIPTIONS.rule.weights_required, false);
  assert.equal(CLASS_DESCRIPTIONS.synthesized_rule.teacher_required, true);
  assert.equal(CLASS_DESCRIPTIONS.synthesized_rule.weights_required, false);
  assert.equal(CLASS_DESCRIPTIONS.compiled_rule.teacher_required, false);
  assert.equal(CLASS_DESCRIPTIONS.compiled_rule.weights_required, false);
  assert.equal(CLASS_DESCRIPTIONS.distilled_model.teacher_required, true);
  assert.equal(CLASS_DESCRIPTIONS.distilled_model.weights_required, true);
  assert.equal(CLASS_DESCRIPTIONS.distilled_model.quantization_applicable, true);
});

test('Wave151 / inferRecipeClass picks the right class from recipe shape', () => {
  assert.equal(inferRecipeClass({}), 'rule');
  assert.equal(inferRecipeClass({ source: 'x' }), 'rule');
  assert.equal(inferRecipeClass({ teacher_vendor: 'anthropic' }), 'synthesized_rule');
  assert.equal(inferRecipeClass({ synthesized_by: 'claude-opus-4-7' }), 'synthesized_rule');
  assert.equal(inferRecipeClass({ compiled_targets: { c: { binary_hash: 'abc' } } }), 'compiled_rule');
  assert.equal(inferRecipeClass({ native_bin: 'phone.bin' }), 'compiled_rule');
  assert.equal(inferRecipeClass({ weights_file: 'model.gguf' }), 'distilled_model');
  assert.equal(inferRecipeClass({ gguf_file: 'model.gguf' }), 'distilled_model');
  assert.equal(inferRecipeClass({ onnx_file: 'model.onnx' }), 'distilled_model');
});

// --- 5-9. validateRecipeClass throws on misdeclared recipes ------------------

test('Wave151 / validateRecipeClass throws when declared class is unknown', () => {
  assert.throws(() => validateRecipeClass({ id: 'r1', class: 'magic-class' }),
    /must be one of/);
});

test('Wave151 / validateRecipeClass rejects distilled_model with no weights', () => {
  assert.throws(() => validateRecipeClass({
    id: 'fake-distill',
    class: 'distilled_model',
    source: 'function generate(){return true}',
  }), /distilled_model.*carries no weights/);
});

test('Wave151 / validateRecipeClass rejects compiled_rule with no DSL or native bin', () => {
  assert.throws(() => validateRecipeClass({
    id: 'fake-compiled',
    class: 'compiled_rule',
    source: 'function generate(){return true}',
  }), /compiled_rule.*carries no compiled_targets/);
});

test('Wave151 / validateRecipeClass rejects synthesized_rule with no teacher attribution', () => {
  assert.throws(() => validateRecipeClass({
    id: 'fake-synth',
    class: 'synthesized_rule',
    source: 'function generate(){return true}',
  }), /synthesized_rule.*carries no teacher attribution/);
});

test('Wave151 / validateRecipeClass accepts honest declarations', () => {
  assert.equal(validateRecipeClass({ id: 'r1', class: 'rule', source: 'x' }), 'rule');
  assert.equal(validateRecipeClass({
    id: 'r2', class: 'synthesized_rule', source: 'x', teacher_vendor: 'anthropic',
  }), 'synthesized_rule');
  assert.equal(validateRecipeClass({
    id: 'r3', class: 'compiled_rule', source: 'x', dsl: 'phone-norm dsl',
  }), 'compiled_rule');
  // W258-ML-8: distilled_model gguf_file path must exist + carry non-zero
  // bytes. Materialize a tiny GGUF fixture in a tmp dir so the validator's
  // "real model bytes" floor is satisfied honestly.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wave151-'));
  const ggufPath = path.join(tmp, 'model.gguf');
  fs.writeFileSync(ggufPath, Buffer.from('GGUF\x03\x00\x00\x00stub', 'binary'));
  assert.equal(validateRecipeClass({
    id: 'r4', class: 'distilled_model', source: 'x', gguf_file: ggufPath,
  }), 'distilled_model');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- 10-14. validateArtifactClass — manifest-vs-bytes contract ---------------

test('Wave151 / validateArtifactClass rejects unknown class', () => {
  const result = validateArtifactClass({ artifact_class: 'futureclass' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /is not in/);
});

test('Wave151 / validateArtifactClass rejects distilled_model with empty model_pointer', () => {
  const result = validateArtifactClass({
    artifact_class: 'distilled_model',
    base_model: 'Llama-3.2-1B',
    hashes: { model_pointer: EMPTY_SHA },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /distilled_model requires non-empty model_pointer/);
});

test('Wave151 / validateArtifactClass rejects distilled_model with base_model=none', () => {
  const result = validateArtifactClass({
    artifact_class: 'distilled_model',
    base_model: 'none',
    hashes: { model_pointer: 'a'.repeat(64) },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires manifest.base_model to be a real model name/);
});

test('Wave151 / validateArtifactClass rejects compiled_rule with no compiled_targets', () => {
  const result = validateArtifactClass({
    artifact_class: 'compiled_rule',
    base_model: 'none',
    hashes: { model_pointer: EMPTY_SHA },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /compiled_rule requires manifest.compiled_targets/);
});

test('Wave151 / validateArtifactClass rejects synthesized_rule with no teacher attribution', () => {
  const result = validateArtifactClass({
    artifact_class: 'synthesized_rule',
    base_model: 'none',
    hashes: { model_pointer: EMPTY_SHA },
    training: { distilled_pairs: 0 },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /synthesized_rule requires manifest.training/);
});

test('Wave151 / validateArtifactClass accepts honest rule artifact (floor case)', () => {
  const result = validateArtifactClass({
    artifact_class: 'rule',
    base_model: 'none',
    hashes: { model_pointer: EMPTY_SHA },
  });
  assert.equal(result.ok, true);
});

test('Wave151 / validateArtifactClass accepts honest distilled_model', () => {
  const result = validateArtifactClass({
    artifact_class: 'distilled_model',
    base_model: 'Llama-3.2-1B',
    hashes: { model_pointer: 'a'.repeat(64) },
  });
  assert.equal(result.ok, true);
});

// --- 15-16. rollupArtifactClass picks MAX ------------------------------------

test('Wave151 / rollupArtifactClass returns MAX of recipe classes', () => {
  assert.equal(rollupArtifactClass(['rule']), 'rule');
  assert.equal(rollupArtifactClass(['rule', 'rule', 'rule']), 'rule');
  assert.equal(rollupArtifactClass(['rule', 'synthesized_rule']), 'synthesized_rule');
  assert.equal(rollupArtifactClass(['rule', 'compiled_rule']), 'compiled_rule');
  assert.equal(rollupArtifactClass(['rule', 'synthesized_rule', 'compiled_rule']), 'compiled_rule');
  assert.equal(rollupArtifactClass(['rule', 'distilled_model']), 'distilled_model');
  assert.equal(rollupArtifactClass(['distilled_model', 'rule']), 'distilled_model');
  // Single distilled_model promotes the whole bundle (verifier must check weights).
  assert.equal(rollupArtifactClass(['rule', 'rule', 'rule', 'distilled_model']), 'distilled_model');
});

test('Wave151 / rollupArtifactClass defaults to rule when given garbage', () => {
  assert.equal(rollupArtifactClass([]), 'rule');
  assert.equal(rollupArtifactClass(null), 'rule');
  assert.equal(rollupArtifactClass(['unknown-class']), 'rule');
});

// --- 17-18. classBadge -------------------------------------------------------

test('Wave151 / classBadge returns short label + one-line description', () => {
  const badge = classBadge('rule');
  assert.match(badge, /Rule recipe/);
  assert.match(badge, /Deterministic/);
});

test('Wave151 / classBadge handles every known class', () => {
  for (const c of RECIPE_CLASSES) {
    const b = classBadge(c);
    assert.equal(typeof b, 'string');
    assert.ok(b.length > 10, `badge for ${c} is suspiciously short: ${b}`);
  }
});

// --- 19-21. Integration with buildPayload ------------------------------------

test('Wave151 / buildPayload writes per-recipe class into recipes.json', async (t) => {
  const savedSecret = process.env.RECIPE_RECEIPT_SECRET;
  const savedEd25519 = process.env.KOLM_ED25519_DISABLE;
  const savedSigstore = process.env.KOLM_SIGSTORE_DISABLE;
  process.env.RECIPE_RECEIPT_SECRET = 'wave151_test_secret';
  process.env.KOLM_ED25519_DISABLE = '1';
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  t.after(() => {
    if (savedSecret === undefined) delete process.env.RECIPE_RECEIPT_SECRET;
    else process.env.RECIPE_RECEIPT_SECRET = savedSecret;
    if (savedEd25519 === undefined) delete process.env.KOLM_ED25519_DISABLE;
    else process.env.KOLM_ED25519_DISABLE = savedEd25519;
    if (savedSigstore === undefined) delete process.env.KOLM_SIGSTORE_DISABLE;
    else process.env.KOLM_SIGSTORE_DISABLE = savedSigstore;
  });

  const { buildPayload } = await import(`../src/artifact.js?wave151-perclass=${Date.now()}`);
  const payload = buildPayload({
    job_id: 'job_wave151',
    task: 'wave151 per-class',
    recipes: [
      { id: 'rule-1', name: 'r1', source: 'function generate(){return true}', source_hash: 'sha256:a' },
      { id: 'synth-1', name: 's1', source: 'function generate(){return true}', source_hash: 'sha256:b',
        teacher_vendor: 'anthropic', teacher_model: 'claude-opus-4-7' },
    ],
    training_stats: { distilled_pairs: 0 },
    evals: { spec: 'rs-1-evals', n: 1, cases: [{ input: 'x', expected: true }] },
  });

  const recipesFile = payload.files.find(f => f.filename === 'recipes.json');
  const recipesJson = JSON.parse(recipesFile.content.toString('utf8'));
  assert.equal(recipesJson.recipes.length, 2);
  assert.equal(recipesJson.recipes[0].class, 'rule');
  assert.equal(recipesJson.recipes[1].class, 'synthesized_rule');
  assert.equal(recipesJson.recipes[1].teacher_vendor, 'anthropic');
});

test('Wave151 / manifest.artifact_class_breakdown reflects per-recipe counts and rolls up', async (t) => {
  const savedSecret = process.env.RECIPE_RECEIPT_SECRET;
  const savedEd25519 = process.env.KOLM_ED25519_DISABLE;
  const savedSigstore = process.env.KOLM_SIGSTORE_DISABLE;
  process.env.RECIPE_RECEIPT_SECRET = 'wave151_test_secret';
  process.env.KOLM_ED25519_DISABLE = '1';
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  t.after(() => {
    if (savedSecret === undefined) delete process.env.RECIPE_RECEIPT_SECRET;
    else process.env.RECIPE_RECEIPT_SECRET = savedSecret;
    if (savedEd25519 === undefined) delete process.env.KOLM_ED25519_DISABLE;
    else process.env.KOLM_ED25519_DISABLE = savedEd25519;
    if (savedSigstore === undefined) delete process.env.KOLM_SIGSTORE_DISABLE;
    else process.env.KOLM_SIGSTORE_DISABLE = savedSigstore;
  });

  const { buildPayload } = await import(`../src/artifact.js?wave151-breakdown=${Date.now()}`);
  const payload = buildPayload({
    job_id: 'job_wave151b',
    task: 'wave151 breakdown',
    recipes: [
      { id: 'rule-1', name: 'r1', source: 'function generate(){return true}', source_hash: 'sha256:a' },
      { id: 'rule-2', name: 'r2', source: 'function generate(){return true}', source_hash: 'sha256:b' },
      { id: 'synth-1', name: 's1', source: 'function generate(){return true}', source_hash: 'sha256:c',
        teacher_vendor: 'anthropic' },
    ],
    training_stats: { distilled_pairs: 0 },
    evals: { spec: 'rs-1-evals', n: 1, cases: [{ input: 'x', expected: true }] },
  });

  const manifest = payload.manifest;
  assert.equal(manifest.artifact_class, 'synthesized_rule', 'rollup picks MAX over rule, rule, synthesized_rule');
  assert.deepEqual(manifest.artifact_class_breakdown, { rule: 2, synthesized_rule: 1 });
});

test('Wave151 / buildPayload rejects misdeclared distilled_model BEFORE signing', async (t) => {
  const savedSecret = process.env.RECIPE_RECEIPT_SECRET;
  const savedEd25519 = process.env.KOLM_ED25519_DISABLE;
  const savedSigstore = process.env.KOLM_SIGSTORE_DISABLE;
  process.env.RECIPE_RECEIPT_SECRET = 'wave151_test_secret';
  process.env.KOLM_ED25519_DISABLE = '1';
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  t.after(() => {
    if (savedSecret === undefined) delete process.env.RECIPE_RECEIPT_SECRET;
    else process.env.RECIPE_RECEIPT_SECRET = savedSecret;
    if (savedEd25519 === undefined) delete process.env.KOLM_ED25519_DISABLE;
    else process.env.KOLM_ED25519_DISABLE = savedEd25519;
    if (savedSigstore === undefined) delete process.env.KOLM_SIGSTORE_DISABLE;
    else process.env.KOLM_SIGSTORE_DISABLE = savedSigstore;
  });

  const { buildPayload } = await import(`../src/artifact.js?wave151-reject=${Date.now()}`);
  assert.throws(() => buildPayload({
    job_id: 'job_wave151c',
    task: 'wave151 reject',
    recipes: [
      // Recipe claims distilled_model but ships no weights — pre-Wave-144 lie.
      { id: 'liar', name: 'liar', class: 'distilled_model',
        source: 'function generate(){return true}', source_hash: 'sha256:liar' },
    ],
    training_stats: { distilled_pairs: 0 },
    evals: { spec: 'rs-1-evals', n: 1, cases: [{ input: 'x', expected: true }] },
  }), /distilled_model.*carries no weights/);
});
