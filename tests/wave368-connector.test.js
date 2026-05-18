// W368 — connector daemon end-to-end tests.
//
// Boots a tiny mock-upstream express app, points the daemon at it via
// KOLM_UPSTREAM_OPENAI_BASE / KOLM_UPSTREAM_ANTHROPIC_BASE, starts the daemon
// on a random port, makes real POST /v1/chat/completions and POST /v1/messages
// calls, asserts:
//   - response shape matches OpenAI/Anthropic
//   - x-kolm-event-id header is set
//   - event was actually written to the capture store
//   - canonical event fields are populated
//   - privacy membrane is invoked (sk-key detected in the prompt)
//   - GET /v1/health returns the expected JSON
//   - `kolm connect doctor` exits gracefully when no env keys set
//
// Behavior-only — no page text assertions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KOLM_CLI = path.resolve(__dirname, '..', 'cli', 'kolm.js');

function isolatedHome() {
  const dir = path.join(os.tmpdir(), 'kolm-w368-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

// Promise wrapper around http.request — no fetch (W305 Windows libuv crash).
function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const hdr = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers };
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST', headers: hdr,
    }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let json; try { json = JSON.parse(buf); } catch (_) { json = { _raw: buf }; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.setTimeout(8000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'GET' }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let json; try { json = JSON.parse(buf); } catch (_) { json = { _raw: buf }; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.setTimeout(8000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.on('error', reject);
    req.end();
  });
}

