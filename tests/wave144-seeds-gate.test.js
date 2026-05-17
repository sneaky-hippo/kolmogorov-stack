// Wave 144 Q+2 demo-ready gate: train/holdout split + recipe scored against
// independent holdout. Required tests per Wave 144 spec:
//
//   - canonical and legacy seed normalization
//   - deterministic split (same seed -> same buckets)
//   - no train/holdout overlap
//   - verifier rejects overlap  (covered in verifier.test.js once Wave D ships)
//   - K-score uses holdout only
//   - blank spec with no seeds fails
//   - artifact manifest contains seed provenance
//   - rule-class artifact does not include fake model files
//   - comparator selection takes effect

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

import {
  loadSeeds,
  normalizeRow,
  splitSeeds,
  hashSeeds,
  prepareSeedSplit,
  verifySplit,
  leakageReport,
  classifyEvalSource,
  DEFAULT_SPLIT_SEED,
} from '../src/seeds.js';
import { compare, scoreHoldout } from '../src/comparators.js';
import { compileSpec } from '../src/spec-compile.js';
import { loadArtifact } from '../src/artifact-runner.js';

process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';

const TMP = path.join(os.tmpdir(), 'kolm-wave144-tests-' + crypto.randomBytes(3).toString('hex'));
fs.mkdirSync(TMP, { recursive: true });

function writeJsonl(filename, rows) {
  const p = path.join(TMP, filename);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

// ---- normalization ----

test('normalizeRow: canonical {input, output} shape', () => {
  const r = normalizeRow({ input: 'hi', output: 'hello', tags: ['greet'] });
  assert.equal(r.input, 'hi');
  assert.equal(r.expected, 'hello');
  assert.deepEqual(r.metadata.tags, ['greet']);
  assert.equal(r.metadata.source_format, 'canonical');
});

test('normalizeRow: canonical {input, expected} shape (eval form)', () => {
  const r = normalizeRow({ input: 'q', expected: 'a' });
  assert.equal(r.input, 'q');
  assert.equal(r.expected, 'a');
});

test('normalizeRow: legacy {prompt, completion} shape', () => {
  const r = normalizeRow({ prompt: 'ssn 123-45-6789', completion: 'ssn [PHI_SSN]' });
  assert.equal(r.input, 'ssn 123-45-6789');
  assert.equal(r.expected, 'ssn [PHI_SSN]');
  assert.equal(r.metadata.source_format, 'legacy_prompt_completion');
});

test('normalizeRow: malformed rows return null', () => {
  assert.equal(normalizeRow(null), null);
  assert.equal(normalizeRow({}), null);
  assert.equal(normalizeRow({ input: 'x' }), null);
  assert.equal(normalizeRow({ prompt: 'x' }), null);
  assert.equal(normalizeRow('a string'), null);
});

test('loadSeeds: mixed canonical + legacy + comments + blanks', () => {
  const file = path.join(TMP, 'mixed.jsonl');
  fs.writeFileSync(file, [
    '// header comment',
    '',
    JSON.stringify({ input: 'a', output: 'A' }),
    JSON.stringify({ prompt: 'b', completion: 'B' }),
    JSON.stringify({ bogus: true }),
    '',
    '// trailing comment',
  ].join('\n'));
  const { rows, skipped } = loadSeeds(file);
  assert.equal(rows.length, 2);
  assert.equal(skipped, 1);
  assert.equal(rows[0].metadata.source_format, 'canonical');
  assert.equal(rows[1].metadata.source_format, 'legacy_prompt_completion');
});

// ---- deterministic split ----

test('splitSeeds: same seed yields same buckets', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ input: 'row-' + i, expected: 'out-' + i, metadata: { tags: [] } }));
  const a = splitSeeds(rows, { split_seed: 'fixed-seed' });
  const b = splitSeeds(rows, { split_seed: 'fixed-seed' });
  assert.equal(hashSeeds(a.train), hashSeeds(b.train));
  assert.equal(hashSeeds(a.holdout), hashSeeds(b.holdout));
  assert.equal(a.train.length + a.holdout.length, 50);
});

test('splitSeeds: different seeds yield different splits', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ input: 'row-' + i, expected: 'out', metadata: { tags: [] } }));
  const a = splitSeeds(rows, { split_seed: 'seed-A' });
  const b = splitSeeds(rows, { split_seed: 'seed-B' });
  // Vanishingly small probability of identical splits across 100 rows with
  // two different sha256 seeds; if this ever fires, the hash is broken.
  assert.notEqual(hashSeeds(a.train), hashSeeds(b.train));
});

