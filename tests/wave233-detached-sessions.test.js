// W233 — detached runtime + kolm resume + reptyr-style rescue.
//
// Behavior tests for src/sessions.js. We do NOT spawn a real `kolm compile
// --detach`; we exercise the session lifecycle via the module's public
// surface using a stub argv that resolves quickly. The CLI dispatch is
// asserted by grepping the source for the new verbs (no integration with
// the real CLI process under test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function modUrl(rel) {
  return pathToFileURL(path.join(ROOT, rel)).href;
}

function scratchDir() {
  const dir = path.join(os.tmpdir(), 'kolm-sessions-test-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('W233 src/sessions.js exports the public surface', async () => {
  const m = await import(modUrl('src/sessions.js'));
  for (const name of ['detach', 'resume', 'rescue', 'rescueSupport', 'isAttachableTTY', 'stripDetach']) {
    assert.ok(name in m, `missing export ${name}`);
  }
});

test('W233 stripDetach removes --detach / --background / -d everywhere', async () => {
  const m = await import(modUrl('src/sessions.js'));
  assert.deepEqual(m.stripDetach(['compile', '--detach', 'x']), ['compile', 'x']);
  assert.deepEqual(m.stripDetach(['distill', '--background', '-d']), ['distill']);
  assert.deepEqual(m.stripDetach(['compile', 'task']), ['compile', 'task']);
});

test('W233 rescueSupport returns a record with .supported and .reason', async () => {
  const m = await import(modUrl('src/sessions.js'));
  const r = m.rescueSupport();
  assert.ok(typeof r === 'object' && r !== null);
  assert.ok(typeof r.supported === 'boolean');
  if (!r.supported) assert.ok(typeof r.reason === 'string' && r.reason.length);
});

test('W233 rescue() with bad pid throws', async () => {
  const m = await import(modUrl('src/sessions.js'));
  assert.throws(() => m.rescue({ pid: 0 }), /positive integer/);
  assert.throws(() => m.rescue({ pid: 'abc' }), /positive integer/);
});

test('W233 rescue() returns honest workaround when not supported', async () => {
  const m = await import(modUrl('src/sessions.js'));
  const r = m.rescue({ pid: 1 });
  // On Linux+reptyr the spawnSync runs and we get { ok: true }. Either way
  // the result must be a structured object the CLI can print.
  assert.ok(typeof r === 'object' && r !== null);
  assert.ok('ok' in r);
  if (!r.ok) {
    assert.ok(typeof r.reason === 'string' && r.reason.length);
    assert.ok(typeof r.workaround === 'string' && r.workaround.length);
  }
});

test('W233 resume() throws on unknown session id', async () => {
  const tmp = scratchDir();
  process.env.KOLM_JOBS_FILE = path.join(tmp, 'jobs.jsonl');
  process.env.KOLM_JOB_LOG_DIR = path.join(tmp, 'job-logs');
  const m = await import(modUrl('src/sessions.js'));
  assert.throws(() => m.resume({ id: 'does-not-exist', onChunk: () => {} }), /unknown session/);
  delete process.env.KOLM_JOBS_FILE;
  delete process.env.KOLM_JOB_LOG_DIR;
});

test('W233 CLI wires resume / rescue / sessions verbs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
  for (const verb of ['resume', 'rescue', 'sessions']) {
    // Each verb must appear in the switch and have a per-verb help block.
    assert.ok(src.includes(`case '${verb}':`), `dispatch missing case '${verb}'`);
  }
  assert.ok(src.includes('async function cmdResume'), 'cmdResume not defined');
  assert.ok(src.includes('async function cmdRescue'), 'cmdRescue not defined');
  assert.ok(src.includes('async function cmdSessions'), 'cmdSessions not defined');
});

test('W233 cmdCompile detaches when --detach is passed', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
  const idx = src.indexOf('async function cmdCompile');
  const block = src.slice(idx, idx + 3000);
  assert.ok(block.includes("--detach"), 'cmdCompile must look at --detach');
  assert.ok(block.includes('KOLM_DETACHED'), 'cmdCompile must guard re-detach with KOLM_DETACHED env');
  assert.ok(block.includes("import('../src/sessions.js')"), 'cmdCompile must call sessions.detach');
});

test('W233 cmdDistill detaches when --detach is passed', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
  const idx = src.indexOf('async function cmdDistill(args)');
  const block = src.slice(idx, idx + 1500);
  assert.ok(block.includes('--detach'), 'cmdDistill must look at --detach');
  assert.ok(block.includes('KOLM_DETACHED'), 'cmdDistill must guard re-detach with KOLM_DETACHED env');
});

test('W233 sessions / resume / rescue listed in COMPLETION_VERBS', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
  const idx = src.indexOf('COMPLETION_VERBS');
  const tail = src.slice(idx, idx + 3000);
  for (const v of ['resume', 'rescue', 'sessions']) {
    assert.ok(tail.includes(`'${v}'`), `COMPLETION_VERBS missing '${v}'`);
  }
});
