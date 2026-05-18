// Seed loader, normalizer, deterministic splitter, and leakage detector for
// the seeds.jsonl train/holdout eval gate (Wave 144 / Q+2).
//
// The eval-credibility problem this module solves: previously the K-score was
// computed against `spec.evals.cases` which were derived from the recipe's own
// hardcoded positives at compile time. `input_hash == recipes_json_hash` by
// construction. This module makes the K-score's accuracy axis a measurement
// against UNSEEN holdout rows, not a self-citation.
//
// Inputs:
//   loadSeeds(path)
//     - reads seeds.jsonl in either canonical {input, output, tags?} or
//       legacy {prompt, completion} format
//     - normalizes to { input, expected, metadata }
//     - skips // comment lines and blank lines
//
//   splitSeeds(rows, { split_seed, holdout_ratio = 0.2 })
//     - deterministic 80/20 by sha256(row.input + split_seed)
//     - same seeds.jsonl + same split_seed -> identical split
//     - verifier rebuilds split from these two inputs and confirms
//
//   hashSeeds(rows)
//     - canonical hash of an array of normalized rows
//
//   detectDuplicateInputs(rows)
//     - returns indices that have duplicate normalized inputs
//
//   leakageReport(train, holdout)
//     - returns { overlap, near_duplicates, grouped }
//       overlap: train rows whose input or expected hash matches a holdout row
//       near_duplicates: pairs of rows with high text similarity (Jaccard on
//                        whitespace-token shingles)
//       grouped: train/holdout rows sharing a tag-derived grouping key
//
// Provenance fields surfaced into the manifest:
//   seeds_hash         = sha256(all normalized rows, canonical-JSON)
//   split_seed         = the split seed string used
//   train_hash         = sha256(train rows, canonical-JSON)
//   holdout_hash       = sha256(holdout rows, canonical-JSON)
//   train_count        = train.length
//   holdout_count      = holdout.length
//   leakage_report_hash = sha256(leakage_report, canonical-JSON)
//   eval_source        = 'tenant_captured' | 'synthetic_starter' | 'spec_inline'
//
// `kolm verify` re-runs splitSeeds with (seeds.jsonl, split_seed) and confirms
// train_hash + holdout_hash + leakage_report_hash match the manifest.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_HOLDOUT_RATIO = 0.2;
export const DEFAULT_SPLIT_SEED = 'kolm-default-split-seed-v1';
export const MIN_PRODUCTION_HOLDOUT = 10;
export const MIN_PRODUCTION_TRAIN = 40;

// Canonical-JSON serializer that sorts object keys recursively. The hash of
// a normalized row array must be stable across machines.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function sha256(s) {
  return crypto.createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');
}

// Strip leading // line comments and blank lines from a JSONL stream so the
// public seeds.jsonl can document its provenance in-line without breaking the
// parser.
function stripCommentsAndBlanks(text) {
  return text.split(/\r?\n/).filter(ln => {
    const t = ln.trim();
    return t.length > 0 && !t.startsWith('//');
  });
}

// Normalize one parsed JSONL row from either canonical or legacy schema into
// the internal { input, expected, metadata } shape. Returns null if neither
// schema matches (caller decides to warn vs skip).
//
// `input` may be a string (the common shape for redactors / summarizers /
// classifiers) OR a JSON object (the shape used by extractors and structured
// classifiers whose recipes consume multiple fields). `expected`/`output`
// may likewise be any JSON value.
export function normalizeRow(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  // Canonical kolm format: {input, output|expected, tags?, id?, params?, metadata?}.
  // Input must be a non-null primitive or object; expected must be defined.
  //
  // Wave 284 — when raw.metadata is present, its custom keys (e.g.,
  // member_id / claim_id / case_id) are preserved so the group-aware split
  // can resolve them at split time. Known fields (id, tags, params,
  // source_format) take precedence at the top-level shape.
  if (raw.input !== undefined && raw.input !== null) {
    const expected = raw.expected !== undefined ? raw.expected : raw.output;
    if (expected === undefined) return null;
    const rawMeta = (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) ? raw.metadata : {};
    return {
      input: raw.input,
      expected,
      metadata: {
        ...rawMeta,
        id: raw.id != null ? raw.id : (rawMeta.id != null ? rawMeta.id : null),
        tags: Array.isArray(raw.tags) ? raw.tags.slice()
              : (Array.isArray(rawMeta.tags) ? rawMeta.tags.slice() : []),
        params: raw.params || rawMeta.params || null,
        source_format: 'canonical',
        ...(opts.extra_metadata || {}),
      },
    };
  }
  // Legacy OpenAI fine-tune format: {prompt, completion}
  if (typeof raw.prompt === 'string' && raw.completion != null) {
    const rawMeta = (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) ? raw.metadata : {};
    return {
      input: raw.prompt,
      expected: raw.completion,
      metadata: {
        ...rawMeta,
        id: raw.id != null ? raw.id : (rawMeta.id != null ? rawMeta.id : null),
        tags: Array.isArray(raw.tags) ? raw.tags.slice()
              : (Array.isArray(rawMeta.tags) ? rawMeta.tags.slice() : []),
        params: null,
        source_format: 'legacy_prompt_completion',
        ...(opts.extra_metadata || {}),
      },
    };
  }
  return null;
}

