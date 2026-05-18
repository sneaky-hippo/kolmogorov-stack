// modal — Modal Labs serverless GPU. No public REST API; SDK is gRPC.
// CLI: https://modal.com/docs/reference/cli/run
// Env: KOLM_MODAL_TOKEN (translated to MODAL_TOKEN_ID + MODAL_TOKEN_SECRET).
// run() shells out to the `modal` CLI if present, else returns guidance.

import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';

const exec = promisify(execCb);

function _token() {
  return process.env.KOLM_MODAL_TOKEN || process.env.MODAL_TOKEN_ID || '';
}

export async function detect() {
  if (!_token()) return { available: false, reason: 'KOLM_MODAL_TOKEN env var not set' };
  return { available: true, device: 'modal-h100', auth: 'token', region: process.env.KOLM_MODAL_REGION || 'auto' };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

// Check if the `modal` CLI is on PATH (Windows-aware).
async function _modalAvailable() {
  const which = process.platform === 'win32' ? 'where modal' : 'command -v modal';
  try {
    const { stdout } = await exec(which);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// run({ image, command, env, timeoutMs }) — `image` is the modal script
// reference like "script.py::function" or a deployed app name. `command`
// becomes positional args passed to `modal run`.
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  if (!_token()) {
    return { ok: false, reason: 'KOLM_MODAL_TOKEN not set', next_step: 'modal token new; export KOLM_MODAL_TOKEN=...' };
  }
  if (!(await _modalAvailable())) {
    return {
      ok: false,
      reason: 'modal CLI not installed',
      next_step: 'pip install modal && modal token new',
      latency_ms: Date.now() - t0,
    };
  }
  if (!image) {
    return { ok: false, reason: 'modal.run requires image (e.g. "myapp.py::train")', next_step: 'pass image="script.py::function_name"' };
  }
  // Spawn `modal run <image> <args...>`. Inherit a clean env that includes
  // MODAL_TOKEN_ID / MODAL_TOKEN_SECRET if the user already split the token.
  const spawnEnv = { ...process.env, ...env };
  if (process.env.KOLM_MODAL_TOKEN && !spawnEnv.MODAL_TOKEN_ID) {
    const parts = process.env.KOLM_MODAL_TOKEN.split(':');
    if (parts.length >= 2) {
      spawnEnv.MODAL_TOKEN_ID = parts[0];
      spawnEnv.MODAL_TOKEN_SECRET = parts.slice(1).join(':');
    }
  }
  const args = ['run', image, ...command];
  return await new Promise((resolve) => {
    const child = spawn('modal', args, { env: spawnEnv, shell: process.platform === 'win32' });
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
        mode: 'modal-cli',
      });
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ ok: false, reason: `spawn modal failed: ${e.message}`, latency_ms: Date.now() - t0 });
    });
  });
}

export default { detect, test, run };
