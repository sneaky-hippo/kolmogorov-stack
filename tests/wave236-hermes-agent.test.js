// W236 — Hermes-agent recipe export + self-growing agent blueprint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function modUrl(rel) {
  return pathToFileURL(path.join(ROOT, rel)).href;
}

test('W236 agent-blueprint module exports the public surface', async () => {
  const m = await import(modUrl('src/agent-blueprint.js'));
  for (const n of ['BLUEPRINT_SCHEMA_VERSION', 'HERMES_TOOL_SCHEMA_VERSION',
                   'exportHermesAgent', 'buildSelfGrowingBlueprint',
                   'validateBlueprint', 'mergeBlueprints', 'blueprintToYaml']) {
    assert.ok(n in m, `missing export ${n}`);
  }
});

test('W236 exportHermesAgent maps recipes to tool definitions', async () => {
  const m = await import(modUrl('src/agent-blueprint.js'));
  const artifact = {
    task: 'redact PHI',
    artifact_class: 'rule',
    artifact_hash: 'sha256-abc',
    recipes: [
      { id: 'phi-redactor', description: 'Strip PHI from text.' },
      { id: 'ssn-detector', description: 'Detect SSN patterns.' },
    ],
  };
  const out = m.exportHermesAgent(artifact);
  assert.equal(out.tools.length, 2);
  assert.equal(out.tools[0].type, 'function');
  assert.equal(out.tools[0].function.name, 'phi_redactor');
  assert.ok(out.system_prompt.includes('function-calling'), 'must include Hermes preamble');
  assert.ok(out.system_prompt.includes('PHI'), 'must include persona from spec');
  assert.match(out.integrity_hash, /^[0-9a-f]{64}$/);
});

test('W236 exportHermesAgent throws on bad input', async () => {
  const m = await import(modUrl('src/agent-blueprint.js'));
  assert.throws(() => m.exportHermesAgent(null), /must be an object/);
});

test('W236 buildSelfGrowingBlueprint returns a signed blueprint with defaults', async () => {
  const m = await import(modUrl('src/agent-blueprint.js'));
  const bp = m.buildSelfGrowingBlueprint({});
  assert.equal(bp.schema_version, m.BLUEPRINT_SCHEMA_VERSION);
  assert.ok(bp.id.startsWith('agent_'));
  assert.ok(bp.capture && bp.capture.enabled === true);
  assert.ok(bp.growth && bp.growth.auto_distill_at === 1000);
  assert.equal(bp.growth.k_score_floor, 0.80);
  assert.ok(bp.mentor_model.includes('Hermes'), 'default mentor must be Hermes');
  assert.match(bp.integrity_hash, /^[0-9a-f]{64}$/);
});

test('W236 buildSelfGrowingBlueprint honors caller overrides', async () => {
  const m = await import(modUrl('src/agent-blueprint.js'));
  const bp = m.buildSelfGrowingBlueprint({
    id: 'agent_test',
    base_model: 'Qwen/Qwen3.6-27B-Instruct',
    mentor_model: 'deepseek-ai/DeepSeek-V4-Flash-158B',
    capture_namespace: 'my_app',
    auto_distill_at: 500,
    k_score_floor: 0.85,
    forbid_network: true,
  });
  assert.equal(bp.id, 'agent_test');
  assert.equal(bp.base_model, 'Qwen/Qwen3.6-27B-Instruct');
  assert.equal(bp.growth.auto_distill_at, 500);
  assert.equal(bp.growth.k_score_floor, 0.85);
  assert.equal(bp.capture.namespace, 'my_app');
  assert.equal(bp.constraints.forbid_network, true);
});

test('W236 validateBlueprint accepts a freshly built blueprint', async () => {
  const m = await import(modUrl('src/agent-blueprint.js'));
  const bp = m.buildSelfGrowingBlueprint({});
  const r = m.validateBlueprint(bp);
  assert.equal(r.ok, true, `unexpected problems: ${JSON.stringify(r.problems)}`);
});

test('W236 validateBlueprint catches tampering via hash mismatch', async () => {
  const m = await import(modUrl('src/agent-blueprint.js'));
  const bp = m.buildSelfGrowingBlueprint({});
  const tampered = { ...bp, base_model: 'malicious-model' };
  const r = m.validateBlueprint(tampered);
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('hash_mismatch'), `missing hash_mismatch: ${JSON.stringify(r.problems)}`);
});

test('W236 validateBlueprint catches missing fields', async () => {
  const m = await import(modUrl('src/agent-blueprint.js'));
  const r = m.validateBlueprint({ schema_version: m.BLUEPRINT_SCHEMA_VERSION });
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('missing_id'));
  assert.ok(r.problems.includes('missing_base_model'));
});

test('W236 mergeBlueprints unions tools by id and resigns', async () => {
  const m = await import(modUrl('src/agent-blueprint.js'));
  const base = m.buildSelfGrowingBlueprint({ id: 'agent_base', tools: [{ id: 'a' }, { id: 'b' }] });
  const override = m.buildSelfGrowingBlueprint({ id: 'agent_override', tools: [{ id: 'b' }, { id: 'c' }] });
  const merged = m.mergeBlueprints(base, override);
  const ids = merged.tools.map(t => t.id);
  assert.deepEqual(ids.sort(), ['a', 'b', 'c']);
  // Hash must differ from both inputs.
  assert.notEqual(merged.integrity_hash, base.integrity_hash);
  assert.notEqual(merged.integrity_hash, override.integrity_hash);
});

test('W236 blueprintToYaml emits deterministic YAML-lite', async () => {
  const m = await import(modUrl('src/agent-blueprint.js'));
  const bp = m.buildSelfGrowingBlueprint({ id: 'agent_yaml' });
  const yaml = m.blueprintToYaml(bp);
  assert.ok(yaml.includes('id: "agent_yaml"'));
  assert.ok(yaml.includes('schema_version: "1.0.0"'));
  assert.ok(yaml.includes('capture:'));
  assert.ok(yaml.includes('growth:'));
});

test('W236 CLI dispatches agent verb and lists subcommands in HELP', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
  assert.ok(src.includes("case 'agent':"), 'dispatch missing case agent');
  assert.ok(src.includes('async function cmdAgent'), 'cmdAgent not defined');
  assert.ok(src.includes("'export-hermes'"), 'cmdAgent must handle export-hermes');
  assert.ok(src.includes("'blueprint'"), 'cmdAgent must handle blueprint');
  assert.ok(src.includes("'validate'"), 'cmdAgent must handle validate');
  assert.ok(src.includes('agent:'), 'HELP must include agent block');
});

test('W236 COMPLETION_VERBS and COMPLETION_SUBS include agent', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
  const cidx = src.indexOf('COMPLETION_VERBS');
  const tail = src.slice(cidx, cidx + 2000);
  assert.ok(tail.includes("'agent'"), 'COMPLETION_VERBS missing agent');
  assert.ok(src.includes("agent:   ['export-hermes'"), 'COMPLETION_SUBS missing agent subverbs');
});
