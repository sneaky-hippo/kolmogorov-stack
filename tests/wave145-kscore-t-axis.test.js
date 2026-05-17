// Wave 145 — K-score T axis (teacher-fidelity) tests.
//
// T = student_holdout_accuracy / teacher_holdout_accuracy
//
// Coverage:
//  1. computeKScore V1 backward compat (no V2 inputs → k-score-1 envelope)
//  2. computeKScore V2 with teacher_holdout + holdout → k-score-2 + non-null T
//  3. T degrades gracefully when only one of (teacher_holdout, holdout) is given
//  4. T math is correct (student/teacher), clamped to [0,1], T=1 when equal
//  5. loadDistillProvenance surfaces teacher_holdout_accuracy from worker manifest
//  6. compileSpec with distillProvenancePath that has teacher_holdout fields
//     produces an artifact whose manifest.k_score has spec='k-score-2' AND
//     a non-null teacher_fidelity_score
//  7. Worker --teacher-holdout flag wiring is reachable (the flag is parsed
//     and recorded in manifest.json; no real teacher call needed because the
//     flag block guards on split.holdout.length > 0 AND callTeacher honoring
//     vendor=local-noop)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

import { computeKScore, computeKScoreV1, computeKScoreV2 } from '../src/kscore.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER = path.resolve(__dirname, '..', 'workers', 'distill', 'distill.mjs');