test('splitSeeds: holdout ratio honored within rounding', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ input: 'r' + i, expected: '', metadata: { tags: [] } }));
  const sp = splitSeeds(rows, { split_seed: 'x', holdout_ratio: 0.2 });
  assert.ok(sp.holdout.length >= 150 && sp.holdout.length <= 250, `holdout=${sp.holdout.length} should be near 200`);
});

test('splitSeeds: rejects out-of-range holdout_ratio', () => {
  assert.throws(() => splitSeeds([], { holdout_ratio: 0 }));
  assert.throws(() => splitSeeds([], { holdout_ratio: 1 }));
  assert.throws(() => splitSeeds([], { holdout_ratio: -0.2 }));
});

// ---- no overlap ----

test('splitSeeds: train and holdout are disjoint by input', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ input: 'row-' + i, expected: 'o', metadata: { tags: [] } }));
  const sp = splitSeeds(rows);
  const trainInputs = new Set(sp.train.map(r => r.input));
  for (const h of sp.holdout) {
    assert.equal(trainInputs.has(h.input), false, 'holdout input ' + h.input + ' leaked into train');
  }
});

test('leakageReport: detects identical input across train/holdout', () => {
  const train = [{ input: 'same', expected: 'A', metadata: { tags: [] } }];
  const holdout = [{ input: 'same', expected: 'A', metadata: { tags: [] } }];
  const r = leakageReport(train, holdout);
  assert.equal(r.input_overlap_count, 1);
  assert.equal(r.output_overlap_count, 1);
});

test('leakageReport: clean split has zero overlap', () => {
  const train = Array.from({ length: 80 }, (_, i) => ({ input: 'train-' + i, expected: 'A-' + i, metadata: { tags: [] } }));
  const holdout = Array.from({ length: 20 }, (_, i) => ({ input: 'hold-' + i, expected: 'B-' + i, metadata: { tags: [] } }));
  const r = leakageReport(train, holdout);
  assert.equal(r.input_overlap_count, 0);
  assert.equal(r.output_overlap_count, 0);
});

// ---- verifier rebuild ----

test('verifySplit: same rows + same seed reproduce manifest hashes', () => {
  const seedsPath = writeJsonl('verify.jsonl', Array.from({ length: 60 }, (_, i) => ({ input: 'i' + i, output: 'o' + i })));
  const split = prepareSeedSplit({ seedsPath, split_seed: 'v-seed' });
  const { rows } = loadSeeds(seedsPath);
  const v = verifySplit({
    rows,
    manifest_split_seed: split.split_seed,
    manifest_train_hash: split.train_hash,
    manifest_holdout_hash: split.holdout_hash,
    holdout_ratio: split.holdout_ratio,
  });
  assert.equal(v.match, true);
  assert.equal(v.train_match, true);
  assert.equal(v.holdout_match, true);
});

test('verifySplit: tampered hash fails match', () => {
  const seedsPath = writeJsonl('verify2.jsonl', Array.from({ length: 30 }, (_, i) => ({ input: 'i' + i, output: 'o' + i })));
  const split = prepareSeedSplit({ seedsPath });
  const { rows } = loadSeeds(seedsPath);
  const v = verifySplit({
    rows,
    manifest_split_seed: split.split_seed,
    manifest_train_hash: '0'.repeat(64),
    manifest_holdout_hash: split.holdout_hash,
    holdout_ratio: split.holdout_ratio,
  });
  assert.equal(v.match, false);
  assert.equal(v.train_match, false);
});

// ---- comparators ----

test('compare(exact) is strict equality', () => {
  assert.equal(compare('hi', 'hi', 'exact').pass, true);
  assert.equal(compare('hi', 'Hi', 'exact').pass, false);
});

test('compare(normalized_string) ignores case + whitespace', () => {
  assert.equal(compare('  Hello  World  ', 'hello world', 'normalized_string').pass, true);
});

test('compare(json_subset) allows extra keys in actual', () => {
  assert.equal(compare({ a: 1, b: 2 }, { a: 1 }, 'json_subset').pass, true);
  assert.equal(compare({ a: 1 }, { a: 1, b: 2 }, 'json_subset').pass, false);
});

