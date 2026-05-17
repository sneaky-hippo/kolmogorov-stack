// Wave 147 — MoE composition provenance bridge tests.
//
// loadMoeProvenance() reads an apps/trainer/moe_run.py output dir and
// produces a normalized moe_block that buildAndZip binds into manifest.moe +
// artifact_hash. Coverage:
//
//   1. buildMoeBlock happy path — required fields + canonical short hash
//   2. buildMoeBlock rejects missing base_model
//   3. buildMoeBlock rejects fewer than 2 experts
//   4. buildMoeBlock rejects top_k routing with k < 2
//   5. buildMoeBlock rejects duplicate expert names
//   6. validateMoeBlock detects hash mutation
//   7. loadMoeProvenance happy path (router + 2 file experts + manifest)
//   8. loadMoeProvenance refuses foreign manifest without kolm_moe:true
//   9. loadMoeProvenance hash drift on router is fatal
//  10. loadMoeProvenance hash drift on expert is fatal
//  11. loadMoeProvenance top_k routing surfaces top_k correctly
//  12. loadMoeProvenance throws when manifest.json is missing
//  13. E2E compileSpec --moeProvenancePath → manifest.moe present, router +
//      experts ride inside the .kolm zip, extra_files binds them
//  14. E2E artifact_hash drift: different experts → different sha256
//  15. E2E without --moeProvenancePath → manifest.moe is null

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import AdmZip from 'adm-zip';

import {
  loadMoeProvenance,
  buildMoeBlock,
  validateMoeBlock,
  MOE_SPEC_VERSION,
} from '../src/moe-provenance.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function tmpdir(prefix = 'kolm-w147-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// buildMoeBlock + validateMoeBlock unit tests
// ---------------------------------------------------------------------------

test('buildMoeBlock happy path produces canonical short hash', () => {
  const block = buildMoeBlock({
    base_model: 'Qwen/Qwen2.5-3B-Instruct',
    routing_strategy: 'top_1',
    top_k: 1,
    composed_at: '2026-05-17T00:00:00Z',
    router: { filename: 'router.pt', sha256: 'a'.repeat(64), size_bytes: 1024 },
    experts: [
      { name: 'phi_redactor', filename: 'phi.kolm', sha256: 'b'.repeat(64), size_bytes: 2048 },
      { name: 'tone_classify', filename: 'tone.kolm', sha256: 'c'.repeat(64), size_bytes: 3072, cid: 'cidv1:sha256:c4...' },
    ],
  });
  assert.equal(block.spec, MOE_SPEC_VERSION);
  assert.equal(block.base_model, 'Qwen/Qwen2.5-3B-Instruct');
  assert.equal(block.routing_strategy, 'top_1');
  assert.equal(block.experts.length, 2);
  assert.equal(block.experts[1].cid, 'cidv1:sha256:c4...');
  assert.match(block.hash, /^[0-9a-f]{16}$/);
});

test('buildMoeBlock rejects missing base_model', () => {
  assert.throws(() => buildMoeBlock({
    routing_strategy: 'top_1',
    router: { filename: 'r.pt', sha256: 'a'.repeat(64) },
    experts: [
      { name: 'a', filename: 'a.kolm', sha256: 'a'.repeat(64) },
      { name: 'b', filename: 'b.kolm', sha256: 'b'.repeat(64) },
    ],
  }), /base_model required/);
});

test('buildMoeBlock rejects fewer than 2 experts', () => {
  assert.throws(() => buildMoeBlock({
    base_model: 'Q',
    routing_strategy: 'top_1',
    router: { filename: 'r.pt', sha256: 'a'.repeat(64) },
    experts: [{ name: 'a', filename: 'a.kolm', sha256: 'a'.repeat(64) }],
  }), /length >= 2/);
});

