// Wave 361 — kolm train --watch: streaming training progress.
//
// Behavior tests:
//   1. CLI: `kolm train <spec> --watch --json --worker <mock>` emits at least
//      one progress event and a final ok event with exit 0.
//   2. Auto-stop fires when holdout K drops for 2 consecutive epochs.
//   3. train() async iterator yields step/name/status invariants.
//   4. Cloud-poll mode: --job-id walks the existing /v1/jobs/:id endpoint
//      and emits progress events as the job advances.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', 'cli', 'kolm.js');
const ROOT = path.resolve(__dirname, '..');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w361-'));
}

// Mock worker script. Mirrors the progress-line contract pipeline-train
// parses: `[progress] epoch=N k=0.XX` on stderr (or stdout — parser
// accepts both). Sequence is deterministic so the test asserts exact
// best-epoch/best-k after the run.
//
// Sequence A (happy path, rising K through 3 epochs):
//   epoch=1 k=0.50
//   epoch=2 k=0.70
//   epoch=3 k=0.85
//
// Sequence B (overfit — auto-stop after 3 epochs):
//   epoch=1 k=0.85
//   epoch=2 k=0.80
//   epoch=3 k=0.70
//   epoch=4 k=0.60   (parent should SIGINT before this lands)
function writeMockWorker(dir, sequence) {
  const file = path.join(dir, 'mock-worker.mjs');
  const lines = sequence.map(([epoch, k]) => `[progress] epoch=${epoch} k=${k.toFixed(2)}`);
  const src = `#!/usr/bin/env node
import process from 'node:process';
const lines = ${JSON.stringify(lines)};
let i = 0;
function step() {
  if (i >= lines.length) { process.exit(0); return; }
  process.stderr.write(lines[i] + '\\n');
  i++;
  setTimeout(step, 80);
}
process.on('SIGINT', () => { process.exit(0); });
step();
`;
  fs.writeFileSync(file, src);
  return file;
}

function writeMinimalSpec(dir) {
  const spec = {
    job_id: 'job_mock_v1',
    task: 'mock spec for train --watch tests',
    base_model: 'none',
    recipes: [{ id: 'rcp_mock', name: 'mock', source: 'function generate(){ return { ok: true }; }' }],
    evals: { spec: 'rs-1-evals', cases: [{ id: 'ok', input: {}, expected: { ok: true } }], coverage: 1.0 },
  };
  const file = path.join(dir, 'mock.spec.json');
  fs.writeFileSync(file, JSON.stringify(spec, null, 2));
  return file;
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const home = tmpDir();
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_HOME: path.join(home, '.kolm'), KOLM_NO_REST_HINT: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 30_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
      resolve({ code, stdout, stderr });
    });
  });
}

test('W361 #1 — kolm train --watch --json emits >=1 progress event + final ok', async () => {
  const dir = tmpDir();
  try {
    const spec = writeMinimalSpec(dir);
    const worker = writeMockWorker(dir, [[1, 0.50], [2, 0.70], [3, 0.85]]);
    const r = await runCli(['train', spec, '--watch', '--json', '--worker', worker]);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    const events = r.stdout.trim().split(/\n/).filter(Boolean).map(JSON.parse);
    const progressEvents = events.filter((e) => e.step === 2 && e.status === 'ok');
    assert.ok(progressEvents.length >= 1, `expected at least one progress event, got ${progressEvents.length}: ${JSON.stringify(events)}`);
    const final = events[events.length - 1];
    assert.equal(final.step, 3, 'last event must be the finalize step');
    assert.equal(final.status, 'ok', `finalize must be ok, got ${final.status}: ${JSON.stringify(final)}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W361 #2 — auto-stop fires when holdout K drops 2 consecutive epochs', async () => {
  const dir = tmpDir();
  try {
    const spec = writeMinimalSpec(dir);
    // Sequence drops every epoch — auto-stop should fire after epoch 3.
    const worker = writeMockWorker(dir, [[1, 0.85], [2, 0.80], [3, 0.70], [4, 0.60], [5, 0.50]]);
    const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'pipeline-train.js')).href);
    const events = [];
    for await (const e of mod.train(spec, { workerPath: worker })) {
      events.push(e);
    }
    const autoStop = events.find((e) => e.step === 2 && e.status === 'ok' && e.detail && e.detail.auto_stop === true);
    assert.ok(autoStop, `expected auto_stop event, got events: ${JSON.stringify(events, null, 2)}`);
    assert.equal(autoStop.detail.reason, 'overfit');
    assert.equal(autoStop.detail.best_epoch, 1, 'best epoch should be 1 (K=0.85)');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W361 #3 — train() iterator yields events with step/name/status', async () => {
  const dir = tmpDir();
  try {
    const spec = writeMinimalSpec(dir);
    const worker = writeMockWorker(dir, [[1, 0.5], [2, 0.6]]);
    const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'pipeline-train.js')).href);
    assert.equal(typeof mod.train, 'function');
    const events = [];
    for await (const e of mod.train(spec, { workerPath: worker })) {
      events.push(e);
      assert.ok(typeof e.step === 'number');
      assert.ok(typeof e.name === 'string');
      assert.ok(['started', 'ok', 'err'].includes(e.status));
    }
    const finalize = events.find((e) => e.step === 3);
    assert.ok(finalize, 'finalize step (3) missing');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W361 #4 — cloud-poll mode walks /v1/jobs/:id and emits progress events', async () => {
  // Stand up a tiny express server that simulates a job advancing.
  const app = express();
  let polls = 0;
  app.get('/v1/jobs/job_w361_cloud', (_req, res) => {
    polls++;
    if (polls === 1) res.json({ id: 'job_w361_cloud', status: 'running', epoch: 1, k: 0.5 });
    else if (polls === 2) res.json({ id: 'job_w361_cloud', status: 'running', epoch: 2, k: 0.6 });
    else if (polls === 3) res.json({ id: 'job_w361_cloud', status: 'running', epoch: 3, k: 0.7 });
    else res.json({ id: 'job_w361_cloud', status: 'completed', epoch: 3, k: 0.7, artifact_path: '/tmp/x.kolm' });
  });
  const server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'pipeline-train.js')).href);
    const events = [];
    for await (const e of mod.train(null, { jobId: 'job_w361_cloud', base, pollIntervalMs: 50, maxPolls: 50 })) {
      events.push(e);
    }
    const progress = events.filter((e) => e.step === 2 && e.status === 'ok');
    assert.ok(progress.length >= 3, `expected at least 3 progress events from cloud poll, got ${progress.length}: ${JSON.stringify(events, null, 2)}`);
    const finalize = events.find((e) => e.step === 3 && e.status === 'ok');
    assert.ok(finalize, 'finalize ok event missing on completed job');
    assert.equal(finalize.detail.status, 'completed');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
