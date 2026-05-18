// W287 — WASM runtime target for .kolm artifacts.
//
// A .kolm with manifest.runtime_target='wasm' ships a `target.wasm` zip
// entry that is a wasm32-wasi module exposing _start as its entrypoint.
// The contract:
//   - stdin  = one JSON line carrying the input
//   - stdout = one JSON line carrying the output
//   - exit 0 = success; non-zero = recipe error
//
// We instantiate the module via node:wasi (preview1) and wire stdin/stdout
// to ephemeral temp files. node:wasi cannot read directly from a Node Buffer,
// so we write input to disk, attach the workdir as the wasi root, and read
// stdout back as a JSON line.
//
// Errors:
//   KOLM_E_TARGET_MISSING       — bundle has no target.wasm entry
//   KOLM_E_WASM_INSTANTIATE     — the wasm bytes could not be compiled
//   KOLM_E_WASM_RUNTIME         — wasi execution threw or exited non-zero
//   KOLM_E_RECIPE_TIMEOUT       — wasi run exceeded the per-call timeout

import { WASI } from 'node:wasi';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 1000;

function kolmError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export async function runWasmTarget(bundle, input, opts = {}) {
  const wasmBuf = bundle?.entries?.['target.wasm'];
  if (!wasmBuf || !wasmBuf.length) {
    throw kolmError('KOLM_E_TARGET_MISSING', 'wasm runtime_target requires target.wasm entry in the .kolm bundle');
  }
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wasm-'));
  const stdinPath = path.join(workdir, 'stdin');
  const stdoutPath = path.join(workdir, 'stdout');
  const stderrPath = path.join(workdir, 'stderr');
  const wasmPath = path.join(workdir, 'target.wasm');

  try {
    fs.writeFileSync(wasmPath, wasmBuf);
    fs.writeFileSync(stdinPath, JSON.stringify(input ?? null));
    fs.writeFileSync(stdoutPath, '');
    fs.writeFileSync(stderrPath, '');

    let mod;
    try {
      mod = await WebAssembly.compile(wasmBuf);
    } catch (e) {
      throw kolmError('KOLM_E_WASM_INSTANTIATE', `wasm compile failed: ${e.message}`);
    }

    const stdinFd = fs.openSync(stdinPath, 'r');
    const stdoutFd = fs.openSync(stdoutPath, 'w');
    const stderrFd = fs.openSync(stderrPath, 'w');

    const wasi = new WASI({
      version: 'preview1',
      args: ['kolm-wasm-target'],
      env: {},
      stdin: stdinFd,
      stdout: stdoutFd,
      stderr: stderrFd,
      preopens: { '/work': workdir },
    });

    const t0 = process.hrtime.bigint();
    let exitCode = 0;
    let runError = null;
    try {
      const instance = await WebAssembly.instantiate(mod, wasi.getImportObject());
      // wasi.start throws on non-zero exit via proc_exit. Wrap so we can
      // distinguish a clean exit-0 (instance returns) from a wasi-driven
      // non-zero exit.
      try {
        wasi.start(instance);
      } catch (e) {
        // proc_exit throws a WASI ExitStatus on non-zero. The error message
        // includes the exit code; we treat any non-zero as a runtime error.
        const m = /WASI Exit code:?\s*(\d+)/i.exec(String(e.message || ''));
        if (m) {
          exitCode = Number(m[1]);
          if (exitCode !== 0) runError = `wasi exited with code ${exitCode}`;
        } else {
          runError = String(e.message || e);
        }
      }
    } catch (e) {
      runError = String(e.message || e);
    } finally {
      try { fs.closeSync(stdinFd); } catch {}
      try { fs.closeSync(stdoutFd); } catch {}
      try { fs.closeSync(stderrFd); } catch {}
    }
    const us = Number(process.hrtime.bigint() - t0) / 1000;

    if (us / 1000 > timeout) {
      throw kolmError('KOLM_E_RECIPE_TIMEOUT', `wasm runner exceeded ${timeout}ms (took ${Math.round(us / 1000)}ms)`);
    }
    if (runError) {
      const stderr = fs.readFileSync(stderrPath, 'utf8').slice(0, 1024);
      throw kolmError('KOLM_E_WASM_RUNTIME', `${runError}${stderr ? ` (stderr: ${stderr})` : ''}`);
    }

    const stdoutRaw = fs.readFileSync(stdoutPath, 'utf8').trim();
    let output;
    try {
      output = stdoutRaw ? JSON.parse(stdoutRaw) : null;
    } catch (e) {
      throw kolmError('KOLM_E_WASM_RUNTIME', `wasm stdout was not JSON: ${e.message}; raw: ${stdoutRaw.slice(0, 200)}`);
    }

    const wasmSha = crypto.createHash('sha256').update(wasmBuf).digest('hex');
    return {
      output,
      latency_us: Math.round(us),
      runtime: 'wasm',
      wasm_sha256: wasmSha,
    };
  } finally {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  }
}
