// Wave 352 - kolm do / what / next / explain / fix CLI verbs.
//
// End-to-end spawn-the-CLI assertions. Each spawn uses a clean HOME so we
// don't pick up the developer's real config / artifacts / captures. The
// fast-path verbs (do --dry-run, what, next) are pure local-state reads --
// no network. We do NOT spawn cmdInteractive because it requires a TTY.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'cli', 'kolm.js');

function runCli(args, { home: presetHome, env: extra } = {}) {
  return new Promise((resolve) => {
    const tmp = presetHome || fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w352-'));
    const env = {
      ...process.env,
      HOME: tmp,
      USERPROFILE: tmp,
      // KOLM_HOME is the homedir-equivalent (parent of .kolm/), NOT the .kolm
      // subdir itself. snapshotContext does path.join(HOME, '.kolm') internally.
      KOLM_HOME: tmp,
      KOLM_NO_INTERACTIVE: '1',
      ...(extra || {}),
    };
    delete env.KOLM_API_KEY;
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (!presetHome) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      }
      resolve({ code, stdout, stderr });
    });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + (e && e.stack || String(e)) }));
  });
}

function firstJson(out) {
  const open = out.indexOf('{');
  if (open < 0) throw new Error('no JSON object found in output:\n' + out.slice(0, 600));
  return JSON.parse(out.slice(open));
}

// -----------------------------------------------------------------------------
// kolm do
// -----------------------------------------------------------------------------

test('W352 #1 - kolm do --dry-run --json "list my models" classifies to verb=models', async () => {
  const r = await runCli(['do', '--dry-run', '--json', 'list my models']);
  assert.equal(r.code, 0, `non-zero exit. stderr=${r.stderr.slice(0, 400)} stdout=${r.stdout.slice(0, 400)}`);
  const env = firstJson(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.ran, false, '--dry-run must not execute');
  assert.ok(env.intent, 'intent envelope present');
  assert.equal(env.intent.verb, 'models', `got verb=${env.intent.verb}`);
  assert.ok(typeof env.intent.confidence === 'number');
  assert.ok(env.intent.confidence >= 0.7, `confidence ${env.intent.confidence} should be high for direct phrasing`);
});

test('W352 #2 - kolm do --dry-run --json "show me captures" -> verb=tail args contain captures', async () => {
  const r = await runCli(['do', '--dry-run', '--json', 'show me captures']);
  assert.equal(r.code, 0);
  const env = firstJson(r.stdout);
  assert.equal(env.intent.verb, 'tail');
  assert.ok(env.intent.args.includes('captures'));
});

test('W352 #3 - kolm do --dry-run "compile foo.spec.json" -> verb=compile + --spec arg', async () => {
  const r = await runCli(['do', '--dry-run', '--json', 'compile foo.spec.json']);
  assert.equal(r.code, 0);
  const env = firstJson(r.stdout);
  assert.equal(env.intent.verb, 'compile');
  assert.ok(env.intent.args.includes('--spec'));
  assert.ok(env.intent.args.includes('foo.spec.json'));
});

test('W352 #4 - kolm do with no positional emits JSON error envelope on --json', async () => {
  const r = await runCli(['do', '--json']);
  assert.notEqual(r.code, 0, 'must exit non-zero with no input');
  const env = firstJson(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'KOLM_E_DO_NO_INPUT');
  assert.equal(env.exit, 1);
  assert.ok(Array.isArray(env.next));
  assert.ok(env.next.length >= 1);
});

test('W352 #5 - kolm do --dry-run non-JSON output is human-readable', async () => {
  const r = await runCli(['do', '--dry-run', 'show captures']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /would run: kolm tail/);
  assert.match(r.stdout, /confidence:/);
});

// -----------------------------------------------------------------------------
// kolm what
// -----------------------------------------------------------------------------

test('W352 #6 - kolm what --json on empty HOME returns 0 counts + structured envelope', async () => {
  const r = await runCli(['what', '--json']);
  assert.equal(r.code, 0, `non-zero exit. stderr=${r.stderr.slice(0, 400)}`);
  const env = firstJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(Array.isArray(env.artifacts));
  assert.ok(Array.isArray(env.captures));
  assert.ok(Array.isArray(env.jobs));
  assert.ok(env.counts && typeof env.counts.artifacts === 'number');
  assert.ok(Array.isArray(env.recommendations));
  assert.ok(env.recommendations.length >= 1, 'at least one recommendation must surface (e.g. login)');
  assert.equal(typeof env.generated_at, 'string');
});

