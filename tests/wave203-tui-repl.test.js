// Wave 203 - TUI / REPL lock-in tests.
//
// W203 audited the interactive entry points and found three existing
// surfaces: cmdTui (artifact-centric), cmdChat (NL session), cmdChatTui
// (alt-screen NL). None offered a generic "dispatch any kolm verb" REPL.
//
// W203 shipped cmdRepl + `case 'repl':` + HELP.repl + 'repl' in
// COMPLETION_VERBS. The implementation re-uses readline (built-in) and the
// dispatch table; zero new dependencies. Scope is intentionally minimal: no
// history, no completion, no fancy keybindings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLI  = path.join(ROOT, 'cli', 'kolm.js');
const SW   = path.join(ROOT, 'public', 'sw.js');
const SRC  = fs.readFileSync(CLI, 'utf-8');

function runWithStdin(stdin, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, KOLM_AIRGAP: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 12000);
  });
}

test('1. cmdRepl function exists in cli/kolm.js (W203 ship marker)', () => {
  assert.match(SRC, /async function cmdRepl\s*\(/,
    'cmdRepl async function must be defined');
});

test('2. dispatch table has a `case \'repl\':` entry routed via withErrorContext', () => {
  assert.match(SRC, /case 'repl':\s*await withErrorContext\('repl',/,
    'main() switch must include `case \'repl\':` with withErrorContext wrapper');
});

test('3. COMPLETION_VERBS contains "repl"', () => {
  const m = SRC.match(/const COMPLETION_VERBS = \[([\s\S]*?)\];/);
  assert.ok(m, 'COMPLETION_VERBS must exist');
  assert.match(m[1], /'repl'/, 'COMPLETION_VERBS must include the repl verb');
});

test('4. HELP.repl block is present with USAGE + HONEST SCOPE sections', () => {
  const m = SRC.match(/repl:\s*`([\s\S]*?)`,/);
  assert.ok(m, 'HELP.repl must exist');
  assert.match(m[1], /^USAGE$/m, 'HELP.repl must include USAGE section');
  assert.match(m[1], /^HONEST SCOPE$/m, 'HELP.repl must include HONEST SCOPE section');
});

test('5. `echo "exit" | kolm repl` exits cleanly (status 0)', async () => {
  const r = await runWithStdin('exit\n', ['repl']);
  assert.equal(r.status, 0, 'repl exit must close with status 0 (stderr: ' + r.stderr.slice(0, 200) + ')');
});

test('6. `echo "quit" | kolm repl` exits cleanly (status 0; quit alias)', async () => {
  const r = await runWithStdin('quit\n', ['repl']);
  assert.equal(r.status, 0, 'repl quit alias must close with status 0');
});

test('7. `printf "version\\nexit" | kolm repl` exits 0 and stdout contains a version string', async () => {
  const r = await runWithStdin('version\nexit\n', ['repl']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /v\d+\.\d+\.\d+/, 'repl output should include a SemVer version');
});

test('8. empty lines do not crash the REPL (re-prompt without error)', async () => {
  const r = await runWithStdin('\n\n\nexit\n', ['repl']);
  assert.equal(r.status, 0, 'empty lines should not crash repl');
});

test('9. `help` inside the REPL prints the verb list (re-uses COMPLETION_VERBS)', async () => {
  const r = await runWithStdin('help\nexit\n', ['repl']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /verbs:/, 'REPL `help` should print the verb list under a "verbs:" label');
  // a few known verbs should be present
  for (const v of ['version', 'verify', 'inspect']) {
    assert.ok(r.stdout.includes(' ' + v + ' ') || r.stdout.includes(v + ' '),
      'REPL help should list "' + v + '"');
  }
});

test('10. `kolm repl --help` exits 0 and HELP text mentions both "exit" and "quit"', async () => {
  const r = await runWithStdin('', ['repl', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\bexit\b/);
  assert.match(r.stdout, /\bquit\b/);
});

test('11. unknown verb inside REPL prints a helpful list and continues (does not exit)', async () => {
  // The repl-internal verb whitelist intentionally excludes interactive / spawning
  // verbs. Use one of those (e.g. `compile`) and confirm we see the rejection
  // message but the REPL still exits cleanly via the trailing `exit`.
  const r = await runWithStdin('compile\nexit\n', ['repl']);
  assert.equal(r.status, 0, 'repl should survive a non-whitelisted verb attempt and exit 0');
  assert.match(r.stderr + r.stdout,
    /not available inside repl|verbs?:/i,
    'repl should explain why the verb is not available');
});

test('12. HELP.repl prose contains no em-dashes (W202/W203 prose hygiene)', () => {
  const m = SRC.match(/repl:\s*`([\s\S]*?)`,/);
  assert.ok(m);
  assert.ok(!/[—]/.test(m[1]), 'HELP.repl must not include em-dashes');
  assert.ok(!/&mdash;/.test(m[1]), 'HELP.repl must not include &mdash; entities');
});

test('13. cmdRepl uses node:readline (no new dependency)', () => {
  // The file already imports readline at the top (used by cmdTui / cmdChat).
  // We assert cmdRepl uses readline.createInterface inside its body. Slice
  // from cmdRepl up to the next top-level `async function ` so nested
  // closures (which contain their own `\n}`) don't truncate the capture.
  // Use `cmdRepl(` (with the paren) to avoid the `cmdReplay` prefix collision.
  const start = SRC.indexOf('async function cmdRepl(');
  assert.ok(start !== -1, 'cmdRepl must exist');
  const after = SRC.indexOf('\nasync function ', start + 'async function cmdRepl('.length);
  const body = SRC.slice(start, after === -1 ? SRC.length : after);
  assert.match(body, /readline\.createInterface/,
    'cmdRepl must create the interactive interface via node:readline (no third-party dep)');
});

test('14. dispatchRepl helper exists and routes via withErrorContext for whitelisted verbs', () => {
  // The helper lives next to cmdRepl. Make sure it exists and uses withErrorContext.
  const m = SRC.match(/async function dispatchRepl[\s\S]*?\n\}/);
  assert.ok(m, 'dispatchRepl helper must exist');
  // At least three of the supported verbs must route through withErrorContext.
  let hits = 0;
  for (const v of ['version', 'verify', 'inspect', 'whoami', 'doctor']) {
    if (new RegExp("case '" + v + "':\\s*return\\s+withErrorContext\\('" + v + "'").test(m[0])) hits++;
  }
  assert.ok(hits >= 3, 'dispatchRepl should wrap >= 3 verbs via withErrorContext; saw ' + hits);
});

test('15. sw.js CACHE wave-floor regex matches >= 203 (parent orchestrator bumps this)', () => {
  const sw = fs.readFileSync(SW, 'utf-8');
  const m  = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(parseInt(m[1], 10) >= 203,
    'sw.js CACHE wave segment must be >= 203 (saw wave' + m[1] + '); coordinator needs to bump');
});
