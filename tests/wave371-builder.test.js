// Wave 371 - Builder layer behavior tests.
//
// Covers:
//   - src/synthetic-data.js
//   - src/simulation.js
//   - src/replay.js (the local subverbs; W216 cloud /v1/replay route is
//     covered by its own wave216 tests)
//   - src/bakeoff.js
//   - src/training-planner.js
//   - CLI dispatch for new verbs (synth / sim / bakeoff / train plan / replay subverbs).
//
// HOME is isolated per-spawn so concurrent W371 runs don't race ~/.kolm/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KOLM_CLI = path.resolve(__dirname, '..', 'cli', 'kolm.js');

function isolatedHome() {
  const dir = path.join(os.tmpdir(), 'kolm-w371-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function runCli(args, extraEnv = {}) {
  const home = isolatedHome();
  // Strip any KOLM_LLM_* the harness may have so template paths fire.
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
  delete env.KOLM_LLM_PROVIDER;
  delete env.KOLM_LLM_KEY;
  delete env.KOLM_LLM_BASE_URL;
  const res = spawnSync(process.execPath, [KOLM_CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env,
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '', home };
}

async function withIsolatedHome(fn) {
  const home = isolatedHome();
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return await fn(home); }
  finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

// ===================== synthetic-data.js =====================

test('W371 #1 - synth.generate({modes:[paraphrase]}) returns N rows all tagged synthetic', async () => {
  const { generate } = await import('../src/synthetic-data.js');
  const rows = [
    { input: 'Patient John Smith arrived', output: 'Patient [PHI_NAME_1] arrived' },
    { input: 'Call 555-1234', output: 'Call [PHI_PHONE_1]' },
  ];
  const r = await generate({ datasetId: rows, n: 10, modes: ['paraphrase'] });
  assert.ok(r.generated.length >= 10, 'should generate at least 10 rows; got ' + r.generated.length);
  for (const row of r.generated.slice(0, 10)) {
    assert.equal(row.source_type, 'synthetic');
    assert.ok(row.teacher_model, 'teacher_model required');
    assert.ok(row.generation_prompt_hash, 'generation_prompt_hash required');
    assert.equal(row.mode, 'paraphrase');
  }
});

test('W371 #2 - synth.generateEdgeCases returns boundary inputs with edge_family tag', async () => {
  const { generateEdgeCases } = await import('../src/synthetic-data.js');
  const r = await generateEdgeCases({ workflow: [{ input: 'hello world', output: 'greeting' }], n: 10 });
  assert.equal(r.generated.length, 10);
  const families = new Set(r.generated.map((row) => row.edge_family));
  assert.ok(families.size >= 5, 'expected at least 5 distinct edge families, got ' + families.size);
  for (const row of r.generated) {
    assert.equal(row.source_type, 'synthetic');
    assert.equal(row.mode, 'edge_case');
  }
  // Must include at least one empty and one unicode case.
  assert.ok(families.has('empty'));
  assert.ok(families.has('unicode'));
});

test('W371 #3 - synth.generate with multiple modes splits N across modes', async () => {
  const { generate } = await import('../src/synthetic-data.js');
  const rows = [{ input: 'classify: hello', output: 'greeting' }];
  const r = await generate({ datasetId: rows, n: 9, modes: ['paraphrase', 'edge_case', 'adversarial'] });
  const byMode = new Map();
  for (const row of r.generated) byMode.set(row.mode, (byMode.get(row.mode) || 0) + 1);
  assert.ok(byMode.get('paraphrase') >= 1);
  assert.ok(byMode.get('edge_case') >= 1);
  assert.ok(byMode.get('adversarial') >= 1);
});

test('W371 #4 - synth.generatePersonas returns N personas with distinct names', async () => {
  const { generatePersonas } = await import('../src/synthetic-data.js');
  const r = await generatePersonas({ workflow: 'support', n: 15 });
  assert.equal(r.personas.length, 15);
  const names = new Set(r.personas.map((p) => p.name));
  assert.ok(names.size >= 10, 'expected >=10 distinct persona names, got ' + names.size);
  for (const p of r.personas) {
    assert.equal(p.source_type, 'synthetic');
    assert.ok(p.tone);
  }
});

test('W371 #5 - synth.generate rejects empty datasetId', async () => {
  const { generate } = await import('../src/synthetic-data.js');
  await assert.rejects(() => generate({ n: 5, modes: ['paraphrase'] }), /datasetId/);
});

// ===================== simulation.js =====================

test('W371 #6 - sim.createSim writes ~/.kolm/simulations/<id>.json', async () => {
  await withIsolatedHome(async (home) => {
    const { createSim } = await import('../src/simulation.js');
    const r = await createSim('support', { type: 'user_simulator', n: 5 });
    assert.match(r.sim_id, /^sim_/);
    const p = path.join(home, '.kolm', 'simulations', r.sim_id + '.json');
    assert.ok(fs.existsSync(p), 'sim file should exist at ' + p);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(j.type, 'user_simulator');
    assert.equal(j.workflow_id, 'support');
    assert.equal(j.n, 5);
    assert.equal(j.status, 'created');
  });
});

test('W371 #7 - sim.runSim emits N events with sim_id tag', async () => {
  await withIsolatedHome(async () => {
    const { createSim, runSim, _readSimRaw } = await import('../src/simulation.js');
    const created = await createSim('support', { type: 'user_simulator', n: 6 });
    const r = await runSim(created.sim_id, { opts: { toLake: false } });
    assert.equal(r.events_emitted, 6);
    const raw = _readSimRaw(created.sim_id);
    assert.equal(raw.events.length, 6);
    for (const ev of raw.events) {
      assert.equal(ev.sim_id, created.sim_id);
      assert.ok(ev.ts);
      assert.equal(ev.sim_type, 'user_simulator');
    }
  });
});

test('W371 #8 - sim.runSim with privacy_red_team_simulator produces PII inputs', async () => {
  await withIsolatedHome(async () => {
    const { createSim, runSim, _readSimRaw } = await import('../src/simulation.js');
    const created = await createSim('phi-redactor', { type: 'privacy_red_team_simulator', n: 4 });
    await runSim(created.sim_id, { opts: { toLake: false } });
    const raw = _readSimRaw(created.sim_id);
    const allInput = raw.events.map((e) => e.input).join('\n');
    assert.match(allInput, /\d{3}-\d{2}-\d{4}|MRN\d{4,}|@example\.com|\d{3}-\d{3}-\d{4}/, 'expected at least one PII pattern in sim input');
  });
});

test('W371 #9 - sim.generateDatasetFromSim writes dataset with synthetic rows and empty holdout by default', async () => {
  await withIsolatedHome(async (home) => {
    const { createSim, runSim, generateDatasetFromSim } = await import('../src/simulation.js');
    const created = await createSim('support', { type: 'user_simulator', n: 5 });
    await runSim(created.sim_id, { opts: { toLake: false } });
    const ds = await generateDatasetFromSim(created.sim_id);
    assert.match(ds.dataset_id, /^ds_sim_/);
    assert.equal(ds.rows.length, 5);
    assert.equal(ds.holdout.length, 0, 'holdout must be empty by default');
    for (const row of ds.rows) assert.equal(row.source_type, 'synthetic');
    const onDisk = path.join(home, '.kolm', 'simulations', ds.dataset_id + '.json');
    assert.ok(fs.existsSync(onDisk));
  });
});

test('W371 #10 - sim.createSim rejects unsupported sim type', async () => {
  await withIsolatedHome(async () => {
    const { createSim } = await import('../src/simulation.js');
    await assert.rejects(() => createSim('x', { type: 'not_a_real_type', n: 1 }), /unsupported/);
  });
});

// ===================== replay.js =====================

test('W371 #11 - replay.replayTrace re-runs a captured prompt against a stub model', async () => {
  await withIsolatedHome(async () => {
    const { replayTrace } = await import('../src/replay.js');
    const inline = {
      trace_id: 'trace_abc',
      prompt: 'what time is it',
      response: 'it is 3pm',
      latency_us: 12345,
      cost_usd: 0.0001,
    };
    const r = await replayTrace('trace_abc', { against: 'gpt-4o-mini', opts: { stubModel: true, trace: inline } });
    assert.ok(r.replay.ok);
    assert.equal(r.replay.engine, 'stub_model');
    assert.ok(r.diff_score >= 0 && r.diff_score <= 1);
    assert.ok(typeof r.latency_delta_ms === 'number');
  });
});

test('W371 #12 - replay.replayTrace throws TRACE_NOT_FOUND on unknown trace', async () => {
  await withIsolatedHome(async () => {
    const { replayTrace } = await import('../src/replay.js');
    await assert.rejects(() => replayTrace('nope', { against: 'gpt-4o-mini', opts: { stubModel: true } }), (e) => e && e.code === 'TRACE_NOT_FOUND');
  });
});

test('W371 #13 - replay.replayDataset with inline rows returns pass_rate summary', async () => {
  await withIsolatedHome(async () => {
    const { replayDataset } = await import('../src/replay.js');
    const rows = [
      { input: 'hello', output: 'greeting' },
      { input: 'goodbye', output: 'farewell' },
      { input: 'thanks', output: 'gratitude' },
    ];
    const r = await replayDataset('inline', { against: 'gpt-4o-mini', opts: { stubModel: true, rows } });
    assert.equal(r.count, 3);
    assert.ok(r.summary.pass_rate >= 0 && r.summary.pass_rate <= 1);
    assert.ok('latency_avg_ms' in r.summary);
  });
});

// ===================== bakeoff.js =====================

test('W371 #14 - bakeoff returns ranked contestants with recommendation', async () => {
  const { bakeoff } = await import('../src/bakeoff.js');
  const rows = Array.from({ length: 20 }, (_, i) => ({
    input: 'classify positive ' + i,
    output: 'positive',
  })).concat(Array.from({ length: 10 }, (_, i) => ({
    input: 'classify negative ' + i,
    output: 'negative',
  })));
  const r = await bakeoff(rows, { contestants: ['cache', 'rule', 'gemma-3n-e2b', 'claude-haiku-4-5'], opts: { stubModel: true } });
  assert.equal(r.rows_used, 30);
  assert.equal(r.contestants.length, 4);
  for (const c of r.contestants) {
    assert.ok(typeof c.pass_rate === 'number');
    assert.ok(typeof c.avg_latency_ms === 'number');
    assert.ok('avg_cost_usd' in c);
    assert.ok('score_per_dollar' in c);
  }
  // Recommended must be one of the contestants.
  assert.ok(r.contestants.some((c) => c.name === r.recommended && c.recommended === true));
});

test('W371 #15 - bakeoffReport renders human table with Recommended line', async () => {
  const { bakeoff, bakeoffReport } = await import('../src/bakeoff.js');
  const rows = Array.from({ length: 12 }, (_, i) => ({ input: 'x' + i, output: 'a' }));
  const r = await bakeoff(rows, { contestants: ['cache', 'rule', 'claude-haiku-4-5'], opts: { stubModel: true } });
  const txt = bakeoffReport(r);
  assert.match(txt, /Bakeoff result/);
  assert.match(txt, /contestant/);
  assert.match(txt, /Recommended|No recommendation/);
});

// ===================== training-planner.js =====================

test('W371 #16 - training-planner.plan returns plan with recommended_path for classification', async () => {
  const { plan } = await import('../src/training-planner.js');
  const rows = Array.from({ length: 50 }, (_, i) => ({
    input: 'classify this thing ' + i,
    output: i % 2 === 0 ? 'positive' : 'negative',
  }));
  const p = await plan('inline', { rows });
  assert.equal(p.task, 'classification');
  assert.ok(['rule_first', 'classifier'].includes(p.recommended_path));
  assert.ok(p.holdout_size >= 1);
  assert.ok(p.estimated_latency_ms > 0 || p.recommended_path === 'rule_first');
  assert.ok(typeof p.expected_replacement_rate === 'number');
});

test('W371 #17 - training-planner.plan flags synthetic-in-holdout warning', async () => {
  await withIsolatedHome(async (home) => {
    const dsId = 'ds_sim_test_warning';
    const envelopePath = path.join(home, '.kolm', 'simulations', dsId + '.json');
    fs.mkdirSync(path.dirname(envelopePath), { recursive: true });
    const synthRows = [
      { input: 'a', output: 'pos', source_type: 'synthetic' },
      { input: 'b', output: 'neg', source_type: 'synthetic' },
      { input: 'c', output: 'pos', source_type: 'synthetic' },
    ];
    fs.writeFileSync(envelopePath, JSON.stringify({
      dataset_id: dsId, rows: synthRows, holdout: synthRows.slice(0, 1),
    }));
    const { plan } = await import('../src/training-planner.js');
    const p = await plan(dsId);
    assert.ok(p.warnings.some((w) => /synthetic_in_holdout/.test(w)), 'expected synthetic_in_holdout warning; got: ' + JSON.stringify(p.warnings));
  });
});

test('W371 #18 - training-planner.plan detects PHI/PII as sensitive', async () => {
  const { plan } = await import('../src/training-planner.js');
  const rows = [
    { input: 'Patient John Doe SSN 123-45-6789', output: '[PHI_NAME_1] SSN [PHI_SSN_1]' },
    { input: 'Email jane@example.com', output: '[PHI_EMAIL_1]' },
  ];
  const p = await plan('inline', { rows });
  assert.equal(p.sensitive_data_detected, true);
  assert.equal(p.task, 'redaction');
});

// ===================== CLI dispatch =====================

test('W371 #19 - kolm synth --help prints HELP block', () => {
  const out = runCli(['synth', '--help']);
  assert.equal(out.code, 0, `stderr: ${out.stderr.slice(0, 400)}`);
  assert.match(out.stdout, /kolm synth - synthetic training-data generator/);
});

test('W371 #20 - kolm sim --help prints HELP block', () => {
  const out = runCli(['sim', '--help']);
  assert.equal(out.code, 0, `stderr: ${out.stderr.slice(0, 400)}`);
  assert.match(out.stdout, /kolm sim - workload \+ adversary simulators/);
});

test('W371 #21 - kolm bakeoff --help prints HELP block', () => {
  const out = runCli(['bakeoff', '--help']);
  assert.equal(out.code, 0, `stderr: ${out.stderr.slice(0, 400)}`);
  assert.match(out.stdout, /kolm bakeoff - score-per-dollar bakeoff/);
});

test('W371 #22 - kolm sim create + run end-to-end via CLI', () => {
  const home = isolatedHome();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.KOLM_LLM_PROVIDER;
  delete env.KOLM_LLM_KEY;
  try {
    const create = spawnSync(process.execPath, [KOLM_CLI, 'sim', 'create', 'support', '--type', 'log_stream_simulator', '--n', '5', '--json'], { encoding: 'utf8', timeout: 60_000, env });
    assert.equal(create.status, 0, `create stderr: ${(create.stderr || '').slice(0, 400)}`);
    const created = JSON.parse(create.stdout);
    const run = spawnSync(process.execPath, [KOLM_CLI, 'sim', 'run', created.sim_id, '--json'], { encoding: 'utf8', timeout: 60_000, env });
    assert.equal(run.status, 0, `run stderr: ${(run.stderr || '').slice(0, 400)}`);
    const ran = JSON.parse(run.stdout);
    assert.equal(ran.sim_id, created.sim_id);
    assert.equal(ran.events_emitted, 5);
    const listSim = spawnSync(process.execPath, [KOLM_CLI, 'sim', 'list', '--json'], { encoding: 'utf8', timeout: 60_000, env });
    assert.equal(listSim.status, 0);
    const list = JSON.parse(listSim.stdout);
    assert.ok(list.some((s) => s.sim_id === created.sim_id));
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

test('W371 #23 - kolm train plan <dataset> emits plan envelope', () => {
  const home = isolatedHome();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  try {
    const dsPath = path.join(home, 'ds.jsonl');
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(JSON.stringify({ input: 'task ' + i, output: i % 2 === 0 ? 'a' : 'b' }));
    fs.writeFileSync(dsPath, lines.join('\n'));
    const out = spawnSync(process.execPath, [KOLM_CLI, 'train', 'plan', dsPath, '--json'], { encoding: 'utf8', timeout: 60_000, env });
    assert.equal(out.status, 0, `stderr: ${(out.stderr || '').slice(0, 400)}`);
    const p = JSON.parse(out.stdout);
    assert.ok(p.plan_id);
    assert.ok(['classification', 'generation', 'extraction', 'redaction', 'unknown'].includes(p.task));
    assert.ok(['rule_first', 'classifier', 'lora', 'distill'].includes(p.recommended_path));
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

test('W371 #24 - kolm bakeoff <ds> --stub-model prints ranked table', () => {
  const home = isolatedHome();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.KOLM_LLM_PROVIDER;
  delete env.KOLM_LLM_KEY;
  try {
    const dsPath = path.join(home, 'ds.jsonl');
    const lines = [];
    for (let i = 0; i < 12; i++) lines.push(JSON.stringify({ input: 'classify ' + i, output: 'positive' }));
    fs.writeFileSync(dsPath, lines.join('\n'));
    const out = spawnSync(process.execPath, [KOLM_CLI, 'bakeoff', dsPath, '--contestants', 'cache,rule,claude-haiku-4-5', '--stub-model'], { encoding: 'utf8', timeout: 60_000, env });
    assert.equal(out.status, 0, `stderr: ${(out.stderr || '').slice(0, 400)}`);
    assert.match(out.stdout, /Bakeoff result/);
    assert.match(out.stdout, /cache/);
    assert.match(out.stdout, /rule/);
    assert.match(out.stdout, /claude-haiku-4-5/);
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

test('W371 #25 - kolm replay dataset <path> --against <model> works without cloud auth', () => {
  const home = isolatedHome();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.KOLM_LLM_PROVIDER;
  delete env.KOLM_LLM_KEY;
  try {
    const dsPath = path.join(home, 'ds.jsonl');
    const lines = [];
    for (let i = 0; i < 5; i++) lines.push(JSON.stringify({ input: 'hello ' + i, output: 'world' }));
    fs.writeFileSync(dsPath, lines.join('\n'));
    const out = spawnSync(process.execPath, [KOLM_CLI, 'replay', 'dataset', dsPath, '--against', 'gpt-4o-mini', '--stub-model', '--json'], { encoding: 'utf8', timeout: 60_000, env });
    assert.equal(out.status, 0, `stderr: ${(out.stderr || '').slice(0, 400)}`);
    const r = JSON.parse(out.stdout);
    assert.equal(r.count, 5);
    assert.ok('pass_rate' in r.summary);
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

// COMPLETION_VERBS sanity check: the new verbs must be exposed for autocomplete.
test('W371 #26 - new verbs appear in COMPLETION_VERBS', () => {
  const src = fs.readFileSync(KOLM_CLI, 'utf8');
  for (const v of ['synth', 'sim', 'bakeoff']) {
    assert.match(src, new RegExp(`COMPLETION_VERBS[^\\]]+'${v}'`, 's'), `expected '${v}' in COMPLETION_VERBS`);
  }
});

test('W371 #27 - new verbs have HELP entries', () => {
  const src = fs.readFileSync(KOLM_CLI, 'utf8');
  assert.match(src, /\bsynth: `kolm synth/);
  assert.match(src, /\bsim: `kolm sim/);
  assert.match(src, /\bbakeoff: `kolm bakeoff/);
});
