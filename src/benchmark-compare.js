// src/benchmark-compare.js
//
// Wave W — Head-to-head benchmark: compiled kolm artifact vs. LLM (remote API
// or local inference).
//
// The product thesis the user named: "we know for a fact that we have
// something that is faster and provides a better system than simply calling
// an LLM or running it locally." This module is the measurement that
// answers that — honestly. If a path can't be measured (no API key, no
// local inference server), it reports "skipped — <reason>", not a faked
// number.
//
// The three paths measured for each task input:
//
//   1. kolm-js          The current artifact runtime. Recipes execute in a
//                       Node vm sandbox. Always available.
//   2. kolm-native      The Wave G native binary, when bundled. The runner
//                       invokes the bin with the input as argv[1] and reads
//                       stdout. Skipped when no native binary is bundled
//                       (toolchain absent at build time).
//   3. llm-api          Remote LLM API call. Default vendor is Anthropic
//                       (because the SDK is already a dep). Requires
//                       ANTHROPIC_API_KEY to be set; otherwise skipped.
//   4. local-llm        Local inference server. Default endpoint is
//                       ollama at http://127.0.0.1:11434. Probed once at
//                       harness start; skipped if not reachable.
//
// For each path we record per-call latency_us, then summarize n, min, p50,
// p95, p99, max. We also record correctness when the case carries an
// `expected` field — for LLM paths we use a loose-equality comparator
// because models add chatter; for kolm paths we use exact match.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadArtifact, runArtifact } from './artifact-runner.js';

