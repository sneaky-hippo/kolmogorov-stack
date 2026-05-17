// workers/distill/teacher-bridge.mjs
//
// Shared teacher-API client for the kolm distillation worker. Bridges the
// abstract { vendor, model, input, system } shape to the actual transport
// for Anthropic, OpenAI, and any local OpenAI-compatible endpoint (vLLM,
// TGI, llama.cpp server, ollama).
//
// EVERY teacher call is wrapped in src/phi-redactor.js automatically when
// `opts.redact === true` (the default). Caller receives:
//   { response, teacher_call_log_entry, redaction_map_hash }
// so the caller can extend the receipt chain per Doc 7 §3.4.
//
// Non-goals:
//   - No retry/backoff sophistication (caller decides).
//   - No streaming (the distill worker collects whole responses; latency
//     doesn't matter for offline collection).

import crypto from 'node:crypto';
import path from 'node:path';
import url from 'node:url';
import { fileURLToPath } from 'node:url';

import { VENDOR_PROFILES, isKnownVendor, isKnownModelFor } from './catalog.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Resolve the redactor relative to the worker package so the worker stays
// self-contained even when copied to a sandbox/venv.
async function loadRedactor() {
  const p = path.resolve(__dirname, '..', '..', 'src', 'phi-redactor.js');
  return await import(url.pathToFileURL(p).href);
}

// Public: call the configured teacher with optional PHI redaction.
//   opts.vendor:  'anthropic' | 'openai' | 'local'
//   opts.model:   string                   (model id; vendor-specific)
//   opts.system:  string                   (system prompt)
//   opts.input:   string                   (user message body)
//   opts.redact:  boolean (default true)   wrap call in src/phi-redactor.js
//   opts.maxTokens: number (default 1024)
//   opts.localEndpoint: string             (OpenAI-compatible base, for vendor=local)
//   opts.localApiKey:   string             (optional Bearer for local endpoint)
// Returns:
//   { response: string, redaction_map_hash: string, teacher_call_log_entry: object }
export async function callTeacher(opts) {
  const {
    vendor, model, input, system = '',
    redact = true, maxTokens = 1024,
    localEndpoint, localApiKey,
  } = opts;
  if (!vendor || !model || !input) {
    throw new Error('callTeacher requires {vendor, model, input}');
  }

  let redactedInput = input;
  let redactedSystem = system;
  let inputMap = {};
  let systemMap = {};
  let map_hash = 'sha256:' + crypto.createHash('sha256').update('').digest('hex');
  if (redact) {
    const { redact: doRedact, mapHash } = await loadRedactor();
    const r1 = doRedact(input);
    redactedInput = r1.redacted;
    inputMap = r1.map;
    if (system) {
      const r2 = doRedact(system);
      redactedSystem = r2.redacted;
      systemMap = r2.map;
    }
    map_hash = mapHash({ ...inputMap, ...systemMap });
  }

  const requestSummary = {
    vendor,
    model,
    redact,
    input_chars: redactedInput.length,
    system_chars: redactedSystem.length,
    started_at: Date.now(),
  };

  let response = '';
  if (vendor === 'anthropic') {
    response = await callAnthropic({ model, system: redactedSystem, input: redactedInput, maxTokens });
  } else if (vendor === 'openai') {
    response = await callOpenAI({ model, system: redactedSystem, input: redactedInput, maxTokens });
  } else if (vendor === 'google') {
    response = await callGoogle({ model, system: redactedSystem, input: redactedInput, maxTokens });
  } else if (vendor === 'xai') {
    response = await callXAI({ model, system: redactedSystem, input: redactedInput, maxTokens });
  } else if (vendor === 'local') {
    response = await callLocal({ endpoint: localEndpoint, apiKey: localApiKey, model, system: redactedSystem, input: redactedInput, maxTokens });
  } else {
    throw new Error(`unknown teacher vendor: ${vendor}`);
  }

  // Reinject identifiers so the caller gets a "real" teacher response, but
  // we keep the REDACTED-input copy in the call log for compliance replay.
  let reinjected = response;
  if (redact) {
    const { reinject } = await loadRedactor();
    reinjected = reinject(response, { ...inputMap, ...systemMap });
  }

  return {
    response: reinjected,
    redaction_map_hash: map_hash,
    teacher_call_log_entry: {
      ...requestSummary,
      ended_at: Date.now(),
      // Note: we log the REDACTED prompt + the REDACTED response so the log
      // itself contains zero PHI and can be checked into a tenant's audit
      // trail. The reverse map stays out of the log (it's in the receipt
      // chain via redaction_map_hash only — never the values).
      redacted_input: redactedInput,
      redacted_system: redactedSystem,
      redacted_response: response,
      response_chars: response.length,
    },
  };
}

