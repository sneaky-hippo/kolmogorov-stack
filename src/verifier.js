// Sandbox + test harness for candidate generators.
// Two execution paths:
//   1. JS generators — sandboxed via node:vm with a frozen `lib` global.
//   2. WASM generators — instantiated via WebAssembly with no imports.
// Production should harden with isolated-vm or wasmtime; this is the demo substrate.

import vm from 'node:vm';
import crypto from 'node:crypto';
import { subroutines } from './library.js';

const DEFAULT_TIMEOUT_MS = 250;

export function compileJs(source) {
  const wrapped = `(function(input, lib){ "use strict"; ${source}\n; return generate(input, lib); })`;
  const script = new vm.Script(wrapped, { filename: 'generator.js' });
  const ctx = vm.createContext({}, { name: 'gen-ctx' });
  const fn = script.runInContext(ctx);
  return (input, opts = {}) => {
    const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
    // Extend the standard subroutine library with optional artifact-bound
    // (pack, index) and tenant-bound (params) slots. Recipes that don't
    // reference them get the original behaviour exactly.
    const lib = (opts.pack || opts.index || opts.params)
      ? Object.freeze({
          ...subroutines,
          pack: opts.pack || null,
          index: opts.index || null,
          params: opts.params || null,
        })
      : subroutines;
    return runWithTimeout(() => fn(input, lib), timeout);
  };
}

function runWithTimeout(fn, ms) {
  // Cooperative timeout — JS generators are short and side-effect-free.
  // Real isolation: isolated-vm with hard CPU limit.
  const start = Date.now();
  const result = fn();
  if (Date.now() - start > ms) {
    throw new Error(`generator exceeded ${ms}ms`);
  }
  return result;
}

export async function compileWasm(b64) {
  const bytes = Buffer.from(b64, 'base64');
  const mod = await WebAssembly.compile(bytes);
  const inst = await WebAssembly.instantiate(mod, {});
  return (input) => {
    if (typeof inst.exports.generate === 'function') {
      return inst.exports.generate(input);
    }
    throw new Error('wasm module must export `generate`');
  };
}

export function verify(generator, { positives = [], negatives = [], property_tests = [] } = {}) {
  const trace = [];
  let posOk = 0, negOk = 0, propOk = 0;
  let totalLatency = 0, runs = 0;

  for (const ex of positives) {
    const t0 = process.hrtime.bigint();
    let pass = false, output, error;
    try {
      output = generator(ex.input);
      pass = matches(output, ex.expected);
    } catch (e) { error = String(e.message || e); }
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    totalLatency += us; runs++;
    if (pass) posOk++;
    trace.push({ kind: 'positive', input: preview(ex.input), expected: preview(ex.expected), output: preview(output), pass, error, latency_us: Math.round(us) });
  }

  for (const ex of negatives) {
    const t0 = process.hrtime.bigint();
    let reject = false, output, error;
    try {
      output = generator(ex.input);
      reject = !matches(output, ex.expected_not);
    } catch (e) { error = String(e.message || e); reject = true; }
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    totalLatency += us; runs++;
    if (reject) negOk++;
    trace.push({ kind: 'negative', input: preview(ex.input), output: preview(output), reject, error, latency_us: Math.round(us) });
  }

  for (const pt of property_tests) {
    let pass = false, error;
    try {
      pass = pt.predicate(generator);
    } catch (e) { error = String(e.message || e); }
    if (pass) propOk++;
    trace.push({ kind: 'property', name: pt.name, pass, error });
  }

  const posRate = positives.length ? posOk / positives.length : 1;
  const negRate = negatives.length ? negOk / negatives.length : 1;
  const propRate = property_tests.length ? propOk / property_tests.length : 1;
  const quality = 0.5 * posRate + 0.4 * negRate + 0.1 * propRate;
  const latency_p50 = runs ? Math.round(totalLatency / runs) : 0;

  return {
    quality_score: round(quality, 3),
    pass_rate_positive: round(posRate, 3),
    reject_rate_negative: round(negRate, 3),
    property_pass_rate: round(propRate, 3),
    latency_p50_us: latency_p50,
    trace,
    runs,
  };
}

function matches(actual, expected) {
  if (expected === undefined || expected === null) return actual !== undefined;
  if (typeof expected === 'function') return expected(actual);
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (actual.length !== expected.length) return false;
    return actual.every((a, i) => matches(a, expected[i]));
  }
  if (typeof expected === 'object' && expected && typeof actual === 'object' && actual) {
    return Object.keys(expected).every(k => matches(actual[k], expected[k]));
  }
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(actual - expected) < 1e-6;
  }
  return actual === expected;
}

function preview(x) {
  if (typeof x === 'string') return x.length > 120 ? x.slice(0, 117) + '...' : x;
  return x;
}

function round(x, d) { const m = 10 ** d; return Math.round(x * m) / m; }

export function hashSource(source) {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
}

export const QUALITY_GATE = 0.85;
