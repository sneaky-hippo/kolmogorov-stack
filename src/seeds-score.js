// src/seeds-score.js
//
// Wave 358 — Seed quality scorer.
//
// score(rows, opts) -> {
//   uniqueness:    0..1   (1 - duplicate / near-duplicate rate)
//   coverage:      { domain, present:[], missing:[], total, ratio }
//   label_quality: 0..1   (rows where output != input AND output != '' AND
//                          output length is sane)
//   row_count:     N
//   recommendations: string[]
// }
//
// Domain auto-detect: if a meaningful fraction of outputs contain [PHI_*]
// tokens, the domain is 'phi-redactor' and coverage scans the 21 PHI classes
// from src/phi-redactor.js. Otherwise we use a generic top-token coverage
// model where missing == bucket of input-token bigrams seen < 2 times.

import { redact, CLASSES } from './phi-redactor.js';

const TOKEN_RE = /\[PHI_([A-Z]+)_\d+\]/g;

function toStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function bigrams(s) {
  const toks = String(s || '').toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i < toks.length - 1; i++) set.add(toks[i] + ' ' + toks[i + 1]);
  return set;
}

function jaccard(A, B) {
  if (A.size === 0 && B.size === 0) return 0;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function detectDomain(rows) {
  let phiHits = 0;
  let n = 0;
  for (const r of rows) {
    const out = toStr(r.expected !== undefined ? r.expected : r.output);
    if (!out) continue;
    n++;
    if (TOKEN_RE.test(out)) phiHits++;
    TOKEN_RE.lastIndex = 0;
  }
  if (n > 0 && phiHits / n >= 0.3) return 'phi-redactor';
  return 'generic';
}

function computeUniqueness(rows, threshold = 0.85) {
  const inputs = rows.map(r => toStr(r.input)).filter(Boolean);
  if (inputs.length === 0) return 1;
  // Exact duplicates first.
  const seen = new Set();
  let exact = 0;
  for (const s of inputs) {
    if (seen.has(s)) exact++;
    else seen.add(s);
  }
  // Near duplicates by bigram Jaccard. O(n^2) — fine for typical seed sizes.
  const bgs = inputs.map(bigrams);
  let near = 0;
  if (inputs.length <= 500) {
    for (let i = 0; i < inputs.length; i++) {
      for (let j = i + 1; j < inputs.length; j++) {
        if (jaccard(bgs[i], bgs[j]) >= threshold) { near++; break; }
      }
    }
  }
  const dupes = exact + near;
  return Math.max(0, 1 - dupes / inputs.length);
}

function computeCoverageForPhi(rows) {
  const present = new Set();
  for (const r of rows) {
    const out = toStr(r.expected !== undefined ? r.expected : r.output);
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(out)) !== null) {
      present.add(m[1]);
    }
    // Also detect from input via the redactor.
    try {
      const inp = toStr(r.input);
      const { map } = redact(inp);
      for (const tok of Object.keys(map)) {
        const cm = tok.match(/\[PHI_([A-Z]+)_\d+\]/);
        if (cm) present.add(cm[1]);
      }
    } catch {}
  }
  // Three "user-facing" coverage classes the demo mentions explicitly. Map
  // them to the underlying CLASSES so the report shows the friendlier name.
  const ALL = Array.from(new Set([...CLASSES, 'BIOMETRIC', 'FACE', 'ANY_UNIQUE_ID']));
  // BIOMETRIC + FACE flow into BIO; ANY_UNIQUE_ID flows into OTHER.
  const inferred = new Set(present);
  if (present.has('BIO')) {
    // Don't auto-claim BIOMETRIC/FACE just because BIO is hit — leave them
    // missing so the recommendation surfaces them as distinct gaps.
  }
  const missing = ALL.filter(c => !inferred.has(c));
  return {
    domain: 'phi-redactor',
    present: Array.from(inferred).sort(),
    missing,
    total: ALL.length,
    ratio: inferred.size / ALL.length,
  };
}

function computeCoverageGeneric(rows) {
  const counts = new Map();
  for (const r of rows) {
    const bg = bigrams(toStr(r.input));
    for (const b of bg) counts.set(b, (counts.get(b) || 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const present = ordered.slice(0, 50).map(([b]) => b);
  // "missing" in generic mode means under-represented bigrams (count==1).
  const missing = ordered.filter(([_, c]) => c === 1).slice(0, 20).map(([b]) => b);
  const total = ordered.length;
  return {
    domain: 'generic',
    present,
    missing,
    total,
    ratio: total === 0 ? 0 : Math.min(1, ordered.filter(([_, c]) => c >= 2).length / Math.max(20, total)),
  };
}

function computeLabelQuality(rows) {
  if (rows.length === 0) return 0;
  let good = 0;
  for (const r of rows) {
    const inp = toStr(r.input);
    const out = toStr(r.expected !== undefined ? r.expected : r.output);
    if (!out) continue;
    if (out === inp) continue;
    if (out.length < 1) continue;
    if (inp.length > 0 && out.length > 50 * inp.length) continue; // runaway
    good++;
  }
  return good / rows.length;
}

function recommendations(metrics) {
  const out = [];
  if (metrics.uniqueness < 0.7) {
    out.push(`uniqueness ${metrics.uniqueness.toFixed(2)} is low — dedupe near-duplicates before training`);
  } else if (metrics.uniqueness >= 0.85) {
    out.push(`uniqueness ${metrics.uniqueness.toFixed(2)} — good diversity`);
  }
  const c = metrics.coverage;
  if (c.domain === 'phi-redactor' && c.missing.length > 0) {
    out.push(`PHI classes hit ${c.present.length}/${c.total} (missing: ${c.missing.slice(0, 6).join(', ')}${c.missing.length > 6 ? '...' : ''}) — run kolm seeds augment --target-coverage to fill`);
  } else if (c.domain === 'generic' && c.missing.length > 5) {
    out.push(`${c.missing.length} bigrams seen only once — consider augmenting to balance`);
  }
  if (metrics.label_quality < 0.8) {
    out.push(`label_quality ${metrics.label_quality.toFixed(2)} — some outputs are empty / identical to input / unreasonably long`);
  } else {
    out.push(`label_quality ${metrics.label_quality.toFixed(2)} — good`);
  }
  if (metrics.row_count < 50) {
    out.push(`only ${metrics.row_count} rows — production K-score needs at least 50 (and 200+ for distill)`);
  }
  return out;
}

export function score(rows, opts = {}) {
  const arr = Array.isArray(rows) ? rows : [];
  const domain = opts.domain || detectDomain(arr);
  const uniqueness = computeUniqueness(arr, opts.similarity_threshold);
  const coverage = domain === 'phi-redactor' ? computeCoverageForPhi(arr) : computeCoverageGeneric(arr);
  const label_quality = computeLabelQuality(arr);
  const row_count = arr.length;
  const metrics = {
    uniqueness: Math.round(uniqueness * 1000) / 1000,
    coverage,
    label_quality: Math.round(label_quality * 1000) / 1000,
    row_count,
  };
  metrics.recommendations = recommendations(metrics);
  return metrics;
}
