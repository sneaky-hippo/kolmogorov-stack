// together — Together AI managed LoRA fine-tune, end-to-end from JS.
//
// Real surface: upload corpus -> POST /fine-tunes -> poll -> download adapter.
// Auth via KOLM_TOGETHER_TOKEN (or TOGETHER_API_KEY). No python service needed.
//
// Pricing model (2026-05-15): Together quotes per-token. For a Qwen 2.5 7B QLoRA
// on 2,000 pairs of ~400 tokens each, expect $2-5 and ~30-45 minutes. The exact
// price ships on the fine-tune object after submit; we surface it in the receipt.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const API_BASE = 'https://api.together.xyz/v1';
const POLL_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h hard cap

function _token() {
  return process.env.KOLM_TOGETHER_TOKEN || process.env.TOGETHER_API_KEY || '';
}

function _ensureToken() {
  const tok = _token();
  if (!tok) {
    throw new Error(
      'together: KOLM_TOGETHER_TOKEN not set.\n' +
      '  get a key at https://api.together.xyz/settings/api-keys\n' +
      '  then: export KOLM_TOGETHER_TOKEN=...'
    );
  }
  return tok;
}

async function _fetch(url, init = {}) {
  const tok = _ensureToken();
  const headers = { ...(init.headers || {}), Authorization: `Bearer ${tok}` };
  const r = await fetch(url, { ...init, headers });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`together: ${init.method || 'GET'} ${url} -> ${r.status}: ${text.slice(0, 400)}`);
  }
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) return r.json();
  return r;
}