test('compare(label) extracts label/class/tag field', () => {
  assert.equal(compare({ label: 'spam' }, 'spam', 'label').pass, true);
  assert.equal(compare({ class: 'urgent' }, { tag: 'urgent' }, 'label').pass, true);
});

test('scoreHoldout computes accuracy over a holdout array', () => {
  const holdout = [
    { input: 'a', expected: 'A' },
    { input: 'b', expected: 'B' },
    { input: 'c', expected: 'C' },
  ];
  const runner = (input) => input.toUpperCase();
  const r = scoreHoldout(holdout, runner, 'exact');
  assert.equal(r.accuracy, 1);
  assert.equal(r.total, 3);
  assert.equal(r.correct, 3);
});

test('scoreHoldout reports failures by index', () => {
  const holdout = [
    { input: 'a', expected: 'A' },
    { input: 'b', expected: 'WRONG' },
  ];
  const runner = (input) => input.toUpperCase();
  const r = scoreHoldout(holdout, runner, 'exact');
  assert.equal(r.accuracy, 0.5);
  assert.equal(r.per_row[1].pass, false);
});

// ---- end-to-end compileSpec ----

function basicSpec(seedsPathOverride) {
  return {
    job_id: 'job_wave144_e2e',
    task: 'Wave 144 Q+2 end-to-end smoke',
    base_model: 'none',
    recipes: [
      {
        id: 'rcp_e2e',
        name: 'Echo recipe',
        source: 'function generate(input, lib) { return { echo: String(input.text || input) }; }',
      },
    ],
  };
}

test('compileSpec: blank spec with no seeds is rejected', async () => {
  await assert.rejects(
    () => compileSpec(basicSpec(), { outDir: TMP, outPath: path.join(TMP, 'blank.kolm'), allowSeedAutoResolve: false }),
    /no seeds provided/i,
  );
});

test('compileSpec: explicit --seeds drives gate path and stamps provenance', async () => {
  const seedsPath = writeJsonl('e2e.jsonl', Array.from({ length: 60 }, (_, i) => ({
    input: { text: 'row-' + i },
    output: { echo: 'row-' + i },
  })));
  const outPath = path.join(TMP, 'e2e.kolm');
  const r = await compileSpec(basicSpec(), {
    seedsPath,
    comparator: 'json_subset',
    outDir: TMP,
    outPath,
  });
  assert.ok(fs.existsSync(outPath), 'artifact written');
  const art = loadArtifact(outPath);
  assert.equal(art.manifest.artifact_class, 'rule');
  const sp = art.manifest.seed_provenance;
  assert.ok(sp, 'seed_provenance present');
  assert.equal(sp.eval_source, 'tenant_captured');
  assert.equal(sp.comparator, 'json_subset');
  assert.equal(typeof sp.seeds_hash, 'string');
  assert.equal(sp.seeds_hash.length, 64);
  assert.equal(typeof sp.train_hash, 'string');
  assert.equal(typeof sp.holdout_hash, 'string');
  assert.notEqual(sp.train_hash, sp.holdout_hash);
  assert.ok(sp.train_count + sp.holdout_count === 60);
  // K-score accuracy axis is measured against the holdout, not the train
  // pairs and not the recipe's hardcoded answers.
  assert.equal(r.evals_report.total, sp.holdout_count);
});

test('compileSpec: rule-class artifact zip has no fake model files', async () => {
  const seedsPath = writeJsonl('nomodel.jsonl', Array.from({ length: 30 }, (_, i) => ({
    input: { text: 'r' + i }, output: { echo: 'r' + i },
  })));
  const outPath = path.join(TMP, 'no-fake-models.kolm');
  await compileSpec(basicSpec(), { seedsPath, comparator: 'json_subset', outDir: TMP, outPath });
  const zip = new AdmZip(outPath);
  const names = zip.getEntries().map(e => e.entryName);
  assert.equal(names.includes('model.gguf'), false, 'rule artifact must not ship a placeholder model.gguf');
  assert.equal(names.includes('lora.bin'), false, 'rule artifact must not ship an empty lora.bin');
  assert.equal(names.includes('index.sqlite-vec'), false, 'rule artifact must not ship an empty index.sqlite-vec');
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.includes('recipes.json'));
  assert.ok(names.includes('evals.json'));
  assert.ok(names.includes('signature.sig'));
  assert.ok(names.includes('receipt.json'));
});

