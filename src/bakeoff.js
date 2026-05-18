// Wave 371 - Bakeoff (builder layer, pillar 8/12).
//
// Public surface:
//   bakeoff(datasetId, {contestants, opts})
//   bakeoffReport(bakeoffResult, opts)
//
// Compares contestants on the same holdout:
//   - cache       : artifact-runner's cache hit path (no LLM)
//   - rule        : synthesized regex/keyword rule (zero-shot LLM cost)
//   - prompt_only : cheapest LLM zero-shot
//   - <model id>  : routed via src/llm-call.js
//   - <artifact>  : routed via src/artifact-runner.js (path ends .kolm)
//
// Returns ranked array {name, pass_rate, avg_latency_ms, avg_cost_usd,
// score_per_dollar, recommended}. We pick `recommended` as the highest
// score_per_dollar (with a small bias toward >=90% pass rate so a 1% pass
// rate doesn't win on cost alone).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { callLLM, isConfigured, describeConfig } from './llm-call.js';
import { runArtifact } from './artifact-runner.js';

// Per-contestant cost estimates (USD per call). Conservative defaults; the
// caller can pass opts.costTable to override. These are intentionally rough -
// the goal is RANKING, not billing-grade accounting.
const DEFAULT_COST_TABLE = {
  cache: 0,
  rule: 0,
  prompt_only: 0.00005,
  'gemma-3n-e2b': 0.00002,
  'qwen-0.5b': 0.00002,
  'phi-mini': 0.00005,
  'claude-haiku-4-5': 0.0008,
  'gpt-4o-mini': 0.00015,
  'gpt-4o': 0.005,
  'claude-opus-4-7': 0.015,
};

// W384 hotfix: also named-exported so src/router.js can `import { DEFAULT_CONTESTANTS }`
// instead of going through the default export.
export const DEFAULT_CONTESTANTS = [
  'cache',
  'rule',
  'prompt_only',
  'gemma-3n-e2b',
  'qwen-0.5b',
  'phi-mini',
  'claude-haiku-4-5',
  'gpt-4o-mini',
];

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function tokenize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}
function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function loadDatasetRows(datasetId, opts) {
  if (Array.isArray(opts && opts.rows) && opts.rows.length) return opts.rows;
  if (Array.isArray(datasetId)) return datasetId;
  if (typeof datasetId === 'string' && fs.existsSync(datasetId)) {
    const text = fs.readFileSync(datasetId, 'utf8').trim();
    if (text.startsWith('[')) {
      try { return JSON.parse(text); } catch { /* fall through to jsonl */ }
    }
    if (text.startsWith('{') && text.indexOf('\n') === -1) {
      try {
        const j = JSON.parse(text);
        if (Array.isArray(j.holdout) && j.holdout.length) return j.holdout;
        if (Array.isArray(j.rows)) return j.rows;
      } catch { /* fall through to jsonl */ }
    }
    // JSONL: one JSON object per line.
    return text.split(/\r?\n/).filter(Boolean).map((ln) => {
      try { return JSON.parse(ln); } catch { return null; }
    }).filter(Boolean);
  }
  if (typeof datasetId === 'string' && datasetId.startsWith('ds_')) {
    const p = path.join(os.homedir(), '.kolm', 'simulations', datasetId + '.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(j.holdout) && j.holdout.length) return j.holdout;
      if (Array.isArray(j.rows)) return j.rows;
    }
  }
  return [];
}

// ---------------- per-contestant runners ----------------

// cache: a trivial in-process lookup over the dataset's own train half (when
// available) or just the expected output (echo). This represents "you had
// this exact answer cached" - so it's perfect-pass on exact-matched inputs
// and zero-pass on new ones. We approximate by passing iff the input appears
// in opts.cacheKeys (defaults to {} -- no cache hits).
async function runCache(rows, opts) {
  const cacheKeys = opts.cacheKeys || {};
  const out = [];
  for (const r of rows) {
    const hit = Object.prototype.hasOwnProperty.call(cacheKeys, r.input);
    const t0 = Date.now();
    out.push({
      input: r.input,
      expected: r.output,
      got: hit ? cacheKeys[r.input] : null,
      ok: hit,
      pass: hit ? (jaccard(cacheKeys[r.input], r.output) >= 0.7) : false,
      latency_us: Math.max(1, (Date.now() - t0) * 1000),
      cost_usd: 0,
    });
  }
  return out;
}

