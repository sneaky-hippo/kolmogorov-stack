// W286 — `workflow_capsule` was named as the "third artifact class" in
// src/workflow-ir.js header comments but never appeared in RECIPE_CLASSES,
// never had a CLASS_DESCRIPTIONS entry, and never had a verifier rule. That
// is a dead claim that ages into a lie. This wave promotes it to a real
// fifth class with verifier semantics: a workflow_capsule artifact MUST ship
// a workflow_ir block whose hash matches manifest.lineage.workflow_ir_hash.
//
// Invariants:
//   1. RECIPE_CLASSES contains 'workflow_capsule'.
//   2. CLASS_RANK['workflow_capsule'] is the highest rank (a graph of recipes
//      is at least as permissive as any single recipe in the graph).
//   3. CLASS_DESCRIPTIONS['workflow_capsule'] is a non-empty honest description.
//   4. inferRecipeClass returns 'workflow_capsule' when recipe.workflow_ir
//      is present.
//   5. validateRecipeClass on a workflow_capsule recipe REQUIRES a workflow_ir
//      block; throws otherwise.
//   6. validateArtifactClass on manifest with artifact_class='workflow_capsule'
//      REQUIRES manifest.lineage.workflow_ir_hash.
//   7. Workflow-capsule class accepts source_type='llm_emitted' or 'hand_written'
//      (the IR can be traced from production OR hand-authored) but rejects
//      'distilled'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECIPE_CLASSES,
  CLASS_RANK,
  CLASS_DESCRIPTIONS,
  CLASS_SOURCE_TYPE_RULES,
  inferRecipeClass,
  validateRecipeClass,
  validateArtifactClass,
  rollupArtifactClass,
} from '../src/recipe-class.js';

test('W286 RECIPE_CLASSES contains workflow_capsule as fifth honest class', () => {
  assert.ok(RECIPE_CLASSES.includes('workflow_capsule'),
    `RECIPE_CLASSES must include 'workflow_capsule'; got ${JSON.stringify(RECIPE_CLASSES)}`);
  assert.equal(RECIPE_CLASSES.length, 5, 'RECIPE_CLASSES is now 5 entries');
});

test('W286 CLASS_RANK[workflow_capsule] is the highest rank', () => {
  const ranks = Object.values(CLASS_RANK);
  const maxRank = Math.max(...ranks);
  assert.equal(CLASS_RANK.workflow_capsule, maxRank,
    `workflow_capsule must rank highest because it can wrap any other class; got rank ${CLASS_RANK.workflow_capsule} vs max ${maxRank}`);
});

test('W286 CLASS_DESCRIPTIONS has an honest workflow_capsule entry', () => {
  const d = CLASS_DESCRIPTIONS.workflow_capsule;
  assert.ok(d, 'CLASS_DESCRIPTIONS.workflow_capsule must exist');
  assert.ok(typeof d.short === 'string' && d.short.length > 0);
  assert.ok(typeof d.one_line === 'string' && d.one_line.length > 0);
  assert.ok(typeof d.honest === 'string' && d.honest.length > 50,
    'workflow_capsule.honest must be a real description, not a placeholder');
  assert.ok(/workflow|IR|graph|node/i.test(d.honest),
    'description must reference the workflow/IR concept');
});

test('W286 inferRecipeClass returns workflow_capsule when workflow_ir present', () => {
  const r = { id: 'wc1', workflow_ir: { spec: 'wir-v1', nodes: [], edges: [], seeds: [] } };
  assert.equal(inferRecipeClass(r), 'workflow_capsule');
});

test('W286 validateRecipeClass: workflow_capsule REQUIRES workflow_ir block', () => {
  assert.throws(
    () => validateRecipeClass({ id: 'wc1', class: 'workflow_capsule' }),
    /workflow_capsule.*workflow_ir/i,
    'declaring class=workflow_capsule with no workflow_ir must throw',
  );
  assert.doesNotThrow(
    () => validateRecipeClass({
      id: 'wc1',
      class: 'workflow_capsule',
      workflow_ir: { spec: 'wir-v1', nodes: [{ id: 'i', kind: 'input' }, { id: 'o', kind: 'output' }], edges: [], seeds: [] },
    }),
  );
});

test('W286 validateArtifactClass: workflow_capsule REQUIRES lineage.workflow_ir_hash', () => {
  const bad = { artifact_class: 'workflow_capsule', lineage: {} };
  const res = validateArtifactClass(bad);
  assert.equal(res.ok, false);
  assert.match(res.reason, /workflow_capsule.*workflow_ir_hash/i);
  const good = { artifact_class: 'workflow_capsule', lineage: { workflow_ir_hash: 'deadbeef'.repeat(8) } };
  const okRes = validateArtifactClass(good);
  assert.equal(okRes.ok, true);
});

test('W286 rollupArtifactClass promotes to workflow_capsule when any recipe is workflow_capsule', () => {
  const rolled = rollupArtifactClass(['rule', 'distilled_model', 'workflow_capsule']);
  assert.equal(rolled, 'workflow_capsule');
});

test('W286 CLASS_SOURCE_TYPE_RULES.workflow_capsule rejects distilled and accepts traced/hand_written', () => {
  const rule = CLASS_SOURCE_TYPE_RULES.workflow_capsule;
  assert.ok(rule, 'workflow_capsule must have a source-type rule entry');
  assert.ok(rule.rejects.includes('distilled'),
    'workflow_capsule must reject source_type=distilled (a workflow is not a model)');
  assert.ok(rule.accepts.includes('hand_written') || rule.accepts.includes('llm_emitted'),
    'workflow_capsule must accept at least one honest authoring path');
});
