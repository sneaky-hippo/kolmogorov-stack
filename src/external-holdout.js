// src/external-holdout.js
//
// Wave 164 (N+3 / N+4) — external benchmark holdouts AND adversarial cross-
// family LLM-pair holdouts. The eval credibility memo (Wave 144 Doc 2 §7)
// named these as the layers ABOVE the seeds.jsonl train/holdout gate (W144
// Q+2 / N+1.5):
//
//   N+1.5 / Q+2  - tenant seeds.jsonl train/holdout split (src/seeds.js)
//   N+3          - external public benchmark holdouts (this module, 'external')
//   N+4          - adversarial cross-family LLM-pair holdouts (this module,
//                  'adversarial')
//   N+5 (W165)   - tenant shadow corpus upload endpoint (separate from seeds)
//   N+6 (W160)   - teacher-delta T axis (already shipped)
//   N+7 (W166)   - third-party auditor attestation
//
// The two new layers share one module because they share one substrate: a
// JSONL holdout file authored independently of the tenant's seeds.jsonl,
// with documented provenance (source, license, accessed_at), that gets
// scored against the same recipe as the seed holdout and contributes a
// SEPARATE accuracy field into the manifest's `external_holdout_provenance`
// block. The verifier (binder check #20) confirms the holdout file's hash
// matches what the manifest declares and the recorded accuracy was computed
// over a hash-pinned corpus, not over rows the recipe synthesized from.
//
// Honest scope: this module loads a curated holdout, validates its shape +
// hash, and runs the recipe over it. It does NOT generate the holdout — the
// `holdouts/external/*.jsonl` and `holdouts/adversarial/*.jsonl` files
// shipped under repo root are the static corpora. New holdouts can be added
// by dropping a JSONL into one of those dirs and an entry into
// `holdouts/catalog.json` with name/kind/license/source_url/accessed_at.
//
// Why this matters: the seeds.jsonl gate (Q+2) makes K-score non-tautological
// for any tenant who has captured 50+ real IO rows. But the holdout is the
// TENANT'S — it shares distribution with the recipe's training data.
// External + adversarial holdouts answer a different question: "does this
// recipe also work on data the tenant didn't curate?" That's the question
// regulated procurement actually asks.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSeeds, hashSeeds, canonicalJson } from './seeds.js';

export const EXTERNAL_HOLDOUT_SPEC_VERSION = 'external-holdout-v1';

// Both kinds (external benchmark and adversarial pair) flow through one
// validation path. The kind is informational to the verifier but determines
// which sub-dir under holdouts/ the loader searches.
export const HOLDOUT_KINDS = ['external', 'adversarial'];

function sha256(s) {
  return crypto.createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');
}