// rule: build a tiny keyword rule by extracting frequent target tokens from
// the first 30 dataset rows. If a row's expected output starts with one of
// those tokens, our rule returns it for any input containing the same token
// in the input. Intentionally crude; this is the "would a regex have worked?"
// baseline.
function synthesizeKeywordRule(rows) {
  const labelCounts = new Map();
  for (const r of rows.slice(0, 30)) {
    const lbl = String(r.output || '').toLowerCase().trim().split(/[\s,;]/)[0];
    if (!lbl) continue;
    labelCounts.set(lbl, (labelCounts.get(lbl) || 0) + 1);
  }
  const ranked = [...labelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);
  // Map a label -> a representative output (first row that uses it).
  const labelOut = new Map();
  for (const r of rows) {
    const lbl = String(r.output || '').toLowerCase().trim().split(/[\s,;]/)[0];
    if (lbl && ranked.includes(lbl) && !labelOut.has(lbl)) labelOut.set(lbl, r.output);
  }
  return (input) => {
    const lower = String(input || '').toLowerCase();
    for (const lbl of ranked) {
      if (lower.includes(lbl)) return labelOut.get(lbl) || lbl;
    }
    return null;
  };
}

async function runRule(rows, opts) {
  const rule = synthesizeKeywordRule(rows);
  const out = [];
  for (const r of rows) {
    const t0 = Date.now();
    const got = rule(r.input);
    out.push({
      input: r.input,
      expected: r.output,
      got,
      ok: got != null,
      pass: got != null && jaccard(got, r.output) >= 0.5,
      latency_us: Math.max(1, (Date.now() - t0) * 1000),
      cost_usd: 0,
    });
  }
  return out;
}

async function runArtifactContestant(rows, artifactPath, opts) {
  const out = [];
  for (const r of rows) {
    const t0 = Date.now();
    try {
      const ar = await runArtifact(artifactPath, r.input, { timeoutMs: 2000 });
      const got = typeof ar.output === 'string' ? ar.output : JSON.stringify(ar.output);
      out.push({
        input: r.input,
        expected: r.output,
        got,
        ok: true,
        pass: jaccard(got, r.output) >= 0.5,
        latency_us: ar.latency_us || (Date.now() - t0) * 1000,
        cost_usd: 0,
      });
    } catch (e) {
      out.push({ input: r.input, expected: r.output, got: null, ok: false, pass: false, error: String(e.message || e), latency_us: (Date.now() - t0) * 1000, cost_usd: 0 });
    }
  }
  return out;
}

async function runModelContestant(rows, modelName, opts) {
  // We require llm-call to be configured OR opt-in stub mode (opts.stubModel
  // === true) for tests. Stub mode echoes a deterministic answer so the
  // bakeoff can rank pass-rates without network. Real callers MUST set
  // KOLM_LLM_PROVIDER + KOLM_LLM_KEY for the per-model branch to be sound.
  const out = [];
  const costPer = (opts.costTable || DEFAULT_COST_TABLE)[modelName] ?? DEFAULT_COST_TABLE.prompt_only;
  for (const r of rows) {
    const t0 = Date.now();
    if (opts.stubModel) {
      // Deterministic stub: jaccard-match expected with quality scaling per model.
      // smaller models -> noisier outputs.
      const qualityByModel = {
        prompt_only: 0.55,
        'gemma-3n-e2b': 0.6,
        'qwen-0.5b': 0.62,
        'phi-mini': 0.7,
        'claude-haiku-4-5': 0.92,
        'gpt-4o-mini': 0.85,
        'gpt-4o': 0.95,
        'claude-opus-4-7': 0.97,
      };
      const q = qualityByModel[modelName] ?? 0.5;
      const stable = (sha(modelName + ':' + r.input).charCodeAt(0) % 100) / 100;
      const pass = stable < q;
      out.push({
        input: r.input,
        expected: r.output,
        got: pass ? r.output : '[stub mismatch]',
        ok: true,
        pass,
        latency_us: 1000 * (10 + (sha(modelName).charCodeAt(0) % 50)),
        cost_usd: costPer,
      });
      continue;
    }
    if (!isConfigured()) {
      out.push({ input: r.input, expected: r.output, got: null, ok: false, pass: false, error: 'llm_not_configured', latency_us: (Date.now() - t0) * 1000, cost_usd: 0 });
      continue;
    }
    try {
      const { text } = await callLLM({ user: String(r.input), maxTokens: 256, temperature: 0 });
      const got = String(text || '');
      out.push({ input: r.input, expected: r.output, got, ok: true, pass: jaccard(got, r.output) >= 0.5, latency_us: (Date.now() - t0) * 1000, cost_usd: costPer });
    } catch (e) {
      out.push({ input: r.input, expected: r.output, got: null, ok: false, pass: false, error: String(e.message || e), latency_us: (Date.now() - t0) * 1000, cost_usd: 0 });
    }
  }
  return out;
}

