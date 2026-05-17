// Wave 148 — pretokenize (KOLMIDX2/KOLMPCK2) provenance bridge tests.
//
// loadPretokenizeProvenance() reads an apps/trainer/pretokenize_run.py output
// dir and produces a normalized pretokenize_block that buildAndZip binds into
// manifest.pretokenize + artifact_hash. Coverage:
//
//   1. buildPretokenizeBlock happy path — required fields + canonical short hash
//   2. buildPretokenizeBlock rejects missing tokenizer_id
//   3. buildPretokenizeBlock rejects unknown tokenizer_family
//   4. buildPretokenizeBlock rejects non-hex64 sha256 on idx_file
//   5. buildPretokenizeBlock rejects vocab_size < 1
//   6. validatePretokenizeBlock detects hash mutation
//   7. loadPretokenizeProvenance happy path (idx + pack + manifest)
//   8. loadPretokenizeProvenance refuses foreign manifest without kolm_pretokenize:true
//   9. loadPretokenizeProvenance idx hash drift is fatal
//  10. loadPretokenizeProvenance pack hash drift is fatal
//  11. loadPretokenizeProvenance vocab_size mismatch between idx and pack headers is fatal
//  12. loadPretokenizeProvenance throws on bad KOLMIDX2 magic
//  13. loadPretokenizeProvenance throws when manifest.json missing
//  14. E2E compileSpec --pretokenizeProvenancePath embeds manifest.pretokenize +
//      bundles tokens.idx + tokens.pack inside .kolm
//  15. E2E artifact_hash changes when packed token bytes differ
//  16. E2E without --pretokenizeProvenancePath: manifest.pretokenize is null

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import AdmZip from 'adm-zip';

import {
  loadPretokenizeProvenance,
  buildPretokenizeBlock,
  validatePretokenizeBlock,
  PRETOKENIZE_SPEC_VERSION,
  IDX_MAGIC,
  PACK_MAGIC,
  IDX_HEADER_SIZE,
  PACK_HEADER_SIZE,
  IDX_RECORD_SIZE,
  BINARY_VERSION,
} from '../src/pretokenize-provenance.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function tmpdir(prefix = 'kolm-w148-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Build a valid KOLMIDX2 buffer for a given list of sequences. Each sequence
// is { inputText, tokenIds:[] }. The pack offsets are computed as if we were
// building the pack alongside (cumulative token-count * 4). Vocab size is the
// caller's responsibility.
function buildIdxBuffer(seqs, vocabSize) {
  const sorted = seqs
    .map(s => ({ input_hash: crypto.createHash('sha256').update(s.inputText, 'utf8').digest(), token_count: s.tokenIds.length }))
    .sort((a, b) => Buffer.compare(a.input_hash, b.input_hash));
  const buf = Buffer.alloc(IDX_HEADER_SIZE + sorted.length * IDX_RECORD_SIZE);
  IDX_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(BINARY_VERSION, 8);
  buf.writeUInt32LE(sorted.length, 12);
  buf.writeUInt32LE(vocabSize, 16);
  buf.writeUInt32LE(0, 20);
  let off = IDX_HEADER_SIZE;
  let packOffset = 0;
  for (const s of sorted) {
    s.input_hash.copy(buf, off);
    buf.writeBigUInt64LE(BigInt(packOffset), off + 32);
    buf.writeUInt32LE(s.token_count, off + 40);
    buf.writeUInt32LE(0, off + 44);
    off += IDX_RECORD_SIZE;
    packOffset += s.token_count * 4;
  }
  return buf;
}

function buildPackBuffer(seqs, vocabSize) {
  // Pack record order must match how the build function laid them out — by
  // input_hash sorted order. We rebuild that here so the layout matches.
  const sorted = seqs
    .map(s => ({ input_hash: crypto.createHash('sha256').update(s.inputText, 'utf8').digest(), token_ids: s.tokenIds }))
    .sort((a, b) => Buffer.compare(a.input_hash, b.input_hash));
  const totalTokens = sorted.reduce((acc, s) => acc + s.token_ids.length, 0);
  const buf = Buffer.alloc(PACK_HEADER_SIZE + totalTokens * 4);
  PACK_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(BINARY_VERSION, 8);
  buf.writeUInt32LE(vocabSize, 12);
  buf.writeBigUInt64LE(0n, 16);
  let off = PACK_HEADER_SIZE;
  for (const s of sorted) {
    for (const tid of s.token_ids) {
      buf.writeUInt32LE(tid >>> 0, off);
      off += 4;
    }
  }
  return buf;
}