// Load + normalize a seeds.jsonl file. Returns { rows, skipped, source_path,
// source_hash } where rows is the normalized array. Throws if the file does
// not exist. Returns rows=[] (with skipped > 0) if every line fails to parse.
export function loadSeeds(seedsPath, opts = {}) {
  const abs = path.resolve(seedsPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`seeds file not found: ${abs}`);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const source_hash = sha256(raw);
  const lines = stripCommentsAndBlanks(raw);
  const rows = [];
  let skipped = 0;
  let lineNumber = 0;
  for (const ln of lines) {
    lineNumber++;
    let parsed;
    try { parsed = JSON.parse(ln); }
    catch { skipped++; continue; }
    const norm = normalizeRow(parsed, opts);
    if (!norm) { skipped++; continue; }
    rows.push(norm);
  }
  return { rows, skipped, source_path: abs, source_hash };
}

// Locate seeds.jsonl for a given task. Search order:
//   1. explicit seedsPath argument
//   2. models/<task>/seeds.jsonl
//   3. ./seeds.jsonl in cwd
// Returns the resolved absolute path or null if none found.
export function resolveSeedsPath({ explicitPath, task, cwd = process.cwd() } = {}) {
  if (explicitPath) {
    const abs = path.resolve(cwd, explicitPath);
    return fs.existsSync(abs) ? abs : null;
  }
  if (task) {
    const candidate = path.resolve(cwd, 'models', task, 'seeds.jsonl');
    if (fs.existsSync(candidate)) return candidate;
  }
  const rootSeeds = path.resolve(cwd, 'seeds.jsonl');
  if (fs.existsSync(rootSeeds)) return rootSeeds;
  return null;
}

// Canonical string representation of any input value for hashing. Primitives
// hash by their string form; objects hash by canonical JSON so {a:1,b:2}
// hashes the same as {b:2,a:1}. Necessary because the split bucket is
// sha256(canonicalInput + split_seed) and structured inputs must be stable.
function canonicalInput(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return canonicalJson(v);
}

// Deterministic 80/20 split by sha256(canonicalInput(row.input) + split_seed).
// Stable across machines, reproducible by verifier. Returns { train, holdout,
// split_seed, holdout_ratio }.
// Wave 284 — extract the group value for a row given a group_key like
// 'member_id' or 'claim_id' or 'case_id'. Two sources are honored:
//   1. row.metadata[group_key] (canonical seed-author shape)
//   2. row.metadata.tags entries that look like 'group_key:value'
// Returns null if no group value is found for this row, in which case the
// row falls back to per-row bucketing (its own input string is the bucket).
export function extractGroupValue(row, group_key) {
  if (!group_key) return null;
  const md = row && row.metadata;
  if (!md) return null;
  if (md[group_key] != null) return String(md[group_key]);
  if (Array.isArray(md.tags)) {
    const prefix = group_key + ':';
    for (const t of md.tags) {
      if (typeof t === 'string' && t.startsWith(prefix)) return t.slice(prefix.length);
    }
  }
  return null;
}

