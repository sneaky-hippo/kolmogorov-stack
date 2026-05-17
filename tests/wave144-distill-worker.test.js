// Wave J — tests for the isolated distill worker at workers/distill/.
// We exercise --doctor + --mode=stub so the test suite never needs a real
// teacher API key or a Python ML stack. The full --mode=full path is
// covered by an integration test in CI when those toolchains are present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

import { parseTeacherSpec } from '../workers/distill/teacher-bridge.mjs';

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
// teacher-bridge unit
// ---------------------------------------------------------------------------
test('parseTeacherSpec: vendor:model parses cleanly', () => {
  assert.deepEqual(parseTeacherSpec('anthropic:claude-opus-4-7'),
                   { vendor: 'anthropic', model: 'claude-opus-4-7' });
  assert.deepEqual(parseTeacherSpec('openai:gpt-5'),
                   { vendor: 'openai', model: 'gpt-5' });
  assert.deepEqual(parseTeacherSpec('local:Qwen/Qwen2.5-7B-Instruct'),
                   { vendor: 'local', model: 'Qwen/Qwen2.5-7B-Instruct' });
});

test('parseTeacherSpec: bare model defaults to anthropic', () => {
  assert.deepEqual(parseTeacherSpec('claude-opus-4-7'),
                   { vendor: 'anthropic', model: 'claude-opus-4-7' });
});

test('parseTeacherSpec: empty raises', () => {
  assert.throws(() => parseTeacherSpec(''));
  assert.throws(() => parseTeacherSpec(null));
});

