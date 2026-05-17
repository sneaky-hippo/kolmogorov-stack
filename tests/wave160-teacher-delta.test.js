// Wave 160 (Q+3c) — K-score teacher-delta axis T + A/T reporting.
//
// Covers:
//   1. computeKScoreV2 emits teacher_fidelity_score when both holdout
//      accuracies present; emits null when either missing.
//   2. Binder check #16 (K-score teacher-delta):
//      a. absent when manifest.lineage.source !== 'distillation'
//      b. fail on distillation_method ∈ {lora, qlora, full-ft} when
//         teacher_holdout_accuracy or holdout_accuracy missing
//      c. pass with A/T detail when both present (lora / qlora / full-ft)
//      d. warn for prompt-distill when fidelity inputs absent
//      e. pass for prompt-distill when fidelity inputs present
//   3. Compliance binder renderKScore emits the T row when V2 envelope
//      carries teacher_fidelity_score; V1 envelope continues to render
//      only 5 axes (backward compat).
//   4. A/T detail string is mathematically accurate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildAndZip } from '../src/artifact.js';
import { buildBinder } from '../src/binder.js';
import { buildLineage } from '../src/artifact-lineage.js';
import { computeKScoreV1, computeKScoreV2 } from '../src/kscore.js';

process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';

const TMP = path.join(os.tmpdir(), 'kolm-wave160-' + crypto.randomBytes(3).toString('hex'));
fs.mkdirSync(TMP, { recursive: true });

function baseSpec(overrides = {}) {
  return {
    job_id: 'job_w160_' + crypto.randomBytes(3).toString('hex'),
    task: 'wave160_teacher_delta',
    base_model: 'none',
    recipes: [{
      id: 'rcp', name: 'echo',
      source: 'function generate(i){ return { echo: String(i && i.text || i) }; }',
      source_hash: 'deadbeef', version_id: 1, tags: [],
    }],
    training_stats: { distilled_pairs: 0, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0 },
    evals: { spec: 'rs-1-evals', n: 0, cases: [] },
    outDir: TMP,
    artifact_class: 'rule',
    ...overrides,
  };
}

function namedCheck(checks, name) {
  return checks.find(c => c.name === name);
}

// ---------------------------------------------------------------------------
// 1. computeKScoreV2 T axis math
// ---------------------------------------------------------------------------
test('computeKScoreV2: emits teacher_fidelity_score = student_holdout / teacher_holdout', () => {
  const k = computeKScoreV2({
    size_bytes: 4096, accuracy: 1, coverage: 1,
    p50_latency_us: 50, cost_usd_per_call: 0,
    holdout_accuracy: 0.94, teacher_holdout_accuracy: 0.97,
  });
  assert.equal(k.spec, 'k-score-2');
  assert.equal(k.teacher_holdout_accuracy, 0.97);
  // 0.94 / 0.97 = 0.96907... -> rounded to 4 decimals = 0.9691
  assert.equal(k.teacher_fidelity_score, 0.9691);
});

test('computeKScoreV2: teacher_fidelity_score = null when teacher_holdout_accuracy missing', () => {
  const k = computeKScoreV2({
    size_bytes: 4096, accuracy: 1, coverage: 1,
    p50_latency_us: 50, cost_usd_per_call: 0,
    holdout_accuracy: 0.94, // no teacher_holdout_accuracy
  });
  assert.equal(k.spec, 'k-score-2');
  assert.equal(k.teacher_fidelity_score, null);
});

test('computeKScoreV2: teacher_fidelity_score = null when holdout_accuracy missing', () => {
  const k = computeKScoreV2({
    size_bytes: 4096, accuracy: 1, coverage: 1,
    p50_latency_us: 50, cost_usd_per_call: 0,
    teacher_holdout_accuracy: 0.97, // no holdout_accuracy
  });
  assert.equal(k.spec, 'k-score-2');
  assert.equal(k.teacher_fidelity_score, null);
});

test('computeKScoreV2: T axis clamped to 1.0 when student outscores teacher', () => {
  const k = computeKScoreV2({
    size_bytes: 4096, accuracy: 1, coverage: 1,
    p50_latency_us: 50, cost_usd_per_call: 0,
    holdout_accuracy: 0.98, teacher_holdout_accuracy: 0.90,
  });
  // 0.98 / 0.90 = 1.088... clamped to 1.0
  assert.equal(k.teacher_fidelity_score, 1.0);
});

test('computeKScoreV1: never emits teacher_fidelity_score (legacy envelope)', () => {
  const k = computeKScoreV1({
    size_bytes: 4096, accuracy: 1, coverage: 1,
    p50_latency_us: 50, cost_usd_per_call: 0,
  });
  assert.equal(k.spec, 'k-score-1');
  assert.equal(k.teacher_fidelity_score, undefined);
});

