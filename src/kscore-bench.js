// K-score public benchmark suite (kolm-bench v1).
//
// W275 — K-score deep work. The public bench is the answer to:
//   "Is K-score a real metric or an internal vanity number?"
// Anyone with kolm installed can run `kolm bench`, get axis-level scores
// against a frozen 30-case suite, and post the resulting receipt to
// /kscore-leaderboard. The suite is deterministic + reproducible: same
// inputs, same scorer, same outputs forever. Version-pinned via
// BENCH_SPEC_ID so an axis tweak rolls into bench v2 without breaking
// historical receipts.
//
// Design notes:
// - 4 task classes (classification, extraction, generation, code) × 7-8
//   cases each = 30 frozen cases. Inputs are short; the bench tests scorer
//   honesty, not model capability — it's the contract between artifact
//   and gate, not a leaderboard for the underlying model.
// - Each case carries a frozen reference output + per-axis target.
//   The scorer function receives `{input, reference, axis_targets}` and
//   must return `{output, accuracy, latency_us, size_bytes, coverage,
//   cost_usd_per_call, holdout_accuracy?, subgroup_min_accuracy?,
//   teacher_holdout_accuracy?, joules_per_call?, eval_set_drift?}`.
// - The summarizer computes per-class and overall K-score using
//   the same V1/V2 path the production gate uses.
// - Leaderboard rows are read-only here; submissions are signed
//   client-side (see cli/kolm.js cmdBench --submit) and processed by
//   src/router.js POST /v1/bench/submit.

import { computeKScoreV2 } from './kscore.js';

export const BENCH_SPEC_ID = 'kolm-bench-v1';
export const BENCH_SCHEMA_VERSION = 1;
export const BENCH_FROZEN_AT = '2026-05-18T00:00:00Z';