test('buildMoeBlock rejects top_k routing with k < 2', () => {
  assert.throws(() => buildMoeBlock({
    base_model: 'Q',
    routing_strategy: 'top_k',
    top_k: 1,
    router: { filename: 'r.pt', sha256: 'a'.repeat(64) },
    experts: [
      { name: 'a', filename: 'a.kolm', sha256: 'a'.repeat(64) },
      { name: 'b', filename: 'b.kolm', sha256: 'b'.repeat(64) },
    ],
  }), /top_k >= 2/);
});

test('buildMoeBlock rejects duplicate expert names', () => {
  assert.throws(() => buildMoeBlock({
    base_model: 'Q',
    routing_strategy: 'top_1',
    router: { filename: 'r.pt', sha256: 'a'.repeat(64) },
    experts: [
      { name: 'a', filename: 'a.kolm', sha256: 'a'.repeat(64) },
      { name: 'a', filename: 'b.kolm', sha256: 'b'.repeat(64) },
    ],
  }), /duplicate/);
});

test('validateMoeBlock detects hash mutation', () => {
  const block = buildMoeBlock({
    base_model: 'Q',
    routing_strategy: 'top_k',
    top_k: 2,
    router: { filename: 'r.pt', sha256: 'd'.repeat(64) },
    experts: [
      { name: 'a', filename: 'a.kolm', sha256: 'a'.repeat(64) },
      { name: 'b', filename: 'b.kolm', sha256: 'b'.repeat(64) },
    ],
  });
  // Mutate after the hash was computed.
  const tampered = { ...block, top_k: 3 };
  assert.throws(() => validateMoeBlock(tampered), /hash mismatch/);
});

// ---------------------------------------------------------------------------
// loadMoeProvenance happy path + failure modes
// ---------------------------------------------------------------------------

function makeMoeDir({ routing = 'top_1', topK = 1, withManifest = true, expertCount = 2, extraExpertBytes = null } = {}) {
  const dir = tmpdir('kolm-w147-moe-');
  // Router checkpoint — fake .pt bytes.
  const routerBuf = Buffer.from('PT-router-' + 'r'.repeat(64), 'binary');
  fs.writeFileSync(path.join(dir, 'router.pt'), routerBuf);
  // Experts — each is a fake .kolm-ish file.
  const expertBufs = [];
  const expertEntries = [];
  for (let i = 0; i < expertCount; i++) {
    const buf = i === 0 && extraExpertBytes ? extraExpertBytes : Buffer.from(`expert-${i}-` + 'e'.repeat(32));
    expertBufs.push(buf);
    const name = `expert_${i}`;
    const filename = `expert_${i}.kolm`;
    fs.writeFileSync(path.join(dir, filename), buf);
    expertEntries.push({ name, filename, buf });
  }
  if (withManifest) {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      kolm_moe: true,
      kolm_moe_version: '0.1.0',
      base_model: 'Qwen/Qwen2.5-3B-Instruct',
      routing_strategy: routing,
      top_k: topK,
      composed_at: '2026-05-17T00:00:00Z',
      router: {
        filename: 'router.pt',
        sha256: sha256Hex(routerBuf),
        size_bytes: routerBuf.length,
        hidden_size: 2048,
        router_hidden: 256,
      },
      experts: expertEntries.map(e => ({
        name: e.name,
        filename: e.filename,
        sha256: sha256Hex(e.buf),
        size_bytes: e.buf.length,
      })),
      training_stats: { loss_final: 0.42, eval_accuracy: 0.91 },
    }));
  }
  return { dir, routerBuf, expertEntries };
}

test('loadMoeProvenance happy path (router + 2 experts + manifest)', () => {
  const { dir, routerBuf, expertEntries } = makeMoeDir();
  const out = loadMoeProvenance(dir);
  assert.equal(out.base_model, 'Qwen/Qwen2.5-3B-Instruct');
  assert.equal(out.routing_strategy, 'top_1');
  assert.equal(out.top_k, 1);
  assert.equal(out.router.sha256, sha256Hex(routerBuf));
  assert.equal(out.router.hidden_size, 2048);
  assert.equal(out.experts.length, 2);
  assert.equal(out.experts[0].sha256, sha256Hex(expertEntries[0].buf));
  assert.equal(out.experts[1].sha256, sha256Hex(expertEntries[1].buf));
  assert.equal(out.training_stats.loss_final, 0.42);
  // files_to_bundle: 1 router + 2 experts
  assert.equal(out.files_to_bundle.length, 3);
  assert.equal(out.files_to_bundle[0].role, 'router');
  assert.equal(out.files_to_bundle[1].role, 'expert');
  // moe_block schema check
  assert.equal(out.moe_block.spec, MOE_SPEC_VERSION);
  assert.match(out.moe_block.hash, /^[0-9a-f]{16}$/);
});

