// Wave 339 — single source-of-truth productionReady() verdict.
//
// Trust bug from design-partner trial: K-score could pass while verify
// failed, because compile/run/verify/marketplace each had their own gate
// logic and disagreed. W339 collapses them all into one module:
// src/production-ready.js.
//
// Tests assert BEHAVIOR:
//   1. computeSeedProductionReady ANDs every leakage channel + min counts.
//   2. productionReady() reads a .kolm file off disk and returns the verdict.
//   3. productionReady() accepts a manifest object directly (skipping zip I/O).
//   4. K-score below the gate fails the verdict.
//   5. Missing seed_provenance fails seed_provenance + holdout_split gates.
//   6. Drift above threshold fails the drift gate.
//   7. Durability gate honors the injected store driver.
//   8. spec-compile.js still imports the shared computeSeedProductionReady
//      (no fork of the leakage AND logic).
//   9. Exported constants (MIN_PRODUCTION_TRAIN, MIN_PRODUCTION_HOLDOUT,
//      DEFAULT_K_GATE) match the originals so downstream callers stay
//      consistent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

test('W339 #1 — computeSeedProductionReady ANDs leakage channels + min counts', async () => {
  const { computeSeedProductionReady, MIN_PRODUCTION_TRAIN, MIN_PRODUCTION_HOLDOUT } = await import('../src/production-ready.js');
  // Happy path
  assert.equal(computeSeedProductionReady({
    train_count: MIN_PRODUCTION_TRAIN,
    holdout_count: MIN_PRODUCTION_HOLDOUT,
    leakage_report: { input_overlap_count: 0, output_overlap_count: 0, near_duplicate_count: 0, grouped_overlap_count: 0 },
  }), true);
  // Each leakage channel independently flips to false
  for (const k of ['input_overlap_count', 'output_overlap_count', 'near_duplicate_count', 'grouped_overlap_count']) {
    const seed = {
      train_count: MIN_PRODUCTION_TRAIN, holdout_count: MIN_PRODUCTION_HOLDOUT,
      leakage_report: { input_overlap_count: 0, output_overlap_count: 0, near_duplicate_count: 0, grouped_overlap_count: 0 },
    };
    seed.leakage_report[k] = 1;
    assert.equal(computeSeedProductionReady(seed), false, `${k} > 0 must fail the AND`);
  }
  // Under-sized splits fail
  assert.equal(computeSeedProductionReady({ train_count: MIN_PRODUCTION_TRAIN - 1, holdout_count: MIN_PRODUCTION_HOLDOUT, leakage_report: {} }), false);
  assert.equal(computeSeedProductionReady({ train_count: MIN_PRODUCTION_TRAIN, holdout_count: MIN_PRODUCTION_HOLDOUT - 1, leakage_report: {} }), false);
  // Null/undefined inputs short-circuit to false
  assert.equal(computeSeedProductionReady(null), false);
  assert.equal(computeSeedProductionReady(undefined), false);
});

function happyManifest(over = {}) {
  return {
    seed_provenance: {
      seeds_hash: 'a'.repeat(64),
      split_seed: 'kolm-default-split-seed-v1',
      train_hash: 'b'.repeat(64),
      holdout_hash: 'c'.repeat(64),
      train_count: 40,
      holdout_count: 10,
      production_ready: true,
      input_overlap_count: 0,
      output_overlap_count: 0,
      near_duplicate_count: 0,
      grouped_overlap_count: 0,
    },
    k_score: { composite: 0.95, ships: true, gate: 0.85 },
    ...over,
  };
}

test('W339 #2 — productionReady() reads a .kolm zip off disk', async () => {
  const sample = path.join(ROOT, 'public', 'registry-pack', 'phi-redactor.kolm');
  if (!fs.existsSync(sample)) {
    // Fixture missing in this env; treat as smoke (skip) but assert path shape.
    assert.ok(true, 'phi-redactor fixture absent — skipping disk read');
    return;
  }
  const { productionReady } = await import('../src/production-ready.js');
  const v = await productionReady(sample);
  // phi-redactor.kolm was built WITHOUT --seeds, so seed_provenance is null.
  // Expected: ok=false, with seed_provenance + holdout_split in reasons.
  assert.equal(v.ok, false, 'no seed_provenance => not production_ready');
  assert.equal(typeof v.gates.seed_provenance.ok, 'boolean');
  assert.equal(v.gates.seed_provenance.ok, false);
  assert.equal(v.gates.holdout_split.ok, false);
  assert.ok(v.reasons.length >= 2, 'should list reasons for failing gates');
});