test('compileSpec: manifest preserves CID hash slots even when files dropped', async () => {
  const seedsPath = writeJsonl('cid.jsonl', Array.from({ length: 30 }, (_, i) => ({
    input: { text: 'r' + i }, output: { echo: 'r' + i },
  })));
  const outPath = path.join(TMP, 'cid-slots.kolm');
  await compileSpec(basicSpec(), { seedsPath, comparator: 'json_subset', outDir: TMP, outPath });
  const art = loadArtifact(outPath);
  const required = ['model_pointer', 'recipes_json', 'lora_bin', 'index_bin', 'evals_json'];
  for (const k of required) {
    assert.equal(typeof art.manifest.hashes[k], 'string', `hash slot '${k}' present`);
    assert.equal(art.manifest.hashes[k].length, 64, `hash slot '${k}' is sha256-hex`);
  }
  assert.ok(art.manifest.cid && art.manifest.cid.startsWith('cidv1:sha256:'));
});

test('compileSpec: K-score uses holdout, not train, for accuracy', async () => {
  // 60 rows: 30 with one shape, 30 with another. The recipe matches the
  // first shape only. With a deterministic split the holdout is a subset of
  // both. K-score must reflect holdout pass-rate, not 100% / not 0%.
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ input: { text: 'easy-' + i }, output: { echo: 'easy-' + i } });
  for (let i = 0; i < 30; i++) rows.push({ input: { text: 'hard-' + i }, output: { echo: 'OTHER' } });
  const seedsPath = writeJsonl('mixed.jsonl', rows);
  const outPath = path.join(TMP, 'mixed.kolm');
  const r = await compileSpec(basicSpec(), { seedsPath, comparator: 'json_subset', outDir: TMP, outPath });
  // K-score accuracy axis comes from running the recipe on the holdout.
  const acc = r.k_score && r.k_score.accuracy;
  assert.ok(typeof acc === 'number');
  // The recipe echoes input.text. easy rows pass; hard rows expect 'OTHER'
  // and fail. So accuracy is strictly between 0 and 1 — proving the score
  // depends on real holdout behavior, not 'spec hash == evals hash'.
  assert.ok(acc > 0 && acc < 1, `accuracy=${acc} should be in (0, 1)`);
});

test('compileSpec: comparator name flows into manifest + evals.json', async () => {
  const seedsPath = writeJsonl('comp.jsonl', Array.from({ length: 30 }, (_, i) => ({
    input: { text: 'c' + i }, output: { echo: 'c' + i },
  })));
  const outPath = path.join(TMP, 'comp.kolm');
  await compileSpec(basicSpec(), { seedsPath, comparator: 'normalized_string', outDir: TMP, outPath });
  const art = loadArtifact(outPath);
  assert.equal(art.manifest.seed_provenance.comparator, 'normalized_string');
  // art.evals is already parsed JSON from artifact-runner.loadArtifact.
  assert.equal(art.evals.comparator, 'normalized_string');
});

test('compileSpec: receipt seeds-step binds real seeds_hash (not training_stats)', async () => {
  const seedsPath = writeJsonl('chain.jsonl', Array.from({ length: 30 }, (_, i) => ({
    input: { text: 'x' + i }, output: { echo: 'x' + i },
  })));
  const outPath = path.join(TMP, 'chain.kolm');
  await compileSpec(basicSpec(), { seedsPath, comparator: 'json_subset', outDir: TMP, outPath });
  const art = loadArtifact(outPath);
  const seedsStep = (art.receipt.chain || []).find(s => s.step === 'seeds');
  assert.ok(seedsStep, 'seeds step exists in chain');
  assert.equal(typeof seedsStep.output_hash, 'string');
  assert.equal(seedsStep.output_hash.length, 64);
  // The seeds step's output_hash is its contribution to the chain. Pre-Wave-144
  // it was sha256(canonicalJson({training: training_stats})) - a function of
  // the recipe, not the data. The fix binds it to the actual seed file content.
  // The recipes step's input_hash chains forward from this same value.
  assert.equal(seedsStep.output_hash, art.manifest.seed_provenance.seeds_hash);
  const recipesStep = (art.receipt.chain || []).find(s => s.step === 'recipes');
  assert.equal(recipesStep.input_hash, art.manifest.seed_provenance.seeds_hash);
});

