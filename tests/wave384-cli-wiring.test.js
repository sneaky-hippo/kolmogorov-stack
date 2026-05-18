// Wave 384 — CLI consolidator behavior tests.
//
// Asserts that the 8 new top-level verbs (privacy / sync / team / pipeline /
// install / wrap / shell-init / agents) are wired into the dispatch table,
// the HELP block, the COMPLETION lists, and that each verb honors the
// canonical --json envelope shape {ok:true, data} or {ok:false, error, code}.
//
// Plus invariants on the cmdTui 14-view extension that lives alongside the
// W222 alt-screen TUI body (the view registry + new key bindings must exist).
//
// Tests assert BEHAVIOR (spawnSync the CLI in a clean HOME / KOLM_DATA_DIR,
// or source-grep where behavior is structural). Per the Pablo W202-W210
// correction, NO page-text marker assertions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'cli', 'kolm.js');
const KOLM_JS = fs.readFileSync(CLI_PATH, 'utf8');

// Spawn the CLI with HOME + USERPROFILE + KOLM_DATA_DIR redirected to a
// fresh tmp dir so a real ~/.kolm config never leaks into the test. Strip
// KOLM_API_KEY from the inherited env so the fresh config wins.
function runCli(args, { extraEnv } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w384-'));
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    ...(extraEnv || {}),
  };
  delete env.KOLM_API_KEY;
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    env, encoding: 'utf8', timeout: 30000,
  });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal };
}

// Parse the first non-empty JSON line on stdout (the W384 jsonOk/jsonErr
// helpers write a single line per call so we can tolerate startup banners
// or experimental-feature warnings on stderr).
function parseJson(out) {
  const line = (out || '').split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith('{'));
  if (!line) throw new Error('no JSON line in stdout: ' + JSON.stringify(out).slice(0, 200));
  return JSON.parse(line);
}

// =============================================================================
// COMPLETION + HELP + dispatch wiring (source-grep).
// =============================================================================

test('W384 #1 — COMPLETION_VERBS contains privacy / pipeline / agents / shell-init', () => {
  // The 8 new verbs (4 wholly new, 4 extensions of existing) must round-trip
  // through tab-completion. The extension verbs (sync / team / install / wrap)
  // were already in the list; here we just lock in the 4 net-new entries.
  for (const v of ['privacy', 'pipeline', 'agents', 'shell-init']) {
    assert.match(KOLM_JS, new RegExp(`'${v}'`), `COMPLETION_VERBS must list ${v}`);
  }
});

test('W384 #2 — COMPLETION_SUBS lists subverbs for the 4 new verbs', () => {
  const r = runCli(['completion', 'bash']);
  assert.equal(r.code, 0, `kolm completion bash exit code 0 expected, got ${r.code}: ${r.stderr}`);
  // privacy / pipeline / agents subverbs round-trip through the bash completion
  // emitter (which is the COMPLETION_SUBS table's only public surface).
  for (const s of ['scan', 'test', 'policy', 'report']) {
    assert.ok(r.stdout.includes(s), `privacy completion must include ${s}`);
  }
  for (const s of ['tokenize', 'distill', 'compile', 'full']) {
    assert.ok(r.stdout.includes(s), `pipeline completion must include ${s}`);
  }
  for (const s of ['stats', 'sessions', 'recommend', 'failing']) {
    assert.ok(r.stdout.includes(s), `agents completion must include ${s}`);
  }
});

test('W384 #3 — COMPLETION_SUBS extends sync with status/enable/disable', () => {
  const r = runCli(['completion', 'bash']);
  assert.equal(r.code, 0);
  // The bash emitter merges all sync subverbs onto one line; look for the
  // full list (status / enable / disable / push / pull).
  for (const s of ['status', 'enable', 'disable', 'push', 'pull']) {
    assert.ok(r.stdout.includes(s), `sync completion must include ${s}`);
  }
});

test('W384 #4 — dispatch table routes privacy / pipeline / agents / shell-init', () => {
  // Source-grep on the _dispatchVerb table to confirm the 4 verbs are wired.
  assert.match(KOLM_JS, /privacy:\s*cmdPrivacy/);
  assert.match(KOLM_JS, /pipeline:\s*cmdPipeline/);
  assert.match(KOLM_JS, /agents:\s*cmdAgents/);
  assert.match(KOLM_JS, /'shell-init':\s*cmdShellInit/);
});

