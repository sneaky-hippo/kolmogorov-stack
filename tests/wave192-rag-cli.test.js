// Wave 192: `kolm rag` CLI verb lock-in.
//
// The airgapped local-retrieval verb (BM25, no embedder, no network) has
// shipped for a while. Wave 192 adds an end-to-end test suite that
// re-enumerates the actual cli/kolm.js dispatch wiring + src/rag.js named
// exports, so any silent regression (verb dropped, export renamed, help
// text drift, em-dash creep) fails loudly.
//
// Scope (read-only on cli/kolm.js, src/rag.js):
//   * Dispatch wiring: `case 'rag':` + withErrorContext + COMPLETION_VERBS
//   * Help substrate: HELP.rag + COMPLETION_SUBS.rag + maybeHelp gate
//   * Backend surface: src/rag.js exported function set
//   * E2E: spawn `node cli/kolm.js rag ...` and assert exit + output
//   * Honest scope: `rag` does NOT feed src/binder.js or src/verifier.js
//     today (no verifier check binds the rag index hash into a manifest
//     receipt). This is locked in so a future wave that wires receipt-
//     chain integration has to update this test deliberately.
//
// Adaptation notes (reality differs from the W192 sketch in two places):
//   (a) The W192 sketch expected vocabulary like "ragLineage" or
//       "retrieval_provenance" inside HELP.rag. The current HELP.rag uses
//       `kolm rag attach <art.kolm> --index <name>` as the receipt-chain
//       integration primitive (the index name is pinned into the
//       artifact's manifest by the `attach` subcommand). We assert the
//       `attach` subcommand is documented; if future work adds a
//       `retrieval_provenance` block to the manifest, that test should
//       be tightened.
//   (b) HELP.rag has zero em-dashes today; we lock that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'cli', 'kolm.js');
const KOLM_SRC = CLI;
const RAG_SRC = path.join(REPO, 'src', 'rag.js');
const BINDER_SRC = path.join(REPO, 'src', 'binder.js');
const VERIFIER_SRC = path.join(REPO, 'src', 'verifier.js');
const SW_JS = path.join(REPO, 'public', 'sw.js');

const ENV = {
  ...process.env,
  KOLM_AIRGAP: '1',
  NO_COLOR: '1',
};

function readCli() {
  return fs.readFileSync(KOLM_SRC, 'utf8');
}