export async function detect() {
  if (!_token()) return { available: false, reason: 'KOLM_TOGETHER_TOKEN env var not set' };
  // Probe /models to confirm the key works without spending anything.
  try {
    await _fetch(`${API_BASE}/models?limit=1`);
    return {
      available: true,
      device: 'together-managed',
      endpoint: API_BASE,
    };
  } catch (err) {
    return { available: false, reason: String(err.message || err) };
  }
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

// Resolve spec -> training corpus. Accepts spec.seeds_path, spec.examples_path,
// or inline spec.evals.cases. Returns a list of {prompt, completion} pairs.
function _extractPairs(spec) {
  // Inline evals.cases shape: [{input, expected}, ...]
  if (spec.evals && Array.isArray(spec.evals.cases) && spec.evals.cases.length > 0) {
    return spec.evals.cases
      .map((c) => ({
        prompt: typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
        completion: typeof c.expected === 'string' ? c.expected : JSON.stringify(c.expected),
      }))
      .filter((p) => p.prompt && p.completion);
  }
  // External seeds JSONL: spec.seeds_path | spec.examples_path
  const seedsPath = spec.seeds_path || spec.examples_path;
  if (seedsPath && fs.existsSync(seedsPath)) {
    const lines = fs.readFileSync(seedsPath, 'utf-8').split(/\r?\n/).filter(Boolean);
    return lines
      .map((l) => {
        try {
          const row = JSON.parse(l);
          const prompt = row.prompt || row.input || '';
          const completion = row.completion || row.output || row.expected || '';
          return { prompt, completion };
        } catch { return null; }
      })
      .filter((p) => p && p.prompt && p.completion);
  }
  return [];
}

// Estimate cost up-front. Together prices vary by base model; this is a
// conservative quote based on 2026-05-15 list prices for 7B LoRA fine-tunes
// (~$0.50 per 1M tokens trained, 3 epochs, avg 400 tokens per pair).
export function estimateCost({ pairCount, baseModel, epochs = 3, avgTokensPerPair = 400 }) {
  // $0.50 per 1M tokens at 7B is the public rate; 14B is ~2x; 70B is ~10x.
  const sizeMultiplier = /70b|72b/i.test(baseModel || '') ? 10
    : /13b|14b|17b|20b|24b/i.test(baseModel || '') ? 2
    : 1;
  const tokens = pairCount * avgTokensPerPair * epochs;
  const cost = (tokens / 1_000_000) * 0.50 * sizeMultiplier;
  return {
    estimated_cost_usd: Math.max(0.50, Number(cost.toFixed(2))),
    estimated_duration_minutes: Math.max(15, Math.round((pairCount / 60) * sizeMultiplier)),
    basis: `${pairCount} pairs * ${avgTokensPerPair} tok * ${epochs} epochs @ size multiplier ${sizeMultiplier}`,
  };
}

// run(spec, opts) — the real path. Submits a fine-tune to Together and returns
// when the adapter is downloadable. Throws on auth/timeout/upstream errors.
//
// spec fields consumed:
//   spec.id                — used as suffix for the Together model name
//   spec.base_model        — e.g. "Qwen/Qwen2.5-7B-Instruct" (must be Together-hosted)
//   spec.target_size       — informational; e.g. "7b"
//   spec.evals.cases       — inline pairs
//   spec.seeds_path        — external JSONL path
//   spec.epochs            — default 3
//   spec.lora_r            — default 16
//   spec.lora_alpha        — default 32
export async function run(spec, { on_progress = null } = {}) {
  _ensureToken();
  const progress = (stage, pct) => { if (on_progress) on_progress({ stage, pct }); };

  progress('together:loading_corpus', 5);
  const pairs = _extractPairs(spec);
  if (pairs.length < 10) {
    throw new Error(`together: need ≥10 training pairs, got ${pairs.length}. Add seeds via 'kolm seeds new' or pass --seeds <jsonl>.`);
  }

  // Build the chat-format JSONL Together expects.
  const tmpDir = path.join(os.tmpdir(), 'kolm-together-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(tmpDir, { recursive: true });
  const jsonlPath = path.join(tmpDir, 'corpus.jsonl');
  const lines = pairs.map((p) => JSON.stringify({
    messages: [
      { role: 'user', content: p.prompt },
      { role: 'assistant', content: p.completion },
    ],
  }));
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');

  const baseModel = spec.base_model || 'Qwen/Qwen2.5-7B-Instruct';
  const epochs = Number(spec.epochs || 3);
  const loraR = Number(spec.lora_r || 16);
  const loraAlpha = Number(spec.lora_alpha || 32);
  const suffix = (spec.id || spec.name || 'kolm').replace(/[^a-z0-9-]/gi, '').slice(0, 32) || 'kolm';

  progress('together:uploading', 15);
  // Together's file upload uses multipart/form-data. The standard fetch API
  // FormData works fine in Node 20+.
  const fileBlob = new Blob([fs.readFileSync(jsonlPath)], { type: 'application/json' });
  const form = new FormData();
  form.append('file', fileBlob, 'corpus.jsonl');
  form.append('purpose', 'fine-tune');
  const up = await _fetch(`${API_BASE}/files`, { method: 'POST', body: form });
  const fileId = up.id;
  if (!fileId) throw new Error(`together: upload returned no file id: ${JSON.stringify(up)}`);

  progress('together:submitting', 25);
  const ftBody = {
    training_file: fileId,
    model: baseModel,
    n_epochs: epochs,
    lora: true,
    lora_r: loraR,
    lora_alpha: loraAlpha,
    suffix,
  };
  const ft = await _fetch(`${API_BASE}/fine-tunes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ftBody),
  });
  const jobId = ft.id;
  if (!jobId) throw new Error(`together: fine-tune submit returned no id: ${JSON.stringify(ft)}`);

  const startedAt = new Date().toISOString();
  progress('together:training', 40);
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  let ftData = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    ftData = await _fetch(`${API_BASE}/fine-tunes/${jobId}`);
    const status = ftData.status;
    if (status === 'completed') break;
    if (['failed', 'cancelled', 'error'].includes(status)) {
      throw new Error(`together: fine-tune ${status}: ${ftData.error || '(no error)'}`);
    }
    progress(`together:${status}`, 60);
  }
  if (!ftData || ftData.status !== 'completed') {
    throw new Error('together: fine-tune timed out before completion');
  }
  const finishedAt = new Date().toISOString();

  progress('together:downloading', 90);
  const outputName = ftData.output_name || ftData.model_output_name;
  if (!outputName) {
    throw new Error(`together: no output_name on completed fine-tune: ${JSON.stringify(ftData)}`);
  }
  const dl = await _fetch(`${API_BASE}/fine-tunes/${jobId}/download`);
  // dl may be Response (binary) or JSON pointer; handle both.
  let adapterBytes;
  if (dl && typeof dl.arrayBuffer === 'function') {
    adapterBytes = Buffer.from(await dl.arrayBuffer());
  } else if (dl && dl.url) {
    const r2 = await fetch(dl.url);
    adapterBytes = Buffer.from(await r2.arrayBuffer());
  } else {
    throw new Error(`together: download response shape unexpected: ${JSON.stringify(dl).slice(0, 200)}`);
  }
  const adapterPath = path.join(tmpDir, `${suffix}.together.tar.gz`);
  fs.writeFileSync(adapterPath, adapterBytes);
  const sha = 'sha256-' + crypto.createHash('sha256').update(adapterBytes).digest('hex');

  progress('together:complete', 100);
  return {
    metrics: {
      backend: 'together',
      base_model: baseModel,
      target_size: spec.target_size || 'unknown',
      pair_count: pairs.length,
      epochs,
      lora_r: loraR,
      lora_alpha: loraAlpha,
      together_model_output: outputName,
    },
    adapter: {
      url: `file://${adapterPath}`,
      sha256: sha,
      size_bytes: adapterBytes.length,
      format: 'together-lora',
    },
    compute: {
      backend: 'together',
      device: 'together-managed',
      cost_usd: ftData.total_price ?? null,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_seconds: Math.round((new Date(finishedAt) - new Date(startedAt)) / 1000),
      provenance: {
        together_job_id: jobId,
        together_file_id: fileId,
        together_model_output: outputName,
      },
    },
  };
}

export default { detect, test, run, estimateCost };
