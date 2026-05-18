// local-rocm — AMD MI / RDNA3 via rocm-smi.
// No API. run() spawns command with HIP_VISIBLE_DEVICES wired.
// Env: caller can pass HIP_VISIBLE_DEVICES; otherwise defaults to "0".

import { spawn, spawnSync } from 'node:child_process';

export async function detect() {
  try {
    const res = spawnSync('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    if (res.status !== 0 || !res.stdout) {
      return { available: false, reason: 'rocm-smi missing or no AMD GPU' };
    }
    let data;
    try { data = JSON.parse(res.stdout); } catch { return { available: false, reason: 'rocm-smi json parse failed' }; }
    const cards = Object.keys(data).filter((k) => k.startsWith('card'));
    if (cards.length === 0) return { available: false, reason: 'no cards reported' };
    return {
      available: true,
      device: 'cuda:0', // ROCm exposes via cuda namespace in pytorch+hip
      cards: cards.length,
      detail: cards.map((c) => data[c]),
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

// run({ image, command, env, timeoutMs }) — spawns command with HIP env wired.
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  const det = await detect();
  if (!command || command.length === 0) {
    return { ok: false, reason: 'local-rocm.run requires command', next_step: 'pass command=["rocm-smi"]' };
  }
  if (!det.available) {
    return { ok: false, reason: det.reason, next_step: 'install rocm-smi + ROCm runtime' };
  }
  const [bin, ...args] = command;
  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env, HIP_VISIBLE_DEVICES: env.HIP_VISIBLE_DEVICES ?? process.env.HIP_VISIBLE_DEVICES ?? '0' },
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
        artifact_url: null, latency_ms: Date.now() - t0, device: 'cuda:0-rocm',
      });
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ ok: false, reason: `spawn ${bin} failed: ${e.message}`, latency_ms: Date.now() - t0 });
    });
  });
}

export default { detect, test, run };
