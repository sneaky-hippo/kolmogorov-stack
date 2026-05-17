// src/export-provenance.js
//
// Wave 146 — bridge between the isolated apps/export Python toolchain and the
// in-process artifact builder. Reads an export-output dir, recomputes every
// per-file sha256 from disk, verifies declared hashes when present, and emits
// a normalized `export` block that buildAndZip will bind into the artifact
// hash (sibling of `lineage`).
//
// Two input shapes are accepted:
//
//  1. Manifest-driven (preferred) — out_dir contains `manifest.json` written
//     by apps/export/run.py (or by hand). Shape:
//       {
//         "kolm_export": true,
//         "kolm_export_version": "0.1.0",
//         "backend": "gguf"|"onnx"|"coreml"|"mlx"|"executorch"|"tensorrt",
//         "exported_at": "ISO8601",
//         "source_artifact_hash": "<hex64>"?,
//         "options": { ... backend-specific opts },
//         "targets": [
//           { "format": "gguf", "filename": "model.q4_k_m.gguf",
//             "sha256": "sha256:<hex64>"?, "size_bytes": 12345?,
//             "quantization": "q4_k_m"?, "runtime_min_version": "..."? }
//         ]
//       }
//     The bridge recomputes every sha256 from disk; drift throws.
//
//  2. Scan-driven (fallback) — out_dir has no manifest.json. Bridge walks the
//     dir, infers a format from each known extension, computes sha256+size,
//     and synthesizes a manifest with backend='unknown' + exported_at=now.
//     This path makes the bridge usable for hand-rolled exporter runs where
//     someone just dropped a .gguf next to a recipe.
//
// In both cases the returned block is the canonical input for
// buildAndZip({ export: <block> }) — see src/artifact.js#buildPayload.
//
// Honest scope: this module BUILDS and VALIDATES the export block. It does
// NOT run the exporter (that's Python, see apps/export/). It does NOT decide
// whether the host can run the target format (that's
// src/device-capabilities.js). It is a pure schema + hash-recompute layer,
// mirroring src/distill-provenance.js.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const EXPORT_SPEC_VERSION = 'export-v1';

const HEX64_RE = /^[0-9a-f]{64}$/;

// Known format → file-extension/pattern mapping for scan-driven fallback.
// Order matters: first match wins when a dir contains multiple shapes.
const FORMAT_PATTERNS = [
  { format: 'gguf',       match: (n, st) => st.isFile() && n.toLowerCase().endsWith('.gguf') },
  { format: 'onnx',       match: (n, st) => st.isFile() && n.toLowerCase().endsWith('.onnx') },
  { format: 'safetensors',match: (n, st) => st.isFile() && n.toLowerCase().endsWith('.safetensors') },
  { format: 'coreml',     match: (n, st) => st.isDirectory() && n.toLowerCase().endsWith('.mlpackage') },
  { format: 'executorch', match: (n, st) => st.isFile() && n.toLowerCase().endsWith('.pte') },
  { format: 'tensorrt',   match: (n, st) => st.isDirectory() && n.toLowerCase() === 'engine' },
  { format: 'mlx',        match: (n, st) => st.isDirectory() && n.toLowerCase().endsWith('mlx_model') },
];

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

// Recursively hash a directory (for coreml .mlpackage / tensorrt engine/
// / mlx_model/). The hash is over the sorted list of (relative_path, sha256)
// pairs so structural reordering doesn't perturb it, and the file content
// itself is hashed once per entry. Returns { sha256, size_bytes, file_count }.
function hashDir(dirAbs) {
  const entries = [];
  function walk(rel) {
    const abs = path.join(dirAbs, rel);
    const items = fs.readdirSync(abs).sort();
    for (const name of items) {
      const childRel = rel ? path.posix.join(rel, name) : name;
      const childAbs = path.join(dirAbs, childRel);
      const st = fs.statSync(childAbs);
      if (st.isDirectory()) walk(childRel);
      else if (st.isFile()) {
        const buf = fs.readFileSync(childAbs);
        entries.push({ rel: childRel.replace(/\\/g, '/'), sha256: sha256Hex(buf), size: buf.length });
      }
    }
  }
  walk('');
  const canon = entries.map(e => `${e.rel}\0${e.sha256}\0${e.size}`).join('\n');
  return {
    sha256: sha256Hex(Buffer.from(canon, 'utf8')),
    size_bytes: entries.reduce((a, e) => a + e.size, 0),
    file_count: entries.length,
  };
}

