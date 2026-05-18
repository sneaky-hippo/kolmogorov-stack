// Wave 371 - Replay (builder layer, pillar 7/12).
//
// Public surface:
//   replayTrace(traceId, {against, opts})
//   replayNamespace(namespace, {against, limit, opts})
//   replayDataset(datasetId, {against, opts})
//   loadCapturesByTrace(traceId, {tenant})  (helper)
//
// W216 already exposes POST /v1/replay (router.js) for replaying a captured
// namespace against a registered cloud artifact. This module is the LOCAL
// orchestration variant: caller passes either an artifact file path OR a
// model name (routed via llm-call). The W216 route is untouched.
//
// `against` resolution rules:
//   - string ending in .kolm OR a file path that exists  -> artifact-runner
//   - string that matches `provider:model` or starts with `model:` -> llm-call
//   - otherwise treated as a model id passed to llm-call (KOLM_LLM_PROVIDER governs)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { runArtifact } from './artifact-runner.js';
import { callLLM, isConfigured, describeConfig } from './llm-call.js';

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function tokenize(s) {
  const norm = String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  return norm.split(/\s+/).filter(Boolean);
}
function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

function isArtifactRef(against) {
  if (!against || typeof against !== 'string') return false;
  if (against.endsWith('.kolm')) return true;
  try { return fs.existsSync(against) && fs.statSync(against).isFile(); } catch { return false; }
}

// Look up a capture row by trace_id across the local store. We accept either
// the durable W212 store (capture-store.js) or, when the store is empty (test
// or air-gapped), an inline {trace_id, input, output} object the caller can
// pass via opts.trace.
export async function loadCapturesByTrace(traceId, { tenant = null, opts = {} } = {}) {
  if (opts && opts.trace && typeof opts.trace === 'object') return [opts.trace];
  try {
    const cs = await import('./capture-store.js');
    const t = tenant || process.env.KOLM_DEFAULT_TENANT || 'default';
    // Walk all captures and match. The store doesn't expose a by-trace getter,
    // so we scan up to a generous cap. For 100K+ caches the caller should
    // pre-filter by namespace via replayNamespace().
    const rows = await cs.allCapturesForTenant(t, 50000);
    return rows.filter((r) => String(r.trace_id || r.id || '') === String(traceId));
  } catch {
    return [];
  }
}

async function executeAgainst(against, input, opts = {}) {
  const t0 = Date.now();
  if (isArtifactRef(against)) {
    try {
      const r = await runArtifact(against, input, { timeoutMs: opts.timeoutMs || 2000 });
      return {
        ok: true,
        output: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
        latency_us: r.latency_us || (Date.now() - t0) * 1000,
        cost_micro_usd: 0,
        engine: 'artifact',
        engine_id: path.basename(against),
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e), latency_us: (Date.now() - t0) * 1000, cost_micro_usd: 0, engine: 'artifact', engine_id: path.basename(against) };
    }
  }
  // Model path. We require llm-call to be configured OR opt-in stub mode
  // (opts.stubModel === true) for tests so we never silently hit /dev/null.
  if (opts.stubModel) {
    return {
      ok: true,
      output: `[stub:${against || 'unknown-model'}] echo: ${String(input).slice(0, 200)}`,
      latency_us: (Date.now() - t0) * 1000,
      cost_micro_usd: 1,
      engine: 'stub_model',
      engine_id: String(against || 'stub'),
    };
  }
  if (!isConfigured()) {
    return {
      ok: false,
      error: 'llm_not_configured: set KOLM_LLM_PROVIDER + KOLM_LLM_KEY, pass --against <artifact.kolm>, or set opts.stubModel=true',
      latency_us: (Date.now() - t0) * 1000,
      cost_micro_usd: 0,
      engine: 'model',
      engine_id: String(against || ''),
    };
  }
  try {
    const { text } = await callLLM({
      user: String(input),
      maxTokens: opts.maxTokens || 1024,
      temperature: opts.temperature || 0,
    });
    return {
      ok: true,
      output: text,
      latency_us: (Date.now() - t0) * 1000,
      cost_micro_usd: 0,
      engine: 'model',
      engine_id: String(against || describeConfig().model || ''),
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e), latency_us: (Date.now() - t0) * 1000, cost_micro_usd: 0, engine: 'model', engine_id: String(against || '') };
  }
}

