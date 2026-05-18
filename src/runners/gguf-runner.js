// W287 — GGUF runtime target for .kolm artifacts.
//
// A .kolm with manifest.runtime_target='gguf' carries a quantized GGUF
// model inside the zip (path declared by manifest.runtime_target_config.gguf_path).
// Execution requires llama.cpp's `llama-cli` binary on the host; we do NOT
// take llama.cpp as a hard npm dep — the binary is detected at runtime via
// the LLAMA_CPP_BIN env var or PATH lookup. A missing binary raises a clean
// KOLM_E_GGUF_RUNTIME_MISSING with a hint, never a silent fallback to JS.
//
// Detection order:
//   1. LLAMA_CPP_BIN env var (full path to llama-cli executable)
//   2. `llama-cli` on PATH
//   3. `llama` on PATH (older builds)
//
// Errors:
//   KOLM_E_TARGET_MISSING            — gguf_path missing from manifest or zip
//   KOLM_E_GGUF_RUNTIME_MISSING      — llama.cpp binary not found on host
//   KOLM_E_GGUF_RUNTIME              — llama-cli crashed or exited non-zero
//   KOLM_E_RECIPE_TIMEOUT            — wall-clock budget exceeded (default 30s
//                                      since model inference is much slower
//                                      than the 1s recipe budget; callers can
//                                      override via opts.timeoutMs)

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 30_000;

function kolmError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Detect the llama.cpp binary path. Returns the absolute path or null.
// Used by both runGgufTarget AND ggufRuntimeAvailable so the "can I run?"
// probe and the actual runner agree on what binary they would use.
export function detectLlamaCppBin() {
  const fromEnv = process.env.LLAMA_CPP_BIN;
  if (fromEnv) {
    try {
      if (fs.existsSync(fromEnv)) return fromEnv;
    } catch {}
  }
  const which = process.platform === 'win32' ? 'where' : 'which';
  for (const candidate of ['llama-cli', 'llama']) {
    try {
      const r = spawnSync(which, [candidate], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) {
        const found = (r.stdout || '').split(/\r?\n/).find(l => l.trim().length > 0);
        if (found) return found.trim();
      }
    } catch {}
  }
  return null;
}

// Probe: does this host have a usable llama.cpp binary? Used by
// runtimeAvailable() in artifact-runner.js so the binder can show a
// "install llama.cpp to run" panel before the user clicks Run.
export function ggufRuntimeAvailable() {
  const bin = detectLlamaCppBin();
  if (!bin) {
    return {
      ok: false,
      reason: 'llama.cpp binary not found (probed LLAMA_CPP_BIN env var, then `llama-cli` and `llama` on PATH). Install llama.cpp from https://github.com/ggerganov/llama.cpp and either add it to PATH or set LLAMA_CPP_BIN to the full path of llama-cli.',
    };
  }
  return { ok: true, binary: bin };
}

export async function runGgufTarget(bundle, input, opts = {}) {
  const cfg = bundle?.manifest?.runtime_target_config || {};
  const ggufRel = cfg.gguf_path;
  if (!ggufRel || typeof ggufRel !== 'string') {
    throw kolmError('KOLM_E_TARGET_MISSING', 'gguf runtime_target requires manifest.runtime_target_config.gguf_path');
  }
  const ggufBuf = bundle?.entries?.[ggufRel];
  if (!ggufBuf || !ggufBuf.length) {
    throw kolmError('KOLM_E_TARGET_MISSING', `gguf runtime_target references gguf_path=${ggufRel} but that entry is missing from the .kolm bundle`);
  }
  const bin = detectLlamaCppBin();
  if (!bin) {
    throw kolmError('KOLM_E_GGUF_RUNTIME_MISSING', 'llama.cpp binary not found (probed LLAMA_CPP_BIN env var, then `llama-cli` and `llama` on PATH). Install llama.cpp from https://github.com/ggerganov/llama.cpp and either add it to PATH or set LLAMA_CPP_BIN.');
  }
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-gguf-'));
  const ggufPath = path.join(workdir, path.basename(ggufRel) || 'model.gguf');
  const ggufSha = crypto.createHash('sha256').update(ggufBuf).digest('hex');

  try {
    fs.writeFileSync(ggufPath, ggufBuf);
    const prompt = typeof input === 'string' ? input : JSON.stringify(input ?? null);
    const args = [
      '--model', ggufPath,
      '--prompt', prompt,
      '--no-display-prompt',
      '--temp', '0',
      '--predict', String(opts.maxTokens || 256),
    ];

    const t0 = process.hrtime.bigint();
    const child = spawn(bin, args, {
      cwd: workdir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeout);

    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });

    const result = await new Promise((resolve) => {
      child.on('error', (e) => resolve({ kind: 'error', error: e }));
      child.on('close', (code, signal) => resolve({ kind: 'close', code, signal }));
    });
    clearTimeout(killTimer);
    const us = Number(process.hrtime.bigint() - t0) / 1000;

    if (timedOut) {
      throw kolmError('KOLM_E_RECIPE_TIMEOUT', `gguf runner exceeded ${timeout}ms`);
    }
    if (result.kind === 'error') {
      throw kolmError('KOLM_E_GGUF_RUNTIME', `llama-cli spawn failed: ${result.error.message}`);
    }
    if (result.code !== 0) {
      throw kolmError('KOLM_E_GGUF_RUNTIME', `llama-cli exited with code ${result.code}${stderr ? ` (stderr: ${stderr.slice(0, 1024)})` : ''}`);
    }

    return {
      output: stdout.trim(),
      latency_us: Math.round(us),
      runtime: 'gguf',
      model_sha256: ggufSha,
      llama_cpp_bin: bin,
    };
  } finally {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  }
}