const NANOS_PER_USEC = 1000n;

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------
export async function compareArtifact(artifactPath, opts = {}) {
  const runs = positiveInt(opts.runs, 5);
  const bundle = loadArtifact(artifactPath);
  const cases = collectCases(bundle, { input: opts.input, cases: opts.cases });
  if (cases.length === 0) {
    throw new Error('compareArtifact: artifact has no eval cases and no opts.input/cases was provided');
  }

  // LLM paths are cost-bounded — running 1000 cases × 5 runs against
  // claude-haiku is $$. Default to first 20 cases for the API path so the
  // head-to-head latency comparison still has signal but we don't burn the
  // user's credits. Override with opts.llmSampleN (or --llm-sample on the CLI).
  const llmSampleN = positiveInt(opts.llmSampleN, Math.min(20, cases.length));
  const llmCases = cases.slice(0, llmSampleN);

  const started_at = new Date().toISOString();
  const probe = await probeAvailability({
    llmApi: opts.llmApi !== false,
    localLlm: opts.localLlm !== false,
    nativeBin: opts.nativeBin !== false,
    bundle,
  });

  const results = {
    'kolm-js': await measureKolmJs(artifactPath, cases, runs),
    'kolm-native': probe.nativeBin.available
      ? await measureKolmNative(artifactPath, bundle, probe.nativeBin, cases, runs)
      : { skipped: true, reason: probe.nativeBin.reason },
    'llm-api': probe.llmApi.available
      ? await measureLlmApi(probe.llmApi, bundle, llmCases, runs, opts)
      : { skipped: true, reason: probe.llmApi.reason },
    'local-llm': probe.localLlm.available
      ? await measureLocalLlm(probe.localLlm, bundle, llmCases, runs, opts)
      : { skipped: true, reason: probe.localLlm.reason },
  };

  const report = {
    spec: 'kolm-benchmark-compare-1',
    started_at,
    finished_at: new Date().toISOString(),
    artifact: artifactPath,
    artifact_sha256: sha256File(artifactPath),
    task: bundle.manifest.task,
    cases: cases.length,
    llm_sample_n: llmSampleN,
    runs_per_case: runs,
    host: { platform: process.platform, arch: process.arch, node: process.version, hostname: os.hostname() },
    paths: results,
    head_to_head: headToHead(results),
  };

  if (opts.outPath) {
    fs.writeFileSync(opts.outPath, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

// Read a JSONL corpus (one JSON object per line). Accepts canonical
// {input, output} (the Wave J / seeds.jsonl shape) or legacy
// {prompt, completion}. Normalizes to {id, input, expected, params}.
// Skips malformed lines silently so a one-line typo doesn't kill a 1000-row
// run — but logs the count on stderr so the operator notices.
export function readCorpusJsonl(corpusPath) {
  const raw = fs.readFileSync(corpusPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const out = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    let row;
    try { row = JSON.parse(lines[i]); }
    catch { skipped++; continue; }
    if (!row || typeof row !== 'object') { skipped++; continue; }
    const input = row.input !== undefined ? row.input
                : row.prompt !== undefined ? row.prompt
                : undefined;
    const expected = row.expected !== undefined ? row.expected
                   : row.output !== undefined ? row.output
                   : row.completion !== undefined ? row.completion
                   : undefined;
    if (input === undefined) { skipped++; continue; }
    out.push({ id: row.id || `corpus-${i + 1}`, input, expected, params: row.params });
  }
  if (skipped > 0) {
    process.stderr.write(`[readCorpusJsonl] skipped ${skipped} malformed lines\n`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path 1 — kolm-js (the current artifact runtime).
// ---------------------------------------------------------------------------
async function measureKolmJs(artifactPath, cases, runs) {
  const latencies = [];
  const correct = { graded: 0, passed: 0, failures: [] };
  for (const c of cases) {
    for (let i = 0; i < runs; i++) {
      const t0 = process.hrtime.bigint();
      try {
        const result = await runArtifact(artifactPath, c.input, { params: c.params });
        const t1 = process.hrtime.bigint();
        latencies.push(Number((t1 - t0) / NANOS_PER_USEC));
        if (c.expected !== undefined) {
          correct.graded++;
          if (deepEqual(result.output, c.expected)) correct.passed++;
          else if (correct.failures.length < 5) {
            correct.failures.push({ id: c.id, expected: c.expected, got: result.output });
          }
        }
      } catch (e) {
        if (c.expected !== undefined) correct.graded++;
        if (correct.failures.length < 5) correct.failures.push({ id: c.id, error: String(e.message || e) });
      }
    }
  }
  return {
    skipped: false,
    notes: 'kolm artifact run via the Node vm sandbox; no external calls',
    latency_us: summarizeLatency(latencies),
    correctness: {
      graded: correct.graded,
      passed: correct.passed,
      accuracy: correct.graded ? round(correct.passed / correct.graded, 4) : null,
      failures: correct.failures,
    },
    cost: {
      model: '$/call=0 (in-process, no network, no metering)',
      per_call_usd: 0,
      per_million_calls_usd: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Path 2 — kolm-native (Wave G bundled native binary).
// ---------------------------------------------------------------------------
async function measureKolmNative(artifactPath, bundle, probe, cases, runs) {
  const { binPath, recipe_id, kind } = probe;
  const latencies = [];
  const correct = { graded: 0, passed: 0, failures: [] };
  for (const c of cases) {
    for (let i = 0; i < runs; i++) {
      const inputStr = typeof c.input === 'string' ? c.input : JSON.stringify(c.input);
      const t0 = process.hrtime.bigint();
      const proc = spawnSync(binPath, [inputStr], { encoding: 'utf8', timeout: 10000 });
      const t1 = process.hrtime.bigint();
      latencies.push(Number((t1 - t0) / NANOS_PER_USEC));
      const out = (proc.stdout || '').trim();
      if (c.expected !== undefined) {
        correct.graded++;
        let parsed;
        try { parsed = JSON.parse(out); } catch { parsed = out; }
        if (deepEqual(parsed, c.expected)) correct.passed++;
        else if (correct.failures.length < 5) {
          correct.failures.push({ id: c.id, expected: c.expected, got: parsed });
        }
      }
    }
  }
  return {
    skipped: false,
    notes: `native binary invoked via spawnSync (${kind} target, recipe ${recipe_id})`,
    bin_path: binPath,
    latency_us: summarizeLatency(latencies),
    correctness: {
      graded: correct.graded,
      passed: correct.passed,
      accuracy: correct.graded ? round(correct.passed / correct.graded, 4) : null,
      failures: correct.failures,
    },
    cost: {
      model: '$/call=0 (process spawn + native exec, no network, no metering)',
      per_call_usd: 0,
      per_million_calls_usd: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Path 3 — llm-api (Anthropic by default).
//
// Honest measurement: we make REAL API calls. If ANTHROPIC_API_KEY is
// missing, the path is skipped — never simulated. Token cost is reported
// using the response's `usage` block multiplied by the public per-token
// rate for the model in question.
// ---------------------------------------------------------------------------
async function measureLlmApi(probe, bundle, cases, runs, opts) {
  const { client, model, rate } = probe;
  const systemPrompt = opts.llmSystemPrompt || buildSystemPromptFromBundle(bundle);
  const latencies = [];
  const tokensIn = [];
  const tokensOut = [];
  const correct = { graded: 0, passed: 0, failures: [] };
  for (const c of cases) {
    for (let i = 0; i < runs; i++) {
      const userText = typeof c.input === 'string' ? c.input : JSON.stringify(c.input);
      const t0 = process.hrtime.bigint();
      let resp;
      try {
        resp = await client.messages.create({
          model,
          max_tokens: 256,
          system: systemPrompt,
          messages: [{ role: 'user', content: userText }],
        });
      } catch (e) {
        if (c.expected !== undefined) correct.graded++;
        if (correct.failures.length < 5) correct.failures.push({ id: c.id, error: String(e.message || e) });
        continue;
      }
      const t1 = process.hrtime.bigint();
      latencies.push(Number((t1 - t0) / NANOS_PER_USEC));
      if (resp.usage) {
        if (typeof resp.usage.input_tokens === 'number') tokensIn.push(resp.usage.input_tokens);
        if (typeof resp.usage.output_tokens === 'number') tokensOut.push(resp.usage.output_tokens);
      }
      const text = (resp.content || []).map(b => b.text || '').join('').trim();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      if (c.expected !== undefined) {
        correct.graded++;
        if (looseMatch(parsed, c.expected)) correct.passed++;
        else if (correct.failures.length < 5) correct.failures.push({ id: c.id, expected: c.expected, got: parsed });
      }
    }
  }
  const avgIn = average(tokensIn);
  const avgOut = average(tokensOut);
  const per_call_usd = avgIn != null && avgOut != null
    ? round(avgIn * rate.input_per_million / 1e6 + avgOut * rate.output_per_million / 1e6, 6)
    : null;
  return {
    skipped: false,
    notes: `real API calls to ${model}; latency includes network + queue + inference`,
    vendor: 'anthropic',
    model,
    rate_card: rate,
    latency_us: summarizeLatency(latencies),
    tokens: { avg_input: avgIn, avg_output: avgOut },
    correctness: {
      graded: correct.graded,
      passed: correct.passed,
      accuracy: correct.graded ? round(correct.passed / correct.graded, 4) : null,
      comparator: 'loose-match (LLM outputs accepted if expected fields are substring-equal)',
      failures: correct.failures,
    },
    cost: {
      per_call_usd,
      per_million_calls_usd: per_call_usd != null ? round(per_call_usd * 1e6, 2) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Path 4 — local-llm (ollama by default).
//
// Real call to the local inference server. Probed at start so we don't
// flood logs on a host without it.
// ---------------------------------------------------------------------------
async function measureLocalLlm(probe, bundle, cases, runs, opts) {
  const { endpoint, model } = probe;
  const systemPrompt = opts.llmSystemPrompt || buildSystemPromptFromBundle(bundle);
  const latencies = [];
  const correct = { graded: 0, passed: 0, failures: [] };
  for (const c of cases) {
    for (let i = 0; i < runs; i++) {
      const userText = typeof c.input === 'string' ? c.input : JSON.stringify(c.input);
      const body = {
        model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
      };
      const t0 = process.hrtime.bigint();
      let resp;
      try {
        const r = await fetch(`${endpoint}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        resp = await r.json();
      } catch (e) {
        if (c.expected !== undefined) correct.graded++;
        if (correct.failures.length < 5) correct.failures.push({ id: c.id, error: String(e.message || e) });
        continue;
      }
      const t1 = process.hrtime.bigint();
      latencies.push(Number((t1 - t0) / NANOS_PER_USEC));
      const text = (resp.message?.content || '').trim();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      if (c.expected !== undefined) {
        correct.graded++;
        if (looseMatch(parsed, c.expected)) correct.passed++;
        else if (correct.failures.length < 5) correct.failures.push({ id: c.id, expected: c.expected, got: parsed });
      }
    }
  }
  return {
    skipped: false,
    notes: `real local-inference calls to ${endpoint} (ollama protocol)`,
    endpoint,
    model,
    latency_us: summarizeLatency(latencies),
    correctness: {
      graded: correct.graded,
      passed: correct.passed,
      accuracy: correct.graded ? round(correct.passed / correct.graded, 4) : null,
      comparator: 'loose-match',
      failures: correct.failures,
    },
    cost: {
      model: '$/call=0 at the API layer; hardware + energy cost not counted',
      per_call_usd: 0,
      per_million_calls_usd: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Availability probes — done once, up front, so we know which paths to run.
// ---------------------------------------------------------------------------
async function probeAvailability({ llmApi, localLlm, nativeBin, bundle }) {
  const probe = {
    llmApi: { available: false, reason: 'not requested' },
    localLlm: { available: false, reason: 'not requested' },
    nativeBin: { available: false, reason: 'not requested' },
  };

  if (nativeBin) probe.nativeBin = await probeNativeBin(bundle);
  if (llmApi) probe.llmApi = await probeLlmApi();
  if (localLlm) probe.localLlm = await probeLocalLlm();

  return probe;
}

async function probeNativeBin(bundle) {
  const ct = bundle.manifest.compiled_targets;
  if (!ct || !ct.recipes) return { available: false, reason: 'artifact has no compiled_targets block (Wave F+ artifact required)' };
  // Find the first recipe with a compiled binary claim.
  for (const rid of Object.keys(ct.recipes)) {
    const rec = ct.recipes[rid];
    for (const kind of ['c', 'rust']) {
      if (rec[kind]?.bin?.bin_filename) {
        // Extract the binary to a temp file so we can spawn it.
        const AdmZip = (await import('adm-zip')).default;
        const zip = new AdmZip(bundle.artifact_path);
        const entry = zip.getEntries().find(e => e.entryName === rec[kind].bin.bin_filename);
        if (!entry) continue;
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-native-'));
        const binPath = path.join(tmpDir, path.basename(rec[kind].bin.bin_filename));
        fs.writeFileSync(binPath, entry.getData());
        try { fs.chmodSync(binPath, 0o755); } catch {}
        return { available: true, binPath, recipe_id: rid, kind, bin_hash: rec[kind].bin.bin_hash };
      }
    }
  }
  return { available: false, reason: 'compiled_targets present but no .bin sub-block (build without KOLM_COMPILE_NATIVE=1 or toolchain absent at build)' };
}

async function probeLlmApi() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { available: false, reason: 'ANTHROPIC_API_KEY not set (set the env var to measure this path)' };
  }
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch (e) {
    return { available: false, reason: `@anthropic-ai/sdk not installable: ${e.message}` };
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  // Default to Haiku (cheap, fast) for fairness — kolm's pitch is that it
  // beats even the cheapest LLM on simple narrow tasks. Override with
  // KOLM_BENCH_LLM_MODEL.
  const model = process.env.KOLM_BENCH_LLM_MODEL || 'claude-haiku-4-5';
  // Public rate cards (USD per 1M tokens) as of 2026-05; user can override.
  const rate = pickRate(model);
  return { available: true, client, model, rate };
}

function pickRate(model) {
  if (process.env.KOLM_BENCH_LLM_INPUT_RATE && process.env.KOLM_BENCH_LLM_OUTPUT_RATE) {
    return {
      input_per_million: Number(process.env.KOLM_BENCH_LLM_INPUT_RATE),
      output_per_million: Number(process.env.KOLM_BENCH_LLM_OUTPUT_RATE),
      source: 'env override',
    };
  }
  // Conservative defaults. Real rates change; verify against the vendor's
  // pricing page before quoting numbers downstream.
  if (/opus/i.test(model))   return { input_per_million: 15.00, output_per_million: 75.00, source: 'estimated public list, verify before quoting' };
  if (/sonnet/i.test(model)) return { input_per_million:  3.00, output_per_million: 15.00, source: 'estimated public list, verify before quoting' };
  if (/haiku/i.test(model))  return { input_per_million:  1.00, output_per_million:  5.00, source: 'estimated public list, verify before quoting' };
  return { input_per_million: 0, output_per_million: 0, source: 'unknown model; set KOLM_BENCH_LLM_*_RATE to override' };
}

async function probeLocalLlm() {
  const endpoint = process.env.KOLM_BENCH_LOCAL_LLM_URL || 'http://127.0.0.1:11434';
  const model = process.env.KOLM_BENCH_LOCAL_LLM_MODEL || 'llama3.2:1b';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const r = await fetch(`${endpoint}/api/tags`, { signal: controller.signal }).catch(() => null);
    clearTimeout(timer);
    if (!r || !r.ok) return { available: false, reason: `${endpoint} unreachable (no local inference server)` };
    const tags = await r.json();
    const found = (tags.models || []).find(m => m.name === model || m.name.startsWith(model + ':'));
    if (!found) {
      const have = (tags.models || []).map(m => m.name).join(', ') || '(none)';
      return { available: false, reason: `${endpoint} reachable but model "${model}" not pulled; have: ${have}` };
    }
    return { available: true, endpoint, model };
  } catch (e) {
    return { available: false, reason: `local probe failed: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Head-to-head — comparative speedup + cost ratios over kolm-js as baseline.
// ---------------------------------------------------------------------------
function headToHead(results) {
  const base = results['kolm-js'];
  if (base.skipped) return { note: 'no baseline (kolm-js skipped)' };
  const basePer50 = base.latency_us.p50;
  const out = {};
  for (const k of Object.keys(results)) {
    if (k === 'kolm-js') continue;
    const r = results[k];
    if (r.skipped) { out[k] = { skipped: r.reason }; continue; }
    const speedup = r.latency_us.p50 ? round(r.latency_us.p50 / basePer50, 2) : null;
    out[k] = {
      p50_latency_ratio: speedup,
      p50_kolm_js_us: basePer50,
      p50_other_us: r.latency_us.p50,
      summary: speedup
        ? (speedup > 1
            ? `${k} is ${speedup}× SLOWER than kolm-js (p50)`
            : `${k} is ${round(1 / speedup, 2)}× FASTER than kolm-js (p50)`)
        : 'unable to compute ratio',
      cost_per_million_usd_kolm_js: 0,
      cost_per_million_usd_other: r.cost?.per_million_calls_usd ?? null,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
function collectCases(bundle, opts) {
  // Priority: explicit cases array (from --corpus or programmatic) >
  // artifact's embedded evals > single --input fallback.
  if (Array.isArray(opts?.cases) && opts.cases.length) {
    return opts.cases.map((c, i) => ({
      id: c.id || `case-${i + 1}`,
      input: c.input,
      expected: c.expected !== undefined ? c.expected : c.output,
      params: c.params,
    }));
  }
  const evalCases = bundle.evals?.cases;
  if (Array.isArray(evalCases) && evalCases.length) {
    return evalCases.map((c, i) => ({ id: c.id || `case-${i + 1}`, input: c.input, expected: c.expected, params: c.params }));
  }
  if (opts?.input !== undefined) return [{ id: 'input-1', input: opts.input, expected: undefined }];
  return [];
}

function buildSystemPromptFromBundle(bundle) {
  const task = bundle.manifest.task || 'follow the user request';
  const evalCases = bundle.evals?.cases?.slice(0, 3) || [];
  const shots = evalCases.map(c => {
    const inp = typeof c.input === 'string' ? c.input : JSON.stringify(c.input);
    const exp = typeof c.expected === 'string' ? c.expected : JSON.stringify(c.expected);
    return `Input: ${inp}\nOutput: ${exp}`;
  }).join('\n\n');
  return [
    `Task: ${task}`,
    'Reply with the output only — no commentary, no markdown fences, no explanation.',
    'If the output is structured, reply with exact JSON. Do not add fields the schema does not specify.',
    shots ? `Examples:\n${shots}` : '',
  ].filter(Boolean).join('\n\n');
}

function summarizeLatency(values) {
  if (!values.length) return { n: 0, min: null, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: pct(sorted, 0.5),
    p95: pct(sorted, 0.95),
    p99: pct(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[Math.max(0, idx)];
}

function average(arr) { if (!arr.length) return null; return round(arr.reduce((a, b) => a + b, 0) / arr.length, 2); }
function round(x, d) { const m = 10 ** d; return Math.round(x * m) / m; }
function positiveInt(v, fb) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : fb; }
function sha256File(p) { return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

// LLM outputs are noisy; we accept if every expected key→value appears in
// the actual output (substring for strings, deepEqual for nested). This
// favors LLMs (they get credit even if they add chatter); the speed
// comparison is fairer with a lenient correctness comparator.
function looseMatch(actual, expected) {
  if (deepEqual(actual, expected)) return true;
  if (typeof expected === 'string' && typeof actual === 'string') {
    return actual.toLowerCase().includes(expected.toLowerCase());
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object') return false;
    for (const k of Object.keys(expected)) {
      if (!(k in actual)) return false;
      if (!looseMatch(actual[k], expected[k])) return false;
    }
    return true;
  }
  return false;
}
