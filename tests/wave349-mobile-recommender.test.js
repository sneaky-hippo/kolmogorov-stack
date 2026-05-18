// Wave 349 — recommend({use:'mobile'}) must pick a real mobile-target
// model, not the smallest generic.
//
// Bug: TIER_BY_USE['mobile'] pointed at Qwen/Qwen2.5-0.5B-Instruct, and the
// recommend() scorer made Qwen win on license alone (apache-2.0 +0.30 vs
// gemma +0.15). The "mobile" answer was a 0.5B model with no phone runtime
// path — Gemma 3n E2B was sitting one row below in the registry and never
// surfaced.
//
// Fix:
//   - Add `mobile_friendly: true` to the two Gemma 3n rows (the only models
//     in MODELS that ship with a phone runtime: MediaPipe / MLC / llama.cpp
//     arm64). The flag is curator-set so the test can also assert nothing
//     else gets it.
//   - Bump TIER_BY_USE['mobile'] to google/gemma-3n-E2B-it (the actual
//     mobile pick), leaving 'wasm' and 'edge' on Qwen 0.5B.
//   - When use === 'mobile', recommend() adds +0.40 for mobile_friendly so
//     the bonus overcomes the apache-vs-gemma license delta.
//
// Behavior assertions (no copy):
//   1. TIER_BY_USE.mobile === 'google/gemma-3n-E2B-it'.
//   2. Both Gemma 3n rows carry mobile_friendly:true. No model that lacks
//      a phone deployment path (e.g. Qwen2.5-7B) carries the flag.
//   3. recommend({use:'mobile'}) returns one of the Gemma 3n IDs as .pick;
//      .explicit_tier_pick === 'google/gemma-3n-E2B-it'.
//   4. The first non-mobile-friendly entry in .top is ranked BELOW the
//      first mobile_friendly entry (sanity-check that the +0.40 bonus
//      actually overcomes the license delta).
//   5. recommend({use:'mobile', vram_gb: 4}) still prefers Gemma 3n E2B
//      (fits in 2.5GB at q4); recommend({use:'mobile', vram_gb: 2}) falls
//      back gracefully (no crash).

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('W349 #1 - TIER_BY_USE.mobile points at google/gemma-3n-E2B-it', async () => {
  const M = await import('../src/models.js');
  assert.equal(M.TIER_BY_USE.mobile, 'google/gemma-3n-E2B-it',
    'mobile tier must be Gemma 3n E2B, not Qwen 0.5B');
});

test('W349 #2 - Gemma 3n rows are mobile_friendly; non-mobile rows are not', async () => {
  const M = await import('../src/models.js');
  const e2b = M.MODELS.find(m => m.id === 'google/gemma-3n-E2B-it');
  const e4b = M.MODELS.find(m => m.id === 'google/gemma-3n-E4B-it');
  assert.ok(e2b, 'Gemma 3n E2B row missing');
  assert.ok(e4b, 'Gemma 3n E4B row missing');
  assert.equal(e2b.mobile_friendly, true, 'E2B must be mobile_friendly');
  assert.equal(e4b.mobile_friendly, true, 'E4B must be mobile_friendly');
  // Sanity: a 7B model is NEVER a mobile target.
  const big = M.MODELS.find(m => m.id === 'Qwen/Qwen2.5-7B-Instruct');
  assert.ok(big, 'Qwen 7B row missing');
  assert.notEqual(big.mobile_friendly, true,
    'Qwen 7B must not carry mobile_friendly:true (no phone runtime path)');
});

test('W349 #3 - recommend({use:"mobile"}) picks a Gemma 3n model', async () => {
  const M = await import('../src/models.js');
  const r = M.recommend({ use: 'mobile' });
  assert.ok(
    r.pick === 'google/gemma-3n-E2B-it' || r.pick === 'google/gemma-3n-E4B-it',
    `expected a Gemma 3n pick, got ${r.pick}`,
  );
  assert.equal(r.explicit_tier_pick, 'google/gemma-3n-E2B-it');
  assert.ok(Array.isArray(r.top) && r.top.length > 0, 'top list missing');
});

test('W349 #4 - mobile_friendly outranks non-mobile generic in the top list', async () => {
  const M = await import('../src/models.js');
  const r = M.recommend({ use: 'mobile' });
  // Find the first mobile_friendly entry and the first non-mobile_friendly
  // entry in the top list. The mobile_friendly one must rank higher.
  const firstFriendlyIdx = r.top.findIndex((row) => {
    const m = M.MODELS.find(mm => mm.id === row.id);
    return m && m.mobile_friendly === true;
  });
  const firstNonFriendlyIdx = r.top.findIndex((row) => {
    const m = M.MODELS.find(mm => mm.id === row.id);
    return m && m.mobile_friendly !== true;
  });
  assert.ok(firstFriendlyIdx >= 0, 'no mobile_friendly model in top list');
  if (firstNonFriendlyIdx >= 0) {
    assert.ok(firstFriendlyIdx < firstNonFriendlyIdx,
      `mobile_friendly model (idx ${firstFriendlyIdx}) must rank above non-mobile_friendly (idx ${firstNonFriendlyIdx})`);
  }
});

test('W349 #5 - recommend({use:"mobile", vram_gb}) respects vram budget', async () => {
  const M = await import('../src/models.js');
  // 4GB phone budget — E4B (4.0GB @ q4) just fits; either Gemma 3n is a
  // valid mobile pick at this budget. We just assert it's still a Gemma 3n
  // (NOT Qwen 0.5B) and not a >4GB model.
  const r4 = M.recommend({ use: 'mobile', vram_gb: 4 });
  assert.ok(
    r4.pick === 'google/gemma-3n-E2B-it' || r4.pick === 'google/gemma-3n-E4B-it',
    `with 4GB budget expected a Gemma 3n, got ${r4.pick}`,
  );
  // 2GB budget — E2B doesn't fit (2.5GB needed), but the function must not
  // crash and must return some pick (degraded mode).
  const r2 = M.recommend({ use: 'mobile', vram_gb: 2 });
  assert.ok(typeof r2.pick === 'string' && r2.pick.length > 0,
    'recommend must always return a pick even in degraded mode');
});