export const BENCH_CASES = [
  // ── Classification (sentiment + intent) ────────────────────────────────
  { id: 'cls-01', cls: 'classification', input: { text: 'this product is amazing, ten stars' }, reference: 'positive', axis_targets: { accuracy: 0.98, p50_latency_us: 80000 } },
  { id: 'cls-02', cls: 'classification', input: { text: 'broke after one week, never again' }, reference: 'negative', axis_targets: { accuracy: 0.98, p50_latency_us: 80000 } },
  { id: 'cls-03', cls: 'classification', input: { text: 'arrived on time, it works' }, reference: 'neutral', axis_targets: { accuracy: 0.90, p50_latency_us: 80000 } },
  { id: 'cls-04', cls: 'classification', input: { text: 'how do I reset my password?' }, reference: 'support_request', axis_targets: { accuracy: 0.95, p50_latency_us: 80000 } },
  { id: 'cls-05', cls: 'classification', input: { text: 'I want a refund' }, reference: 'refund_request', axis_targets: { accuracy: 0.95, p50_latency_us: 80000 } },
  { id: 'cls-06', cls: 'classification', input: { text: 'do you ship to germany?' }, reference: 'shipping_question', axis_targets: { accuracy: 0.92, p50_latency_us: 80000 } },
  { id: 'cls-07', cls: 'classification', input: { text: 'this is fraud, I never made this purchase' }, reference: 'dispute', axis_targets: { accuracy: 0.97, p50_latency_us: 80000 } },
  { id: 'cls-08', cls: 'classification', input: { text: 'thanks!' }, reference: 'acknowledgement', axis_targets: { accuracy: 0.85, p50_latency_us: 80000 } },

  // ── Extraction (PII / structured fields) ───────────────────────────────
  { id: 'ext-01', cls: 'extraction', input: { text: 'My name is Jane Doe, ssn 123-45-6789' }, reference: { name: 'Jane Doe', ssn: '123-45-6789' }, axis_targets: { accuracy: 0.98, coverage: 0.95 } },
  { id: 'ext-02', cls: 'extraction', input: { text: 'Call me at (555) 234-5678 anytime' }, reference: { phone: '(555) 234-5678' }, axis_targets: { accuracy: 0.95, coverage: 0.90 } },
  { id: 'ext-03', cls: 'extraction', input: { text: 'Patient John Smith, DOB 1985-03-12, MRN 4421' }, reference: { name: 'John Smith', dob: '1985-03-12', mrn: '4421' }, axis_targets: { accuracy: 0.96, coverage: 0.93 } },
  { id: 'ext-04', cls: 'extraction', input: { text: 'Invoice #INV-9921, total $1,420.50' }, reference: { invoice_id: 'INV-9921', amount: 1420.50 }, axis_targets: { accuracy: 0.97, coverage: 0.92 } },
  { id: 'ext-05', cls: 'extraction', input: { text: 'Email me at jane@example.com or jane.doe@corp.io' }, reference: { emails: ['jane@example.com', 'jane.doe@corp.io'] }, axis_targets: { accuracy: 0.95, coverage: 0.90 } },
  { id: 'ext-06', cls: 'extraction', input: { text: 'Meeting on March 15 at 2:30 PM EST' }, reference: { date: '2026-03-15', time: '14:30 EST' }, axis_targets: { accuracy: 0.90, coverage: 0.88 } },
  { id: 'ext-07', cls: 'extraction', input: { text: 'Address: 100 Main St, Springfield, IL 62701' }, reference: { street: '100 Main St', city: 'Springfield', state: 'IL', zip: '62701' }, axis_targets: { accuracy: 0.94, coverage: 0.91 } },

  // ── Generation (summarization + rewrite) ───────────────────────────────
  { id: 'gen-01', cls: 'generation', input: { task: 'summarize', text: 'The quarterly report shows revenue up 12% YoY driven by enterprise contracts; churn declined to 3.2%, with NRR at 118%.' }, reference: { contains: ['revenue up 12%', 'churn 3.2%', 'NRR 118%'] }, axis_targets: { accuracy: 0.88, coverage: 0.85 } },
  { id: 'gen-02', cls: 'generation', input: { task: 'rewrite_formal', text: 'hey wanna grab coffee tmrw?' }, reference: { contains: ['Would you like', 'tomorrow'] }, axis_targets: { accuracy: 0.85, coverage: 0.82 } },
  { id: 'gen-03', cls: 'generation', input: { task: 'translate_es', text: 'Where is the train station?' }, reference: { contains: ['estación', 'tren'] }, axis_targets: { accuracy: 0.92, coverage: 0.90 } },
  { id: 'gen-04', cls: 'generation', input: { task: 'summarize', text: 'Patient presented with fever 101.4, chills, and productive cough x 3 days. CXR shows RLL consolidation; started on amoxicillin 875mg BID.' }, reference: { contains: ['pneumonia', 'amoxicillin', 'RLL'] }, axis_targets: { accuracy: 0.91, coverage: 0.88 } },
  { id: 'gen-05', cls: 'generation', input: { task: 'rewrite_polite', text: 'this is wrong, fix it now' }, reference: { contains: ['could you', 'please'] }, axis_targets: { accuracy: 0.85, coverage: 0.82 } },
  { id: 'gen-06', cls: 'generation', input: { task: 'expand', text: 'Q3 strong' }, reference: { contains: ['Q3', 'performance', 'strong'] }, axis_targets: { accuracy: 0.80, coverage: 0.78 } },
  { id: 'gen-07', cls: 'generation', input: { task: 'redact_phi', text: 'Patient John Doe, MRN 4421, presented with chest pain.' }, reference: { contains: ['[NAME]', '[MRN]', 'chest pain'] }, axis_targets: { accuracy: 0.96, coverage: 0.94 } },
  { id: 'gen-08', cls: 'generation', input: { task: 'json_normalize', text: 'order id 88-22, qty 3' }, reference: { contains: ['"order_id"', '"qty": 3'] }, axis_targets: { accuracy: 0.93, coverage: 0.91 } },

  // ── Code (regex + simple function) ─────────────────────────────────────
  { id: 'code-01', cls: 'code', input: { task: 'regex_email' }, reference: '/^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$/', axis_targets: { accuracy: 0.95, coverage: 0.92 } },
  { id: 'code-02', cls: 'code', input: { task: 'fn_is_even', lang: 'js' }, reference: { contains: ['n % 2', 'return', '=== 0'] }, axis_targets: { accuracy: 0.96, coverage: 0.94 } },
  { id: 'code-03', cls: 'code', input: { task: 'fn_factorial', lang: 'py' }, reference: { contains: ['def factorial', 'return', 'n * factorial'] }, axis_targets: { accuracy: 0.93, coverage: 0.90 } },
  { id: 'code-04', cls: 'code', input: { task: 'sql_top_5_users' }, reference: { contains: ['SELECT', 'ORDER BY', 'LIMIT 5'] }, axis_targets: { accuracy: 0.94, coverage: 0.91 } },
  { id: 'code-05', cls: 'code', input: { task: 'regex_ipv4' }, reference: { contains: ['\\d{1,3}\\.', '\\d{1,3}'] }, axis_targets: { accuracy: 0.92, coverage: 0.89 } },
  { id: 'code-06', cls: 'code', input: { task: 'fn_clamp', lang: 'rust' }, reference: { contains: ['fn clamp', 'min', 'max'] }, axis_targets: { accuracy: 0.91, coverage: 0.88 } },
  { id: 'code-07', cls: 'code', input: { task: 'fix_off_by_one', lang: 'js' }, reference: { contains: ['<=', 'fixed'] }, axis_targets: { accuracy: 0.90, coverage: 0.87 } },
];

