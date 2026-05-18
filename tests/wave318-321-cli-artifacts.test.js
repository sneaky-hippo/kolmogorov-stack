// Wave 318-321 — kolm whoami --json polish + kolm artifacts {list,show,diff}.
//
// These four waves together close the CLI inspection gap so a script (or a
// human-in-CI) can interrogate the local kolm state + remote artifacts shape
// without parsing free-form table output.
//
// W318 — whoami --json must emit: logged_in, base, cli_version, key_fingerprint,
//        tenant{id,name,plan,quota,seats,email}, _raw. Forward-compat: extra
//        server fields land in _raw and don't leak into the stable tenant block.
// W319 — kolm artifacts list  → hits GET /v1/artifacts and returns rows
// W320 — kolm artifacts show <id> → hits GET /v1/artifacts/:id and returns the row
// W321 — kolm artifacts diff <a> <b> → parallel GETs and field-by-field diff
//
// Tests assert BEHAVIOR (response shape, exit codes, dispatcher wiring) rather
// than copy. The CLI surface is exercised by spawning `node cli/kolm.js …` with
// an in-process Express harness as the cloud base, so the test exercises the
// real fetch path, not a mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'cli', 'kolm.js');

// ---- in-process fake cloud (just enough for /v1/account + /v1/artifacts*) ----

function makeFakeCloud({ account, artifacts }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/v1/account', (req, res) => res.json(account));
  app.get('/v1/artifacts', (req, res) => res.json({ artifacts, n: artifacts.length }));
  app.get('/v1/artifacts/:id', (req, res) => {
    const a = artifacts.find(x => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    res.json(a);
  });
  return app;
}

function startCloud(app) {
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, () => {
      resolve({ srv, port: srv.address().port, close: () => new Promise(r => srv.close(r)) });
    });
  });
}

// Spawn the CLI in a clean HOME so it doesn't pick up a real ~/.kolm/config.
function runCli(args, { base, apiKey } = {}) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-test-'));
    if (apiKey) {
      const cfgDir = path.join(tmp, '.kolm');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ base, api_key: apiKey }));
    }
    const env = {
      ...process.env,
      HOME: tmp,
      USERPROFILE: tmp,
      KOLM_HOME: path.join(tmp, '.kolm'),
      KOLM_BASE: base || '',
    };
    // Strip any inherited key so the fresh config wins.
    delete env.KOLM_API_KEY;
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      resolve({ code, stdout, stderr });
    });
  });
}

// ---------- W318: whoami --json shape ----------

test('W318 #1 — whoami --json emits structured envelope with cli_version + key_fingerprint + tenant', async () => {
  const account = {
    id: 'ten_w318_x',
    name: 'Test Tenant',
    plan: 'pro',
    quota: 100000,
    seats: 5,
    email: 'rod@example.com',
    extra_server_field: 'should land in _raw, not tenant',
  };
  const cloud = await startCloud(makeFakeCloud({ account, artifacts: [] }));
  try {
    const apiKey = 'ks_test_w318_abcdef123456';
    const r = await runCli(['whoami', '--json'], { base: `http://127.0.0.1:${cloud.port}`, apiKey });
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr: ${r.stderr}`);
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.logged_in, true, 'logged_in must be true');
    assert.ok(env.base, 'base must be set');
    assert.ok(env.cli_version, 'cli_version must be set');
    assert.ok(env.key_fingerprint, 'key_fingerprint must be set');
    assert.ok(!env.key_fingerprint.includes('abcdef123456'),
      'fingerprint must NOT include the middle of the key (only prefix+suffix)');
    assert.equal(env.tenant.id, 'ten_w318_x');
    assert.equal(env.tenant.plan, 'pro');
    assert.equal(env.tenant.quota, 100000);
    assert.equal(env.tenant.seats, 5);
    assert.equal(env.tenant.email, 'rod@example.com');
    assert.ok(!env.tenant.extra_server_field, 'tenant block must not contain unknown server fields');
    assert.ok(env._raw, '_raw must echo full server response for forward-compat');
    assert.equal(env._raw.extra_server_field, 'should land in _raw, not tenant');
  } finally {
    await cloud.close();
  }
});

test('W318 #2 — whoami --json without a key emits logged_in:false + hint', async () => {
  const r = await runCli(['whoami', '--json'], { /* no apiKey */ });
  // exits non-zero (MISSING_PREREQ) but still emits valid JSON on stdout.
  assert.notEqual(r.code, 0, 'whoami without a key must exit non-zero');
  const env = JSON.parse(r.stdout.trim());
  assert.equal(env.logged_in, false, 'logged_in must be false');
  assert.equal(env.key_fingerprint, null, 'fingerprint must be null when there is no key');
  assert.ok(env.hint, 'hint must point users at kolm login / signup');
});

// ---------- W319: kolm artifacts list ----------

test('W319 #1 — artifacts list --json emits {artifacts,n,total} shape', async () => {
  const artifacts = [
    { id: 'art_a', recipe_class: 'recipe', created_at: '2026-05-01T00:00:00Z', k_score: 0.91 },
    { id: 'art_b', recipe_class: 'specialist', created_at: '2026-05-02T00:00:00Z', k_score: 0.95 },
  ];
  const cloud = await startCloud(makeFakeCloud({ account: {}, artifacts }));
  try {
    const r = await runCli(['artifacts', 'list', '--json'], {
      base: `http://127.0.0.1:${cloud.port}`,
      apiKey: 'ks_test_w319_zzz',
    });
    assert.equal(r.code, 0, `expected 0, got ${r.code}. stderr: ${r.stderr}`);
    const env = JSON.parse(r.stdout.trim());
    assert.ok(Array.isArray(env.artifacts), 'artifacts must be an array');
    assert.equal(env.artifacts.length, 2);
    assert.equal(env.n, 2);
    assert.equal(env.total, 2);
    assert.equal(env.artifacts[0].id, 'art_a');
  } finally {
    await cloud.close();
  }
});