async function runContestant(name, rows, opts) {
  if (name === 'cache') return runCache(rows, opts);
  if (name === 'rule') return runRule(rows, opts);
  if (name.endsWith('.kolm') || (fs.existsSync && fs.existsSync(name))) {
    return runArtifactContestant(rows, name, opts);
  }
  return runModelContestant(rows, name, opts);
}

function summarize(name, calls) {
  if (!calls.length) return { name, pass_rate: 0, avg_latency_ms: 0, avg_cost_usd: 0, calls: 0, score_per_dollar: 0 };
  const pass = calls.filter((c) => c.pass).length;
  const passRate = pass / calls.length;
  const avgLatencyMs = calls.reduce((s, c) => s + (c.latency_us || 0), 0) / calls.length / 1000;
  const avgCostUsd = calls.reduce((s, c) => s + (c.cost_usd || 0), 0) / calls.length;
  // score_per_dollar: pass per dollar. Floor cost at $1e-6 so zero-cost
  // contestants don't blow up to Infinity.
  const score_per_dollar = passRate / Math.max(avgCostUsd, 1e-6);
  return {
    name,
    pass_rate: passRate,
    avg_latency_ms: Math.round(avgLatencyMs * 10) / 10,
    avg_cost_usd: avgCostUsd,
    score_per_dollar,
    calls: calls.length,
  };
}

export async function bakeoff(datasetId, { contestants, opts = {} } = {}) {
  const rows = loadDatasetRows(datasetId, opts);
  if (!rows.length) throw new Error('bakeoff: dataset empty (passed: ' + (typeof datasetId === 'string' ? datasetId.slice(0, 80) : '<rows>') + ')');
  const list = (contestants && contestants.length ? contestants : DEFAULT_CONTESTANTS);
  const results = [];
  for (const name of list) {
    const t0 = Date.now();
    let calls = [];
    let error = null;
    try {
      calls = await runContestant(name, rows, opts);
    } catch (e) {
      error = String(e.message || e);
    }
    const summary = summarize(name, calls);
    summary.error = error;
    summary.elapsed_ms = Date.now() - t0;
    results.push(summary);
  }
  // Recommended: best score_per_dollar AMONG contestants with pass_rate >= 0.85.
  // If none clear 0.85, pick the highest pass_rate.
  const eligible = results.filter((r) => r.pass_rate >= 0.85);
  let recommended = null;
  if (eligible.length) recommended = eligible.reduce((a, b) => (a.score_per_dollar >= b.score_per_dollar ? a : b)).name;
  else if (results.length) recommended = results.reduce((a, b) => (a.pass_rate >= b.pass_rate ? a : b)).name;
  for (const r of results) r.recommended = (r.name === recommended);
  // Sort: pass_rate desc, then score_per_dollar desc.
  results.sort((a, b) => (b.pass_rate - a.pass_rate) || (b.score_per_dollar - a.score_per_dollar));
  return {
    dataset_id: typeof datasetId === 'string' ? datasetId : 'inline',
    rows_used: rows.length,
    contestants: results,
    recommended,
  };
}

export function bakeoffReport(result, opts = {}) {
  if (!result || !Array.isArray(result.contestants)) return 'no bakeoff result';
  const lines = [];
  lines.push('Bakeoff result (' + result.rows_used + ' rows)');
  lines.push('');
  lines.push('contestant            pass    latency    $/call         score/$         rec');
  lines.push('-----------          ----    -------    ----------     ------------    ---');
  for (const c of result.contestants) {
    const name = c.name.padEnd(20);
    const pass = (Math.round(c.pass_rate * 1000) / 10).toString().padStart(5) + '%';
    const lat = (c.avg_latency_ms.toFixed(1) + 'ms').padStart(8);
    const cost = ('$' + c.avg_cost_usd.toFixed(6)).padStart(12);
    const sd = Number.isFinite(c.score_per_dollar) ? c.score_per_dollar.toFixed(0).padStart(12) : '       n/a';
    const rec = c.recommended ? '   YES' : '';
    lines.push(name + '  ' + pass + '   ' + lat + '   ' + cost + '   ' + sd + '   ' + rec);
  }
  lines.push('');
  if (result.recommended) {
    lines.push('Recommended: ' + result.recommended + ' (best score per dollar among contestants >= 85% pass).');
  } else {
    lines.push('No recommendation: no contestant cleared the 85% pass-rate gate.');
  }
  return lines.join('\n');
}

export default { bakeoff, bakeoffReport, DEFAULT_CONTESTANTS };