function makePretokenizeDir({
  tokenizerId = 'Qwen/Qwen2.5-3B-Instruct',
  family = 'identity',
  vocabSize = 65536,
  seqs = null,
  withManifest = true,
  manifestOverrides = {},
} = {}) {
  const dir = tmpdir('kolm-w148-pretok-');
  const seqsInput = seqs || [
    { inputText: 'hello world', tokenIds: [101, 202, 303] },
    { inputText: 'foo bar baz', tokenIds: [404, 505, 606, 707] },
    { inputText: 'lorem ipsum dolor', tokenIds: [11, 22, 33, 44, 55] },
  ];
  const idxBuf = buildIdxBuffer(seqsInput, vocabSize);
  const packBuf = buildPackBuffer(seqsInput, vocabSize);
  fs.writeFileSync(path.join(dir, 'tokens.idx'), idxBuf);
  fs.writeFileSync(path.join(dir, 'tokens.pack'), packBuf);
  if (withManifest) {
    const manifest = {
      kolm_pretokenize: true,
      kolm_pretokenize_version: '0.1.0',
      tokenizer_id: tokenizerId,
      tokenizer_family: family,
      vocab_size: vocabSize,
      seq_count: seqsInput.length,
      source_input_count: seqsInput.length,
      source: 'seeds.jsonl',
      encoded_at: '2026-05-17T00:00:00Z',
      idx_file: { filename: 'tokens.idx', sha256: sha256Hex(idxBuf), size_bytes: idxBuf.length },
      pack_file: { filename: 'tokens.pack', sha256: sha256Hex(packBuf), size_bytes: packBuf.length },
      stats: { total_tokens: seqsInput.reduce((a, s) => a + s.tokenIds.length, 0) },
      ...manifestOverrides,
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  return { dir, idxBuf, packBuf, seqs: seqsInput, vocabSize };
}

// ---------------------------------------------------------------------------
// buildPretokenizeBlock + validatePretokenizeBlock unit tests
// ---------------------------------------------------------------------------

test('buildPretokenizeBlock happy path produces canonical short hash', () => {
  const block = buildPretokenizeBlock({
    tokenizer_id: 'Qwen/Qwen2.5-3B-Instruct',
    tokenizer_family: 'bpe',
    vocab_size: 152064,
    seq_count: 25,
    source_input_count: 25,
    source: 'seeds.jsonl',
    encoded_at: '2026-05-17T00:00:00Z',
    idx_file: { filename: 'tokens.idx', sha256: 'a'.repeat(64), size_bytes: 1224 },
    pack_file: { filename: 'tokens.pack', sha256: 'b'.repeat(64), size_bytes: 4096 },
    stats: { total_tokens: 12345, avg_tokens_per_seq: 493.8 },
  });
  assert.equal(block.spec, PRETOKENIZE_SPEC_VERSION);
  assert.equal(block.tokenizer_id, 'Qwen/Qwen2.5-3B-Instruct');
  assert.equal(block.tokenizer_family, 'bpe');
  assert.equal(block.vocab_size, 152064);
  assert.equal(block.seq_count, 25);
  assert.equal(block.idx_file.sha256, 'a'.repeat(64));
  assert.match(block.hash, /^[0-9a-f]{16}$/);
});

test('buildPretokenizeBlock rejects missing tokenizer_id', () => {
  assert.throws(() => buildPretokenizeBlock({
    tokenizer_family: 'bpe',
    vocab_size: 100,
    seq_count: 1,
    idx_file: { filename: 'tokens.idx', sha256: 'a'.repeat(64), size_bytes: 1 },
    pack_file: { filename: 'tokens.pack', sha256: 'b'.repeat(64), size_bytes: 1 },
  }), /tokenizer_id required/);
});

test('buildPretokenizeBlock rejects unknown tokenizer_family', () => {
  assert.throws(() => buildPretokenizeBlock({
    tokenizer_id: 'x',
    tokenizer_family: 'made-up',
    vocab_size: 100,
    seq_count: 1,
    idx_file: { filename: 'tokens.idx', sha256: 'a'.repeat(64), size_bytes: 1 },
    pack_file: { filename: 'tokens.pack', sha256: 'b'.repeat(64), size_bytes: 1 },
  }), /tokenizer_family must be one of/);
});

test('buildPretokenizeBlock rejects non-hex64 sha256 on idx_file', () => {
  assert.throws(() => buildPretokenizeBlock({
    tokenizer_id: 'x',
    tokenizer_family: 'identity',
    vocab_size: 100,
    seq_count: 1,
    idx_file: { filename: 'tokens.idx', sha256: 'nope', size_bytes: 1 },
    pack_file: { filename: 'tokens.pack', sha256: 'b'.repeat(64), size_bytes: 1 },
  }), /idx_file.sha256 must be hex64/);
});

test('buildPretokenizeBlock rejects vocab_size < 1', () => {
  assert.throws(() => buildPretokenizeBlock({
    tokenizer_id: 'x',
    tokenizer_family: 'identity',
    vocab_size: 0,
    seq_count: 1,
    idx_file: { filename: 'tokens.idx', sha256: 'a'.repeat(64), size_bytes: 1 },
    pack_file: { filename: 'tokens.pack', sha256: 'b'.repeat(64), size_bytes: 1 },
  }), /vocab_size must be positive integer/);
});

test('validatePretokenizeBlock detects hash mutation', () => {
  const block = buildPretokenizeBlock({
    tokenizer_id: 'x',
    tokenizer_family: 'identity',
    vocab_size: 100,
    seq_count: 1,
    idx_file: { filename: 'tokens.idx', sha256: 'a'.repeat(64), size_bytes: 24 },
    pack_file: { filename: 'tokens.pack', sha256: 'b'.repeat(64), size_bytes: 24 },
  });
  const tampered = { ...block, vocab_size: 999 };
  assert.throws(() => validatePretokenizeBlock(tampered), /hash mismatch/);
});

// ---------------------------------------------------------------------------
// loadPretokenizeProvenance happy path + failure modes
// ---------------------------------------------------------------------------

test('loadPretokenizeProvenance happy path (idx + pack + manifest)', () => {
  const { dir, idxBuf, packBuf, seqs, vocabSize } = makePretokenizeDir();
  const out = loadPretokenizeProvenance(dir);
  assert.equal(out.tokenizer_id, 'Qwen/Qwen2.5-3B-Instruct');
  assert.equal(out.tokenizer_family, 'identity');
  assert.equal(out.vocab_size, vocabSize);
  assert.equal(out.seq_count, seqs.length);
  assert.equal(out.idx_file.sha256, sha256Hex(idxBuf));
  assert.equal(out.pack_file.sha256, sha256Hex(packBuf));
  assert.equal(out.files_to_bundle.length, 2);
  assert.equal(out.files_to_bundle[0].role, 'pretokenize_idx');
  assert.equal(out.files_to_bundle[1].role, 'pretokenize_pack');
  assert.equal(out.pretokenize_block.spec, PRETOKENIZE_SPEC_VERSION);
  assert.match(out.pretokenize_block.hash, /^[0-9a-f]{16}$/);
});

test('loadPretokenizeProvenance refuses foreign manifest without kolm_pretokenize:true', () => {
  const { dir } = makePretokenizeDir({ withManifest: false });
  // Foreign manifest — has the files but the wrong marker (or none).
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    backend: 'some-other-tool',
    tokenizer_id: 'X',
    idx_file: { filename: 'tokens.idx' },
    pack_file: { filename: 'tokens.pack' },
  }));
  assert.throws(() => loadPretokenizeProvenance(dir), /foreign manifest refused/);
});

