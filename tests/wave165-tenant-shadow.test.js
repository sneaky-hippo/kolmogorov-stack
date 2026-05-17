// Wave 165 — N+5 tenant shadow corpus. The eval-credibility ladder above
// the seeds.jsonl gate (W145 / Q+2 / N+1.5) and the external+adversarial
// holdouts (W164 / N+3+N+4) — a per-tenant labeled corpus that NEVER
// leaves the tenant's environment. The artifact records {tenant_id,
// corpus_id, corpus_sha256, accuracy} only; bytes stay on the tenant's
// own server storage.
//
// Coverage (20 tests):
//   1.  SAFE_ID matches valid IDs; rejects traversal/whitespace/empty
//   2.  resolveCorpusPath yields ${KOLM_DATA_DIR}/tenant_holdouts/<t>/<c>.jsonl
//   3.  resolveCorpusPath rejects ../ traversal in tenant_id
//   4.  saveCorpus writes JSONL with canonical+legacy row normalization
//   5.  saveCorpus refuses duplicate without replace=true
//   6.  saveCorpus replace=true overwrites
//   7.  loadCorpus round-trips + computes hashes deterministically
//   8.  hashCorpusFile is deterministic + hex64
//   9.  listCorpora enumerates per-tenant
//  10.  deleteCorpus removes + returns deleted=true / false
//  11.  buildTenantShadowBlock round-trips through validateTenantShadowBlock
//  12.  validateTenantShadowBlock rejects schema drift (missing field)
//  13.  validateTenantShadowBlock rejects hash drift (post-build mutation)
//  14.  reAnchorTenantShadowBlock mode=reanchored when bytes match
//  15.  reAnchorTenantShadowBlock mode=unavailable when corpus not on disk
//  16.  check #21 absent branch: no tenant_shadow_corpus_provenance => pass
//       with upgrade hint naming POST /v1/eval/tenant_holdout +
//       --tenant-shadow-corpus
//  17.  check #21 reanchored-match: pass with file_path + bytes-match note
//  18.  check #21 external-unavailable: pass with HIPAA residency note
//       (verifier outside tenant infra)
//  19.  check #21 bytes-drift: fail with corpus_sha256 mismatch reason
//  20.  TENANT_SHADOW_SPEC_VERSION === 'tenant-shadow-corpus-v1'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TENANT_SHADOW_SPEC_VERSION,
  resolveCorpusPath,
  hashCorpusFile,
  saveCorpus,
  loadCorpus,
  listCorpora,
  deleteCorpus,
  buildTenantShadowBlock,
  validateTenantShadowBlock,
  reAnchorTenantShadowBlock,
} from '../src/tenant-holdout.js';
import { buildAndZip } from '../src/artifact.js';
import { buildBinder } from '../src/binder.js';

const SECRET = 'wave165-test-secret-' + crypto.randomBytes(8).toString('hex');
process.env.RECIPE_RECEIPT_SECRET = SECRET;

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w165-${label}-`));
}

function isolateEnv(t, { dataDir = null } = {}) {
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
    'KOLM_DATA_DIR',
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
  if (dataDir) {
    process.env.KOLM_DATA_DIR = dataDir;
  } else {
    delete process.env.KOLM_DATA_DIR;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(keyDir, { recursive: true, force: true }); } catch { /* swallow */ }
  });
}

// Pin cwd to repo root so verifier checks that walk cwd (#20 external
// holdouts) don't fall over when wave165 also bundles an absent block.
function pinCwd(t) {
  const saved = process.cwd();
  process.chdir(REPO_ROOT);
  t.after(() => { try { process.chdir(saved); } catch { /* swallow */ } });
}

async function buildOne(suffix, { tenantShadowBlocks } = {}) {
  const outDir = tmpDir(`artifact-${suffix}`);
  const result = await buildAndZip({
    job_id: `wave165-${suffix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    task: 'wave165-shadow-test',
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
    ...(tenantShadowBlocks ? { tenant_shadow_corpus: tenantShadowBlocks } : {}),
  });
  return { ...result, outDir };
}

