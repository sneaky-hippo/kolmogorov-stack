// src/completions-api.js
//
// Wave Y — OpenAI-compatible chat completions endpoint that bridges
// to either:
//   1. A local kolm artifact      (model = "kolm:<artifact-name>")
//   2. A local kolm artifact path (model = "kolm-path:<absolute-or-relative-path>")
//   3. Anthropic                  (model = "anthropic:<model-id>" or "claude-*")
//   4. OpenAI                     (model = "openai:<model-id>" or "gpt-*")
//
// The point: a tenant can point any existing OpenAI-SDK client (LangChain,
// LlamaIndex, the openai npm package, Continue.dev, Cursor, ChatGPT clones,
// LiteLLM proxies) at this endpoint and silently get a kolm artifact in
// the loop — no SDK changes, no protocol negotiation.
//
// Request shape (subset of openai chat/completions we honor):
//   {
//     model:       string         required
//     messages:    Array<{role, content}>   required (we use the last
//                                          user message as the input)
//     max_tokens:  number         optional (forwarded to upstream when bridging)
//     temperature: number         optional (forwarded to upstream when bridging)
//     stream:      boolean        optional (SSE stream when true)
//     metadata:    {...}          optional (forwarded; we add kolm.path_resolved
//                                          + kolm.artifact_sha256 when we run a
//                                          kolm artifact)
//   }
//
// Response shape (mirrors openai):
//   {
//     id:       "cmpl-...",
//     object:   "chat.completion",
//     created:  unix_seconds,
//     model:    <as-resolved>,
//     choices:  [{index:0, message:{role:"assistant", content:"..."},
//                 finish_reason:"stop", kolm: {/* per-artifact provenance */}}],
//     usage:    {prompt_tokens, completion_tokens, total_tokens},
//     kolm: {                      // present iff we ran a kolm artifact
//       artifact:        string,   // local path
//       artifact_sha256: "sha256:hex",
//       recipe_id:       string,
//       latency_us:      number,
//       k_score:         number|object,
//       receipt:         object,
//     },
//   }
//
// The point of the kolm sub-block is auditability: any client that already
// understood "openai chat completion" now ALSO gets a verifiable provenance
// receipt for the answer. Older clients ignore unknown fields by spec,
// so nothing breaks.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadArtifact, runArtifact } from './artifact-runner.js';

const DEFAULT_REGISTRY_DIRS = [
  // Search paths for "kolm:<name>" lookup. First match wins.
  // The CLI / server can override with opts.registryDirs.
  process.cwd(),
  path.join(process.cwd(), 'examples'),
  path.join(process.cwd(), 'tmp'),
];

// ---------------------------------------------------------------------------
// Public: handleChatCompletion(req, opts) → response object.
//
// `req` is the parsed JSON body. `opts.registryDirs` overrides the kolm:
// search path. `opts.artifactByName` is an optional map from short-name to
// absolute path (highest priority). Streaming is handled separately via
// streamChatCompletion (below) — this entry point returns the full response
// in one shot for non-streaming clients.
// ---------------------------------------------------------------------------
export async function handleChatCompletion(req, opts = {}) {
  validateRequest(req);
  const resolved = await resolveModel(req.model, opts);

  switch (resolved.kind) {
    case 'kolm':
      return await runKolmCompletion(req, resolved, opts);
    case 'anthropic':
      return await runAnthropicCompletion(req, resolved, opts);
    case 'openai':
      return await runOpenAiCompletion(req, resolved, opts);
    default:
      throw apiError(400, 'invalid_model', `unsupported model selector '${req.model}'`);
  }
}

// ---------------------------------------------------------------------------
// Streaming form. Returns an async generator yielding SSE-shaped chunks
// (each chunk a string already prefixed with "data: " and terminated with
// "\n\n"). When the bridge target supports streaming, we forward chunks
// as they arrive; for kolm artifacts (which return a single result in
// sub-millisecond time) we emit ONE delta then the terminator — same shape,
// same parser path, so OpenAI-SDK clients work unchanged.
// ---------------------------------------------------------------------------
export async function* streamChatCompletion(req, opts = {}) {
  validateRequest(req);
  const resolved = await resolveModel(req.model, opts);
  const id = generateId();
  const created = Math.floor(Date.now() / 1000);

  if (resolved.kind === 'kolm') {
    const full = await runKolmCompletion(req, resolved, opts);
    const content = full.choices[0].message.content;
    yield sseLine({
      id, object: 'chat.completion.chunk', created, model: full.model,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
      kolm: full.kolm,
    });
    yield sseLine({
      id, object: 'chat.completion.chunk', created, model: full.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: full.usage,
    });
    yield 'data: [DONE]\n\n';
    return;
  }

  if (resolved.kind === 'anthropic') {
    yield* streamAnthropicCompletion(req, resolved, opts, id, created);
    return;
  }

  if (resolved.kind === 'openai') {
    yield* streamOpenAiCompletion(req, resolved, opts, id, created);
    return;
  }
}

