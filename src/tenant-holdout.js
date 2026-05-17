// src/tenant-holdout.js
//
// Wave 165 (N+5) — tenant shadow corpus. The eval-credibility ladder Wave
// 144 Doc 2 §7 named five tiers; N+5 is the layer ABOVE external + adversarial
// (W164 N+3/N+4):
//
//   N+1.5 / Q+2  - tenant seeds.jsonl train/holdout split (src/seeds.js)
//   N+3          - external public benchmark holdouts (W164)
//   N+4          - adversarial cross-family LLM-pair holdouts (W164)
//   N+5          - TENANT SHADOW CORPUS (this module)
//   N+6 (W160)   - teacher-delta T axis (shipped)
//   N+7 (W166)   - third-party auditor attestation
//
// The distinguishing property of N+5: the corpus NEVER LEAVES THE TENANT'S
// ENVIRONMENT. Unlike seeds.jsonl (shipped with the .kolm so the verifier
// can replay), and unlike external holdouts (shipped under repo root so
// every verifier can re-anchor), the shadow corpus is uploaded once to the
// tenant's own server storage and the .kolm artifact records ONLY the
// {tenant_id, corpus_id, corpus_sha256, accuracy} — never the corpus rows
// themselves.
//
// Why this matters: HIPAA-covered tenants, banking BAA holders, and any
// regulated buyer with a contractual data-residency clause CANNOT ship
// their own labeled holdout corpus inside a portable artifact. They need
// to (a) prove the recipe was scored against their proprietary corpus,
// (b) prove the manifest's recorded accuracy was computed over a hash-
// pinned snapshot of that corpus, and (c) not leak the corpus contents
// to anyone holding the .kolm. The verifier check #21 anchors to the
// tenant's storage when accessible (server-side or air-gapped) and falls
// back to schema + hash round-trip when not (external auditor with no
// access to the tenant's infrastructure).
//
// Storage layout (server-side):
//
//   ${KOLM_DATA_DIR}/tenant_holdouts/${tenant_id}/${corpus_id}.jsonl
//
// One file per corpus. Per-tenant subdir scopes naturally. Filenames
// validated to a strict pattern to prevent path traversal.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSeeds, hashSeeds, canonicalJson } from './seeds.js';

export const TENANT_SHADOW_SPEC_VERSION = 'tenant-shadow-corpus-v1';

// tenant_id and corpus_id must be safe for filesystem use. We deliberately
// restrict to [a-z0-9_-] so a malicious id can't escape the per-tenant dir
// via ../ traversal or null bytes.
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

function sha256(s) {
  return crypto.createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');
}

function tenantHoldoutRoot(opts = {}) {
  const dataDir = opts.dataDir || process.env.KOLM_DATA_DIR || path.resolve('data');
  return path.join(dataDir, 'tenant_holdouts');
}

export function resolveCorpusPath(tenantId, corpusId, opts = {}) {
  if (!SAFE_ID.test(tenantId)) {
    throw new Error(`tenant-holdout: tenant_id='${tenantId}' must match ${SAFE_ID}`);
  }
  if (!SAFE_ID.test(corpusId)) {
    throw new Error(`tenant-holdout: corpus_id='${corpusId}' must match ${SAFE_ID}`);
  }
  return path.join(tenantHoldoutRoot(opts), tenantId, `${corpusId}.jsonl`);
}

export function hashCorpusFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`tenant-holdout: file not found: ${filePath}`);
  }
  return sha256(fs.readFileSync(filePath));
}

