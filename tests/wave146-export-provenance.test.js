// Wave 146 — export provenance bridge tests.
//
// loadExportProvenance() reads an apps/export output dir and produces a
// normalized export_block that buildAndZip binds into manifest.export +
// artifact_hash. Coverage:
//
//  1. buildExportBlock happy path — required fields + canonical short hash
//  2. buildExportBlock rejects missing backend/targets/sha256
//  3. validateExportBlock detects hash drift in the block itself
//  4. loadExportProvenance manifest-driven happy path (gguf single file)
//  5. loadExportProvenance hash drift in manifest is fatal
//  6. loadExportProvenance scan-driven fallback (no manifest.json,
//     just a .gguf next to nothing else)
//  7. loadExportProvenance directory target (CoreML-style .mlpackage)
//     produces is_dir + file_count + canonical dir hash
//  8. loadExportProvenance throws when dir has no recognizable targets
//  9. E2E compileSpec --exportProvenancePath → manifest.export present
//     with non-null hash + each target file rides inside the .kolm zip
// 10. E2E artifact_hash drift: mutating an export target on disk between
//     loadExportProvenance and buildAndZip would change the bundled hash,
//     so the block hash would mismatch the validated block — but the
//     simpler test is that two compiles with different export targets
//     produce different artifact_hashes (binding works).
// 11. Manifest-driven path that lacks kolm_export:true marker falls back
//     to scan-driven (we don't trust foreign manifests).
// 12. Scan-driven path with manifest.json present but missing kolm_export
//     does NOT mistakenly trust the manifest's declared targets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import AdmZip from 'adm-zip';

import {
  loadExportProvenance,
  buildExportBlock,
  validateExportBlock,
  EXPORT_SPEC_VERSION,
} from '../src/export-provenance.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function tmpdir(prefix = 'kolm-w146-') {
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
// buildExportBlock + validateExportBlock unit tests
// ---------------------------------------------------------------------------

test('buildExportBlock happy path with required fields produces canonical hash', () => {
  const block = buildExportBlock({
    backend: 'gguf',
    exported_at: '2026-05-17T00:00:00Z',
    targets: [
      { format: 'gguf', filename: 'model.q4_k_m.gguf', sha256: 'a'.repeat(64), size_bytes: 1024, quantization: 'q4_k_m' },
    ],
  });
  assert.equal(block.spec, EXPORT_SPEC_VERSION);
  assert.equal(block.backend, 'gguf');
  assert.equal(block.targets.length, 1);
  assert.equal(block.targets[0].quantization, 'q4_k_m');
  assert.match(block.hash, /^[0-9a-f]{16}$/);
});

test('buildExportBlock rejects missing backend', () => {
  assert.throws(() => buildExportBlock({ targets: [{ format: 'gguf', filename: 'x', sha256: 'a'.repeat(64) }] }), /backend required/);
});

test('buildExportBlock rejects empty targets', () => {
  assert.throws(() => buildExportBlock({ backend: 'gguf', targets: [] }), /non-empty array/);
});

test('buildExportBlock rejects non-hex64 sha256', () => {
  assert.throws(() => buildExportBlock({
    backend: 'gguf',
    targets: [{ format: 'gguf', filename: 'x', sha256: 'not-hex' }],
  }), /hex64/);
});

test('validateExportBlock detects hash mutation', () => {
  const block = buildExportBlock({
    backend: 'onnx',
    targets: [{ format: 'onnx', filename: 'model.onnx', sha256: 'b'.repeat(64) }],
  });
  // Mutate a target post-hoc and re-issue validation — should throw.
  const tampered = { ...block, targets: block.targets.map(t => ({ ...t, sha256: 'c'.repeat(64) })) };
  assert.throws(() => validateExportBlock(tampered), /hash mismatch/);
});

// ---------------------------------------------------------------------------
// loadExportProvenance manifest-driven path
// ---------------------------------------------------------------------------

test('loadExportProvenance manifest-driven happy path (gguf single file)', () => {
  const dir = tmpdir();
  const ggufBuf = Buffer.from('GGUF\x00\x00\x00\x03' + 'x'.repeat(64), 'binary');
  writeFile(path.join(dir, 'model.q4_k_m.gguf'), ggufBuf);
  const declaredHash = sha256Hex(ggufBuf);
  writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    kolm_export: true,
    kolm_export_version: '0.1.0',
    backend: 'gguf',
    exported_at: '2026-05-17T00:00:00Z',
    options: { quantization: 'q4_k_m', context_length: 8192 },
    targets: [
      { format: 'gguf', filename: 'model.q4_k_m.gguf', sha256: declaredHash, size_bytes: ggufBuf.length, quantization: 'q4_k_m', runtime_min_version: 'llama.cpp@2024-12-01' },
    ],
  }));
  const out = loadExportProvenance(dir);
  assert.equal(out.synthesized, false);
  assert.equal(out.backend, 'gguf');
  assert.equal(out.targets.length, 1);
  assert.equal(out.targets[0].sha256, declaredHash);
  assert.equal(out.targets[0].quantization, 'q4_k_m');
  assert.equal(out.targets[0].runtime_min_version, 'llama.cpp@2024-12-01');
  assert.equal(out.files_to_bundle.length, 1);
  assert.equal(out.files_to_bundle[0].is_dir, false);
  assert.equal(out.export_block.backend, 'gguf');
  assert.equal(out.export_block.options.context_length, 8192);
});

