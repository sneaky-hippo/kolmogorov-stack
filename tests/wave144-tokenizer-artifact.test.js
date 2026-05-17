// Wave 144 — tokenizer.json rides inside the .kolm zip.
//
// Confirms:
//   - `kolm compile --tokenizer` packs tokenizer.json into the artifact
//   - manifest.training.tokenizer carries { type, vocab_size, sha256, filename }
//   - manifest.hashes.extra_files['tokenizer.json'] equals sha256(bytes)
//   - artifact_hash covers extra_files (tampering breaks the chain)
//   - tokenizer can be read back from the zip and reconstructed losslessly

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

import { compileSpec } from '../src/spec-compile.js';
import { KolmTokenizer, trainTokenizer } from '../src/tokenizer.js';

const SECRET = 'kolm-public-fixture-v0-1-0';

function withSecret(fn) {
  return async () => {
    const before = process.env.RECIPE_RECEIPT_SECRET;
    process.env.RECIPE_RECEIPT_SECRET = SECRET;
    try { return await fn(); }
    finally {
      if (before === undefined) delete process.env.RECIPE_RECEIPT_SECRET;
      else process.env.RECIPE_RECEIPT_SECRET = before;
    }
  };
}

function tinySpec(id) {
  return {
    job_id: `job_${id}`,
    task: `tokenizer test: ${id}`,
    base_model: 'none',
    recipes: [{
      id: `rcp_${id}`,
      name: id,
      schema: { input: { text: 'string' }, output: { type: 'object' } },
      source: `function generate(input, lib) { return { ok: true }; }`,
    }],
    evals: { spec: 'rs-1-evals', cases: [{ id: 'e1', input: { text: 'x' }, expected: { ok: true } }], coverage: 1.0 },
  };
}

test('compileSpec --tokenizer: tokenizer.json rides inside the zip', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-tok-'));
  try {
    const tok = trainTokenizer(['hello world', 'hello there', 'world is round'], { vocab_size: 280 });
    const tokPath = path.join(dir, 'tokenizer.json');
    fs.writeFileSync(tokPath, JSON.stringify(tok.toJSON()));
    const tokBytes = fs.readFileSync(tokPath);
    const expectedSha = crypto.createHash('sha256').update(tokBytes).digest('hex');

    const outPath = path.join(dir, 'with-tokenizer.kolm');
    await compileSpec(tinySpec('basic'), { outPath, allowSeedAutoResolve: false, tokenizerPath: tokPath });

    const zip = new AdmZip(outPath);
    const entries = zip.getEntries().map(e => e.entryName);
    assert.ok(entries.includes('tokenizer.json'), `tokenizer.json missing from zip; entries=${entries.join(',')}`);

    const packedBytes = zip.getEntry('tokenizer.json').getData();
    assert.equal(crypto.createHash('sha256').update(packedBytes).digest('hex'), expectedSha);

    const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf-8'));
    assert.equal(manifest.training.tokenizer.sha256, expectedSha);
    assert.equal(manifest.training.tokenizer.type, 'byte-bpe');
    assert.equal(manifest.training.tokenizer.vocab_size, tok.vocab_size);
    assert.equal(manifest.training.tokenizer.filename, 'tokenizer.json');
    assert.equal(manifest.hashes.extra_files['tokenizer.json'], expectedSha);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('compileSpec --tokenizer: artifact_hash covers extra_files (tampering detectable)', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-tok-'));
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-tok-A-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-tok-B-'));
  try {
    const tok = trainTokenizer(['alpha beta', 'gamma delta'], { vocab_size: 280 });
    const tokPathA = path.join(dir, 'tok-a.json');
    fs.writeFileSync(tokPathA, JSON.stringify(tok.toJSON()));

    const tokB = trainTokenizer(['alpha beta gamma delta epsilon zeta'], { vocab_size: 280 });
    const tokPathB = path.join(dir, 'tok-b.json');
    fs.writeFileSync(tokPathB, JSON.stringify(tokB.toJSON()));

    // Same spec on both sides — only the tokenizer differs. The artifact_hash
    // must still diverge, proving extra_files participate in the receipt chain.
    const sameSpec = tinySpec('tamper-same');
    const outA = path.join(dirA, 'a.kolm');
    const outB = path.join(dirB, 'b.kolm');
    await compileSpec(sameSpec, { outDir: dirA, outPath: outA, allowSeedAutoResolve: false, tokenizerPath: tokPathA });
    await compileSpec(sameSpec, { outDir: dirB, outPath: outB, allowSeedAutoResolve: false, tokenizerPath: tokPathB });

    const manA = JSON.parse(new AdmZip(outA).getEntry('manifest.json').getData().toString('utf-8'));
    const manB = JSON.parse(new AdmZip(outB).getEntry('manifest.json').getData().toString('utf-8'));
    assert.notEqual(manA.hashes.extra_files['tokenizer.json'], manB.hashes.extra_files['tokenizer.json']);
    const recA = JSON.parse(new AdmZip(outA).getEntry('receipt.json').getData().toString('utf-8'));
    const recB = JSON.parse(new AdmZip(outB).getEntry('receipt.json').getData().toString('utf-8'));
    assert.notEqual(recA.artifact_hash, recB.artifact_hash, 'artifact_hash must change when extra_files change');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
}));

test('compileSpec: no --tokenizer keeps manifest backward-compatible', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-tok-'));
  try {
    const outPath = path.join(dir, 'plain.kolm');
    await compileSpec(tinySpec('plain'), { outPath, allowSeedAutoResolve: false });
    const zip = new AdmZip(outPath);
    const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf-8'));
    // No tokenizer flag means no tokenizer in training, no extra_files in hashes.
    assert.equal(manifest.training.tokenizer, undefined);
    assert.equal(manifest.hashes.extra_files, undefined);
    assert.equal(zip.getEntry('tokenizer.json'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('packed tokenizer reconstructs losslessly via KolmTokenizer.fromJSON', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-tok-'));
  try {
    const corpus = ['the quick brown fox', 'jumps over the lazy dog', 'the fox runs free'];
    const tok = trainTokenizer(corpus, { vocab_size: 320 });
    const tokPath = path.join(dir, 'tokenizer.json');
    fs.writeFileSync(tokPath, JSON.stringify(tok.toJSON()));

    const outPath = path.join(dir, 'roundtrip.kolm');
    await compileSpec(tinySpec('rt'), { outPath, allowSeedAutoResolve: false, tokenizerPath: tokPath });

    const zip = new AdmZip(outPath);
    const packed = JSON.parse(zip.getEntry('tokenizer.json').getData().toString('utf-8'));
    const restored = KolmTokenizer.fromJSON(packed);

    for (const s of corpus.concat(['fresh sample text'])) {
      assert.deepEqual(restored.encode(s), tok.encode(s), `mismatch on encode(${JSON.stringify(s)})`);
      assert.equal(restored.decode(restored.encode(s)), s);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));
