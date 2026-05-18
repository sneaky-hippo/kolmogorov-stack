// Wave 310 — `kolm key fingerprint` short verb.
//
// One-liner that prints just the api_key fingerprint (or empty string when
// not logged in). Useful for shell scripts that need to compare which key
// the current session is using (e.g. `if [ "$(kolm key fingerprint)" = ... ]`).

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
  const dir = path.join(os.tmpdir(), 'kolm-w310-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function runKey(extraArgs = [], extraEnv = {}) {
  const home = isolatedHome();
  const res = spawnSync(process.execPath, [KOLM_CLI, 'key', ...extraArgs], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_API_KEY: '', ...extraEnv },
  });
  fs.rmSync(home, { recursive: true, force: true });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('W310 #1 — no key set → exit 0, prints empty line (script-safe)', () => {
  const out = runKey(['fingerprint']);
  assert.equal(out.code, 0, `stderr: ${out.stderr.slice(0, 400)}`);
  // Empty fingerprint should print empty line so $(kolm key fingerprint) is "".
  assert.equal(out.stdout.trim(), '');
});

test('W310 #2 — with KOLM_API_KEY env, prints elided fingerprint', () => {
  const fakeKey = 'ks_test_AAAA0000111122223333DDDD';
  const out = runKey(['fingerprint'], { KOLM_API_KEY: fakeKey });
  assert.equal(out.code, 0);
  const fp = out.stdout.trim();
  assert.ok(fp.startsWith(fakeKey.slice(0, 10)));
  assert.ok(fp.endsWith(fakeKey.slice(-4)));
  assert.ok(fp.includes('...'));
  assert.notEqual(fp, fakeKey);
});

test('W310 #3 — --json mode emits { key_fingerprint, logged_in }', () => {
  const fakeKey = 'ks_test_XYZ0011223344556677889900';
  const out = runKey(['fingerprint', '--json'], { KOLM_API_KEY: fakeKey });
  assert.equal(out.code, 0);
  const jsonStart = out.stdout.indexOf('{');
  const r = JSON.parse(out.stdout.slice(jsonStart));
  assert.equal(r.logged_in, true);
  assert.ok(r.key_fingerprint);
  assert.ok(!out.stdout.includes(fakeKey));
});

test('W310 #4 — kolm key --help prints body', () => {
  const out = runKey(['--help']);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /kolm key/);
});

test('W310 #5 — "key" registered in COMPLETION_VERBS and dispatched from >=2 sites', () => {
  const cliSrc = fs.readFileSync(KOLM_CLI, 'utf8');
  const m = cliSrc.match(/const COMPLETION_VERBS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m);
  assert.match(m[1], /'key'/);
  const calls = (cliSrc.match(/cmdKey\(rest\)/g) || []).length;
  assert.ok(calls >= 2, `expected cmdKey from >=2 sites, got ${calls}`);
});