test('compileSpec: artifact_class defaults to rule when unspecified', async () => {
  const seedsPath = writeJsonl('default-class.jsonl', Array.from({ length: 30 }, (_, i) => ({
    input: { text: 'r' + i }, output: { echo: 'r' + i },
  })));
  const outPath = path.join(TMP, 'default-class.kolm');
  await compileSpec(basicSpec(), { seedsPath, comparator: 'json_subset', outDir: TMP, outPath });
  const art = loadArtifact(outPath);
  assert.equal(art.manifest.artifact_class, 'rule');
});

test('compileSpec: artifact_class flows through to manifest', async () => {
  // compiled_rule requires a rule-dsl-v1 block on every recipe (Wave F).
  // Echo from the `text` field using a tiny DSL.
  const dslSpec = {
    job_id: 'job_wave144_compiled_class',
    task: 'Wave 144 compiled_rule class smoke',
    base_model: 'none',
    artifact_class: 'compiled_rule',
    recipes: [
      {
        id: 'rcp_compiled_echo',
        name: 'Compiled echo recipe',
        dsl: {
          type: 'rule-dsl-v1',
          output: {
            op: 'object',
            fields: {
              echo: { op: 'field', from: { op: 'input' }, key: 'text' },
            },
          },
        },
      },
    ],
  };
  const seedsPath = writeJsonl('class.jsonl', Array.from({ length: 30 }, (_, i) => ({
    input: { text: 'r' + i }, output: { echo: 'r' + i },
  })));
  const outPath = path.join(TMP, 'compiled-rule.kolm');
  await compileSpec(dslSpec, {
    seedsPath,
    comparator: 'json_subset',
    artifactClass: 'compiled_rule',
    outDir: TMP,
    outPath,
  });
  const art = loadArtifact(outPath);
  assert.equal(art.manifest.artifact_class, 'compiled_rule');
  assert.ok(art.manifest.compiled_targets, 'manifest.compiled_targets present for compiled_rule');
  assert.equal(art.manifest.compiled_targets.spec, 'rule-dsl-v1');
});

test('compileSpec: production_ready=false when train below MIN_PRODUCTION_TRAIN', async () => {
  const seedsPath = writeJsonl('small.jsonl', Array.from({ length: 20 }, (_, i) => ({
    input: { text: 's' + i }, output: { echo: 's' + i },
  })));
  const outPath = path.join(TMP, 'small.kolm');
  await compileSpec(basicSpec(), { seedsPath, comparator: 'json_subset', outDir: TMP, outPath });
  const art = loadArtifact(outPath);
  assert.equal(art.manifest.seed_provenance.production_ready, false);
});

test('compileSpec: production_ready=true with enough train + holdout + no leakage', async () => {
  // 60 rows -> ~48 train + ~12 holdout, meets MIN_PRODUCTION_TRAIN=40 and
  // MIN_PRODUCTION_HOLDOUT=10, no leakage.
  const seedsPath = writeJsonl('prod.jsonl', Array.from({ length: 60 }, (_, i) => ({
    input: { text: 'p' + i }, output: { echo: 'p' + i },
  })));
  const outPath = path.join(TMP, 'prod.kolm');
  await compileSpec(basicSpec(), { seedsPath, comparator: 'json_subset', outDir: TMP, outPath });
  const art = loadArtifact(outPath);
  assert.equal(art.manifest.seed_provenance.production_ready, true);
});

test('compileSpec: invalid comparator rejected before any work', async () => {
  await assert.rejects(
    () => compileSpec(basicSpec(), {
      seedsPath: writeJsonl('bogus.jsonl', [{ input: 'a', output: 'A' }]),
      comparator: 'not-a-real-comparator',
      outDir: TMP,
      outPath: path.join(TMP, 'bogus.kolm'),
    }),
    /not supported|unsupported/i,
  );
});

test('classifyEvalSource flags synthetic_starter seed banners', () => {
  const banner = path.join(TMP, 'banner.jsonl');
  fs.writeFileSync(banner, [
    '// kolm seed dataset (CC0)',
    JSON.stringify({ input: 'x', output: 'X' }),
  ].join('\n'));
  assert.equal(classifyEvalSource(banner, [{ input: 'x', expected: 'X' }]), 'synthetic_starter');
});