export function splitSeeds(rows, opts = {}) {
  const split_seed = opts.split_seed || DEFAULT_SPLIT_SEED;
  const holdout_ratio = typeof opts.holdout_ratio === 'number' ? opts.holdout_ratio : DEFAULT_HOLDOUT_RATIO;
  if (holdout_ratio <= 0 || holdout_ratio >= 1) {
    throw new Error(`holdout_ratio must be in (0, 1), got ${holdout_ratio}`);
  }
  if (!Array.isArray(rows)) throw new Error('rows must be an array');

  const group_key = typeof opts.group_key === 'string' && opts.group_key ? opts.group_key : null;
  const buckets = 1000;
  const cutoff = Math.floor(holdout_ratio * buckets);

  // Wave 284 — when group_key is set, route every row whose metadata
  // resolves a group value through a per-group bucket assignment so all
  // rows sharing the value land in the same partition. Rows that don't
  // resolve a group value (no member_id / claim_id / case_id) fall back to
  // per-row hashing — this is the correct behavior for mixed corpora.
  const groupAssignment = new Map(); // group_value -> 'train' | 'holdout'
  function assignGroup(groupValue) {
    if (groupAssignment.has(groupValue)) return groupAssignment.get(groupValue);
    const h = sha256(groupValue + ' ' + split_seed);
    const bucket = parseInt(h.slice(0, 8), 16) % buckets;
    const partition = bucket < cutoff ? 'holdout' : 'train';
    groupAssignment.set(groupValue, partition);
    return partition;
  }

  const train = [];
  const holdout = [];
  const trainHashes = new Set();
  const holdoutHashes = new Set();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const inputHash = sha256(canonicalInput(row.input));
    let partition;
    if (group_key) {
      const gv = extractGroupValue(row, group_key);
      if (gv != null) {
        partition = assignGroup(gv);
      } else {
        const h = sha256(canonicalInput(row.input) + ' ' + split_seed);
        const bucket = parseInt(h.slice(0, 8), 16) % buckets;
        partition = bucket < cutoff ? 'holdout' : 'train';
      }
    } else {
      const h = sha256(canonicalInput(row.input) + ' ' + split_seed);
      const bucket = parseInt(h.slice(0, 8), 16) % buckets;
      partition = bucket < cutoff ? 'holdout' : 'train';
    }
    if (partition === 'holdout') {
      holdout.push(row);
      holdoutHashes.add(inputHash);
    } else {
      train.push(row);
      trainHashes.add(inputHash);
    }
  }

  let overlap_count = 0;
  for (const h of trainHashes) if (holdoutHashes.has(h)) overlap_count++;

  return { train, holdout, split_seed, holdout_ratio, overlap_count, group_key };
}

// Hash an array of normalized rows. The hash is over the canonical-JSON
// serialization of [{input, expected, metadata.tags}, ...]. Metadata fields
// that are author-specific (id, params, source_format) are excluded so a
// round-trip through normalize + serialize is stable.
export function hashSeeds(rows) {
  const projected = rows.map(r => ({
    input: r.input,
    expected: r.expected,
    tags: (r.metadata && r.metadata.tags) ? r.metadata.tags.slice().sort() : [],
  }));
  return sha256(canonicalJson(projected));
}

// Find rows whose input is duplicated. Returns an array of { input_hash,
// indices } groups. Used by leakageReport and surfaced in the manifest.
export function detectDuplicateInputs(rows) {
  const groups = new Map();
  rows.forEach((r, i) => {
    const h = sha256(canonicalInput(r.input));
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(i);
  });
  const out = [];
  for (const [h, indices] of groups) {
    if (indices.length > 1) out.push({ input_hash: h.slice(0, 16), indices });
  }
  return out;
}