test('loadMoeProvenance refuses foreign manifest without kolm_moe:true', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'router.pt'), Buffer.from('r'));
  fs.writeFileSync(path.join(dir, 'a.kolm'), Buffer.from('a'));
  fs.writeFileSync(path.join(dir, 'b.kolm'), Buffer.from('b'));
  // No kolm_moe:true marker — bridge must refuse to consume.
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    backend: 'something-else',
    base_model: 'pretend',
    router: { filename: 'router.pt' },
    experts: [{ name: 'x', filename: 'a.kolm' }, { name: 'y', filename: 'b.kolm' }],
  }));
  assert.throws(() => loadMoeProvenance(dir), /foreign manifest refused/);
});

test('loadMoeProvenance router hash drift is fatal', () => {
  const { dir } = makeMoeDir();
  // Mutate router on disk after manifest was written.
  fs.writeFileSync(path.join(dir, 'router.pt'), Buffer.from('TAMPERED'));
  assert.throws(() => loadMoeProvenance(dir), /router hash drift/);
});

test('loadMoeProvenance expert hash drift is fatal', () => {
  const { dir, expertEntries } = makeMoeDir();
  fs.writeFileSync(path.join(dir, expertEntries[1].filename), Buffer.from('TAMPERED-EXPERT'));
  assert.throws(() => loadMoeProvenance(dir), /expert .* hash drift/);
});

test('loadMoeProvenance top_k routing surfaces top_k=2', () => {
  const { dir } = makeMoeDir({ routing: 'top_k', topK: 2 });
  const out = loadMoeProvenance(dir);
  assert.equal(out.routing_strategy, 'top_k');
  assert.equal(out.top_k, 2);
  assert.equal(out.moe_block.routing_strategy, 'top_k');
  assert.equal(out.moe_block.top_k, 2);
});

test('loadMoeProvenance throws when manifest.json missing', () => {
  const { dir } = makeMoeDir({ withManifest: false });
  assert.throws(() => loadMoeProvenance(dir), /missing manifest\.json/);
});

// ---------------------------------------------------------------------------
// E2E through compileSpec
// ---------------------------------------------------------------------------

