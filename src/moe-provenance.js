// src/moe-provenance.js
//
// Wave 147 — bridge between the isolated apps/trainer/moe_run.py Python
// composition step and the in-process artifact builder. Reads a MoE
// composition output dir, recomputes every per-file sha256 from disk,
// verifies declared hashes when present, and emits a normalized `moe` block
// that buildAndZip will bind into the artifact hash (sibling of `lineage`
// and `export`).
//
// Mirrors src/export-provenance.js (wave 146) and src/distill-provenance.js
// (wave 144). The cross-package contract is:
//
//   * Python writes manifest.json with `kolm_moe: true` + per-target sha256
//     declarations.
//   * Node bridge refuses to consume any manifest.json that doesn't carry
//     the `kolm_moe: true` marker (security boundary; foreign manifests are
//     ignored as if absent).
//   * Node bridge recomputes every file/dir hash from disk; drift is fatal.
//
// Input shape:
//
//   {
//     "kolm_moe": true,
//     "kolm_moe_version": "0.1.0",
//     "base_model": "Qwen/Qwen2.5-3B-Instruct",
//     "routing_strategy": "top_1" | "top_k",
//     "top_k": 1,
//     "composed_at": "ISO8601",
//     "router": { "filename", "sha256", "size_bytes" },
//     "experts": [ { "name", "filename", "sha256", "size_bytes",
//                    "is_dir"?, "file_count"?, "cid"? } ],
//     "training_stats": { ... }?
//   }
//
// Output: { router, experts, moe_block, files_to_bundle, training_stats }
//
// Honest scope: this BUILDS and VALIDATES the moe block. It does NOT train a
// router (that's Python, see apps/trainer/moe_run.py --train). It does NOT
// decide whether the host can run top_k routing (runtime concern). It is a
// pure schema + hash-recompute layer.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MOE_SPEC_VERSION = 'moe-v1';

const HEX64_RE = /^[0-9a-f]{64}$/;
const VALID_ROUTING = new Set(['top_1', 'top_k']);

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

// Recursive directory hash, byte-identical to apps/trainer/moe_run.py
// _hash_dir() — sort by posix-rel-path, join `(rel \0 sha256 \0 size)` lines
// with `\n`, then sha256. Same spec as src/export-provenance.js hashDir().
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

function hashPath(absPath) {
  const st = fs.statSync(absPath);
  if (st.isDirectory()) {
    const h = hashDir(absPath);
    return { sha256: h.sha256, size_bytes: h.size_bytes, file_count: h.file_count, is_dir: true };
  }
  const buf = fs.readFileSync(absPath);
  return { sha256: sha256Hex(buf), size_bytes: buf.length, file_count: 1, is_dir: false };
}

