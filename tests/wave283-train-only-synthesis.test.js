// W283 — synthesis must only see train rows; manifest must carry
// synthesis_input_hash so an external auditor can prove no holdout leaked
// into the teacher.
//
// Asserts BEHAVIOR:
//   1) The `positives` array passed to ctx.synthesize is the train slice,
//      NOT the full positives array (smaller, deterministic).
//   2) seed_provenance.synthesis_input_hash is populated and equals
//      hashSeeds(train_rows). This proves what the teacher saw.
//   3) The hash is reproducible from the same seeds.jsonl + split_seed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('W283 synthesis receives only train rows, not full positives', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w283-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w283-out-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  // Need enough rows that the holdout slice is non-empty.
  const examples = Array.from({ length: 50 }, (_, i) => ({
    input: 'echo input ' + i,
    output: 'echo input ' + i,
  }));
  let captured_synth_positives = null;
  const job = createJob({
    task: 'echo train-only synthesis',
    examples,
    tenant: 't_w283_a',
    k_threshold: 0.50,
  });
  const recipeSource = 'function generate(input, lib){ return input; }';
  const ctx = {
    examples,
    synthesize: async ({ positives }) => {
      captured_synth_positives = positives;
      return {
        accepted: true,
        source: recipeSource,
        source_hash: 'abc',
        pass_rate_positive: 1.0,
        quality_score: 0.99,
        latency_p50_us: 5,
        size_bytes: recipeSource.length,
        strategy: 'pattern',
      };
    },
    recall: null,
    registry: null,
    outDir,
  };
  await runJob(job, ctx);
  const fresh = getJob(job.id, 't_w283_a');
  assert.equal(fresh.status, 'completed', `expected completed, got ${fresh.status} (err=${fresh.error})`);
  assert.ok(captured_synth_positives, 'synthesize must have been called');
  // 50 positives × 0.2 holdout ratio → ~10 holdout, ~40 train.
  assert.ok(captured_synth_positives.length < 50,
    `synthesis saw ${captured_synth_positives.length} rows but ALL ${examples.length} were given; holdout leaked into teacher`);
  assert.ok(captured_synth_positives.length >= 30,
    `synthesis got too few rows (${captured_synth_positives.length}) — train slice should be ~80%`);
});

test('W283 manifest seed_provenance.synthesis_input_hash equals train_hash', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w283-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w283-out-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const examples = Array.from({ length: 50 }, (_, i) => ({
    input: 'echo ' + i,
    output: 'echo ' + i,
  }));
  const job = createJob({
    task: 'echo synth-hash check',
    examples,
    tenant: 't_w283_b',
    k_threshold: 0.50,
  });
  const recipeSource = 'function generate(input, lib){ return input; }';
  const ctx = {
    examples,
    synthesize: async () => ({
      accepted: true,
      source: recipeSource,
      source_hash: 'xyz',
      pass_rate_positive: 1.0,
      quality_score: 0.99,
      latency_p50_us: 5,
      size_bytes: recipeSource.length,
      strategy: 'pattern',
    }),
    recall: null,
    registry: null,
    outDir,
  };
  await runJob(job, ctx);
  const fresh = getJob(job.id, 't_w283_b');
  assert.equal(fresh.status, 'completed', `expected completed, got ${fresh.status} (err=${fresh.error})`);
  const sp = fresh.seed_provenance;
  assert.ok(sp, 'seed_provenance must be present');
  assert.ok(sp.synthesis_input_hash, 'synthesis_input_hash must be present in seed_provenance');
  assert.equal(sp.synthesis_input_hash, sp.train_hash,
    'when the teacher saw only train rows, synthesis_input_hash MUST equal train_hash');
});

test('W283 synthesis_input_hash is deterministic across runs', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w283-'));
  const outDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w283-out-'));
  const outDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w283-out-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const examples = Array.from({ length: 50 }, (_, i) => ({
    input: 'identical input ' + i,
    output: 'identical input ' + i,
  }));
  const recipeSource = 'function generate(input, lib){ return input; }';
  const buildCtx = (outDir) => ({
    examples,
    synthesize: async () => ({
      accepted: true,
      source: recipeSource,
      source_hash: 'h',
      pass_rate_positive: 1.0,
      quality_score: 0.99,
      latency_p50_us: 5,
      size_bytes: recipeSource.length,
      strategy: 'pattern',
    }),
    recall: null,
    registry: null,
    outDir,
  });
  const j1 = createJob({ task: 'same task', examples, tenant: 't_w283_c1', k_threshold: 0.50 });
  await runJob(j1, buildCtx(outDir1));
  const f1 = getJob(j1.id, 't_w283_c1');
  const j2 = createJob({ task: 'same task', examples, tenant: 't_w283_c2', k_threshold: 0.50 });
  await runJob(j2, buildCtx(outDir2));
  const f2 = getJob(j2.id, 't_w283_c2');
  assert.equal(f1.status, 'completed');
  assert.equal(f2.status, 'completed');
  assert.equal(f1.seed_provenance.synthesis_input_hash, f2.seed_provenance.synthesis_input_hash,
    'synthesis_input_hash must be deterministic across runs given identical positives');
});

test('W283 compile.js calls prepareSeedSplit before synthesize (source check)', async () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..', 'src/compile.js'), 'utf8');
  // The order must be: split-then-synth. Look for prepareSeedSplit call ahead
  // of ctx.synthesize so the teacher can only ever see train rows.
  const splitIdx = src.indexOf('prepareSeedSplit');
  const synthIdx = src.indexOf('ctx.synthesize');
  assert.ok(splitIdx > 0, 'compile.js must import or call prepareSeedSplit');
  assert.ok(synthIdx > 0, 'compile.js must call ctx.synthesize');
  assert.ok(splitIdx < synthIdx,
    `prepareSeedSplit must appear before ctx.synthesize in compile.js (got split@${splitIdx} synth@${synthIdx})`);
});
