// W287 — ONNX runtime target for .kolm artifacts.
//
// A .kolm with manifest.runtime_target='onnx' carries an ONNX model file
// inside the zip (path declared by manifest.runtime_target_config.onnx_path).
// Execution requires the `onnxruntime-node` npm package on the host; we do
// NOT take it as a hard root dep (it pulls a large native blob and we want
// the JS path to work on any Node install without it). It is detected via
// dynamic import at call time; missing dep raises a clean
// KOLM_E_ONNX_RUNTIME_MISSING with an install hint.
//
// Input tensor shape:
//   - opts.inputName overrides the input feed name (default: read from
//     manifest.entrypoint.input_schema.name OR fall back to the session's
//     first input name).
//   - opts.dtype overrides the tensor dtype (default: 'float32').
//   - For string-typed schemas, input is wrapped as a 1-element string tensor.
//
// Errors:
//   KOLM_E_TARGET_MISSING            — onnx_path missing from manifest or zip
//   KOLM_E_ONNX_RUNTIME_MISSING      — onnxruntime-node not installed
//   KOLM_E_ONNX_RUNTIME              — session creation or run threw
//   KOLM_E_RECIPE_TIMEOUT            — wall-clock budget exceeded

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DEFAULT_TIMEOUT_MS = 30_000;
const _onnxRequire = createRequire(import.meta.url);

function kolmError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Try to load onnxruntime-node. Returns the module or null. Cached so we
// don't repeatedly pay dynamic-import cost across a long-lived process.
let _ortCache;
async function loadOrt() {
  if (_ortCache !== undefined) return _ortCache;
  try {
    _ortCache = await import('onnxruntime-node');
    return _ortCache;
  } catch (e) {
    _ortCache = null;
    return null;
  }
}

// Probe: is onnxruntime-node available on this host? Used by runtimeAvailable
// so the binder can surface a clean "npm i -O onnxruntime-node to run" panel.
// Synchronous so the dispatchRuntime probe stays sync; we use the CommonJS
// require.resolve via createRequire under the hood. False positives (module
// resolves but the native .node binding fails to load) are surfaced later by
// runOnnxTarget when the dynamic import actually runs.
export function onnxRuntimeAvailable() {
  try {
    _onnxRequire.resolve('onnxruntime-node');
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: 'onnxruntime-node not installed. Install with: npm i -O onnxruntime-node (it is an optional peer dep so the JS runtime path works without it).',
    };
  }
}

export async function runOnnxTarget(bundle, input, opts = {}) {
  const cfg = bundle?.manifest?.runtime_target_config || {};
  const onnxRel = cfg.onnx_path;
  if (!onnxRel || typeof onnxRel !== 'string') {
    throw kolmError('KOLM_E_TARGET_MISSING', 'onnx runtime_target requires manifest.runtime_target_config.onnx_path');
  }
  const onnxBuf = bundle?.entries?.[onnxRel];
  if (!onnxBuf || !onnxBuf.length) {
    throw kolmError('KOLM_E_TARGET_MISSING', `onnx runtime_target references onnx_path=${onnxRel} but that entry is missing from the .kolm bundle`);
  }
  const ort = await loadOrt();
  if (!ort) {
    throw kolmError('KOLM_E_ONNX_RUNTIME_MISSING', 'onnxruntime-node not installed. Install with: npm i -O onnxruntime-node.');
  }
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-onnx-'));
  const onnxPath = path.join(workdir, path.basename(onnxRel) || 'model.onnx');
  const onnxSha = crypto.createHash('sha256').update(onnxBuf).digest('hex');

  try {
    fs.writeFileSync(onnxPath, onnxBuf);
    const t0 = process.hrtime.bigint();

    // Session creation + run wrapped in a timeout race. onnxruntime-node does
    // not expose a per-call deadline; we race the promise against a timer.
    const sessionPromise = (async () => {
      const session = await ort.InferenceSession.create(onnxPath);
      const inputName = opts.inputName
        || bundle?.manifest?.entrypoint?.input_schema?.name
        || session.inputNames?.[0];
      if (!inputName) {
        throw kolmError('KOLM_E_ONNX_RUNTIME', 'unable to derive input tensor name (no opts.inputName, no manifest.entrypoint.input_schema.name, no session.inputNames)');
      }
      const dtype = opts.dtype || bundle?.manifest?.entrypoint?.input_schema?.dtype || 'float32';
      let tensor;
      if (dtype === 'string') {
        const s = typeof input === 'string' ? input : JSON.stringify(input ?? null);
        tensor = new ort.Tensor('string', [s], [1]);
      } else {
        // Numeric tensor. Accept a flat array or a single number.
        const arr = Array.isArray(input)
          ? input
          : (typeof input === 'number' ? [input] : (input?.data || []));
        const shape = opts.shape || [1, arr.length];
        const TypedArr = dtype === 'float32' ? Float32Array : (dtype === 'int64' ? BigInt64Array : Float32Array);
        const data = dtype === 'int64'
          ? new TypedArr(arr.map(x => BigInt(x)))
          : new TypedArr(arr);
        tensor = new ort.Tensor(dtype, data, shape);
      }
      const feeds = { [inputName]: tensor };
      const out = await session.run(feeds);
      // Return all outputs as plain objects (callers know their model).
      const result = {};
      for (const [k, v] of Object.entries(out)) {
        result[k] = {
          dims: v.dims,
          type: v.type,
          data: Array.isArray(v.data) ? v.data : Array.from(v.data),
        };
      }
      return result;
    })();

    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(kolmError('KOLM_E_RECIPE_TIMEOUT', `onnx runner exceeded ${timeout}ms`)), timeout);
    });

    let output;
    try {
      output = await Promise.race([sessionPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }

    const us = Number(process.hrtime.bigint() - t0) / 1000;
    return {
      output,
      latency_us: Math.round(us),
      runtime: 'onnx',
      model_sha256: onnxSha,
    };
  } catch (e) {
    if (e.code && /^KOLM_E_/.test(e.code)) throw e;
    throw kolmError('KOLM_E_ONNX_RUNTIME', String(e.message || e));
  } finally {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  }
}
