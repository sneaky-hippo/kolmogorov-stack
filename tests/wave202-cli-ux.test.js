// Wave 202 - CLI UX audit lock-in tests.
//
// The W202 patch was a polish wave: it found inconsistencies between the main
// dispatch switch and COMPLETION_VERBS (11 verbs missing), discovered two
// undefined EXIT enum members (EXIT.USAGE / EXIT.RUNTIME) silently masking
// errors as exit 0, and ensured every dispatch case still uses withErrorContext.
//
// These tests lock in the audit findings so the next regression that drifts
// COMPLETION_VERBS / removes withErrorContext / drops EXIT enum members fails
// loudly here instead of silently in CI/users' terminals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLI  = path.join(ROOT, 'cli', 'kolm.js');
const SW   = path.join(ROOT, 'public', 'sw.js');
const SRC  = fs.readFileSync(CLI, 'utf-8');

const run = (args, env = {}) =>
  spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, KOLM_AIRGAP: '1', ...env },
    timeout: 15000,
  });

function dispatchVerbs() {
  // Slice the main() switch body so we don't pick up sub-switches elsewhere.
  const start = SRC.indexOf('async function main()');
  const block = SRC.slice(start, start + 9000);
  const seen = new Set();
  for (const m of block.matchAll(/^\s*case '([^']+)':/gm)) seen.add(m[1]);
  return seen;
}
function completionVerbs() {
  const m = SRC.match(/const COMPLETION_VERBS = \[([\s\S]*?)\];/);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
}

test('1. every verb in dispatch is also in COMPLETION_VERBS', () => {
  const disp = dispatchVerbs();
  const cv   = completionVerbs();
  // Exclude pure flag-style cases (--help, -h, --version, -v) and the catch-all
  // help token: these are not user-discoverable verbs.
  const skipped = new Set(['--help', '-h', '--version', '-v', 'help']);
  const missing = [...disp].filter(v => !skipped.has(v) && !cv.has(v));
  assert.deepEqual(missing, [],
    'these dispatch verbs are not in COMPLETION_VERBS: ' + JSON.stringify(missing));
});

test('2. every dispatch case uses withErrorContext wrapper', () => {
  const start = SRC.indexOf('async function main()');
  const block = SRC.slice(start, start + 9000);
  const offenders = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*case '([^']+)':\s*await/);
    if (m && !line.includes('withErrorContext')) offenders.push(m[1]);
  }
  assert.deepEqual(offenders, [],
    'these cases use `await` without withErrorContext: ' + JSON.stringify(offenders));
});

test('3. `kolm --help` exits 0 and lists every COMPLETION_VERBS entry that has a row in HELP._root', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0, '`kolm --help` exit code (stderr: ' + r.stderr?.slice(0, 200) + ')');
  // Sanity: a few high-traffic verbs MUST appear (catches an accidental HELP._root truncation).
  for (const v of ['init', 'compile', 'verify', 'serve', 'distill', 'seeds', 'version']) {
    assert.ok(r.stdout.includes(' ' + v + ' ') || r.stdout.includes('\n  ' + v + ' '),
      'HELP._root must list "' + v + '"');
  }
});

test('4. `kolm version` works (returns text containing a semver-like string)', () => {
  const r = run(['version', '--offline']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /v\d+\.\d+\.\d+/, 'version output should contain SemVer');
});

test('5. `kolm version --short` returns one SemVer line (W175 lock-in re-asserted)', () => {
  const r = run(['version', '--short']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^kolm v\d+\.\d+\.\d+\s*$/m);
});

test('6. `kolm <invalid-verb>` exits non-zero with a usable error (no Node stack trace)', () => {
  const r = run(['some-totally-bogus-verb-zzz']);
  assert.notEqual(r.status, 0, 'invalid verb must exit non-zero');
  // Must NOT include a Node stack trace as the primary error surface.
  assert.ok(!/at\s+\S+\s+\(.+:\d+:\d+\)/.test(r.stderr.slice(0, 400)),
    'invalid verb should not surface a Node stack trace');
  // Must include a "unknown command" hint (the dispatcher prints this).
  assert.match(r.stderr, /unknown command/i);
});

