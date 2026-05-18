// local-cpu — always available, slow, no GPU. Detect reports cores + RAM.
// No API. run() spawns the command on this box via node:child_process.
// Env: KOLM_TRAINER_BACKEND=local for the training bridge; run() is generic exec.

import os from 'node:os';
import { spawn } from 'node:child_process';

export async function detect() {
  return {
    available: true,
    device: 'cpu',
    cores: os.cpus().length,
    ram_gb: Number((os.totalmem() / 1e9).toFixed(1)),
  };
}

export async function test() {
  const t0 = Date.now();
  return { ok: true, latency_ms: Date.now() - t0, device: 'cpu', cores: os.cpus().length };
}

// run({ image, command, env, timeoutMs }) — `image` is ignored (no container
// runtime on local). `command` is argv. Returns the same envelope as remote
// backends so callers can treat all backends uniformly.
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  if (!command || command.length === 0) {
    return { ok: false, reason: 'local-cpu.run requires command', next_step: 'pass command=["echo","hello"]' };
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
        ok: code === 0,
        exit_code: code == null ? 1 : code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        artifact_url: null,
        latency_ms: Date.now() - t0,
        device: 'cpu',
      });
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ ok: false, reason: `spawn ${bin} failed: ${e.message}`, latency_ms: Date.now() - t0 });
    });
  });
}

export default { detect, test, run };