async function callAnthropic({ model, system, input, maxTokens }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY required for vendor=anthropic');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  const resp = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: system || undefined,
    messages: [{ role: 'user', content: input }],
  });
  const block = (resp.content || []).find(b => b.type === 'text');
  return block ? block.text : '';
}

async function callOpenAI({ model, system, input, maxTokens }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY required for vendor=openai');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: input });
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 400)}`);
  }
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

// Google Gemini native API. The generateContent endpoint takes a different
// shape from OpenAI-chat. System is folded into systemInstruction; user
// message becomes the single content part. Auth is x-goog-api-key header.
async function callGoogle({ model, system, input, maxTokens }) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY required for vendor=google');
  const body = {
    contents: [{ role: 'user', parts: [{ text: input }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (system) body.systemInstruction = { role: 'system', parts: [{ text: system }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Google ${res.status}: ${txt.slice(0, 400)}`);
  }
  const j = await res.json();
  const parts = j.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('');
}

// xAI Grok ships an OpenAI-compatible /v1/chat/completions at api.x.ai.
async function callXAI({ model, system, input, maxTokens }) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('XAI_API_KEY required for vendor=xai');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: input });
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`xAI ${res.status}: ${txt.slice(0, 400)}`);
  }
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

async function callLocal({ endpoint, apiKey, model, system, input, maxTokens }) {
  if (!endpoint) throw new Error('localEndpoint required for vendor=local');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: input });
  const base = endpoint.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`local teacher ${res.status}: ${txt.slice(0, 400)}`);
  }
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

// Public: split a vendor:model spec string. "anthropic:claude-opus-4-7" ->
// { vendor: 'anthropic', model: 'claude-opus-4-7' }. Bare strings default
// to anthropic.
//
// Wave 158 — opts.strict (default true) enforces the cross-vendor catalog:
//   - vendor must be in VENDORS
//   - model must be in VENDOR_PROFILES[vendor].models (or local, where any
//     model id is accepted because the OpenAI-compatible server enforces).
// Set strict=false to bypass for tests that exercise the parser without
// committing to a known SKU.
export function parseTeacherSpec(spec, opts = {}) {
  const strict = opts.strict !== false;
  if (!spec) throw new Error('teacher spec required (e.g., anthropic:claude-opus-4-7)');
  const i = spec.indexOf(':');
  const vendor = i < 0 ? 'anthropic' : spec.slice(0, i).toLowerCase();
  const model  = i < 0 ? spec : spec.slice(i + 1);
  if (strict) {
    if (!isKnownVendor(vendor)) {
      throw new Error(`unknown teacher vendor "${vendor}"; expected one of: ${Object.keys(VENDOR_PROFILES).join(', ')}`);
    }
    if (!isKnownModelFor(vendor, model)) {
      const known = VENDOR_PROFILES[vendor].models;
      const hint = known === null ? '(local accepts any model)' : `expected one of: ${known.join(', ')}`;
      throw new Error(`unknown model "${model}" for vendor "${vendor}"; ${hint}`);
    }
  }
  return { vendor, model };
}