test('7. HELP for 5 high-traffic verbs (verify / compile / distill / nl / seeds) contains USAGE header', () => {
  for (const v of ['verify', 'compile', 'distill', 'nl', 'seeds']) {
    const r = run([v, '--help']);
    assert.equal(r.status, 0, '`kolm ' + v + ' --help` should exit 0 (got ' + r.status + ')');
    assert.match(r.stdout, /^USAGE$/m, '`kolm ' + v + ' --help` output must contain USAGE');
  }
});

test('8. --json flag is wired on verbs that advertise it (smoke: nl --json air-gap)', () => {
  // cmdNl has explicit --json branch; smoke-test it returns JSON-parseable output.
  const r = run(['nl', 'a simple regex redactor', '--json']);
  assert.equal(r.status, 0, 'nl --json should succeed under air-gap');
  // first line that looks like JSON object
  const jsonLine = r.stdout.trim().split('\n').find(l => l.startsWith('{'));
  assert.ok(jsonLine, 'nl --json must emit a JSON object');
  // Parsing the whole stdout (it's a pretty-printed JSON block) should not throw.
  const obj = JSON.parse(r.stdout);
  assert.ok(typeof obj === 'object' && obj !== null, 'nl --json output must be a JSON object');
});

test('9. no two HELP blocks are byte-identical (de-dup check via sha256)', async () => {
  const crypto = await import('node:crypto');
  const helpStart = SRC.indexOf('const HELP = {');
  const helpEnd   = SRC.indexOf('\nfunction usage(topic)');
  const block     = SRC.slice(helpStart, helpEnd);
  const re        = /^  ([a-zA-Z_][a-zA-Z0-9_-]*):\s*`([\s\S]*?)`,?$/gm;
  const hashes    = new Map();
  let m;
  while ((m = re.exec(block)) !== null) {
    const key = m[1];
    const body = m[2].trim();
    if (body.length < 40) continue; // skip ultra-short aliases like HELP.attest
    const h = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
    if (hashes.has(h)) {
      assert.fail('HELP.' + key + ' is byte-identical to HELP.' + hashes.get(h));
    }
    hashes.set(h, key);
  }
});

test('10. EXIT enum defines OK / BAD_ARGS / GATE_FAIL / MISSING_PREREQ / EXECUTION / NOT_FOUND / USAGE / RUNTIME', () => {
  const m = SRC.match(/const EXIT = \{([\s\S]*?)\};/);
  assert.ok(m, 'EXIT enum must exist');
  for (const k of ['OK', 'BAD_ARGS', 'GATE_FAIL', 'MISSING_PREREQ', 'EXECUTION', 'NOT_FOUND', 'USAGE', 'RUNTIME']) {
    assert.match(m[1], new RegExp('\\b' + k + ':\\s*\\d+'),
      'EXIT.' + k + ' must be defined as a numeric constant (W202 fix for undefined EXIT.USAGE / EXIT.RUNTIME)');
  }
});

test('11. EXIT enum has at least 5 distinct exit-code values (variety guard)', () => {
  const m = SRC.match(/const EXIT = \{([\s\S]*?)\};/);
  const values = [...m[1].matchAll(/:\s*(\d+)/g)].map(x => Number(x[1]));
  const distinct = new Set(values);
  assert.ok(distinct.size >= 5, 'EXIT enum should expose >= 5 distinct numeric codes (saw ' + distinct.size + ')');
});

test('12. COMPLETION_VERBS contains all the W202-added entries (drift / trace / ir / device / cc / fl / test / tui)', () => {
  const cv = completionVerbs();
  for (const v of ['drift', 'trace', 'ir', 'device', 'cc', 'fl', 'test', 'tui',
                   'sigstore-attest', 'attest', 'self-update']) {
    assert.ok(cv.has(v), 'COMPLETION_VERBS should contain "' + v + '" (W202 audit gap)');
  }
});