// Catalog lookup. Reads holdouts/catalog.json from a configurable root (cwd
// by default) and returns the entry for `name` or null. Catalog entries are
// the source of truth for license + provenance metadata so a verifier can
// surface "this holdout came from <source_url> under <license>" without
// trusting the .jsonl header alone.
export function loadCatalog(opts = {}) {
  const root = opts.root || process.cwd();
  const catalogPath = path.resolve(root, 'holdouts', 'catalog.json');
  if (!fs.existsSync(catalogPath)) {
    return { holdouts: [], catalog_path: catalogPath, missing: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (e) {
    throw new Error(`external-holdout: holdouts/catalog.json invalid JSON: ${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.holdouts)) {
    throw new Error('external-holdout: holdouts/catalog.json missing top-level "holdouts" array');
  }
  return { holdouts: parsed.holdouts, catalog_path: catalogPath, missing: false };
}

export function findInCatalog(name, opts = {}) {
  const { holdouts } = loadCatalog(opts);
  return holdouts.find(h => h.name === name) || null;
}

// Locate a holdout JSONL on disk. Search order:
//   1. catalog entry's `file` field, resolved relative to repo root
//   2. holdouts/<kind>/<name>.jsonl
// Returns the resolved absolute path or null.
export function resolveHoldoutPath(name, opts = {}) {
  const root = opts.root || process.cwd();
  const entry = findInCatalog(name, opts);
  if (entry && entry.file) {
    const abs = path.resolve(root, entry.file);
    if (fs.existsSync(abs)) return abs;
  }
  for (const kind of HOLDOUT_KINDS) {
    const candidate = path.resolve(root, 'holdouts', kind, `${name}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Validate a catalog entry's shape. Throws on missing required fields; warns
// (returns warnings array) on missing-but-recommended ones. Required:
// name, kind, file, license, source_url, accessed_at. Recommended:
// description, suitable_for (array of recipe tags this holdout applies to),
// expected_sha256 (verifier enforces if present), row_count.
export function validateCatalogEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('external-holdout: catalog entry must be an object');
  }
  // W252b Bug 6 — expected_sha256 is now REQUIRED, not recommended. Without
  // it the verifier has no way to confirm the on-disk holdout file has not
  // drifted from what the catalog declares, and the whole point of the
  // external-holdout layer is corpus-identity provenance. Adding a row to
  // the catalog without computing the hash is the exact silent-drift the
  // verifier was supposed to prevent.
  const required = ['name', 'kind', 'file', 'license', 'source_url', 'accessed_at', 'expected_sha256'];
  for (const k of required) {
    if (entry[k] == null || entry[k] === '') {
      if (k === 'expected_sha256') {
        throw new Error(
          `external-holdout: catalog entry '${entry.name || '?'}' missing required expected_sha256. ` +
          `Compute with: openssl dgst -sha256 ${entry.file || '<file>'} and add to catalog entry.`
        );
      }
      throw new Error(`external-holdout: catalog entry missing required field '${k}'`);
    }
  }
  if (!HOLDOUT_KINDS.includes(entry.kind)) {
    throw new Error(`external-holdout: catalog entry kind='${entry.kind}' must be one of ${HOLDOUT_KINDS.join(', ')}`);
  }
  // accessed_at must be an ISO-8601 date string (rough check)
  if (!/^\d{4}-\d{2}-\d{2}/.test(entry.accessed_at)) {
    throw new Error(`external-holdout: catalog entry accessed_at='${entry.accessed_at}' must be ISO-8601`);
  }
  if (!/^[0-9a-f]{64}$/.test(entry.expected_sha256)) {
    throw new Error(`external-holdout: catalog entry '${entry.name}' expected_sha256 must be 64 hex chars (got ${entry.expected_sha256.length})`);
  }
  const warnings = [];
  if (!entry.description) warnings.push(`entry '${entry.name}' missing description`);
  if (!Array.isArray(entry.suitable_for) || entry.suitable_for.length === 0) {
    warnings.push(`entry '${entry.name}' missing suitable_for tags`);
  }
  return { ok: true, warnings };
}

// Compute the canonical hash of a holdout file (raw bytes). Used by the
// verifier to confirm the file declared in the manifest is byte-identical
// to what shipped under holdouts/. The hash is over the on-disk bytes so a
// third party with the same file (sha256-comparable) can reproduce.
export function hashHoldoutFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`external-holdout: file not found: ${filePath}`);
  }
  return sha256(fs.readFileSync(filePath));
}

// Load a holdout by name. Returns { name, kind, license, source_url,
// accessed_at, file_path, file_sha256, rows, normalized_hash }. The rows
// array is normalized via loadSeeds (so legacy {prompt, completion} works);
// the normalized_hash is hashSeeds(rows) so the verifier can confirm the
// holdout produced the same row set after normalization.
export function loadHoldout(name, opts = {}) {
  const entry = findInCatalog(name, opts);
  if (!entry) {
    throw new Error(`external-holdout: '${name}' not found in holdouts/catalog.json`);
  }
  const { warnings } = validateCatalogEntry(entry);

  const filePath = resolveHoldoutPath(name, opts);
  if (!filePath) {
    throw new Error(`external-holdout: '${name}' file not found (looked in catalog 'file' and holdouts/<kind>/<name>.jsonl)`);
  }
  const file_sha256 = hashHoldoutFile(filePath);
  if (entry.expected_sha256 && entry.expected_sha256 !== file_sha256) {
    throw new Error(`external-holdout: '${name}' file sha256 drift — catalog expected ${entry.expected_sha256}, file is ${file_sha256}`);
  }

  const loaded = loadSeeds(filePath);
  if (loaded.rows.length === 0) {
    throw new Error(`external-holdout: '${name}' loaded 0 rows (skipped ${loaded.skipped}); check format`);
  }
  const normalized_hash = hashSeeds(loaded.rows);

  return {
    name,
    kind: entry.kind,
    license: entry.license,
    source_url: entry.source_url,
    accessed_at: entry.accessed_at,
    description: entry.description || null,
    suitable_for: Array.isArray(entry.suitable_for) ? entry.suitable_for.slice() : [],
    adversarial_generator_pair: entry.adversarial_generator_pair || null,
    file_path: filePath,
    file_sha256,
    rows: loaded.rows,
    row_count: loaded.rows.length,
    skipped: loaded.skipped,
    normalized_hash,
    warnings,
  };
}

