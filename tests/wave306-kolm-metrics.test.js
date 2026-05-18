// Wave 306 — `kolm metrics` local dashboard summary.
//
// Locally-readable aggregation of jobs by kind and status. Mirrors what the
// /dashboard page shows but without a network call so it works offline and
// on air-gapped boxes. Reads ~/.kolm/jobs.jsonl via src/jobs.js (same source
// W304 cmdStatus uses for its active/done counter).
//
// Cross-test isolation: per-spawn HOME override. The metrics verb writes
// a seeded JSONL into the isolated HOME first so the assertions have a
// deterministic shape regardless of any jobs lingering in the dev tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KOLM_CLI = path.resolve(__dirname, '..', 'cli', 'kolm.js');

function isolatedHome() {
  const dir = path.join(os.tmpdir(), 'kolm-w306-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function seedJobs(home, rows) {
  const kolmDir = path.join(home, '.kolm');
  const jobsDir = path.join(kolmDir, 'jobs');
  try { fs.mkdirSync(jobsDir, { recursive: true }); } catch (_) {}
  const now = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rec = {
      id: 'job-' + i,
      kind: r.kind,
      status: r.status,
      started_at: now - (rows.length - i) * 1000,
      updated_at: now - i * 100,
      pid: 0,
      log_path: path.join(kolmDir, 'logs', 'job-' + i + '.log'),
      meta: {},
    };
    fs.writeFileSync(path.join(jobsDir, 'job-' + i + '.json'), JSON.stringify(rec), 'utf8');
  }
}

function runMetrics(extraArgs = [], seed = null) {
  const home = isolatedHome();
  if (seed) seedJobs(home, seed);
  const res = spawnSync(process.execPath, [KOLM_CLI, 'metrics', ...extraArgs], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_API_KEY: '' },
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('W306 #1 — empty state prints zeros (no jobs file)', () => {
  const out = runMetrics();
  assert.equal(out.code, 0, `stderr: ${out.stderr.slice(0, 400)}`);
  assert.match(out.stdout, /jobs:/, 'must include jobs section header');
  assert.match(out.stdout, /total:\s+0/, 'must show 0 total when empty');
});

test('W306 #2 — aggregates by status (running/done/failed)', () => {
  const out = runMetrics([], [
    { kind: 'compile', status: 'running' },
    { kind: 'compile', status: 'running' },
    { kind: 'distill', status: 'done' },
    { kind: 'compile', status: 'done' },
    { kind: 'distill', status: 'failed' },
  ]);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /total:\s+5/);
  assert.match(out.stdout, /running:\s+2/);
  assert.match(out.stdout, /done:\s+2/);
  assert.match(out.stdout, /failed:\s+1/);
});

test('W306 #3 — aggregates by kind (compile/distill split)', () => {
  const out = runMetrics([], [
    { kind: 'compile', status: 'done' },
    { kind: 'compile', status: 'done' },
    { kind: 'distill', status: 'done' },
  ]);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /compile:\s+2/);
  assert.match(out.stdout, /distill:\s+1/);
});

test('W306 #4 — --json mode emits structured payload', () => {
  const out = runMetrics(['--json'], [
    { kind: 'compile', status: 'running' },
    { kind: 'distill', status: 'done' },
  ]);
  assert.equal(out.code, 0);
  const jsonStart = out.stdout.indexOf('{');
  assert.ok(jsonStart >= 0, `expected JSON payload, got: ${out.stdout.slice(0, 200)}`);
  const report = JSON.parse(out.stdout.slice(jsonStart));
  assert.equal(typeof report.jobs, 'object');
  assert.equal(report.jobs.total, 2);
  assert.equal(report.jobs.by_status.running, 1);
  assert.equal(report.jobs.by_status.done, 1);
  assert.equal(report.jobs.by_kind.compile, 1);
  assert.equal(report.jobs.by_kind.distill, 1);
});

test('W306 #5 — --help prints HELP.metrics body', () => {
  const out = runMetrics(['--help']);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /kolm metrics/);
  assert.match(out.stdout, /--json/);
});

test('W306 #6 — "metrics" registered in COMPLETION_VERBS and dispatched from >=2 sites', () => {
  const cliSrc = fs.readFileSync(KOLM_CLI, 'utf8');
  const m = cliSrc.match(/const COMPLETION_VERBS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m);
  assert.match(m[1], /'metrics'/);
  const cmdMetricsCalls = (cliSrc.match(/cmdMetrics\(rest\)/g) || []).length;
  assert.ok(cmdMetricsCalls >= 2, `expected cmdMetrics from >=2 sites, got ${cmdMetricsCalls}`);
});
