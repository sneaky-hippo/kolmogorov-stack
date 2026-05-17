// src/pretokenize-provenance.js
//
// Wave 148 — bridge between the isolated apps/trainer/pretokenize_run.py
// Python tokenization step and the in-process artifact builder. Reads a
// pretokenize output dir (manifest.json + tokens.idx + tokens.pack),
// recomputes per-file sha256 from disk, verifies declared hashes when
// present, and emits a normalized `pretokenize` block that buildAndZip will
// bind into the artifact hash (sibling of `lineage`, `export`, `moe`).
//
// Mirrors src/moe-provenance.js (wave 147) including the security boundary:
// foreign manifest.json without `kolm_pretokenize: true` THROWS — there is
// no scan-driven fallback because we cannot infer which file is the idx vs
// the pack from extension alone.
//
// Cross-package contract (file-on-disk is the API, not function calls):
//
//   * Python writes manifest.json + tokens.idx + tokens.pack into a dir.
//   * Node bridge requires kolm_pretokenize:true OR throws.
//   * Node bridge recomputes both file hashes from disk; drift is fatal.
//   * Both binary files carry their own magic ("KOLMIDX2" / "KOLMPCK2") and
//     a version u32 LE; the bridge re-reads these headers to confirm the
//     binary layout matches the manifest's declared seq_count/vocab_size.
//
// Input shape (manifest.json):
//   {
//     "kolm_pretokenize": true,
//     "kolm_pretokenize_version": "0.1.0",
//     "tokenizer_id": "Qwen/Qwen2.5-3B-Instruct",
//     "tokenizer_family": "bpe" | "sentencepiece" | "tiktoken" | "identity",
//     "vocab_size": 152064,
//     "seq_count": 25,
//     "source_input_count": 25,
//     "encoded_at": "ISO8601",
//     "idx_file":  { "filename": "tokens.idx",  "sha256": "...", "size_bytes": ... },
//     "pack_file": { "filename": "tokens.pack", "sha256": "...", "size_bytes": ... },
//     "stats": { ... }?
//   }
//
// Output (loadPretokenizeProvenance return):
//   {
//     tokenizer_id, tokenizer_family, vocab_size, seq_count,
//     idx_file: { filename, sha256, size_bytes },
//     pack_file: { filename, sha256, size_bytes },
//     pretokenize_block: <canonical block ready for buildAndZip>,
//     files_to_bundle: [ {filename, absPath, role}, ... ],
//   }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PRETOKENIZE_SPEC_VERSION = 'pretokenize-v1';
export const IDX_MAGIC = Buffer.from('KOLMIDX2', 'utf8');
export const PACK_MAGIC = Buffer.from('KOLMPCK2', 'utf8');
export const IDX_HEADER_SIZE = 24;
export const PACK_HEADER_SIZE = 24;
export const IDX_RECORD_SIZE = 48;
export const BINARY_VERSION = 1;

const HEX64_RE = /^[0-9a-f]{64}$/;
const VALID_FAMILIES = new Set(['bpe', 'sentencepiece', 'tiktoken', 'identity']);

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function _canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_canon).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _canon(v[k])).join(',') + '}';
}
function _shortHash(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }

function hashFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return { sha256: sha256Hex(buf), size_bytes: buf.length };
}

// Parse the fixed 24-byte tokens.idx header and return { seq_count, vocab_size }.
// Throws on bad magic or version. Used to cross-check the manifest's claim
// against the bytes on disk — protects against a manifest that says seq_count=10
// over a file that has seq_count=0.
function parseIdxHeader(absPath) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const head = Buffer.alloc(IDX_HEADER_SIZE);
    const n = fs.readSync(fd, head, 0, IDX_HEADER_SIZE, 0);
    if (n < IDX_HEADER_SIZE) throw new Error(`tokens.idx too short: ${n} bytes`);
    if (!head.subarray(0, 8).equals(IDX_MAGIC)) {
      throw new Error(`tokens.idx bad magic: got ${head.subarray(0, 8).toString()}, expected KOLMIDX2`);
    }
    const version = head.readUInt32LE(8);
    const seq_count = head.readUInt32LE(12);
    const vocab_size = head.readUInt32LE(16);
    if (version !== BINARY_VERSION) throw new Error(`tokens.idx unsupported version: ${version}`);
    return { version, seq_count, vocab_size };
  } finally {
    fs.closeSync(fd);
  }
}