// Save a corpus into the data dir scoped by the given KOLM_DATA_DIR and
// return a fully-built tenant-shadow block ready to embed in an artifact.
function saveAndBuildBlock(dataDir, tenantId, corpusId, rows, { accuracy = 1.0 } = {}) {
  saveCorpus(tenantId, corpusId, rows, { dataDir });
  const loaded = loadCorpus(tenantId, corpusId, { dataDir });
  const score = {
    accuracy,
    total: loaded.row_count,
    correct: Math.round(accuracy * loaded.row_count),
    comparator: 'exact',
  };
  return buildTenantShadowBlock(loaded, score, { comparator: 'exact', evaluated_at: '2026-05-17T00:00:00Z' });
}

// ---------------------------------------------------------------------------
// 1. SAFE_ID matches valid IDs; rejects traversal/whitespace/empty
// ---------------------------------------------------------------------------
test('1. SAFE_ID rejects traversal / whitespace / empty / null bytes', () => {
  // Good IDs validate (via resolveCorpusPath as a black-box surface)
  for (const id of ['tenantA', 'tenant_b', 'tenant-c', 'tenant1', 'a', 'abc123_xyz-001']) {
    assert.doesNotThrow(() => resolveCorpusPath(id, 'corpus1'), `id '${id}' should be valid`);
  }
  // Bad IDs throw
  for (const id of ['..', '../etc', 'tenant/../escape', 'tenant\0', 'tenant with space', '', '!bang']) {
    assert.throws(() => resolveCorpusPath(id, 'corpus1'), /must match/, `id '${id}' should reject`);
  }
  // corpus_id with traversal also rejected
  assert.throws(() => resolveCorpusPath('tenant1', '../etc/passwd'), /must match/);
});

// ---------------------------------------------------------------------------
// 2. resolveCorpusPath yields per-tenant storage path
// ---------------------------------------------------------------------------
test('2. resolveCorpusPath places corpus at <dataDir>/tenant_holdouts/<t>/<c>.jsonl', () => {
  const dataDir = tmpDir('resolve');
  const p = resolveCorpusPath('tenant1', 'corpus1', { dataDir });
  const expected = path.join(dataDir, 'tenant_holdouts', 'tenant1', 'corpus1.jsonl');
  assert.equal(p, expected);
});

// ---------------------------------------------------------------------------
// 3. resolveCorpusPath rejects ../ traversal (defense in depth — the SAFE_ID
//    regex is the first line; the resolved path being inside the per-tenant
//    dir is the second)
// ---------------------------------------------------------------------------
test('3. resolveCorpusPath rejects ../ traversal in tenant_id', () => {
  assert.throws(() => resolveCorpusPath('../escape', 'c1'), /must match/);
  assert.throws(() => resolveCorpusPath('t1', '..'), /must match/);
});

// ---------------------------------------------------------------------------
// 4. saveCorpus writes JSONL with canonical + legacy row normalization
// ---------------------------------------------------------------------------
test('4. saveCorpus writes mixed canonical+legacy rows into per-tenant JSONL', () => {
  const dataDir = tmpDir('save-mixed');
  const meta = saveCorpus('tenantA', 'corpus1', [
    { input: 'a', output: 'A' },           // canonical
    { prompt: 'b', completion: 'B' },      // legacy
    { input: 'c', expected: 'C' },         // expected → output normalize
  ], { dataDir });
  assert.equal(meta.tenant_id, 'tenantA');
  assert.equal(meta.corpus_id, 'corpus1');
  assert.equal(meta.row_count, 3);
  assert.match(meta.corpus_sha256, /^[0-9a-f]{64}$/);
  assert.match(meta.normalized_hash, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(meta.file_path));
  // File is JSONL — each line a single JSON object
  const lines = fs.readFileSync(meta.file_path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).input, 'a');
  assert.equal(JSON.parse(lines[1]).prompt, 'b');     // legacy preserved on disk
  assert.equal(JSON.parse(lines[2]).output, 'C');     // expected → output normalized
});

