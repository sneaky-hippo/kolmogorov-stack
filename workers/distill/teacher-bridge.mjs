// workers/distill/teacher-bridge.mjs
//
// Shared teacher-API client for the kolm distillation worker. Bridges the
// abstract { vendor, model, input, system } shape to the actual transport
// for Anthropic, OpenAI, Google, xAI, and any local OpenAI-compatible
// endpoint (vLLM, TGI, llama.cpp server, ollama).
//
// W292 contract — fail-closed on PHI:
//   1. CLOUD_VENDORS is the canonical set of outbound vendors. Calling any
//      of them with redact:false throws BEFORE any network I/O — no opt-out
//      for cloud, only for local.
//   2. Every redact pass uses src/phi-redactor.js redactPhi(); if the
//      redactor returns safe_to_send=false the bridge throws and never
//      calls the vendor.
//   3. When opts.encryptionKey (32-byte Buffer or 64-char hex) is supplied,
//      the redaction map is encrypted with AES-256-GCM and returned as
//      encrypted_redaction_map; the plaintext map is NEVER returned.
//
// EVERY teacher call is wrapped in src/phi-redactor.js automatically when
// `opts.redact === true` (the default). Caller receives:
//   { response, teacher_call_log_entry, redaction_map_hash,
//     encrypted_redaction_map?  // present iff opts.encryptionKey supplied
//   }
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

// W292 — the four cloud vendors. Any input destined for one of these MUST
// pass through the redactor; opting out is forbidden.
export const CLOUD_VENDORS = Object.freeze(['anthropic', 'openai', 'google', 'xai']);

// Resolve the redactor relative to the worker package so the worker stays
// self-contained even when copied to a sandbox/venv.
async function loadRedactor() {
  const p = path.resolve(__dirname, '..', '..', 'src', 'phi-redactor.js');
  return await import(url.pathToFileURL(p).href);
}

function _coerceKey(k) {
  if (Buffer.isBuffer(k)) {
    if (k.length !== 32) throw new Error('encryptionKey must be 32 bytes (AES-256-GCM)');
    return k;
  }
  if (typeof k === 'string') {
    const b = Buffer.from(k, 'hex');
    if (b.length !== 32) throw new Error('encryptionKey hex must decode to 32 bytes');
    return b;
  }
  throw new Error('encryptionKey must be a 32-byte Buffer or 64-char hex string');
}

// W292 — AES-256-GCM the map. Returns a JSON-safe block carrying ciphertext,
// iv, tag, alg, and key_hash so an auditor can confirm WHICH key was used
// without exposing the key.
export function encryptRedactionMap(plainMap, key) {
  const k = _coerceKey(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plainMap), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('hex'),
    ciphertext: ct.toString('hex'),
    tag: tag.toString('hex'),
    key_hash: 'sha256:' + crypto.createHash('sha256').update(k).digest('hex'),
  };
}

// W292 — round-trip helper for tenants/auditors holding the same key.
export function decryptRedactionMap(enc, key) {
  if (!enc || enc.alg !== 'aes-256-gcm') throw new Error('unsupported alg');
  const k = _coerceKey(key);
  const iv = Buffer.from(enc.iv, 'hex');
  const ct = Buffer.from(enc.ciphertext, 'hex');
  const tag = Buffer.from(enc.tag, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
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
    encryptionKey,            // W292 — encrypt redaction map at rest
    redactorOverride,         // test seam — function(string) -> redactPhi result
    transportOverride,        // test seam — function({vendor,model,system,input,maxTokens}) -> string
  } = opts;
  if (!vendor || !model || !input) {
    throw new Error('callTeacher requires {vendor, model, input}');
  }

  // W292 fail-closed #1 — no opt-out of redaction for cloud vendors.
  if (!redact && CLOUD_VENDORS.includes(vendor)) {
    throw new Error(
      `fail-closed: PHI redaction cannot be disabled for cloud vendor '${vendor}'. ` +
      `redact:false is only honored for vendor='local'. ` +
      `Refusing to send raw prompt to ${vendor} without redaction.`
    );
  }

  let redactedInput = input;
  let redactedSystem = system;
  let inputMap = {};
  let systemMap = {};
  let map_hash = 'sha256:' + crypto.createHash('sha256').update('').digest('hex');
  let combinedFindings = [];
  let combinedSafe = true;
  if (redact) {
    const phi = redactorOverride ? null : await loadRedactor();
    const doRedactPhi = redactorOverride || phi.redactPhi;
    const r1 = doRedactPhi(input);
    redactedInput = r1.redacted_text;
    inputMap = r1.map || {};
    combinedFindings = combinedFindings.concat(r1.findings || []);
    if (r1.safe_to_send === false) combinedSafe = false;
    if (system) {
      const r2 = doRedactPhi(system);
      redactedSystem = r2.redacted_text;
      systemMap = r2.map || {};
      combinedFindings = combinedFindings.concat(r2.findings || []);
      if (r2.safe_to_send === false) combinedSafe = false;
    }
    // W292 fail-closed #2 — refuse to send when the redactor flags anything
    // as not safe_to_send (e.g., partially-recognized PHI it could not fully
    // mask). Throw BEFORE we call the vendor.
    if (!combinedSafe) {
      const critical = combinedFindings.filter(f => f && f.safe_to_send === false);
      throw new Error(
        `fail-closed: PHI redactor reports unsafe content (${critical.length} unsafe finding(s)). ` +
        `Refusing to send to vendor '${vendor}'. ` +
        `Caller must remediate the input or use a stricter redactor before retry.`
      );
    }
    const mapHashFn = redactorOverride
      ? (m) => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(m || {})).digest('hex')
      : phi.mapHash;
    map_hash = mapHashFn({ ...inputMap, ...systemMap });
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
  if (transportOverride) {
    response = await transportOverride({ vendor, model, system: redactedSystem, input: redactedInput, maxTokens, localEndpoint, localApiKey });
  } else if (vendor === 'anthropic') {
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
  if (redact && !redactorOverride) {
    const { reinject } = await loadRedactor();
    reinjected = reinject(response, { ...inputMap, ...systemMap });
  }

  const out = {
    response: reinjected,
    redaction_map_hash: map_hash,
    teacher_call_log_entry: {
      ...requestSummary,
      ended_at: Date.now(),
      // We log the REDACTED prompt + the REDACTED response so the log itself
      // contains zero PHI and can be checked into a tenant's audit trail. The
      // reverse map stays out of the log (it's in the receipt chain via
      // redaction_map_hash only — never the values).
      redacted_input: redactedInput,
      redacted_system: redactedSystem,
      redacted_response: response,
      response_chars: response.length,
      findings_count: combinedFindings.length,
    },
  };
  // W292 fail-closed #3 — when encryption is requested, emit the encrypted
  // block and DO NOT include the plaintext map anywhere on the response.
  if (encryptionKey) {
    out.encrypted_redaction_map = encryptRedactionMap({ ...inputMap, ...systemMap }, encryptionKey);
  }
  return out;
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
