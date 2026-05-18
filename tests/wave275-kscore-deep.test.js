// W275 — K-score deep work: public bench + leaderboard + v2 axes UI surface.
// Behavior assertions, not page-marker tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

test('W275 src/kscore-bench.js exports the v1 frozen suite', async () => {
  const mod = await import('../src/kscore-bench.js');
  assert.equal(mod.BENCH_SPEC_ID, 'kolm-bench-v1');
  assert.equal(mod.BENCH_SCHEMA_VERSION, 1);
  assert.equal(mod.BENCH_FROZEN_AT, '2026-05-18T00:00:00Z');
  assert.equal(mod.BENCH_CASES.length, 30, 'kolm-bench v1 is exactly 30 cases');
  // 8 cls + 7 ext + 8 gen + 7 code = 30
  const byClass = mod.BENCH_CASES.reduce((acc, c) => { acc[c.cls] = (acc[c.cls] || 0) + 1; return acc; }, {});
  assert.equal(byClass.classification, 8);
  assert.equal(byClass.extraction, 7);
  assert.equal(byClass.generation, 8);
  assert.equal(byClass.code, 7);
});

test('W275 every case has id, cls, input, reference, axis_targets', async () => {
  const { BENCH_CASES } = await import('../src/kscore-bench.js');
  for (const c of BENCH_CASES) {
    assert.ok(c.id, `case missing id`);
    assert.ok(c.cls, `case ${c.id} missing cls`);
    assert.ok(c.input, `case ${c.id} missing input`);
    assert.ok(c.reference != null, `case ${c.id} missing reference`);
    assert.ok(c.axis_targets, `case ${c.id} missing axis_targets`);
  }
});

test('W275 case ids are unique', async () => {
  const { BENCH_CASES } = await import('../src/kscore-bench.js');
  const ids = new Set();
  for (const c of BENCH_CASES) {
    assert.ok(!ids.has(c.id), `duplicate case id: ${c.id}`);
    ids.add(c.id);
  }
  assert.equal(ids.size, 30);
});

test('W275 runBench with referenceScorer produces deterministic pass', async () => {
  const { runBench, referenceScorer, BENCH_CASES } = await import('../src/kscore-bench.js');
  const res = await runBench(referenceScorer);
  assert.equal(res.spec, 'kolm-bench-v1');
  assert.equal(res.n_cases, 30);
  assert.equal(res.results.length, 30);
  assert.ok(res.summary, 'summary attached');
  assert.ok(res.summary.composite_mean >= 0.85, `referenceScorer composite_mean ${res.summary.composite_mean} should clear gate`);
  // Run twice — identical determinism (same inputs, same axis_targets).
  const res2 = await runBench(referenceScorer);
  assert.equal(res2.summary.composite_mean, res.summary.composite_mean);
  assert.equal(res2.summary.pass, res.summary.pass);
});

test('W275 runBench summary has per-class breakdown', async () => {
  const { runBench, referenceScorer } = await import('../src/kscore-bench.js');
  const res = await runBench(referenceScorer);
  assert.ok(res.summary.by_class.classification, 'by_class.classification present');
  assert.equal(res.summary.by_class.classification.n, 8);
  assert.equal(res.summary.by_class.extraction.n, 7);
  assert.equal(res.summary.by_class.generation.n, 8);
  assert.equal(res.summary.by_class.code.n, 7);
});

test('W275 axis_means surface in summary for v2 axes', async () => {
  const { runBench, referenceScorer } = await import('../src/kscore-bench.js');
  const res = await runBench(referenceScorer);
  assert.ok(res.summary.axis_means.A != null);
  assert.ok(res.summary.axis_means.S != null);
  assert.ok(res.summary.axis_means.L != null);
  assert.ok(res.summary.axis_means.C != null);
  assert.ok(res.summary.axis_means.V != null);
  // referenceScorer supplies holdout + subgroup + joules + drift,
  // so R/F/E/Z should be populated. No teacher → T is null.
  assert.ok(res.summary.axis_means.R != null, 'R should be present when holdout_accuracy supplied');
  assert.ok(res.summary.axis_means.F != null, 'F should be present when subgroup_min_accuracy supplied');
  assert.ok(res.summary.axis_means.E != null, 'E should be present when joules_per_call supplied');
  assert.ok(res.summary.axis_means.Z != null, 'Z should be present when eval_set_drift supplied');
  assert.equal(res.summary.axis_means.T, null, 'T should be null without teacher_holdout_accuracy');
});

test('W275 runBench rejects non-function scorer', async () => {
  const { runBench } = await import('../src/kscore-bench.js');
  await assert.rejects(() => runBench(null));
  await assert.rejects(() => runBench('not a function'));
});

test('W275 runBench surfaces per-case errors instead of throwing', async () => {
  const { runBench } = await import('../src/kscore-bench.js');
  const throwingScorer = () => { throw new Error('scorer blew up'); };
  const res = await runBench(throwingScorer);
  assert.equal(res.results.length, 30);
  for (const r of res.results) {
    assert.equal(r.passed, false);
    assert.match(r.error, /scorer blew up/);
  }
  assert.equal(res.summary.pass, 0);
  assert.equal(res.summary.fail, 30);
});

