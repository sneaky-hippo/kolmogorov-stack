// local-directml — Windows DX12 via torch-directml.
// No API. run() spawns command on this box (Windows-aware shell).
// Env: caller env passed through; PATH must include python with torch-directml.

import { spawn, spawnSync } from 'node:child_process';

export async function detect() {
  try {
    const res = spawnSync('python', ['-c', 'import torch_directml; d=torch_directml.device(); print(torch_directml.device_count())'], {
      encoding: 'utf-8',
      timeout: 4000,
    });
    if (res.status !== 0) {
      return { available: false, reason: 'torch-directml not importable (pip install torch-directml)' };
    }
    const count = Number((res.stdout || '0').trim()) || 0;
    if (count === 0) return { available: false, reason: 'no DX12 device' };
    return { available: true, device: 'dml:0', device_count: count };
  } catch (err) {
    return { available: false, reason: String(err.message || err) };
  }
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

// run({ image, command, env, timeoutMs }) — spawns command on this box.
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  const det = await detect();
  if (!command || command.length === 0) {
    return { ok: false, reason: 'local-directml.run requires command', next_step: 'pass command=["python","-c","import torch_directml"]' };
  }
  if (!det.available) {
    return { ok: false, reason: det.reason, next_step: 'pip install torch-directml on Windows' };
  }
  const [bin, ...args] = command;
  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
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
        artifact_url: null, latency_ms: Date.now() - t0, device: 'dml:0',
      });
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ ok: false, reason: `spawn ${bin} failed: ${e.message}`, latency_ms: Date.now() - t0 });
    });
  });
}

export default { detect, test, run };
