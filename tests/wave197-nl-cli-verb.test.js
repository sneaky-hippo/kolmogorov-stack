// Wave 197: `kolm nl` natural-language CLI verb lock-in.
//
// Shift 5 of the Wave 192 plan: a free-text recipe scaffolder. User types
// `kolm nl "parse EDI 837 claims"` and gets a structured scaffold ready
// to drop into spec.json + seeds.jsonl. Air-gap path is deterministic
// (keyword-based class inference + templated seed examples). Networked
// LLM path is NOT YET WIRED: every invocation today exercises the
// air-gap branch.
//
// Tests lock both the CLI substrate (dispatch table, help text, flag
// parsing) and the backend (`scaffoldRecipeFromNl` export from
// src/assistant.js). If the CLI silently drops the verb or the backend
// silently changes output shape, these tests fail loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'cli', 'kolm.js');
const ASSISTANT = path.join(REPO, 'src', 'assistant.js');

const ENV = {
  ...process.env,
  KOLM_AIRGAP: '1',
  NO_COLOR: '1',
};

const RECIPE_CLASSES = ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'];

function execNl(args, env = ENV) {
  return spawnSync(process.execPath, [CLI, 'nl', ...args], {
    timeout: 10_000,
    encoding: 'utf8',
    env,
  });
}

test('1. `kolm nl --help` exits 0, mentions the verb and at least 2 example invocations', () => {
  const r = execNl(['--help']);
  assert.equal(r.status, 0, `kolm nl --help exited ${r.status} (stderr: ${r.stderr?.slice(0, 200)})`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /kolm nl/, 'help text must reference the verb name');
  // Count example invocations (lines starting with `  kolm nl "` in EXAMPLES block).
  const exampleCount = (out.match(/kolm nl "/g) || []).length;
  assert.ok(exampleCount >= 2,
    `help must show at least 2 example invocations (found ${exampleCount}); got:\n${out.slice(0, 400)}`);
  // Healthcare-specific example required by the wave 197 plan.
  assert.match(out, /appeal|HEDIS|EDI|claim/i,
    'help text must include at least one healthcare-flavored example (per wave 197 plan)');
});

test('2. `kolm nl` with no args prints usage and exits non-zero', () => {
  const r = execNl([]);
  assert.notEqual(r.status, 0, 'bare `kolm nl` should exit non-zero (no prompt given)');
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /usage:|free text request/i,
    'bare `kolm nl` should print a usage line');
});

test('3. `KOLM_AIRGAP=1 kolm nl "..." --json` returns valid scaffold JSON on stdout', () => {
  const r = execNl(['parse EDI 837 claims', '--json']);
  assert.equal(r.status, 0, `nl --json exited ${r.status} (stderr: ${r.stderr?.slice(0, 200)})`);
  assert.ok(r.stdout.trim().length > 0, 'expected JSON on stdout');
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true, `scaffold.ok should be true; got ${parsed.ok}`);
});

