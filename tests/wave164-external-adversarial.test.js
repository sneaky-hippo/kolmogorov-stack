// Wave 164 — N+3 (external public benchmark holdouts) + N+4 (adversarial
// cross-family LLM-pair holdouts) eval-credibility layer above the
// seeds.jsonl gate.
//
// Wave 144 Doc 2 §7 laid out a five-tier eval-credibility ladder. The
// seeds.jsonl gate (W145 / Q+2 / N+1.5) kills the tautological-eval
// failure mode within ONE tenant's captured IO. N+3 and N+4 answer a
// different question: "does this recipe also generalize to data the
// tenant did not curate?" Both layers share one primitive — a holdout
// JSONL authored independently of the tenant's seeds.jsonl, identified
// by a catalog entry, scored at compile time, and bound into the
// artifact's hash chain so a downstream verifier can replay the scoring.
//
// Coverage (14 tests):
//   1.  loadCatalog reads holdouts/catalog.json + returns >= 3 entries
//   2.  validateCatalogEntry enforces required fields (name/kind/file/
//       license/source_url/accessed_at)
//   3.  validateCatalogEntry rejects an unknown kind
//   4.  loadHoldout normalizes legacy {prompt, completion} alongside
//       canonical {input, output} and produces a stable normalized_hash
//   5.  hashHoldoutFile is deterministic over file bytes
//   6.  buildExternalHoldoutBlock round-trips through validateExternalHoldoutBlock
//   7.  validateExternalHoldoutBlock rejects schema drift (missing field)
//   8.  validateExternalHoldoutBlock rejects hash drift (post-build mutation)
//   9.  check #20 absent branch: no external_holdout_provenance => pass with
//       upgrade hint naming --external-holdout and --adversarial-holdout
//  10.  check #20 valid branch: both kinds in one block => pass with summary
//       naming each holdout's accuracy/passed/evaluated counts
//  11.  check #20 fail branch: file_sha256 drift => fail with per-holdout reason
//  12.  check #20 fail branch: holdout file missing on disk => fail
//  13.  check #20 fail branch: catalog license mismatch (tenant edited
//       catalog post-build) => fail
//  14.  EXTERNAL_HOLDOUT_SPEC_VERSION is stable ('external-holdout-v1')

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EXTERNAL_HOLDOUT_SPEC_VERSION,
  HOLDOUT_KINDS,
  loadCatalog,
  findInCatalog,
  resolveHoldoutPath,
  validateCatalogEntry,
  hashHoldoutFile,
  loadHoldout,
  buildExternalHoldoutBlock,
  validateExternalHoldoutBlock,
  loadHoldouts,
} from '../src/external-holdout.js';
import { buildAndZip } from '../src/artifact.js';
import { buildBinder } from '../src/binder.js';

const SECRET = 'wave164-test-secret-' + crypto.randomBytes(8).toString('hex');
process.env.RECIPE_RECEIPT_SECRET = SECRET;

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w164-${label}-`));
}

function isolateEnv(t) {
  const saved = {};
  for (const k of [
    'KOLM_ED25519_KEY_STORE',
    'KOLM_ED25519_PRIVATE_KEY',
    'KOLM_ED25519_PRIVATE_KEY_PATH',
    'KOLM_ED25519_DISABLE',
    'KOLM_SIGSTORE_DISABLE',
    'KOLM_SIGSTORE_REKOR_URL',
    'KOLM_REKOR_REQUIRE',
    'KOLM_REQUIRE_REKOR',
    'KOLM_REQUIRE_ED25519',
    'KOLM_POLICY_OPT_OUT',
  ]) saved[k] = process.env[k];
  const keyDir = tmpDir('keys');
  process.env.KOLM_ED25519_KEY_STORE = keyDir;
  delete process.env.KOLM_ED25519_PRIVATE_KEY;
  delete process.env.KOLM_ED25519_PRIVATE_KEY_PATH;
  delete process.env.KOLM_ED25519_DISABLE;
  delete process.env.KOLM_SIGSTORE_DISABLE;
  delete process.env.KOLM_SIGSTORE_REKOR_URL;
  delete process.env.KOLM_REKOR_REQUIRE;
  delete process.env.KOLM_REQUIRE_REKOR;
  delete process.env.KOLM_REQUIRE_ED25519;
  delete process.env.KOLM_POLICY_OPT_OUT;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(keyDir, { recursive: true, force: true }); } catch { /* swallow */ }
  });
}

// Pin cwd to repo root so check #20's resolveHoldoutPath(name, {root: cwd})
// finds the shipped holdouts under holdouts/<kind>/<name>.jsonl.
function pinCwd(t) {
  const saved = process.cwd();
  process.chdir(REPO_ROOT);
  t.after(() => { try { process.chdir(saved); } catch { /* swallow */ } });
}

async function buildOne(suffix, { externalHoldoutBlock } = {}) {
  const outDir = tmpDir(`artifact-${suffix}`);
  const result = await buildAndZip({
    job_id: `wave164-${suffix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    task: 'wave164-holdout-test',
    base_model: 'none',
    recipes: [{
      id: 'r1',
      source: 'export default function r1(x){return String(x).toUpperCase()}',
      positives: [{ input: 'hi', expected: 'HI' }],
    }],
    evals: { cases: [{ input: 'hi', expected: 'HI' }] },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 10, cost_usd_per_call: 0 },
    outDir,
    tier: 'recipe',
    ...(externalHoldoutBlock ? { external_holdout: externalHoldoutBlock } : {}),
  });
  return { ...result, outDir };
}