if (BENCH_CASES.length !== 30) {
  throw new Error(`kolm-bench v1 expects exactly 30 cases, got ${BENCH_CASES.length}`);
}

// Deterministic per-case scorer signature:
//   scorer(case) => Promise<{
//     output, accuracy, latency_us, size_bytes, coverage, cost_usd_per_call,
//     holdout_accuracy?, subgroup_min_accuracy?, teacher_holdout_accuracy?,
//     joules_per_call?, eval_set_drift?
//   }>
// `runBench` is a thin orchestrator: it does NOT cherry-pick or retry;
// every case must score exactly once, in declaration order.
export async function runBench(scorer, opts = {}) {
  if (typeof scorer !== 'function') {
    throw new Error('runBench: scorer must be a function (case) => Promise<scoreObj>');
  }
  const onCase = typeof opts.onCase === 'function' ? opts.onCase : () => {};
  const results = [];
  for (const c of BENCH_CASES) {
    const t0 = Date.now();
    let score = null;
    let error = null;
    try {
      score = await scorer(c);
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    }
    const wall_ms = Date.now() - t0;
    const row = { case_id: c.id, cls: c.cls, wall_ms };
    if (error) {
      row.error = error;
      row.passed = false;
    } else {
      row.score = score;
      // Pass = artifact's per-case k-score-V2 composite >= per-case gate.
      const ks = computeKScoreV2({
        accuracy: score.accuracy,
        size_bytes: score.size_bytes,
        coverage: score.coverage,
        p50_latency_us: score.latency_us,
        cost_usd_per_call: score.cost_usd_per_call ?? 0,
        holdout_accuracy: score.holdout_accuracy,
        subgroup_min_accuracy: score.subgroup_min_accuracy,
        teacher_holdout_accuracy: score.teacher_holdout_accuracy,
        joules_per_call: score.joules_per_call,
        eval_set_drift: score.eval_set_drift,
        recipe_class: score.recipe_class || 'rule',
        teacher_vendor: score.teacher_vendor,
        lenient_teacher_fidelity: true,
      });
      row.k_score = ks;
      row.passed = ks.composite >= (opts.gate ?? 0.85);
    }
    results.push(row);
    try { onCase(row); } catch {}
  }
  return {
    spec: BENCH_SPEC_ID,
    schema_version: BENCH_SCHEMA_VERSION,
    frozen_at: BENCH_FROZEN_AT,
    n_cases: BENCH_CASES.length,
    results,
    summary: summarizeBench(results, opts.gate ?? 0.85),
  };
}

