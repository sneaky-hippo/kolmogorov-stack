// W287 — native subprocess runtime target for .kolm artifacts.
//
// A .kolm with manifest.runtime_target='native' carries a precompiled
// binary inside the zip (typically under target/<triple>/<name>). The
// manifest.entrypoint.binary field names the relative path. We extract the
// binary to a fresh tmp dir, chmod 0755, and spawn it with stdin = one JSON
// line. The process must write one JSON line to stdout and exit.
//
// Sandbox posture (best-effort, NOT a hard security boundary):
//   - no env vars from the parent process are passed (env = {})
//   - cwd = ephemeral tmp dir (the dir containing only the extracted binary)
//   - 1000 ms wall-clock budget; SIGKILL on exceed
//   - on Windows, the binary path MUST end in .exe (no fallback to /bin/sh
//     style shebang interpretation)
//
// Errors:
//   KOLM_E_TARGET_MISSING        — entrypoint.binary missing from manifest or zip
//   KOLM_E_NATIVE_RUNTIME        — child crashed, exited non-zero, or stdout
//                                  was not parseable JSON
//   KOLM_E_RECIPE_TIMEOUT        — wall-clock budget exceeded
//   KOLM_E_NATIVE_PLATFORM       — refused to run on this platform (Windows
//                                  without .exe suffix)

import { spawn } from 'node:child_process';
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

export async function runNativeTarget(bundle, input, opts = {}) {
  const ep = bundle?.manifest?.entrypoint || {};
  const rel = ep.binary;
  if (!rel || typeof rel !== 'string') {
    throw kolmError('KOLM_E_TARGET_MISSING', 'native runtime_target requires manifest.entrypoint.binary');
  }
  if (process.platform === 'win32' && !rel.endsWith('.exe')) {
    throw kolmError('KOLM_E_NATIVE_PLATFORM', `on Windows, manifest.entrypoint.binary must end in .exe (got ${rel})`);
  }
  const bin = bundle?.entries?.[rel];
  if (!bin || !bin.length) {
    throw kolmError('KOLM_E_TARGET_MISSING', `native runtime_target references entrypoint.binary=${rel} but that entry is missing from the .kolm bundle`);
  }
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-native-'));
  const binName = path.basename(rel) || 'recipe';
  const binPath = path.join(workdir, binName);
  const binSha = crypto.createHash('sha256').update(bin).digest('hex');

  try {
    fs.writeFileSync(binPath, bin);
    try { fs.chmodSync(binPath, 0o755); } catch {}

    const t0 = process.hrtime.bigint();
    const child = spawn(binPath, [], {
      cwd: workdir,
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
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

    try {
      child.stdin.write(JSON.stringify(input ?? null) + '\n');
      child.stdin.end();
    } catch {
      // Child may have already exited; the close event below carries the
      // verdict either way.
    }

    const result = await new Promise((resolve) => {
      child.on('error', (e) => resolve({ kind: 'error', error: e }));
      child.on('close', (code, signal) => resolve({ kind: 'close', code, signal }));
    });
    clearTimeout(killTimer);
    const us = Number(process.hrtime.bigint() - t0) / 1000;

    if (timedOut) {
      throw kolmError('KOLM_E_RECIPE_TIMEOUT', `native runner exceeded ${timeout}ms`);
    }
    if (result.kind === 'error') {
      throw kolmError('KOLM_E_NATIVE_RUNTIME', `native spawn failed: ${result.error.message}`);
    }
    if (result.code !== 0) {
      throw kolmError('KOLM_E_NATIVE_RUNTIME', `native exited with code ${result.code}${stderr ? ` (stderr: ${stderr.slice(0, 1024)})` : ''}`);
    }

    const firstLine = stdout.split(/\r?\n/).find(l => l.trim().length > 0) || '';
    let output;
    try {
      output = firstLine ? JSON.parse(firstLine) : null;
    } catch (e) {
      throw kolmError('KOLM_E_NATIVE_RUNTIME', `native stdout was not JSON: ${e.message}; raw: ${firstLine.slice(0, 200)}`);
    }

    return {
      output,
      latency_us: Math.round(us),
      runtime: 'native',
      binary_sha256: binSha,
    };
  } finally {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  }
}
