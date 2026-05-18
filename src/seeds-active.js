// src/seeds-active.js
//
// Wave 356 — Active learning sampler.
//
// Runs a compiled .kolm artifact against an unlabeled pool and returns the N
// rows where the artifact is LEAST CONFIDENT — those are the rows whose
// labels add the most signal when filled in by a human.
//
// API:
//   activeSampling(artifactPath, poolPath, opts) -> Promise<Row[]>
//
// Output rows have shape:
//   {
//     input,                       // raw pool row's input
//     predicted,                   // what the artifact said
//     uncertainty_score,           // 0..1, higher = more uncertain
//     expected: null,              // placeholder for human to fill in
//     source: 'active:<artifact_basename>'
//   }
//
// Confidence model: many artifact recipes return either a raw string
// (a redaction / extraction) or a structured object. We score uncertainty as
// follows:
//   - object with `confidence` field present (0..1)         -> 1 - confidence
//   - object with `top_classes` array of {label, score}     -> 1 - max(score)
//                                                              or entropy if
//                                                              opts.scoring='entropy'
//   - string output: uncertainty = unstable-ness across N=3 perturbed runs
//     (whitespace, casing). Recipes that always return same answer => 0,
//     recipes that flip => closer to 1.
//   - errored / no-recipe-handled rows                       -> 1.0

import fs from 'node:fs/promises';
import path from 'node:path';

function readPool(text) {
  // Accept either JSON array of {input,...} or JSONL.
  const t = String(text).trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr;
    } catch {}
  }
  const out = [];
  for (const ln of t.split(/\r?\n/)) {
    const s = ln.trim();
    if (!s || s.startsWith('//')) continue;
    try { out.push(JSON.parse(s)); } catch {}
  }
  return out;
}

function entropy(scores) {
  // Renormalize scores into a probability distribution.
  const positives = scores.filter(s => s > 0);
  if (positives.length === 0) return 0;
  const total = positives.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const s of positives) {
    const p = s / total;
    h -= p * Math.log2(p);
  }
  const norm = Math.log2(positives.length || 2);
  return norm > 0 ? h / norm : 0;
}

function scoreFromObject(out, scoring) {
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    if (typeof out.confidence === 'number') {
      return Math.max(0, Math.min(1, 1 - out.confidence));
    }
    if (Array.isArray(out.top_classes) && out.top_classes.length) {
      const ss = out.top_classes
        .map(c => typeof c.score === 'number' ? c.score : (typeof c.probability === 'number' ? c.probability : 0));
      if (scoring === 'entropy') return entropy(ss);
      const max = ss.reduce((a, b) => Math.max(a, b), 0);
      return Math.max(0, Math.min(1, 1 - max));
    }
    if (Array.isArray(out.scores) && out.scores.length) {
      if (scoring === 'entropy') return entropy(out.scores);
      const max = out.scores.reduce((a, b) => Math.max(a, b), 0);
      return Math.max(0, Math.min(1, 1 - max));
    }
    if (Array.isArray(out.findings)) {
      // Redactor-style output: more findings + lower per-finding severity
      // means less certain. Uncertainty grows as count drifts from extremes.
      const n = out.findings.length;
      if (n === 0) return 0.2;
      const lowSev = out.findings.filter(f => f && f.severity === 'low').length;
      const ratio = lowSev / n;
      return Math.max(0, Math.min(1, ratio * 0.6 + 0.2));
    }
  }
  return null;
}

// Best-effort perturbation: change casing of first non-trivial alpha word,
// add+strip trailing whitespace.
function perturbations(input) {
  const variants = [];
  const s = typeof input === 'string' ? input : JSON.stringify(input);
  variants.push(s + ' ');
  variants.push(s.toLowerCase());
  variants.push(s.toUpperCase());
  // Insert benign whitespace.
  variants.push(s.replace(/\s+/g, '  '));
  return variants;
}

export async function activeSampling(artifactPath, poolPath, opts = {}) {
  const n = Number.isFinite(opts.n) ? Number(opts.n) : 20;
  const scoring = opts.scoring || 'max'; // 'max' | 'entropy'
  const artAbs = path.resolve(artifactPath);
  const poolAbs = path.resolve(poolPath);
  const runner = await import('./artifact-runner.js');
  const text = await fs.readFile(poolAbs, 'utf8');
  const pool = readPool(text);
  if (pool.length === 0) return [];

  const scored = [];
  for (const item of pool) {
    if (!item || (item.input == null && typeof item !== 'string')) continue;
    const input = typeof item === 'string' ? item : item.input;
    let predicted = null;
    let score = null;
    try {
      const res = await runner.runArtifact(artAbs, input, { timeoutMs: opts.timeoutMs || 1500 });
      predicted = res && res.output;
      score = scoreFromObject(predicted, scoring);
      if (score == null) {
        // String output. Estimate uncertainty by checking if perturbed inputs
        // produce the same output.
        const baseStr = typeof predicted === 'string' ? predicted : JSON.stringify(predicted);
        let agree = 0;
        const variants = perturbations(input).slice(0, 3);
        for (const v of variants) {
          try {
            const r2 = await runner.runArtifact(artAbs, v, { timeoutMs: opts.timeoutMs || 1500 });
            const otherStr = typeof r2.output === 'string' ? r2.output : JSON.stringify(r2.output);
            if (otherStr === baseStr) agree++;
          } catch {
            // perturbation errored — adds to uncertainty
          }
        }
        score = 1 - (agree / variants.length);
      }
    } catch (e) {
      score = 1.0;
      predicted = { error: String(e && e.message || e) };
    }
    scored.push({
      input,
      predicted,
      uncertainty_score: Math.round(score * 1000) / 1000,
      expected: null,
      source: `active:${path.basename(artAbs)}`,
    });
  }

  scored.sort((a, b) => b.uncertainty_score - a.uncertainty_score);
  return scored.slice(0, n);
}