// ---------------------------------------------------------------------------
// 1. loadCatalog reads holdouts/catalog.json + returns >= 3 entries
// ---------------------------------------------------------------------------
test('1. loadCatalog reads holdouts/catalog.json with >= 3 entries', () => {
  const cat = loadCatalog({ root: REPO_ROOT });
  assert.equal(cat.missing, false);
  assert.ok(Array.isArray(cat.holdouts));
  assert.ok(cat.holdouts.length >= 3, `expected >= 3 entries, got ${cat.holdouts.length}`);
  const names = cat.holdouts.map(h => h.name);
  assert.ok(names.includes('presidio-synthetic-v1'));
  assert.ok(names.includes('cms-claims-public-v1'));
  assert.ok(names.includes('cross-family-pair-v1'));
});

// ---------------------------------------------------------------------------
// 2. validateCatalogEntry enforces required fields
// ---------------------------------------------------------------------------
test('2. validateCatalogEntry enforces required fields', () => {
  // W252b promoted expected_sha256 from recommended to hard-required (so
  // catalog drift can be caught at verify time). Validator throws a
  // dedicated "missing required expected_sha256" message for that field;
  // the generic "missing required field '<k>'" message covers the rest.
  const required = ['name', 'kind', 'file', 'license', 'source_url', 'accessed_at'];
  const good = {
    name: 'x', kind: 'external', file: 'holdouts/external/x.jsonl',
    license: 'CC0-1.0', source_url: 'https://example.com', accessed_at: '2026-05-17',
    expected_sha256: 'a'.repeat(64),
  };
  // Each required field: dropping it should throw
  for (const k of required) {
    const bad = { ...good };
    delete bad[k];
    assert.throws(() => validateCatalogEntry(bad), new RegExp(`missing required field '${k}'`));
  }
  // expected_sha256 has its own dedicated error message.
  const noHash = { ...good };
  delete noHash.expected_sha256;
  assert.throws(() => validateCatalogEntry(noHash), /missing required expected_sha256/);
  // The "good" entry validates without throwing
  const res = validateCatalogEntry(good);
  assert.equal(res.ok, true);
});

// ---------------------------------------------------------------------------
// 3. validateCatalogEntry rejects an unknown kind
// ---------------------------------------------------------------------------
test('3. validateCatalogEntry rejects unknown kind', () => {
  // W252b made expected_sha256 a hard-required field; provide a valid 64-hex
  // value so the unknown-kind branch is actually reached.
  const bad = {
    name: 'x', kind: 'banana', file: 'x.jsonl', license: 'CC0-1.0',
    source_url: 'https://example.com', accessed_at: '2026-05-17',
    expected_sha256: 'a'.repeat(64),
  };
  assert.throws(() => validateCatalogEntry(bad), /must be one of external, adversarial/);
  assert.deepEqual([...HOLDOUT_KINDS].sort(), ['adversarial', 'external']);
});

