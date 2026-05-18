// local-cuda — NVIDIA GPU on this box. Detection via nvidia-smi.
// No API. run() spawns the command with CUDA_VISIBLE_DEVICES wired.
// Env: caller can pass env.CUDA_VISIBLE_DEVICES; otherwise inherited.

import { spawn, spawnSync } from 'node:child_process';

function nvidiaSmi() {
  try {
    const res = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    if (res.status !== 0 || !res.stdout) return null;
    return res.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [name, mem, drv] = line.split(',').map((s) => s.trim());
        return { name, vram_mb: Number(mem), driver: drv };
      });
  } catch {
    return null;
  }
}

export async function detect() {
  const gpus = nvidiaSmi();
  if (!gpus || gpus.length === 0) {
    return { available: false, reason: 'no nvidia-smi or no GPUs' };
  }
  return {
    available: true,
    device: `cuda:0`,
    gpus,
    primary_vram_gb: Number((gpus[0].vram_mb / 1024).toFixed(1)),
  };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

// run({ image, command, env, timeoutMs }) — spawns command with GPU env wired.
// Detects + reports `gpu_available` so callers can fall back to CPU if needed.
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  const det = await detect();
  if (!command || command.length === 0) {
    return { ok: false, reason: 'local-cuda.run requires command', next_step: 'pass command=["nvidia-smi"]' };
  }
  if (!det.available) {
    return { ok: false, reason: det.reason, gpu_available: false, next_step: 'install nvidia-smi driver, or use local-cpu' };
  }
  const [bin, ...args] = command;
  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env, CUDA_VISIBLE_DEVICES: env.CUDA_VISIBLE_DEVICES ?? process.env.CUDA_VISIBLE_DEVICES ?? '0' },
      shell: process.platform === 'win32',
    });
    const outChunks = []; const errChunks = [];
    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({
        ok: code === 0,
        exit_code: code == null ? 1 : code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        artifact_url: null,
        latency_ms: Date.now() - t0,
        device: det.device,
        gpu_available: true,
      });
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ ok: false, reason: `spawn ${bin} failed: ${e.message}`, latency_ms: Date.now() - t0 });
    });
  });
}

export default { detect, test, run };