function parsePackHeader(absPath) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const head = Buffer.alloc(PACK_HEADER_SIZE);
    const n = fs.readSync(fd, head, 0, PACK_HEADER_SIZE, 0);
    if (n < PACK_HEADER_SIZE) throw new Error(`tokens.pack too short: ${n} bytes`);
    if (!head.subarray(0, 8).equals(PACK_MAGIC)) {
      throw new Error(`tokens.pack bad magic: got ${head.subarray(0, 8).toString()}, expected KOLMPCK2`);
    }
    const version = head.readUInt32LE(8);
    const vocab_size = head.readUInt32LE(12);
    if (version !== BINARY_VERSION) throw new Error(`tokens.pack unsupported version: ${version}`);
    return { version, vocab_size };
  } finally {
    fs.closeSync(fd);
  }
}

// Build + validate the canonical pretokenize block. Optional inputs are
// dropped from output if falsy. Block carries its own short hash so any
// tamper downstream breaks the artifact hash.
export function buildPretokenizeBlock(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('pretokenize input must be object');
  if (!input.tokenizer_id || typeof input.tokenizer_id !== 'string') {
    throw new Error('pretokenize.tokenizer_id required (string)');
  }
  const family = input.tokenizer_family;
  if (!family || !VALID_FAMILIES.has(family)) {
    throw new Error(`pretokenize.tokenizer_family must be one of ${[...VALID_FAMILIES].join('|')}`);
  }
  const vocab = Number(input.vocab_size);
  if (!Number.isFinite(vocab) || vocab < 1) {
    throw new Error('pretokenize.vocab_size must be positive integer');
  }
  const seqCount = Number(input.seq_count);
  if (!Number.isFinite(seqCount) || seqCount < 0) {
    throw new Error('pretokenize.seq_count must be non-negative integer');
  }

  function _file(side, f) {
    if (!f || typeof f !== 'object') throw new Error(`pretokenize.${side}_file required (object)`);
    if (!f.filename || typeof f.filename !== 'string') throw new Error(`pretokenize.${side}_file.filename required`);
    if (!f.sha256 || typeof f.sha256 !== 'string') throw new Error(`pretokenize.${side}_file.sha256 required`);
    const clean = String(f.sha256).replace(/^sha256:/, '');
    if (!HEX64_RE.test(clean)) throw new Error(`pretokenize.${side}_file.sha256 must be hex64`);
    return {
      filename: f.filename,
      sha256: clean,
      size_bytes: f.size_bytes != null ? Number(f.size_bytes) : 0,
    };
  }

  const out = {
    spec: PRETOKENIZE_SPEC_VERSION,
    tokenizer_id: input.tokenizer_id,
    tokenizer_family: family,
    vocab_size: vocab,
    seq_count: seqCount,
    encoded_at: input.encoded_at || new Date().toISOString(),
    idx_file: _file('idx', input.idx_file),
    pack_file: _file('pack', input.pack_file),
  };
  if (input.source_input_count != null) out.source_input_count = Number(input.source_input_count);
  if (input.source && typeof input.source === 'string') out.source = input.source;
  if (input.stats && typeof input.stats === 'object') out.stats = { ...input.stats };
  if (input.notes && typeof input.notes === 'string') out.notes = input.notes;
  out.hash = _shortHash(_canon(out));
  return out;
}

// Re-validate a pretokenize block read back from a manifest. Returns frozen
// on success; throws on schema or hash mismatch.
export function validatePretokenizeBlock(block) {
  if (!block || typeof block !== 'object') throw new Error('pretokenize block must be object');
  if (block.spec !== PRETOKENIZE_SPEC_VERSION) throw new Error(`bad pretokenize spec: ${block.spec}`);
  const { hash, ...rest } = block;
  const recomputed = _shortHash(_canon(rest));
  if (hash !== recomputed) throw new Error('pretokenize block hash mismatch');
  return Object.freeze({ ...block });
}