test('W352 #7 - kolm what human-mode prints a snapshot header + the next section', async () => {
  const r = await runCli(['what']);
  assert.equal(r.code, 0, `stderr=${r.stderr.slice(0, 400)}`);
  assert.match(r.stdout, /snapshot/);
  assert.match(r.stdout, /artifacts:\s+\d+/);
  assert.match(r.stdout, /captures:\s+\d+/);
  assert.match(r.stdout, /jobs:\s+\d+/);
  assert.match(r.stdout, /next/);
});

test('W352 #8 - kolm what --json reflects jobs.jsonl when present', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w352-h-'));
  try {
    fs.mkdirSync(path.join(tmp, '.kolm'), { recursive: true });
    const jobs = [
      JSON.stringify({ id: 'j1', kind: 'compile', status: 'running', started_at: new Date().toISOString() }),
      JSON.stringify({ id: 'j2', kind: 'distill', status: 'done', started_at: new Date().toISOString() }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(tmp, '.kolm', 'jobs.jsonl'), jobs);
    const r = await runCli(['what', '--json'], { home: tmp });
    assert.equal(r.code, 0);
    const env = firstJson(r.stdout);
    assert.ok(env.counts.jobs >= 2, `expected jobs.jsonl rows to count, got ${env.counts.jobs}`);
    assert.ok(env.jobs.some(j => j.id === 'j1'));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

// -----------------------------------------------------------------------------
// kolm next
// -----------------------------------------------------------------------------

test('W352 #9 - kolm next --json returns 1-3 ranked recommendations', async () => {
  const r = await runCli(['next', '--json']);
  assert.equal(r.code, 0);
  const env = firstJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(Array.isArray(env.recommendations));
  assert.ok(env.recommendations.length >= 1 && env.recommendations.length <= 3,
    `1-3 recs expected, got ${env.recommendations.length}`);
  for (const r of env.recommendations) {
    assert.equal(typeof r.action, 'string');
    assert.equal(typeof r.command, 'string');
    assert.equal(typeof r.why, 'string');
    assert.equal(typeof r.rank, 'number');
  }
  // Must be ordered by rank desc.
  const ranks = env.recommendations.map(r => r.rank);
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i - 1] >= ranks[i], `recs must be sorted by rank desc, got ${ranks.join(',')}`);
  }
});

test('W352 #10 - kolm next human-mode prints copy-pasteable commands', async () => {
  const r = await runCli(['next']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\$ kolm /);
});

// -----------------------------------------------------------------------------
// kolm explain
// -----------------------------------------------------------------------------

test('W352 #11 - kolm explain with missing artifact emits NOT_FOUND envelope', async () => {
  const r = await runCli(['explain', '--json', 'no-such.kolm']);
  assert.notEqual(r.code, 0);
  const env = firstJson(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'KOLM_E_ARTIFACT_NOT_FOUND');
  assert.equal(env.exit, 5);
});

// -----------------------------------------------------------------------------
// kolm fix
// -----------------------------------------------------------------------------

test('W352 #12 - kolm fix with missing artifact emits NOT_FOUND envelope', async () => {
  const r = await runCli(['fix', '--json', 'no-such.kolm']);
  assert.notEqual(r.code, 0);
  const env = firstJson(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'KOLM_E_ARTIFACT_NOT_FOUND');
  assert.equal(env.exit, 5);
});

// -----------------------------------------------------------------------------
// Dispatcher wiring + help
// -----------------------------------------------------------------------------

test('W352 #13 - kolm do --help prints the do help body (not the global help)', async () => {
  const r = await runCli(['do', '--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /kolm do - natural-language intent dispatcher/);
});

test('W352 #14 - kolm what --help, kolm next --help, kolm explain --help, kolm fix --help all return per-verb help', async () => {
  const out1 = await runCli(['what', '--help']);
  const out2 = await runCli(['next', '--help']);
  const out3 = await runCli(['explain', '--help']);
  const out4 = await runCli(['fix', '--help']);
  assert.equal(out1.code, 0);
  assert.equal(out2.code, 0);
  assert.equal(out3.code, 0);
  assert.equal(out4.code, 0);
  assert.match(out1.stdout, /kolm what -/);
  assert.match(out2.stdout, /kolm next -/);
  assert.match(out3.stdout, /kolm explain/);
  assert.match(out4.stdout, /kolm fix/);
});

test('W352 #15 - kolm --help mentions the new natural-language verbs in COMMANDS', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  // Must surface all five new verbs in the top-level help so a user can
  // discover them without leaving the CLI.
  for (const v of ['do', 'what', 'next', 'explain', 'fix']) {
    assert.match(r.stdout, new RegExp(`\\b${v}\\b`),
      `top-level help must mention '${v}'`);
  }
});