test('W319 #2 — artifacts list with no key exits MISSING_PREREQ', async () => {
  const r = await runCli(['artifacts', 'list', '--json'], { /* no key */ });
  assert.notEqual(r.code, 0, 'must exit non-zero with no key');
  const env = JSON.parse(r.stdout.trim());
  assert.equal(env.error, 'not_logged_in');
});

// ---------- W320: kolm artifacts show <id> ----------

test('W320 #1 — artifacts show <id> --json returns the full artifact record', async () => {
  const artifacts = [
    {
      id: 'art_show_x',
      recipe_class: 'recipe',
      created_at: '2026-05-18T00:00:00Z',
      status: 'completed',
      base_model: 'qwen-3.5-27b',
      k_score: 0.88,
      k_score_composite: 0.91,
      size_bytes: 12345,
      cid: 'bafy123',
    },
  ];
  const cloud = await startCloud(makeFakeCloud({ account: {}, artifacts }));
  try {
    const r = await runCli(['artifacts', 'show', 'art_show_x', '--json'], {
      base: `http://127.0.0.1:${cloud.port}`,
      apiKey: 'ks_test_w320_zzz',
    });
    assert.equal(r.code, 0);
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.id, 'art_show_x');
    assert.equal(env.recipe_class, 'recipe');
    assert.equal(env.base_model, 'qwen-3.5-27b');
    assert.equal(env.k_score, 0.88);
    assert.equal(env.k_score_composite, 0.91);
  } finally {
    await cloud.close();
  }
});

test('W320 #2 — artifacts show without an id exits USAGE', async () => {
  const r = await runCli(['artifacts', 'show', '--json'], {
    base: 'http://127.0.0.1:1',
    apiKey: 'ks_test_w320_zzz2',
  });
  assert.notEqual(r.code, 0, 'show with no id must fail');
});

// ---------- W321: kolm artifacts diff <a> <b> ----------

test('W321 #1 — artifacts diff emits {a_id,b_id,differences,same_count,diff_count}', async () => {
  const artifacts = [
    { id: 'art_left',  recipe_class: 'recipe',     base_model: 'qwen-3.5-27b',  k_score: 0.85, status: 'completed' },
    { id: 'art_right', recipe_class: 'specialist', base_model: 'qwen-3.5-27b',  k_score: 0.92, status: 'completed' },
  ];
  const cloud = await startCloud(makeFakeCloud({ account: {}, artifacts }));
  try {
    const r = await runCli(['artifacts', 'diff', 'art_left', 'art_right', '--json'], {
      base: `http://127.0.0.1:${cloud.port}`,
      apiKey: 'ks_test_w321_zzz',
    });
    assert.equal(r.code, 0, `expected 0, got ${r.code}. stderr: ${r.stderr}`);
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.a_id, 'art_left');
    assert.equal(env.b_id, 'art_right');
    assert.ok(Array.isArray(env.differences));
    // base_model is the same → not in differences. recipe_class + k_score differ → in differences.
    const fields = env.differences.map(d => d.field);
    assert.ok(fields.includes('recipe_class'), 'recipe_class diff must surface');
    assert.ok(fields.includes('k_score'), 'k_score diff must surface');
    assert.ok(!fields.includes('base_model'), 'identical base_model must not surface as diff');
    assert.ok(env.diff_count > 0);
    assert.ok(env.same_count > 0);
  } finally {
    await cloud.close();
  }
});

test('W321 #2 — artifacts diff with one missing side exits non-zero', async () => {
  const artifacts = [{ id: 'art_exists', recipe_class: 'recipe', status: 'completed' }];
  const cloud = await startCloud(makeFakeCloud({ account: {}, artifacts }));
  try {
    const r = await runCli(['artifacts', 'diff', 'art_exists', 'art_missing', '--json'], {
      base: `http://127.0.0.1:${cloud.port}`,
      apiKey: 'ks_test_w321_miss',
    });
    assert.notEqual(r.code, 0, 'diff with missing side must fail');
  } finally {
    await cloud.close();
  }
});

// ---------- W319-W321 wiring: dispatcher + HELP + completion ----------

test('W318-321 #wire — cli/kolm.js registers artifacts in both dispatchers + HELP + completion', () => {
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Main switch dispatcher
  assert.match(cli, /case 'artifacts':\s*await withErrorContext\('artifacts',\s*\(\)\s*=>\s*cmdArtifacts/,
    'main switch must register artifacts');
  // REPL dispatcher
  assert.match(cli, /case 'artifacts':\s*return withErrorContext\('artifacts',\s*\(\)\s*=>\s*cmdArtifacts/,
    'dispatchRepl must register artifacts');
  // HELP block
  assert.match(cli, /artifacts:\s*`kolm artifacts/, 'HELP must include an "artifacts" entry');
  // Completion
  assert.match(cli, /'whoami',\s*'artifacts'/, 'COMPLETION_VERBS must include "artifacts"');
  assert.match(cli, /artifacts:\s*\[\s*'list'/, 'COMPLETION_SUBS must include artifacts sub-verbs');
});
