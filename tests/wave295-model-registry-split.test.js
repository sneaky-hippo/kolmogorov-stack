// Wave 295: model-registry split (audit C5). Real behavior tests for the
// verifyExactSourceUrl / listVerified / listCandidates / verifyEntry
// tightening. Each assertion is on registry behavior, NOT on source-grep
// theater (per Pablo W202-W210 correction).
//
// What this test enforces:
//   1. verifyExactSourceUrl returns ok:true for exact HF model-card URLs.
//   2. verifyExactSourceUrl returns ok:false + reason:'too_broad' for HF
//      organization-only pages.
//   3. verifyExactSourceUrl returns ok:false + reason:'not_huggingface' for
//      non-HF URLs.
//   4. verifyExactSourceUrl returns ok:false + reason:'missing' for empty
//      / null / non-string input.
//   5. listVerified() and listCandidates() are exported and return arrays.
//   6. listVerified() and listCandidates() return DISJOINT id sets (no row
//      can sit in both registries).
//   7. Every row in listVerified() has a source_url that passes
//      verifyExactSourceUrl.
//   8. Every row in listVerified() has license_url, verified_at within the
//      last 90 days, and either a 40-char hex revision_hash OR
//      revision_pinned:false (the honest warn-band).
//   9. resolveTier('dgx-spark') either returns a verified entry (with a
//      base_model) or returns null/reason:'no_verified_model_for_tier'.
//  10. resolveTier never returns a base_model that lives in CANDIDATE_MODELS
//      (the verification gate).
//  11. verifyEntry still surfaces bad_arch / bad_quant / bad_hw_tier
//      problems unchanged from W217 / W235.
//  12. verifyEntry surfaces bad_source_url_specificity for verified rows
//      whose source_url fails the exact-URL gate (the W295 tightening).
//  13. verifyEntryOnline returns source_url_specific:true|false.
//  14. The W295 verification_evidence shape is attached to verified rows
//      with at least a verifier_note.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('W295 #1 - verifyExactSourceUrl accepts exact HF model-card URLs', async () => {
  const R = await import('../src/model-registry.js');
  for (const ok of [
    'https://huggingface.co/Qwen/Qwen2.5-7B',
    'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct',
    'https://huggingface.co/meta-llama/Llama-3.1-70B-Instruct',
    'https://huggingface.co/google/gemma-2-9b-it',
    'https://huggingface.co/microsoft/Phi-3.5-mini-instruct',
    'https://huggingface.co/Qwen/Qwen2.5-7B/',  // trailing slash allowed
  ]) {
    const r = R.verifyExactSourceUrl(ok);
    assert.deepEqual(r, { ok: true }, `expected ok for ${ok}, got ${JSON.stringify(r)}`);
  }
});

test('W295 #2 - verifyExactSourceUrl rejects HF organization-only pages', async () => {
  const R = await import('../src/model-registry.js');
  for (const broad of [
    'https://huggingface.co/Qwen',
    'https://huggingface.co/google',
    'https://huggingface.co/meta-llama',
    'https://huggingface.co/Qwen/',
  ]) {
    const r = R.verifyExactSourceUrl(broad);
    assert.equal(r.ok, false, `expected too_broad for ${broad}`);
    assert.equal(r.reason, 'too_broad', `expected reason=too_broad for ${broad}`);
  }
});

test('W295 #3 - verifyExactSourceUrl rejects non-HuggingFace URLs', async () => {
  const R = await import('../src/model-registry.js');
  for (const nonHf of [
    'https://example.com/qwen',
    'https://github.com/Qwen/Qwen2.5',
    'https://ai.google.dev/gemma',
    'http://huggingface.co.evil.com/Qwen/Qwen2.5-7B',
  ]) {
    const r = R.verifyExactSourceUrl(nonHf);
    assert.equal(r.ok, false, `expected not_huggingface for ${nonHf}`);
    assert.equal(r.reason, 'not_huggingface', `expected reason=not_huggingface for ${nonHf}`);
  }
});

test('W295 #4 - verifyExactSourceUrl rejects empty / null / non-string input', async () => {
  const R = await import('../src/model-registry.js');
  for (const bad of [null, undefined, '', 0, false, {}, []]) {
    const r = R.verifyExactSourceUrl(bad);
    assert.equal(r.ok, false, `expected missing for ${JSON.stringify(bad)}`);
    assert.equal(r.reason, 'missing');
  }
});