// Build + validate the canonical moe block. Optional inputs are dropped
// from output if falsy. Block carries its own short hash so any tamper
// downstream breaks the artifact hash.
export function buildMoeBlock(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('moe input must be object');
  if (!input.base_model || typeof input.base_model !== 'string') {
    throw new Error('moe.base_model required (string)');
  }
  const routing = input.routing_strategy;
  if (!routing || !VALID_ROUTING.has(routing)) {
    throw new Error(`moe.routing_strategy must be one of ${[...VALID_ROUTING].join('|')}`);
  }
  const topK = input.top_k == null ? 1 : Number(input.top_k);
  if (!Number.isFinite(topK) || topK < 1) throw new Error('moe.top_k must be integer >= 1');
  if (routing === 'top_k' && topK < 2) throw new Error('moe.routing_strategy=top_k requires top_k >= 2');

  if (!input.router || typeof input.router !== 'object') {
    throw new Error('moe.router required (object)');
  }
  const router = input.router;
  if (!router.filename || typeof router.filename !== 'string') {
    throw new Error('moe.router.filename required');
  }
  if (!router.sha256 || typeof router.sha256 !== 'string') {
    throw new Error('moe.router.sha256 required');
  }
  const routerHash = String(router.sha256).replace(/^sha256:/, '');
  if (!HEX64_RE.test(routerHash)) throw new Error('moe.router.sha256 must be hex64');

  if (!Array.isArray(input.experts) || input.experts.length < 2) {
    throw new Error('moe.experts must be array of length >= 2');
  }
  const seenNames = new Set();
  const experts = input.experts.map((e, i) => {
    if (!e || typeof e !== 'object') throw new Error(`moe.experts[${i}] must be object`);
    if (!e.name || typeof e.name !== 'string') throw new Error(`moe.experts[${i}].name required`);
    if (seenNames.has(e.name)) throw new Error(`moe.experts[${i}].name duplicate: ${e.name}`);
    seenNames.add(e.name);
    if (!e.filename || typeof e.filename !== 'string') throw new Error(`moe.experts[${i}].filename required`);
    if (!e.sha256 || typeof e.sha256 !== 'string') throw new Error(`moe.experts[${i}].sha256 required`);
    const cleanHash = String(e.sha256).replace(/^sha256:/, '');
    if (!HEX64_RE.test(cleanHash)) throw new Error(`moe.experts[${i}].sha256 must be hex64`);
    const out = {
      name: e.name,
      filename: e.filename,
      sha256: cleanHash,
      size_bytes: e.size_bytes != null ? Number(e.size_bytes) : 0,
    };
    if (e.cid) out.cid = String(e.cid);
    if (e.is_dir) out.is_dir = true;
    if (e.file_count != null) out.file_count = Number(e.file_count);
    if (e.domain) out.domain = String(e.domain);
    return out;
  });

  const out = {
    spec: MOE_SPEC_VERSION,
    base_model: input.base_model,
    routing_strategy: routing,
    top_k: topK,
    composed_at: input.composed_at || new Date().toISOString(),
    router: {
      filename: router.filename,
      sha256: routerHash,
      size_bytes: router.size_bytes != null ? Number(router.size_bytes) : 0,
    },
    experts,
  };
  if (router.hidden_size != null) out.router.hidden_size = Number(router.hidden_size);
  if (router.router_hidden != null) out.router.router_hidden = Number(router.router_hidden);
  if (input.training_stats && typeof input.training_stats === 'object') {
    out.training_stats = { ...input.training_stats };
  }
  if (input.notes && typeof input.notes === 'string') out.notes = input.notes;
  out.hash = _shortHash(_canon(out));
  return out;
}

// Re-validate a moe block read back from a manifest. Returns frozen on
// success; throws on schema or hash mismatch.
export function validateMoeBlock(block) {
  if (!block || typeof block !== 'object') throw new Error('moe block must be object');
  if (block.spec !== MOE_SPEC_VERSION) throw new Error(`bad moe spec: ${block.spec}`);
  const { hash, ...rest } = block;
  const recomputed = _shortHash(_canon(rest));
  if (hash !== recomputed) throw new Error('moe block hash mismatch');
  return Object.freeze({ ...block });
}

