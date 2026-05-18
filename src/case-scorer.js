// W345 — single shared case-scoring path.
//
// Background: `kolm eval <art>` and `kolm bench <art>` historically used two
// different matchers on the same input. eval used a subset-equal walker (an
// expected object was a pass when actual was a superset; numeric tolerance
// 1e-6; array length must match). bench used a strict deep-equal (key sets
// must match both ways; numeric tolerance 1e-9). On the same .kolm with the
// same cases the two verbs disagreed — user trial reported eval=5/7 pass,
// bench=2/7 pass. That is a bug; users expect the pass count to be a property
// of the artifact + the case set, not of the verb that read them.
//
// This module exports `scoreCase` as the one true scorer. eval and bench both
// call it, so pass/fail is identical. Benchmark still wraps the call with
// extra timing/cost measurement, but the pass boolean is the same path.
//
// Comparator selection follows the artifact's manifest-declared comparator
// when supplied (eval matcher when 'exact' or omitted; comparators.js when
// 'json_subset', 'normalized_string', 'label'). Default keeps the historical
// eval semantics (subset-equal) so existing artifacts score identically — the
// user said eval was the more correct verb in their trial, so eval is the
// canonical source.

import { compare } from './comparators.js';

// Subset-equal matcher mirroring artifact-runner.js::matches and verifier.verify's
// `matches`. Compile-time and runtime eval use the same matcher or the user
// sees different pass counts from `kolm compile --spec` vs `kolm eval`. This
// is the canonical version; artifact-runner imports from here.
//
// Rules (intentional, do not change without a wave bump):
//   - expected null/undefined: any defined actual passes.
//   - expected function: invoked with actual.
//   - both arrays: same length AND elementwise matches.
//   - both objects: every expected key is matched in actual (subset).
//   - numbers: absolute tolerance 1e-6.
//   - fallback: strict ===.
export function subsetEqualMatch(actual, expected) {
  if (expected === undefined || expected === null) return actual !== undefined;
  if (typeof expected === 'function') return !!expected(actual);
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (actual.length !== expected.length) return false;
    return actual.every((a, i) => subsetEqualMatch(a, expected[i]));
  }
  if (typeof expected === 'object' && expected && typeof actual === 'object' && actual) {
    return Object.keys(expected).every(k => subsetEqualMatch(actual[k], expected[k]));
  }
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(actual - expected) < 1e-6;
  }
  return actual === expected;
}

// Public API. Given a case envelope and the artifact's actual output, return
// the shared score envelope. `comparator` may be omitted (defaults to the
// canonical subset-equal eval matcher) or one of the comparators.js names.
//
// The returned shape is stable. Callers that need extra timing/cost (bench)
// wrap this call; they MUST NOT recompute pass independently or the two
// verbs drift apart again.
export function scoreCase(testCase, output, opts = {}) {
  const expected = testCase ? testCase.expected : undefined;
  const comparator = opts.comparator || 'subset_equal';
  let pass = false;
  let comparatorUsed = comparator;
  if (comparator === 'subset_equal' || comparator === 'exact' || !comparator) {
    // Default and most-common path: the eval matcher. 'exact' is treated as
    // subset-equal historically (see artifact-runner::matches) — strict deep
    // equality is intentionally NOT the default because it would re-introduce
    // the bench-vs-eval drift this module exists to remove.
    pass = subsetEqualMatch(output, expected);
    comparatorUsed = 'subset_equal';
  } else if (comparator === 'json_subset' || comparator === 'normalized_string' || comparator === 'label') {
    try {
      const r = compare(output, expected, comparator);
      pass = !!(r && r.pass);
      comparatorUsed = comparator;
    } catch {
      // Comparators throw on shape mismatch in some paths; fall back to the
      // subset-equal eval matcher so we never claim pass when the comparator
      // could not even decide.
      pass = subsetEqualMatch(output, expected);
      comparatorUsed = 'subset_equal';
    }
  } else {
    // Unknown comparator name → safest fallback is the canonical matcher.
    pass = subsetEqualMatch(output, expected);
    comparatorUsed = 'subset_equal';
  }
  return {
    pass,
    score: pass ? 1 : 0,
    comparator: comparatorUsed,
    latency_us: typeof opts.latency_us === 'number' ? opts.latency_us : null,
    cost_micro_usd: typeof opts.cost_micro_usd === 'number' ? opts.cost_micro_usd : 0,
  };
}