// Save a corpus to disk. Accepts rows in either canonical {input, output}
// or legacy {prompt, completion} shape; normalizes via loadSeeds-compatible
// JSONL format on disk. Returns metadata the caller (HTTP endpoint or CLI)
// can echo to the tenant.
//
// Setting replace=true overwrites an existing corpus. Default is false:
// re-saving the same corpus_id throws (so a CI script that drifts the
// corpus by accident is caught instead of silently shadowing the prior one).
export function saveCorpus(tenantId, corpusId, rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('tenant-holdout: rows must be a non-empty array');
  }
  const filePath = resolveCorpusPath(tenantId, corpusId, opts);
  if (fs.existsSync(filePath) && !opts.replace) {
    throw new Error(`tenant-holdout: corpus '${corpusId}' already exists for tenant '${tenantId}' (pass replace=true to overwrite)`);
  }
  const tenantDir = path.dirname(filePath);
  fs.mkdirSync(tenantDir, { recursive: true });
  // Normalize: each row stored as canonical {input, output, tags?, metadata?}.
  // Legacy {prompt, completion} is preserved as-is and the loader normalizes
  // it at read time (same path seeds.js takes for tenant seeds.jsonl).
  const lines = rows.map(r => {
    const out = {};
    if (r.input != null) out.input = r.input;
    if (r.output != null) out.output = r.output;
    if (r.prompt != null) out.prompt = r.prompt;
    if (r.completion != null) out.completion = r.completion;
    if (r.expected != null && r.output == null && r.completion == null) out.output = r.expected;
    if (Array.isArray(r.tags) && r.tags.length > 0) out.tags = r.tags;
    if (r.metadata && typeof r.metadata === 'object') out.metadata = r.metadata;
    return JSON.stringify(out);
  });
  const body = lines.join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf8');
  const corpus_sha256 = sha256(body);
  // Compute normalized_hash so the loader-side hash is recorded at save time
  const loaded = loadSeeds(filePath);
  const normalized_hash = hashSeeds(loaded.rows);
  return {
    tenant_id: tenantId,
    corpus_id: corpusId,
    file_path: filePath,
    corpus_sha256,
    normalized_hash,
    row_count: loaded.rows.length,
    skipped: loaded.skipped,
    stored_at: new Date().toISOString(),
    bytes: Buffer.byteLength(body, 'utf8'),
  };
}

// Read a saved corpus back. Returns the loaded rows + metadata + content
// hashes. Used by the compile path (via --tenant-shadow-corpus flag) AND
// by the verifier (check #21 re-anchor).
export function loadCorpus(tenantId, corpusId, opts = {}) {
  const filePath = resolveCorpusPath(tenantId, corpusId, opts);
  if (!fs.existsSync(filePath)) {
    throw new Error(`tenant-holdout: corpus '${corpusId}' not found for tenant '${tenantId}' at ${filePath}`);
  }
  const corpus_sha256 = hashCorpusFile(filePath);
  const loaded = loadSeeds(filePath);
  if (loaded.rows.length === 0) {
    throw new Error(`tenant-holdout: corpus '${corpusId}' loaded 0 rows (skipped ${loaded.skipped})`);
  }
  const normalized_hash = hashSeeds(loaded.rows);
  return {
    tenant_id: tenantId,
    corpus_id: corpusId,
    file_path: filePath,
    corpus_sha256,
    normalized_hash,
    rows: loaded.rows,
    row_count: loaded.rows.length,
    skipped: loaded.skipped,
    stat: fs.statSync(filePath),
  };
}

export function listCorpora(tenantId, opts = {}) {
  if (!SAFE_ID.test(tenantId)) {
    throw new Error(`tenant-holdout: tenant_id='${tenantId}' must match ${SAFE_ID}`);
  }
  const dir = path.join(tenantHoldoutRoot(opts), tenantId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => n.endsWith('.jsonl'))
    .map(n => {
      const corpus_id = n.slice(0, -'.jsonl'.length);
      const file_path = path.join(dir, n);
      const stat = fs.statSync(file_path);
      return {
        tenant_id: tenantId,
        corpus_id,
        file_path,
        bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
      };
    });
}

export function deleteCorpus(tenantId, corpusId, opts = {}) {
  const filePath = resolveCorpusPath(tenantId, corpusId, opts);
  if (!fs.existsSync(filePath)) {
    return { deleted: false, reason: 'not found' };
  }
  fs.unlinkSync(filePath);
  return { deleted: true, file_path: filePath };
}

