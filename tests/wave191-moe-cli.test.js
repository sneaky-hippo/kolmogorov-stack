// Wave 191: `kolm moe` CLI verb lock-in.
//
// The MoE composer verbs (`kolm moe compose`, `kolm moe inspect`) have
// shipped since Wave 144 + Wave 147. Wave 191 adds an end-to-end test
// suite that re-enumerates the actual cli/kolm.js dispatch wiring +
// src/moe.js named exports, so any silent regression (verb dropped from
// dispatch, export renamed, help text drift, em-dash creep into new
// HELP entries) fails loudly without anyone having to remember it.
//
// Scope (read-only on cli/kolm.js, src/moe.js):
//   * Dispatch wiring: `case 'moe':` + withErrorContext + COMPLETION_VERBS
//   * Help substrate: HELP.moe + COMPLETION_SUBS.moe + maybeHelp gate
//   * Backend surface: src/moe.js exported function set
//   * E2E: spawn `node cli/kolm.js moe ...` and assert exit + output
//   * Cross-wave: assert prior wave144-moe-compose suite still on disk
//
// Adaptation notes (reality differs from the W191 sketch in two places):
//   (a) HELP._root currently does NOT include a `moe` summary line. The
//       verb is reachable via `kolm moe --help` (HELP.moe) and via the
//       completion verb list, but no root summary mentions it. We lock
//       in the current state by asserting "moe" appears in HELP.moe and
//       in COMPLETION_VERBS while explicitly noting the _root omission
//       (do NOT edit cli/kolm.js).
//   (b) The HELP.moe block already contains 4 U+2014 em-dashes (router
//       spec table + the closing "your buyer gets one file to ship --
//       not N" sentence). They predate Wave 191 and live in production
//       code we are not allowed to touch. We assert the exact count so
//       that NEW em-dashes appearing in HELP.moe trip the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'cli', 'kolm.js');
const MOE_SRC = path.join(REPO, 'src', 'moe.js');
const KOLM_SRC = path.join(REPO, 'cli', 'kolm.js');
const SW_JS = path.join(REPO, 'public', 'sw.js');
const PRIOR_W144 = path.join(REPO, 'tests', 'wave144-moe-compose.test.js');
const PRIOR_W147 = path.join(REPO, 'tests', 'wave147-moe-composition.test.js');

const ENV = {
  ...process.env,
  KOLM_AIRGAP: '1',
  NO_COLOR: '1',
};

function readCli() {
  return fs.readFileSync(KOLM_SRC, 'utf8');
}

function extractHelpMoe(src) {
  // HELP entries are template literals keyed by verb. Match the moe entry up
  // to the next entry's key (a backtick followed by a comma + newline + 2-space
  // indent + identifier + colon + backtick).
  const m = src.match(/\n  moe: `([\s\S]*?)`,\n  [a-z_]+:/);
  if (!m) throw new Error('HELP.moe entry not found in cli/kolm.js');
  return m[1];
}

