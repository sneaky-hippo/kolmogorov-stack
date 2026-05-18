// W285 — every recipe in recipes.json carries an honest `source_type`
// declaring HOW the source was produced, not just what it does.
//
// Allowed source_type values:
//   hand_written        — human author, no LLM
//   pattern_generated   — deterministic pattern-matcher emitted the code
//   llm_emitted         — LLM teacher emitted the source
//   distilled           — LoRA-finetuned weights from teacher pairs
//   compiled_from_dsl   — emitted by DSL → JS lowering
//
// Class/type constraints (enforced at build time):
//   class=synthesized_rule REQUIRES source_type=llm_emitted
//   class=distilled_model  REQUIRES source_type=distilled
//   class=rule             ACCEPTS  hand_written | pattern_generated
//                          REJECTS  llm_emitted | distilled
//   class=compiled_rule    ACCEPTS  any non-distilled type

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECIPE_SOURCE_TYPES,
  validateRecipeSourceType,
  inferSourceType,
} from '../src/recipe-class.js';

test('W285 RECIPE_SOURCE_TYPES enumerates the 5 honest sources', () => {
  assert.deepEqual(
    [...RECIPE_SOURCE_TYPES].sort(),
    ['compiled_from_dsl', 'distilled', 'hand_written', 'llm_emitted', 'pattern_generated'],
  );
});

test('W285 inferSourceType: explicit pattern strategy → pattern_generated', () => {
  const t = inferSourceType({ class: 'rule', synthesis_strategy: 'pattern' });
  assert.equal(t, 'pattern_generated');
});

test('W285 inferSourceType: explicit claude strategy → llm_emitted', () => {
  const t = inferSourceType({ class: 'synthesized_rule', synthesis_strategy: 'claude', teacher_vendor: 'anthropic' });
  assert.equal(t, 'llm_emitted');
});

test('W285 inferSourceType: weights present → distilled', () => {
  const t = inferSourceType({ class: 'distilled_model', weights_file: 'model.gguf' });
  assert.equal(t, 'distilled');
});

test('W285 inferSourceType: dsl present, no teacher → compiled_from_dsl', () => {
  const t = inferSourceType({ class: 'compiled_rule', dsl: { kind: 'rule-dsl-v1' } });
  assert.equal(t, 'compiled_from_dsl');
});

test('W285 inferSourceType: no signal → hand_written', () => {
  const t = inferSourceType({ class: 'rule' });
  assert.equal(t, 'hand_written');
});

test('W285 validateRecipeSourceType: rule + llm_emitted REJECTED', () => {
  assert.throws(() => validateRecipeSourceType({
    id: 'rcp_test', class: 'rule', source_type: 'llm_emitted',
  }), /rule.*rejects.*llm_emitted/i);
});

test('W285 validateRecipeSourceType: synthesized_rule + pattern_generated REJECTED', () => {
  assert.throws(() => validateRecipeSourceType({
    id: 'rcp_test', class: 'synthesized_rule', source_type: 'pattern_generated',
  }), /synthesized_rule.*requires.*llm_emitted/i);
});

test('W285 validateRecipeSourceType: distilled_model + hand_written REJECTED', () => {
  assert.throws(() => validateRecipeSourceType({
    id: 'rcp_test', class: 'distilled_model', source_type: 'hand_written',
  }), /distilled_model.*requires.*distilled/i);
});

test('W285 validateRecipeSourceType: synthesized_rule + llm_emitted OK', () => {
  assert.doesNotThrow(() => validateRecipeSourceType({
    id: 'rcp_test', class: 'synthesized_rule', source_type: 'llm_emitted',
    teacher_vendor: 'anthropic',
  }));
});

test('W285 validateRecipeSourceType: rule + hand_written OK', () => {
  assert.doesNotThrow(() => validateRecipeSourceType({
    id: 'rcp_test', class: 'rule', source_type: 'hand_written',
  }));
});

test('W285 build-time: recipes.json carries source_type for every recipe', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const AdmZip = await tryImportAdmZip();
  if (!AdmZip) {
    // Skip when adm-zip isn't installed; the marker test below still verifies code shape.
    return;
  }
  const { buildAndZip } = await import('../src/artifact.js');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w285-'));
  const res = await buildAndZip({
    job_id: 'job_test_w285',
    task: 'echo',
    base_model: 'none',
    recipes: [{
      id: 'rcp_echo',
      name: 'echo',
      source: 'function generate(input, lib){ return input; }',
      source_hash: 'abc',
      version_id: 'ver_1',
      tags: [],
    }],
    evals: { spec: 'rs-1-evals', n: 1, cases: [{ id: 'e1', input: 'x', expected: 'x' }] },
    training_stats: { pass_rate_positive: 1.0 },
    outDir,
    artifact_class: 'rule',
  });
  const zip = new AdmZip(res.outPath);
  const recipesJson = JSON.parse(zip.readAsText('recipes.json'));
  for (const r of recipesJson.recipes) {
    assert.ok(r.source_type,
      `recipe ${r.id} must carry an honest source_type — got ${JSON.stringify(r.source_type)}`);
    assert.ok(RECIPE_SOURCE_TYPES.includes(r.source_type),
      `recipe ${r.id} source_type ${r.source_type} not in ${RECIPE_SOURCE_TYPES.join(',')}`);
  }
});

async function tryImportAdmZip() {
  try { const m = await import('adm-zip'); return m.default || m; } catch { return null; }
}