function diffRow(original, replay) {
  const k = replay.ok ? jaccard(original.output || '', replay.output || '') : 0;
  return {
    original: { input_head: String(original.input || '').slice(0, 200), output_head: String(original.output || '').slice(0, 200), latency_us: original.latency_us || null, cost_usd: original.cost_usd || null },
    replay: { output_head: String(replay.output || '').slice(0, 200), ok: replay.ok, error: replay.error || null, latency_us: replay.latency_us, cost_micro_usd: replay.cost_micro_usd, engine: replay.engine, engine_id: replay.engine_id },
    diff_score: k,
    latency_delta_ms: Math.round((replay.latency_us - (original.latency_us || 0)) / 1000),
    cost_delta_usd: ((replay.cost_micro_usd || 0) - Math.round((original.cost_usd || 0) * 1e6)) / 1e6,
  };
}

export async function replayTrace(traceId, { against, opts = {} } = {}) {
  if (!against) throw new Error('replayTrace: --against required (artifact path or model id)');
  const captures = await loadCapturesByTrace(traceId, { tenant: opts.tenant, opts });
  if (captures.length === 0) {
    const err = new Error('trace_not_found: ' + traceId);
    err.code = 'TRACE_NOT_FOUND';
    throw err;
  }
  const original = captures[0];
  const inputForReplay = original.prompt || original.input || '';
  const replay = await executeAgainst(against, inputForReplay, opts);
  const original_envelope = {
    input: inputForReplay,
    output: original.response || original.output || '',
    latency_us: original.latency_us || null,
    cost_usd: original.cost_usd || null,
    trace_id: traceId,
  };
  return diffRow(original_envelope, replay);
}

export async function replayNamespace(namespace, { against, limit = 100, opts = {} } = {}) {
  if (!against) throw new Error('replayNamespace: --against required');
  if (!namespace) throw new Error('replayNamespace: namespace required');
  const cs = await import('./capture-store.js');
  const tenant = opts.tenant || process.env.KOLM_DEFAULT_TENANT || 'default';
  const rows = await cs.listCaptures(tenant, namespace, Math.max(1, Math.min(1000, Number(limit) || 100)));
  if (!rows.length) {
    return { namespace, against, count: 0, summary: { avg_diff_score: 0, replacement_rate: 0, avg_latency_ms: 0, cost_delta_usd: 0 }, diffs: [] };
  }
  const diffs = [];
  let kSum = 0;
  let kN = 0;
  let latencyDeltaUsTotal = 0;
  let costDeltaUsdTotal = 0;
  let replaced = 0;
  for (const row of rows) {
    const original = {
      input: row.prompt || row.input || '',
      output: row.response || row.output || '',
      latency_us: row.latency_us || null,
      cost_usd: row.cost_usd || null,
      trace_id: row.trace_id || row.id,
    };
    const replay = await executeAgainst(against, original.input, opts);
    const d = diffRow(original, replay);
    diffs.push({ trace_id: original.trace_id, ...d });
    if (replay.ok) { kSum += d.diff_score; kN += 1; }
    latencyDeltaUsTotal += (replay.latency_us - (original.latency_us || 0));
    costDeltaUsdTotal += d.cost_delta_usd;
    // "replacement" heuristic: diff_score >= 0.7 means the replay engine
    // produced an answer close enough to upstream that it could replace it.
    if (replay.ok && d.diff_score >= 0.7) replaced++;
  }
  return {
    namespace,
    against,
    count: rows.length,
    summary: {
      avg_diff_score: kN ? kSum / kN : 0,
      replacement_rate: rows.length ? replaced / rows.length : 0,
      avg_latency_delta_ms: Math.round(latencyDeltaUsTotal / rows.length / 1000),
      cost_delta_usd: costDeltaUsdTotal,
    },
    diffs,
  };
}