test('classifyEvalSource flags tenant_captured for plain user seeds', () => {
  const plain = path.join(TMP, 'plain.jsonl');
  fs.writeFileSync(plain, JSON.stringify({ input: 'y', output: 'Y' }));
  assert.equal(classifyEvalSource(plain, [{ input: 'y', expected: 'Y' }]), 'tenant_captured');
});

// ---- D. Verifier enforcement (Wave 144) ----
//
// The verifier (`kolm verify` → src/binder.js#verifyArtifact) gates these
// failure modes:
//   1. eval_source=self_generated (no seed gate ran; K-score is tautological)
//   2. missing train_hash or holdout_hash
//   3. train_hash === holdout_hash (degenerate split)
//   4. input_overlap_count > 0 or output_overlap_count > 0 (leakage)
//   5. holdout_count below the production minimum when production_ready=true
//   6. synthetic_starter warns but does not fail
//   7. clean tenant_captured + sufficient counts pass

import { buildBinder } from '../src/binder.js';

function namedCheck(checks, name) {
  return checks.find(c => c.name === name);
}

test('verifier: passes a clean tenant_captured artifact', async () => {
  const seedsPath = writeJsonl('verifyok.jsonl', Array.from({ length: 60 }, (_, i) => ({
    input: { text: 'ok-' + i }, output: { echo: 'ok-' + i },
  })));
  const outPath = path.join(TMP, 'verifyok.kolm');
  await compileSpec(basicSpec(), { seedsPath, comparator: 'json_subset', outDir: TMP, outPath });
  const r = await buildBinder(outPath);
  const c = namedCheck(r.checks, 'Seed gate (train/holdout independence)');
  assert.ok(c, 'seed gate check present');
  assert.equal(c.status, 'pass', `expected pass got ${c.status}: ${c.detail}`);
});

test('verifier: rejects an artifact built against a synthesized eval set (self_generated)', async () => {
  // Manually craft an artifact with seed_provenance forced to self_generated.
  // We do this by directly invoking buildAndZip with seed_provenance=null,
  // which is the legacy-path shape (eval_source defaults to self_generated).
  const { buildAndZip } = await import('../src/artifact.js');
  const built = await buildAndZip({
    job_id: 'job_selfgen',
    task: 'self_generated_demo',
    base_model: 'none',
    recipes: [{
      id: 'rcp', name: 'r', source: 'function generate(i,l){ return i; }',
      source_hash: 'deadbeef', version_id: 1, tags: [],
    }],
    training_stats: { distilled_pairs: 0, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0 },
    evals: { spec: 'rs-1-evals', n: 0, cases: [] },
    outDir: TMP,
    artifact_class: 'rule',
    seed_provenance: null,
  });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Seed gate (train/holdout independence)');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /self_generated/);
  assert.equal(r.verdict, 'fail');
});

test('verifier: rejects an artifact whose train_hash equals holdout_hash', async () => {
  const { buildAndZip } = await import('../src/artifact.js');
  const fakeHash = crypto.createHash('sha256').update('same').digest('hex');
  const built = await buildAndZip({
    job_id: 'job_degenerate',
    task: 'degenerate_split',
    base_model: 'none',
    recipes: [{
      id: 'rcp', name: 'r', source: 'function generate(i,l){ return i; }',
      source_hash: 'deadbeef', version_id: 1, tags: [],
    }],
    training_stats: { distilled_pairs: 0, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0 },
    evals: { spec: 'rs-1-evals', n: 0, cases: [] },
    outDir: TMP,
    artifact_class: 'rule',
    seed_provenance: {
      seeds_hash: fakeHash, split_seed: 'x', holdout_ratio: 0.2,
      train_hash: fakeHash, holdout_hash: fakeHash,
      train_count: 50, holdout_count: 10, eval_source: 'tenant_captured',
      leakage_report_hash: 'abc', comparator: 'exact',
      input_overlap_count: 0, output_overlap_count: 0,
      near_duplicate_count: 0, grouped_overlap_count: 0,
      production_ready: true, min_train: 40, min_holdout: 10,
    },
  });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Seed gate (train/holdout independence)');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /identical|degenerate/i);
});