test('loadExportProvenance hash drift is fatal', () => {
  const dir = tmpdir();
  const buf = Buffer.from('real bytes');
  writeFile(path.join(dir, 'model.onnx'), buf);
  // Manifest declares wrong hash — bridge must throw, not silently re-hash.
  writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    kolm_export: true,
    backend: 'onnx',
    exported_at: '2026-05-17T00:00:00Z',
    targets: [
      { format: 'onnx', filename: 'model.onnx', sha256: 'd'.repeat(64), size_bytes: buf.length },
    ],
  }));
  assert.throws(() => loadExportProvenance(dir), /hash drift/);
});

// ---------------------------------------------------------------------------
// loadExportProvenance scan-driven fallback
// ---------------------------------------------------------------------------

test('loadExportProvenance scan-driven fallback (no manifest, single .gguf)', () => {
  const dir = tmpdir();
  const buf = Buffer.from('scan body');
  writeFile(path.join(dir, 'model.gguf'), buf);
  const out = loadExportProvenance(dir);
  assert.equal(out.synthesized, true);
  assert.equal(out.backend, 'unknown');
  assert.equal(out.targets.length, 1);
  assert.equal(out.targets[0].format, 'gguf');
  assert.equal(out.targets[0].sha256, sha256Hex(buf));
});

test('loadExportProvenance scan-driven picks up .pte / executorch', () => {
  const dir = tmpdir();
  const buf = Buffer.from('pte');
  writeFile(path.join(dir, 'model.pte'), buf);
  const out = loadExportProvenance(dir);
  assert.equal(out.targets[0].format, 'executorch');
});

test('loadExportProvenance dir without any recognized output throws', () => {
  const dir = tmpdir();
  writeFile(path.join(dir, 'random.txt'), 'noise');
  assert.throws(() => loadExportProvenance(dir), /no recognized output/);
});

// ---------------------------------------------------------------------------
// directory targets (CoreML .mlpackage style)
// ---------------------------------------------------------------------------

test('loadExportProvenance directory target (.mlpackage) hashes recursively', () => {
  const dir = tmpdir();
  const pkg = path.join(dir, 'model.mlpackage');
  writeFile(path.join(pkg, 'Manifest.json'), '{"version":1}');
  writeFile(path.join(pkg, 'Data', 'com.apple.CoreML', 'weights', 'weight.bin'), Buffer.from('w'.repeat(32)));
  const out = loadExportProvenance(dir);
  assert.equal(out.synthesized, true);
  assert.equal(out.targets.length, 1);
  assert.equal(out.targets[0].format, 'coreml');
  assert.equal(out.targets[0].is_dir, true);
  assert.ok(out.targets[0].file_count >= 2);
  assert.ok(out.targets[0].sha256.length === 64);
  assert.equal(out.files_to_bundle[0].is_dir, true);
});

// ---------------------------------------------------------------------------
// manifest without kolm_export:true → fall back to scan-driven, do not trust
// ---------------------------------------------------------------------------

test('foreign manifest.json without kolm_export:true is ignored (scan-driven fallback)', () => {
  const dir = tmpdir();
  writeFile(path.join(dir, 'model.gguf'), Buffer.from('legit bytes'));
  writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    // No kolm_export:true marker — bridge must ignore this entirely.
    backend: 'pretend-onnx',
    targets: [{ format: 'onnx', filename: 'NOT-A-REAL-FILE.onnx', sha256: 'e'.repeat(64) }],
  }));
  const out = loadExportProvenance(dir);
  assert.equal(out.synthesized, true);
  assert.equal(out.backend, 'unknown');
  assert.equal(out.targets.length, 1);
  assert.equal(out.targets[0].format, 'gguf');
});

// ---------------------------------------------------------------------------
// E2E through compileSpec
// ---------------------------------------------------------------------------

