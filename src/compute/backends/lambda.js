// lambda — Lambda Labs Cloud (GPU rentals, no managed job queue).
// API: https://cloud.lambdalabs.com/api/v1 (instance-types, instances, instance-operations)
// Env: KOLM_LAMBDA_TOKEN (or LAMBDA_API_KEY). run() honestly: lists instances or
// provisions one and returns the SSH handle — Lambda has no programmatic exec API.

import https from 'node:https';

const HOST = 'cloud.lambdalabs.com';
const BASE_PATH = '/api/v1';

function _token() {
  return process.env.KOLM_LAMBDA_TOKEN || process.env.LAMBDA_API_KEY || '';
}

export async function detect() {
  if (!_token()) return { available: false, reason: 'KOLM_LAMBDA_TOKEN env var not set' };
  return { available: true, device: 'lambda-cloud', endpoint: 'https://cloud.lambdalabs.com/api/v1' };
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
      method, host: HOST, path: BASE_PATH + pathname,
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

// Lambda exposes no managed "submit job, get artifact" endpoint. The honest
// thing to do here is: with no command, list running instances; with a
// command, return a clear "you must SSH" handle (we do NOT auto-provision,
// because that spends real money silently). Set env.LAMBDA_PROVISION=1 to
// opt in to launching a new instance.
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  const tok = _token();
  if (!tok) {
    return { ok: false, reason: 'KOLM_LAMBDA_TOKEN not set', next_step: 'export KOLM_LAMBDA_TOKEN=...; see https://cloud.lambdalabs.com/api-keys' };
  }
  const auth = 'Basic ' + Buffer.from(tok + ':').toString('base64');
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };
  // No command: list instances (cheap, no spend).
  if (!command || command.length === 0) {
    let r;
    try { r = await _req('GET', '/instances', headers); }
    catch (e) { return { ok: false, reason: `instances fetch failed: ${e.message}`, latency_ms: Date.now() - t0 }; }
    if (r.status >= 400) {
      return { ok: false, exit_code: 1, stderr: r.text.slice(0, 500), reason: `lambda ${r.status}`, latency_ms: Date.now() - t0 };
    }
    return {
      ok: true, exit_code: 0,
      stdout: r.text,
      stderr: '',
      artifact_url: 'https://cloud.lambdalabs.com/api/v1/instances',
      latency_ms: Date.now() - t0,
      mode: 'list-instances',
      next_step: 'pass command=[...] + env.LAMBDA_PROVISION=1 to launch + SSH manually',
    };
  }
  // Command given but LAMBDA_PROVISION not set: be honest, return the handle.
  if (!env.LAMBDA_PROVISION) {
    return {
      ok: false,
      reason: 'lambda has no managed exec API; kolm only provisions, you SSH',
      next_step: 'set env.LAMBDA_PROVISION=1 + env.LAMBDA_INSTANCE_TYPE=gpu_1x_a100 + env.LAMBDA_SSH_KEY_NAME=<key> to launch',
      mode: 'requires-opt-in',
      latency_ms: Date.now() - t0,
    };
  }
  // Provision: POST /instance-operations/launch and return the IP for SSH.
  const launchBody = {
    region_name: env.LAMBDA_REGION || 'us-west-1',
    instance_type_name: env.LAMBDA_INSTANCE_TYPE || image || 'gpu_1x_a100',
    ssh_key_names: [env.LAMBDA_SSH_KEY_NAME].filter(Boolean),
    quantity: 1,
  };
  if (!launchBody.ssh_key_names.length) {
    return { ok: false, reason: 'LAMBDA_SSH_KEY_NAME required to provision', latency_ms: Date.now() - t0 };
  }
  let launch;
  try { launch = await _req('POST', '/instance-operations/launch', headers, launchBody); }
  catch (e) { return { ok: false, reason: `launch failed: ${e.message}`, latency_ms: Date.now() - t0 }; }
  if (launch.status >= 400) {
    return { ok: false, exit_code: 1, stderr: launch.text.slice(0, 500), reason: `launch ${launch.status}`, latency_ms: Date.now() - t0 };
  }
  let lj; try { lj = JSON.parse(launch.text); } catch { lj = {}; }
  const instanceIds = (lj.data && lj.data.instance_ids) || [];
  return {
    ok: true, exit_code: 0,
    stdout: launch.text,
    stderr: '',
    artifact_url: `https://${HOST}${BASE_PATH}/instances`,
    latency_ms: Date.now() - t0,
    mode: 'provisioned',
    instance_ids: instanceIds,
    next_step: `ssh ubuntu@<ip from /instances/${instanceIds[0]}> '${(command || []).join(' ')}' && curl -X POST /instance-operations/terminate when done`,
  };
}

export default { detect, test, run };