export function summarizeBench(results, gate = 0.85) {
  const byClass = {};
  let pass = 0;
  let fail = 0;
  let axisSum = { A: 0, S: 0, L: 0, C: 0, V: 0, R: 0, F: 0, T: 0, E: 0, Z: 0 };
  let axisN   = { A: 0, S: 0, L: 0, C: 0, V: 0, R: 0, F: 0, T: 0, E: 0, Z: 0 };
  for (const r of results) {
    if (!byClass[r.cls]) byClass[r.cls] = { n: 0, pass: 0, fail: 0 };
    byClass[r.cls].n += 1;
    if (r.passed) { pass += 1; byClass[r.cls].pass += 1; } else { fail += 1; byClass[r.cls].fail += 1; }
    const ks = r.k_score;
    if (!ks) continue;
    const addAxis = (key, val) => { if (val == null) return; axisSum[key] += val; axisN[key] += 1; };
    addAxis('A', ks.accuracy);
    addAxis('S', ks.size_score);
    addAxis('L', ks.latency_score);
    addAxis('C', ks.cost_score);
    addAxis('V', ks.coverage);
    addAxis('R', ks.robustness_score);
    addAxis('F', ks.fairness_score);
    addAxis('T', ks.teacher_fidelity_score);
    addAxis('E', ks.energy_score);
    addAxis('Z', ks.drift_score);
  }
  const axis_means = {};
  for (const k of Object.keys(axisSum)) {
    axis_means[k] = axisN[k] ? Number((axisSum[k] / axisN[k]).toFixed(4)) : null;
  }
  const composite_mean = results.length
    ? Number((results.reduce((acc, r) => acc + (r.k_score ? r.k_score.composite : 0), 0) / results.length).toFixed(4))
    : 0;
  return {
    n: results.length,
    pass,
    fail,
    pass_rate: results.length ? Number((pass / results.length).toFixed(4)) : 0,
    by_class: byClass,
    axis_means,
    composite_mean,
    gate,
    ships: composite_mean >= gate,
  };
}

// Trivial reference scorer used for testing the orchestrator. Returns the
// frozen axis_targets verbatim so the bench passes for an idealized
// artifact, which is the contract we want the test suite to assert.
export function referenceScorer(c) {
  const t = c.axis_targets || {};
  return {
    output: c.reference,
    accuracy: t.accuracy ?? 0.95,
    coverage: t.coverage ?? 0.92,
    size_bytes: t.size_bytes ?? 32 * 1024 * 1024,
    latency_us: t.p50_latency_us ?? 80000,
    cost_usd_per_call: t.cost_usd_per_call ?? 0,
    holdout_accuracy: t.holdout_accuracy ?? (t.accuracy ? t.accuracy - 0.02 : 0.93),
    subgroup_min_accuracy: t.subgroup_min_accuracy ?? (t.accuracy ? t.accuracy - 0.04 : 0.91),
    joules_per_call: t.joules_per_call ?? 0.5,
    eval_set_drift: t.eval_set_drift ?? 0.02,
    recipe_class: 'rule',
  };
}

// Public leaderboard view. The JSON file lives at public/kscore-leaderboard.json
// and is the canonical read-only artifact. Submissions go through
// /v1/bench/submit and are appended server-side after signature check.
// Loader is fs-based so the CLI can read without HTTP; the page reads via
// fetch.
export async function loadLeaderboard(filePath) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const file = filePath || path.resolve(process.cwd(), 'public', 'kscore-leaderboard.json');
  try {
    const buf = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(buf);
    if (!data || !Array.isArray(data.rows)) throw new Error('leaderboard: missing .rows array');
    return data;
  } catch (e) {
    if (e && e.code === 'ENOENT') return { spec: BENCH_SPEC_ID, rows: [] };
    throw e;
  }
}

export default {
  BENCH_SPEC_ID,
  BENCH_SCHEMA_VERSION,
  BENCH_FROZEN_AT,
  BENCH_CASES,
  runBench,
  summarizeBench,
  referenceScorer,
  loadLeaderboard,
};
