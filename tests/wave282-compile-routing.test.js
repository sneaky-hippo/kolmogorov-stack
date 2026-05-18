// W282 — /v1/compile now routes through src/spec-compile.js.
//
// Asserts BEHAVIOR not page copy:
//   1) compile with no positive examples → job status='failed' +
//      error_code='KOLM_E_NO_SEEDS'. No artifact produced.
//   2) compile with positive examples → goes through compileSpec, produces
//      a real artifact with seed_provenance populated.
//   3) synthesizeStarterEvals + pickInputsForTask are GONE from src/compile.js
//      (they were the stub-eval path that the audit C1 finding called out).
//   4) src/compile.js imports compileSpec from spec-compile.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');

test('W282 compile.js no longer contains synthesizeStarterEvals or pickInputsForTask', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/compile.js'), 'utf8');
  assert.equal(src.includes('synthesizeStarterEvals'), false, 'synthesizeStarterEvals must be gone (stub-eval path)');
  assert.equal(src.includes('pickInputsForTask'), false, 'pickInputsForTask must be gone (keyword heuristic fake inputs)');
  assert.equal(src.includes('auto_synthesized'), false, 'auto_synthesized eval-case marker must be gone');
});

test('W282 compile.js imports compileSpec from spec-compile.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/compile.js'), 'utf8');
  assert.match(src, /import\s*\{[^}]*compileSpec[^}]*\}\s*from\s*['"]\.\/spec-compile\.js['"]/);
});

test('W282 compile.js no longer calls buildAndZip directly', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/compile.js'), 'utf8');
  // The only build path is now compileSpec, which delegates to buildAndZip
  // internally. compile.js itself must not import or call it.
  assert.equal(src.includes('buildAndZip'), false, 'buildAndZip must be reached only via compileSpec now');
});

test('W282 compile.js sets KOLM_E_NO_SEEDS error code in source', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/compile.js'), 'utf8');
  assert.ok(src.includes('KOLM_E_NO_SEEDS'), 'no-seeds refusal error code must be present');
  assert.ok(src.includes('no_seeds_provided'), 'human-readable error string must be present');
});

test('W282 runJob behavior: no positive examples → failed + KOLM_E_NO_SEEDS', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w282-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const job = createJob({
    task: 'redact PII from email',
    examples: [],
    tenant: 't_w282_a',
  });
  const ctx = {
    examples: [],
    synthesize: async () => ({ accepted: false }),
    recall: null,
    registry: null,
    outDir: process.env.KOLM_DATA_DIR,
  };
  await runJob(job, ctx);
  const fresh = getJob(job.id, 't_w282_a');
  assert.equal(fresh.status, 'failed');
  assert.equal(fresh.error_code, 'KOLM_E_NO_SEEDS');
  assert.match(fresh.error, /no_seeds_provided/);
  assert.equal(fresh.artifact_path, null);
});

test('W282 runJob behavior: synthesis fail → KOLM_E_RECIPE_SYNTHESIS_FAILED (not stub artifact)', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w282-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const job = createJob({
    task: 'redact PII from email',
    examples: [{ input: 'foo bar', output: 'foo bar' }],
    tenant: 't_w282_b',
  });
  const ctx = {
    examples: [{ input: 'foo bar', output: 'foo bar' }],
    synthesize: async () => ({ accepted: false }),
    recall: null,
    registry: null,
    outDir: process.env.KOLM_DATA_DIR,
  };
  await runJob(job, ctx);
  const fresh = getJob(job.id, 't_w282_b');
  assert.equal(fresh.status, 'failed');
  assert.equal(fresh.error_code, 'KOLM_E_RECIPE_SYNTHESIS_FAILED');
  assert.equal(fresh.artifact_path, null);
});

test('W282 runJob behavior: real examples + accepted synthesis → artifact w/ seed_provenance', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w282-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w282-out-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const examples = Array.from({ length: 8 }, (_, i) => ({
    input: 'echo input ' + i,
    output: 'echo input ' + i,
  }));
  const job = createJob({
    task: 'echo task',
    examples,
    tenant: 't_w282_c',
    k_threshold: 0.50,
  });
  // Deterministic identity recipe — passes the verifier quality gate.
  const recipeSource = 'function generate(input, lib){ return input; }';
  const ctx = {
    examples,
    synthesize: async () => ({
      accepted: true,
      source: recipeSource,
      source_hash: 'abc123',
      pass_rate_positive: 1.0,
      reject_rate_negative: 1.0,
      quality_score: 0.99,
      latency_p50_us: 5,
      size_bytes: recipeSource.length,
      strategy: 'identity',
    }),
    recall: null,
    registry: null,
    outDir,
  };
  await runJob(job, ctx);
  const fresh = getJob(job.id, 't_w282_c');
  assert.equal(fresh.status, 'completed', `expected completed, got ${fresh.status} (err=${fresh.error})`);
  assert.ok(fresh.artifact_path, 'artifact_path must be set');
  assert.ok(fresh.k_score >= 0.50, `k_score ${fresh.k_score} below 0.50`);
  assert.ok(fresh.seed_provenance, 'seed_provenance must be populated');
  assert.ok(fresh.seed_provenance.seeds_hash, 'seeds_hash must be present');
  assert.ok(fresh.seed_provenance.train_hash, 'train_hash must be present');
  assert.ok(fresh.seed_provenance.holdout_hash, 'holdout_hash must be present');
  assert.ok(fresh.seed_provenance.leakage_report_hash, 'leakage_report_hash must be present');
  // Honest taxonomy: pattern-mode synthesis = no teacher = class='rule'.
  // Only strategy='claude' (LLM teacher) flips to 'synthesized_rule'.
  assert.equal(fresh.manifest?.artifact_class, 'rule');
});

test('W282 runJob behavior: strategy=claude → artifact_class=synthesized_rule + teacher attribution', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w282-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w282-out-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const examples = Array.from({ length: 8 }, (_, i) => ({
    input: 'echo ' + i,
    output: 'echo ' + i,
  }));
  const job = createJob({ task: 'echo claude task', examples, tenant: 't_w282_d', k_threshold: 0.50 });
  const recipeSource = 'function generate(input, lib){ return input; }';
  const ctx = {
    examples,
    synthesize: async () => ({
      accepted: true,
      source: recipeSource,
      source_hash: 'def456',
      pass_rate_positive: 1.0,
      quality_score: 0.99,
      latency_p50_us: 5,
      size_bytes: recipeSource.length,
      strategy: 'claude',
    }),
    recall: null,
    registry: null,
    outDir,
  };
  await runJob(job, ctx);
  const fresh = getJob(job.id, 't_w282_d');
  assert.equal(fresh.status, 'completed', `expected completed, got ${fresh.status} (err=${fresh.error})`);
  assert.equal(fresh.manifest?.artifact_class, 'synthesized_rule');
  // Teacher attribution must be in manifest.training (recipe-class.js #185).
  const t = fresh.manifest?.training || {};
  assert.ok(t.teacher_vendor || t.teacher_model || t.synthesized_by,
    'synthesized_rule artifact must record teacher attribution');
});