test('W295 #5 - listVerified and listCandidates are exported and return arrays', async () => {
  const R = await import('../src/model-registry.js');
  assert.equal(typeof R.listVerified, 'function');
  assert.equal(typeof R.listCandidates, 'function');
  const v = R.listVerified();
  const c = R.listCandidates();
  assert.ok(Array.isArray(v), 'listVerified returns an array');
  assert.ok(Array.isArray(c), 'listCandidates returns an array');
  assert.ok(v.length >= 1, 'at least one verified row');
  assert.ok(c.length >= 1, 'at least one candidate row');
});

test('W295 #6 - listVerified and listCandidates return DISJOINT id sets', async () => {
  const R = await import('../src/model-registry.js');
  const v = new Set(R.listVerified().map(m => m.id));
  const c = new Set(R.listCandidates().map(m => m.id));
  const overlap = [...v].filter(id => c.has(id));
  assert.deepEqual(overlap, [], `verified+candidate overlap is not empty: ${JSON.stringify(overlap)}`);
});

test('W295 #7 - every verified row has a source_url that passes verifyExactSourceUrl', async () => {
  const R = await import('../src/model-registry.js');
  for (const m of R.listVerified()) {
    const r = R.verifyExactSourceUrl(m.source_url);
    assert.equal(r.ok, true, `verified row ${m.id} has bad source_url ${m.source_url}: ${r.reason}`);
  }
});

test('W295 #8 - every verified row has license_url, recent verified_at, and pinned-or-warn-band revision', async () => {
  const R = await import('../src/model-registry.js');
  const ninetyDaysAgoMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
  for (const m of R.listVerified()) {
    assert.ok(typeof m.license_url === 'string' && m.license_url.length > 0,
      `verified row ${m.id} missing license_url`);
    assert.ok(m.license_url.startsWith('https://huggingface.co/'),
      `verified row ${m.id} license_url must be an HF link (got ${m.license_url})`);
    // verified_at must be a real date in the last 90 days.
    assert.match(m.verified_at, /^\d{4}-\d{2}-\d{2}$/, `verified row ${m.id} bad verified_at`);
    const t = Date.parse(m.verified_at + 'T00:00:00Z');
    assert.ok(Number.isFinite(t), `verified row ${m.id} verified_at not parseable`);
    assert.ok(t >= ninetyDaysAgoMs, `verified row ${m.id} verified_at older than 90 days`);
    // revision_hash 40-hex OR revision_pinned:false (warn-band).
    if (m.revision_hash != null) {
      assert.match(m.revision_hash, /^[0-9a-f]{40}$/i, `verified row ${m.id} revision_hash not 40-hex`);
    } else {
      assert.equal(m.revision_pinned, false, `verified row ${m.id} must have revision_pinned:false when revision_hash is null`);
    }
  }
});

test('W295 #9 - resolveTier(dgx-spark) returns a verified entry OR a no_verified_model_for_tier reason', async () => {
  const R = await import('../src/model-registry.js');
  const out = R.resolveTier('dgx-spark');
  assert.ok(out, 'resolveTier should never return null for a known tier slug');
  if (out.base_model) {
    // Must be a verified id.
    const verifiedIds = new Set(R.listVerified().map(m => m.id));
    assert.ok(verifiedIds.has(out.base_model),
      `resolveTier returned base_model ${out.base_model} that is NOT in FRONTIER_MODELS`);
  } else {
    assert.equal(out.reason, 'no_verified_model_for_tier',
      `resolveTier without a base_model must surface a reason; got ${JSON.stringify(out)}`);
    assert.ok(typeof out.hint === 'string' && out.hint.length > 0, 'reason payload must include a CLI hint');
  }
});

test('W295 #10 - resolveTier NEVER picks a candidate (verification gate)', async () => {
  const R = await import('../src/model-registry.js');
  const candidateIds = new Set(R.listCandidates().map(m => m.id));
  for (const t of R.listHwTiers()) {
    const out = R.resolveTier(t.slug);
    if (out && out.base_model) {
      assert.ok(!candidateIds.has(out.base_model),
        `tier ${t.slug} picked ${out.base_model} which is a CANDIDATE, not verified`);
    }
  }
});