test('loadPretokenizeProvenance idx hash drift is fatal', () => {
  const { dir } = makePretokenizeDir();
  // Mutate the idx file after the manifest was written. Even if we keep the
  // bytes a valid KOLMIDX2 header, the sha256 differs from manifest's claim.
  const tampered = Buffer.concat([Buffer.from(IDX_MAGIC), Buffer.alloc(16, 0x00)]);
  fs.writeFileSync(path.join(dir, 'tokens.idx'), tampered);
  assert.throws(() => loadPretokenizeProvenance(dir), /idx hash drift/);
});

test('loadPretokenizeProvenance pack hash drift is fatal', () => {
  const { dir } = makePretokenizeDir();
  const tampered = Buffer.concat([Buffer.from(PACK_MAGIC), Buffer.alloc(16, 0x00)]);
  fs.writeFileSync(path.join(dir, 'tokens.pack'), tampered);
  assert.throws(() => loadPretokenizeProvenance(dir), /pack hash drift/);
});

test('loadPretokenizeProvenance vocab_size mismatch between idx and pack headers is fatal', () => {
  // Build both buffers with DIFFERENT vocab sizes embedded in their headers,
  // then write a manifest that matches the idx side. Bridge must refuse
  // because the two binaries disagree.
  const dir = tmpdir('kolm-w148-mismatch-');
  const seqsInput = [{ inputText: 'a', tokenIds: [1, 2, 3] }];
  const idxBuf = buildIdxBuffer(seqsInput, 1000);
  const packBuf = buildPackBuffer(seqsInput, 2000); // different vocab
  fs.writeFileSync(path.join(dir, 'tokens.idx'), idxBuf);
  fs.writeFileSync(path.join(dir, 'tokens.pack'), packBuf);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    kolm_pretokenize: true,
    kolm_pretokenize_version: '0.1.0',
    tokenizer_id: 'x',
    tokenizer_family: 'identity',
    vocab_size: 1000,
    seq_count: 1,
    idx_file: { filename: 'tokens.idx', sha256: sha256Hex(idxBuf), size_bytes: idxBuf.length },
    pack_file: { filename: 'tokens.pack', sha256: sha256Hex(packBuf), size_bytes: packBuf.length },
  }));
  assert.throws(() => loadPretokenizeProvenance(dir), /vocab_size mismatch between idx .* and pack/);
});