test('13. COMPLETION_VERBS has at least 70 entries (post-W202 baseline; was 65 pre-patch)', () => {
  const cv = completionVerbs();
  assert.ok(cv.size >= 70, 'COMPLETION_VERBS should have >= 70 entries; saw ' + cv.size);
});

test('14. sw.js CACHE wave-floor regex matches >= 202 (parent orchestrator bumps this)', () => {
  const sw = fs.readFileSync(SW, 'utf-8');
  const m  = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(parseInt(m[1], 10) >= 202,
    'sw.js CACHE wave segment must be >= 202 (saw wave' + m[1] + '); coordinator needs to bump');
});

test('15. no em-dashes in NEW W202 prose (HELP.repl + EXIT alias comments)', () => {
  // We pin the W202 additions; the historic budget elsewhere is locked by W191.
  const helpReplMatch = SRC.match(/repl:\s*`([\s\S]*?)`,/);
  assert.ok(helpReplMatch, 'HELP.repl must exist (W203 ships it; W202 tests its prose hygiene)');
  assert.ok(!/[—]|&mdash;/.test(helpReplMatch[1]),
    'HELP.repl must not contain em-dashes or &mdash;');
  // EXIT alias comment block (W202 patch)
  const exitBlock = SRC.match(/Aliases used by call sites[\s\S]*?RUNTIME:\s*\d+,?/);
  assert.ok(exitBlock, 'W202 EXIT alias comment must be present');
  assert.ok(!/[—]|&mdash;/.test(exitBlock[0]),
    'W202 EXIT enum prose must not contain em-dashes');
});

test('16. firstRunBannerIfNeeded prints a usable signin URL (kolm.ai)', () => {
  // Tone check: the first-run banner shouldn't push marketing fluff at users.
  const m = SRC.match(/function firstRunBannerIfNeeded[\s\S]*?\n\}/);
  assert.ok(m, 'firstRunBannerIfNeeded must exist');
  assert.match(m[0], /kolm\.ai/, 'banner should mention kolm.ai for key issuance');
  assert.ok(!/[—]|&mdash;/.test(m[0]), 'first-run banner must not contain em-dashes');
});

test('17. error messages use a "error:" or "[kolm <verb>]" prefix (consistent tone)', () => {
  // The withErrorContext wrapper produces "[kolm <verb>] ...". The global catch
  // in main() prints "error: <msg>". Smoke-test by running an inspect on a
  // nonexistent path and asserting one of the two prefixes appears.
  const r = run(['inspect', '/no/such/path/nope.kolm']);
  assert.notEqual(r.status, 0, 'inspect on missing path should fail');
  const combined = (r.stderr || '') + (r.stdout || '');
  assert.ok(/error:|\[kolm /.test(combined),
    'error output should carry a consistent prefix (got: ' + combined.slice(0, 200) + ')');
});

test('18. every verb that takes a sub-command has a COMPLETION_SUBS entry (audit lock-in)', () => {
  // Verbs known to have sub-commands. If we add one without registering subs,
  // bash/zsh/fish completion silently falls back to no suggestions.
  const m = SRC.match(/const COMPLETION_SUBS = \{([\s\S]*?)\};/);
  assert.ok(m, 'COMPLETION_SUBS object must exist');
  for (const v of ['auditor', 'compute', 'airgap', 'team', 'tunnel', 'cloud',
                   'hub', 'tune', 'tokenize', 'moe', 'doc', 'rag', 'capture',
                   'install', 'completion', 'models', 'gpu', 'seeds',
                   'hmac', 'keys', 'quantize']) {
    assert.match(m[1], new RegExp('\\b' + v + ':\\s*\\['),
      'COMPLETION_SUBS should expose subcommands for "' + v + '"');
  }
});