// ---------------------------------------------------------------------------
// 5. saveCorpus refuses duplicate save without replace=true
// ---------------------------------------------------------------------------
test('5. saveCorpus refuses duplicate corpus without replace=true', () => {
  const dataDir = tmpDir('save-dup');
  saveCorpus('tenantA', 'corpus1', [{ input: 'a', output: 'A' }], { dataDir });
  assert.throws(
    () => saveCorpus('tenantA', 'corpus1', [{ input: 'b', output: 'B' }], { dataDir }),
    /already exists.*replace=true/,
  );
});

// ---------------------------------------------------------------------------
// 6. saveCorpus replace=true overwrites
// ---------------------------------------------------------------------------
test('6. saveCorpus replace=true overwrites prior corpus', () => {
  const dataDir = tmpDir('save-replace');
  const first = saveCorpus('tenantA', 'corpus1', [{ input: 'a', output: 'A' }], { dataDir });
  const second = saveCorpus('tenantA', 'corpus1', [
    { input: 'b', output: 'B' },
    { input: 'c', output: 'C' },
  ], { dataDir, replace: true });
  assert.equal(first.row_count, 1);
  assert.equal(second.row_count, 2);
  // Hash changed because content changed
  assert.notEqual(first.corpus_sha256, second.corpus_sha256);
  // On-disk file reflects the new content
  const lines = fs.readFileSync(second.file_path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).input, 'b');
});

// ---------------------------------------------------------------------------
// 7. loadCorpus round-trips + computes hashes deterministically
// ---------------------------------------------------------------------------
test('7. loadCorpus returns rows + stable corpus_sha256 + normalized_hash', () => {
  const dataDir = tmpDir('load');
  const saved = saveCorpus('tenantA', 'corpus1', [
    { input: 'x', output: 'X' },
    { input: 'y', output: 'Y' },
  ], { dataDir });
  const loaded1 = loadCorpus('tenantA', 'corpus1', { dataDir });
  const loaded2 = loadCorpus('tenantA', 'corpus1', { dataDir });
  assert.equal(loaded1.row_count, 2);
  assert.equal(loaded1.corpus_sha256, saved.corpus_sha256);
  assert.equal(loaded1.normalized_hash, saved.normalized_hash);
  assert.equal(loaded1.corpus_sha256, loaded2.corpus_sha256);
  // loadSeeds normalizes canonical {input, output} → {input, expected, metadata}
  assert.equal(loaded1.rows[0].input, 'x');
  assert.equal(loaded1.rows[1].expected, 'Y');
  // Loading a missing corpus throws
  assert.throws(
    () => loadCorpus('tenantA', 'nope', { dataDir }),
    /not found/,
  );
});

// ---------------------------------------------------------------------------
// 8. hashCorpusFile is deterministic and matches raw sha256 of file bytes
// ---------------------------------------------------------------------------
test('8. hashCorpusFile is deterministic + hex64', () => {
  const dataDir = tmpDir('hash');
  const saved = saveCorpus('tenantA', 'corpus1', [{ input: 'z', output: 'Z' }], { dataDir });
  const h1 = hashCorpusFile(saved.file_path);
  const h2 = hashCorpusFile(saved.file_path);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  const raw = sha256Hex(fs.readFileSync(saved.file_path));
  assert.equal(h1, raw);
  // Missing file throws
  assert.throws(() => hashCorpusFile(path.join(dataDir, 'nope.jsonl')), /not found/);
});

// ---------------------------------------------------------------------------
// 9. listCorpora enumerates per-tenant
// ---------------------------------------------------------------------------
test('9. listCorpora enumerates per-tenant corpora (and not other tenants)', () => {
  const dataDir = tmpDir('list');
  saveCorpus('tenantA', 'corpus1', [{ input: 'a', output: 'A' }], { dataDir });
  saveCorpus('tenantA', 'corpus2', [{ input: 'b', output: 'B' }], { dataDir });
  saveCorpus('tenantB', 'corpus1', [{ input: 'c', output: 'C' }], { dataDir });
  const listA = listCorpora('tenantA', { dataDir });
  const listB = listCorpora('tenantB', { dataDir });
  const listC = listCorpora('tenantC', { dataDir });
  assert.equal(listA.length, 2);
  assert.deepEqual(listA.map(x => x.corpus_id).sort(), ['corpus1', 'corpus2']);
  assert.equal(listB.length, 1);
  assert.equal(listB[0].corpus_id, 'corpus1');
  assert.deepEqual(listC, []);    // no dir for tenantC → empty
  // Listing carries file metadata
  for (const entry of listA) {
    assert.ok(entry.bytes > 0);
    assert.match(entry.modified_at, /^\d{4}-\d{2}-\d{2}T/);
  }
});