test('W275 loadLeaderboard reads public/kscore-leaderboard.json', async () => {
  const { loadLeaderboard } = await import('../src/kscore-bench.js');
  const data = await loadLeaderboard(path.join(ROOT, 'public', 'kscore-leaderboard.json'));
  assert.equal(data.spec, 'kolm-bench-v1');
  assert.ok(Array.isArray(data.rows));
  assert.ok(data.rows.length >= 3, 'seed leaderboard ships >= 3 rows');
  for (const r of data.rows) {
    assert.ok(r.rank >= 1);
    assert.ok(r.artifact);
    assert.ok(r.k_score);
    assert.ok(typeof r.k_score.composite === 'number');
    assert.ok(r.k_score.composite >= 0.85, `row ${r.artifact} should ship`);
  }
});

test('W275 loadLeaderboard returns empty rows for ENOENT path', async () => {
  const { loadLeaderboard, BENCH_SPEC_ID } = await import('../src/kscore-bench.js');
  const data = await loadLeaderboard(path.join(ROOT, 'public', 'does-not-exist-leaderboard.json'));
  assert.equal(data.spec, BENCH_SPEC_ID);
  assert.deepEqual(data.rows, []);
});

test('W275 kolm-bench.json public spec mirrors src/kscore-bench BENCH_CASES', async () => {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'kolm-bench.json'), 'utf8'));
  const { BENCH_CASES, BENCH_SPEC_ID } = await import('../src/kscore-bench.js');
  assert.equal(json.spec, BENCH_SPEC_ID);
  assert.equal(json.cases.length, 30);
  for (let i = 0; i < 30; i++) {
    assert.equal(json.cases[i].id, BENCH_CASES[i].id, `case ${i} id mismatch`);
    assert.equal(json.cases[i].cls, BENCH_CASES[i].cls);
  }
});

test('W275 public/kscore-bench.html renders core bench facts', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'kscore-bench.html'), 'utf8');
  assert.match(html, /kolm-bench v1/);
  assert.match(html, /30 frozen cases/);
  // Required cross-links
  assert.match(html, /\/kscore-leaderboard/);
  assert.match(html, /\/kolm-bench\.json/);
  assert.match(html, /\/k-score/);
  // 10-axis enumeration
  for (const ax of ['A', 'S', 'L', 'C', 'V', 'R', 'F', 'T', 'E', 'Z']) {
    assert.match(html, new RegExp(`>${ax}<`), `axis ${ax} missing from bench page`);
  }
  // Canonical
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/kscore-bench"/);
});

test('W275 public/kscore-leaderboard.html fetches JSON + renders header', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'kscore-leaderboard.html'), 'utf8');
  assert.match(html, /K-score leaderboard/);
  assert.match(html, /\/kscore-leaderboard\.json/, 'page fetches the leaderboard JSON');
  assert.match(html, /kolm-bench-v1/);
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/kscore-leaderboard"/);
  // Submission flow surfaced
  assert.match(html, /kolm bench/);
  assert.match(html, /--submit/);
});

test('W275 public/k-score.html documents v2 axes + bench callout', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'k-score.html'), 'utf8');
  // v2 axes section enumerates R/F/T/E/Z
  assert.match(html, /Robustness/);
  assert.match(html, /Fairness/);
  assert.match(html, /Teacher fidelity/);
  assert.match(html, /Energy/);
  assert.match(html, /Drift/);
  // Bench callout
  assert.match(html, /kolm-bench v1/);
  assert.match(html, /\/kscore-bench/);
  assert.match(html, /\/kscore-leaderboard/);
});

test('W275 vercel.json routes kscore-bench + kscore-leaderboard', () => {
  const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const rewrites = vj.rewrites || [];
  const has = (src) => rewrites.some(r => r.source === src);
  assert.ok(has('/kscore-bench'), '/kscore-bench rewrite missing');
  assert.ok(has('/kscore-leaderboard'), '/kscore-leaderboard rewrite missing');
});

test('W275 leaderboard JSON has stable schema for the page renderer', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'kscore-leaderboard.json'), 'utf8'));
  assert.ok(data.spec);
  assert.ok(data.schema_version);
  assert.ok(Array.isArray(data.rows));
  for (const r of data.rows) {
    // Page reads: rank, artifact, base_model, k_score.composite, axis fields, signature
    assert.ok(typeof r.rank === 'number');
    assert.ok(typeof r.artifact === 'string');
    assert.ok(r.k_score);
    assert.ok(typeof r.k_score.composite === 'number');
    assert.ok(typeof r.k_score.gate === 'number');
    assert.ok(typeof r.signature === 'string');
  }
});

test('W275 summarizeBench gate parameter is respected', async () => {
  const { runBench, referenceScorer } = await import('../src/kscore-bench.js');
  const res = await runBench(referenceScorer, { gate: 0.99 });
  // A 0.99 gate should fail every case (referenceScorer is ~0.95 composite).
  assert.ok(res.summary.fail >= res.summary.pass, '0.99 gate fails most cases');
  assert.equal(res.summary.gate, 0.99);
});