// Main entry. Read the dir, normalize, return composition-ready bundle.
export function loadPretokenizeProvenance(dirPath, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const abs = path.isAbsolute(dirPath) ? dirPath : path.resolve(cwd, dirPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`pretokenize provenance dir not found: ${abs}`);
  }
  if (!fs.statSync(abs).isDirectory()) {
    throw new Error(`pretokenize provenance path is not a directory: ${abs}`);
  }

  const manifestPath = path.join(abs, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`pretokenize provenance missing manifest.json: ${abs} (write one with apps/trainer/pretokenize_run.py --build ...)`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`pretokenize manifest.json could not be parsed: ${e.message}`);
  }
  if (raw.kolm_pretokenize !== true) {
    throw new Error('pretokenize manifest.json missing kolm_pretokenize:true marker (foreign manifest refused)');
  }

  const tokenizerId = raw.tokenizer_id;
  if (!tokenizerId) throw new Error('pretokenize manifest.tokenizer_id required');
  const family = raw.tokenizer_family || 'identity';

  if (!raw.idx_file || !raw.idx_file.filename) throw new Error('pretokenize manifest.idx_file.filename required');
  if (!raw.pack_file || !raw.pack_file.filename) throw new Error('pretokenize manifest.pack_file.filename required');

  const idxAbs = path.join(abs, raw.idx_file.filename);
  const packAbs = path.join(abs, raw.pack_file.filename);
  if (!fs.existsSync(idxAbs)) throw new Error(`pretokenize tokens.idx not found: ${idxAbs}`);
  if (!fs.existsSync(packAbs)) throw new Error(`pretokenize tokens.pack not found: ${packAbs}`);

  const idxOnDisk = hashFile(idxAbs);
  const packOnDisk = hashFile(packAbs);

  const declaredIdx = raw.idx_file.sha256 ? String(raw.idx_file.sha256).replace(/^sha256:/, '') : null;
  if (declaredIdx && declaredIdx !== idxOnDisk.sha256) {
    throw new Error(`pretokenize idx hash drift: manifest=${declaredIdx} disk=${idxOnDisk.sha256}`);
  }
  const declaredPack = raw.pack_file.sha256 ? String(raw.pack_file.sha256).replace(/^sha256:/, '') : null;
  if (declaredPack && declaredPack !== packOnDisk.sha256) {
    throw new Error(`pretokenize pack hash drift: manifest=${declaredPack} disk=${packOnDisk.sha256}`);
  }

  // Cross-check binary headers against manifest claims. A tampered manifest
  // could declare seq_count=10000 over a file that really has 0; this catches
  // that before the block gets signed into the artifact.
  const idxHeader = parseIdxHeader(idxAbs);
  const packHeader = parsePackHeader(packAbs);
  if (raw.seq_count != null && Number(raw.seq_count) !== idxHeader.seq_count) {
    throw new Error(`pretokenize seq_count drift: manifest=${raw.seq_count} idx-header=${idxHeader.seq_count}`);
  }
  const declaredVocab = Number(raw.vocab_size);
  if (Number.isFinite(declaredVocab) && declaredVocab !== idxHeader.vocab_size) {
    throw new Error(`pretokenize vocab_size drift: manifest=${declaredVocab} idx-header=${idxHeader.vocab_size}`);
  }
  if (idxHeader.vocab_size !== packHeader.vocab_size) {
    throw new Error(`pretokenize vocab_size mismatch between idx (${idxHeader.vocab_size}) and pack (${packHeader.vocab_size})`);
  }

  const expectedIdxBodyBytes = idxHeader.seq_count * IDX_RECORD_SIZE;
  if (idxOnDisk.size_bytes !== IDX_HEADER_SIZE + expectedIdxBodyBytes) {
    throw new Error(
      `pretokenize idx file size mismatch: got ${idxOnDisk.size_bytes}, expected ${IDX_HEADER_SIZE + expectedIdxBodyBytes} (header + ${idxHeader.seq_count} * ${IDX_RECORD_SIZE})`,
    );
  }

  const resolvedIdx = {
    filename: raw.idx_file.filename,
    sha256: idxOnDisk.sha256,
    size_bytes: idxOnDisk.size_bytes,
  };
  const resolvedPack = {
    filename: raw.pack_file.filename,
    sha256: packOnDisk.sha256,
    size_bytes: packOnDisk.size_bytes,
  };

  const block = buildPretokenizeBlock({
    tokenizer_id: tokenizerId,
    tokenizer_family: family,
    vocab_size: idxHeader.vocab_size,
    seq_count: idxHeader.seq_count,
    source_input_count: raw.source_input_count != null ? Number(raw.source_input_count) : undefined,
    source: raw.source,
    encoded_at: raw.encoded_at,
    idx_file: resolvedIdx,
    pack_file: resolvedPack,
    stats: raw.stats || undefined,
    notes: raw.notes || undefined,
  });

  return {
    tokenizer_id: tokenizerId,
    tokenizer_family: family,
    vocab_size: idxHeader.vocab_size,
    seq_count: idxHeader.seq_count,
    idx_file: resolvedIdx,
    pack_file: resolvedPack,
    pretokenize_block: block,
    files_to_bundle: [
      { filename: raw.idx_file.filename, absPath: idxAbs, role: 'pretokenize_idx' },
      { filename: raw.pack_file.filename, absPath: packAbs, role: 'pretokenize_pack' },
    ],
  };
}