// ---------------------------------------------------------------------------
// 10. deleteCorpus removes + returns deleted=true / false
// ---------------------------------------------------------------------------
test('10. deleteCorpus removes file (deleted=true); missing corpus returns deleted=false', () => {
  const dataDir = tmpDir('delete');
  const saved = saveCorpus('tenantA', 'corpus1', [{ input: 'a', output: 'A' }], { dataDir });
  assert.ok(fs.existsSync(saved.file_path));
  const del1 = deleteCorpus('tenantA', 'corpus1', { dataDir });
  assert.equal(del1.deleted, true);
  assert.equal(del1.file_path, saved.file_path);
  assert.equal(fs.existsSync(saved.file_path), false);
  // Second delete: missing → deleted=false
  const del2 = deleteCorpus('tenantA', 'corpus1', { dataDir });
  assert.equal(del2.deleted, false);
});

// ---------------------------------------------------------------------------
// 11. buildTenantShadowBlock round-trips through validateTenantShadowBlock
// ---------------------------------------------------------------------------
test('11. buildTenantShadowBlock round-trips through validateTenantShadowBlock', () => {
  const dataDir = tmpDir('build');
  const block = saveAndBuildBlock(dataDir, 'tenantA', 'corpus1', [
    { input: 'a', output: 'A' },
    { input: 'b', output: 'B' },
  ], { accuracy: 0.5 });
  assert.equal(block.spec, TENANT_SHADOW_SPEC_VERSION);
  assert.equal(block.tenant_id, 'tenantA');
  assert.equal(block.corpus_id, 'corpus1');
  assert.match(block.corpus_sha256, /^[0-9a-f]{64}$/);
  assert.match(block.normalized_hash, /^[0-9a-f]{64}$/);
  assert.match(block.hash, /^[0-9a-f]{64}$/);
  assert.equal(block.row_count, 2);
  assert.equal(block.accuracy, 0.5);
  assert.equal(block.evaluated_count, 2);
  assert.equal(block.passed_count, 1);
  assert.equal(block.comparator, 'exact');
  assert.ok(block.residency_note.includes('tenant infrastructure'));
  // Validation round-trips without mutation
  const validated = validateTenantShadowBlock(block);
  assert.equal(validated.hash, block.hash);
});

// ---------------------------------------------------------------------------
// 12. validateTenantShadowBlock rejects schema drift (missing required field)
// ---------------------------------------------------------------------------
test('12. validateTenantShadowBlock rejects missing-field schema drift', () => {
  const dataDir = tmpDir('schema');
  const block = saveAndBuildBlock(dataDir, 'tenantA', 'corpus1', [{ input: 'a', output: 'A' }]);
  for (const k of ['tenant_id', 'corpus_id', 'corpus_sha256', 'normalized_hash', 'row_count', 'comparator', 'evaluated_at']) {
    const dropped = JSON.parse(JSON.stringify(block));
    delete dropped[k];
    assert.throws(() => validateTenantShadowBlock(dropped), new RegExp(`missing field '${k}'`),
      `dropping ${k} should reject`);
  }
  // Bad spec field
  const wrongSpec = { ...block, spec: 'something-else' };
  assert.throws(() => validateTenantShadowBlock(wrongSpec), /expected/);
  // Bad shape ids
  const badTenantId = JSON.parse(JSON.stringify(block));
  badTenantId.tenant_id = '../escape';
  assert.throws(() => validateTenantShadowBlock(badTenantId), /tenant_id.*invalid shape/);
});