test("W384 #5 — main() switch routes privacy / pipeline / agents / shell-init", () => {
  // main() has an explicit case-per-verb structure separate from the dispatch
  // table; tests/wave222-tui-altscreen.test.js asserts this pattern for tui.
  for (const v of ['privacy', 'pipeline', 'agents', 'shell-init']) {
    const re = new RegExp(`case '${v}':\\s*await withErrorContext\\('${v}'`, 'i');
    assert.match(KOLM_JS, re, `main() must route case '${v}'`);
  }
});

test('W384 #6 — HELP._root mentions the 8 W384 verbs', () => {
  // The help block is the user-facing surface for verb discovery. Even though
  // the extension verbs (sync / team / install / wrap) were already there,
  // their HELP lines must reflect the new W384 subverbs.
  for (const v of ['privacy', 'pipeline', 'agents', 'shell-init']) {
    assert.ok(KOLM_JS.includes(`  ${v}`), `HELP._root must list ${v}`);
  }
  // Tag W384 should appear in the HELP block so a `kolm help | grep W384`
  // surfaces the new verbs at a glance.
  assert.ok((KOLM_JS.match(/\[W384\]/g) || []).length >= 4,
    'HELP._root must tag W384 lines');
});

// =============================================================================
// privacy {scan,test,policy,report}
// =============================================================================

