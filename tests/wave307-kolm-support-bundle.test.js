// Wave 307 — `kolm support-bundle` redacted local dump verb.
//
// Customer-shipped artifact for enterprise support: collects config (with
// api_key redacted to fingerprint), recent jobs, last N log lines, plus
// version/platform. Output is a directory with bundle.json + jobs.json +
// logs/ — easy for the customer to inspect before sending, and for support
// to read without unpacking an archive.

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
  const dir = path.join(os.tmpdir(), 'kolm-w307-' + process.pid + '-' + Math.random().toString(36).slice(2));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function seedHome(home, { apiKey = '', jobs = [], logLines = [] } = {}) {
  const kolmDir = path.join(home, '.kolm');
  const jobsDir = path.join(kolmDir, 'jobs');
  const logsDir = path.join(kolmDir, 'logs');
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  if (apiKey) {
    fs.writeFileSync(path.join(kolmDir, 'config.json'), JSON.stringify({ api_key: apiKey, base: 'https://kolm.ai' }), 'utf8');
  }
  jobs.forEach((j, i) => {
    const rec = { id: 'job-' + i, kind: j.kind, status: j.status, started_at: Date.now(), updated_at: Date.now(), pid: 0, log_path: path.join(logsDir, 'job-' + i + '.log'), meta: {} };
    fs.writeFileSync(path.join(jobsDir, 'job-' + i + '.json'), JSON.stringify(rec), 'utf8');
    if (logLines[i]) fs.writeFileSync(path.join(logsDir, 'job-' + i + '.log'), logLines[i], 'utf8');
  });
}

function runBundle(extraArgs = [], seed = {}, env = {}) {
  const home = isolatedHome();
  const outDir = path.join(home, 'bundle-out');
  if (seed && Object.keys(seed).length) seedHome(home, seed);
  const res = spawnSync(process.execPath, [KOLM_CLI, 'support-bundle', '--out', outDir, ...extraArgs], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_API_KEY: '', ...env },
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '', home, outDir };
}

test('W307 #1 — produces an output directory with bundle.json', () => {
  const r = runBundle();
  assert.equal(r.code, 0, `stderr: ${r.stderr.slice(0, 400)}`);
  const bundlePath = path.join(r.outDir, 'bundle.json');
  assert.ok(fs.existsSync(bundlePath), 'bundle.json must exist at outDir');
  const b = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  assert.equal(typeof b.version, 'string');
  assert.equal(typeof b.base, 'string');
  assert.equal(typeof b.platform, 'string');
  assert.equal(typeof b.node, 'string');
  fs.rmSync(r.home, { recursive: true, force: true });
});

test('W307 #2 — api_key is NEVER written in clear; only fingerprint', () => {
  const fakeKey = 'ks_test_LIVE0123456789ABCDEFGHIJ';
  const r = runBundle([], { apiKey: fakeKey });
  assert.equal(r.code, 0);
  // Scan every file in the output dir for the raw key.
  const walk = (d) => {
    const out = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  const files = walk(r.outDir);
  assert.ok(files.length > 0, 'bundle must contain files');
  for (const f of files) {
    const body = fs.readFileSync(f, 'utf8');
    assert.ok(!body.includes(fakeKey), `file ${path.basename(f)} contains raw api_key`);
  }
  const b = JSON.parse(fs.readFileSync(path.join(r.outDir, 'bundle.json'), 'utf8'));
  assert.ok(b.key_fingerprint, 'fingerprint must be present in bundle.json');
  assert.ok(b.key_fingerprint.startsWith(fakeKey.slice(0, 10)));
  assert.ok(b.key_fingerprint.endsWith(fakeKey.slice(-4)));
  fs.rmSync(r.home, { recursive: true, force: true });
});

test('W307 #3 — jobs.json includes all seeded jobs', () => {
  const r = runBundle([], {
    jobs: [
      { kind: 'compile', status: 'done' },
      { kind: 'distill', status: 'failed' },
    ],
  });
  assert.equal(r.code, 0);
  const jobsPath = path.join(r.outDir, 'jobs.json');
  assert.ok(fs.existsSync(jobsPath));
  const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
  assert.equal(jobs.length, 2);
  assert.ok(jobs.some((j) => j.kind === 'compile'));
  assert.ok(jobs.some((j) => j.kind === 'distill'));
  fs.rmSync(r.home, { recursive: true, force: true });
});

test('W307 #4 — recent log files copied into logs/ subdir', () => {
  const r = runBundle([], {
    jobs: [{ kind: 'compile', status: 'done' }],
    logLines: ['line 1\nline 2\nline 3\n'],
  });
  assert.equal(r.code, 0);
  const logsDir = path.join(r.outDir, 'logs');
  assert.ok(fs.existsSync(logsDir), 'logs dir must exist');
  const logs = fs.readdirSync(logsDir);
  assert.ok(logs.length >= 1, 'at least one log must be copied');
  fs.rmSync(r.home, { recursive: true, force: true });
});

test('W307 #5 — --json mode prints destination path', () => {
  const r = runBundle(['--json']);
  assert.equal(r.code, 0);
  const jsonStart = r.stdout.indexOf('{');
  const report = JSON.parse(r.stdout.slice(jsonStart));
  assert.equal(typeof report.out_dir, 'string');
  assert.ok(report.out_dir.endsWith('bundle-out') || report.out_dir.includes('bundle-out'));
  fs.rmSync(r.home, { recursive: true, force: true });
});

test('W307 #6 — --help prints HELP.support_bundle body', () => {
  const home = isolatedHome();
  const res = spawnSync(process.execPath, [KOLM_CLI, 'support-bundle', '--help'], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, KOLM_API_KEY: '' },
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /kolm support-bundle/);
  assert.match(res.stdout, /--out/);
});

test('W307 #7 — "support-bundle" registered in COMPLETION_VERBS and dispatched twice', () => {
  const cliSrc = fs.readFileSync(KOLM_CLI, 'utf8');
  const m = cliSrc.match(/const COMPLETION_VERBS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m);
  assert.match(m[1], /'support-bundle'/);
  const calls = (cliSrc.match(/cmdSupportBundle\(rest\)/g) || []).length;
  assert.ok(calls >= 2, `expected cmdSupportBundle from >=2 sites, got ${calls}`);
});
