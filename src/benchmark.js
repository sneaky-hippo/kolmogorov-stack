import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { loadArtifact, runArtifact } from './artifact-runner.js';
import { scoreCase } from './case-scorer.js';

const require = createRequire(import.meta.url);

export async function benchmarkArtifact(artifactPath, opts = {}) {
  const runs = positiveInt(opts.runs, 1);
  const artifactBytes = fs.readFileSync(artifactPath);
  const bundle = loadArtifact(artifactPath);
  const cases = benchmarkCases(bundle, opts.input);
  const startedAt = new Date().toISOString();
  const egress = createEgressMonitor();
  const latencies = [];
  const errors = [];
  let passed = 0;
  let graded = 0;

  // W345 — bench and eval share src/case-scorer.js. Comparator is pulled from
  // the artifact's manifest (or the bundle's embedded evals.comparator) so the
  // pass-count for a given .kolm + case set is independent of which verb the
  // user ran. opts.comparator is the per-call override.
  const comparatorName = opts.comparator || bundle.evals?.comparator || 'subset_equal';
  const restore = egress.install();
  try {
    for (const c of cases) {
      for (let i = 0; i < runs; i++) {
        try {
          const result = await runArtifact(artifactPath, c.input, { params: c.params });
          latencies.push(result.latency_us);
          if (c.expected !== undefined) {
            graded++;
            const sc = scoreCase({ input: c.input, expected: c.expected }, result.output, { comparator: comparatorName, latency_us: result.latency_us });
            if (sc.pass) passed++;
            else if (errors.length < 10) {
              errors.push({ id: c.id, expected: c.expected, got: result.output });
            }
          }
        } catch (error) {
          if (c.expected !== undefined) graded++;
          if (errors.length < 10) errors.push({ id: c.id, error: String(error.message || error) });
        }
      }
    }
  } finally {
    restore();
  }

  const latency = summarizeLatency(latencies);
  const report = {
    spec: 'kolm-benchmark-1',
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    artifact: artifactPath,
    artifact_sha256: 'sha256:' + sha256(artifactBytes),
    artifact_bytes: artifactBytes.length,
    target: opts.target || `${process.platform}-${process.arch}`,
    device: opts.device || os.hostname(),
    node: process.version,
    manifest: {
      spec: bundle.manifest.spec,
      job_id: bundle.manifest.job_id,
      task: bundle.manifest.task,
      runtime: bundle.manifest.runtime,
      tier: bundle.manifest.tier || null,
      base_model: bundle.manifest.base_model,
    },
    k_score: bundle.manifest.k_score?.composite ?? null,
    k_score_raw: bundle.manifest.k_score || null,
    evals: {
      n: cases.length,
      graded,
      passed,
      accuracy: graded ? round(passed / graded, 4) : null,
      runs_per_case: runs,
    },
    latency_us: latency,
    privacy: {
      runtime_egress_attempts: egress.attempts.length,
      runtime_egress_bytes: 0,
      blocked: egress.attempts.length > 0,
      attempts: egress.attempts.slice(0, 10),
    },
    integrity: {
      signature_valid: bundle.signature_valid,
      receipt_present: !!bundle.receipt,
      receipt_signature_alg: bundle.receipt?.signature_alg || null,
      receipt_chain_steps: bundle.receipt?.chain?.length || 0,
    },
    errors,
  };

  if (opts.outPath) {
    fs.writeFileSync(opts.outPath, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

function benchmarkCases(bundle, input) {
  const evalCases = bundle.evals?.cases;
  if (Array.isArray(evalCases) && evalCases.length) {
    return evalCases.map((c, i) => ({
      id: c.id || `case-${i + 1}`,
      input: c.input,
      expected: c.expected,
      params: c.params,
    }));
  }
  if (input !== undefined) return [{ id: 'input-1', input, expected: undefined }];
  return [];
}

function summarizeLatency(values) {
  if (!values.length) {
    return { n: 0, min: null, p50: null, p95: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[Math.max(0, idx)];
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function round(x, d) {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

// W345 — superseded by src/case-scorer.js::scoreCase (shared with eval). Kept
// for backward compat with anything that imported the legacy helper; the
// active pass/fail path no longer calls this function.
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
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return false;
}

function createEgressMonitor() {
  const attempts = [];
  const patches = [];
  const modules = [];

  try { modules.push(['http', require('node:http')]); } catch {}
  try { modules.push(['https', require('node:https')]); } catch {}
  try { modules.push(['net', require('node:net')]); } catch {}
  try { modules.push(['tls', require('node:tls')]); } catch {}
  try { modules.push(['dns', require('node:dns')]); } catch {}

  function record(api, args) {
    attempts.push({ api, target: describeTarget(args[0]) });
    throw new Error(`network egress blocked by benchmark harness: ${api}`);
  }

  function patch(obj, key, api) {
    if (!obj || typeof obj[key] !== 'function') return;
    const original = obj[key];
    obj[key] = function (...args) { return record(api, args); };
    patches.push(() => { obj[key] = original; });
  }

  return {
    attempts,
    install() {
      const originalFetch = globalThis.fetch;
      if (typeof originalFetch === 'function') {
        globalThis.fetch = (...args) => record('fetch', args);
        patches.push(() => { globalThis.fetch = originalFetch; });
      }
      for (const [name, mod] of modules) {
        for (const key of ['request', 'get', 'connect', 'createConnection', 'lookup', 'resolve', 'resolve4', 'resolve6']) {
          patch(mod, key, `${name}.${key}`);
        }
      }
      return () => {
        while (patches.length) patches.pop()();
      };
    },
  };
}

function describeTarget(value) {
  if (typeof value === 'string') return value.slice(0, 200);
  if (value instanceof URL) return value.toString().slice(0, 200);
  if (value && typeof value === 'object') {
    if (value.href) return String(value.href).slice(0, 200);
    if (value.hostname || value.host) return String(value.hostname || value.host).slice(0, 200);
  }
  return typeof value;
}