test('W384 #7 — kolm privacy test --json returns smoke-test envelope', () => {
  const r = runCli(['privacy', 'test', '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(env.data, 'env.data required');
  assert.ok(env.data.detector_version, 'detector_version required');
  assert.ok(env.data.results, 'results required');
  // Each fixture sample must surface at least one match.
  for (const cls of ['ssn', 'email', 'phone', 'api_key']) {
    assert.ok(env.data.results[cls], `result for ${cls} required`);
    assert.equal(env.data.results[cls].matched, true, `${cls} must match its sample`);
  }
});

test('W384 #8 — kolm privacy scan --json returns detector envelope', () => {
  const r = runCli(['privacy', 'scan', 'contact rod@example.com or 415-555-1212', '--json']);
  assert.equal(r.code, 0);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(env.data, 'env.data required');
  assert.ok(env.data.detector_version);
  assert.ok(Array.isArray(env.data.matches), 'matches must be an array');
  // Email + phone should surface in matches.
  const classes = env.data.matches.map(m => m.class);
  assert.ok(classes.includes('email'), 'email should match');
});

test('W384 #9 — kolm privacy policy --json lists all classes', () => {
  const r = runCli(['privacy', 'policy', '--json']);
  assert.equal(r.code, 0);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(env.data.policy, 'policy map required');
  assert.ok(Array.isArray(env.data.classes), 'classes array required');
  assert.ok(env.data.classes.length >= 10, 'must list >= 10 privacy classes');
});

test('W384 #10 — kolm privacy report --json returns counts', () => {
  const r = runCli(['privacy', 'report', '--json']);
  assert.equal(r.code, 0);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(env.data.counts, 'counts required');
  assert.ok(typeof env.data.total_classes === 'number');
});

// =============================================================================
// sync {status,enable,disable,push,pull}
// =============================================================================

test('W384 #11 — kolm sync status --json returns cloud-sync state', () => {
  const r = runCli(['sync', 'status', '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(env.data.state, 'state required');
  assert.ok('cloud_base' in env.data, 'cloud_base key required');
  assert.ok('namespace' in env.data, 'namespace key required');
});

test('W384 #12 — kolm sync enable --json --state metadata_only writes state', () => {
  const r = runCli(['sync', 'enable', '--state', 'metadata_only', '--namespace', 'w384-test', '--json']);
  assert.equal(r.code, 0);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.state, 'metadata_only');
  assert.equal(env.data.namespace, 'w384-test');
});

// =============================================================================
// team {members,invite,role,approve,reject,namespace}
// =============================================================================

test('W384 #13 — kolm team members --json returns default workspace member list', () => {
  const r = runCli(['team', 'members', '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(Array.isArray(env.data.members));
  // Default workspace auto-creates one admin member.
  assert.ok(env.data.members.length >= 1, 'default workspace must have >= 1 admin member');
  assert.equal(env.data.members[0].role, 'admin');
});

test('W384 #14 — kolm team invite --json --role reviewer returns invite envelope', () => {
  const r = runCli(['team', 'invite', 'alice@kolm.test', '--role', 'reviewer', '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(env.data.member_id, 'member_id required');
  assert.ok(env.data.invite_token || env.data.invite_url, 'invite_token or invite_url required');
});

// =============================================================================
// pipeline {tokenize,distill,compile,full}
// =============================================================================

test('W384 #15 — kolm pipeline (no sub) --json returns bad_args envelope', () => {
  const r = runCli(['pipeline', '--json']);
  // bad_args is exit 1 (BAD_ARGS) — process.exit(EXIT.BAD_ARGS) in cmdPipeline.
  assert.notEqual(r.code, 0);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'bad_args');
  assert.match(env.error, /tokenize|distill|compile|full/);
});

test('W384 #16 — kolm pipeline tokenize <inline> --json returns tokenizer envelope', () => {
  const r = runCli(['pipeline', 'tokenize', 'the quick brown fox jumps over the lazy dog', '--vocab-size', '64', '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(env.data.tokenizer_path, 'tokenizer_path required');
  assert.ok(env.data.algorithm, 'algorithm required');
  assert.ok(typeof env.data.vocab_size === 'number');
});

// =============================================================================
// install <agent-id> (dev-agent path)
// =============================================================================

test('W384 #17 — kolm install codex --dry-run --json returns install envelope', () => {
  const r = runCli(['install', 'codex', '--dry-run', '--json']);
  // Dry-run should not require the proxy to be live.
  const env = parseJson(r.stdout);
  // Either the install module reports ok with dry-run details, or it reports
  // a missing-prereq error — both should round-trip through the W384 envelope.
  assert.ok(env.ok === true || (env.ok === false && env.code),
    `envelope shape required, got: ${JSON.stringify(env)}`);
});

// =============================================================================
// wrap <agent-cmd> (env-injecting spawn)
// =============================================================================

test('W384 #18 — kolm wrap <agent-cmd> --dry-run --json returns spawn summary', () => {
  // node is guaranteed to be on PATH because we just spawned it; using a
  // platform-agnostic dummy command means the test runs on Windows + Unix.
  const r = runCli(['wrap', 'node', '--version', '--dry-run', '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.cmd, 'node');
  assert.ok(Array.isArray(env.data.args));
  assert.ok(env.data.env, 'env block required');
  // KOLM_BASE must be in the injected env block.
  assert.ok('KOLM_BASE' in env.data.env, 'KOLM_BASE must be injected');
});

// =============================================================================
// shell-init
// =============================================================================

test('W384 #19 — kolm shell-init --shell bash emits export snippet to stdout', () => {
  const r = runCli(['shell-init', '--shell', 'bash']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  // bash form: `export NAME=value`.
  assert.match(r.stdout, /^export\s+\w+=/m, 'must emit at least one export NAME=value line');
});

test('W384 #20 — kolm shell-init --json wraps snippet in envelope', () => {
  const r = runCli(['shell-init', '--shell', 'bash', '--json']);
  assert.equal(r.code, 0);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(env.data.snippet, 'snippet required');
  assert.equal(env.data.shell, 'bash');
});

// =============================================================================
// agents {stats,sessions,recommend,failing}
// =============================================================================

test('W384 #21 — kolm agents stats --json returns telemetry envelope', () => {
  const r = runCli(['agents', 'stats', '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(typeof env.data.total_agent_calls === 'number');
  assert.ok(typeof env.data.total_sessions === 'number');
  assert.ok(env.data.by_app);
});

test('W384 #22 — kolm agents sessions --limit 5 --json returns list envelope', () => {
  const r = runCli(['agents', 'sessions', '--limit', '5', '--json']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(Array.isArray(env.data.sessions));
  assert.ok(typeof env.data.count === 'number');
});

// =============================================================================
// cmdTui 14-view extension — source-grep on the registry + key bindings.
// =============================================================================

test('W384 #23 — cmdTui declares a 14-view registry (TUI_VIEWS)', () => {
  // The W384 plan adds 14 views to the alt-screen TUI. Each row registers
  // an id + a key binding + a backing endpoint. Tests assert the registry
  // exists and lists each of the 14 canonical view ids.
  const idx = KOLM_JS.indexOf('async function cmdTui(args)');
  assert.ok(idx > 0, 'cmdTui must exist');
  const NEXT_FN = KOLM_JS.indexOf('\nasync function ', idx + 1);
  const body = NEXT_FN > idx ? KOLM_JS.slice(idx, NEXT_FN) : KOLM_JS.slice(idx);
  assert.match(body, /TUI_VIEWS/, 'TUI_VIEWS registry required');
  // The 14 views — each id must appear as a string literal in the registry.
  const ids = [
    'live-calls', 'spend', 'privacy-events', 'repeated-workflows', 'opportunities',
    'labeling-queue', 'datasets', 'simulations', 'bakeoffs', 'builds',
    'artifacts', 'devices', 'storage-sync', 'agent-telemetry',
  ];
  for (const id of ids) {
    assert.ok(body.includes(`'${id}'`), `TUI registry must list view '${id}'`);
  }
});

test('W384 #24 — cmdTui binds keys 4-9, 0, A-D to switch views', () => {
  const idx = KOLM_JS.indexOf('async function cmdTui(args)');
  const NEXT_FN = KOLM_JS.indexOf('\nasync function ', idx + 1);
  const body = NEXT_FN > idx ? KOLM_JS.slice(idx, NEXT_FN) : KOLM_JS.slice(idx);
  // The W384 view-switch dispatcher must be present.
  assert.match(body, /viewByKey/, 'cmdTui must define a viewByKey lookup');
  // Each view binds via the TUI_VIEWS entry — its key column lists 4-9, 0, A-D.
  for (const k of ['4', '5', '6', '7', '8', '9', '0', 'A', 'B', 'C', 'D']) {
    assert.ok(body.includes(`key: '${k}'`), `TUI_VIEWS must bind key '${k}'`);
  }
});

test('W384 #25 — cmdTui non-TTY environments degrade gracefully (still hold)', () => {
  // The W222 #12 non-TTY guard must still trigger after the 14-view edit.
  const r = spawnSync(process.execPath, [CLI_PATH, 'tui'], {
    cwd: ROOT, encoding: 'utf8', timeout: 5000, input: '',
  });
  assert.notEqual(r.status, null, 'process must exit (not hang) when stdin/stdout are pipes');
  assert.ok(/requires a TTY/i.test(r.stderr || ''),
    'must print the TTY-required hint on stderr');
});

// =============================================================================
// Envelope shape lock-in — every W384 verb must respond to --json with a
// single-line JSON envelope (parseJson() on the first { line succeeds).
// =============================================================================

test('W384 #26 — every W384 verb honors the {ok,data|error} envelope shape', () => {
  // Quick round-trip across each new verb's --json with the minimum args so
  // we know the envelope helpers (jsonOk / jsonErr) actually wrap every
  // branch and don't accidentally drop into a console.log fallback.
  const probes = [
    ['privacy', 'test'],
    ['sync', 'status'],
    ['team', 'members'],
    ['pipeline'],
    ['agents', 'stats'],
    ['shell-init'],
  ];
  for (const argv of probes) {
    const r = runCli([...argv, '--json']);
    let env;
    try { env = parseJson(r.stdout); }
    catch (e) {
      throw new Error(`verb ${argv.join(' ')} did not produce a JSON envelope: ${e.message}; stdout=${JSON.stringify(r.stdout).slice(0, 200)}`);
    }
    assert.ok(typeof env.ok === 'boolean', `${argv.join(' ')} envelope must have .ok boolean`);
    if (env.ok) assert.ok(env.data != null, `${argv.join(' ')} ok envelope must have .data`);
    else assert.ok(env.error, `${argv.join(' ')} error envelope must have .error`);
  }
});