function makeMinimalSpecDir() {
  const dir = tmpdir('kolm-w147-spec-');
  const seedsPath = path.join(dir, 'seeds.jsonl');
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ input: `hello ${i}`, output: `HELLO ${i}` });
  }
  fs.writeFileSync(seedsPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const spec = {
    job_id: 'job_w147_test',
    task: 'uppercase echo',
    base_model: 'none',
    recipes: [
      {
        id: 'rcp_echo_upper',
        name: 'echo upper',
        source: `function generate(input, lib) { return String(input).toUpperCase(); }`,
        tags: ['echo'],
      },
    ],
    evals: { spec: 'rs-1-evals', n: 0, cases: [] },
  };
  const specPath = path.join(dir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  return { dir, spec, specPath, seedsPath };
}

test('E2E compileSpec --moeProvenancePath embeds manifest.moe and bundles router + expert files', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-w147';
  const { spec, seedsPath, dir: specDir } = makeMinimalSpecDir();
  const { dir: moeDir, routerBuf, expertEntries } = makeMoeDir({ routing: 'top_k', topK: 2 });
  const { compileSpec } = await import('../src/spec-compile.js');
  const r = await compileSpec(spec, {
    outDir: specDir,
    seedsPath,
    allowSeedAutoResolve: false,
    moeProvenancePath: moeDir,
  });
  assert.ok(r.moe_provenance, 'moe_provenance must be present');
  assert.equal(r.moe_provenance.routing_strategy, 'top_k');
  assert.equal(r.moe_provenance.top_k, 2);
  assert.ok(r.manifest.moe, 'manifest.moe must be present');
  assert.equal(r.manifest.moe.spec, MOE_SPEC_VERSION);
  assert.equal(r.manifest.moe.routing_strategy, 'top_k');
  assert.equal(r.manifest.moe.top_k, 2);
  assert.equal(r.manifest.moe.experts.length, 2);
  assert.equal(r.manifest.moe.router.sha256, sha256Hex(routerBuf));
  assert.match(r.manifest.moe.hash, /^[0-9a-f]{16}$/);

  // Router + experts must actually ride inside the .kolm zip.
  const zip = new AdmZip(r.outPath);
  const routerEntry = zip.getEntry('router.pt');
  assert.ok(routerEntry, 'router.pt must be bundled inside .kolm');
  assert.equal(sha256Hex(routerEntry.getData()), sha256Hex(routerBuf));
  for (const e of expertEntries) {
    const ent = zip.getEntry(e.filename);
    assert.ok(ent, `expert ${e.filename} must be bundled inside .kolm`);
    assert.equal(sha256Hex(ent.getData()), sha256Hex(e.buf));
  }
  // extra_files binding
  assert.ok(r.manifest.hashes.extra_files);
  assert.equal(r.manifest.hashes.extra_files['router.pt'], sha256Hex(routerBuf));
});

test('E2E artifact_hash changes when expert bytes differ', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-w147';
  const { spec, seedsPath, dir: specDir } = makeMinimalSpecDir();
  const { compileSpec } = await import('../src/spec-compile.js');

  const { dir: moeA } = makeMoeDir({ extraExpertBytes: Buffer.from('alpha-expert-bytes-AAAAA') });
  const rA = await compileSpec({ ...spec, job_id: 'job_w147_a' }, {
    outDir: specDir,
    seedsPath,
    allowSeedAutoResolve: false,
    moeProvenancePath: moeA,
  });
  const { dir: moeB } = makeMoeDir({ extraExpertBytes: Buffer.from('beta-expert-bytes-BBBBB-different') });
  const rB = await compileSpec({ ...spec, job_id: 'job_w147_b' }, {
    outDir: specDir,
    seedsPath,
    allowSeedAutoResolve: false,
    moeProvenancePath: moeB,
  });

  assert.notEqual(rA.manifest.moe.experts[0].sha256, rB.manifest.moe.experts[0].sha256,
    'different expert_0 bytes must yield different expert sha256');
  assert.notEqual(rA.manifest.moe.hash, rB.manifest.moe.hash,
    'different expert hashes must propagate to different moe block hashes');
  // The moe block hash folds into artifact_hash_input as `moe_hash`, AND the
  // bundled files fold into hashes.extra_files. Both bind into the .kolm zip
  // file hash on disk, so the on-disk sha256 must differ.
  assert.notEqual(rA.sha256, rB.sha256, 'moe drift must propagate to .kolm file sha256');
  assert.notEqual(
    rA.manifest.hashes.extra_files['expert_0.kolm'],
    rB.manifest.hashes.extra_files['expert_0.kolm'],
    'different expert bytes must produce different per-file extra_files hashes',
  );
});

test('E2E without --moeProvenancePath: manifest.moe is null', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-w147';
  const { spec, seedsPath, dir: specDir } = makeMinimalSpecDir();
  const { compileSpec } = await import('../src/spec-compile.js');
  const r = await compileSpec({ ...spec, job_id: 'job_w147_no_moe' }, {
    outDir: specDir,
    seedsPath,
    allowSeedAutoResolve: false,
  });
  assert.equal(r.manifest.moe, null, 'moe block must be null when not supplied');
  assert.equal(r.moe_provenance, null);
});
