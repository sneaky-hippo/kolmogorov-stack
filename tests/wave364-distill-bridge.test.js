// Wave 364 — distill bridge: in-tree LoRA worker spawn replaces 503 sentinel.
//
// Closes the W199-W364 gap where the specialist arms of both
// /v1/distill/from-captures and /v1/specialists/auto-distill returned 503
// distill_bridge_not_configured. Both endpoints now:
//   - try KOLM_TRAINER_BRIDGE_URL first (legacy operator-managed cluster)
//   - on failure / unset, spawn workers/distill/distill.mjs via
//     src/distill-bridge.js → startDistillJob → src/jobs.js
//   - always return 202 with {job_id, status, poll_url, bridge_source}
//
// Behavior tests:
//   1. startDistillJob() returns a job record with kind:'distill', a real
//      pid, and an existing log path. (Spawn is mocked.)
//   2. startDistillJob() throws when captures are missing.
//   3. The spawned worker process gets the expected argv (spec/seeds/out/mode).
//   4. The job record meta includes pair_count, tmp_dir, out_dir, mode.
//   5. Mode picks: stub when no teacher key, collect when teacher set,
//      full when KOLM_DISTILL_FULL=1 + teacher set.
//   6. src/router.js no longer contains 503 distill_bridge_not_configured
//      in the from-captures handler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODULE_PATH = path.join(ROOT, 'src/distill-bridge.js');
const ROUTER_SRC = fs.readFileSync(path.join(ROOT, 'src/router.js'), 'utf8');

function freshImport() {
  return import(pathToFileURL(MODULE_PATH).href + '?t=' + Date.now());
}

// Tracker mock for child_process.spawn. Records argv + opts + returns a fake
// child that supports unref(), on('exit'), and a settable pid.
function makeSpawnMock(opts = {}) {
  const calls = [];
  const fn = (cmd, args, spawnOpts) => {
    const child = new EventEmitter();
    child.pid = opts.pid || 12345;
    child.unref = () => {};
    child.kill = () => {};
    calls.push({ cmd, args, spawnOpts });
    if (opts.simulateExit) {
      // Defer the exit so the caller can register listeners first.
      setTimeout(() => child.emit('exit', opts.exitCode || 0, null), 1);
    }
    return child;
  };
  return { fn, calls };
}

function withTmpDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w364-'));
  return { tmp, cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} } };
}

function withEnv(extra = {}) {
  const SAVED = {};
  const TARGETS = [
    'KOLM_DISTILL_FULL', 'KOLM_DISTILL_TEACHER', 'KOLM_DISTILL_MAX_ROWS',
    'KOLM_DISTILL_TMP_DIR', 'KOLM_JOBS_DIR', 'KOLM_JOBS_FILE',
    'KOLM_JOB_LOG_DIR', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  ];
  for (const k of TARGETS) {
    if (k in process.env) { SAVED[k] = process.env[k]; delete process.env[k]; }
  }
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  return () => {
    for (const k of TARGETS) delete process.env[k];
    for (const [k, v] of Object.entries(SAVED)) process.env[k] = v;
  };
}

test('W364 #1 — startDistillJob returns a job record with kind:distill + pid + log path', async () => {
  const { tmp, cleanup } = withTmpDir();
  const restore = withEnv({
    KOLM_DISTILL_TMP_DIR: path.join(tmp, 'workspace'),
    KOLM_JOBS_DIR: path.join(tmp, 'jobs'),
    KOLM_JOBS_FILE: path.join(tmp, 'jobs.jsonl'),
    KOLM_JOB_LOG_DIR: path.join(tmp, 'logs'),
  });
  try {
    const { startDistillJob } = await freshImport();
    const mock = makeSpawnMock({ pid: 99001 });
    const captures = [
      { id: 'c1', variable_input: 'in1', response: 'out1' },
      { id: 'c2', variable_input: 'in2', response: 'out2' },
    ];
    const job = await startDistillJob({
      tenant: 'tenant_a',
      namespace: 'ns_a',
      captures,
      spawnOverride: mock.fn,
    });
    assert.equal(job.kind, 'distill');
    assert.equal(job.pid, 99001);
    assert.equal(job.status, 'running');
    assert.ok(job.log_path);
    assert.ok(fs.existsSync(job.log_path));
    assert.equal(mock.calls.length, 1);
  } finally {
    restore();
    cleanup();
  }
});

test('W364 #2 — startDistillJob throws when captures missing', async () => {
  const { startDistillJob } = await freshImport();
  await assert.rejects(() => startDistillJob({ tenant: 't', namespace: 'ns', captures: [] }), /captures required/);
  await assert.rejects(() => startDistillJob({ tenant: 't', namespace: 'ns' }), /captures required/);
});