// ---------------------------------------------------------------------------
// Resolve model selector → kind + handle.
// ---------------------------------------------------------------------------
async function resolveModel(model, opts) {
  if (typeof model !== 'string' || !model.length) {
    throw apiError(400, 'invalid_model', 'model field required');
  }

  // Explicit prefixes first.
  if (model.startsWith('kolm-path:')) {
    const p = model.slice('kolm-path:'.length);
    const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    if (!fs.existsSync(abs)) throw apiError(404, 'artifact_not_found', `kolm-path: artifact not found at ${abs}`);
    return { kind: 'kolm', artifactPath: abs, displayModel: model };
  }
  if (model.startsWith('kolm:')) {
    const name = model.slice('kolm:'.length);
    const abs = lookupArtifactByName(name, opts);
    if (!abs) throw apiError(404, 'artifact_not_found', `kolm:${name} not found in registry search path`);
    return { kind: 'kolm', artifactPath: abs, displayModel: model };
  }
  if (model.startsWith('anthropic:') || model.startsWith('claude-')) {
    const id = model.startsWith('anthropic:') ? model.slice('anthropic:'.length) : model;
    return { kind: 'anthropic', modelId: id, displayModel: model };
  }
  if (model.startsWith('openai:') || model.startsWith('gpt-')) {
    const id = model.startsWith('openai:') ? model.slice('openai:'.length) : model;
    return { kind: 'openai', modelId: id, displayModel: model };
  }

  // Bare names — fall back to kolm lookup, then refuse if not found.
  const abs = lookupArtifactByName(model, opts);
  if (abs) return { kind: 'kolm', artifactPath: abs, displayModel: `kolm:${model}` };

  throw apiError(400, 'invalid_model',
    `model '${model}' is not a kolm artifact in the registry, and lacks an anthropic:/openai:/claude-/gpt- prefix`);
}