// ---------------------------------------------------------------------------
// 13. validateTenantShadowBlock rejects post-build hash drift
// ---------------------------------------------------------------------------
test('13. validateTenantShadowBlock rejects post-build hash drift', () => {
  const dataDir = tmpDir('hash-drift');
  const block = saveAndBuildBlock(dataDir, 'tenantA', 'corpus1', [{ input: 'a', output: 'A' }]);
  // Mutate accuracy without recomputing hash
  const tampered = JSON.parse(JSON.stringify(block));
  tampered.accuracy = 0.99;
  assert.throws(() => validateTenantShadowBlock(tampered), /hash drift/);
});

// ---------------------------------------------------------------------------
// 14. reAnchorTenantShadowBlock mode=reanchored when bytes match
// ---------------------------------------------------------------------------
test('14. reAnchorTenantShadowBlock returns mode=reanchored when corpus on disk matches', () => {
  const dataDir = tmpDir('reanchor-match');
  const block = saveAndBuildBlock(dataDir, 'tenantA', 'corpus1', [{ input: 'a', output: 'A' }]);
  const anchor = reAnchorTenantShadowBlock(block, { dataDir });
  assert.equal(anchor.mode, 'reanchored');
  assert.equal(anchor.matches, true);
  assert.equal(anchor.corpus_sha256_recomputed, block.corpus_sha256);
  assert.ok(anchor.file_path.includes('tenantA'));
});

// ---------------------------------------------------------------------------
// 15. reAnchorTenantShadowBlock mode=unavailable when corpus not on disk
//     (external verifier case)
// ---------------------------------------------------------------------------
test('15. reAnchorTenantShadowBlock returns mode=unavailable when external to tenant infra', () => {
  const dataDir = tmpDir('reanchor-build');
  const block = saveAndBuildBlock(dataDir, 'tenantA', 'corpus1', [{ input: 'a', output: 'A' }]);
  // Verifier sits in a dataDir with no tenant_holdouts/ subtree → unavailable
  const externalDataDir = tmpDir('reanchor-external');
  const anchor = reAnchorTenantShadowBlock(block, { dataDir: externalDataDir });
  assert.equal(anchor.mode, 'unavailable');
  assert.match(anchor.reason, /not reachable/);
  assert.match(anchor.reason, /external/);
});

// ---------------------------------------------------------------------------
// 16. check #21 absent branch: no tenant_shadow_corpus_provenance => pass
//     with upgrade hint
// ---------------------------------------------------------------------------
test('16. check #21 passes (informational) on artifacts without tenant_shadow_corpus', async (t) => {
  isolateEnv(t);
  pinCwd(t);
  const { outPath } = await buildOne('no-shadow');
  const report = await buildBinder(outPath);
  const c21 = report.checks.find(c => c.name === 'Tenant shadow corpus');
  assert.ok(c21, 'check #21 must always emit');
  assert.equal(c21.status, 'pass');
  assert.match(c21.detail, /no manifest\.tenant_shadow_corpus_provenance/);
  assert.match(c21.detail, /POST \/v1\/eval\/tenant_holdout/);
  assert.match(c21.detail, /--tenant-shadow-corpus/);
});

// ---------------------------------------------------------------------------
// 17. check #21 reanchored-match branch: tenant-internal verifier can
//     re-anchor against on-disk corpus, bytes match => pass with file_path
// ---------------------------------------------------------------------------
test('17. check #21 passes with re-anchor when corpus is reachable + matches', async (t) => {
  const dataDir = tmpDir('check21-reanchor');
  isolateEnv(t, { dataDir });
  pinCwd(t);
  const block = saveAndBuildBlock(dataDir, 'tenanta', 'corpus1', [
    { input: 'a', output: 'A' },
    { input: 'b', output: 'B' },
  ], { accuracy: 1.0 });
  const { outPath } = await buildOne('reanchor', { tenantShadowBlocks: [block] });
  const report = await buildBinder(outPath);
  const c21 = report.checks.find(c => c.name === 'Tenant shadow corpus');
  assert.ok(c21);
  assert.equal(c21.status, 'pass', `expected pass, got ${c21.status}: ${c21.detail}`);
  assert.match(c21.detail, /re-anchored from tenant storage/);
  assert.match(c21.detail, /tenanta:corpus1/);
  assert.match(c21.detail, /bytes match/);
  assert.match(c21.detail, /accuracy=100\.0%/);
});