// Cheap Jaccard similarity on whitespace-token bigrams. Used by leakageReport
// to flag near-duplicate text that would leak from train into holdout even
// when the input hash differs.
function jaccardBigrams(a, b) {
  // Object inputs (e.g., {text: 'foo'}) stringify to '[object Object]' under
  // String() — every row would tokenize identically and the detector would
  // falsely flag every pair as near-duplicate. Canonicalize via JSON for
  // objects, then tokenize on non-word boundaries so JSON punctuation
  // ({},:,") doesn't dominate the bigram space.
  const flatten = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const tokens = (s) => flatten(s).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  const bigrams = (toks) => {
    const set = new Set();
    for (let i = 0; i < toks.length - 1; i++) set.add(toks[i] + ' ' + toks[i + 1]);
    return set;
  };
  const A = bigrams(tokens(a));
  const B = bigrams(tokens(b));
  if (A.size === 0 && B.size === 0) return 0;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Grouping key for leakage detection. Tries to extract a stable identifier
// from row.metadata.tags (e.g., a member_id or claim_id tag) so two rows
// referring to the same underlying entity can be flagged even with different
// surface text. Returns null if no grouping signal found.
//
// Wave 284 — when an explicit `group_key` is supplied (e.g., 'member_id'),
// the function returns just that group's value so the leakage check matches
// what splitSeeds enforces. Without an explicit key the function falls back
// to picking the first tag that looks like an id, which is the pre-W284
// best-effort behavior.
function groupingKey(row, group_key) {
  if (group_key) {
    const v = extractGroupValue(row, group_key);
    return v ? group_key + ':' + String(v).toLowerCase() : null;
  }
  const tags = (row.metadata && row.metadata.tags) || [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    if (/^[a-z_]+:[a-z0-9_-]+$/i.test(t)) return t.toLowerCase();
  }
  return null;
}

// Report on train/holdout leakage: input/output hash overlap, near-duplicate
// pairs by Jaccard, and grouped-key overlap. Returns a serializable object;
// the manifest carries its hash so verifier can recompute and compare.
export function leakageReport(train, holdout, opts = {}) {
  const similarityThreshold = typeof opts.similarity_threshold === 'number' ? opts.similarity_threshold : 0.85;

  // Direct input-hash overlap
  const trainInputHashes = new Set(train.map(r => sha256(canonicalInput(r.input))));
  const trainOutputHashes = new Set(train.map(r => sha256(canonicalInput(r.expected))));
  const inputOverlap = [];
  const outputOverlap = [];
  holdout.forEach((r, i) => {
    const ih = sha256(canonicalInput(r.input));
    if (trainInputHashes.has(ih)) inputOverlap.push({ holdout_index: i, input_hash: ih.slice(0, 16) });
    const oh = sha256(canonicalInput(r.expected));
    if (trainOutputHashes.has(oh)) outputOverlap.push({ holdout_index: i, output_hash: oh.slice(0, 16) });
  });

  // Near-duplicate by Jaccard bigrams. O(n*m); fine for typical seed sizes.
  // For larger sets a MinHash sketch would be better; defer until needed.
  const nearDuplicates = [];
  if (train.length * holdout.length <= 50_000) {
    for (let i = 0; i < holdout.length; i++) {
      for (let j = 0; j < train.length; j++) {
        const s = jaccardBigrams(holdout[i].input, train[j].input);
        if (s >= similarityThreshold) {
          nearDuplicates.push({ holdout_index: i, train_index: j, similarity: Number(s.toFixed(3)) });
          if (nearDuplicates.length > 20) break;
        }
      }
      if (nearDuplicates.length > 20) break;
    }
  }

  // Grouping-key overlap. When the caller supplied a specific group_key
  // (Wave 284), this is the exact key the splitter enforced; otherwise we
  // fall back to picking the first tag that looks like an id.
  const explicit_group_key = typeof opts.group_key === 'string' && opts.group_key ? opts.group_key : null;
  const trainGroups = new Set();
  for (const r of train) {
    const g = groupingKey(r, explicit_group_key);
    if (g) trainGroups.add(g);
  }
  const groupedOverlap = [];
  holdout.forEach((r, i) => {
    const g = groupingKey(r, explicit_group_key);
    if (g && trainGroups.has(g)) groupedOverlap.push({ holdout_index: i, grouping_key: g });
  });

  return {
    similarity_threshold: similarityThreshold,
    input_overlap_count: inputOverlap.length,
    output_overlap_count: outputOverlap.length,
    near_duplicate_count: nearDuplicates.length,
    grouped_overlap_count: groupedOverlap.length,
    samples: {
      input_overlap: inputOverlap.slice(0, 10),
      output_overlap: outputOverlap.slice(0, 10),
      near_duplicates: nearDuplicates.slice(0, 10),
      grouped_overlap: groupedOverlap.slice(0, 10),
    },
  };
}

// Decide which evaluation source label belongs in the manifest. Used to flag
// synthetic-starter seeds (the CC0 phi-redactor scaffold) vs real captured IO.
// Heuristic: a seeds.jsonl whose first non-comment line is one of the known
// public starter rows gets labeled synthetic_starter; everything else is
// tenant_captured.
export function classifyEvalSource(seedsPath, rows) {
  if (!rows || rows.length === 0) return 'empty';
  if (!seedsPath) return 'tenant_captured';
  try {
    const raw = fs.readFileSync(seedsPath, 'utf8');
    if (/synthetic, public domain, illustrative only/i.test(raw)) return 'synthetic_starter';
    if (/CC0/.test(raw) && /seed dataset/i.test(raw)) return 'synthetic_starter';
  } catch {}
  return 'tenant_captured';
}

// Convenience wrapper: load + split + leakage-report in one call. Used by
// spec-compile.js and the CLI compile path.
export function prepareSeedSplit({ seedsPath, split_seed, holdout_ratio, task, cwd, group_key } = {}) {
  const resolved = resolveSeedsPath({ explicitPath: seedsPath, task, cwd });
  if (!resolved) return null;
  const loaded = loadSeeds(resolved);
  if (loaded.rows.length === 0) {
    return {
      seeds_path: resolved,
      seeds_hash: hashSeeds([]),
      rows: [],
      train: [],
      holdout: [],
      split_seed: split_seed || DEFAULT_SPLIT_SEED,
      holdout_ratio: holdout_ratio || DEFAULT_HOLDOUT_RATIO,
      train_hash: hashSeeds([]),
      holdout_hash: hashSeeds([]),
      train_count: 0,
      holdout_count: 0,
      eval_source: 'empty',
      duplicates: [],
      leakage_report: null,
      leakage_report_hash: null,
      source_skipped: loaded.skipped,
      source_format_mix: { canonical: 0, legacy_prompt_completion: 0 },
      group_key: group_key || null,
    };
  }
  const sp = splitSeeds(loaded.rows, { split_seed, holdout_ratio, group_key });
  const train_hash = hashSeeds(sp.train);
  const holdout_hash = hashSeeds(sp.holdout);
  const duplicates = detectDuplicateInputs(loaded.rows);
  const report = leakageReport(sp.train, sp.holdout, { group_key });
  const leakage_report_hash = sha256(canonicalJson(report));
  const eval_source = classifyEvalSource(resolved, loaded.rows);

  const format_mix = { canonical: 0, legacy_prompt_completion: 0 };
  for (const r of loaded.rows) {
    const f = (r.metadata && r.metadata.source_format) || 'canonical';
    if (format_mix[f] != null) format_mix[f]++;
  }

  return {
    seeds_path: resolved,
    seeds_hash: hashSeeds(loaded.rows),
    rows: loaded.rows,
    train: sp.train,
    holdout: sp.holdout,
    split_seed: sp.split_seed,
    holdout_ratio: sp.holdout_ratio,
    train_hash,
    holdout_hash,
    train_count: sp.train.length,
    holdout_count: sp.holdout.length,
    eval_source,
    duplicates,
    leakage_report: report,
    leakage_report_hash,
    source_skipped: loaded.skipped,
    source_format_mix: format_mix,
    group_key: group_key || null,
  };
}

// Verifier-side rebuild. Given the manifest-recorded split_seed + the loaded
// rows, recompute split + hashes and compare. Returns { match, details }.
export function verifySplit({ rows, manifest_split_seed, manifest_train_hash, manifest_holdout_hash, holdout_ratio } = {}) {
  const sp = splitSeeds(rows, { split_seed: manifest_split_seed, holdout_ratio });
  const train_hash = hashSeeds(sp.train);
  const holdout_hash = hashSeeds(sp.holdout);
  const trainMatch = train_hash === manifest_train_hash;
  const holdoutMatch = holdout_hash === manifest_holdout_hash;
  return {
    match: trainMatch && holdoutMatch,
    train_match: trainMatch,
    holdout_match: holdoutMatch,
    recomputed_train_hash: train_hash,
    recomputed_holdout_hash: holdout_hash,
    train_count: sp.train.length,
    holdout_count: sp.holdout.length,
  };
}