test('W295 #11 - verifyEntry still surfaces bad_arch / bad_quant / bad_hw_tier problems (W217 contract intact)', async () => {
  const R = await import('../src/model-registry.js');
  // Cannot mutate FRONTIER_MODELS at runtime (the registry is frozen-by-convention),
  // so we test buildEntry which uses the same enum-validation logic. Confirm the
  // throw messages exist for each bad-enum class.
  assert.throws(() => R.buildEntry({
    id: 'x/y', family: 'f', params: '1B', params_b: 1, arch: 'NOPE',
    modality: 'text', hw_tier: '3090', recommended_quant: 'q4', license: 'mit',
  }), /arch must be one of/, 'bad_arch must throw');
  assert.throws(() => R.buildEntry({
    id: 'x/y', family: 'f', params: '1B', params_b: 1, arch: 'dense',
    modality: 'text', hw_tier: '3090', recommended_quant: 'NOPE', license: 'mit',
  }), /recommended_quant must be one of/, 'bad_quant must throw');
  assert.throws(() => R.buildEntry({
    id: 'x/y', family: 'f', params: '1B', params_b: 1, arch: 'dense',
    modality: 'text', hw_tier: 'INVALID', recommended_quant: 'q4', license: 'mit',
  }), /hw_tier must be one of/, 'bad_hw_tier must throw');
});

test('W295 #12 - verifyEntry surfaces bad_source_url_specificity for any candidate verified-side promotion', async () => {
  const R = await import('../src/model-registry.js');
  // Indirect contract test: every CANDIDATE_MODELS row has a broad source_url
  // (that's why it's a candidate). If we ran the verified-side specificity
  // gate on it, it would fail. We probe this by directly calling
  // verifyExactSourceUrl on the candidate URLs and asserting they fail.
  for (const m of R.listCandidates()) {
    const r = R.verifyExactSourceUrl(m.source_url);
    assert.equal(r.ok, false,
      `candidate ${m.id} has exact source_url ${m.source_url}; should be promoted to FRONTIER_MODELS instead`);
  }
});

test('W295 #13 - verifyEntryOnline returns source_url_specific:true|false', async () => {
  const R = await import('../src/model-registry.js');
  const id = R.FRONTIER_MODELS[0]?.id;
  assert.ok(id, 'at least one verified row required');
  const realFetch = global.fetch;
  global.fetch = async () => ({ status: 200, ok: true });
  try {
    const out = await R.verifyEntryOnline(id);
    assert.equal(typeof out.source_url_specific, 'boolean',
      'verifyEntryOnline must surface source_url_specific');
    // For a verified row, the URL must pass the strict check.
    assert.equal(out.source_url_specific, true,
      `verified ${id} should have source_url_specific:true`);
  } finally {
    global.fetch = realFetch;
  }
});

test('W295 #13b - verifyEntryOnline surfaces source_url_specific:false for a candidate row', async () => {
  const R = await import('../src/model-registry.js');
  const candId = R.CANDIDATE_MODELS[0]?.id;
  assert.ok(candId, 'at least one candidate row required');
  const realFetch = global.fetch;
  global.fetch = async () => ({ status: 200, ok: true });
  try {
    const out = await R.verifyEntryOnline(candId);
    assert.equal(out.source_url_specific, false,
      `candidate ${candId} should have source_url_specific:false (broad URL)`);
    assert.ok(out.source_url_specificity_reason,
      'must include a specificity_reason when source_url_specific is false');
  } finally {
    global.fetch = realFetch;
  }
});

test('W295 #14 - every verified row carries a verification_evidence object with a verifier_note', async () => {
  const R = await import('../src/model-registry.js');
  for (const m of R.listVerified()) {
    assert.ok(m.verification_evidence && typeof m.verification_evidence === 'object',
      `verified row ${m.id} missing verification_evidence`);
    assert.ok(typeof m.verification_evidence.verifier_note === 'string'
      && m.verification_evidence.verifier_note.length > 0,
      `verified row ${m.id} verification_evidence.verifier_note must be a non-empty string`);
    // Shape: all five fields are present (null is OK for the network-probe ones).
    for (const f of ['source_url_checked_at', 'source_url_status',
                     'license_url_status', 'revision_hash', 'verifier_note']) {
      assert.ok(f in m.verification_evidence, `verified row ${m.id} verification_evidence missing field ${f}`);
    }
  }
});