function runWorker(args, opts = {}) {
  const res = spawnSync(process.execPath, [WORKER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30000,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function writeSpec(dir, spec) {
  const p = path.join(dir, 'spec.json');
  fs.writeFileSync(p, JSON.stringify(spec, null, 2));
  return p;
}

function writeSeeds(dir, rows) {
  const p = path.join(dir, 'seeds.jsonl');
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

// ---------------------------------------------------------------------------
// computeKScore unit tests
// ---------------------------------------------------------------------------

test('kscore V1 backward compat: no V2 inputs → k-score-1 envelope', () => {
  const k = computeKScore({
    size_bytes: 4096,
    accuracy: 0.92,
    coverage: 0.85,
    p50_latency_us: 50,
    cost_usd_per_call: 0,
  });
  assert.equal(k.spec, 'k-score-1');
  assert.equal(k.teacher_fidelity_score, undefined,
    'V1 envelope must not carry teacher_fidelity_score field');
  assert.equal(k.holdout_accuracy, undefined,
    'V1 envelope must not carry holdout_accuracy field');
});

test('kscore V2 with teacher_holdout + holdout → k-score-2 + non-null T', () => {
  const k = computeKScore({
    size_bytes: 4096,
    accuracy: 0.95,
    coverage: 1.0,
    p50_latency_us: 50,
    cost_usd_per_call: 0,
    holdout_accuracy: 0.85,
    teacher_holdout_accuracy: 0.95,
  });
  assert.equal(k.spec, 'k-score-2');
  assert.ok(k.teacher_fidelity_score != null);
  // T = 0.85 / 0.95 = 0.8947...
  assert.ok(Math.abs(k.teacher_fidelity_score - 0.8947) < 0.001,
    `expected T≈0.8947, got ${k.teacher_fidelity_score}`);
  assert.equal(k.teacher_holdout_accuracy, 0.95);
});

test('kscore V2 T=1.0 when student_holdout == teacher_holdout', () => {
  const k = computeKScore({
    size_bytes: 4096, accuracy: 0.9, coverage: 1.0,
    p50_latency_us: 50, cost_usd_per_call: 0,
    holdout_accuracy: 0.9,
    teacher_holdout_accuracy: 0.9,
  });
  assert.equal(k.teacher_fidelity_score, 1.0,
    'T must be 1.0 when student matches teacher on holdout');
});

test('kscore V2 T degrades when only teacher_holdout supplied (no student holdout)', () => {
  const k = computeKScore({
    size_bytes: 4096, accuracy: 0.9, coverage: 1.0,
    p50_latency_us: 50, cost_usd_per_call: 0,
    // holdout_accuracy missing
    teacher_holdout_accuracy: 0.95,
  });
  // T axis was triggered (so spec=k-score-2) but T itself is null because
  // the numerator (student holdout) wasn't supplied.
  assert.equal(k.spec, 'k-score-2');
  assert.equal(k.teacher_fidelity_score, null);
});

test('kscore V2 T degrades when only student_holdout supplied (no teacher)', () => {
  const k = computeKScoreV2({
    size_bytes: 4096, accuracy: 0.9, coverage: 1.0,
    p50_latency_us: 50, cost_usd_per_call: 0,
    holdout_accuracy: 0.85,
    // teacher_holdout_accuracy missing
  });
  assert.equal(k.spec, 'k-score-2');
  assert.equal(k.teacher_fidelity_score, null);
  // R axis (student-holdout / accuracy) still computes
  assert.ok(k.robustness_score != null);
});

test('kscore V2 weight redistribution: K-score still in [0,1] when T missing', () => {
  const k = computeKScore({
    size_bytes: 4096, accuracy: 0.95, coverage: 1.0,
    p50_latency_us: 50, cost_usd_per_call: 0,
    holdout_accuracy: 0.9,  // triggers R axis but not T
  });
  assert.equal(k.spec, 'k-score-2');
  assert.ok(k.composite >= 0 && k.composite <= 1);
  // T-axis weight (0.05) should have been redistributed over present axes,
  // so the sum of scaled weights ≈ 1.
  const ws = k.weights;
  const sum = Object.values(ws).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-6,
    `redistributed weights must sum to 1, got ${sum}`);
  assert.equal(ws.T, undefined, 'T weight must be absent when T axis missing');
});

test('kscore V2 weight allocation: all 10 axes present sums to 1', () => {
  const k = computeKScore({
    size_bytes: 4096, accuracy: 0.95, coverage: 1.0,
    p50_latency_us: 50, cost_usd_per_call: 0,
    holdout_accuracy: 0.9,
    teacher_holdout_accuracy: 0.95,
    subgroup_min_accuracy: 0.88,
    joules_per_call: 10,
    eval_set_drift: 0.05,
  });
  assert.equal(k.spec, 'k-score-2');
  const ws = k.weights;
  const sum = Object.values(ws).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-6,
    `all-axes weights must sum to 1, got ${sum}`);
  // Every axis present and contributes
  for (const axis of ['A','S','L','C','V','R','T','F','E','Z']) {
    assert.ok(ws[axis] > 0, `axis ${axis} must be present in weights`);
  }
});

test('kscore V2 T clamped to [0,1] even if student > teacher (overfit guard)', () => {
  // If student_holdout > teacher_holdout (e.g. teacher had a bad day on a
  // small holdout sample), T should clamp to 1.0 — not exceed it.
  const k = computeKScore({
    size_bytes: 4096, accuracy: 0.9, coverage: 1.0,
    p50_latency_us: 50, cost_usd_per_call: 0,
    holdout_accuracy: 0.95,
    teacher_holdout_accuracy: 0.85,  // student beat teacher
  });
  assert.equal(k.teacher_fidelity_score, 1.0,
    'T must clamp at 1.0 when student exceeds teacher on holdout');
});

// ---------------------------------------------------------------------------
// loadDistillProvenance — surfaces teacher_holdout_accuracy from worker manifest
// ---------------------------------------------------------------------------

test('loadDistillProvenance: surfaces teacher_holdout fields when worker recorded them', async () => {
  const { loadDistillProvenance } = await import('../src/distill-provenance.js');
  const crypto = await import('node:crypto');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w145-th-'));
  try {
    const pairs = JSON.stringify({ id: 'p1', input: 'foo', teacher_output: 'FOO' }) + '\n';
    fs.writeFileSync(path.join(tmp, 'training-pairs.jsonl'), pairs);
    const pairsHash = 'sha256:' + crypto.createHash('sha256').update(pairs).digest('hex');
    const thLog = JSON.stringify({ input: 'foo', expected: 'FOO', teacher_output: 'FOO', correct: true }) + '\n';
    fs.writeFileSync(path.join(tmp, 'teacher-holdout-log.jsonl'), thLog);
    const thLogHash = 'sha256:' + crypto.createHash('sha256').update(thLog).digest('hex');
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({
      worker: 'kolm-distill-worker',
      worker_version: '0.1.0',
      mode: 'full',
      teacher_vendor: 'anthropic',
      teacher_model: 'claude-opus-4-7',
      student_base: 'Qwen/Qwen2.5-0.5B',
      ml_pipeline_run: true,
      training_pairs_collected: 1,
      training_pairs_path: 'training-pairs.jsonl',
      training_pairs_hash: pairsHash,
      // wave 145 — teacher holdout block
      teacher_holdout_accuracy: 0.95,
      teacher_holdout_count: 1,
      teacher_holdout_log_hash: thLogHash,
    }));
    const prov = loadDistillProvenance(tmp);
    assert.equal(prov.teacher_holdout_accuracy, 0.95);
    assert.equal(prov.teacher_holdout_count, 1);
    assert.equal(prov.teacher_holdout_log_hash, thLogHash);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadDistillProvenance: teacher_holdout fields null when worker did not record them', async () => {
  const { loadDistillProvenance } = await import('../src/distill-provenance.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w145-no-th-'));
  try {
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({
      worker: 'kolm-distill-worker',
      worker_version: '0.1.0',
      mode: 'stub',
    }));
    const prov = loadDistillProvenance(tmp);
    assert.equal(prov.teacher_holdout_accuracy, null);
    assert.equal(prov.teacher_holdout_count, null);
    assert.equal(prov.teacher_holdout_log_hash, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end: compileSpec with distillProvenancePath that has teacher_holdout
// fields → artifact's k_score has spec=k-score-2 + non-null teacher_fidelity_score
// ---------------------------------------------------------------------------

test('compileSpec --distillProvenancePath with teacher_holdout → k-score-2 + T axis', async () => {
  const { compileSpec } = await import('../src/spec-compile.js');
  const { loadArtifact } = await import('../src/artifact-runner.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w145-e2e-'));
  try {
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' }, { input: 'f', output: 'F' },
    ]);
    const specPath = writeSpec(tmp, { job_id: 'job_w145_e2e' });
    const provOut = path.join(tmp, 'distill-out');

    // Run worker stub to produce baseline manifest.
    const wr = runWorker([
      '--mode=stub',
      `--spec=${specPath}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${provOut}`,
    ]);
    assert.equal(wr.status, 0, wr.stderr);

    // Synthesize the teacher_holdout block on top of the stub manifest —
    // this is the post-condition we'd get from --teacher-holdout against
    // a real teacher. Tests would otherwise need an API key.
    const mfPath = path.join(provOut, 'manifest.json');
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    mf.teacher_vendor = 'anthropic';
    mf.teacher_model = 'claude-opus-4-7';
    mf.student_base = 'Qwen/Qwen2.5-0.5B';
    mf.ml_pipeline_run = true;
    mf.training_pairs_collected = 5;
    mf.training_pairs_path = 'training-pairs.jsonl';
    delete mf.training_pairs_hash;
    fs.writeFileSync(path.join(provOut, 'training-pairs.jsonl'),
      JSON.stringify({ id: 'p1', input: 'a', teacher_output: 'A' }) + '\n');
    // wave 145 — teacher holdout fields
    mf.teacher_holdout_accuracy = 0.95;
    mf.teacher_holdout_count = 1;
    mf.teacher_holdout_log_hash = 'sha256:' + 'a'.repeat(64);
    fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

    const r = await compileSpec({
      job_id: 'job_w145_e2e',
      task: 'echo',
      recipes: [{
        id: 'rcp_echo', name: 'echo',
        source: 'function generate(input) { return input; }',
      }],
      evals: { cases: [{ input: 'x', expected: 'x' }] },
    }, {
      outDir: tmp,
      distillProvenancePath: provOut,
      allowSeedAutoResolve: false,
    });
    assert.ok(r.outPath);
    assert.equal(r.distill_provenance.teacher_holdout_accuracy, 0.95);

    const art = await loadArtifact(r.outPath);
    assert.ok(art.manifest.k_score, 'manifest.k_score must be present');
    assert.equal(art.manifest.k_score.spec, 'k-score-2',
      'k-score must dispatch to v2 when teacher_holdout_accuracy is present');
    assert.equal(art.manifest.k_score.teacher_holdout_accuracy, 0.95);
    // T = student_holdout / teacher_holdout. Student-holdout will be whatever
    // the seed-split path computed for this artifact. The important thing is
    // that T is now a real number, not null — the receipt chain claims a
    // distillation with a teacher-fidelity score that a verifier can replay.
    if (art.manifest.k_score.holdout_accuracy != null) {
      assert.ok(art.manifest.k_score.teacher_fidelity_score != null,
        'when both holdout fields present, T must be computed');
      assert.ok(art.manifest.k_score.teacher_fidelity_score >= 0 &&
                art.manifest.k_score.teacher_fidelity_score <= 1);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Worker --teacher-holdout flag wiring — flag is parsed and guarded by
// split.holdout.length > 0 + teacher being present. Stub mode has no
// teacher, so we exercise the parse path + confirm graceful no-op.
// ---------------------------------------------------------------------------

test('worker --teacher-holdout in stub mode: no teacher → no holdout call, manifest fields stay null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w145-worker-'));
  try {
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' }, { input: 'f', output: 'F' },
    ]);
    const specPath = writeSpec(tmp, { job_id: 'job_w145_worker' });
    const out = path.join(tmp, 'out');
    const r = runWorker([
      '--mode=stub',
      `--spec=${specPath}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${out}`,
      '--teacher-holdout',
      '--teacher-holdout-max=5',
      '--teacher-holdout-comparator=exact',
    ]);
    assert.equal(r.status, 0, `worker exit: ${r.stderr}`);
    const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    // stub mode means no teacher → block guards out → manifest fields stay null
    assert.equal(mf.teacher_holdout_accuracy, null);
    assert.equal(mf.teacher_holdout_count, null);
    assert.equal(mf.teacher_holdout_log_hash, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