// ---------------------------------------------------------------------------
// --doctor: read-only readiness probe
// ---------------------------------------------------------------------------
test('worker --doctor: emits JSON readiness report (no inputs required)', () => {
  const r = runWorker(['--doctor']);
  assert.equal(r.status, 0, `doctor exit; stderr=${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert.ok(typeof j.node_version === 'string');
  assert.ok(typeof j.python_ok === 'boolean');
  assert.ok(typeof j.torch_ok === 'boolean');
  assert.ok(typeof j.transformers_ok === 'boolean');
  assert.ok(typeof j.ready_for_full_pipeline === 'boolean');
});

// ---------------------------------------------------------------------------
// --mode=stub: offline split + manifest, never calls teacher
// ---------------------------------------------------------------------------
test('worker --mode=stub: writes split.json + manifest with ml_pipeline_run=false', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-distill-stub-'));
  try {
    writeSpec(tmp, { job_id: 'job_stub_test', task: 'echo' });
    writeSeeds(tmp, [
      { input: 'alpha', output: 'alpha' },
      { input: 'bravo', output: 'bravo' },
      { input: 'charlie', output: 'charlie' },
      { input: 'delta', output: 'delta' },
      { input: 'echo', output: 'echo' },
    ]);
    const out = path.join(tmp, 'out');
    const r = runWorker([
      '--mode=stub',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${out}`,
    ]);
    assert.equal(r.status, 0, `stub exit; stderr=${r.stderr}`);
    const split = JSON.parse(fs.readFileSync(path.join(out, 'split.json'), 'utf8'));
    assert.equal(split.split_seed, 1);
    assert.equal(split.train_count + split.holdout_count, 5);
    assert.match(split.train_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(split.holdout_hash, /^sha256:[0-9a-f]{64}$/);

    const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(mf.worker, 'kolm-distill-worker');
    assert.equal(mf.mode, 'stub');
    assert.equal(mf.ml_pipeline_run, false);
    assert.equal(mf.spec_id, 'job_stub_test');
    assert.equal(mf.training_pairs_collected, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('worker --mode=stub: deterministic split — same seed produces identical hashes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-distill-det-'));
  try {
    writeSpec(tmp, { job_id: 'job_det', task: 'echo' });
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' }, { input: 'f', output: 'F' },
    ]);
    const run1 = path.join(tmp, 'out1');
    const run2 = path.join(tmp, 'out2');
    runWorker([ '--mode=stub', `--spec=${path.join(tmp, 'spec.json')}`,
                `--seeds=${path.join(tmp, 'seeds.jsonl')}`, `--out=${run1}` ]);
    runWorker([ '--mode=stub', `--spec=${path.join(tmp, 'spec.json')}`,
                `--seeds=${path.join(tmp, 'seeds.jsonl')}`, `--out=${run2}` ]);
    const s1 = JSON.parse(fs.readFileSync(path.join(run1, 'split.json'), 'utf8'));
    const s2 = JSON.parse(fs.readFileSync(path.join(run2, 'split.json'), 'utf8'));
    assert.equal(s1.train_hash, s2.train_hash);
    assert.equal(s1.holdout_hash, s2.holdout_hash);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI error paths
// ---------------------------------------------------------------------------
test('worker: collect mode without --teacher fails with hint', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-distill-noteach-'));
  try {
    writeSpec(tmp, { job_id: 'x' });
    writeSeeds(tmp, [{ input: 'a', output: 'A' }]);
    const r = runWorker([
      '--mode=collect',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${path.join(tmp, 'out')}`,
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /teacher/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('worker: missing --spec / --seeds / --out fails fast', () => {
  const r = runWorker(['--mode=stub']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /required/);
});

test('worker: --mode=invalid fails with hint', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-distill-bad-'));
  try {
    writeSpec(tmp, {});
    writeSeeds(tmp, [{ input: 'a', output: 'A' }]);
    const r = runWorker([
      '--mode=banana',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${path.join(tmp, 'out')}`,
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown --mode/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Seeds normalization
// ---------------------------------------------------------------------------
test('worker: reads both {input,output} canonical and {prompt,completion} legacy', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-distill-norm-'));
  try {
    writeSpec(tmp, {});
    // Mix both shapes plus a malformed line that should be skipped.
    const p = path.join(tmp, 'seeds.jsonl');
    fs.writeFileSync(p,
      JSON.stringify({ input: 'a', output: 'A' }) + '\n' +
      JSON.stringify({ prompt: 'b', completion: 'B' }) + '\n' +
      '{ malformed\n' +
      JSON.stringify({ input: 'c', output: 'C' }) + '\n'
    );
    const out = path.join(tmp, 'out');
    const r = runWorker([
      '--mode=stub',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${p}`,
      `--out=${out}`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const split = JSON.parse(fs.readFileSync(path.join(out, 'split.json'), 'utf8'));
    assert.equal(split.train_count + split.holdout_count, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Stub-mode manifest stays small (no full split inline)
// ---------------------------------------------------------------------------
test('worker --mode=stub: manifest carries split SUMMARY only (no inline row content)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-distill-summary-'));
  try {
    writeSpec(tmp, { job_id: 'job_summary' });
    // Use longer payloads so an inline-split bug would show up in size.
    const rows = [];
    for (let i = 0; i < 25; i++) {
      rows.push({ input: 'INPUT_PAYLOAD_'.padEnd(400, 'x') + i, output: 'OUTPUT_PAYLOAD_'.padEnd(400, 'y') + i });
    }
    writeSeeds(tmp, rows);
    const out = path.join(tmp, 'out');
    const r = runWorker([
      '--mode=stub',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${out}`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.ok(mf.split && typeof mf.split === 'object', 'split summary present');
    assert.ok(!('train' in mf.split), 'manifest.split must not embed train row content');
    assert.ok(!('holdout' in mf.split), 'manifest.split must not embed holdout row content');
    assert.equal(typeof mf.split.train_hash, 'string');
    assert.equal(typeof mf.split.holdout_hash, 'string');
    // The full split rows live in train.jsonl + holdout.jsonl on disk so
    // downstream consumers (kolm compile --distill-provenance) can re-hash.
    assert.ok(fs.existsSync(path.join(out, 'train.jsonl')));
    assert.ok(fs.existsSync(path.join(out, 'holdout.jsonl')));
    // Manifest should stay small (<5KB) even with 25×800-char rows.
    const sz = fs.statSync(path.join(out, 'manifest.json')).size;
    assert.ok(sz < 5000, `manifest grew unexpectedly: ${sz} bytes`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadDistillProvenance — receipt-chain anchor
// ---------------------------------------------------------------------------
test('loadDistillProvenance: stub-mode dir → lineage block (source=rebuild, no false distillation claim)', async () => {
  const { loadDistillProvenance } = await import('../src/distill-provenance.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-prov-stub-'));
  try {
    writeSpec(tmp, { job_id: 'job_prov_stub' });
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' },
    ]);
    const out = path.join(tmp, 'out');
    const r = runWorker([
      '--mode=stub',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${out}`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const prov = loadDistillProvenance(out);
    assert.equal(prov.training_pairs_collected, 0);
    assert.equal(prov.ml_pipeline_run, false);
    // No teacher/student in stub mode → lineage source defaults to 'rebuild'
    // not 'distillation' so we never lie about what happened.
    assert.equal(prov.lineage.source, 'rebuild');
    assert.match(prov.lineage.hash, /^[0-9a-f]{16}$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadDistillProvenance: synthetic distill manifest with teacher+student → lineage source=distillation', async () => {
  const { loadDistillProvenance } = await import('../src/distill-provenance.js');
  const crypto = await import('node:crypto');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-prov-full-'));
  try {
    // Synthesize a worker-shaped manifest + training-pairs.jsonl with stable
    // hashes so we test the hash-recompute path without spinning up a teacher.
    const pairs = [
      JSON.stringify({ id: 'p1', input: 'foo', teacher_output: 'FOO' }),
      JSON.stringify({ id: 'p2', input: 'bar', teacher_output: 'BAR' }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(tmp, 'training-pairs.jsonl'), pairs);
    const pairsHash = 'sha256:' + crypto.createHash('sha256').update(pairs).digest('hex');
    const mapHash = 'sha256:' + crypto.createHash('sha256').update('redaction-map-contents').digest('hex');
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({
      worker: 'kolm-distill-worker',
      worker_version: '0.1.0',
      mode: 'full',
      spec_id: 'job_prov_full',
      teacher_vendor: 'anthropic',
      teacher_model: 'claude-opus-4-7',
      student_base: 'Qwen/Qwen2.5-0.5B',
      ml_pipeline_run: true,
      training_pairs_collected: 2,
      training_pairs_path: 'training-pairs.jsonl',
      training_pairs_hash: pairsHash,
      redaction_map_hash: mapHash,
      split: { train_count: 2, holdout_count: 1, train_hash: 'sha256:00', holdout_hash: 'sha256:11', split_seed: 1 },
    }, null, 2));
    const prov = loadDistillProvenance(tmp);
    assert.equal(prov.teacher_vendor, 'anthropic');
    assert.equal(prov.teacher_model, 'claude-opus-4-7');
    assert.equal(prov.student_base, 'Qwen/Qwen2.5-0.5B');
    assert.equal(prov.training_pairs_collected, 2);
    assert.equal(prov.ml_pipeline_run, true);
    assert.equal(prov.lineage.source, 'distillation');
    assert.equal(prov.lineage.teacher.vendor, 'anthropic');
    assert.equal(prov.lineage.teacher.model, 'claude-opus-4-7');
    assert.equal(prov.lineage.student_base.repo, 'Qwen/Qwen2.5-0.5B');
    assert.equal(prov.lineage.distillation_method, 'lora');
    // training_corpus_hash is full sha256, recomputed from disk to prove the
    // worker's recorded hash matches the bytes we actually have.
    assert.match(prov.lineage.training_corpus_hash, /^[0-9a-f]{64}$/);
    // Redaction map hash is truncated to hex16 inside lineage block.
    assert.equal(prov.lineage.teacher.redaction_map_hash.length, 16);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadDistillProvenance: hash drift between manifest + training-pairs file is fatal', async () => {
  const { loadDistillProvenance } = await import('../src/distill-provenance.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-prov-drift-'));
  try {
    fs.writeFileSync(path.join(tmp, 'training-pairs.jsonl'),
      JSON.stringify({ input: 'real', teacher_output: 'REAL' }) + '\n');
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
      // Wrong hash claim — file content does NOT hash to this.
      training_pairs_hash: 'sha256:' + 'f'.repeat(64),
    }));
    assert.throws(() => loadDistillProvenance(tmp), /hash drift/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end: distill-worker stub → compileSpec --distill-provenance →
// artifact carries lineage block bound into manifest.
// ---------------------------------------------------------------------------
test('compileSpec --distillProvenancePath: lineage block lands in built artifact', async () => {
  const { compileSpec } = await import('../src/spec-compile.js');
  const { loadArtifact } = await import('../src/artifact-runner.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-distill-e2e-'));
  try {
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' }, { input: 'f', output: 'F' },
    ]);
    const specPath = writeSpec(tmp, { job_id: 'job_e2e_distill' });
    const provOut = path.join(tmp, 'distill-out');
    const wr = runWorker([
      '--mode=stub',
      `--spec=${specPath}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${provOut}`,
    ]);
    assert.equal(wr.status, 0, wr.stderr);

    // Pre-populate a teacher/student so we can prove the lineage block lands
    // as source='distillation', not 'rebuild'.
    const mfPath = path.join(provOut, 'manifest.json');
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    mf.teacher_vendor = 'anthropic';
    mf.teacher_model = 'claude-opus-4-7';
    mf.student_base = 'Qwen/Qwen2.5-0.5B';
    mf.ml_pipeline_run = true;
    mf.training_pairs_collected = 5;
    fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
    fs.writeFileSync(path.join(provOut, 'training-pairs.jsonl'),
      JSON.stringify({ id: 'p1', input: 'a', teacher_output: 'A' }) + '\n');
    mf.training_pairs_path = 'training-pairs.jsonl';
    delete mf.training_pairs_hash; // let loadDistillProvenance compute fresh.
    fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

    const r = await compileSpec({
      job_id: 'job_e2e_distill',
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
    assert.ok(r.distill_provenance);
    assert.equal(r.distill_provenance.teacher_vendor, 'anthropic');
    assert.equal(r.distill_provenance.lineage.source, 'distillation');

    const art = await loadArtifact(r.outPath);
    assert.ok(art.manifest.lineage, 'manifest.lineage must be present');
    assert.equal(art.manifest.lineage.source, 'distillation');
    assert.equal(art.manifest.lineage.teacher.vendor, 'anthropic');
    assert.equal(art.manifest.lineage.teacher.model, 'claude-opus-4-7');
    assert.equal(art.manifest.lineage.student_base.repo, 'Qwen/Qwen2.5-0.5B');
    assert.equal(art.manifest.lineage.distillation_method, 'lora');
    assert.match(art.manifest.lineage.hash, /^[0-9a-f]{16}$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
