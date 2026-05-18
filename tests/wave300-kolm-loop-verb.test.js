// Wave 300 — `kolm loop` top-level verb (alias of `kolm doctor --loop`).
//
// W298 shipped the in-process value-loop smoke as a subflag of doctor.
// W300 exposes it as a top-level verb so it's discoverable in `kolm` /
// `kolm completion` / shell autocomplete, while keeping the doctor flag
// for backward compatibility. Behavior assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KOLM_CLI = path.resolve(__dirname, '..', 'cli', 'kolm.js');
const KOLM_SRC = fs.readFileSync(KOLM_CLI, 'utf8');

// Per-spawn isolated HOME so parallel test files don't race ~/.kolm/. We
// deliberately do NOT override KOLM_DATA_DIR (bundled ./data is concurrency
// safe; an empty override crashes libuv UV_HANDLE_CLOSING on Windows).
function isolatedHome() {
  const dir = path.join(os.tmpdir(), 'kolm-w300-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function run(args) {
  const home = isolatedHome();
  const res = spawnSync(process.execPath, [KOLM_CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('W300 #1 — kolm loop --json runs the smoke and exits 0', () => {
  const out = run(['loop', '--json']);
  assert.equal(out.code, 0, `stderr: ${out.stderr.slice(0, 400)}`);
  const jsonStart = out.stdout.indexOf('{');
  const report = JSON.parse(out.stdout.slice(jsonStart));
  assert.equal(report.ok, true);
  assert.equal(report.rungs.length, 6);
});

test('W300 #2 — kolm loop with no args prints PASS markers', () => {
  const out = run(['loop']);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /\[PASS\]\s+boot router/);
  assert.match(out.stdout, /value loop green/);
});

test('W300 #3 — kolm loop --help prints HELP.loop body', () => {
  const out = run(['loop', '--help']);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /kolm loop - run the value-loop smoke/);
  assert.match(out.stdout, /capture\/log/);
  assert.match(out.stdout, /distill\/from-captures/);
  assert.match(out.stdout, /Equivalent to:\s+kolm doctor --loop/);
});

test('W300 #4 — loop is registered in COMPLETION_VERBS for shell completion', () => {
  // Source-level assertion: the verb must be in COMPLETION_VERBS so bash/zsh
  // completion offers it. We grep the source rather than the runtime
  // completion output because the latter requires a shell context to invoke.
  const match = KOLM_SRC.match(/const COMPLETION_VERBS = \[([\s\S]*?)\];/);
  assert.ok(match, 'COMPLETION_VERBS array must exist in cli/kolm.js');
  assert.match(match[1], /'loop'/, "COMPLETION_VERBS must include 'loop'");
});

test('W300 #5 — cmdLoop dispatches into cmdDoctor with --loop forced on', () => {
  // Source-level: the function body must call cmdDoctor with --loop in the args.
  // We don't want a future refactor to silently re-implement the loop in cmdLoop
  // and drift from the doctor --loop behavior asserted by W298.
  const fnMatch = KOLM_SRC.match(/async function cmdLoop\(args\) \{[\s\S]*?\}\n/);
  assert.ok(fnMatch, 'cmdLoop must be defined');
  assert.match(fnMatch[0], /cmdDoctor\(\['--loop'/, "cmdLoop must dispatch into cmdDoctor with --loop");
});

test('W300 #6 — kolm loop verb is in both top-level dispatcher branches', () => {
  // The CLI has two case-switch dispatchers (legacy + main). Both must route
  // 'loop' to cmdLoop or the verb is unreachable from one entry point.
  const loopRoutes = KOLM_SRC.match(/case 'loop':/g) || [];
  assert.ok(loopRoutes.length >= 2, `expected 'loop' in >=2 case branches, got ${loopRoutes.length}`);
});