function extractHelpRag(src) {
  const m = src.match(/\n  rag: `([\s\S]*?)`,\n  [a-z_]+:/);
  if (!m) throw new Error('HELP.rag entry not found in cli/kolm.js');
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

function execRag(args, env = ENV) {
  return spawnSync(process.execPath, [CLI, 'rag', ...args], {
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

test('1. cli/kolm.js dispatch table has `case \'rag\':` routing to cmdRag', () => {
  const src = readCli();
  assert.match(src, /case 'rag':\s+await withErrorContext\('rag',\s*\(\)\s*=>\s*cmdRag\(rest\)\)/,
    "expected `case 'rag': await withErrorContext('rag', () => cmdRag(rest))` in main() dispatch");
});

test('2. cli/kolm.js defines `async function cmdRag(args)`', () => {
  const src = readCli();
  assert.match(src, /async function cmdRag\s*\(\s*args\s*\)/,
    'cmdRag must be declared as `async function cmdRag(args)`');
});

test('3. `kolm rag --help` exits 0 and HELP output references the verb', () => {
  const r = execRag(['--help']);
  assert.equal(r.status, 0, `kolm rag --help exited ${r.status} (stderr: ${r.stderr?.slice(0, 200)})`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /kolm rag/, 'help text must reference the verb name');
});

test('4. `kolm rag` with no args prints HELP and exits BAD_ARGS=1 (cmdRag calls usage + EXIT.BAD_ARGS)', () => {
  const r = execRag([]);
  // Reality: cmdRag falls through to `if (!sub) { usage('rag'); process.exit(EXIT.BAD_ARGS); }`
  // EXIT.BAD_ARGS = 1 per the EXIT enum at the top of cli/kolm.js.
  assert.equal(r.status, 1,
    `kolm rag (no args) must exit 1 (EXIT.BAD_ARGS); got ${r.status}. ` +
    'If this changed intentionally, update wave192 test #4.');
  const combined = (r.stdout || '') + (r.stderr || '');
  assert.match(combined, /kolm rag/, 'no-args path must print usage referencing the verb');
});

test('5. HELP.rag documents all 4 subcommands: index, query, attach, list', () => {
  const src = readCli();
  const help = extractHelpRag(src);
  for (const sub of ['index', 'query', 'attach', 'list']) {
    assert.match(help, new RegExp('kolm rag ' + sub + '\\b'),
      `HELP.rag must document the \`kolm rag ${sub}\` subcommand`);
  }
});

test('6. cmdRag body wires all 4 subcommands via switch cases', () => {
  const src = readCli();
  const body = extractFnBody(src, 'cmdRag');
  for (const sub of ['index', 'query', 'attach', 'list']) {
    assert.match(body, new RegExp("case '" + sub + "':"),
      `cmdRag must include \`case '${sub}':\``);
  }
});

test('7. `rag` is registered in COMPLETION_VERBS', () => {
  const src = readCli();
  const verbs = extractCompletionVerbs(src);
  assert.ok(verbs.includes('rag'),
    `COMPLETION_VERBS must include 'rag'; got ${verbs.length} verbs without it`);
});

test('8. COMPLETION_SUBS.rag lists [index, query, attach, list]', () => {
  const src = readCli();
  const subs = extractCompletionSubs(src, 'rag');
  assert.deepEqual(subs.sort(), ['attach', 'index', 'list', 'query'],
    `COMPLETION_SUBS.rag must equal ['attach','index','list','query']; got ${JSON.stringify(subs)}`);
});

test('9. Root `kolm --help` includes a `rag` summary line', () => {
  const r = execKolm(['--help']);
  assert.equal(r.status, 0, `kolm --help exited ${r.status}`);
  const out = (r.stdout || '') + (r.stderr || '');
  // HELP._root has `rag <sub>` line at line 326. Lock the substring.
  assert.match(out, /\brag\b/,
    'root help must list the rag verb (currently `rag <sub>` in HELP._root)');
});

test('10. src/rag.js exports >= 3 named functions (lock in current backend surface)', async () => {
  const mod = await import('../src/rag.js');
  const exportNames = Object.keys(mod).sort();
  assert.ok(exportNames.length >= 3,
    `src/rag.js must export at least 3 named symbols; got ${exportNames.length}: ${JSON.stringify(exportNames)}`);
  for (const n of exportNames) {
    assert.equal(typeof mod[n], 'function',
      `src/rag.js named export ${n} must be a function; got ${typeof mod[n]}`);
  }
});

test('11. src/rag.js exports the load-bearing functions used by cmdRag', async () => {
  // cmdRag imports the whole module as `rag` and calls rag.indexDir,
  // rag.queryIndex, rag.attachIndexToArtifact, rag.listIndexes. Lock those.
  const mod = await import('../src/rag.js');
  for (const fn of ['indexDir', 'queryIndex', 'attachIndexToArtifact', 'listIndexes']) {
    assert.equal(typeof mod[fn], 'function',
      `src/rag.js must export ${fn} (cmdRag calls rag.${fn})`);
  }
});

test('12. cmdRag body reads `--json` flag (for `kolm rag query --json`)', () => {
  const src = readCli();
  const body = extractFnBody(src, 'cmdRag');
  assert.match(body, /--json/,
    'cmdRag must read `--json` (query result is machine-parsed by CI)');
});

test('13. HELP.rag includes retrieval vocabulary (retrieval | BM25 | index)', () => {
  const src = readCli();
  const help = extractHelpRag(src);
  assert.match(help, /retrieval|BM25|index/i,
    'HELP.rag must use retrieval/BM25/index vocabulary so the verb is discoverable');
});

test('14. HELP.rag documents `kolm rag attach` as the artifact-binding primitive (receipt-chain bridge)', () => {
  const src = readCli();
  const help = extractHelpRag(src);
  // The current receipt-chain bridge is `attach`: it pins the rag index name
  // into the artifact's manifest so a downstream run can resolve
  // `lib.rag.query(q, k)` deterministically. The sketch asked for
  // ragLineage/retrieval_provenance vocabulary; that vocabulary does NOT
  // exist today (verified: src/binder.js + src/verifier.js have no `rag`
  // references). When provenance binding ships, tighten this assertion.
  assert.match(help, /kolm rag attach/,
    'HELP.rag must document `kolm rag attach <art.kolm> --index <name>` (the artifact-binding subcommand)');
  assert.match(help, /lib\.rag/,
    'HELP.rag must reference the runtime helper `lib.rag.query(q, k)` so recipe authors know how to consume the index');
});

test('15. HELP.rag includes an EXAMPLES block with concrete `kolm rag ...` invocations', () => {
  const src = readCli();
  const help = extractHelpRag(src);
  assert.match(help, /EXAMPLES/, 'HELP.rag must include an EXAMPLES section');
  const exampleCount = (help.match(/kolm rag /g) || []).length;
  assert.ok(exampleCount >= 4,
    `HELP.rag must include at least 4 \`kolm rag ...\` invocations (usage + examples); got ${exampleCount}`);
});

test('16. public/sw.js cache slug is wave-floor >= 192 (regex, not literal)', () => {
  const sw = fs.readFileSync(SW_JS, 'utf8');
  const m = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'public/sw.js CACHE constant must match kolm-v7-YYYY-MM-DD-waveNNN- pattern');
  assert.ok(parseInt(m[1], 10) >= 192,
    `sw.js wave floor must be >= 192; got wave${m[1]}`);
});

test('17. HELP.rag em-dash count is unchanged from Wave 192 baseline (currently 0)', () => {
  // Lock in zero em-dashes in HELP.rag so any future edit that introduces
  // one trips the test and the author has to acknowledge it.
  const src = readCli();
  const help = extractHelpRag(src);
  const codepoints = [...help].map(c => c.codePointAt(0));
  const emDashes = codepoints.filter(c => c === 0x2014).length;
  assert.equal(emDashes, 0,
    `HELP.rag must have 0 em-dashes (Wave 192 baseline); got ${emDashes}. ` +
    'Em-dashes added since Wave 192 indicate help-text drift.');
});

test('18. cmdRag is defined as an async function (not sync, not generator)', () => {
  const src = readCli();
  assert.match(src, /\nasync function cmdRag\(/,
    'cmdRag must remain `async function` (it awaits import(\'../src/rag.js\'))');
  assert.doesNotMatch(src, /\nfunction\*\s+cmdRag\(/,
    'cmdRag must not be a generator');
});

test('19. `rag` does NOT currently feed src/binder.js or src/verifier.js (honest scope lock-in)', () => {
  // This is the honest-scope assertion called out in the Wave 192 brief: as
  // of Wave 192, the rag index hash is NOT bound into the artifact manifest
  // by a verifier check. `kolm rag attach` writes a sidecar file (the
  // index name) that the runtime sandbox reads, but no binder check
  // re-anchors the index hash against the manifest. Future work on
  // retrieval-provenance receipts (rag.lineage / retrieval_provenance) will
  // change this; until then, lock the current scope.
  const binder = fs.existsSync(BINDER_SRC) ? fs.readFileSync(BINDER_SRC, 'utf8') : '';
  const verifier = fs.existsSync(VERIFIER_SRC) ? fs.readFileSync(VERIFIER_SRC, 'utf8') : '';
  // Use a word-boundary match so "storage" + "registration" etc. do not
  // false-positive. Only an actual `rag` identifier should match.
  const ragInBinder = /\brag\b/.test(binder);
  const ragInVerifier = /\brag\b/.test(verifier);
  assert.equal(ragInBinder, false,
    'src/binder.js must not yet reference rag (honest scope: receipt-chain integration NOT YET WIRED). ' +
    'If rag.lineage now ships, update this test and the W192 honest-scope note.');
  assert.equal(ragInVerifier, false,
    'src/verifier.js must not yet reference rag (honest scope: no verifier check anchors the rag index hash today). ' +
    'If a verifier check now binds the index, update this test.');
});

test('20. cli/kolm.js dispatch for `rag` uses the `withErrorContext` wrapper', () => {
  const src = readCli();
  // Lock the literal dispatch line so a refactor that drops the wrapper
  // (and therefore loses the `[kolm rag]` error prefix + hint pipeline)
  // trips the test.
  assert.match(src, /case 'rag':\s+await withErrorContext\('rag',\s*\(\)\s*=>\s*cmdRag\(rest\)\);\s*break;/,
    "the rag dispatch case must wrap cmdRag(rest) in withErrorContext('rag', ...) so errors get prefixed and hinted");
});
