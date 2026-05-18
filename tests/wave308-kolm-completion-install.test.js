// Wave 308 — `kolm completion install` shell-RC writer.
//
// Adds an `install` subcommand to the existing `kolm completion` verb that
// appends the eval line into the user's shell rc (.bashrc / .zshrc / fish
// config), detecting the shell from $SHELL when --shell is omitted. Must be
// idempotent — running it twice is a no-op.

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
  const dir = path.join(os.tmpdir(), 'kolm-w308-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function runInstall(extraArgs = [], extraEnv = {}, rcSeed = null) {
  const home = isolatedHome();
  const rc = path.join(home, '.bashrc');
  if (rcSeed != null) fs.writeFileSync(rc, rcSeed, 'utf8');
  const res = spawnSync(process.execPath, [KOLM_CLI, 'completion', 'install', '--rc', rc, ...extraArgs], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_API_KEY: '', SHELL: '/bin/bash', ...extraEnv },
  });
  const rcAfter = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
  fs.rmSync(home, { recursive: true, force: true });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '', rcAfter };
}

test('W308 #1 — install appends eval line to a fresh rc file', () => {
  const r = runInstall();
  assert.equal(r.code, 0, `stderr: ${r.stderr.slice(0, 400)}`);
  assert.match(r.rcAfter, /kolm completion bash/);
  assert.match(r.rcAfter, /eval/);
});

test('W308 #2 — idempotent: second run does NOT double-append', () => {
  const r1 = runInstall([], {}, '');
  assert.equal(r1.code, 0);
  // Now run again with the rc content already containing the eval line.
  const r2 = runInstall([], {}, r1.rcAfter);
  assert.equal(r2.code, 0);
  const occurrences = (r2.rcAfter.match(/kolm completion bash/g) || []).length;
  assert.equal(occurrences, 1, `expected exactly 1 eval line, got ${occurrences}`);
});

test('W308 #3 — --dry-run prints diff but does NOT write', () => {
  const home = isolatedHome();
  const rc = path.join(home, '.bashrc');
  fs.writeFileSync(rc, '# my rc\n', 'utf8');
  const res = spawnSync(process.execPath, [KOLM_CLI, 'completion', 'install', '--rc', rc, '--dry-run'], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_API_KEY: '', SHELL: '/bin/bash' },
  });
  const after = fs.readFileSync(rc, 'utf8');
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(res.status, 0);
  assert.equal(after, '# my rc\n', 'rc must be unchanged in --dry-run');
  assert.match(res.stdout, /would append/i);
});

test('W308 #4 — --shell zsh writes the zsh eval line', () => {
  const home = isolatedHome();
  const rc = path.join(home, '.zshrc');
  const res = spawnSync(process.execPath, [KOLM_CLI, 'completion', 'install', '--shell', 'zsh', '--rc', rc], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_API_KEY: '' },
  });
  const after = fs.readFileSync(rc, 'utf8');
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(res.status, 0);
  assert.match(after, /kolm completion zsh/);
});

test('W308 #5 — completion install --help prints body', () => {
  const home = isolatedHome();
  const res = spawnSync(process.execPath, [KOLM_CLI, 'completion', 'install', '--help'], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_API_KEY: '' },
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /completion install/);
  assert.match(res.stdout, /--shell/);
});
