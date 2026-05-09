// Capture proxy — drop-in replacement for Anthropic / OpenAI APIs that
// records (input, output, latency_us, model, namespace, tenant) tuples on
// every call. The customer points OPENAI_BASE_URL or ANTHROPIC_API_URL at
// `https://kolm.ai/v1/capture/<provider>` and passes their own provider key
// in the `x-upstream-api-key` header (we strip + forward it).
//
// The captured corpus is queryable via `/v1/labels/synthesize-corpus` as
// JSONL or parquet, then promoted to a recipe via the existing
// `/v1/bridges/auto-synthesize` path or distilled to a local LoRA via
// `/v1/specialists/auto-distill` (REM Labs bridge).
//
// We never train on the customer's data without consent. The artifact
// produced by distill ships to the customer; no copy is retained.

import crypto from 'node:crypto';

const ANTHROPIC_DEFAULT = 'https://api.anthropic.com/v1/messages';
const OPENAI_DEFAULT = 'https://api.openai.com/v1/chat/completions';

export function pickAnthropicUpstream() {
  return process.env.ANTHROPIC_UPSTREAM_URL || ANTHROPIC_DEFAULT;
}

export function pickOpenAIUpstream() {
  return process.env.OPENAI_UPSTREAM_URL || OPENAI_DEFAULT;
}

// Sanitize the namespace label. We allow a-z, 0-9, dash, dot, underscore;
// disallow consecutive dots and leading/trailing dots so a namespace can't
// look like a path-traversal token. Empty -> 'default'.
export function sanitizeNamespace(raw) {
  let s = String(raw || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  s = s.replace(/\.+/g, '').slice(0, 64);
  return s || 'default';
}

// Distill the inbound request body into a single canonical "prompt" string we
// hash for clustering. We deliberately drop config fields (temperature, max
// tokens, etc.) so identical user intent across different sampling configs
// clusters together.
export function extractPromptForCapture(body, provider) {
  if (!body || typeof body !== 'object') return '';
  if (provider === 'anthropic') {
    const sys = typeof body.system === 'string' ? body.system : '';
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const turns = messages.map(m => {
      if (!m) return '';
      const role = m.role || 'user';
      const content = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => (c && (c.text || c.content)) || '').join('\n')
          : '';
      return `${role}: ${content}`;
    }).filter(Boolean).join('\n\n');
    return [sys ? `system: ${sys}` : '', turns].filter(Boolean).join('\n\n');
  }
  if (provider === 'openai') {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return messages.map(m => {
      const role = m && m.role || 'user';
      const content = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => (c && (c.text || c.content)) || '').join('\n')
          : '';
      return `${role}: ${content}`;
    }).join('\n\n');
  }
  return '';
}

// Pull the model output text out of a provider response.
export function extractCompletionText(json, provider) {
  if (!json || typeof json !== 'object') return '';
  if (provider === 'anthropic') {
    const blocks = Array.isArray(json.content) ? json.content : [];
    return blocks.map(b => (b && b.text) || '').join('').trim();
  }
  if (provider === 'openai') {
    const choices = Array.isArray(json.choices) ? json.choices : [];
    const first = choices[0] || {};
    const msg = first.message || {};
    if (typeof msg.content === 'string') return msg.content.trim();
    if (Array.isArray(msg.content)) {
      return msg.content.map(c => (c && c.text) || '').join('').trim();
    }
    return String(first.text || '').trim();
  }
  return '';
}

export function modelFromBody(body, provider) {
  if (!body || typeof body !== 'object') return '';
  if (provider === 'anthropic') return String(body.model || '').slice(0, 128);
  if (provider === 'openai') return String(body.model || '').slice(0, 128);
  return '';
}

// Forward to the upstream provider. The customer's own provider key
// arrives in `x-upstream-api-key`; we use it and never log it.
export async function forwardAnthropic({ url, body, upstreamKey, anthropicVersion }) {
  if (!upstreamKey) {
    return { status: 401, json: { error: { type: 'no_upstream_key', message: 'pass your Anthropic key in x-upstream-api-key' } } };
  }
  const t0 = process.hrtime.bigint();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': upstreamKey,
      'anthropic-version': anthropicVersion || '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  const elapsed_us = Math.round(Number(process.hrtime.bigint() - t0) / 1000);
  return { status: res.status, json, elapsed_us };
}

export async function forwardOpenAI({ url, body, upstreamKey }) {
  if (!upstreamKey) {
    return { status: 401, json: { error: { type: 'no_upstream_key', message: 'pass your OpenAI key in x-upstream-api-key' } } };
  }
  const t0 = process.hrtime.bigint();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${upstreamKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  const elapsed_us = Math.round(Number(process.hrtime.bigint() - t0) / 1000);
  return { status: res.status, json, elapsed_us };
}

// Hash the prompt to detect duplicate captures (the customer hitting "send"
// twice on the same input in two seconds).
export function promptHash(prompt) {
  return crypto.createHash('sha256').update(prompt || '', 'utf8').digest('hex').slice(0, 16);
}