function lookupArtifactByName(name, opts) {
  if (opts.artifactByName && opts.artifactByName[name]) return opts.artifactByName[name];
  const dirs = opts.registryDirs || DEFAULT_REGISTRY_DIRS;
  for (const d of dirs) {
    try {
      const candidates = [
        path.join(d, `${name}.kolm`),
        path.join(d, name, `${name}.kolm`),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
      // Also scan: any .kolm whose basename matches the requested name.
      if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
        for (const f of fs.readdirSync(d)) {
          if (f === `${name}.kolm`) return path.join(d, f);
        }
      }
    } catch { /* ignore inaccessible dirs */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// kolm path — load the artifact, run it on the last user message's content.
//
// The artifact's recipe.schema.input shapes how we coerce the message
// content. If the recipe expects an object with a `text` field, we wrap
// content into {text:content}; if it expects a string, we pass content
// directly; if structured JSON, we attempt to parse content as JSON and
// fall back to a generic wrap.
// ---------------------------------------------------------------------------
async function runKolmCompletion(req, resolved, _opts) {
  const userMsg = lastUserContent(req.messages);
  if (userMsg == null) throw apiError(400, 'invalid_messages', 'messages must contain at least one user message');

  const bundle = loadArtifact(resolved.artifactPath);
  const input = coerceInputForBundle(userMsg, bundle);
  const t0 = process.hrtime.bigint();
  const result = await runArtifact(resolved.artifactPath, input);
  const latencyUs = Number(process.hrtime.bigint() - t0) / 1000;

  const assistantText = typeof result.output === 'string'
    ? result.output
    : JSON.stringify(result.output);

  const promptTokens = approxTokens(userMsg);
  const completionTokens = approxTokens(assistantText);

  return {
    id: generateId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resolved.displayModel,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: assistantText },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    kolm: {
      artifact: resolved.artifactPath,
      artifact_sha256: sha256File(resolved.artifactPath),
      recipe_id: result.recipe_id,
      recipe_name: result.recipe_name,
      latency_us: Math.round(latencyUs),
      k_score: result.k_score ?? null,
      receipt: result.receipt,
      audit: result.audit,
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic bridge (non-streaming).
// ---------------------------------------------------------------------------
async function runAnthropicCompletion(req, resolved, _opts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw apiError(503, 'upstream_unavailable', 'ANTHROPIC_API_KEY not set; cannot bridge to anthropic');
  let Anthropic;
  try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')); }
  catch (e) { throw apiError(503, 'upstream_unavailable', `@anthropic-ai/sdk not loadable: ${e.message}`); }
  const client = new Anthropic({ apiKey });
  const { systemText, messages } = splitSystem(req.messages);
  const resp = await client.messages.create({
    model: resolved.modelId,
    max_tokens: req.max_tokens || 1024,
    temperature: req.temperature,
    system: systemText || undefined,
    messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: stringifyContent(m.content) })),
  });
  const text = (resp.content || []).map(b => b.text || '').join('');
  return {
    id: resp.id || generateId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resolved.displayModel,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: resp.stop_reason || 'stop' }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
    upstream: { vendor: 'anthropic', model: resolved.modelId },
  };
}

async function* streamAnthropicCompletion(req, resolved, _opts, id, created) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw apiError(503, 'upstream_unavailable', 'ANTHROPIC_API_KEY not set');
  let Anthropic;
  try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')); }
  catch (e) { throw apiError(503, 'upstream_unavailable', `@anthropic-ai/sdk not loadable: ${e.message}`); }
  const client = new Anthropic({ apiKey });
  const { systemText, messages } = splitSystem(req.messages);

  const stream = await client.messages.stream({
    model: resolved.modelId,
    max_tokens: req.max_tokens || 1024,
    temperature: req.temperature,
    system: systemText || undefined,
    messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: stringifyContent(m.content) })),
  });
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      yield sseLine({
        id, object: 'chat.completion.chunk', created, model: resolved.displayModel,
        choices: [{ index: 0, delta: { content: chunk.delta.text }, finish_reason: null }],
      });
    }
  }
  const final = await stream.finalMessage();
  yield sseLine({
    id, object: 'chat.completion.chunk', created, model: resolved.displayModel,
    choices: [{ index: 0, delta: {}, finish_reason: final.stop_reason || 'stop' }],
    usage: {
      prompt_tokens: final.usage?.input_tokens ?? 0,
      completion_tokens: final.usage?.output_tokens ?? 0,
      total_tokens: (final.usage?.input_tokens ?? 0) + (final.usage?.output_tokens ?? 0),
    },
  });
  yield 'data: [DONE]\n\n';
}

// ---------------------------------------------------------------------------
// OpenAI bridge (non-streaming + streaming). We do not require the openai
// SDK as a dep — we hit /v1/chat/completions directly via fetch so anyone
// who set OPENAI_API_KEY gets bridging without npm-installing extra weight.
// ---------------------------------------------------------------------------
async function runOpenAiCompletion(req, resolved, _opts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw apiError(503, 'upstream_unavailable', 'OPENAI_API_KEY not set; cannot bridge to openai');
  const endpoint = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  const body = {
    model: resolved.modelId,
    messages: req.messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
  };
  const r = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw apiError(r.status, 'upstream_error', `openai upstream returned ${r.status}: ${text.slice(0, 200)}`);
  }
  const resp = await r.json();
  return {
    ...resp,
    model: resolved.displayModel,
    upstream: { vendor: 'openai', model: resolved.modelId },
  };
}