test('W364 #3 — spawned worker argv contains spec/seeds/out/mode/student-base', async () => {
  const { tmp, cleanup } = withTmpDir();
  const restore = withEnv({
    KOLM_DISTILL_TMP_DIR: path.join(tmp, 'workspace'),
    KOLM_JOBS_DIR: path.join(tmp, 'jobs'),
    KOLM_JOBS_FILE: path.join(tmp, 'jobs.jsonl'),
    KOLM_JOB_LOG_DIR: path.join(tmp, 'logs'),
  });
  try {
    const { startDistillJob } = await freshImport();
    const mock = makeSpawnMock();
    await startDistillJob({
      tenant: 't', namespace: 'n',
      captures: [{ id: 'c1', variable_input: 'x', response: 'y' }],
      baseModel: 'Qwen/Qwen2.5-0.5B',
      spawnOverride: mock.fn,
    });
    const argv = mock.calls[0].args;
    // First arg is the worker script path; remaining are --flag=value.
    assert.match(argv[0], /distill\.mjs$/);
    const joined = argv.join(' ');
    assert.match(joined, /--spec=/);
    assert.match(joined, /--seeds=/);
    assert.match(joined, /--out=/);
    assert.match(joined, /--mode=/);
    assert.match(joined, /--student-base=Qwen\/Qwen2\.5-0\.5B/);
    assert.match(joined, /--max-rows=/);
  } finally {
    restore();
    cleanup();
  }
});

test('W364 #4 — job meta has pair_count + tmp_dir + out_dir + mode', async () => {
  const { tmp, cleanup } = withTmpDir();
  const restore = withEnv({
    KOLM_DISTILL_TMP_DIR: path.join(tmp, 'workspace'),
    KOLM_JOBS_DIR: path.join(tmp, 'jobs'),
    KOLM_JOBS_FILE: path.join(tmp, 'jobs.jsonl'),
    KOLM_JOB_LOG_DIR: path.join(tmp, 'logs'),
  });
  try {
    const { startDistillJob } = await freshImport();
    const mock = makeSpawnMock();
    const captures = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i}`, variable_input: `in${i}`, response: `out${i}`,
    }));
    const job = await startDistillJob({
      tenant: 't', namespace: 'n', captures, spawnOverride: mock.fn,
    });
    assert.equal(job.meta.pair_count, 3);
    assert.ok(job.meta.tmp_dir);
    assert.ok(job.meta.out_dir);
    assert.ok(['stub', 'collect', 'full'].includes(job.meta.mode));
    assert.equal(job.meta.tenant, 't');
    assert.equal(job.meta.namespace, 'n');
  } finally {
    restore();
    cleanup();
  }
});

test('W364 #5 — mode picks: stub | collect | full', async () => {
  const { tmp, cleanup } = withTmpDir();
  const baseEnv = {
    KOLM_DISTILL_TMP_DIR: path.join(tmp, 'workspace'),
    KOLM_JOBS_DIR: path.join(tmp, 'jobs'),
    KOLM_JOBS_FILE: path.join(tmp, 'jobs.jsonl'),
    KOLM_JOB_LOG_DIR: path.join(tmp, 'logs'),
  };
  const cap = [{ id: 'c', variable_input: 'i', response: 'o' }];
  try {
    // No teacher key => stub.
    {
      const restore = withEnv(baseEnv);
      try {
        const { startDistillJob } = await freshImport();
        const mock = makeSpawnMock();
        const job = await startDistillJob({ tenant: 't', namespace: 'n', captures: cap, spawnOverride: mock.fn });
        assert.equal(job.meta.mode, 'stub');
        const args = mock.calls[0].args.join(' ');
        assert.match(args, /--mode=stub/);
      } finally { restore(); }
    }
    // Teacher key set => collect.
    {
      const restore = withEnv({ ...baseEnv, ANTHROPIC_API_KEY: 'sk-mock' });
      try {
        const { startDistillJob } = await freshImport();
        const mock = makeSpawnMock();
        const job = await startDistillJob({ tenant: 't', namespace: 'n', captures: cap, spawnOverride: mock.fn });
        assert.equal(job.meta.mode, 'collect');
        const args = mock.calls[0].args.join(' ');
        assert.match(args, /--mode=collect/);
        assert.match(args, /--teacher=anthropic:claude/);
      } finally { restore(); }
    }
    // KOLM_DISTILL_FULL=1 + teacher set => full.
    {
      const restore = withEnv({ ...baseEnv, OPENAI_API_KEY: 'sk-mock', KOLM_DISTILL_FULL: '1' });
      try {
        const { startDistillJob } = await freshImport();
        const mock = makeSpawnMock();
        const job = await startDistillJob({ tenant: 't', namespace: 'n', captures: cap, spawnOverride: mock.fn });
        assert.equal(job.meta.mode, 'full');
        const args = mock.calls[0].args.join(' ');
        assert.match(args, /--mode=full/);
      } finally { restore(); }
    }
  } finally {
    cleanup();
  }
});

test('W364 #6 — from-captures handler no longer emits 503 distill_bridge_not_configured', () => {
  const marker = "r.post('/v1/distill/from-captures'";
  const idx = ROUTER_SRC.indexOf(marker);
  assert.ok(idx > 0, 'POST handler must be present');
  const slice = ROUTER_SRC.slice(idx, idx + 8000);
  assert.doesNotMatch(slice, /distill_bridge_not_configured/);
  // The in-tree worker import + startDistillJob call must be present.
  assert.match(slice, /distill-bridge\.js/);
  assert.match(slice, /startDistillJob/);
  assert.match(slice, /poll_url/);
});