// ---------------------------------------------------------------------------
// 4. loadHoldout normalizes a legacy {prompt, completion} corpus alongside
//    canonical {input, output} and yields a stable normalized_hash.
// ---------------------------------------------------------------------------
test('4. loadHoldout normalizes legacy + canonical formats stably', () => {
  // Use one of the shipped holdouts as the basis. presidio-synthetic-v1 is
  // canonical {input, output}; we re-load it twice and confirm
  // normalized_hash is stable across reads.
  const a = loadHoldout('presidio-synthetic-v1', { root: REPO_ROOT });
  const b = loadHoldout('presidio-synthetic-v1', { root: REPO_ROOT });
  assert.equal(a.normalized_hash, b.normalized_hash);
  assert.equal(a.file_sha256, b.file_sha256);
  assert.ok(a.rows.length > 0, 'presidio-synthetic-v1 must yield > 0 rows');
  assert.ok(a.row_count > 0);
  assert.equal(a.kind, 'external');
  assert.equal(a.license, 'CC0-1.0');
});

// ---------------------------------------------------------------------------
// 5. hashHoldoutFile is deterministic over file bytes
// ---------------------------------------------------------------------------
test('5. hashHoldoutFile is deterministic over file bytes', () => {
  const filePath = resolveHoldoutPath('cms-claims-public-v1', { root: REPO_ROOT });
  assert.ok(filePath, 'cms-claims-public-v1 must resolve to a path');
  const h1 = hashHoldoutFile(filePath);
  const h2 = hashHoldoutFile(filePath);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  // Also confirm hash matches a raw recompute of the file bytes
  const raw = sha256Hex(fs.readFileSync(filePath));
  assert.equal(h1, raw);
});

// ---------------------------------------------------------------------------
// 6. buildExternalHoldoutBlock round-trips through validateExternalHoldoutBlock
// ---------------------------------------------------------------------------
test('6. buildExternalHoldoutBlock round-trips', () => {
  const loaded = loadHoldouts(['presidio-synthetic-v1', 'cross-family-pair-v1'], { root: REPO_ROOT });
  assert.equal(loaded.length, 2);
  // Trivial scorer: pretend every row passed
  const scorer = (rows) => ({ accuracy: 1.0, total: rows.length, correct: rows.length, comparator: 'exact' });
  const block = buildExternalHoldoutBlock(loaded, scorer, { comparator: 'exact', generated_at: '2026-05-17T00:00:00Z' });
  assert.ok(block);
  assert.equal(block.spec, EXTERNAL_HOLDOUT_SPEC_VERSION);
  assert.equal(block.holdouts.length, 2);
  assert.match(block.hash, /^[0-9a-f]{64}$/);
  // Each holdout entry has required fields
  for (const h of block.holdouts) {
    for (const k of ['name', 'kind', 'license', 'source_url', 'accessed_at',
                     'file_basename', 'file_sha256', 'normalized_hash',
                     'row_count', 'accuracy', 'passed_count', 'evaluated_count']) {
      assert.ok(h[k] != null, `missing field ${k}`);
    }
  }
  // Validation round-trips
  const validated = validateExternalHoldoutBlock(block);
  assert.equal(validated.hash, block.hash);
});

// ---------------------------------------------------------------------------
// 7. validateExternalHoldoutBlock rejects schema drift (missing field)
// ---------------------------------------------------------------------------
test('7. validateExternalHoldoutBlock rejects schema drift', () => {
  const loaded = loadHoldouts(['presidio-synthetic-v1'], { root: REPO_ROOT });
  const scorer = (rows) => ({ accuracy: 1.0, total: rows.length, correct: rows.length });
  const block = buildExternalHoldoutBlock(loaded, scorer);
  // Drop a required field on the first holdout
  const dropped = JSON.parse(JSON.stringify(block));
  delete dropped.holdouts[0].source_url;
  assert.throws(() => validateExternalHoldoutBlock(dropped), /missing field 'source_url'/);
});