// Spin up a fake OpenAI/Anthropic upstream on a random port.
function spinMockUpstream() {
  const app = express();
  app.use(express.json());
  app.post('/v1/chat/completions', (req, res) => {
    const m = (req.body && req.body.messages && req.body.messages[0] && req.body.messages[0].content) || '';
    res.json({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: req.body.model || 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK (saw: ' + String(m).slice(0, 32) + ')' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  });
  app.post('/v1/messages', (req, res) => {
    res.json({
      id: 'msg_mock', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'OK' }],
      model: req.body.model || 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 1 },
    });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

async function startTestDaemon(env = {}) {
  // Set env vars before importing — daemon-connector resolves PROVIDERS at module load.
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  // Force re-import to pick up the env (cache-bust on daemon-connector only).
  const url = pathToFileURLOnce('../src/daemon-connector.js');
  const mod = await import(url);
  // Import provider-registry WITHOUT cache-bust so we get the SAME instance
  // that daemon-connector imported (Node strips query strings when resolving
  // relative child imports). Mutating PROVIDERS here also mutates what the
  // daemon sees.
  const PRpath = 'file://' + path.resolve(__dirname, '../src/provider-registry.js').replace(/\\/g, '/');
  const PRmod = await import(PRpath);
  if (env.KOLM_UPSTREAM_OPENAI_BASE) PRmod.PROVIDERS.openai.upstream = env.KOLM_UPSTREAM_OPENAI_BASE;
  if (env.KOLM_UPSTREAM_ANTHROPIC_BASE) PRmod.PROVIDERS.anthropic.upstream = env.KOLM_UPSTREAM_ANTHROPIC_BASE;
  const { server, port, pid } = await mod.startDaemon({ port: 0, host: '127.0.0.1' });
  return { server, port, pid, base: 'http://127.0.0.1:' + port, prev, mod };
}

let _urlCounter = 0;
function pathToFileURLOnce(rel) {
  // Cache-bust query so each test gets a fresh module instance and we can
  // mutate the PROVIDERS table per-test without bleed.
  const abs = path.resolve(__dirname, rel);
  _urlCounter += 1;
  return 'file://' + abs.replace(/\\/g, '/') + '?w368=' + _urlCounter;
}

test('W368 #1 — daemon starts on random port and /v1/health returns JSON', async () => {
  const HOME = isolatedHome();
  const prev = process.env.HOME;
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({
      KOLM_UPSTREAM_OPENAI_BASE: up.base,
      KOLM_UPSTREAM_ANTHROPIC_BASE: up.base,
    });
    try {
      const h = await getJson(t.base + '/v1/health');
      assert.equal(h.status, 200);
      assert.equal(h.body.ok, true);
      assert.equal(typeof h.body.version, 'string');
      assert.equal(typeof h.body.uptime_s, 'number');
      assert.equal(typeof h.body.captured_events, 'number');
      assert.ok(h.body.providers && h.body.providers.openai);
      assert.equal(h.body.providers.openai.env_key_name, 'OPENAI_API_KEY');
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    process.env.HOME = prev || ''; process.env.USERPROFILE = prev || '';
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W368 #2 — POST /v1/chat/completions forwards + returns OpenAI shape + x-kolm-event-id', async () => {
  const HOME = isolatedHome();
  const prev = { HOME: process.env.HOME, KEY: process.env.OPENAI_API_KEY };
  process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.OPENAI_API_KEY = 'sk-test-fake';
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({
      KOLM_UPSTREAM_OPENAI_BASE: up.base,
      KOLM_UPSTREAM_ANTHROPIC_BASE: up.base,
    });
    try {
      const r = await postJson(t.base + '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello world' }],
        max_tokens: 4,
      });
      assert.equal(r.status, 200, 'expected 200, got ' + r.status + ' ' + JSON.stringify(r.body));
      assert.ok(r.body.choices && r.body.choices.length > 0, 'missing choices');
      assert.equal(r.body.choices[0].message.role, 'assistant');
      assert.ok(r.headers['x-kolm-event-id'], 'missing x-kolm-event-id header');
      assert.match(r.headers['x-kolm-event-id'], /^evt_/);
      assert.equal(r.headers['x-kolm-provider'], 'openai');
      assert.equal(r.headers['x-kolm-model'], 'gpt-4o-mini');
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    process.env.HOME = prev.HOME || ''; process.env.USERPROFILE = prev.HOME || '';
    if (prev.KEY) process.env.OPENAI_API_KEY = prev.KEY; else delete process.env.OPENAI_API_KEY;
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W368 #3 — POST /v1/messages forwards + returns Anthropic shape', async () => {
  const HOME = isolatedHome();
  const prev = { HOME: process.env.HOME, KEY: process.env.ANTHROPIC_API_KEY };
  process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake';
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({
      KOLM_UPSTREAM_OPENAI_BASE: up.base,
      KOLM_UPSTREAM_ANTHROPIC_BASE: up.base,
    });
    try {
      const r = await postJson(t.base + '/v1/messages', {
        model: 'claude-haiku-4-5',
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ping' }],
      }, { 'anthropic-version': '2023-06-01' });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.content), 'expected anthropic-shape content array');
      assert.equal(r.body.content[0].type, 'text');
      assert.equal(r.body.role, 'assistant');
      assert.ok(r.headers['x-kolm-event-id'], 'missing x-kolm-event-id header');
      assert.equal(r.headers['x-kolm-provider'], 'anthropic');
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    process.env.HOME = prev.HOME || ''; process.env.USERPROFILE = prev.HOME || '';
    if (prev.KEY) process.env.ANTHROPIC_API_KEY = prev.KEY; else delete process.env.ANTHROPIC_API_KEY;
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W368 #4 — capture-store row written with all canonical event fields populated', async () => {
  const HOME = isolatedHome();
  const prev = { HOME: process.env.HOME, KEY: process.env.OPENAI_API_KEY };
  process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.OPENAI_API_KEY = 'sk-test-fake';
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({
      KOLM_UPSTREAM_OPENAI_BASE: up.base,
      KOLM_UPSTREAM_ANTHROPIC_BASE: up.base,
    });
    try {
      const r = await postJson(t.base + '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'unique-marker-' + Math.random() }],
      });
      assert.equal(r.status, 200);
      const evid = r.headers['x-kolm-event-id'];
      assert.ok(evid);
      // Read store directly through the same module the daemon uses.
      const csMod = await import(pathToFileURLOnce('../src/capture-store.js'));
      const rows = await csMod.listCaptures('local', 'default', 1000);
      const match = rows.find((row) => row.id === evid || row.event_id === evid);
      assert.ok(match, 'expected to find captured row for event_id=' + evid + ' (have ' + rows.length + ' rows)');
      // Spot-check canonical fields present in the persisted row.
      assert.equal(match.provider, 'openai');
      assert.equal(match.model, 'gpt-4o-mini');
      assert.ok(match.prompt && match.prompt.length > 0);
      assert.ok(match.response && match.response.length > 0);
      assert.ok(match.created_at);
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    process.env.HOME = prev.HOME || ''; process.env.USERPROFILE = prev.HOME || '';
    if (prev.KEY) process.env.OPENAI_API_KEY = prev.KEY; else delete process.env.OPENAI_API_KEY;
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W368 #5 — privacy membrane scan flags api_key in the prompt', async () => {
  const HOME = isolatedHome();
  const prev = { HOME: process.env.HOME, KEY: process.env.OPENAI_API_KEY };
  process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.OPENAI_API_KEY = 'sk-test-fake';
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({
      KOLM_UPSTREAM_OPENAI_BASE: up.base,
      KOLM_UPSTREAM_ANTHROPIC_BASE: up.base,
    });
    try {
      const r = await postJson(t.base + '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'please use my key sk-abcdef1234567890 to access X' }],
      });
      assert.equal(r.status, 200);
      const classes = String(r.headers['x-kolm-sensitive-classes'] || '');
      // The privacy stub detects api_key patterns; assert it surfaces.
      assert.ok(classes.includes('api_key'), 'expected api_key in sensitive_classes, got: ' + classes);
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    process.env.HOME = prev.HOME || ''; process.env.USERPROFILE = prev.HOME || '';
    if (prev.KEY) process.env.OPENAI_API_KEY = prev.KEY; else delete process.env.OPENAI_API_KEY;
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W368 #6 — POST without upstream credentials returns 401 with hint', async () => {
  const HOME = isolatedHome();
  const prev = { HOME: process.env.HOME, KEY: process.env.OPENAI_API_KEY };
  process.env.HOME = HOME; process.env.USERPROFILE = HOME; delete process.env.OPENAI_API_KEY;
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({
      KOLM_UPSTREAM_OPENAI_BASE: up.base,
      KOLM_UPSTREAM_ANTHROPIC_BASE: up.base,
    });
    try {
      const r = await postJson(t.base + '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(r.status, 401);
      assert.equal(r.body.error.type, 'missing_upstream_credentials');
      assert.match(r.body.error.message, /OPENAI_API_KEY/);
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    process.env.HOME = prev.HOME || ''; process.env.USERPROFILE = prev.HOME || '';
    if (prev.KEY) process.env.OPENAI_API_KEY = prev.KEY;
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W368 #7 — Authorization Bearer header overrides env var', async () => {
  const HOME = isolatedHome();
  const prev = { HOME: process.env.HOME, KEY: process.env.OPENAI_API_KEY };
  process.env.HOME = HOME; process.env.USERPROFILE = HOME; delete process.env.OPENAI_API_KEY;
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({
      KOLM_UPSTREAM_OPENAI_BASE: up.base,
      KOLM_UPSTREAM_ANTHROPIC_BASE: up.base,
    });
    try {
      // No env key, but Authorization header should satisfy auth.
      const r = await postJson(t.base + '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }, { 'authorization': 'Bearer sk-from-header' });
      assert.equal(r.status, 200);
      assert.ok(r.headers['x-kolm-event-id']);
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    process.env.HOME = prev.HOME || ''; process.env.USERPROFILE = prev.HOME || '';
    if (prev.KEY) process.env.OPENAI_API_KEY = prev.KEY;
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W368 #8 — kolm connect doctor without daemon + no keys exits gracefully (not 0, no crash)', async () => {
  const HOME = isolatedHome();
  const r = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [KOLM_CLI, 'connect', 'doctor'], {
      env: { ...process.env, HOME, USERPROFILE: HOME, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', GEMINI_API_KEY: '', KOLM_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 15000);
    proc.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
  });
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  // Doctor should not crash; either exits 0 (all warns) or 1 (some fails). It MUST not crash with non-int exit.
  assert.ok(r.code === 0 || r.code === 1, 'unexpected exit code ' + r.code + ' stderr=' + r.stderr.slice(0, 200));
  assert.match(r.stdout, /daemon_running/);
  assert.match(r.stdout, /home_writable/);
  assert.match(r.stdout, /capture_store/);
  assert.match(r.stdout, /summary:/);
});

test('W368 #9 — kolm connect status without daemon prints NOT RUNNING (exit 0)', async () => {
  const HOME = isolatedHome();
  const r = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [KOLM_CLI, 'connect', 'status'], {
      env: { ...process.env, HOME, USERPROFILE: HOME, KOLM_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 10000);
    proc.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
  });
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  assert.equal(r.code, 0, 'expected exit 0, got ' + r.code);
  assert.match(r.stdout, /NOT RUNNING/);
});

test('W368 #10 — kolm connect config --show emits sanitized key fingerprints', async () => {
  const HOME = isolatedHome();
  // Pre-seed ~/.kolm/config.json with an upstream key so --show has something to print.
  fs.mkdirSync(path.join(HOME, '.kolm'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.kolm', 'config.json'), JSON.stringify({ upstream_keys: { openai: 'sk-abcdef1234567890wxyz' } }));
  const r = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [KOLM_CLI, 'connect', 'config', '--show'], {
      env: { ...process.env, HOME, USERPROFILE: HOME, KOLM_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 10000);
    proc.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
  });
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  assert.equal(r.code, 0);
  // Sanitized: should show prefix + "..." + suffix, NOT the full key.
  assert.match(r.stdout, /sk-abc.*wxyz/);
  assert.ok(!r.stdout.includes('sk-abcdef1234567890wxyz'), 'config --show leaked full key');
});