async function* streamOpenAiCompletion(req, resolved, _opts, _id, _created) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw apiError(503, 'upstream_unavailable', 'OPENAI_API_KEY not set');
  const endpoint = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  const body = {
    model: resolved.modelId,
    messages: req.messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    stream: true,
  };
  const r = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw apiError(r.status, 'upstream_error', `openai upstream returned ${r.status}: ${text.slice(0, 200)}`);
  }
  // Forward chunks verbatim — openai SSE format is already what our client
  // wants. We rewrite the model field so the client sees "openai:gpt-..."
  // instead of the bare id.
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      if (!chunk.startsWith('data:')) continue;
      const payload = chunk.slice('data:'.length).trim();
      if (payload === '[DONE]') { yield 'data: [DONE]\n\n'; return; }
      try {
        const obj = JSON.parse(payload);
        obj.model = resolved.displayModel;
        yield `data: ${JSON.stringify(obj)}\n\n`;
      } catch {
        yield `${chunk}\n\n`;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// /v1/models — list bridge-able models.
//
// For a tenant pointing their OpenAI SDK at us, this is the first call
// they'll make. We return the kolm artifacts in the search path plus a
// short note for the bridge targets.
// ---------------------------------------------------------------------------
export async function handleListModels(opts = {}) {
  const dirs = opts.registryDirs || DEFAULT_REGISTRY_DIRS;
  const out = [];
  const seen = new Set();
  for (const d of dirs) {
    try {
      if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.kolm')) continue;
        const abs = path.join(d, f);
        const name = f.slice(0, -'.kolm'.length);
        if (seen.has(name)) continue;
        seen.add(name);
        let bundle;
        try { bundle = loadArtifact(abs); } catch { continue; }
        out.push({
          id: `kolm:${name}`,
          object: 'model',
          created: Math.floor(fs.statSync(abs).mtimeMs / 1000),
          owned_by: 'kolm',
          path: abs,
          task: bundle.manifest.task || '',
          k_score: bundle.manifest.k_score?.composite ?? bundle.manifest.k_score ?? null,
          artifact_sha256: sha256File(abs),
        });
      }
    } catch { /* ignore */ }
  }
  // Bridge targets (always advertised even if no key — clients can detect
  // and fall back; the actual call will 503 if the key is missing).
  out.push({ id: 'anthropic:claude-haiku-4-5', object: 'model', created: 0, owned_by: 'anthropic', kind: 'bridge' });
  out.push({ id: 'anthropic:claude-sonnet-4-6', object: 'model', created: 0, owned_by: 'anthropic', kind: 'bridge' });
  out.push({ id: 'anthropic:claude-opus-4-7', object: 'model', created: 0, owned_by: 'anthropic', kind: 'bridge' });
  out.push({ id: 'openai:gpt-5', object: 'model', created: 0, owned_by: 'openai', kind: 'bridge' });
  return { object: 'list', data: out };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
function validateRequest(req) {
  if (!req || typeof req !== 'object') throw apiError(400, 'invalid_request', 'body must be an object');
  if (!req.model) throw apiError(400, 'invalid_request', 'model field required');
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw apiError(400, 'invalid_request', 'messages must be a non-empty array');
  }
}

function lastUserContent(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return stringifyContent(messages[i].content);
  }
  return null;
}

function stringifyContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  // OpenAI's multi-part array form: [{type:'text', text:'...'}, ...]
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

function splitSystem(messages) {
  const sys = messages.filter(m => m.role === 'system').map(m => stringifyContent(m.content)).join('\n\n');
  const rest = messages.filter(m => m.role !== 'system');
  return { systemText: sys, messages: rest };
}

function coerceInputForBundle(text, bundle) {
  // Look at the first recipe's input schema for a hint.
  const r0 = bundle.recipes?.recipes?.[0];
  const schemaIn = r0?.schema?.input;
  if (schemaIn && typeof schemaIn === 'object') {
    // Property-style schema: { type: 'object', properties: { text: {...} } }
    if (schemaIn.properties && typeof schemaIn.properties === 'object') {
      // Try to parse text as JSON object first (caller already passed a
      // structured payload).
      try {
        const j = JSON.parse(text);
        if (j && typeof j === 'object' && !Array.isArray(j)) return j;
      } catch { /* not JSON, continue */ }
      // Single string field? Wrap.
      const propNames = Object.keys(schemaIn.properties);
      if (propNames.length === 1) {
        const only = propNames[0];
        return { [only]: text };
      }
      // Multiple fields — best effort: stuff into 'text' or 'input'.
      if (propNames.includes('text')) return { text };
      if (propNames.includes('input')) return { input: text };
      if (propNames.includes('query')) return { query: text };
      // Last resort: wrap in 'text'.
      return { text };
    }
    // Shorthand: { input: { text: 'string' } } style
    if (typeof schemaIn.text === 'string' || typeof schemaIn.input === 'string') {
      return { text };
    }
  }
  // Default: try to JSON-parse, else wrap in {text}.
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') return j;
  } catch { /* fall through */ }
  return { text };
}

function approxTokens(s) {
  if (!s) return 0;
  // Heuristic: ~4 chars per token (matches OpenAI public guidance for
  // English). For non-English text the number's off, but the field is
  // primarily for billing-shape compatibility, not exact accounting.
  return Math.max(1, Math.ceil(String(s).length / 4));
}

function sseLine(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

function generateId() {
  return 'cmpl-' + crypto.randomBytes(12).toString('hex');
}

function sha256File(p) {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function apiError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.openai_error = { message, type: code, code, param: null };
  return e;
}
