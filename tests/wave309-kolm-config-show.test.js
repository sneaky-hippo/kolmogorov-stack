// Wave 309 — `kolm config show` explicit subcommand + key elision.
//
// cmdConfig already prints config when called with no args, but that's
// a side-effect, not a contract. W309 makes `kolm config show` an explicit
// subcommand, adds --json that returns a clean machine-parseable shape, and
// guarantees the api_key fingerprint is never the full key.

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
  const dir = path.join(os.tmpdir(), 'kolm-w309-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function runConfig(extraArgs = [], extraEnv = {}) {
  const home = isolatedHome();
  const res = spawnSync(process.execPath, [KOLM_CLI, 'config', ...extraArgs], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_API_KEY: '', ...extraEnv },
  });
  fs.rmSync(home, { recursive: true, force: true });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('W309 #1 — kolm config show prints config (no api key set)', () => {
  const out = runConfig(['show']);
  assert.equal(out.code, 0, `stderr: ${out.stderr.slice(0, 400)}`);
  assert.match(out.stdout, /base/);
});

test('W309 #2 — kolm config show --json emits parseable payload', () => {
  const out = runConfig(['show', '--json']);
  assert.equal(out.code, 0);
  const jsonStart = out.stdout.indexOf('{');
  assert.ok(jsonStart >= 0);
  const r = JSON.parse(out.stdout.slice(jsonStart));
  assert.equal(typeof r.base, 'string');
  assert.ok('logged_in' in r);
  assert.ok('key_fingerprint' in r);
});

test('W309 #3 — api_key NEVER printed in full, only fingerprint', () => {
  const fakeKey = 'ks_test_DONOTLEAK1234567890ABCDEF';
  const out = runConfig(['show', '--json'], { KOLM_API_KEY: fakeKey });
  assert.equal(out.code, 0);
  // The raw full key must not appear.
  assert.ok(!out.stdout.includes(fakeKey), 'full api_key must not appear in stdout');
  // Fingerprint must appear and respect prefix+suffix rule.
  const jsonStart = out.stdout.indexOf('{');
  const r = JSON.parse(out.stdout.slice(jsonStart));
  assert.ok(r.key_fingerprint, 'fingerprint must be present');
  assert.ok(r.key_fingerprint.startsWith(fakeKey.slice(0, 10)));
  assert.ok(r.key_fingerprint.endsWith(fakeKey.slice(-4)));
  assert.notEqual(r.key_fingerprint, fakeKey);
});

test('W309 #4 — kolm config (no subcommand) still works for back-compat', () => {
  // Pre-W309 behavior was: `kolm config` with no args printed config. Must
  // remain a non-erroring path so existing scripts do not break.
  const out = runConfig([]);
  assert.equal(out.code, 0);
  assert.ok(out.stdout.length > 0);
});

test('W309 #5 — kolm config show --help prints body', () => {
  const out = runConfig(['show', '--help']);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /kolm config/);
});