// Inspect a path (file or directory), return { sha256, size_bytes } using the
// right hasher. Used both for declared targets (manifest-driven) and scanned
// targets (fallback).
function hashPath(absPath) {
  const st = fs.statSync(absPath);
  if (st.isDirectory()) {
    const h = hashDir(absPath);
    return { sha256: h.sha256, size_bytes: h.size_bytes, file_count: h.file_count, is_dir: true };
  }
  const buf = fs.readFileSync(absPath);
  return { sha256: sha256Hex(buf), size_bytes: buf.length, file_count: 1, is_dir: false };
}

function inferFormat(name, statObj) {
  for (const p of FORMAT_PATTERNS) {
    if (p.match(name, statObj)) return p.format;
  }
  return null;
}

// Build + validate the canonical export block. Optional inputs are dropped
// from output if falsy. Block carries its own short hash so any tamper
// downstream breaks the artifact hash (see src/artifact.js#buildPayload).
export function buildExportBlock(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('export input must be object');
  if (!input.backend || typeof input.backend !== 'string') {
    throw new Error('export.backend required (string)');
  }
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new Error('export.targets must be non-empty array');
  }
  const targets = input.targets.map((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`export.targets[${i}] must be object`);
    if (!t.format || typeof t.format !== 'string') throw new Error(`export.targets[${i}].format required`);
    if (!t.filename || typeof t.filename !== 'string') throw new Error(`export.targets[${i}].filename required`);
    if (!t.sha256 || typeof t.sha256 !== 'string') throw new Error(`export.targets[${i}].sha256 required`);
    const cleanHash = t.sha256.replace(/^sha256:/, '');
    if (!HEX64_RE.test(cleanHash)) throw new Error(`export.targets[${i}].sha256 must be hex64`);
    const out = {
      format: t.format,
      filename: t.filename,
      sha256: cleanHash,
      size_bytes: t.size_bytes != null ? Number(t.size_bytes) : 0,
    };
    if (t.quantization) out.quantization = String(t.quantization);
    if (t.runtime_min_version) out.runtime_min_version = String(t.runtime_min_version);
    if (t.is_dir) out.is_dir = true;
    if (t.file_count != null) out.file_count = Number(t.file_count);
    return out;
  });
  const out = {
    spec: EXPORT_SPEC_VERSION,
    backend: input.backend,
    exported_at: input.exported_at || new Date().toISOString(),
    targets,
  };
  if (input.source_artifact_hash) {
    const clean = String(input.source_artifact_hash).replace(/^sha256:/, '');
    if (!HEX64_RE.test(clean)) throw new Error('export.source_artifact_hash must be hex64');
    out.source_artifact_hash = clean;
  }
  if (input.options && typeof input.options === 'object') {
    out.options = { ...input.options };
  }
  if (input.notes && typeof input.notes === 'string') out.notes = input.notes;
  out.hash = _shortHash(_canon(out));
  return out;
}

// Re-validate an export block read back from a manifest. Returns frozen on
// success; throws on schema or hash mismatch.
export function validateExportBlock(block) {
  if (!block || typeof block !== 'object') throw new Error('export block must be object');
  if (block.spec !== EXPORT_SPEC_VERSION) throw new Error(`bad export spec: ${block.spec}`);
  const { hash, ...rest } = block;
  const recomputed = _shortHash(_canon(rest));
  if (hash !== recomputed) throw new Error('export block hash mismatch');
  return Object.freeze({ ...block });
}

