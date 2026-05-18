// Wave 303 — `kolm loop --remote` walks the same rungs against the cloud.
//
// W298 ran the loop in-process; W303 makes the same code path drivable
// against the user's configured cloud base so an installed key can be
// proven end-to-end against prod (or staging) without having to spin
// the in-process router. Behavior-only assertions.

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
  const dir = path.join(os.tmpdir(), 'kolm-w303-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function runLoopRemote(extraArgs = [], envOverrides = {}) {
  // Default to an empty HOME so loadConfig() picks up nothing from the host
  // user's real ~/.kolm/config.json.
  const tmpHome = isolatedHome();
  const res = spawnSync(process.execPath, [KOLM_CLI, 'loop', '--remote', ...extraArgs], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      KOLM_API_KEY: '',
      ...envOverrides,
    },
  });
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('W303 #1 — --remote without api_key fails clearly + non-zero exit', () => {
  const out = runLoopRemote();
  assert.notEqual(out.code, 0, 'no api_key must yield non-zero exit');
  // Text-mode failure prints [FAIL] remote auth with the actionable message.
  assert.match(out.stdout, /\[FAIL\]\s+remote auth/);
  assert.match(out.stdout, /no api_key/);
  assert.match(out.stdout, /kolm login/);
});

test('W303 #2 — --remote --json reports mode=remote regardless of outcome', () => {
  const out = runLoopRemote(['--json']);
  const jsonStart = out.stdout.indexOf('{');
  assert.ok(jsonStart >= 0, `no JSON payload found: ${out.stdout.slice(0, 400)}`);
  const report = JSON.parse(out.stdout.slice(jsonStart));
  assert.equal(report.mode, 'remote', `mode must be "remote" in --remote runs, got: ${report.mode}`);
  assert.equal(report.ok, false, 'ok must be false when remote auth fails');
});

test('W303 #3 — --remote auth-fail surfaces remote auth rung with status=fail', () => {
  const out = runLoopRemote(['--json']);
  const jsonStart = out.stdout.indexOf('{');
  const report = JSON.parse(out.stdout.slice(jsonStart));
  const authRung = report.rungs.find(r => r.name === 'remote auth');
  assert.ok(authRung, `rungs must include "remote auth" (got names: ${report.rungs.map(r => r.name).join(',')})`);
  assert.equal(authRung.status, 'fail');
  assert.match(authRung.detail, /no api_key/);
});

test('W303 #4 — in-process mode (no --remote) reports mode=in-process', () => {
  // Sanity: ensure the refactor did not regress the default. We hit the
  // public CLI without --remote and assert the JSON payload tags the mode
  // correctly. This guards the W302 refactor that introduced the field.
  const home = isolatedHome();
  const res = spawnSync(process.execPath, [KOLM_CLI, 'loop', '--json'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  assert.equal(res.status, 0, `in-process loop must still exit 0; got ${res.status} (stderr: ${(res.stderr || '').slice(0, 400)})`);
  const jsonStart = (res.stdout || '').indexOf('{');
  const report = JSON.parse((res.stdout || '').slice(jsonStart));
  assert.equal(report.mode, 'in-process');
  assert.equal(report.ok, true);
});

test('W303 #5 — cmdDoctor source path declares --remote handling', () => {
  // Implementation-side check that the --remote branch exists in the source
  // (so a future refactor cannot silently delete the remote walker while
  // leaving --remote as a no-op alias for in-process mode).
  const src = fs.readFileSync(KOLM_CLI, 'utf8');
  assert.match(src, /const remoteMode = args\.includes\('--remote'\)/);
  assert.match(src, /if \(remoteMode\)/);
  assert.match(src, /walkLoop\(remoteBase,/);
  // The walk body must be shared (single source of truth) between in-process
  // and remote modes: both call walkLoop(...) — not two copy-pasted blocks.
  const walkLoopCalls = (src.match(/await walkLoop\(/g) || []).length;
  assert.ok(walkLoopCalls >= 2, `walkLoop should be called from both modes (>=2 sites), got ${walkLoopCalls}`);
});

test('W303 #6 — HELP.loop documents --remote flag', () => {
  const src = fs.readFileSync(KOLM_CLI, 'utf8');
  // HELP.loop is defined as an object-property entry: `loop: \`...\`,`
  const helpBlock = src.match(/\n\s*loop:\s*`([\s\S]*?)`,/);
  assert.ok(helpBlock, 'HELP.loop entry must exist as object property');
  assert.match(helpBlock[1], /--remote/, 'HELP.loop must mention --remote');
});
