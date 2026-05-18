// Wave 305 — `kolm health` cloud ping verb.
//
// Boots an in-process buildRouter() with the existing /health and
// /v1/capture/health routes, sets KOLM_BASE so cmdHealth probes it,
// and asserts the three exit-code contracts (0 healthy, 1 down, 2 slow).
// Behavior-only — no page text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KOLM_CLI = path.resolve(__dirname, '..', 'cli', 'kolm.js');

function isolatedHome() {
  const dir = path.join(os.tmpdir(), 'kolm-w305-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

// Use async spawn so the parent event loop stays free to service the in-process
// express server while the child kolm health subprocess is running. spawnSync
// blocks the loop and would deadlock against any local server bound here.
function spawnAsync(args, env) {
  return new Promise((resolve) => {
    const home = isolatedHome();
    const child = spawn(process.execPath, [KOLM_CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_API_KEY: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 20_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
      resolve({ code, stdout, stderr });
    });
  });
}

// Spin a tiny express app exposing only /health and /v1/capture/health so
// cmdHealth has a real target without booting the full router. delayMs lets
// us simulate slow-server scenarios; downCode 0 means do not respond (we
// listen on a closed port instead).
function spinServer({ delayMs = 0, captureDurable = true, captureDriver = 'sqlite' } = {}) {
  const app = express();
  app.get('/health', async (_req, res) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    res.json({ ok: true });
  });
  app.get('/v1/capture/health', (_req, res) => {
    res.json({ ok: true, driver: captureDriver, durable: captureDurable, subscriber_count: 0, thresholds: [100, 500, 1000] });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

test('W305 #1 — healthy server returns exit 0 with HEALTHY summary', async () => {
  const { server, base } = await spinServer();
  try {
    const out = await spawnAsync(['health'], { KOLM_BASE: base });
    assert.equal(out.code, 0, `expected exit 0, got ${out.code} (stdout: ${out.stdout.slice(0, 200)})`);
    assert.match(out.stdout, /HEALTHY/);
    assert.match(out.stdout, /capture:\s+driver=sqlite/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('W305 #2 — slow server (RTT > --slow-ms) returns exit 2 with SLOW summary', async () => {
  const { server, base } = await spinServer({ delayMs: 300 });
  try {
    const out = await spawnAsync(['health', '--slow-ms', '100'], { KOLM_BASE: base });
    assert.equal(out.code, 2, `expected exit 2 (slow), got ${out.code}`);
    assert.match(out.stdout, /SLOW/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('W305 #3 — unreachable base returns exit 1 with DOWN summary', async () => {
  // Use a port the OS will not have anything bound on.
  const out = await spawnAsync(['health', '--timeout-ms', '1500'], { KOLM_BASE: 'http://127.0.0.1:1' });
  assert.equal(out.code, 1, `expected exit 1 (down), got ${out.code}`);
  assert.match(out.stdout, /DOWN/);
});

test('W305 #4 — --json mode emits structured payload with thresholds', async () => {
  const { server, base } = await spinServer();
  try {
    const out = await spawnAsync(['health', '--json'], { KOLM_BASE: base });
    assert.equal(out.code, 0);
    const payload = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')));
    assert.equal(payload.ok, true);
    assert.equal(payload.summary, 'healthy');
    assert.equal(payload.base, base);
    assert.equal(typeof payload.root.rtt_ms, 'number');
    assert.equal(payload.capture.driver, 'sqlite');
    assert.equal(payload.capture.durable, true);
    assert.equal(payload.thresholds.slow_ms, 2000);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('W305 #5 — --help prints HELP.health body', async () => {
  const out = await spawnAsync(['health', '--help'], {});
  assert.equal(out.code, 0);
  assert.match(out.stdout, /kolm health - ping/);
  assert.match(out.stdout, /--slow-ms/);
});

test('W305 #6 — "health" registered in COMPLETION_VERBS and main dispatcher', () => {
  const cliSrc = fs.readFileSync(KOLM_CLI, 'utf8');
  const m = cliSrc.match(/const COMPLETION_VERBS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m);
  assert.match(m[1], /'health'/);
  const cmdHealthCalls = (cliSrc.match(/cmdHealth\(rest\)/g) || []).length;
  assert.ok(cmdHealthCalls >= 2, `expected cmdHealth dispatched from >=2 sites, got ${cmdHealthCalls}`);
});
