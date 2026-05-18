// W250 — kolm remote: rent compute when local hardware is weak.
//
// Tests assert catalog shape + ranking math + plan output, not provider
// runtime (which would be brittle + cost real money).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import child_process from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');
const RC_URL = pathToFileURL(path.join(ROOT, 'src', 'remote-compute.js')).href;

function runCli(args, env = {}) {
  const res = child_process.spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', code: res.status };
}

test('W250 #1 — PROVIDERS catalog has both inference + training providers with required fields', async () => {
  const RC = await import(RC_URL);
  assert.ok(Array.isArray(RC.PROVIDERS), 'PROVIDERS is array');
  assert.ok(RC.PROVIDERS.length >= 6, 'at least 6 providers');
  for (const p of RC.PROVIDERS) {
    assert.ok(p.id, `id on ${p.id}`);
    assert.ok(p.name, `name on ${p.id}`);
    assert.ok(['inference', 'training', 'both'].includes(p.kind), `valid kind on ${p.id}`);
    assert.ok(p.homepage, `homepage on ${p.id}`);
    assert.ok(p.docs, `docs on ${p.id}`);
    assert.ok(p.auth_env, `auth_env on ${p.id}`);
    assert.ok(p.billing, `billing on ${p.id}`);
    assert.ok(p.verified_at, `verified_at on ${p.id}`);
  }
  const inf = RC.PROVIDERS.filter((p) => p.kind === 'inference' || p.kind === 'both');
  const trn = RC.PROVIDERS.filter((p) => p.kind === 'training' || p.kind === 'both');
  assert.ok(inf.length >= 3, '3+ inference providers');
  assert.ok(trn.length >= 3, '3+ training providers');
});

test('W250 #2 — known top providers present (fireworks/together/modal/runpod)', async () => {
  const RC = await import(RC_URL);
  const ids = RC.PROVIDERS.map((p) => p.id);
  for (const expected of ['fireworks', 'together', 'modal', 'runpod', 'predibase']) {
    assert.ok(ids.includes(expected), `${expected} present`);
  }
});

test('W250 #3 — listProviders({kind}) filters correctly', async () => {
  const RC = await import(RC_URL);
  const inf = RC.listProviders({ kind: 'inference' });
  assert.ok(inf.every((p) => p.kind === 'inference' || p.kind === 'both'));
  const trn = RC.listProviders({ kind: 'training' });
  assert.ok(trn.every((p) => p.kind === 'training' || p.kind === 'both'));
});

test('W250 #4 — rankByInferenceCost orders ascending by est_usd', async () => {
  const RC = await import(RC_URL);
  const ranked = RC.rankByInferenceCost({ in_M: 1, out_M: 1 });
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i].est_usd >= ranked[i - 1].est_usd, 'monotonic ascending');
  }
  assert.ok(ranked.length >= 3, '3+ ranked');
});

test('W250 #5 — rankByTrainingCost A100 returns at least one row', async () => {
  const RC = await import(RC_URL);
  const ranked = RC.rankByTrainingCost({ gpu: 'A100' });
  assert.ok(ranked.length >= 1, '>=1 A100 provider');
  assert.ok(ranked.every((r) => r.usd_hr > 0), 'positive rate');
});

test('W250 #6 — planInference returns POST + Authorization Bearer with env var name', async () => {
  const RC = await import(RC_URL);
  const plan = RC.planInference({
    providerId: 'fireworks',
    model: 'accounts/fireworks/models/qwen2p5-72b-instruct',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(plan.method, 'POST');
  assert.match(plan.url, /\/chat\/completions$/);
  assert.equal(plan.headers['Authorization'], 'Bearer $FIREWORKS_API_KEY');
  assert.equal(plan.body.model, 'accounts/fireworks/models/qwen2p5-72b-instruct');
});

test('W250 #7 — planInference rejects training-only provider', async () => {
  const RC = await import(RC_URL);
  assert.throws(() => RC.planInference({ providerId: 'modal', model: 'x', messages: [] }), /training-only/);
});

test('W250 #8 — planTraining returns est_usd when gpu rate is known', async () => {
  const RC = await import(RC_URL);
  const plan = RC.planTraining({ providerId: 'lambda', recipe: '/r', base_model: 'qwen3-7b', dataset: '/d', gpu: 'H100', hours: 2 });
  assert.equal(plan.provider, 'lambda');
  assert.equal(plan.mode, 'training');
  assert.ok(plan.est_usd > 0, 'est_usd computed');
});

test('W250 #9 — planTraining rejects inference-only provider', async () => {
  const RC = await import(RC_URL);
  assert.throws(() => RC.planTraining({ providerId: 'fireworks', recipe: '/r', base_model: 'x' }), /inference-only/);
});

test('W250 #10 — recommendInference returns the cheapest 1M+1M provider', async () => {
  const RC = await import(RC_URL);
  const r = RC.recommendInference();
  assert.ok(r && r.provider && r.provider.id, 'has provider');
  // cheapest as of W250 catalog: together at 0.88+0.88 or fireworks at 0.9+0.9.
  assert.ok(['together', 'fireworks'].includes(r.provider.id), 'cheapest is together or fireworks');
});

test('W250 #11 — CLI kolm remote --help advertises subcommands', () => {
  const r = runCli(['remote', '--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /kolm remote - rent compute/);
  assert.match(r.stdout, /remote rank/);
  assert.match(r.stdout, /remote plan/);
});

test('W250 #12 — CLI kolm remote list --json emits the catalog', () => {
  const r = runCli(['remote', 'list', '--json']);
  assert.equal(r.code, 0);
  const arr = JSON.parse(r.stdout);
  assert.ok(Array.isArray(arr));
  assert.ok(arr.length >= 6);
  for (const p of arr) {
    assert.ok(p.id);
    assert.ok(p.kind);
  }
});

test('W250 #13 — CLI kolm remote rank inference --json emits ascending', () => {
  const r = runCli(['remote', 'rank', 'inference', '--json']);
  assert.equal(r.code, 0);
  const arr = JSON.parse(r.stdout);
  for (let i = 1; i < arr.length; i++) {
    assert.ok(arr[i].est_usd >= arr[i - 1].est_usd);
  }
});

test('W250 #14 — CLI kolm remote info <id> --json returns provider record', () => {
  const r = runCli(['remote', 'info', 'fireworks', '--json']);
  assert.equal(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.equal(p.id, 'fireworks');
  assert.equal(p.auth_env, 'FIREWORKS_API_KEY');
});

test('W250 #15 — CLI dispatch + completion + HELP wiring for remote', () => {
  const txt = fs.readFileSync(CLI, 'utf8');
  assert.match(txt, /case 'remote':\s*await withErrorContext\('remote'/);
  assert.match(txt, /'services', 'bootstrap', 'proxy', 'remote'/);
  assert.match(txt, /remote: \['list', 'info', 'rank', 'recommend', 'plan', 'env'\]/);
  assert.match(txt, /remote: `kolm remote - rent compute/);
});