test('loadPretokenizeProvenance throws on bad KOLMIDX2 magic', () => {
  const dir = tmpdir('kolm-w148-badmagic-');
  fs.writeFileSync(path.join(dir, 'tokens.idx'), Buffer.concat([Buffer.from('BADMAGIC'), Buffer.alloc(16, 0)]));
  const packBuf = buildPackBuffer([], 1000);
  fs.writeFileSync(path.join(dir, 'tokens.pack'), packBuf);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    kolm_pretokenize: true,
    kolm_pretokenize_version: '0.1.0',
    tokenizer_id: 'x',
    tokenizer_family: 'identity',
    vocab_size: 1000,
    seq_count: 0,
    idx_file: { filename: 'tokens.idx', sha256: sha256Hex(fs.readFileSync(path.join(dir, 'tokens.idx'))), size_bytes: 24 },
    pack_file: { filename: 'tokens.pack', sha256: sha256Hex(packBuf), size_bytes: packBuf.length },
  }));
  assert.throws(() => loadPretokenizeProvenance(dir), /tokens.idx bad magic/);
});

test('loadPretokenizeProvenance throws when manifest.json missing', () => {
  const { dir } = makePretokenizeDir({ withManifest: false });
  assert.throws(() => loadPretokenizeProvenance(dir), /missing manifest\.json/);
});

// ---------------------------------------------------------------------------
// E2E through compileSpec
// ---------------------------------------------------------------------------

