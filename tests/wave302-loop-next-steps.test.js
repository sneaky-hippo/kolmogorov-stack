// Wave 302 — `kolm loop` NEXT STEPS hint after green.
//
// W300 shipped the alias; W301 shipped the public docs; W302 closes the
// "what do I do now?" gap that hit on every fresh install. Behavior-only:
// asserts the 5-line next-steps block surfaces on green text-mode runs,
// stays absent in --json (machine consumers don't want it), and the listed
// verbs are real CLI commands (no aspirational copy).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KOLM_CLI = path.resolve(__dirname, '..', 'cli', 'kolm.js');

function isolatedHome() {
  const dir = path.join(os.tmpdir(), 'kolm-w302-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function runLoop(extraArgs = []) {
  const home = isolatedHome();
  const res = spawnSync(process.execPath, [KOLM_CLI, 'loop', ...extraArgs], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('W302 #1 — text-mode green run prints "next steps:" block', () => {
  const out = runLoop([]);
  assert.equal(out.code, 0, `expected exit 0, got ${out.code} (stderr: ${out.stderr.slice(0, 400)})`);
  assert.match(out.stdout, /value loop green/);
  assert.match(out.stdout, /\nnext steps:\n/);
});

test('W302 #2 — next-steps block names the 5 follow-on actions', () => {
  const out = runLoop([]);
  for (const verb of ['kolm proxy', 'kolm tail captures', 'kolm distill --from-captures', 'kolm replay', 'kolm.ai/value-loop']) {
    assert.ok(out.stdout.includes(verb), `next steps must mention "${verb}" (got: ${out.stdout.slice(-600)})`);
  }
});

test('W302 #3 — --json mode does NOT include human next-steps prose', () => {
  const out = runLoop(['--json']);
  assert.equal(out.code, 0);
  // The JSON payload is machine-readable; the next-steps block is a humans-only
  // teaching surface. Asserting absence prevents future drift where someone
  // tacks the prose into the JSON branch by accident.
  assert.doesNotMatch(out.stdout, /\nnext steps:\n/);
});

test('W302 #4 — next-steps verbs are real cli verbs (proxy/tail/distill/replay)', () => {
  // Each verb listed in next-steps must be in the completion list — i.e. wired
  // through the main dispatcher. If a future refactor renames or removes one
  // of these, this test catches the dead-link in next-steps copy.
  const cliSrc = fs.readFileSync(KOLM_CLI, 'utf8');
  const m = cliSrc.match(/const COMPLETION_VERBS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, 'COMPLETION_VERBS must exist in cli/kolm.js');
  const verbList = m[1];
  for (const verb of ['proxy', 'tail', 'distill', 'replay']) {
    assert.ok(verbList.includes(`'${verb}'`), `COMPLETION_VERBS must include '${verb}' (next-steps copy depends on it)`);
  }
});

test('W302 #5 — next-steps block does NOT appear when a rung fails', () => {
  // We don't have a reliable way to force a rung failure in-process without
  // mutating router.js. Instead, drive the same code path via --remote with
  // an empty HOME so loadConfig() returns no api_key -> "remote auth" rung
  // fails -> next-steps must NOT print (it's only for green runs).
  const tmpHome = isolatedHome();
  const res = spawnSync(process.execPath, [KOLM_CLI, 'loop', '--remote'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, KOLM_API_KEY: '' },
  });
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  assert.notEqual(res.status, 0, 'remote loop with no api_key must exit non-zero');
  assert.doesNotMatch(res.stdout || '', /\nnext steps:\n/, 'next-steps must NOT print on failure');
});