// Build the manifest block for a list of loaded holdouts. The block sits at
// manifest.external_holdout_provenance and its `hash` field binds into
// artifact_hash via artifact_hash_input.external_holdout_hash. Tamper with
// any holdout's file_sha256 or recorded accuracy and the block hash drifts,
// the artifact hash drifts, every signature breaks.
//
// scoreHoldoutFn(rows) is supplied by the caller (typically a closure over
// the compiled recipe + comparator); it returns { accuracy, evaluated_count,
// passed_count }.
export function buildExternalHoldoutBlock(loadedHoldouts, scoreHoldoutFn, opts = {}) {
  if (!Array.isArray(loadedHoldouts) || loadedHoldouts.length === 0) {
    return null;
  }
  const results = loadedHoldouts.map(h => {
    const score = scoreHoldoutFn(h.rows.map(r => ({ input: r.input, expected: r.expected, metadata: r.metadata })));
    const accuracy = typeof score?.accuracy === 'number' ? score.accuracy : null;
    // src/comparators.js#scoreHoldout returns { accuracy, total, correct,
    // comparator, per_row }. Accept either {correct, total} or aliases for
    // forward compat with future scorers.
    const passed = typeof score?.correct === 'number'
      ? score.correct
      : (typeof score?.passed_count === 'number' ? score.passed_count : null);
    const total = typeof score?.total === 'number'
      ? score.total
      : (typeof score?.evaluated_count === 'number' ? score.evaluated_count : h.row_count);
    return {
      name: h.name,
      kind: h.kind,
      license: h.license,
      source_url: h.source_url,
      accessed_at: h.accessed_at,
      file_basename: path.basename(h.file_path),
      file_sha256: h.file_sha256,
      normalized_hash: h.normalized_hash,
      row_count: h.row_count,
      accuracy,
      passed_count: passed,
      evaluated_count: total,
      suitable_for: h.suitable_for,
      adversarial_generator_pair: h.adversarial_generator_pair,
      // K-score implication: this accuracy is the "external R" or
      // "adversarial R" axis depending on kind. The seed-holdout's
      // R axis (holdout_accuracy) measures generalization within the
      // tenant's distribution; this measures generalization OUT of it.
    };
  });
  const block = {
    spec: EXTERNAL_HOLDOUT_SPEC_VERSION,
    generated_at: opts.generated_at || new Date().toISOString(),
    comparator: opts.comparator || 'exact',
    holdouts: results,
  };
  block.hash = sha256(canonicalJson(block));
  return block;
}

// Validate a manifest.external_holdout_provenance block. Re-hashes the
// canonical representation (excluding the .hash field itself), confirms
// every holdout entry has the required fields, returns the validated block
// or throws.
export function validateExternalHoldoutBlock(block) {
  if (!block || typeof block !== 'object') {
    throw new Error('external-holdout: block must be an object');
  }
  if (block.spec !== EXTERNAL_HOLDOUT_SPEC_VERSION) {
    throw new Error(`external-holdout: block.spec='${block.spec}' expected '${EXTERNAL_HOLDOUT_SPEC_VERSION}'`);
  }
  if (!Array.isArray(block.holdouts) || block.holdouts.length === 0) {
    throw new Error('external-holdout: block.holdouts must be a non-empty array');
  }
  for (const h of block.holdouts) {
    for (const k of ['name', 'kind', 'license', 'source_url', 'accessed_at', 'file_basename', 'file_sha256', 'normalized_hash', 'row_count']) {
      if (h[k] == null) {
        throw new Error(`external-holdout: holdout '${h.name || '?'}' missing field '${k}'`);
      }
    }
    if (!HOLDOUT_KINDS.includes(h.kind)) {
      throw new Error(`external-holdout: holdout '${h.name}' kind='${h.kind}' invalid`);
    }
    if (!/^[0-9a-f]{64}$/.test(h.file_sha256)) {
      throw new Error(`external-holdout: holdout '${h.name}' file_sha256 not hex64`);
    }
    if (!/^[0-9a-f]{64}$/.test(h.normalized_hash)) {
      throw new Error(`external-holdout: holdout '${h.name}' normalized_hash not hex64`);
    }
  }
  // Recompute the block hash without its own .hash field
  const { hash: declared, ...rest } = block;
  const recomputed = sha256(canonicalJson(rest));
  if (declared !== recomputed) {
    throw new Error(`external-holdout: block hash drift — declared ${declared}, recomputed ${recomputed}`);
  }
  return block;
}

// Convenience: load several holdouts by name in one call. Returns an array
// of loaded objects (suitable for buildExternalHoldoutBlock).
export function loadHoldouts(names, opts = {}) {
  if (!Array.isArray(names) || names.length === 0) return [];
  return names.map(n => loadHoldout(n, opts));
}
