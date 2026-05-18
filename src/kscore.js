// K-score: composite quality + production-fit score for a compiled .kolm.
// Extracted from src/artifact.js so the CLI, the trainer bridge, and the
// public verifier can compute K-scores without pulling the rest of the
// artifact module.
//
// v1 spec (current shipping): K = 0.40*A + 0.15*S + 0.15*L + 0.15*C + 0.15*V
//   A = accuracy on declared positives
//   S = size score        (smaller is better)
//   L = latency score     (faster is better)
//   C = cost score        (free is better)
//   V = eval coverage     (cases covered / cases declared)
//   ship gate: composite >= 0.85
//
// v2 spec (target architecture): adds five optional axes that, when supplied,
// shift the composite slightly without breaking v1 verification of old
// artifacts. v2 carries `spec: 'k-score-2'` so verifiers can dispatch.
//   R = robustness         (held-out accuracy / declared accuracy)
//   F = fairness           (lowest sub-group accuracy / declared accuracy)
//   E = energy             (1 / (1 + joules_per_call / 100))
//   Z = drift              (1 - eval-set drift vs. registry baseline)
//   T = teacher-fidelity   (student holdout accuracy / teacher holdout accuracy)
//
//   K2 = 0.30*A + 0.10*S + 0.10*L + 0.10*C + 0.10*V + 0.05*R + 0.05*T + 0.10*F + 0.05*E + 0.05*Z
//
// T (added wave 145) is the distillation-honesty axis: A/T ratio reported in
// the manifest makes the cost/quality tradeoff legible. 0.9 means student is
// at 90% of teacher accuracy on the same holdout. Required by Doc 7 §4.7 for
// cross-vendor distillation. Missing T (no teacher_holdout_accuracy supplied)
// degrades gracefully — the v2 redistribution rule reshuffles weight to the
// supplied axes.
//
// Both versions are normalized to [0..1] and gated at 0.85.

const V1_WEIGHTS = { A: 0.40, S: 0.15, L: 0.15, C: 0.15, V: 0.15 };
const V2_WEIGHTS = { A: 0.30, S: 0.10, L: 0.10, C: 0.10, V: 0.10, R: 0.05, T: 0.05, F: 0.10, E: 0.05, Z: 0.05 };
const GATE = 0.85;
// W258-ML-1: honest floor for the A divisor when computing R/F/T ratios.
// Without a real floor the 1e-6 epsilon used to dodge division-by-zero lets
// a tiny declared accuracy inflate R/F/T to 1.0 via clamp01(holdout / 1e-6).
// Below this threshold the axis is unverifiable and must redistribute weight
// rather than emit a falsely-perfect score.
const MIN_HONEST_A_FOR_RATIO = 0.05;

function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function round4(x) { return Number(x.toFixed(4)); }

function sizeScore(size_bytes) {
  const size_kb = Math.max(1, (size_bytes || 0) / 1024);
  return clamp01(1 - Math.log2(size_kb) / 30);
}
function latencyScore(p50_latency_us) {
  const lat_us = p50_latency_us == null ? 100 : Math.max(0, p50_latency_us);
  return 1 / (1 + lat_us / 100000);
}
function costScore(cost_usd_per_call) {
  const cost = Math.max(0, cost_usd_per_call ?? 0);
  return 1 / (1 + cost * 1000);
}
function energyScore(joules_per_call) {
  if (joules_per_call == null) return null;
  return 1 / (1 + Math.max(0, joules_per_call) / 100);
}
function driftScore(eval_set_drift) {
  if (eval_set_drift == null) return null;
  return clamp01(1 - eval_set_drift);
}

export function computeKScoreV1({ size_bytes, accuracy, coverage, p50_latency_us, cost_usd_per_call }) {
  const A = clamp01(accuracy);
  const S = sizeScore(size_bytes);
  const L = latencyScore(p50_latency_us);
  const C = costScore(cost_usd_per_call);
  const V = clamp01(coverage);
  const composite = round4(V1_WEIGHTS.A * A + V1_WEIGHTS.S * S + V1_WEIGHTS.L * L + V1_WEIGHTS.C * C + V1_WEIGHTS.V * V);
  return {
    accuracy: round4(A),
    coverage: round4(V),
    p50_latency_us: p50_latency_us ?? null,
    cost_usd_per_call: cost_usd_per_call ?? 0,
    size_bytes: size_bytes || 0,
    size_score: round4(S),
    latency_score: round4(L),
    cost_score: round4(C),
    composite,
    ships: composite >= GATE,
    gate: GATE,
    spec: 'k-score-1',
    weights: V1_WEIGHTS,
  };
}

