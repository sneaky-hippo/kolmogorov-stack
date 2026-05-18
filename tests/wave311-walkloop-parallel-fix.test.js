// Wave 311 — walkLoop parallel-flake real fix lock-in.
//
// Two earlier sessions hit "database is locked" SQLite errors when W297, W298,
// W300-W303 ran in parallel. Root causes:
//   (1) .env sets KOLM_STORE_DRIVER=sqlite, dotenv loads before store.js
//       initialises (via src/synthesis.js), so every parallel test process
//       fights over the same data/kolm.sqlite write lock.
//   (2) walkLoop in cli/kolm.js used global fetch(); on Windows the undici
//       socket pool crashes libuv (UV_HANDLE_CLOSING) on process.exit when
//       any keep-alive sockets are still draining.
//
// Fixes shipped:
//   * src/store.js getSqliteDb() adds PRAGMA busy_timeout = 30000 so writers
//     wait on the lock instead of erroring immediately.
//   * cli/kolm.js walkLoop uses node:http/node:https directly (same pattern
//     as W305 cmdHealth) and no longer touches the global fetch dispatcher.
//
// These tests lock both invariants in source so future edits can't quietly
// regress them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KOLM_CLI = path.resolve(__dirname, '..', 'cli', 'kolm.js');
const STORE_PATH = path.resolve(__dirname, '..', 'src', 'store.js');

test('W311 #1 — store.js getSqliteDb sets PRAGMA busy_timeout >= 5000', () => {
  const src = fs.readFileSync(STORE_PATH, 'utf8');
  // busy_timeout must be at least 5000ms so a competing writer waits a real
  // fraction of a second instead of erroring with SQLITE_BUSY immediately.
  const m = src.match(/PRAGMA\s+busy_timeout\s*=\s*(\d+)/i);
  assert.ok(m, 'getSqliteDb must set PRAGMA busy_timeout to avoid lock contention crashes');
  const ms = parseInt(m[1], 10);
  assert.ok(ms >= 5000, `busy_timeout must be >= 5000ms, got ${ms}`);
});

test('W311 #2 — walkLoop in cli/kolm.js uses node:http, not global fetch', () => {
  const src = fs.readFileSync(KOLM_CLI, 'utf8');
  // Find the walkLoop function block.
  const start = src.indexOf('const walkLoop = async (base, auth');
  assert.ok(start > 0, 'walkLoop must exist in cli/kolm.js');
  const end = src.indexOf('process.exit(exitCode);', start);
  assert.ok(end > start, 'walkLoop must be followed by process.exit(exitCode)');
  const block = src.slice(start, end);
  // The block itself must not contain bare fetch() calls — that is the libuv
  // crash vector on Windows when CLI exits.
  assert.ok(!/\bawait\s+fetch\(/.test(block), 'walkLoop must not use fetch() (libuv exit crash vector)');
  // Look for the httpJson helper or node:http use just upstream.
  const upstream = src.slice(Math.max(0, start - 2000), start);
  assert.ok(/node:http/.test(upstream) || /httpJson/.test(block), 'walkLoop should use node:http or an httpJson helper');
});

test('W311 #3 — kolm doctor --loop --json exits 0 in isolation (smoke)', () => {
  // Smoke that the value-loop CLI still wires end-to-end after the fetch→
  // node:http rewrite. Run as a child of `node` (not `node --test`) to avoid
  // node:test's recursive-run warning, which silently skips the inner suite.
  // Isolated HOME per spawn so the smoke does not pollute the user config.
  const home = path.join(os.tmpdir(), 'kolm-w311-smoke-' + process.pid + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(home, { recursive: true });
  const res = spawnSync(process.execPath, [KOLM_CLI, 'doctor', '--loop', '--json'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  assert.equal(res.error, undefined, `spawn must not error (${res.error && res.error.message})`);
  assert.equal(res.status, 0, `kolm doctor --loop --json must exit 0 (got ${res.status}, stderr: ${(res.stderr || '').slice(0, 600)})`);
  const jsonStart = (res.stdout || '').indexOf('{');
  assert.ok(jsonStart >= 0, `no JSON in output: ${(res.stdout || '').slice(0, 400)}`);
  const report = JSON.parse(res.stdout.slice(jsonStart));
  assert.equal(report.ok, true, `report.ok must be true after node:http rewrite (rungs: ${JSON.stringify(report.rungs)})`);
  assert.equal(report.mode, 'in-process');
  assert.ok(Array.isArray(report.rungs) && report.rungs.length === 6, `expected 6 rungs, got ${report.rungs && report.rungs.length}`);
});

test('W311 #4 — store.js still defaults to JSON in dev (non-production env)', () => {
  // The dev default must stay JSON so a fresh clone does not need .env at all.
  // This protects against accidental productionLike inversion.
  const src = fs.readFileSync(STORE_PATH, 'utf8');
  assert.match(src, /function detectDefaultDriver\(\)/, 'detectDefaultDriver must exist');
  // Search for the "if (!productionLike) return 'json'" line.
  assert.match(src, /if \(!productionLike\) return ['"]json['"]/, 'dev default must remain json');
});

test('W311 #5 — busy_timeout is part of the same exec block as journal_mode', () => {
  // Putting busy_timeout in a separate exec() risks racing the first INSERT,
  // since pragmas are connection-scoped. Lock-in: same exec() as journal_mode.
  const src = fs.readFileSync(STORE_PATH, 'utf8');
  const m = src.match(/sqliteDb\.exec\(`([\s\S]+?)`\)/);
  assert.ok(m, 'sqliteDb.exec backtick block must exist in store.js');
  const block = m[1];
  assert.match(block, /PRAGMA\s+journal_mode\s*=\s*WAL/i);
  assert.match(block, /PRAGMA\s+busy_timeout\s*=\s*\d+/i);
});