// ---------------------------------------------------------------------------
// 18. check #21 external-unavailable branch: verifier has no access to
//     tenant storage (HIPAA "data never leaves tenant" residency) but
//     block schema + hash still round-trip => pass with residency note
// ---------------------------------------------------------------------------
test('18. check #21 passes for external verifier with no storage access (HIPAA residency)', async (t) => {
  // Build the artifact with KOLM_DATA_DIR pointing at the tenant's storage,
  // then re-verify with KOLM_DATA_DIR pointing at an EMPTY data dir — the
  // typical "external auditor receives the .kolm but has no tenant infra
  // access" case the HIPAA residency posture demands.
  const tenantDataDir = tmpDir('check21-tenant');
  const block = saveAndBuildBlock(tenantDataDir, 'tenanta', 'corpus1', [
    { input: 'a', output: 'A' },
  ], { accuracy: 1.0 });
  // Build phase: KOLM_DATA_DIR = tenant's dir (so saveAndBuildBlock + later
  // re-anchor at build time both succeed)
  isolateEnv(t, { dataDir: tenantDataDir });
  pinCwd(t);
  const { outPath } = await buildOne('external-verifier', { tenantShadowBlocks: [block] });
  // Verify phase: switch KOLM_DATA_DIR to an unrelated empty data dir
  const externalDataDir = tmpDir('check21-external');
  process.env.KOLM_DATA_DIR = externalDataDir;
  const report = await buildBinder(outPath);
  const c21 = report.checks.find(c => c.name === 'Tenant shadow corpus');
  assert.ok(c21);
  assert.equal(c21.status, 'pass', `expected pass, got ${c21.status}: ${c21.detail}`);
  assert.match(c21.detail, /HIPAA data-never-leaves-tenant/);
  assert.match(c21.detail, /schema \+ block hash/);
  assert.match(c21.detail, /tenanta:corpus1/);
});

// ---------------------------------------------------------------------------
// 19. check #21 bytes-drift branch: manifest's declared corpus_sha256 does
//     not match the on-disk corpus the verifier finds at the tenant path =>
//     fail with explicit drift reason
// ---------------------------------------------------------------------------
test('19. check #21 fails when on-disk corpus bytes drift from manifest', async (t) => {
  const dataDir = tmpDir('check21-drift');
  isolateEnv(t, { dataDir });
  pinCwd(t);
  // Build the block from a corpus the tenant initially saved
  const block = saveAndBuildBlock(dataDir, 'tenanta', 'corpus1', [
    { input: 'a', output: 'A' },
  ], { accuracy: 1.0 });
  const { outPath } = await buildOne('bytes-drift', { tenantShadowBlocks: [block] });
  // Now corrupt the on-disk corpus AFTER the artifact has been built. The
  // block still round-trips schema+hash (intra-manifest integrity holds),
  // but the on-disk bytes hash differently. check #21 must catch this.
  const corpusFile = resolveCorpusPath('tenanta', 'corpus1', { dataDir });
  fs.writeFileSync(corpusFile, JSON.stringify({ input: 'EDITED', output: 'EDITED' }) + '\n', 'utf8');
  const report = await buildBinder(outPath);
  const c21 = report.checks.find(c => c.name === 'Tenant shadow corpus');
  assert.ok(c21);
  assert.equal(c21.status, 'fail', `expected fail, got ${c21.status}: ${c21.detail}`);
  assert.match(c21.detail, /corpus-byte drift/);
  assert.match(c21.detail, /tenanta:corpus1/);
  assert.match(c21.detail, /on-disk corpus hashes to/);
});

// ---------------------------------------------------------------------------
// 20. TENANT_SHADOW_SPEC_VERSION is stable
// ---------------------------------------------------------------------------
test('20. TENANT_SHADOW_SPEC_VERSION === tenant-shadow-corpus-v1', () => {
  assert.equal(TENANT_SHADOW_SPEC_VERSION, 'tenant-shadow-corpus-v1');
});