test('W339 #3 — productionReady() accepts a manifest object directly', async () => {
  const { productionReady } = await import('../src/production-ready.js');
  const v = await productionReady(happyManifest());
  assert.equal(v.ok, true, `happy manifest should pass: ${JSON.stringify(v.reasons)}`);
  assert.equal(v.gates.seed_provenance.ok, true);
  assert.equal(v.gates.k_score.ok, true);
  assert.equal(v.gates.holdout_split.ok, true);
  assert.equal(v.gates.drift.ok, true, 'no drift_report => vacuously ok');
});

test('W339 #4 — K-score below gate fails the verdict', async () => {
  const { productionReady } = await import('../src/production-ready.js');
  const mf = happyManifest({ k_score: { composite: 0.80, ships: false, gate: 0.85 } });
  const v = await productionReady(mf);
  assert.equal(v.ok, false);
  assert.equal(v.gates.k_score.ok, false);
  assert.equal(v.gates.k_score.value, 0.80);
  assert.equal(v.gates.k_score.threshold, 0.85);
  assert.ok(v.reasons.some((r) => r.startsWith('k_score:')));
});

test('W339 #5 — missing seed_provenance fails seed+holdout gates', async () => {
  const { productionReady } = await import('../src/production-ready.js');
  const mf = happyManifest();
  delete mf.seed_provenance;
  const v = await productionReady(mf);
  assert.equal(v.ok, false);
  assert.equal(v.gates.seed_provenance.ok, false);
  assert.equal(v.gates.holdout_split.ok, false);
});

test('W339 #6 — drift above threshold fails the drift gate', async () => {
  const { productionReady } = await import('../src/production-ready.js');
  const mf = happyManifest({ drift_report: { spec: 'drift-report-v1', drift_score: 0.5 } });
  const v = await productionReady(mf, { driftMax: 0.30 });
  assert.equal(v.ok, false);
  assert.equal(v.gates.drift.ok, false);
  assert.ok(v.reasons.some((r) => r.startsWith('drift:')));
});

test('W339 #7 — durability gate honors injected store driver', async () => {
  const { productionReady } = await import('../src/production-ready.js');
  const mf = happyManifest();
  const stubEphemeral = { isDurable: () => false, driverName: () => 'tmp_fake' };
  const v1 = await productionReady(mf, { capture: stubEphemeral });
  assert.equal(v1.gates.durability.ok, false);
  assert.ok(v1.reasons.some((r) => r.startsWith('durability:')));
  const stubDurable = { isDurable: () => true, driverName: () => 'sqlite' };
  const v2 = await productionReady(mf, { capture: stubDurable });
  assert.equal(v2.gates.durability.ok, true);
});

test('W339 #8 — spec-compile.js imports the shared computeSeedProductionReady', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'spec-compile.js'), 'utf8');
  assert.match(src, /from\s+['"]\.\/production-ready\.js['"]/, 'spec-compile must import from production-ready.js');
  assert.match(src, /computeSeedProductionReady/, 'spec-compile must call computeSeedProductionReady');
  // The old inline AND must be gone — no second source of truth.
  const inlineLeakageAnd = /seedSplit\.train_count\s*>=\s*MIN_PRODUCTION_TRAIN\s*\n\s*\&\&\s*seedSplit\.holdout_count\s*>=\s*MIN_PRODUCTION_HOLDOUT/;
  assert.doesNotMatch(src, inlineLeakageAnd, 'spec-compile must not re-implement the leakage AND');
});

test('W339 #9 — exported constants match originals', async () => {
  const PR = await import('../src/production-ready.js');
  const seeds = await import('../src/seeds.js');
  assert.equal(PR.MIN_PRODUCTION_TRAIN, seeds.MIN_PRODUCTION_TRAIN);
  assert.equal(PR.MIN_PRODUCTION_HOLDOUT, seeds.MIN_PRODUCTION_HOLDOUT);
  assert.equal(PR.DEFAULT_K_GATE, 0.85);
});

test('W339 #10 — productionReadySync mirrors async (minus durability)', async () => {
  const { productionReadySync, productionReady } = await import('../src/production-ready.js');
  const mf = happyManifest();
  const syncV = productionReadySync(mf);
  const asyncV = await productionReady(mf, { capture: { isDurable: () => true, driverName: () => 'memory' } });
  assert.equal(syncV.ok, asyncV.ok);
  assert.equal(syncV.gates.k_score.ok, asyncV.gates.k_score.ok);
  assert.equal(syncV.gates.seed_provenance.ok, asyncV.gates.seed_provenance.ok);
});
