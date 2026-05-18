// Wave 304 — `kolm status` oneliner verb.
//
// Locally-readable snapshot for "where am I right now" without making a
// network call. Mirrors what kolm whoami would show if you were offline
// (version + base + key fingerprint), and adds an active vs. done jobs
// count read straight from ~/.kolm/jobs.jsonl. Behavior-only assertions.
//
// Cross-test isolation: per-spawn HOME override (HOME-only — KOLM_DATA_DIR
// override crashes libuv UV_HANDLE_CLOSING on Windows under parallel load;
// HOME isolation is enough because cmdStatus is local-only).

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
  const dir = path.join(os.tmpdir(), 'kolm-w304-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function runStatus(extraArgs = [], envOverrides = {}) {
  const home = isolatedHome();
  const res = spawnSync(process.execPath, [KOLM_CLI, 'status', ...extraArgs], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_API_KEY: '', ...envOverrides },
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('W304 #1 — kolm status prints version + base + key + jobs lines', () => {
  const out = runStatus();
  assert.equal(out.code, 0, `stderr: ${out.stderr.slice(0, 400)}`);
  assert.match(out.stdout, /kolm v\d+\.\d+\.\d+/, 'must include semver line');
  assert.match(out.stdout, /\nbase:\s+/, 'must include base line');
  assert.match(out.stdout, /\nkey:\s+/, 'must include key line');
  assert.match(out.stdout, /\njobs:\s+\d+\s+active,\s+\d+\s+done/, 'must include jobs count line');
});

test('W304 #2 — no api_key prints "(not logged in" hint in key line', () => {
  // Empty HOME + KOLM_API_KEY='' -> loadConfig() finds no api_key.
  const out = runStatus();
  assert.equal(out.code, 0);
  assert.match(out.stdout, /not logged in/, 'must coach the user to log in when no key is set');
});

test('W304 #3 — --json mode emits structured payload with required fields', () => {
  const out = runStatus(['--json']);
  assert.equal(out.code, 0);
  const jsonStart = out.stdout.indexOf('{');
  assert.ok(jsonStart >= 0, `expected JSON payload, got: ${out.stdout.slice(0, 200)}`);
  const report = JSON.parse(out.stdout.slice(jsonStart));
  assert.equal(typeof report.version, 'string', 'version must be a string');
  assert.equal(typeof report.base, 'string', 'base must be a string');
  assert.equal(typeof report.logged_in, 'boolean', 'logged_in must be a boolean');
  assert.equal(report.logged_in, false, 'logged_in must reflect no api_key');
  assert.equal(report.key_fingerprint, null, 'key_fingerprint must be null when no key');
  assert.ok('jobs' in report, 'report.jobs must exist');
  assert.equal(typeof report.jobs.active, 'number', 'jobs.active must be a number');
  assert.equal(typeof report.jobs.done, 'number', 'jobs.done must be a number');
});

test('W304 #4 — --json key_fingerprint shows prefix+suffix (not full key) when logged in', () => {
  // Set a fake KOLM_API_KEY env var. We don't validate it (cmdStatus is
  // local-only) — just assert the fingerprint reveals first 10 + last 4
  // and elides the middle so a screenshot would not leak the live token.
  const fakeKey = 'ks_test_FAKEXX1234567890ABCDEFGH';
  const out = runStatus(['--json'], { KOLM_API_KEY: fakeKey });
  assert.equal(out.code, 0);
  const report = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')));
  assert.equal(report.logged_in, true);
  assert.ok(report.key_fingerprint, 'fingerprint must be present when key is set');
  assert.ok(report.key_fingerprint.startsWith(fakeKey.slice(0, 10)), 'fingerprint must start with first 10 chars');
  assert.ok(report.key_fingerprint.endsWith(fakeKey.slice(-4)), 'fingerprint must end with last 4 chars');
  assert.ok(report.key_fingerprint.includes('...'), 'fingerprint must include elision marker');
  assert.notEqual(report.key_fingerprint, fakeKey, 'fingerprint must NOT be the full key');
});

test('W304 #5 — kolm status --help prints HELP.status body', () => {
  const out = runStatus(['--help']);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /kolm status - one-line snapshot/);
  assert.match(out.stdout, /\[--json\]/);
});

test('W304 #6 — status verb registered in main + repl dispatchers', () => {
  // Source-level check: the verb must be dispatched from both the main
  // case-switch and the dispatchRepl case-switch so it works inside the
  // repl AND from a fresh shell.
  const cliSrc = fs.readFileSync(KOLM_CLI, 'utf8');
  const cmdStatusCalls = (cliSrc.match(/cmdStatus\(rest\)/g) || []).length;
  assert.ok(cmdStatusCalls >= 2, `expected cmdStatus dispatched from >=2 sites, got ${cmdStatusCalls}`);
});

test('W304 #7 — "status" is registered in COMPLETION_VERBS for shell completion', () => {
  const cliSrc = fs.readFileSync(KOLM_CLI, 'utf8');
  const m = cliSrc.match(/const COMPLETION_VERBS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, 'COMPLETION_VERBS must exist');
  assert.match(m[1], /'status'/, "COMPLETION_VERBS must include 'status'");
});
