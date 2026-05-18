// Wave 298 — `kolm doctor --loop` in-process value-loop smoke.
//
// W297 locked in the HTTP-harness happy path; W298 makes that loop runnable
// from the user's terminal so a brand-new install can prove the four ladder
// rungs (capture → bridges → distill → replay) work end-to-end before any
// real traffic is captured. Behavior assertions only — never copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KOLM_CLI = path.resolve(__dirname, '..', 'cli', 'kolm.js');

// Isolated HOME per spawn so parallel test files don't fight over ~/.kolm/*.
// We deliberately do NOT override KOLM_DATA_DIR: the bundled ./data store has
// safe concurrent-read defaults, and on Windows an empty KOLM_DATA_DIR
// triggers a libuv UV_HANDLE_CLOSING crash during in-process server shutdown.
function isolatedHome() {
  const dir = path.join(os.tmpdir(), 'kolm-w298-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function runDoctorLoop(extraArgs = []) {
  const home = isolatedHome();
  const res = spawnSync(process.execPath, [KOLM_CLI, 'doctor', '--loop', ...extraArgs], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('W298 #1 — kolm doctor --loop --json exits 0 with ok=true and 6 rungs', () => {
  const out = runDoctorLoop(['--json']);
  assert.equal(out.code, 0, `expected exit 0, got ${out.code} (stderr: ${out.stderr.slice(0, 400)})`);
  // Strip the experimental-SQLite warning that node emits to stdout in some envs.
  const jsonStart = out.stdout.indexOf('{');
  assert.ok(jsonStart >= 0, `no JSON in output: ${out.stdout.slice(0, 400)}`);
  const report = JSON.parse(out.stdout.slice(jsonStart));
  assert.equal(report.ok, true, 'report.ok must be true when every rung passes');
  assert.ok(Array.isArray(report.rungs), 'report.rungs must be an array');
  assert.equal(report.rungs.length, 6, `expected 6 rungs (boot + 5 ladder), got ${report.rungs.length}`);
  const rungNames = report.rungs.map(r => r.name);
  for (const required of ['boot router', 'capture/log', 'capture/health', 'bridges/observations', 'distill/from-captures', 'replay']) {
    assert.ok(rungNames.includes(required), `missing rung "${required}" (got ${JSON.stringify(rungNames)})`);
  }
});

test('W298 #2 — every rung in the loop returns status=ok in a clean env', () => {
  const out = runDoctorLoop(['--json']);
  const jsonStart = out.stdout.indexOf('{');
  const report = JSON.parse(out.stdout.slice(jsonStart));
  for (const r of report.rungs) {
    assert.equal(r.status, 'ok', `rung ${r.name} failed: ${r.detail}`);
  }
});

test('W298 #3 — capture/log rung reports durable receipt header path', () => {
  const out = runDoctorLoop(['--json']);
  const jsonStart = out.stdout.indexOf('{');
  const report = JSON.parse(out.stdout.slice(jsonStart));
  const captureLog = report.rungs.find(r => r.name === 'capture/log');
  assert.ok(captureLog, 'capture/log rung must exist');
  // detail should mention the row count, not just "ok".
  assert.match(captureLog.detail, /6 rows/, `capture/log detail should report row count (got: ${captureLog.detail})`);
});

test('W298 #4 — distill/from-captures rung uses mode=recipe', () => {
  const out = runDoctorLoop(['--json']);
  const jsonStart = out.stdout.indexOf('{');
  const report = JSON.parse(out.stdout.slice(jsonStart));
  const distill = report.rungs.find(r => r.name === 'distill/from-captures');
  assert.ok(distill);
  assert.match(distill.detail, /mode=recipe/, `distill rung must indicate recipe mode (got: ${distill.detail})`);
});

test('W298 #5 — replay rung asserts concept_id_or_version_id contract guard', () => {
  const out = runDoctorLoop(['--json']);
  const jsonStart = out.stdout.indexOf('{');
  const report = JSON.parse(out.stdout.slice(jsonStart));
  const replay = report.rungs.find(r => r.name === 'replay');
  assert.ok(replay);
  assert.match(replay.detail, /concept_id_or_version_id_required/);
});

test('W298 #6 — text mode prints [PASS] markers + summary line', () => {
  const out = runDoctorLoop([]);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /\[PASS\]\s+boot router/);
  assert.match(out.stdout, /\[PASS\]\s+capture\/log/);
  assert.match(out.stdout, /\[PASS\]\s+capture\/health/);
  assert.match(out.stdout, /\[PASS\]\s+bridges\/observations/);
  assert.match(out.stdout, /\[PASS\]\s+distill\/from-captures/);
  assert.match(out.stdout, /\[PASS\]\s+replay/);
  assert.match(out.stdout, /value loop green/);
});
