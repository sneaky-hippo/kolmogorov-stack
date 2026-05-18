// fal — fal.ai serverless inference queue.
// API: https://docs.fal.ai/model-endpoints/queue + https://queue.fal.run/{app_id}
// Env: KOLM_FAL_TOKEN (or FAL_KEY). run() submits to queue, polls, returns result.

import https from 'node:https';

const QUEUE_HOST = 'queue.fal.run';
const POLL_INTERVAL_MS = 1500;

function _token() {
  return process.env.KOLM_FAL_TOKEN || process.env.FAL_KEY || '';
}

export async function detect() {
  if (!_token()) return { available: false, reason: 'KOLM_FAL_TOKEN env var not set' };
  return { available: true, device: 'fal-serverless', endpoint: 'https://fal.run' };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

// Minimal JSON request helper. No external deps; uses node:https.
function _req(method, host, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = https.request({
      method, host, path: pathname,
      headers: { ...(headers || {}), ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode || 0, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// run({ image, command, env, timeoutMs }) — `image` is the fal app id
// (e.g. "fal-ai/any-llm"). `command` becomes the JSON `input` payload via
// env.FAL_INPUT_JSON or falls back to {prompt: command.join(' ')}.
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  const tok = _token();
  if (!tok) {
    return { ok: false, reason: 'KOLM_FAL_TOKEN not set', next_step: 'export KOLM_FAL_TOKEN=...; see https://fal.ai/dashboard/keys' };
  }
  const appId = image || env.FAL_APP_ID || process.env.FAL_APP_ID || 'fal-ai/any-llm';
  let input;
  if (env.FAL_INPUT_JSON) {
    try { input = JSON.parse(env.FAL_INPUT_JSON); }
    catch (e) { return { ok: false, reason: `FAL_INPUT_JSON parse error: ${e.message}` }; }
  } else {
    input = { prompt: Array.isArray(command) ? command.join(' ') : String(command || '') };
  }
  const headers = { Authorization: `Key ${tok}`, 'Content-Type': 'application/json' };
  let submit;
  try {
    submit = await _req('POST', QUEUE_HOST, `/${appId}`, headers, input);
  } catch (e) {
    return { ok: false, reason: `submit fetch failed: ${e.message}`, latency_ms: Date.now() - t0 };
  }
  if (submit.status >= 400) {
    return { ok: false, exit_code: 1, stderr: submit.text.slice(0, 1000), reason: `fal submit ${submit.status}`, latency_ms: Date.now() - t0 };
  }
  let submitJson;
  try { submitJson = JSON.parse(submit.text); } catch { submitJson = {}; }
  const requestId = submitJson.request_id;
  if (!requestId) {
    return { ok: false, reason: 'fal submit returned no request_id', stderr: submit.text.slice(0, 500), latency_ms: Date.now() - t0 };
  }
  // Poll until status terminal or timeout.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let st;
    try { st = await _req('GET', QUEUE_HOST, `/${appId}/requests/${requestId}/status`, headers); }
    catch (e) { return { ok: false, reason: `poll failed: ${e.message}`, latency_ms: Date.now() - t0 }; }
    if (st.status >= 400) {
      return { ok: false, exit_code: 1, stderr: st.text.slice(0, 500), reason: `poll ${st.status}`, latency_ms: Date.now() - t0 };
    }
    let sj; try { sj = JSON.parse(st.text); } catch { sj = {}; }
    if (sj.status === 'COMPLETED') {
      const r2 = await _req('GET', QUEUE_HOST, `/${appId}/requests/${requestId}`, headers);
      return {
        ok: r2.status < 400,
        exit_code: r2.status < 400 ? 0 : 1,
        stdout: r2.text,
        stderr: '',
        artifact_url: `https://${QUEUE_HOST}/${appId}/requests/${requestId}`,
        latency_ms: Date.now() - t0,
        request_id: requestId,
      };
    }
    if (sj.status === 'FAILED' || sj.status === 'ERROR') {
      return { ok: false, exit_code: 1, stderr: st.text.slice(0, 1000), reason: `fal ${sj.status}`, latency_ms: Date.now() - t0 };
    }
  }
  return { ok: false, reason: `timed out after ${timeoutMs}ms`, latency_ms: Date.now() - t0, request_id: requestId };
}

export default { detect, test, run };