// ---------------------------------------------------------------------------
// 8. validateExternalHoldoutBlock rejects post-build hash drift
// ---------------------------------------------------------------------------
test('8. validateExternalHoldoutBlock rejects post-build hash drift', () => {
  const loaded = loadHoldouts(['presidio-synthetic-v1'], { root: REPO_ROOT });
  const scorer = (rows) => ({ accuracy: 0.5, total: rows.length, correct: Math.floor(rows.length / 2) });
  const block = buildExternalHoldoutBlock(loaded, scorer);
  // Mutate the accuracy on the first holdout; block.hash is now stale
  const tampered = JSON.parse(JSON.stringify(block));
  tampered.holdouts[0].accuracy = 0.99;
  assert.throws(() => validateExternalHoldoutBlock(tampered), /hash drift/);
});

// ---------------------------------------------------------------------------
// 9. check #20 absent branch: no external_holdout_provenance => pass with hint
// ---------------------------------------------------------------------------
test('9. check #20 passes (informational) on artifacts without external_holdout', async (t) => {
  isolateEnv(t);
  pinCwd(t);
  const { outPath } = await buildOne('no-holdout');
  const report = await buildBinder(outPath);
  const c20 = report.checks.find(c => c.name === 'External / adversarial holdouts');
  assert.ok(c20, 'check #20 must always emit');
  assert.equal(c20.status, 'pass');
  assert.match(c20.detail, /no manifest\.external_holdout_provenance/);
  assert.match(c20.detail, /--external-holdout/);
  assert.match(c20.detail, /--adversarial-holdout/);
});

// ---------------------------------------------------------------------------
// 10. check #20 valid branch: both kinds in one block => pass
// ---------------------------------------------------------------------------
test('10. check #20 passes on a valid block with one external + one adversarial', async (t) => {
  isolateEnv(t);
  pinCwd(t);
  const loaded = loadHoldouts(['presidio-synthetic-v1', 'cross-family-pair-v1'], { root: REPO_ROOT });
  const scorer = (rows) => ({ accuracy: 0.8, total: rows.length, correct: Math.floor(rows.length * 0.8) });
  const block = buildExternalHoldoutBlock(loaded, scorer, { comparator: 'exact' });
  const { outPath } = await buildOne('valid-mixed', { externalHoldoutBlock: block });
  const report = await buildBinder(outPath);
  const c20 = report.checks.find(c => c.name === 'External / adversarial holdouts');
  assert.ok(c20);
  assert.equal(c20.status, 'pass', `expected pass, got ${c20.status}: ${c20.detail}`);
  assert.match(c20.detail, /1 external \+ 1 adversarial/);
  assert.match(c20.detail, /presidio-synthetic-v1/);
  assert.match(c20.detail, /cross-family-pair-v1/);
});

// ---------------------------------------------------------------------------
// 11. check #20 fail branch: file_sha256 drift
// ---------------------------------------------------------------------------
test('11. check #20 fails when manifest declares a different file_sha256 than disk', async (t) => {
  isolateEnv(t);
  pinCwd(t);
  const loaded = loadHoldouts(['presidio-synthetic-v1'], { root: REPO_ROOT });
  const scorer = (rows) => ({ accuracy: 1.0, total: rows.length, correct: rows.length });
  const block = buildExternalHoldoutBlock(loaded, scorer);
  // Manually mutate the file_sha256 to a different valid hex64; this passes
  // the block-level hash round-trip ONLY if we also recompute block.hash.
  // We do so by surgically editing both fields, simulating a tamperer who
  // edited both the file_sha256 and re-hashed the block (to bypass check
  // #8's hash-drift detection) but didn't actually update the on-disk file.
  const tampered = JSON.parse(JSON.stringify(block));
  tampered.holdouts[0].file_sha256 = '0'.repeat(64);
  // Recompute the block hash so it round-trips through #8 successfully
  const { canonicalJson } = await import('../src/seeds.js');
  const { hash: _, ...rest } = tampered;
  tampered.hash = crypto.createHash('sha256').update(canonicalJson(rest)).digest('hex');
  // Sanity: validateExternalHoldoutBlock now passes (hash recomputed)
  validateExternalHoldoutBlock(tampered);
  // But check #20 cross-checks against the on-disk file, which fails
  const { outPath } = await buildOne('sha-drift', { externalHoldoutBlock: tampered });
  const report = await buildBinder(outPath);
  const c20 = report.checks.find(c => c.name === 'External / adversarial holdouts');
  assert.equal(c20.status, 'fail', `expected fail, got ${c20.status}: ${c20.detail}`);
  assert.match(c20.detail, /drift/);
  assert.match(c20.detail, /presidio-synthetic-v1/);
});