test('4. Returned scaffold has suggested_slug + suggested_task_description', () => {
  const r = execNl(['parse EDI 837 claims', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed.suggested_slug, 'string', 'suggested_slug must be a string');
  assert.ok(parsed.suggested_slug.length > 0, 'suggested_slug must be non-empty');
  assert.equal(typeof parsed.suggested_task_description, 'string', 'suggested_task_description must be a string');
  assert.ok(parsed.suggested_task_description.length > 0, 'suggested_task_description must be non-empty');
});

test('5. Returned scaffold has recipe_class', () => {
  const r = execNl(['parse EDI 837 claims', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed.recipe_class, 'string', 'recipe_class must be a string');
});

test('6. Returned scaffold has suggested_k_score_gate', () => {
  const r = execNl(['parse EDI 837 claims', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed.suggested_k_score_gate, 'number', 'suggested_k_score_gate must be a number');
});

test('7. Returned scaffold has suggested_seed_examples (length 10) + next_steps array', () => {
  const r = execNl(['parse EDI 837 claims', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.suggested_seed_examples), 'suggested_seed_examples must be an array');
  assert.equal(parsed.suggested_seed_examples.length, 10, 'suggested_seed_examples must have length 10');
  assert.ok(Array.isArray(parsed.next_steps), 'next_steps must be an array');
  assert.ok(parsed.next_steps.length > 0, 'next_steps must be non-empty');
});

test('8. recipe_class is one of the 4 allowed RECIPE_CLASSES values', () => {
  const r = execNl(['parse EDI 837 claims', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.ok(RECIPE_CLASSES.includes(parsed.recipe_class),
    `recipe_class must be one of ${JSON.stringify(RECIPE_CLASSES)}; got ${JSON.stringify(parsed.recipe_class)}`);
});

test('9. suggested_k_score_gate is a number in [0.5, 0.99]', () => {
  const r = execNl(['parse EDI 837 claims', '--json']);
  const parsed = JSON.parse(r.stdout);
  const g = parsed.suggested_k_score_gate;
  assert.ok(g >= 0.5 && g <= 0.99,
    `suggested_k_score_gate must be in [0.5, 0.99]; got ${g}`);
});

test('10. suggested_seed_examples each have prompt + completion keys', () => {
  const r = execNl(['parse EDI 837 claims', '--json']);
  const parsed = JSON.parse(r.stdout);
  for (let i = 0; i < parsed.suggested_seed_examples.length; i++) {
    const ex = parsed.suggested_seed_examples[i];
    assert.ok(typeof ex.prompt === 'string' && ex.prompt.length > 0,
      `seed example ${i} must have non-empty prompt`);
    assert.ok(typeof ex.completion === 'string' && ex.completion.length > 0,
      `seed example ${i} must have non-empty completion`);
  }
});

test('11. Air-gap "EDI 837 claim parser" infers `rule` class', () => {
  const r = execNl(['build an EDI 837 claim parser', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.recipe_class, 'rule',
    `EDI parser should map to rule class; got ${parsed.recipe_class} (basis: ${parsed.class_inference_basis})`);
});

test('12. Air-gap "draft an appeal letter" infers `distilled_model` class', () => {
  const r = execNl(['draft an appeal letter for a denial', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.recipe_class, 'distilled_model',
    `appeal-letter draft should map to distilled_model; got ${parsed.recipe_class} (basis: ${parsed.class_inference_basis})`);
});

test('13. Air-gap "compute HEDIS measure" infers `synthesized_rule` class', () => {
  const r = execNl(['compute HEDIS HBD measure for a diabetic cohort', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.recipe_class, 'synthesized_rule',
    `HEDIS compute should map to synthesized_rule; got ${parsed.recipe_class} (basis: ${parsed.class_inference_basis})`);
});

test('14. `--class rule` overrides the auto-inferred class', () => {
  // "draft an appeal letter" alone infers distilled_model (test 12). Force it
  // to `rule` and confirm the override wins.
  const r = execNl(['draft an appeal letter for a denial', '--json', '--class', 'rule']);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.recipe_class, 'rule',
    `--class rule must override keyword inference; got ${parsed.recipe_class}`);
  assert.equal(parsed.class_inference_basis, 'class_hint',
    `class_inference_basis must indicate the hint won; got ${parsed.class_inference_basis}`);
});

test('15. `--out <path>` writes scaffold to file (not stdout)', () => {
  const tmp = path.join(os.tmpdir(), `wave197-nl-out-${Date.now()}.json`);
  try {
    const r = execNl(['parse EDI 837 claims', '--out', tmp, '--json']);
    assert.equal(r.status, 0, `nl --out exited ${r.status}`);
    assert.ok(fs.existsSync(tmp), `--out should have written ${tmp}`);
    const content = fs.readFileSync(tmp, 'utf8');
    const parsed = JSON.parse(content);
    assert.equal(parsed.ok, true, 'written scaffold must be valid');
    assert.equal(typeof parsed.suggested_slug, 'string', 'written scaffold must have suggested_slug');
    // Stdout should NOT contain the full scaffold (just an ack).
    assert.ok(!r.stdout.includes('"suggested_seed_examples"'),
      'stdout should not contain the full scaffold when --out is set');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('16. `--json` output parses as valid JSON', () => {
  const r = execNl(['redact PHI from clinical notes', '--json']);
  assert.equal(r.status, 0);
  // Should parse without throwing.
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed, 'object', 'parsed output must be an object');
  assert.ok(parsed !== null, 'parsed output must not be null');
});

test('17. Non-JSON (human-readable) output includes verbatim "recipe class:" + "k-score gate:" labels', () => {
  const r = execNl(['parse EDI 837 claims']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /recipe class:/,
    'human-readable output must include verbatim "recipe class:" label');
  assert.match(r.stdout, /k-score gate:/,
    'human-readable output must include verbatim "k-score gate:" label');
});

test('18. Two consecutive air-gap invocations with same input produce identical output', () => {
  const a = execNl(['parse EDI 837 claims', '--json']);
  const b = execNl(['parse EDI 837 claims', '--json']);
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.equal(a.stdout, b.stdout,
    `air-gap mode must be deterministic: same input must produce same output across two invocations`);
});

test('19. scaffoldRecipeFromNl is importable from src/assistant.js as a function', async () => {
  const mod = await import('file://' + ASSISTANT.replace(/\\/g, '/'));
  assert.equal(typeof mod.scaffoldRecipeFromNl, 'function',
    'src/assistant.js must export scaffoldRecipeFromNl as a function');
  const r = mod.scaffoldRecipeFromNl({ text: 'parse EDI 837 claims', airGap: true });
  assert.equal(r.ok, true, 'scaffoldRecipeFromNl({airGap:true, text:...}) must return ok:true');
  assert.equal(typeof r.suggested_slug, 'string');
  assert.equal(r.suggested_seed_examples.length, 10);
});

test('20. scaffoldRecipeFromNl({airGap:true}) completes in < 200 ms (no network)', async () => {
  const mod = await import('file://' + ASSISTANT.replace(/\\/g, '/'));
  const start = Date.now();
  const r = mod.scaffoldRecipeFromNl({ text: 'parse EDI 837 claims', airGap: true });
  const dt = Date.now() - start;
  assert.equal(r.ok, true);
  assert.ok(dt < 200,
    `air-gap path must complete in < 200ms (took ${dt}ms): any network call would blow this budget`);
});

test('21. `kolm nl` verb is registered in the cli/kolm.js dispatch table', () => {
  const cli = fs.readFileSync(CLI, 'utf8');
  assert.match(cli, /case\s+['"`]nl['"`]\s*:/,
    "cli/kolm.js dispatch table must contain `case 'nl':` (wave 197 verb registration check)");
  assert.match(cli, /async function cmdNl\s*\(/,
    'cli/kolm.js must define async function cmdNl(args)');
});

test('22. Honest scope: human-readable + JSON output both mention "scaffold" + "refine" language', () => {
  // The wave 197 plan requires "scaffolds are starting points; refine + verify
  // before compile" language so the user is not misled into shipping the stub.
  const r = execNl(['parse EDI 837 claims']);
  assert.match(r.stdout, /scaffold|starting point|refine/i,
    'human-readable output must include honest-scope language');
  const j = execNl(['parse EDI 837 claims', '--json']);
  const parsed = JSON.parse(j.stdout);
  const allText = JSON.stringify(parsed);
  assert.match(allText, /scaffold|starting point|refine/i,
    'JSON scaffold must carry honest-scope language in at least one field');
});

test('23. network_status is "air_gap" or "not_yet_wired" (no false networked claim)', () => {
  const r = execNl(['parse EDI 837 claims', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.ok(['air_gap', 'not_yet_wired'].includes(parsed.network_status),
    `network_status must be air_gap or not_yet_wired (wave 197 networked LLM is NOT YET WIRED); got ${parsed.network_status}`);
});
