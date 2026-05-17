// Wave-144 API smoke test.
//
// Exercises the HTTP endpoints added in router.js for the new wave-144
// modules: trace / ir / device / cc / fl / lineage. Each verb is a thin
// shell over the corresponding module export. This test confirms the
// wiring is intact and the auth/rate-limit middleware doesn't block
// legitimate calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const dataDir = path.join(os.tmpdir(), `kolm-wave144-api-${process.pid}-${Date.now()}`);
const kolmHome = path.join(os.tmpdir(), `kolm-wave144-home-${process.pid}-${Date.now()}`);

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, retries = 60) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not come up');
}

async function jsonFetch(base, p, opts = {}) {
  const r = await fetch(base + p, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  return { status: r.status, body };
}

test('wave-144 api: trace / ir / device / cc / fl / lineage endpoints', async (t) => {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.rmSync(kolmHome, { recursive: true, force: true });
  fs.mkdirSync(kolmHome, { recursive: true });
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(kolmHome, { recursive: true, force: true });
  });

  const proc = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DEFAULT_TENANT: 'wave144',
      ANTHROPIC_API_KEY: '',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: kolmHome,
      KOLM_STORE_DRIVER: 'json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  t.after(() => { try { proc.kill(); } catch {} });

  await waitForHealth(BASE);

  // Mint a tenant for endpoints that need auth.
  const signup = await jsonFetch(BASE, '/v1/signup', {
    method: 'POST',
    body: JSON.stringify({ email: `wave144-${process.pid}-${Date.now()}@example.com`, name: 'wave144' }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(signup.status, 201, JSON.stringify(signup.body));
  const key = signup.body.api_key;
  const authH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };

  // ----- device (public catalog) -----
  const profiles = await jsonFetch(BASE, '/v1/device/profiles');
  assert.equal(profiles.status, 200);
  assert.ok(Array.isArray(profiles.body.profiles));
  assert.ok(profiles.body.profiles.length > 10);

  const oneProfile = await jsonFetch(BASE, '/v1/device/profiles/rtx-4090');
  assert.equal(oneProfile.status, 200);
  assert.equal(oneProfile.body.device_id, 'rtx-4090');

  const probe = await jsonFetch(BASE, '/v1/device/probe', { method: 'POST', headers: authH, body: '{}' });
  assert.equal(probe.status, 200);
  assert.ok(probe.body && typeof probe.body === 'object');

  const checkBad = await jsonFetch(BASE, '/v1/device/check', {
    method: 'POST', headers: authH,
    body: JSON.stringify({ target: { min_vram_gb: 500 }, device_id: 'rtx-4090' }),
  });
  assert.equal(checkBad.status, 200);
  assert.equal(checkBad.body.ok, false);

  // ----- cc -----
  const kinds = await jsonFetch(BASE, '/v1/cc/kinds');
  assert.equal(kinds.status, 200);
  assert.ok(Array.isArray(kinds.body.kinds));
  assert.ok(kinds.body.kinds.includes('pccs'));

  const shape = await jsonFetch(BASE, '/v1/cc/shape/snp-report');
  assert.equal(shape.status, 200);
  assert.equal(shape.body.kind, 'snp-report');
  assert.ok(shape.body.shape && typeof shape.body.shape === 'object');

  const shapeBad = await jsonFetch(BASE, '/v1/cc/shape/not-a-real-kind');
  assert.equal(shapeBad.status, 404);

  // ----- fl -----
  const strategies = await jsonFetch(BASE, '/v1/fl/strategies');
  assert.equal(strategies.status, 200);
  assert.deepEqual([...strategies.body.strategies].sort(), ['fedavg', 'fedprox', 'fedsgd']);

  const fl = await import(pathToFileURL(path.resolve('src/federated-learning.js')).href);
  const round = fl.newRound({
    round_id: 'r1',
    model_hash: 'a'.repeat(64),
    base_artifact_version: 'v1',
    target_strategy: 'fedavg',
    min_participants: 2,
  });
  const aliceKeys = fl.generateKeypair();
  const bobKeys = fl.generateKeypair();
  const aliceContrib = fl.buildContribution({
    round, participant_id: 'alice', delta: { weights: [0.1, 0.2, 0.3] },
    sample_count: 100, private_key: aliceKeys.private_key,
  });
  const bobContrib = fl.buildContribution({
    round, participant_id: 'bob', delta: { weights: [0.4, 0.5, 0.6] },
    sample_count: 200, private_key: bobKeys.private_key,
  });

  const newRound = await jsonFetch(BASE, '/v1/fl/round/new', {
    method: 'POST', headers: authH,
    body: JSON.stringify({
      round_id: 'r-api', model_hash: 'b'.repeat(64), base_artifact_version: 'v1',
      target_strategy: 'fedavg', min_participants: 2,
    }),
  });
  assert.equal(newRound.status, 201);
  assert.ok(newRound.body.round && newRound.body.hash);

  const verifyContrib = await jsonFetch(BASE, '/v1/fl/contribution/verify', {
    method: 'POST', headers: authH,
    body: JSON.stringify({ contribution: aliceContrib, round, public_key: aliceKeys.public_key }),
  });
  assert.equal(verifyContrib.status, 200, JSON.stringify(verifyContrib.body));
  assert.equal(verifyContrib.body.ok, true, JSON.stringify(verifyContrib.body));

  const agg = await jsonFetch(BASE, '/v1/fl/aggregate', {
    method: 'POST', headers: authH,
    body: JSON.stringify({ round, contributions: [aliceContrib, bobContrib] }),
  });
  assert.equal(agg.status, 200);
  assert.ok(agg.body.aggregated_delta && typeof agg.body.aggregated_delta === 'object');
  assert.ok(Array.isArray(agg.body.aggregated_delta.weights));
  assert.equal(agg.body.aggregated_delta.weights.length, 3);

  // ----- lineage + capability -----
  const cap = await jsonFetch(BASE, '/v1/capability/build', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      min_vram_gb: 24, runtimes: ['cuda', 'rocm'], modalities: ['text'],
    }),
  });
  assert.equal(cap.status, 200);
  assert.equal(cap.body.spec, 'capability-v1');
  assert.ok(/^[0-9a-f]{16}$/.test(cap.body.hash), JSON.stringify(cap.body));

  const capVal = await jsonFetch(BASE, '/v1/capability/validate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cap.body),
  });
  assert.equal(capVal.status, 200);
  assert.equal(capVal.body.ok, true);

  const lin = await jsonFetch(BASE, '/v1/lineage/build', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'workflow_compile',
      workflow_ir_hash: 'c'.repeat(16),
      source_trace_ids: ['d'.repeat(32)],
    }),
  });
  assert.equal(lin.status, 200, JSON.stringify(lin.body));
  assert.equal(lin.body.spec, 'lineage-v1');
  assert.equal(lin.body.source, 'workflow_compile');

  const linBad = await jsonFetch(BASE, '/v1/lineage/build', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'distillation' }),
  });
  assert.equal(linBad.status, 400);

  // ----- trace + ir round-trip -----
  const tc = await import(pathToFileURL(path.resolve('src/trace-capture.js')).href);
  const TID = tc.newTraceId();
  const rootSp = tc.newSpanId();
  const llmSp = tc.newSpanId();
  // Write trace directly into the server's KOLM_HOME (same env var).
  process.env.KOLM_HOME = kolmHome;
  await tc.appendSpan(tc.userInputSpan({
    trace_id: TID, span_id: rootSp, parent_span_id: null,
    role: 'user', text: 'ping', channel: 'api',
  }));
  await tc.appendSpan(tc.llmCallSpan({
    trace_id: TID, span_id: llmSp, parent_span_id: rootSp,
    vendor: 'anthropic', model: 'claude-haiku-4-5',
    prompt: 'ping', response: 'pong',
    tokens_in: 1, tokens_out: 1, latency_ms: 50, cost_usd: 0,
  }));

  const stats = await jsonFetch(BASE, `/v1/trace/${TID}/stats`, { headers: authH });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.total_spans, 2);
  assert.equal(stats.body.llm_calls, 1);

  const chain = await jsonFetch(BASE, `/v1/trace/${TID}/chain`, { headers: authH });
  assert.equal(chain.status, 200);
  assert.equal(chain.body.ok, true);
  assert.equal(chain.body.length, 2);

  const exp = await jsonFetch(BASE, `/v1/trace/${TID}/export`, { headers: authH });
  assert.equal(exp.status, 200);
  assert.equal(exp.body.spans.length, 2);

  const compile = await jsonFetch(BASE, '/v1/ir/compile', {
    method: 'POST', headers: authH,
    body: JSON.stringify({ trace_ids: [TID] }),
  });
  assert.equal(compile.status, 200);
  assert.equal(compile.body.ir.spec, 'wir-v1');
  assert.ok(compile.body.ir.nodes.length >= 2);

  const irStats = await jsonFetch(BASE, '/v1/ir/stats', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(compile.body),
  });
  assert.equal(irStats.status, 200);
  assert.ok(irStats.body.hash);

  const irVal = await jsonFetch(BASE, '/v1/ir/validate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ir: compile.body.ir }),
  });
  assert.equal(irVal.status, 200);
  assert.equal(irVal.body.ok, true);

  const irReplay = await jsonFetch(BASE, '/v1/ir/replay', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ir: compile.body.ir }),
  });
  assert.equal(irReplay.status, 200);
  assert.equal(irReplay.body.ok, true);

  // Bad trace_id rejected
  const bad = await jsonFetch(BASE, '/v1/trace/not-a-real-tid/stats', { headers: authH });
  assert.equal(bad.status, 400);

  // Unauth blocked
  const noauth = await jsonFetch(BASE, `/v1/trace/${TID}/stats`);
  assert.ok(noauth.status === 401 || noauth.status === 403);
});
