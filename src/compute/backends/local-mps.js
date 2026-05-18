// local-mps — Apple Silicon (M1+) via torch.backends.mps.
// No API. run() spawns the command with PYTORCH_ENABLE_MPS_FALLBACK=1.
// Env: any caller-set env wins over the default fallback.

import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

export async function detect() {
  const isMac = os.platform() === 'darwin';
  const isAppleSilicon = isMac && (os.arch() === 'arm64');
  if (!isAppleSilicon) {
    return { available: false, reason: 'not Apple Silicon' };
  }
  return {
    available: true,
    device: 'mps',
    chip: detectChip(),
    cores: os.cpus().length,
    unified_memory_gb: Number((os.totalmem() / 1e9).toFixed(1)),
  };
}

function detectChip() {
  try {
    const res = spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf-8', timeout: 1000 });
    return (res.stdout || '').trim() || 'Apple Silicon';
  } catch {
    return 'Apple Silicon';
  }
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

// run({ image, command, env, timeoutMs }) — spawns command with MPS fallback wired.
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  const det = await detect();
  if (!command || command.length === 0) {
    return { ok: false, reason: 'local-mps.run requires command', next_step: 'pass command=["python","-c","import torch;print(torch.backends.mps.is_available())"]' };
  }
  if (!det.available) {
    return { ok: false, reason: det.reason, next_step: 'requires arm64 darwin (Apple Silicon)' };
  }
  const [bin, ...args] = command;
  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: { PYTORCH_ENABLE_MPS_FALLBACK: '1', ...process.env, ...env },
      shell: false,
    });
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
        artifact_url: null, latency_ms: Date.now() - t0, device: 'mps',
      });
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ ok: false, reason: `spawn ${bin} failed: ${e.message}`, latency_ms: Date.now() - t0 });
    });
  });
}

export default { detect, test, run };
