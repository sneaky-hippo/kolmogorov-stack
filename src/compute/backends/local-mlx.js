// local-mlx — Apple Silicon native via mlx-lm. Detected by mlx import probe.
// No API. run() spawns the command (mlx is process-local, no daemon).
// Env: standard PATH inherits; mlx-lm tools must be on PATH.

import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

export async function detect() {
  if (os.platform() !== 'darwin' || os.arch() !== 'arm64') {
    return { available: false, reason: 'not Apple Silicon' };
  }
  try {
    const res = spawnSync('python3', ['-c', 'import mlx, mlx_lm; print(mlx.__version__)'], {
      encoding: 'utf-8',
      timeout: 4000,
    });
    if (res.status !== 0) {
      return { available: false, reason: 'mlx-lm not importable (pip install mlx-lm)' };
    }
    return {
      available: true,
      device: 'mlx',
      version: (res.stdout || '').trim(),
      unified_memory_gb: Number((os.totalmem() / 1e9).toFixed(1)),
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

// run({ image, command, env, timeoutMs }) — spawns command (typically a
// mlx_lm tool like `mlx_lm.lora` or `python -m mlx_lm.generate`).
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  const det = await detect();
  if (!command || command.length === 0) {
    return { ok: false, reason: 'local-mlx.run requires command', next_step: 'pass command=["python","-m","mlx_lm.generate","--help"]' };
  }
  if (!det.available) {
    return { ok: false, reason: det.reason, next_step: 'pip install mlx-lm; ensure Apple Silicon (arm64 darwin)' };
  }
  const [bin, ...args] = command;
  return await new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env }, shell: false });
    const outChunks = []; const errChunks = [];
    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({
        ok: code === 0, exit_code: code == null ? 1 : code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        artifact_url: null, latency_ms: Date.now() - t0, device: 'mlx',
      });
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ ok: false, reason: `spawn ${bin} failed: ${e.message}`, latency_ms: Date.now() - t0 });
    });
  });
}

export default { detect, test, run };