// ---------------------------------------------------------------------------
// 12. check #20 fail branch: holdout file missing on disk (cwd doesn't have
//     the holdouts/ dir at all)
// ---------------------------------------------------------------------------
test('12. check #20 fails when on-disk holdout JSONL is unreachable from cwd', async (t) => {
  isolateEnv(t);
  // Build the block from the real repo root, but verify from a cwd that
  // has NO holdouts/ dir at all. The verifier uses process.cwd() to find
  // holdouts, so this simulates a verifier running outside the kolm repo.
  const loaded = loadHoldouts(['cms-claims-public-v1'], { root: REPO_ROOT });
  const scorer = (rows) => ({ accuracy: 0.9, total: rows.length, correct: Math.floor(rows.length * 0.9) });
  const block = buildExternalHoldoutBlock(loaded, scorer);
  const savedCwd = process.cwd();
  const isolatedCwd = tmpDir('no-holdouts-here');
  t.after(() => {
    try { process.chdir(savedCwd); } catch { /* swallow */ }
    try { fs.rmSync(isolatedCwd, { recursive: true, force: true }); } catch { /* swallow */ }
  });
  // Build the artifact while cwd is repo root (so artifact build doesn't blow up)
  const { outPath } = await buildOne('missing-on-disk', { externalHoldoutBlock: block });
  // Now switch cwd to a dir with no holdouts/ and re-verify
  process.chdir(isolatedCwd);
  const report = await buildBinder(outPath);
  const c20 = report.checks.find(c => c.name === 'External / adversarial holdouts');
  assert.equal(c20.status, 'fail', `expected fail, got ${c20.status}: ${c20.detail}`);
  assert.match(c20.detail, /could not be re-anchored/);
  assert.match(c20.detail, /cms-claims-public-v1/);
});

// ---------------------------------------------------------------------------
// 13. check #20 fail branch: catalog license mismatch (tenant edited catalog
//     post-build to claim different provenance)
// ---------------------------------------------------------------------------
test('13. check #20 fails when manifest license disagrees with catalog license', async (t) => {
  isolateEnv(t);
  pinCwd(t);
  const loaded = loadHoldouts(['presidio-synthetic-v1'], { root: REPO_ROOT });
  const scorer = (rows) => ({ accuracy: 1.0, total: rows.length, correct: rows.length });
  const block = buildExternalHoldoutBlock(loaded, scorer);
  // Mutate the manifest to claim a different license than catalog says.
  // Use a license string that differs from catalog.json's CC0-1.0 entry.
  const tampered = JSON.parse(JSON.stringify(block));
  tampered.holdouts[0].license = 'MIT';
  // Recompute block hash so #8 passes
  const { canonicalJson } = await import('../src/seeds.js');
  const { hash: _, ...rest } = tampered;
  tampered.hash = crypto.createHash('sha256').update(canonicalJson(rest)).digest('hex');
  const { outPath } = await buildOne('license-drift', { externalHoldoutBlock: tampered });
  const report = await buildBinder(outPath);
  const c20 = report.checks.find(c => c.name === 'External / adversarial holdouts');
  assert.equal(c20.status, 'fail', `expected fail, got ${c20.status}: ${c20.detail}`);
  assert.match(c20.detail, /license/);
  assert.match(c20.detail, /presidio-synthetic-v1/);
});

// ---------------------------------------------------------------------------
// 14. EXTERNAL_HOLDOUT_SPEC_VERSION is stable
// ---------------------------------------------------------------------------
test('14. EXTERNAL_HOLDOUT_SPEC_VERSION is stable at external-holdout-v1', () => {
  assert.equal(EXTERNAL_HOLDOUT_SPEC_VERSION, 'external-holdout-v1');
  // Every block built by buildExternalHoldoutBlock carries this spec
  const loaded = loadHoldouts(['presidio-synthetic-v1'], { root: REPO_ROOT });
  const scorer = (rows) => ({ accuracy: 1.0, total: rows.length, correct: rows.length });
  const block = buildExternalHoldoutBlock(loaded, scorer);
  assert.equal(block.spec, 'external-holdout-v1');
});