export async function replayDataset(datasetId, { against, opts = {}, holdoutOnly = true } = {}) {
  if (!against) throw new Error('replayDataset: --against required');
  if (!datasetId) throw new Error('replayDataset: datasetId required');
  let rows = [];
  // datasetId may be:
  //   - in-memory rows passed as opts.rows
  //   - file path to JSON / JSONL
  //   - a sim dataset id ds_sim_*  (lives under ~/.kolm/simulations/)
  if (Array.isArray(opts.rows) && opts.rows.length) {
    rows = opts.rows;
  } else if (typeof datasetId === 'string' && fs.existsSync(datasetId)) {
    const text = fs.readFileSync(datasetId, 'utf8');
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) {
      try { rows = JSON.parse(trimmed); } catch { rows = []; }
    } else if (trimmed.startsWith('{') && trimmed.indexOf('\n') === -1) {
      // Dataset envelope ({rows: [...]} or {holdout: [...]}) - single-line JSON.
      try {
        const j = JSON.parse(trimmed);
        if (holdoutOnly && Array.isArray(j.holdout) && j.holdout.length) rows = j.holdout;
        else if (Array.isArray(j.rows)) rows = j.rows;
      } catch { /* fall through to jsonl */ }
    }
    if (!rows.length) {
      // JSONL: one JSON per line. Tolerant - any line that parses to an object
      // with input/prompt is in.
      rows = trimmed.split(/\r?\n/).filter(Boolean).map((ln) => {
        try { return JSON.parse(ln); } catch { return null; }
      }).filter(Boolean);
    }
  } else if (typeof datasetId === 'string' && datasetId.startsWith('ds_')) {
    // Look in ~/.kolm/simulations/<id>.json (written by simulation.generateDatasetFromSim).
    const os = await import('node:os');
    const p = path.join(os.homedir(), '.kolm', 'simulations', datasetId + '.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (holdoutOnly && Array.isArray(j.holdout) && j.holdout.length) rows = j.holdout;
      else if (Array.isArray(j.rows)) rows = j.rows;
    }
  }
  if (!rows.length) {
    return { dataset_id: datasetId, against, count: 0, summary: { pass_rate: 0, replacement_rate: 0, latency_avg_ms: 0, cost_delta_usd: 0 }, failed_cases: [] };
  }
  let pass = 0;
  let fail = 0;
  let kSum = 0;
  let kN = 0;
  let latUsTotal = 0;
  let costUsdTotal = 0;
  let replaced = 0;
  const failed = [];
  for (const row of rows) {
    const original = {
      input: row.input || row.prompt || '',
      output: row.output || row.expected || '',
      latency_us: 0,
      cost_usd: 0,
    };
    const replay = await executeAgainst(against, original.input, opts);
    const d = diffRow(original, replay);
    latUsTotal += replay.latency_us;
    costUsdTotal += d.cost_delta_usd;
    if (replay.ok && d.diff_score >= 0.5) {
      pass++;
      kSum += d.diff_score;
      kN++;
      if (d.diff_score >= 0.7) replaced++;
    } else {
      fail++;
      failed.push({ input_head: String(original.input).slice(0, 200), expected_head: String(original.output).slice(0, 200), got_head: String(replay.output || '').slice(0, 200), error: replay.error || null, diff_score: d.diff_score });
    }
  }
  return {
    dataset_id: datasetId,
    against,
    count: rows.length,
    summary: {
      pass_rate: rows.length ? pass / rows.length : 0,
      avg_diff_score: kN ? kSum / kN : 0,
      replacement_rate: rows.length ? replaced / rows.length : 0,
      latency_avg_ms: rows.length ? Math.round(latUsTotal / rows.length / 1000) : 0,
      cost_delta_usd: costUsdTotal,
    },
    failed_cases: failed.slice(0, 100),
  };
}

export default {
  replayTrace,
  replayNamespace,
  replayDataset,
  loadCapturesByTrace,
};
