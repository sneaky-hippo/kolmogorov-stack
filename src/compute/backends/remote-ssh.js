// remote-ssh — bring-your-own GPU over SSH.
// No HTTP API. Uses native `ssh` binary via node:child_process.
// Env: KOLM_REMOTE_HOST (user@host[:port]) + KOLM_REMOTE_SSH_KEY (default ~/.ssh/id_ed25519).

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

export async function detect() {
  const host = process.env.KOLM_REMOTE_HOST;
  if (!host) return { available: false, reason: 'KOLM_REMOTE_HOST not set (user@host:port)' };
  const sshKey = process.env.KOLM_REMOTE_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519');
  if (!fs.existsSync(sshKey)) return { available: false, reason: `SSH key not found at ${sshKey}` };
  return { available: true, device: `remote://${host}`, host, ssh_key: sshKey };
}

export async function test() {
  const d = await detect();
  if (!d.available) return { ok: false, ...d };
  const t0 = Date.now();
  try {
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', '-i', d.ssh_key, d.host, 'echo kolm-probe'];
    const res = spawnSync('ssh', args, { encoding: 'utf-8', timeout: 6000 });
    const ok = res.status === 0 && /kolm-probe/.test(res.stdout || '');
    return { ok, latency_ms: Date.now() - t0, host: d.host, stderr: ok ? undefined : (res.stderr || '').slice(0, 200) };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}

// Parse "user@host" or "user@host:port" — ssh CLI uses -p for port.
function _parseHost(raw) {
  const m = String(raw).match(/^(.*?)(?::(\d+))?$/);
  return { hostspec: m[1], port: m[2] ? Number(m[2]) : null };
}

// run({ image, command, env, timeoutMs }) — `image` is ignored (we don't ship
// containers over SSH; that's the user's job). `command` is the shell command
// to execute. `env` is shipped as `KEY=VAL ...` prefix in the remote shell.
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  const det = await detect();
  if (!det.available) {
    return { ok: false, reason: det.reason, next_step: 'export KOLM_REMOTE_HOST=user@host; ensure ssh key exists' };
  }
  if (!command || command.length === 0) {
    return { ok: false, reason: 'remote-ssh.run requires command', next_step: 'pass command=["nvidia-smi"] or similar' };
  }
  const { hostspec, port } = _parseHost(det.host);
  // Build remote command: env-prefix + the user command joined as one shell string.
  // We deliberately do NOT bash-escape — the caller already passes shell-safe argv.
  const envPrefix = Object.entries(env || {})
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
    .join(' ');
  const remoteCmd = (envPrefix ? envPrefix + ' ' : '') + command.join(' ');
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-i', det.ssh_key,
    ...(port ? ['-p', String(port)] : []),
    hostspec,
    remoteCmd,
  ];
  return await new Promise((resolve) => {
    const child = spawn('ssh', args);
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
        host: det.host,
      });
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ ok: false, reason: `spawn ssh failed: ${e.message}`, latency_ms: Date.now() - t0 });
    });
  });
}

export default { detect, test, run };