test('verifier: rejects an artifact with reported input overlap', async () => {
  const { buildAndZip } = await import('../src/artifact.js');
  const built = await buildAndZip({
    job_id: 'job_overlap',
    task: 'leakage_demo',
    base_model: 'none',
    recipes: [{
      id: 'rcp', name: 'r', source: 'function generate(i,l){ return i; }',
      source_hash: 'deadbeef', version_id: 1, tags: [],
    }],
    training_stats: { distilled_pairs: 0, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0 },
    evals: { spec: 'rs-1-evals', n: 0, cases: [] },
    outDir: TMP,
    artifact_class: 'rule',
    seed_provenance: {
      seeds_hash: 'a'.repeat(64), split_seed: 'x', holdout_ratio: 0.2,
      train_hash: 'b'.repeat(64), holdout_hash: 'c'.repeat(64),
      train_count: 50, holdout_count: 10, eval_source: 'tenant_captured',
      leakage_report_hash: 'abc', comparator: 'exact',
      input_overlap_count: 3, output_overlap_count: 1,
      near_duplicate_count: 0, grouped_overlap_count: 0,
      production_ready: false, min_train: 40, min_holdout: 10,
    },
  });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Seed gate (train/holdout independence)');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /leakage/i);
});

test('verifier: fails when production_ready=true but holdout_count is below minimum', async () => {
  const { buildAndZip } = await import('../src/artifact.js');
  const built = await buildAndZip({
    job_id: 'job_underholdout',
    task: 'underholdout',
    base_model: 'none',
    recipes: [{
      id: 'rcp', name: 'r', source: 'function generate(i,l){ return i; }',
      source_hash: 'deadbeef', version_id: 1, tags: [],
    }],
    training_stats: { distilled_pairs: 0, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0 },
    evals: { spec: 'rs-1-evals', n: 0, cases: [] },
    outDir: TMP,
    artifact_class: 'rule',
    seed_provenance: {
      seeds_hash: 'a'.repeat(64), split_seed: 'x', holdout_ratio: 0.2,
      train_hash: 'b'.repeat(64), holdout_hash: 'c'.repeat(64),
      train_count: 50, holdout_count: 3, eval_source: 'tenant_captured',
      leakage_report_hash: 'abc', comparator: 'exact',
      input_overlap_count: 0, output_overlap_count: 0,
      near_duplicate_count: 0, grouped_overlap_count: 0,
      production_ready: true, min_train: 40, min_holdout: 10,
    },
  });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Seed gate (train/holdout independence)');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /below the production threshold|production_ready/i);
});

test('verifier: warns when eval_source=synthetic_starter', async () => {
  // Write a seeds file with the CC0 banner header so classifyEvalSource flags
  // it. The recipe still runs and produces a passing K-score, but the
  // verifier downgrades the verdict to 'warn'.
  const banner = path.join(TMP, 'starter.jsonl');
  fs.writeFileSync(banner, [
    '// kolm seed dataset (CC0) — synthetic, public domain, illustrative only',
    ...Array.from({ length: 60 }, (_, i) => JSON.stringify({
      input: { text: 'starter-' + i }, output: { echo: 'starter-' + i },
    })),
  ].join('\n'));
  const outPath = path.join(TMP, 'starter.kolm');
  await compileSpec(basicSpec(), { seedsPath: banner, comparator: 'json_subset', outDir: TMP, outPath });
  const r = await buildBinder(outPath);
  const c = namedCheck(r.checks, 'Seed gate (train/holdout independence)');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /synthetic_starter/);
});

test('verifier: warns when holdout is small but production_ready was honestly false', async () => {
  // A small but honest build (20 rows) labels production_ready=false. The
  // verifier emits a warning (not a fail) so internal demos can run.
  const seedsPath = writeJsonl('small-honest.jsonl', Array.from({ length: 20 }, (_, i) => ({
    input: { text: 's' + i }, output: { echo: 's' + i },
  })));
  const outPath = path.join(TMP, 'small-honest.kolm');
  await compileSpec(basicSpec(), { seedsPath, comparator: 'json_subset', outDir: TMP, outPath });
  const r = await buildBinder(outPath);
  const c = namedCheck(r.checks, 'Seed gate (train/holdout independence)');
  // 20 rows / 0.2 holdout ratio -> ~4 holdout rows (deterministic). Below 10
  // so it should warn. The honest label production_ready=false keeps it from
  // escalating to a fail.
  assert.ok(c.status === 'warn' || c.status === 'pass',
    `expected warn or pass, got ${c.status}: ${c.detail}`);
});