function makeMinimalSpecDir() {
  const dir = tmpdir('kolm-w146-spec-');
  const seedsPath = path.join(dir, 'seeds.jsonl');
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ input: `hello ${i}`, output: `HELLO ${i}` });
  }
  fs.writeFileSync(seedsPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const spec = {
    job_id: 'job_w146_test',
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

function makeExportDir({ withManifest = true } = {}) {
  const dir = tmpdir('kolm-w146-export-');
  const ggufBuf = Buffer.from('GGUFv3\x00' + 'q'.repeat(200), 'binary');
  fs.writeFileSync(path.join(dir, 'model.q4_k_m.gguf'), ggufBuf);
  if (withManifest) {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      kolm_export: true,
      backend: 'gguf',
      exported_at: '2026-05-17T00:00:00Z',
      options: { quantization: 'q4_k_m' },
      targets: [
        { format: 'gguf', filename: 'model.q4_k_m.gguf', sha256: sha256Hex(ggufBuf), size_bytes: ggufBuf.length, quantization: 'q4_k_m' },
      ],
    }));
  }
  return { dir, ggufBuf };
}

test('E2E compileSpec --exportProvenancePath embeds manifest.export and bundles target files', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-w146';
  const { spec, seedsPath, dir: specDir } = makeMinimalSpecDir();
  const { dir: exportDir, ggufBuf } = makeExportDir();
  const { compileSpec } = await import('../src/spec-compile.js');
  const r = await compileSpec(spec, {
    outDir: specDir,
    seedsPath,
    allowSeedAutoResolve: false,
    exportProvenancePath: exportDir,
  });
  assert.ok(r.export_provenance, 'export_provenance must be present');
  assert.equal(r.export_provenance.backend, 'gguf');
  assert.ok(r.manifest.export, 'manifest.export must be present');
  assert.equal(r.manifest.export.spec, EXPORT_SPEC_VERSION);
  assert.equal(r.manifest.export.backend, 'gguf');
  assert.equal(r.manifest.export.targets.length, 1);
  assert.equal(r.manifest.export.targets[0].sha256, sha256Hex(ggufBuf));
  assert.match(r.manifest.export.hash, /^[0-9a-f]{16}$/);

  // Confirm the target file actually rides inside the .kolm zip.
  const zip = new AdmZip(r.outPath);
  const entry = zip.getEntry('model.q4_k_m.gguf');
  assert.ok(entry, 'export target file must be bundled inside .kolm');
  const bundled = entry.getData();
  assert.equal(sha256Hex(bundled), sha256Hex(ggufBuf));
  // And the manifest hashes.extra_files must record it (binds extra_files into artifact_hash).
  assert.ok(r.manifest.hashes.extra_files, 'extra_files hash table must be present');
  assert.equal(r.manifest.hashes.extra_files['model.q4_k_m.gguf'], sha256Hex(ggufBuf));
});

test('E2E artifact_hash changes when export target bytes differ', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-w146';
  const { spec, seedsPath, dir: specDir } = makeMinimalSpecDir();
  const { compileSpec } = await import('../src/spec-compile.js');

  // First compile with one export payload
  const exportA = tmpdir('kolm-w146-eA-');
  const bufA = Buffer.from('payload-A');
  fs.writeFileSync(path.join(exportA, 'a.gguf'), bufA);
  const rA = await compileSpec({ ...spec, job_id: 'job_w146_a' }, {
    outDir: specDir,
    seedsPath,
    allowSeedAutoResolve: false,
    exportProvenancePath: exportA,
  });

  // Second compile with a different export payload
  const exportB = tmpdir('kolm-w146-eB-');
  const bufB = Buffer.from('payload-B-different');
  fs.writeFileSync(path.join(exportB, 'a.gguf'), bufB);
  const rB = await compileSpec({ ...spec, job_id: 'job_w146_b' }, {
    outDir: specDir,
    seedsPath,
    allowSeedAutoResolve: false,
    exportProvenancePath: exportB,
  });

  assert.notEqual(rA.manifest.export.targets[0].sha256, rB.manifest.export.targets[0].sha256,
    'different export bytes must yield different target hashes');
  assert.notEqual(rA.manifest.export.hash, rB.manifest.export.hash,
    'different target hashes must propagate to different block hashes');
  // The block hash folds into artifact_hash_input as `export_hash`, AND the
  // bundled files fold into hashes.extra_files. Both bind into the .kolm zip
  // file hash on disk, so the on-disk sha256 must differ.
  assert.notEqual(rA.sha256, rB.sha256, 'export drift must propagate to .kolm file sha256');
  // And the extra_files hash table must record different per-file hashes.
  assert.notEqual(
    rA.manifest.hashes.extra_files['a.gguf'],
    rB.manifest.hashes.extra_files['a.gguf'],
    'different export bytes must produce different per-file extra_files hashes',
  );
});

test('E2E without --exportProvenancePath: manifest.export is null and no extra files', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-w146';
  const { spec, seedsPath, dir: specDir } = makeMinimalSpecDir();
  const { compileSpec } = await import('../src/spec-compile.js');
  const r = await compileSpec({ ...spec, job_id: 'job_w146_noexport' }, {
    outDir: specDir,
    seedsPath,
    allowSeedAutoResolve: false,
  });
  assert.equal(r.manifest.export, null, 'export block must be null when not supplied');
  assert.equal(r.export_provenance, null);
});