function makeMinimalSpecDir() {
  const dir = tmpdir('kolm-w148-spec-');
  const seedsPath = path.join(dir, 'seeds.jsonl');
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ input: `hello ${i}`, output: `HELLO ${i}` });
  }
  fs.writeFileSync(seedsPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const spec = {
    job_id: 'job_w148_test',
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

test('E2E compileSpec --pretokenizeProvenancePath embeds manifest.pretokenize and bundles tokens.idx + tokens.pack', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-w148';
  const { spec, seedsPath, dir: specDir } = makeMinimalSpecDir();
  const { dir: ptDir, idxBuf, packBuf, vocabSize } = makePretokenizeDir();
  const { compileSpec } = await import('../src/spec-compile.js');
  const r = await compileSpec(spec, {
    outDir: specDir,
    seedsPath,
    allowSeedAutoResolve: false,
    pretokenizeProvenancePath: ptDir,
  });
  assert.ok(r.pretokenize_provenance, 'pretokenize_provenance must be present');
  assert.equal(r.pretokenize_provenance.tokenizer_family, 'identity');
  assert.equal(r.pretokenize_provenance.vocab_size, vocabSize);
  assert.ok(r.manifest.pretokenize, 'manifest.pretokenize must be present');
  assert.equal(r.manifest.pretokenize.spec, PRETOKENIZE_SPEC_VERSION);
  assert.equal(r.manifest.pretokenize.tokenizer_id, 'Qwen/Qwen2.5-3B-Instruct');
  assert.equal(r.manifest.pretokenize.idx_file.sha256, sha256Hex(idxBuf));
  assert.equal(r.manifest.pretokenize.pack_file.sha256, sha256Hex(packBuf));
  assert.match(r.manifest.pretokenize.hash, /^[0-9a-f]{16}$/);

  // tokens.idx + tokens.pack must ride inside the .kolm.
  const zip = new AdmZip(r.outPath);
  const idxEntry = zip.getEntry('tokens.idx');
  assert.ok(idxEntry, 'tokens.idx must be bundled inside .kolm');
  assert.equal(sha256Hex(idxEntry.getData()), sha256Hex(idxBuf));
  const packEntry = zip.getEntry('tokens.pack');
  assert.ok(packEntry, 'tokens.pack must be bundled inside .kolm');
  assert.equal(sha256Hex(packEntry.getData()), sha256Hex(packBuf));
  // extra_files binding
  assert.ok(r.manifest.hashes.extra_files);
  assert.equal(r.manifest.hashes.extra_files['tokens.idx'], sha256Hex(idxBuf));
  assert.equal(r.manifest.hashes.extra_files['tokens.pack'], sha256Hex(packBuf));
});

test('E2E artifact_hash changes when packed token bytes differ', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-w148';
  const { spec, seedsPath, dir: specDir } = makeMinimalSpecDir();
  const { compileSpec } = await import('../src/spec-compile.js');

  // Same inputs, different token ids → different pack bytes → different idx
  // bytes (offsets shift) → different block hash → different .kolm sha256.
  const seqsA = [
    { inputText: 'hello', tokenIds: [1, 2, 3] },
    { inputText: 'world', tokenIds: [4, 5, 6] },
  ];
  const seqsB = [
    { inputText: 'hello', tokenIds: [10, 20, 30, 40] },
    { inputText: 'world', tokenIds: [50, 60, 70, 80] },
  ];
  const { dir: ptA } = makePretokenizeDir({ seqs: seqsA });
  const rA = await compileSpec({ ...spec, job_id: 'job_w148_a' }, {
    outDir: specDir,
    seedsPath,
    allowSeedAutoResolve: false,
    pretokenizeProvenancePath: ptA,
  });
  const { dir: ptB } = makePretokenizeDir({ seqs: seqsB });
  const rB = await compileSpec({ ...spec, job_id: 'job_w148_b' }, {
    outDir: specDir,
    seedsPath,
    allowSeedAutoResolve: false,
    pretokenizeProvenancePath: ptB,
  });

  assert.notEqual(rA.manifest.pretokenize.pack_file.sha256, rB.manifest.pretokenize.pack_file.sha256,
    'different packed tokens must yield different pack sha256');
  assert.notEqual(rA.manifest.pretokenize.hash, rB.manifest.pretokenize.hash,
    'different pack hashes must propagate to different pretokenize block hashes');
  assert.notEqual(rA.sha256, rB.sha256, 'pretokenize drift must propagate to .kolm file sha256');
});

test('E2E without --pretokenizeProvenancePath: manifest.pretokenize is null', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-w148';
  const { spec, seedsPath, dir: specDir } = makeMinimalSpecDir();
  const { compileSpec } = await import('../src/spec-compile.js');
  const r = await compileSpec({ ...spec, job_id: 'job_w148_no_pt' }, {
    outDir: specDir,
    seedsPath,
    allowSeedAutoResolve: false,
  });
  assert.equal(r.manifest.pretokenize, null, 'pretokenize block must be null when not supplied');
  assert.equal(r.pretokenize_provenance, null);
});