// Build the manifest block for a single tenant shadow corpus. Unlike
// external_holdout_provenance which carries the holdout's bytes-hash for
// re-anchor by ANY verifier, tenant_shadow_corpus_provenance carries the
// hash but the corpus stays on the tenant's server. An external verifier
// (no access to tenant storage) can only confirm the schema + block hash
// round-trip; a tenant-internal verifier (same storage access) can also
// re-hash the corpus from disk and confirm the bytes match.
//
// scoreResult shape: { accuracy, total?/evaluated_count?, correct?/passed_count?, comparator? }
export function buildTenantShadowBlock(loadedCorpus, scoreResult, opts = {}) {
  if (!loadedCorpus || !loadedCorpus.tenant_id || !loadedCorpus.corpus_id) {
    throw new Error('tenant-holdout: loadedCorpus must include tenant_id and corpus_id');
  }
  const accuracy = typeof scoreResult?.accuracy === 'number' ? scoreResult.accuracy : null;
  const passed = typeof scoreResult?.correct === 'number'
    ? scoreResult.correct
    : (typeof scoreResult?.passed_count === 'number' ? scoreResult.passed_count : null);
  const total = typeof scoreResult?.total === 'number'
    ? scoreResult.total
    : (typeof scoreResult?.evaluated_count === 'number' ? scoreResult.evaluated_count : loadedCorpus.row_count);
  const block = {
    spec: TENANT_SHADOW_SPEC_VERSION,
    tenant_id: loadedCorpus.tenant_id,
    corpus_id: loadedCorpus.corpus_id,
    corpus_sha256: loadedCorpus.corpus_sha256,
    normalized_hash: loadedCorpus.normalized_hash,
    row_count: loadedCorpus.row_count,
    accuracy,
    passed_count: passed,
    evaluated_count: total,
    comparator: opts.comparator || scoreResult?.comparator || 'exact',
    evaluated_at: opts.evaluated_at || new Date().toISOString(),
    residency_note: opts.residency_note || 'corpus retained on tenant infrastructure; bytes not included in artifact',
  };
  block.hash = sha256(canonicalJson(block));
  return block;
}

export function validateTenantShadowBlock(block) {
  if (!block || typeof block !== 'object') {
    throw new Error('tenant-shadow: block must be an object');
  }
  if (block.spec !== TENANT_SHADOW_SPEC_VERSION) {
    throw new Error(`tenant-shadow: block.spec='${block.spec}' expected '${TENANT_SHADOW_SPEC_VERSION}'`);
  }
  for (const k of ['tenant_id', 'corpus_id', 'corpus_sha256', 'normalized_hash', 'row_count', 'comparator', 'evaluated_at']) {
    if (block[k] == null) {
      throw new Error(`tenant-shadow: block missing field '${k}'`);
    }
  }
  if (!SAFE_ID.test(block.tenant_id)) {
    throw new Error(`tenant-shadow: tenant_id='${block.tenant_id}' invalid shape`);
  }
  if (!SAFE_ID.test(block.corpus_id)) {
    throw new Error(`tenant-shadow: corpus_id='${block.corpus_id}' invalid shape`);
  }
  if (!/^[0-9a-f]{64}$/.test(block.corpus_sha256)) {
    throw new Error(`tenant-shadow: corpus_sha256 not hex64`);
  }
  if (!/^[0-9a-f]{64}$/.test(block.normalized_hash)) {
    throw new Error(`tenant-shadow: normalized_hash not hex64`);
  }
  const { hash: declared, ...rest } = block;
  const recomputed = sha256(canonicalJson(rest));
  if (declared !== recomputed) {
    throw new Error(`tenant-shadow: block hash drift — declared ${declared}, recomputed ${recomputed}`);
  }
  return block;
}

// Re-anchor an already-loaded block against on-disk corpus bytes (if
// reachable from current cwd's data dir). Returns:
//   { mode: 'reanchored', file_path, corpus_sha256_recomputed, matches: bool }
// when corpus is accessible, or:
//   { mode: 'unavailable', reason } when not.
// The verifier (binder check #21) uses this to differentiate "external
// verifier who can't reach tenant storage but can still validate block
// hash" from "internal verifier who can re-anchor bytes".
export function reAnchorTenantShadowBlock(block, opts = {}) {
  const filePath = resolveCorpusPath(block.tenant_id, block.corpus_id, opts);
  if (!fs.existsSync(filePath)) {
    return {
      mode: 'unavailable',
      reason: `corpus file not reachable at ${filePath} (verifier likely external to tenant infrastructure)`,
    };
  }
  const corpus_sha256_recomputed = hashCorpusFile(filePath);
  return {
    mode: 'reanchored',
    file_path: filePath,
    corpus_sha256_recomputed,
    matches: corpus_sha256_recomputed === block.corpus_sha256,
  };
}