// Main entry. Read the dir, normalize, return:
//   {
//     backend, exported_at, source_artifact_hash, options,
//     targets: [{format, filename, sha256, size_bytes, quantization?, runtime_min_version?, is_dir?, file_count?}],
//     export_block: <canonical block ready for buildAndZip>,
//     files_to_bundle: [{filename, absPath, is_dir}]  // caller uses this to add to extra_files
//   }
export function loadExportProvenance(dirPath, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const abs = path.isAbsolute(dirPath) ? dirPath : path.resolve(cwd, dirPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`export provenance dir not found: ${abs}`);
  }
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) {
    throw new Error(`export provenance path is not a directory: ${abs}`);
  }

  const manifestPath = path.join(abs, 'manifest.json');
  let workerManifest = null;
  let synthesized = false;

  if (fs.existsSync(manifestPath)) {
    try {
      workerManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      throw new Error(`export manifest.json could not be parsed: ${e.message}`);
    }
    if (workerManifest.kolm_export !== true) {
      // Not our manifest — fall through to scan-driven path. Don't trust a
      // manifest that doesn't claim to be ours.
      workerManifest = null;
    }
  }

  let backend, exportedAt, sourceArtifactHash, options, declaredTargets;

  if (workerManifest) {
    backend = workerManifest.backend || 'unknown';
    exportedAt = workerManifest.exported_at || new Date().toISOString();
    sourceArtifactHash = workerManifest.source_artifact_hash || null;
    options = workerManifest.options || null;
    declaredTargets = Array.isArray(workerManifest.targets) ? workerManifest.targets : [];
  } else {
    // Scan-driven: walk the dir, infer formats.
    synthesized = true;
    backend = 'unknown';
    exportedAt = new Date().toISOString();
    sourceArtifactHash = null;
    options = null;
    declaredTargets = [];
    const entries = fs.readdirSync(abs).sort();
    for (const name of entries) {
      if (name === 'manifest.json') continue;
      const childAbs = path.join(abs, name);
      let st;
      try { st = fs.statSync(childAbs); } catch { continue; }
      const format = inferFormat(name, st);
      if (!format) continue;
      declaredTargets.push({ format, filename: name });
    }
    if (declaredTargets.length === 0) {
      throw new Error(`export dir has no recognized output files: ${abs} (expected .gguf/.onnx/.mlpackage/.pte/mlx_model/engine)`);
    }
  }

  // For every declared target, locate the file/dir, recompute hash, and
  // verify against the declared hash when present. Drift is fatal — the
  // bridge cannot let a manifest claim a hash that doesn't match the bytes.
  const resolvedTargets = [];
  const filesToBundle = [];
  for (let i = 0; i < declaredTargets.length; i++) {
    const t = declaredTargets[i];
    if (!t.filename) throw new Error(`export target [${i}] missing filename`);
    const targetAbs = path.join(abs, t.filename);
    if (!fs.existsSync(targetAbs)) {
      throw new Error(`export target file not found: ${targetAbs}`);
    }
    const h = hashPath(targetAbs);
    if (t.sha256) {
      const declared = String(t.sha256).replace(/^sha256:/, '');
      if (declared !== h.sha256) {
        throw new Error(`export target ${t.filename} hash drift: manifest=${declared} disk=${h.sha256}`);
      }
    }
    const resolved = {
      format: t.format || inferFormat(t.filename, fs.statSync(targetAbs)) || 'unknown',
      filename: t.filename,
      sha256: h.sha256,
      size_bytes: h.size_bytes,
    };
    if (t.quantization) resolved.quantization = String(t.quantization);
    if (t.runtime_min_version) resolved.runtime_min_version = String(t.runtime_min_version);
    if (h.is_dir) { resolved.is_dir = true; resolved.file_count = h.file_count; }
    resolvedTargets.push(resolved);
    filesToBundle.push({ filename: t.filename, absPath: targetAbs, is_dir: h.is_dir });
  }

  const exportBlock = buildExportBlock({
    backend,
    exported_at: exportedAt,
    source_artifact_hash: sourceArtifactHash || undefined,
    options: options || undefined,
    targets: resolvedTargets,
    notes: synthesized
      ? 'scan-driven: no kolm_export manifest.json present; format inferred from extensions'
      : undefined,
  });

  return {
    backend,
    exported_at: exportedAt,
    source_artifact_hash: sourceArtifactHash,
    options,
    targets: resolvedTargets,
    export_block: exportBlock,
    files_to_bundle: filesToBundle,
    synthesized,
  };
}

export default {
  EXPORT_SPEC_VERSION,
  loadExportProvenance,
  buildExportBlock,
  validateExportBlock,
};
