// Wave 217: frontier base-model catalog. Behavior assertions (no page-text
// markers per Pablo W202-W210 correction). What this test enforces:
//   1. src/model-registry.js exports FRONTIER_MODELS + HW_TIERS + helpers.
//   2. The W217 plan rows are present somewhere in the registry surface --
//      after the W295 split they live in CANDIDATE_MODELS (unverified
//      watchlist), not in FRONTIER_MODELS. The union of verified + candidates
//      must still cover every named id.
//   3. Every row has the required shape (arch / quant / modality / hw_tier all
//      from the enumerated sets; verified_at is YYYY-MM-DD; source present).
//   4. Hardware-tier slugs cover the 8 named platforms in the plan.
//   5. listFrontier filters by tier / arch / modality / family / max_vram_gb
//      over the verified registry (post-W295 the verified set is smaller, so
//      the filter assertions are sized to post-split reality).
//   6. verifyAll() returns {ok:true} for every shipped row (no bad data).
//   7. buildEntry() rejects missing required fields + bad enums.
//   8. cli/kolm.js cmdModels has frontier / tiers / show / add / verify cases
//      wired into the existing dispatch.
//   9. public/models.html documents the Frontier 2026 catalog with all 14
//      models referenced + 10 hw-tier slugs.
//  10. sw.js CACHE wave-floor >= 217.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI_SRC = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
const MODELS_HTML = fs.readFileSync(path.join(ROOT, 'public/models.html'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

test('W217 #1 - model-registry exports surface', async () => {
  const R = await import('../src/model-registry.js');
  for (const fn of ['FRONTIER_MODELS', 'HW_TIERS', 'QUANTS', 'ARCHS', 'MODALITIES',
                    'listFrontier', 'showFrontier', 'listHwTiers', 'showHwTier',
                    'buildEntry', 'verifyEntry', 'verifyAll']) {
    assert.ok(R[fn] != null, `missing export: ${fn}`);
  }
});

test('W217 #2 - the 14 plan rows survive somewhere in the registry surface (post-W295: in CANDIDATE_MODELS)', async () => {
  const R = await import('../src/model-registry.js');
  // W295 split: the original W217 catalog rows are unverified research
  // watchlist entries (broad HF org URLs, no exact license URL, no revision
  // pinning), so they now live in CANDIDATE_MODELS. The test asserts on the
  // UNION of both registries to keep the audit trail honest.
  const verifiedIds = R.FRONTIER_MODELS.map(m => m.id);
  const candidateIds = R.CANDIDATE_MODELS.map(m => m.id);
  const all = new Set([...verifiedIds, ...candidateIds]);
  const expected = [
    'stepfun-ai/step3.5-flash-reap-121b',
    'Qwen/Qwen3.6-27B-Instruct',
    'nvidia/Nemotron-3-Nano-Omni-30B-A3B',
    'deepseek-ai/DeepSeek-V4-PRO-1.6T',
    'deepseek-ai/DeepSeek-V4-Flash-158B',
    'zai-org/GLM-4.7-Flash',
    'zai-org/GLM-4.5-Air-REAP-82B-A12B',
    'google/gemma-4-26b-a4b-it',
    'Qwen/Qwen3-VL-235B-A22B-Instruct',
    'Qwen/Qwen3-Coder-30B-A3B-Instruct',
    'Qwen/Qwen3.5-27B-Instruct',
    'moonshotai/Kimi-K2.5-1T',
    'NousResearch/Hermes-4.3-36B',
    'cerebras/Carnice-35B-A3B-Instruct',
  ];
  for (const e of expected) assert.ok(all.has(e), `missing W217 plan row: ${e}`);
  // FRONTIER_MODELS must still have at least one verified row per named tier
  // (the W218 #9 plan tiers are 3090 / 5090 / dgx-spark / m3-ultra-512).
  assert.ok(R.FRONTIER_MODELS.length >= 4, `verified registry too small: ${R.FRONTIER_MODELS.length}`);
});

test('W217 #3 - every row has required shape + valid enums', async () => {
  const R = await import('../src/model-registry.js');
  for (const m of R.FRONTIER_MODELS) {
    for (const f of ['id', 'family', 'params', 'params_b', 'arch', 'modality',
                     'hw_tier', 'recommended_quant', 'vram_gb', 'ctx_k',
                     'license', 'source_url', 'source_note', 'verified_at']) {
      assert.ok(m[f] != null, `row ${m.id} missing field ${f}`);
    }
    assert.ok(R.ARCHS.includes(m.arch), `bad arch on ${m.id}: ${m.arch}`);
    assert.ok(R.QUANTS.includes(m.recommended_quant), `bad quant on ${m.id}: ${m.recommended_quant}`);
    assert.ok(R.HW_TIERS.some(t => t.slug === m.hw_tier), `bad hw_tier on ${m.id}: ${m.hw_tier}`);
    assert.ok(Array.isArray(m.modality) && m.modality.length > 0, `bad modality on ${m.id}`);
    for (const mod of m.modality) {
      assert.ok(R.MODALITIES.includes(mod), `bad modality value on ${m.id}: ${mod}`);
    }
    assert.match(m.verified_at, /^\d{4}-\d{2}-\d{2}$/, `bad verified_at on ${m.id}`);
    assert.ok(typeof m.params_b === 'number' && m.params_b > 0, `bad params_b on ${m.id}`);
    if (m.active_params_b != null) {
      assert.ok(m.active_params_b <= m.params_b, `active>total on ${m.id}`);
    }
  }
});

test('W217 #4 - hardware tiers cover the 8 named platforms', async () => {
  const R = await import('../src/model-registry.js');
  const slugs = R.HW_TIERS.map(t => t.slug);
  for (const s of ['3090', '5090', 'a100-80', 'h100-80', 'h200-141',
                   'dgx-spark', 'm3-ultra-512', 'cpu-server']) {
    assert.ok(slugs.includes(s), `missing tier: ${s}`);
  }
});

test('W217 #5 - listFrontier filters by tier / family / license / max-vram', async () => {
  const R = await import('../src/model-registry.js');
  // W295 sized for post-split verified set: at least one Spark pick and at
  // least one consumer-tier pick. omni / vision filters target candidates
  // (asserted separately) since no verified omni or vision row ships yet.
  const spark = R.listFrontier({ hw_tier: 'dgx-spark' });
  assert.ok(spark.length >= 1, 'at least 1 verified DGX Spark row');
  for (const m of spark) assert.equal(m.hw_tier, 'dgx-spark');

  // Family + license filters still demonstrably narrow the set.
  const qwen = R.listFrontier({ family: 'qwen2.5' });
  assert.ok(qwen.length >= 1, 'at least 1 verified qwen2.5 row');
  for (const m of qwen) assert.equal(m.family, 'qwen2.5');

  const apache = R.listFrontier({ license: 'apache-2.0' });
  assert.ok(apache.length >= 2, 'at least 2 verified apache-2.0 rows');
  for (const m of apache) assert.equal(m.license, 'apache-2.0');

  const small = R.listFrontier({ max_vram_gb: 24 });
  assert.ok(small.length >= 3, 'at least 3 fit-in-24GB verified models');
  for (const m of small) assert.ok(m.vram_gb <= 24);

  // W295: omni and vision rows live in CANDIDATE_MODELS until promoted.
  // Assert they survive somewhere in the surface so the audit trail is intact.
  const candOmni = R.CANDIDATE_MODELS.filter(m => m.arch === 'omni');
  assert.ok(candOmni.length >= 1, 'at least 1 omni candidate');
  const candVision = R.CANDIDATE_MODELS.filter(m => m.modality.includes('vision'));
  assert.ok(candVision.length >= 1, 'at least 1 vision candidate');
});

test('W217 #6 - verifyAll returns ok:true for every shipped row', async () => {
  const R = await import('../src/model-registry.js');
  const out = R.verifyAll();
  assert.equal(out.failed, 0, `failed rows: ${JSON.stringify(out.results.filter(r => !r.ok), null, 2)}`);
  assert.equal(out.total, R.FRONTIER_MODELS.length);
});

test('W217 #7 - buildEntry rejects missing required fields + bad enums', async () => {
  const R = await import('../src/model-registry.js');
  assert.throws(() => R.buildEntry({}), /missing required fields/);
  assert.throws(
    () => R.buildEntry({ id:'x/y', family:'f', params:'1B', params_b:1, arch:'NOPE', modality:'text', hw_tier:'3090', recommended_quant:'q4', license:'mit' }),
    /arch must be one of/
  );
  assert.throws(
    () => R.buildEntry({ id:'x/y', family:'f', params:'1B', params_b:1, arch:'dense', modality:'text', hw_tier:'3090', recommended_quant:'NOPE', license:'mit' }),
    /recommended_quant must be one of/
  );
  assert.throws(
    () => R.buildEntry({ id:'x/y', family:'f', params:'1B', params_b:1, arch:'dense', modality:'text', hw_tier:'INVALID', recommended_quant:'q4', license:'mit' }),
    /hw_tier must be one of/
  );
  const ok = R.buildEntry({
    id: 'test/x', family: 'test', params: '1B', params_b: 1, arch: 'dense',
    modality: 'text', hw_tier: '3090', recommended_quant: 'q4', license: 'apache-2.0',
  });
  assert.equal(ok.id, 'test/x');
  assert.equal(ok.arch, 'dense');
  assert.deepEqual(ok.modality, ['text']);
  assert.match(ok.verified_at, /^\d{4}-\d{2}-\d{2}$/);
});

test('W217 #8 - cli cmdModels wires frontier / tiers / show / add / verify cases', () => {
  for (const c of [`case 'frontier':`, `case 'tiers':`, `case 'show':`, `case 'add':`, `case 'verify':`]) {
    assert.ok(CLI_SRC.includes(c), `cmdModels missing case: ${c}`);
  }
  assert.match(CLI_SRC, /listFrontier\(/, 'cmdModels must call listFrontier');
  assert.match(CLI_SRC, /listHwTiers\(/, 'cmdModels must call listHwTiers');
  assert.match(CLI_SRC, /verifyEntry\(/, 'cmdModels must call verifyEntry');
  assert.match(CLI_SRC, /verifyAll\(/, 'cmdModels must call verifyAll');
  assert.match(CLI_SRC, /buildEntry\(/, 'cmdModels must call buildEntry');
});

test('W217 #9 - public/models.html documents the Frontier 2026 catalog', () => {
  assert.match(MODELS_HTML, /Frontier 2026 catalog/);
  // All 14 model ids should appear in the page (as <code> blocks).
  const ids = [
    'stepfun-ai/step3.5-flash-reap-121b',
    'Qwen/Qwen3.6-27B-Instruct',
    'nvidia/Nemotron-3-Nano-Omni-30B-A3B',
    'deepseek-ai/DeepSeek-V4-PRO-1.6T',
    'deepseek-ai/DeepSeek-V4-Flash-158B',
    'zai-org/GLM-4.7-Flash',
    'zai-org/GLM-4.5-Air-REAP-82B-A12B',
    'google/gemma-4-26b-a4b-it',
    'Qwen/Qwen3-VL-235B-A22B-Instruct',
    'Qwen/Qwen3-Coder-30B-A3B-Instruct',
    'Qwen/Qwen3.5-27B-Instruct',
    'moonshotai/Kimi-K2.5-1T',
    'NousResearch/Hermes-4.3-36B',
    'cerebras/Carnice-35B-A3B-Instruct',
  ];
  for (const id of ids) assert.ok(MODELS_HTML.includes(id), `models.html missing id ref: ${id}`);
  for (const slug of ['3090', '5090', 'a100-80', 'h100-80', 'h200-141',
                      'dgx-spark', 'm3-ultra-512']) {
    assert.ok(MODELS_HTML.includes(slug), `models.html missing tier slug: ${slug}`);
  }
});

test('W217 #10 - sw.js CACHE wave-floor >= 217', () => {
  const m = SW_JS.match(/const\s+CACHE\s*=\s*'kolm-v7-2026-05-\d+-wave(\d+)/);
  assert.ok(m, 'CACHE slug present');
  assert.ok(parseInt(m[1], 10) >= 217, 'CACHE wave >= 217 (got ' + m[1] + ')');
});
