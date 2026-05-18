// Wave 348 — `kolm ask` must not crash with a Node libuv assertion when
// the hosted assistant returns 401 (or any HTTP error). The original bug
// surfaced as:
//
//   node: ../deps/uv/src/win/async.c:64: assertion failed:
//   !(handle->flags & UV_HANDLE_CLOSING)
//
// — undici's keep-alive socket pool was still draining at process.exit()
// while the CLI's top-level catch was already calling exit. Fix: replace
// the global api() helper (cli/kolm.js) from fetch() to node:http(s)
// directly so there is no global dispatcher to leave open. Same pattern
// as W305 (cmdHealth) and W311 (walkLoop).
//
// Behavior assertions (no fragile copy markers):
//   1. cli/kolm.js no longer imports/uses fetch() for the api() helper.
//   2. spawn(`node cli/kolm.js ask "x"`) with no api key in a clean HOME
//      exits 0 (the verb falls back to the local parser when no key set)
//      AND emits NO libuv stack trace.
//   3. spawn with KOLM_API_KEY set to a clearly invalid token and a base
//      URL pointing at a real cloud-style endpoint that returns 401:
//      exit code is EXIT.MISSING_PREREQ (3), stderr mentions 'kolm login'
//      or 'auth_required', and there is NO Node stack trace / no libuv
//      assertion / no "UV_HANDLE_CLOSING" anywhere in the output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '..');
const KOLM_JS = path.join(ROOT, 'cli', 'kolm.js');

function mkTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w348-home-'));
}

function runKolm(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [KOLM_JS, ...args], {
      env: { ...env, PATH: process.env.PATH, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function withFakeUpstream(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      try {
        const base = 'http://127.0.0.1:' + server.address().port;
        const out = await fn(base);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

test('W348 #1 - api() helper uses node:http, not fetch()', () => {
  const src = fs.readFileSync(KOLM_JS, 'utf8');
  const apiIdx = src.indexOf('async function api(');
  assert.ok(apiIdx > 0, 'api() helper missing');
  // Slice the body of api() (first ~2000 chars after the signature).
  const apiBody = src.slice(apiIdx, apiIdx + 2000);
  assert.ok(!/await\s+fetch\s*\(/.test(apiBody),
    'api() must not call fetch() (libuv UV_HANDLE_CLOSING trap on Windows exit). Use node:http.');
  // Must reference http/https/lib.request — the new helper.
  assert.ok(/lib\.request\(|http\.request\(|https\.request\(/.test(apiBody),
    'api() must use node:http(s).request directly');
});

test('W348 #2 - `kolm ask "x"` with no api key falls back locally, exits 0, no libuv crash', async () => {
  const HOME = mkTempHome();
  const env = process.platform === 'win32'
    ? { USERPROFILE: HOME, HOMEDRIVE: 'C:', HOMEPATH: HOME.slice(2) }
    : { HOME };
  // Make sure no inherited key leaks in.
  delete env.KOLM_API_KEY;
  const r = await runKolm(['ask', 'what can you do'], env);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr=${r.stderr}`);
  const combined = r.stdout + '\n' + r.stderr;
  assert.ok(!combined.includes('UV_HANDLE_CLOSING'),
    'must NOT print libuv UV_HANDLE_CLOSING assertion: ' + combined);
  assert.ok(!combined.includes('assertion failed'),
    'must NOT print libuv assertion failure: ' + combined);
  assert.ok(!combined.includes('STATUS_STACK_BUFFER_OVERRUN'),
    'must NOT print STATUS_STACK_BUFFER_OVERRUN: ' + combined);
});

test('W348 #3 - `kolm ask "x"` on 401 exits MISSING_PREREQ (3) with no libuv crash', async () => {
  const HOME = mkTempHome();
  // Write a fake config that points at a base we control + a clearly bad key.
  const kolmDir = path.join(HOME, '.kolm');
  fs.mkdirSync(kolmDir, { recursive: true });
  await withFakeUpstream((req, res) => {
    // Return 401 for any auth attempt.
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'invalid_api_key' }));
  }, async (base) => {
    fs.writeFileSync(path.join(kolmDir, 'config.json'),
      JSON.stringify({ base, api_key: 'ks_test_invalid_12345' }));
    const env = process.platform === 'win32'
      ? { USERPROFILE: HOME, HOMEDRIVE: 'C:', HOMEPATH: HOME.slice(2) }
      : { HOME };
    // --json mode forces ask to re-throw the 401 (the non-json path falls
    // back to the local parser silently; the spec wants the auth-required
    // exit code propagated, which the --json path does).
    const r = await runKolm(['ask', '--json', 'list jobs'], env);
    const combined = r.stdout + '\n' + r.stderr;
    // Critical: no libuv assertion anywhere.
    assert.ok(!combined.includes('UV_HANDLE_CLOSING'),
      'libuv UV_HANDLE_CLOSING assertion regression: ' + combined);
    assert.ok(!combined.includes('assertion failed'),
      'libuv assertion failure: ' + combined);
    assert.ok(!combined.includes('STATUS_STACK_BUFFER_OVERRUN'),
      'STATUS_STACK_BUFFER_OVERRUN regression: ' + combined);
    // Exit code: --json mode re-throws so error context maps to MISSING_PREREQ.
    assert.equal(r.code, 3, `expected exit 3 (MISSING_PREREQ), got ${r.code}; stderr=${r.stderr}`);
    // Stderr should hint at login or auth.
    assert.ok(/kolm login|auth_required|invalid_api_key/i.test(r.stderr + r.stdout),
      'expected login/auth hint in output: ' + combined);
  });
});

test('W348 #4 - non-json `kolm ask` on 502 falls back to local parser, exits 0, no crash', async () => {
  // 401 always promotes to auth_required (MISSING_PREREQ) by design — that
  // path is exercised in #3. This test exercises the OTHER catch branch:
  // any non-401 transport/server error falls back to the local parser and
  // exits 0, so the verb stays useful when the hosted assistant is sick.
  const HOME = mkTempHome();
  const kolmDir = path.join(HOME, '.kolm');
  fs.mkdirSync(kolmDir, { recursive: true });
  await withFakeUpstream((req, res) => {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'upstream_unavailable' }));
  }, async (base) => {
    fs.writeFileSync(path.join(kolmDir, 'config.json'),
      JSON.stringify({ base, api_key: 'ks_test_real_key' }));
    const env = process.platform === 'win32'
      ? { USERPROFILE: HOME, HOMEDRIVE: 'C:', HOMEPATH: HOME.slice(2) }
      : { HOME };
    const r = await runKolm(['ask', 'help me list jobs'], env);
    const combined = r.stdout + '\n' + r.stderr;
    assert.ok(!combined.includes('UV_HANDLE_CLOSING'),
      'libuv regression: ' + combined);
    assert.ok(!combined.includes('assertion failed'),
      'libuv assertion failure: ' + combined);
    // Non-JSON path falls back to local parser on 502; exit code is 0.
    assert.equal(r.code, 0, `expected exit 0 on local fallback, got ${r.code}; stderr=${r.stderr}`);
  });
});