// v2 — accepts the same inputs as v1 plus optional R/F/E/Z/T. When an optional
// input is missing, its weight is redistributed proportionally over the
// supplied axes so the composite stays comparable. Spec emitted is 'k-score-2'
// when any v2 axis is supplied; otherwise we return a v1 envelope.
//
// T (teacher-fidelity) is the distillation honesty axis added in wave 145.
// It needs BOTH the student's holdout accuracy (already required for R) AND
// the teacher's accuracy on the SAME holdout. Without both, T degrades to
// null and its weight redistributes.
export function computeKScoreV2(input) {
  const hasV2 = ['holdout_accuracy', 'subgroup_min_accuracy', 'joules_per_call', 'eval_set_drift', 'teacher_holdout_accuracy']
    .some(k => input[k] != null);
  if (!hasV2) return computeKScoreV1(input);

  const A = clamp01(input.accuracy);
  const S = sizeScore(input.size_bytes);
  const L = latencyScore(input.p50_latency_us);
  const C = costScore(input.cost_usd_per_call);
  const V = clamp01(input.coverage);
  // W258-ML-1: R/F/T ratios divide by A. When A is near zero, dividing by a
  // 1e-6 epsilon trivially clamps the ratio to 1.0 and the axis claims a
  // false perfect score. Below MIN_HONEST_A_FOR_RATIO the divisor is not
  // meaningful, so the axis returns null and its weight redistributes.
  const ratioReady = A >= MIN_HONEST_A_FOR_RATIO;
  const R = (input.holdout_accuracy == null || !ratioReady)
    ? null
    : clamp01(input.holdout_accuracy / A);
  const F = (input.subgroup_min_accuracy == null || !ratioReady)
    ? null
    : clamp01(input.subgroup_min_accuracy / A);
  const E = energyScore(input.joules_per_call);
  const Z = driftScore(input.eval_set_drift);
  // T = student-holdout / teacher-holdout. Reported as A/T (student / teacher).
  // 1.0 = student matches teacher; 0.9 = student at 90% of teacher quality.
  // Needs BOTH inputs AND a non-trivial teacher_holdout_accuracy; the same
  // ratio-floor argument applies to the teacher's holdout: a teacher that
  // scored 0 on the holdout cannot anchor a fidelity ratio.
  const teacherReady = input.teacher_holdout_accuracy != null
    && input.teacher_holdout_accuracy >= MIN_HONEST_A_FOR_RATIO;
  const T = (input.teacher_holdout_accuracy == null || input.holdout_accuracy == null || !teacherReady)
    ? null
    : clamp01(input.holdout_accuracy / input.teacher_holdout_accuracy);

  const supplied = { A, S, L, C, V };
  if (R != null) supplied.R = R;
  if (T != null) supplied.T = T;
  if (F != null) supplied.F = F;
  if (E != null) supplied.E = E;
  if (Z != null) supplied.Z = Z;

  // Redistribute missing weight over present axes.
  let totalWeight = 0;
  for (const k of Object.keys(supplied)) totalWeight += V2_WEIGHTS[k];
  const scaled = {};
  for (const k of Object.keys(supplied)) scaled[k] = V2_WEIGHTS[k] / totalWeight;

  let composite = 0;
  for (const k of Object.keys(supplied)) composite += scaled[k] * supplied[k];
  composite = round4(composite);

  return {
    accuracy: round4(A),
    coverage: round4(V),
    p50_latency_us: input.p50_latency_us ?? null,
    cost_usd_per_call: input.cost_usd_per_call ?? 0,
    size_bytes: input.size_bytes || 0,
    size_score: round4(S),
    latency_score: round4(L),
    cost_score: round4(C),
    holdout_accuracy: input.holdout_accuracy == null ? null : round4(input.holdout_accuracy),
    robustness_score: R == null ? null : round4(R),
    teacher_holdout_accuracy: input.teacher_holdout_accuracy == null ? null : round4(input.teacher_holdout_accuracy),
    teacher_fidelity_score: T == null ? null : round4(T),
    subgroup_min_accuracy: input.subgroup_min_accuracy == null ? null : round4(input.subgroup_min_accuracy),
    fairness_score: F == null ? null : round4(F),
    joules_per_call: input.joules_per_call ?? null,
    energy_score: E == null ? null : round4(E),
    eval_set_drift: input.eval_set_drift ?? null,
    drift_score: Z == null ? null : round4(Z),
    composite,
    ships: composite >= GATE,
    gate: GATE,
    spec: 'k-score-2',
    weights: scaled,
    weights_base: V2_WEIGHTS,
  };
}

// Default export = whichever path is appropriate for the inputs supplied.
// Existing callers that pass only v1 inputs continue to get v1 envelopes.
//
// W252b Bug 4: when the manifest declares `recipe_class: 'distilled_model'`
// AND names a `teacher_vendor` (cross-vendor distillation claim) but does NOT
// supply `teacher_holdout_accuracy`, the T axis cannot be verified. The
// default behavior is to emit a `T_axis_unverifiable` warning so the verifier
// surfaces the gap rather than silently redistributing weight. Callers that
// must enforce teacher fidelity (e.g., regulated procurement gates that will
// not accept an unverifiable T axis) can pass `strict_teacher_fidelity: true`
// to upgrade the warning to a throw.
export function computeKScore(input) {
  if (input && input.recipe_class === 'distilled_model'
      && input.teacher_vendor
      && (input.teacher_holdout_accuracy == null)) {
    const msg = 'T_axis_unverifiable: distilled_model with teacher_vendor='
      + String(input.teacher_vendor)
      + ' teacher_holdout_accuracy not provided (verifier check #T1, RS-1 §7.13).';
    if (input.lenient_teacher_fidelity === true) {
      const out = computeKScoreV2(input);
      const warning = { code: 'T_axis_unverifiable', message: msg };
      out.warnings = Array.isArray(out.warnings) ? out.warnings.concat(warning) : [warning];
      return out;
    }
    if (input.strict_teacher_fidelity === true) {
      throw new Error(
        'strict-teacher-fidelity: teacher_holdout_accuracy not provided for '
        + 'distilled_model with teacher_vendor=' + String(input.teacher_vendor)
        + '. Either supply teacher_holdout_accuracy or drop strict_teacher_fidelity.'
      );
    }
    if (input.holdout_accuracy != null) {
      const out = computeKScoreV2(input);
      const warning = { code: 'T_axis_unverifiable', message: msg };
      out.warnings = Array.isArray(out.warnings) ? out.warnings.concat(warning) : [warning];
      return out;
    }
    throw new Error(msg);
  }
  return computeKScoreV2(input);
}
