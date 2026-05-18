// vast — Vast.ai marketplace (GPU rentals via SSH, no managed job queue).
// API: https://console.vast.ai/api/v0 (instances, ask_offers, asks)
// Env: KOLM_VAST_TOKEN (or VAST_API_KEY) + SSH key. run() lists instances or
// honestly returns a handle — vast.ai has no programmatic exec API.

import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const HOST = 'console.vast.ai';

function _token() {
  return process.env.KOLM_VAST_TOKEN || process.env.VAST_API_KEY || '';
}

export async function detect() {
  if (!_token()) return { available: false, reason: 'KOLM_VAST_TOKEN env var not set' };
  const sshKey = process.env.KOLM_VAST_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519');
  if (!fs.existsSync(sshKey)) return { available: false, reason: `SSH key not found at ${sshKey}` };
  return { available: true, device: 'vast-ssh', endpoint: 'https://console.vast.ai/api/v0' };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

function _req(method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = https.request({
      method, host: HOST, path: pathname,
      headers: { ...(headers || {}), ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// vast.ai is a rental marketplace, not a job queue. With no command, list
// the user's running instances. With a command + VAST_PROVISION=1, the
// honest path is: the user must already have an instance + SSH to it. We
// surface the instance list so the caller can pick one to SSH into.
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  const tok = _token();
  if (!tok) {
    return { ok: false, reason: 'KOLM_VAST_TOKEN not set', next_step: 'export KOLM_VAST_TOKEN=...; see https://console.vast.ai/account/' };
  }
  const headers = { 'Content-Type': 'application/json' };
  // Vast.ai uses ?api_key=... rather than Authorization header.
  let r;
  try { r = await _req('GET', `/api/v0/instances?api_key=${encodeURIComponent(tok)}`, headers); }
  catch (e) { return { ok: false, reason: `instances fetch failed: ${e.message}`, latency_ms: Date.now() - t0 }; }
  if (r.status >= 400) {
    return { ok: false, exit_code: 1, stderr: r.text.slice(0, 500), reason: `vast ${r.status}`, latency_ms: Date.now() - t0 };
  }
  // No command: just return the instance list.
  if (!command || command.length === 0) {
    return {
      ok: true, exit_code: 0,
      stdout: r.text,
      stderr: '',
      artifact_url: `https://${HOST}/api/v0/instances`,
      latency_ms: Date.now() - t0,
      mode: 'list-instances',
      next_step: 'ssh root@<ssh_host>:<ssh_port> -i ~/.ssh/id_ed25519 from /instances response',
    };
  }
  // Command given: parse instance list, build copy-pasteable SSH command per running one.
  let inst; try { inst = JSON.parse(r.text); } catch { inst = {}; }
  const rows = inst.instances || [];
  const ssh = rows
    .filter((row) => row.actual_status === 'running' && row.ssh_host && row.ssh_port)
    .map((row) => `ssh -p ${row.ssh_port} root@${row.ssh_host} '${(command || []).join(' ')}'`);
  return {
    ok: ssh.length > 0,
    exit_code: ssh.length > 0 ? 0 : 1,
    stdout: ssh.join('\n'),
    stderr: ssh.length === 0 ? `no running instances (have ${rows.length} total)` : '',
    artifact_url: `https://${HOST}/api/v0/instances`,
    latency_ms: Date.now() - t0,
    mode: 'ssh-handles',
    instance_count: rows.length,
    next_step: 'vast.ai has no exec API — copy one ssh line and run it manually',
  };
}

export default { detect, test, run };
