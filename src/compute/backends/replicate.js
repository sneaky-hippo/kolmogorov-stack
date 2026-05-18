// replicate — Replicate Cog containers via predictions API.
// API: https://replicate.com/docs/reference/http#predictions.create
// Env: KOLM_REPLICATE_TOKEN (or REPLICATE_API_TOKEN). run() POSTs prediction, polls until terminal.

import https from 'node:https';

const HOST = 'api.replicate.com';
const POLL_INTERVAL_MS = 2000;

function _token() {
  return process.env.KOLM_REPLICATE_TOKEN || process.env.REPLICATE_API_TOKEN || '';
}

export async function detect() {
  if (!_token()) return { available: false, reason: 'KOLM_REPLICATE_TOKEN env var not set' };
  return { available: true, device: 'replicate-cog', endpoint: 'https://api.replicate.com/v1' };
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

// run({ image, command, env, timeoutMs }) — `image` is the Replicate model
// version hash (e.g. "stability-ai/sdxl:7762fd07..."). `command` becomes the
// JSON `input` payload via env.REPLICATE_INPUT_JSON or {prompt: command.join(' ')}.
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  const tok = _token();
  if (!tok) {
    return { ok: false, reason: 'KOLM_REPLICATE_TOKEN not set', next_step: 'export KOLM_REPLICATE_TOKEN=...; see https://replicate.com/account/api-tokens' };
  }
  if (!image) {
    return { ok: false, reason: 'replicate.run requires image (model version hash like owner/name:hash)', next_step: 'pass image="owner/model:version_hash"' };
  }
  let input;
  if (env.REPLICATE_INPUT_JSON) {
    try { input = JSON.parse(env.REPLICATE_INPUT_JSON); }
    catch (e) { return { ok: false, reason: `REPLICATE_INPUT_JSON parse error: ${e.message}` }; }
  } else {
    input = { prompt: Array.isArray(command) ? command.join(' ') : String(command || '') };
  }
  // Accept both shapes: "owner/name:version" or bare "version".
  const versionHash = image.includes(':') ? image.split(':').pop() : image;
  const headers = { Authorization: `Token ${tok}`, 'Content-Type': 'application/json' };
  let submit;
  try {
    submit = await _req('POST', '/v1/predictions', headers, { version: versionHash, input });
  } catch (e) {
    return { ok: false, reason: `submit fetch failed: ${e.message}`, latency_ms: Date.now() - t0 };
  }
  if (submit.status >= 400) {
    return { ok: false, exit_code: 1, stderr: submit.text.slice(0, 1000), reason: `replicate submit ${submit.status}`, latency_ms: Date.now() - t0 };
  }
  let sj; try { sj = JSON.parse(submit.text); } catch { sj = {}; }
  const id = sj.id;
  if (!id) {
    return { ok: false, reason: 'replicate submit returned no id', stderr: submit.text.slice(0, 500), latency_ms: Date.now() - t0 };
  }
  // Poll prediction status.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let st;
    try { st = await _req('GET', `/v1/predictions/${id}`, headers); }
    catch (e) { return { ok: false, reason: `poll failed: ${e.message}`, latency_ms: Date.now() - t0 }; }
    if (st.status >= 400) {
      return { ok: false, exit_code: 1, stderr: st.text.slice(0, 500), reason: `poll ${st.status}`, latency_ms: Date.now() - t0 };
    }
    let pj; try { pj = JSON.parse(st.text); } catch { pj = {}; }
    if (pj.status === 'succeeded') {
      return {
        ok: true, exit_code: 0,
        stdout: typeof pj.output === 'string' ? pj.output : JSON.stringify(pj.output),
        stderr: pj.logs || '',
        artifact_url: (pj.urls && pj.urls.get) || `https://api.replicate.com/v1/predictions/${id}`,
        latency_ms: Date.now() - t0,
        prediction_id: id,
      };
    }
    if (['failed', 'canceled'].includes(pj.status)) {
      return { ok: false, exit_code: 1, stderr: pj.error || pj.logs || '', reason: `replicate ${pj.status}`, latency_ms: Date.now() - t0, prediction_id: id };
    }
  }
  return { ok: false, reason: `timed out after ${timeoutMs}ms`, latency_ms: Date.now() - t0, prediction_id: id };
}

export default { detect, test, run };