// Main entry. Read the dir, normalize, return:
//   {
//     base_model, routing_strategy, top_k, composed_at,
//     router: { filename, sha256, size_bytes },
//     experts: [{ name, filename, sha256, size_bytes, is_dir?, file_count?, cid? }],
//     training_stats: {...}?,
//     moe_block: <canonical block ready for buildAndZip>,
//     files_to_bundle: [{filename, absPath, is_dir}],
//   }
export function loadMoeProvenance(dirPath, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const abs = path.isAbsolute(dirPath) ? dirPath : path.resolve(cwd, dirPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`moe provenance dir not found: ${abs}`);
  }
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) {
    throw new Error(`moe provenance path is not a directory: ${abs}`);
  }

  const manifestPath = path.join(abs, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`moe provenance missing manifest.json: ${abs} (write one with apps/trainer/moe_run.py --compose ...)`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`moe manifest.json could not be parsed: ${e.message}`);
  }
  // Foreign manifests (no kolm_moe:true marker) are ignored as a security
  // boundary — don't let an unrelated manifest.json be consumed as truth.
  if (raw.kolm_moe !== true) {
    throw new Error('moe manifest.json missing kolm_moe:true marker (foreign manifest refused)');
  }

  const baseModel = raw.base_model;
  if (!baseModel) throw new Error('moe manifest.base_model required');
  const routing = raw.routing_strategy || 'top_1';
  const topK = raw.top_k == null ? 1 : Number(raw.top_k);
  const composedAt = raw.composed_at || new Date().toISOString();

  if (!raw.router || typeof raw.router !== 'object') {
    throw new Error('moe manifest.router required');
  }
  const routerFilename = raw.router.filename;
  if (!routerFilename) throw new Error('moe manifest.router.filename required');
  const routerAbs = path.join(abs, routerFilename);
  if (!fs.existsSync(routerAbs)) {
    throw new Error(`moe router file not found: ${routerAbs}`);
  }
  const routerOnDisk = hashPath(routerAbs);
  const declaredRouterHash = raw.router.sha256 ? String(raw.router.sha256).replace(/^sha256:/, '') : null;
  if (declaredRouterHash && declaredRouterHash !== routerOnDisk.sha256) {
    throw new Error(`moe router hash drift: manifest=${declaredRouterHash} disk=${routerOnDisk.sha256}`);
  }
  const resolvedRouter = {
    filename: routerFilename,
    sha256: routerOnDisk.sha256,
    size_bytes: routerOnDisk.size_bytes,
  };
  if (raw.router.hidden_size != null) resolvedRouter.hidden_size = Number(raw.router.hidden_size);
  if (raw.router.router_hidden != null) resolvedRouter.router_hidden = Number(raw.router.router_hidden);

  if (!Array.isArray(raw.experts) || raw.experts.length < 2) {
    throw new Error('moe manifest.experts must be array of length >= 2');
  }
  const resolvedExperts = [];
  const filesToBundle = [
    { filename: routerFilename, absPath: routerAbs, is_dir: false, role: 'router' },
  ];
  for (let i = 0; i < raw.experts.length; i++) {
    const e = raw.experts[i];
    if (!e || !e.filename) throw new Error(`moe manifest.experts[${i}].filename required`);
    if (!e.name) throw new Error(`moe manifest.experts[${i}].name required`);
    const expertAbs = path.join(abs, e.filename);
    if (!fs.existsSync(expertAbs)) {
      throw new Error(`moe expert file not found: ${expertAbs}`);
    }
    const h = hashPath(expertAbs);
    const declared = e.sha256 ? String(e.sha256).replace(/^sha256:/, '') : null;
    if (declared && declared !== h.sha256) {
      throw new Error(`moe expert ${e.name} (${e.filename}) hash drift: manifest=${declared} disk=${h.sha256}`);
    }
    const resolved = {
      name: e.name,
      filename: e.filename,
      sha256: h.sha256,
      size_bytes: h.size_bytes,
    };
    if (e.cid) resolved.cid = String(e.cid);
    if (e.domain) resolved.domain = String(e.domain);
    if (h.is_dir) { resolved.is_dir = true; resolved.file_count = h.file_count; }
    resolvedExperts.push(resolved);
    filesToBundle.push({ filename: e.filename, absPath: expertAbs, is_dir: h.is_dir, role: 'expert' });
  }

  const moeBlock = buildMoeBlock({
    base_model: baseModel,
    routing_strategy: routing,
    top_k: topK,
    composed_at: composedAt,
    router: resolvedRouter,
    experts: resolvedExperts,
    training_stats: raw.training_stats || undefined,
  });

  return {
    base_model: baseModel,
    routing_strategy: routing,
    top_k: topK,
    composed_at: composedAt,
    router: resolvedRouter,
    experts: resolvedExperts,
    training_stats: raw.training_stats || null,
    moe_block: moeBlock,
    files_to_bundle: filesToBundle,
  };
}

export default {
  MOE_SPEC_VERSION,
  loadMoeProvenance,
  buildMoeBlock,
  validateMoeBlock,
};
