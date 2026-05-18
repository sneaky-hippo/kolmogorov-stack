// Wave 229: native verbs for the 5-foundations agentic stack.
//
// W229 ships four new CLI verbs (kolm jobs / watch / sync / profile)
// backed by two new src/ modules (jobs.js / sync-git.js). These tests
// assert behavior of the underlying modules + that the CLI surface is
// wired (verb appears in COMPLETION_VERBS + dispatcher + help text).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');
const CLI_SRC = fs.readFileSync(CLI, 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

function modUrl(rel, suffix = '') {
  return pathToFileURL(path.join(ROOT, rel)).href + suffix;
}

// Per-test scratch dir so we don't trample the user's real ~/.kolm
function makeScratch() {
  const dir = path.join(os.tmpdir(), `kolm-w229-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function envWith(scratch) {
  return {
    ...process.env,
    KOLM_JOBS_FILE: path.join(scratch, 'jobs.jsonl'),
    KOLM_JOB_LOG_DIR: path.join(scratch, 'logs'),
    KOLM_PROFILE_DIR: path.join(scratch, 'profiles'),
  };
}

test('W229 #1 - src/jobs.js exists and exports the documented surface', async () => {
  const mod = await import(modUrl('src/jobs.js'));
  for (const k of ['filePath', 'logDir', 'ensureDirs', 'listAll', 'get', 'create',
                   'update', 'prune', 'tailLog', 'appendLog', 'VALID_KINDS', 'VALID_STATUSES']) {
    assert.ok(k in mod, `jobs.js must export ${k}`);
  }
  assert.ok(mod.VALID_KINDS instanceof Set, 'VALID_KINDS must be a Set');
  assert.ok(mod.VALID_KINDS.has('compile'), 'VALID_KINDS must include compile');
  assert.ok(mod.VALID_KINDS.has('distill'), 'VALID_KINDS must include distill');
});

test('W229 #2 - jobs.create returns a record with id / kind / status=queued / pid / log_path', async () => {
  const scratch = makeScratch();
  process.env.KOLM_JOBS_FILE = path.join(scratch, 'jobs.jsonl');
  process.env.KOLM_JOB_LOG_DIR = path.join(scratch, 'logs');
  const jobs = await import(modUrl('src/jobs.js', '?w229_2'));
  const rec = jobs.create({ kind: 'compile' });
  assert.ok(rec.id && rec.id.startsWith('job-'), 'id must start with job-');
  assert.equal(rec.kind, 'compile');
  assert.equal(rec.status, 'queued');
  assert.ok(rec.pid > 0, 'pid must be positive');
  assert.ok(rec.log_path && fs.existsSync(rec.log_path), 'log_path must exist');
});

test('W229 #3 - jobs.update transitions status and persists across reads', async () => {
  const scratch = makeScratch();
  process.env.KOLM_JOBS_FILE = path.join(scratch, 'jobs.jsonl');
  process.env.KOLM_JOB_LOG_DIR = path.join(scratch, 'logs');
  const jobs = await import(modUrl('src/jobs.js', '?w229_3'));
  const rec = jobs.create({ kind: 'distill' });
  jobs.update(rec.id, { status: 'running' });
  const r2 = jobs.get(rec.id);
  assert.equal(r2.status, 'running');
  jobs.update(rec.id, { status: 'completed', exit_code: 0 });
  const r3 = jobs.get(rec.id);
  assert.equal(r3.status, 'completed');
  assert.equal(r3.exit_code, 0);
});

test('W229 #4 - jobs.create rejects unknown kinds (behavior contract)', async () => {
  const scratch = makeScratch();
  process.env.KOLM_JOBS_FILE = path.join(scratch, 'jobs.jsonl');
  process.env.KOLM_JOB_LOG_DIR = path.join(scratch, 'logs');
  const jobs = await import(modUrl('src/jobs.js', '?w229_4'));
  assert.throws(() => jobs.create({ kind: 'not-a-kind' }), /invalid job kind/);
});

test('W229 #5 - jobs.prune drops completed jobs older than the cutoff', async () => {
  const scratch = makeScratch();
  process.env.KOLM_JOBS_FILE = path.join(scratch, 'jobs.jsonl');
  process.env.KOLM_JOB_LOG_DIR = path.join(scratch, 'logs');
  const jobs = await import(modUrl('src/jobs.js', '?w229_5'));
  const a = jobs.create({ kind: 'compile' });
  jobs.update(a.id, { status: 'completed', updated_at: Date.now() - 10 * 24 * 3600 * 1000 });
  // Hand-edit to backdate updated_at (update bumps it to now).
  const fp = path.join(scratch, 'jobs.jsonl');
  const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  last.updated_at = Date.now() - 10 * 24 * 3600 * 1000;
  lines[lines.length - 1] = JSON.stringify(last);
  fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8');

  const b = jobs.create({ kind: 'compile' }); // still running, must NOT prune
  const r = jobs.prune({ olderThanMs: 7 * 24 * 3600 * 1000 });
  assert.equal(r.dropped, 1, `should drop 1 stale completed job, dropped=${r.dropped}`);
  assert.ok(jobs.get(b.id), 'still-queued job must survive prune');
  assert.equal(jobs.get(a.id), null, 'old completed job must be gone');
});

test('W229 #6 - src/sync-git.js exists and exports push/pull/status', async () => {
  const mod = await import(modUrl('src/sync-git.js'));
  for (const k of ['push', 'pull', 'status', 'workdirFor', 'ensureClone']) {
    assert.ok(k in mod, `sync-git.js must export ${k}`);
  }
});

test('W229 #7 - sync.workdirFor maps a git URL to a deterministic temp path', async () => {
  const mod = await import(modUrl('src/sync-git.js'));
  const a = mod.workdirFor('git@github.com:acme/kolm-mirror.git');
  const b = mod.workdirFor('git@github.com:acme/kolm-mirror.git');
  assert.equal(a, b, 'same URL must map to same workdir');
  const c = mod.workdirFor('git@github.com:other/kolm-mirror.git');
  assert.notEqual(a, c, 'different URL must map to different workdir');
});

test('W229 #8 - COMPLETION_VERBS includes jobs / watch / sync / profile', () => {
  for (const verb of ['jobs', 'watch', 'sync', 'profile']) {
    const re = new RegExp(`'${verb}'`);
    assert.ok(re.test(CLI_SRC), `COMPLETION_VERBS must list '${verb}'`);
  }
});

test('W229 #9 - dispatcher routes jobs/watch/sync/profile to cmd functions', () => {
  for (const verb of ['jobs', 'watch', 'sync', 'profile']) {
    const re = new RegExp(`case '${verb}':`);
    assert.ok(re.test(CLI_SRC), `dispatcher must route case '${verb}':`);
  }
  // All four cmd implementations must exist.
  for (const fn of ['cmdJobs', 'cmdWatch', 'cmdSync', 'cmdProfile']) {
    assert.ok(CLI_SRC.includes(`async function ${fn}`), `${fn} must be defined`);
  }
});

test('W229 #10 - sw.js wave-floor >= 229 (foundations verbs)', () => {
  const m = SW.match(/const CACHE = 'kolm-v7-[^']+-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE must follow wave-N slug pattern');
  const waveN = parseInt(m[1], 10);
  assert.ok(waveN >= 229, `sw.js wave-slug must be >= 229 (saw ${waveN})`);
});

test('W229 #11 - kolm jobs (no args) lists, exit 0, prints empty-state guidance', () => {
  const scratch = makeScratch();
  const r = spawnSync(process.execPath, [CLI, 'jobs'], {
    encoding: 'utf8',
    env: envWith(scratch),
  });
  assert.equal(r.status, 0, `jobs must exit 0 on empty list, got ${r.status}, stderr=${r.stderr}`);
  assert.match(r.stdout, /no jobs recorded/i, 'empty-state hint must mention no jobs');
});

test('W229 #12 - kolm profile list (empty) exits 0 with guidance', () => {
  const scratch = makeScratch();
  const r = spawnSync(process.execPath, [CLI, 'profile', 'list'], {
    encoding: 'utf8',
    env: envWith(scratch),
  });
  assert.equal(r.status, 0, `profile list must exit 0, got ${r.status}, stderr=${r.stderr}`);
  assert.match(r.stdout, /no profiles/i, 'empty-state hint must mention no profiles');
});

test('W229 #13 - kolm profile save + use + show round-trips a named profile', () => {
  const scratch = makeScratch();
  const env = envWith(scratch);
  const save = spawnSync(process.execPath, [CLI, 'profile', 'save', 'demo'], { encoding: 'utf8', env });
  assert.equal(save.status, 0, `save exit=${save.status}, stderr=${save.stderr}`);
  assert.match(save.stdout, /saved profile demo/);
  const use = spawnSync(process.execPath, [CLI, 'profile', 'use', 'demo'], { encoding: 'utf8', env });
  assert.equal(use.status, 0, `use exit=${use.status}, stderr=${use.stderr}`);
  const show = spawnSync(process.execPath, [CLI, 'profile', 'show', 'demo'], { encoding: 'utf8', env });
  assert.equal(show.status, 0, `show exit=${show.status}`);
  const parsed = JSON.parse(show.stdout);
  assert.ok(parsed.created_at, 'profile must record created_at');
  assert.equal(parsed.env.KOLM_PROFILE, 'demo', 'profile must self-name KOLM_PROFILE');
});

test('W229 #14 - kolm sync push without args fails with usage hint', () => {
  const scratch = makeScratch();
  const r = spawnSync(process.execPath, [CLI, 'sync', 'push'], {
    encoding: 'utf8',
    env: envWith(scratch),
  });
  assert.notEqual(r.status, 0, 'sync push without args must fail');
  assert.match(r.stderr + r.stdout, /usage: kolm sync push/i, 'must print usage hint');
});

test('W229 #15 - kolm watch without job-id fails with usage hint', () => {
  const scratch = makeScratch();
  const r = spawnSync(process.execPath, [CLI, 'watch'], {
    encoding: 'utf8',
    env: envWith(scratch),
    timeout: 5000,
  });
  assert.notEqual(r.status, 0, 'watch without id must fail');
  assert.match(r.stderr + r.stdout, /usage: kolm watch/i, 'must print usage hint');
});

test('W229 #16 - kolm jobs list emits the created job after create()', async () => {
  const scratch = makeScratch();
  const env = envWith(scratch);
  // Bootstrap one job via the module, then list via the CLI.
  process.env.KOLM_JOBS_FILE = env.KOLM_JOBS_FILE;
  process.env.KOLM_JOB_LOG_DIR = env.KOLM_JOB_LOG_DIR;
  const jobs = await import(modUrl('src/jobs.js', '?w229_16'));
  const rec = jobs.create({ kind: 'eval' });
  const r = spawnSync(process.execPath, [CLI, 'jobs', 'list'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `jobs list exit=${r.status}, stderr=${r.stderr}`);
  assert.ok(r.stdout.includes(rec.id), 'jobs list must include the created job id');
  assert.ok(r.stdout.includes('eval'), 'jobs list must include the job kind');
});

test('W229 #17 - COMPLETION_SUBS exposes jobs/sync/profile subcommands', () => {
  assert.match(CLI_SRC, /jobs:\s*\[['"]list['"]/, 'jobs subs must include list');
  assert.match(CLI_SRC, /sync:\s*\[['"]push['"]/, 'sync subs must include push');
  assert.match(CLI_SRC, /profile:\s*\[['"]save['"]/, 'profile subs must include save');
});