// ---------------------------------------------------------------------------
// 2. Binder check #16: K-score teacher-delta gate
// ---------------------------------------------------------------------------
test('check #16: absent when no distillation lineage', async () => {
  const built = await buildAndZip(baseSpec());
  const r = await buildBinder(built.outPath);
  assert.equal(namedCheck(r.checks, 'K-score teacher-delta (A/T)'), undefined,
    'check #16 should not fire on non-distillation artifact');
});

test('check #16: absent when lineage source is rebuild (not distillation)', async () => {
  const lineage = buildLineage({
    source: 'rebuild',
    notes: 'test: non-distillation lineage',
  });
  const built = await buildAndZip(baseSpec({ lineage }));
  const r = await buildBinder(built.outPath);
  assert.equal(namedCheck(r.checks, 'K-score teacher-delta (A/T)'), undefined,
    'check #16 should only fire when lineage.source=distillation');
});

test('check #16: fails for distillation_method=lora when teacher_holdout_accuracy missing', async () => {
  const lineage = buildLineage({
    source: 'distillation',
    teacher: { vendor: 'anthropic', model: 'claude-opus-4-7' },
    student_base: { repo: 'Qwen/Qwen2.5-0.5B' },
    distillation_method: 'lora',
  });
  // Note: training_stats has holdout_accuracy but NO teacher_holdout_accuracy.
  const built = await buildAndZip(baseSpec({
    lineage,
    training_stats: {
      distilled_pairs: 5, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      teacher_vendor: 'anthropic',
      teacher_model: 'claude-opus-4-7',
      student_base: 'qwen2.5-0.5b',
      distillation_method: 'lora',
      holdout_accuracy: 0.94, // student score present
      // teacher_holdout_accuracy intentionally absent — should fail check #16
    },
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'K-score teacher-delta (A/T)');
  assert.ok(c, 'check #16 present');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /distillation_method=lora/);
  assert.match(c.detail, /teacher_holdout_accuracy/);
  assert.match(c.detail, /--teacher-holdout/);
});

test('check #16: fails for distillation_method=qlora when both holdout fields missing', async () => {
  const lineage = buildLineage({
    source: 'distillation',
    teacher: { vendor: 'openai', model: 'gpt-5' },
    student_base: { repo: 'meta-llama/Llama-3.2-1B' },
    distillation_method: 'qlora',
  });
  const built = await buildAndZip(baseSpec({
    lineage,
    training_stats: {
      distilled_pairs: 5, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      teacher_vendor: 'openai',
      teacher_model: 'gpt-5',
      student_base: 'llama-3.2-1b',
      distillation_method: 'qlora',
      // both holdout fields absent
    },
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'K-score teacher-delta (A/T)');
  assert.ok(c, 'check #16 present');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /distillation_method=qlora/);
});

test('check #16: fails for distillation_method=full-ft when holdout fields missing', async () => {
  const lineage = buildLineage({
    source: 'distillation',
    teacher: { vendor: 'google', model: 'gemini-2.5-pro' },
    student_base: { repo: 'google/gemma-2-2b' },
    distillation_method: 'full-ft',
  });
  const built = await buildAndZip(baseSpec({
    lineage,
    training_stats: {
      distilled_pairs: 5, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      teacher_vendor: 'google',
      teacher_model: 'gemini-2.5-pro',
      student_base: 'gemma-2-2b',
      distillation_method: 'full-ft',
    },
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'K-score teacher-delta (A/T)');
  assert.ok(c, 'check #16 present');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /distillation_method=full-ft/);
});

test('check #16: passes with A/T detail when both holdout accuracies present (lora)', async () => {
  const lineage = buildLineage({
    source: 'distillation',
    teacher: { vendor: 'anthropic', model: 'claude-opus-4-7' },
    student_base: { repo: 'Qwen/Qwen2.5-0.5B', revision: 'abc1234' },
    distillation_method: 'lora',
  });
  const built = await buildAndZip(baseSpec({
    lineage,
    training_stats: {
      distilled_pairs: 5, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      teacher_vendor: 'anthropic',
      teacher_model: 'claude-opus-4-7',
      student_base: 'qwen2.5-0.5b',
      distillation_method: 'lora',
      holdout_accuracy: 0.94,
      teacher_holdout_accuracy: 0.97,
    },
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'K-score teacher-delta (A/T)');
  assert.ok(c, 'check #16 present');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /student_holdout=0\.9400/);
  assert.match(c.detail, /teacher_holdout=0\.9700/);
  // A/T = 0.94/0.97 = 0.9690721... -> formatted to 4 decimals = 0.9691
  assert.match(c.detail, /A\/T=0\.9691/);
  assert.match(c.detail, /T axis = 0\.9691/);
});

test('check #16: warns for prompt-distill when fidelity inputs absent', async () => {
  const lineage = buildLineage({
    source: 'distillation',
    teacher: { vendor: 'anthropic', model: 'claude-sonnet-4-6' },
    student_base: { repo: 'Qwen/Qwen2.5-0.5B' },
    distillation_method: 'prompt-distill',
  });
  const built = await buildAndZip(baseSpec({
    lineage,
    training_stats: {
      distilled_pairs: 0, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      teacher_vendor: 'anthropic',
      teacher_model: 'claude-sonnet-4-6',
      student_base: 'qwen2.5-0.5b',
      distillation_method: 'prompt-distill',
      // no holdout fields — but prompt-distill makes this a warn, not a fail
    },
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'K-score teacher-delta (A/T)');
  assert.ok(c, 'check #16 present');
  assert.equal(c.status, 'warn', c.detail);
  assert.match(c.detail, /prompt-distill/);
  assert.match(c.detail, /informational only/);
});

test('check #16: passes for prompt-distill when both holdout fields present', async () => {
  const lineage = buildLineage({
    source: 'distillation',
    teacher: { vendor: 'anthropic', model: 'claude-sonnet-4-6' },
    student_base: { repo: 'Qwen/Qwen2.5-0.5B' },
    distillation_method: 'prompt-distill',
  });
  const built = await buildAndZip(baseSpec({
    lineage,
    training_stats: {
      distilled_pairs: 0, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      teacher_vendor: 'anthropic',
      teacher_model: 'claude-sonnet-4-6',
      student_base: 'qwen2.5-0.5b',
      distillation_method: 'prompt-distill',
      holdout_accuracy: 0.88,
      teacher_holdout_accuracy: 0.95,
    },
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'K-score teacher-delta (A/T)');
  assert.ok(c, 'check #16 present');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /\[prompt-distill\]/);
  // A/T = 0.88 / 0.95 = 0.92631... -> 0.9263
  assert.match(c.detail, /A\/T=0\.9263/);
});

// ---------------------------------------------------------------------------
// 3. renderKScore: V2 axis rendering in the compliance binder HTML
// ---------------------------------------------------------------------------
test('renderKScore: V2 envelope renders T axis row when teacher_fidelity_score present', async () => {
  const lineage = buildLineage({
    source: 'distillation',
    teacher: { vendor: 'anthropic', model: 'claude-opus-4-7' },
    student_base: { repo: 'Qwen/Qwen2.5-0.5B' },
    distillation_method: 'lora',
  });
  const built = await buildAndZip(baseSpec({
    lineage,
    training_stats: {
      distilled_pairs: 5, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      teacher_vendor: 'anthropic',
      teacher_model: 'claude-opus-4-7',
      student_base: 'qwen2.5-0.5b',
      distillation_method: 'lora',
      holdout_accuracy: 0.94,
      teacher_holdout_accuracy: 0.97,
    },
  }));
  const { html } = await buildBinder(built.outPath);
  assert.match(html, /Teacher-fidelity \(A\/T\)/);
  assert.match(html, /k-score-2/);
  // Composite formula line is the V2 expression.
  assert.match(html, /K2 = 0\.30·A/);
});

test('renderKScore: V1 envelope renders only 5 axes (backward compat)', async () => {
  // No lineage → no V2 axes supplied → V1 envelope.
  const built = await buildAndZip(baseSpec());
  const { html } = await buildBinder(built.outPath);
  assert.match(html, /k-score-1/);
  assert.equal(/Teacher-fidelity/.test(html), false, 'V1 should not render T axis');
  assert.equal(/Robustness/.test(html), false, 'V1 should not render R axis');
  assert.match(html, /K = 0\.40·A/);
});

test('renderKScore: V2 envelope renders R axis when holdout_accuracy present without teacher_holdout', async () => {
  const lineage = buildLineage({
    source: 'distillation',
    teacher: { vendor: 'local', model: 'qwen2.5-72b' },
    student_base: { repo: 'Qwen/Qwen2.5-0.5B' },
    distillation_method: 'prompt-distill',
  });
  const built = await buildAndZip(baseSpec({
    lineage,
    training_stats: {
      distilled_pairs: 0, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      teacher_vendor: 'local',
      teacher_model: 'qwen2.5-72b',
      student_base: 'qwen2.5-0.5b',
      distillation_method: 'prompt-distill',
      holdout_accuracy: 0.88,
      // no teacher_holdout_accuracy → T axis null
    },
  }));
  const { html } = await buildBinder(built.outPath);
  // R axis present (because holdout_accuracy supplied).
  assert.match(html, /Robustness/);
  // T axis row absent (because teacher_holdout_accuracy missing).
  assert.equal(/Teacher-fidelity/.test(html), false, 'T axis absent when teacher_holdout_accuracy missing');
});