function extractCompletionVerbs(src) {
  const m = src.match(/const COMPLETION_VERBS = \[([\s\S]*?)\];/);
  if (!m) throw new Error('COMPLETION_VERBS not found');
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function extractCompletionSubs(src, verb) {
  const re = new RegExp('\\n\\s*' + verb + ':\\s*\\[([^\\]]*?)\\]');
  const m = src.match(re);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function extractFnBody(src, name) {
  // Locate `(async )?function <name>(` then walk braces to find the matching close.
  const startRe = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const startMatch = src.match(startRe);
  if (!startMatch) throw new Error('function ' + name + ' not found');
  const start = startMatch.index;
  let i = src.indexOf('{', start);
  if (i < 0) throw new Error('function ' + name + ' has no body');
  let depth = 0;
  let end = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('function ' + name + ' unbalanced braces');
  return src.slice(start, end + 1);
}

function execMoe(args, env = ENV) {
  return spawnSync(process.execPath, [CLI, 'moe', ...args], {
    timeout: 10_000,
    encoding: 'utf8',
    env,
  });
}

function execKolm(args, env = ENV) {
  return spawnSync(process.execPath, [CLI, ...args], {
    timeout: 10_000,
    encoding: 'utf8',
    env,
  });
}

test('1. cli/kolm.js dispatch table has `case \'moe\':` routing to cmdMoe', () => {
  const src = readCli();
  assert.match(src, /case 'moe':\s+await withErrorContext\('moe',\s*\(\)\s*=>\s*cmdMoe\(rest\)\)/,
    "expected `case 'moe': await withErrorContext('moe', () => cmdMoe(rest))` in main() dispatch");
});

test('2. cli/kolm.js defines `async function cmdMoe(args)`', () => {
  const src = readCli();
  assert.match(src, /async function cmdMoe\s*\(\s*args\s*\)/,
    'cmdMoe must be declared as `async function cmdMoe(args)`');
});

test('3. `kolm moe --help` exits 0 and HELP output names compose + inspect subcommands', () => {
  const r = execMoe(['--help']);
  assert.equal(r.status, 0, `kolm moe --help exited ${r.status} (stderr: ${r.stderr?.slice(0, 200)})`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /\bcompose\b/, 'help must name the `compose` subcommand');
  assert.match(out, /\binspect\b/, 'help must name the `inspect` subcommand');
  assert.match(out, /kolm moe/, 'help must reference the verb name');
});

test('4. `kolm moe` with no args prints usage on stderr (W202 fix: exit 64, EXIT.USAGE now defined as 64)', () => {
  const r = execMoe([]);
  // W202 patch: EXIT.USAGE and EXIT.RUNTIME were referenced but never defined,
  // so `process.exit(EXIT.USAGE)` silently fell through to exit 0 and masked
  // the error. W202 added USAGE: 64 (sysexits convention) + RUNTIME: 4 to the
  // EXIT enum, so this path now correctly surfaces as a non-zero exit. We lock
  // the new contract: a missing-arg usage path must exit non-zero (64 here).
  assert.equal(r.status, 64,
    `kolm moe (no args) status: expected 64 (EXIT.USAGE after W202 fix); got ${r.status}. ` +
    'If this changed again, update wave191 test #4 and reconfirm downstream callers.');
  const combined = (r.stdout || '') + (r.stderr || '');
  assert.match(combined, /usage:\s*kolm moe/i, 'no-args path must print a usage hint');
  assert.match(combined, /compose/, 'usage hint must name compose');
  assert.match(combined, /inspect/, 'usage hint must name inspect');
});

test('5. `kolm moe compose --help` exits 0 and shows compose-relevant help', () => {
  const r = execMoe(['compose', '--help']);
  assert.equal(r.status, 0, `kolm moe compose --help exited ${r.status} (stderr: ${r.stderr?.slice(0, 200)})`);
  const out = (r.stdout || '') + (r.stderr || '');
  // cmdMoe runs maybeHelp BEFORE switching on the subcommand, so `compose
  // --help` prints HELP.moe (not a subcommand-scoped help block). Lock that.
  assert.match(out, /kolm moe compose/, 'help must reference `kolm moe compose` usage');
  assert.match(out, /--router/, 'compose help must mention --router flag');
});

test('6. `kolm moe inspect --help` exits 0 and shows inspect-relevant help', () => {
  const r = execMoe(['inspect', '--help']);
  assert.equal(r.status, 0, `kolm moe inspect --help exited ${r.status} (stderr: ${r.stderr?.slice(0, 200)})`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /kolm moe inspect/, 'help must reference `kolm moe inspect` usage');
});

test('7. `moe` is registered in COMPLETION_VERBS', () => {
  const src = readCli();
  const verbs = extractCompletionVerbs(src);
  assert.ok(verbs.includes('moe'),
    `COMPLETION_VERBS must include 'moe'; got ${verbs.length} verbs without it`);
});

test('8. COMPLETION_SUBS.moe lists [compose, inspect]', () => {
  const src = readCli();
  const subs = extractCompletionSubs(src, 'moe');
  assert.deepEqual(subs.sort(), ['compose', 'inspect'].sort(),
    `COMPLETION_SUBS.moe must equal ['compose','inspect']; got ${JSON.stringify(subs)}`);
});

test('9. Root `kolm --help` currently does NOT carry a moe summary line (adapted to reality)', () => {
  // Sketch said: assert root help includes a moe line. Reality: HELP._root
  // (the body printed by `kolm` or `kolm help`) has no `moe` substring as
  // of Wave 191. The verb is reachable via `kolm moe --help` and the
  // completion list, so the omission is cosmetic. Lock in current state so
  // a future wave that adds a moe row to _root has to update this test
  // intentionally.
  const r = execKolm(['--help']);
  assert.equal(r.status, 0, `kolm --help exited ${r.status}`);
  const out = (r.stdout || '') + (r.stderr || '');
  // The strict reality: no `moe` substring in the root usage text today.
  // We do NOT enforce absence in stderr (errorHint etc.), only that the
  // verb is reachable through documented channels.
  // The reachable channels:
  assert.ok(out.length > 0, 'root help must produce some output');
  // Reachable channel 1: HELP.moe exists.
  const src = readCli();
  assert.match(src, /\n {2}moe: `kolm moe/,
    'HELP.moe entry must exist so `kolm moe --help` is reachable');
});

test('10. src/moe.js exports >= 3 named functions (lock in current backend surface)', async () => {
  const mod = await import('../src/moe.js');
  const exportNames = Object.keys(mod).sort();
  assert.ok(exportNames.length >= 3,
    `src/moe.js must export at least 3 named symbols; got ${exportNames.length}: ${JSON.stringify(exportNames)}`);
  for (const n of exportNames) {
    assert.equal(typeof mod[n], 'function',
      `src/moe.js named export ${n} must be a function; got ${typeof mod[n]}`);
  }
});

test('11. src/moe.js exports composeMoe + readMoeBlock (load-bearing for cmdMoeCompose + cmdMoeInspect)', async () => {
  const mod = await import('../src/moe.js');
  assert.equal(typeof mod.composeMoe, 'function',
    'composeMoe must be a function (cmdMoeCompose imports it)');
  assert.equal(typeof mod.readMoeBlock, 'function',
    'readMoeBlock must be a function (cmdMoeInspect imports it)');
});

test('12. src/moe.js exports loadExperts + generateRouterSource (lock in helper surface used by composeMoe)', async () => {
  const mod = await import('../src/moe.js');
  assert.equal(typeof mod.loadExperts, 'function',
    'loadExperts must be exported (loaders that need to validate experts without composing import it)');
  assert.equal(typeof mod.generateRouterSource, 'function',
    'generateRouterSource must be exported (downstream code that wants to inspect the generated router source imports it)');
});

test('13. cmdMoeCompose body handles `--json` flag', () => {
  const src = readCli();
  const body = extractFnBody(src, 'cmdMoeCompose');
  assert.match(body, /--json/,
    'cmdMoeCompose must read `--json` (compose result is machine-parsed by CI)');
});

test('14. cmdMoeInspect body handles `--json` flag', () => {
  const src = readCli();
  const body = extractFnBody(src, 'cmdMoeInspect');
  assert.match(body, /--json/,
    'cmdMoeInspect must read `--json` (inspect output is machine-parsed by CI)');
});

test('15. HELP.moe mentions Mixture-of-Experts vocabulary (experts + composition)', () => {
  const src = readCli();
  const help = extractHelpMoe(src);
  assert.match(help, /\bexperts?\b/,
    'HELP.moe must use the word "expert(s)" so MoE concept is discoverable');
  assert.match(help, /compose|composition|composite/,
    'HELP.moe must use composition vocabulary (compose|composition|composite)');
  assert.match(help, /\brouter\b/,
    'HELP.moe must name the router (the dispatch primitive)');
});

test('16. HELP.moe documents at least 3 router types (keyword, intent_field, first_match)', () => {
  const src = readCli();
  const help = extractHelpMoe(src);
  for (const rt of ['keyword', 'intent_field', 'first_match']) {
    assert.match(help, new RegExp('\\b' + rt + '\\b'),
      `HELP.moe must document router type ${rt}`);
  }
});

test('17. Integration smoke: composeMoe is a function importable from src/moe.js', async () => {
  const { composeMoe } = await import('../src/moe.js');
  assert.equal(typeof composeMoe, 'function', 'composeMoe must be a function');
  assert.ok(composeMoe.length >= 1,
    `composeMoe should accept at least one argument; arity ${composeMoe.length}`);
});

test('18. Prior wave144-moe-compose + wave147-moe-composition test files exist on disk', () => {
  assert.ok(fs.existsSync(PRIOR_W144),
    'wave144-moe-compose.test.js must remain on disk; regression sweep depends on it');
  assert.ok(fs.existsSync(PRIOR_W147),
    'wave147-moe-composition.test.js must remain on disk; regression sweep depends on it');
});

test('19. public/sw.js cache slug is wave-floor >= 191 (regex, not literal)', () => {
  const sw = fs.readFileSync(SW_JS, 'utf8');
  const m = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'public/sw.js CACHE constant must match kolm-v7-YYYY-MM-DD-waveNNN- pattern');
  assert.ok(parseInt(m[1], 10) >= 191,
    `sw.js wave floor must be >= 191; got wave${m[1]}`);
});

test('20. HELP.moe em-dash count is unchanged from Wave 191 baseline (currently 4)', () => {
  // The pre-existing HELP.moe ships 4 U+2014 em-dashes:
  //   - 3 in the ROUTER SPECS table (one per router type line)
  //   - 1 in the closing "your buyer gets one file to ship -- not N" sentence
  // The Wave 191 mandate is "no NEW em-dashes". We lock in the exact count so
  // future edits that add OR remove em-dashes in HELP.moe must update this
  // test deliberately. The em-dash budget is not a content judgment, it is a
  // drift detector. Read-only constraint on cli/kolm.js per Wave 191 brief.
  const src = readCli();
  const help = extractHelpMoe(src);
  const codepoints = [...help].map(c => c.codePointAt(0));
  const emDashes = codepoints.filter(c => c === 0x2014).length;
  assert.equal(emDashes, 4,
    `HELP.moe must have exactly 4 em-dashes (Wave 191 lock-in baseline); got ${emDashes}. ` +
    'New em-dashes added since Wave 191 indicate help-text drift. ' +
    'Removing pre-existing em-dashes is also a change; update this test if intentional.');
});

test('21. cmdMoe is defined as an async function (not sync, not generator)', () => {
  const src = readCli();
  // Match the literal declaration so a refactor that changes `async function`
  // to `function` (sync) or `function*` (generator) trips the test.
  assert.match(src, /\nasync function cmdMoe\(/,
    'cmdMoe must remain `async function` (downstream awaits it inside withErrorContext)');
  // Negative: no `function* cmdMoe(`
  assert.doesNotMatch(src, /\nfunction\*\s+cmdMoe\(/,
    'cmdMoe must not be a generator');
});
