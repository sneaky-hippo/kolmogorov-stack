// src/llm-call.js
//
// Generic LLM caller. OpenAI-compatible chat-completions API by default
// (covers OpenAI, together.ai, deepseek, groq, openrouter, any vLLM /
// LM-Studio / ollama instance running in OpenAI-compat mode). Native
// Anthropic Messages API when KOLM_LLM_PROVIDER=anthropic.
//
// Configuration via environment variables (all optional — `isConfigured()`
// returns false when no key/url is set so callers can deterministically
// fall back to a non-network path):
//
//   KOLM_LLM_PROVIDER   one of: openai (default) | anthropic | ollama
//                       | together | deepseek | groq | openrouter | custom
//   KOLM_LLM_BASE_URL   API base URL. Defaults per provider:
//                         openai      → https://api.openai.com/v1
//                         anthropic   → https://api.anthropic.com/v1
//                         ollama      → http://127.0.0.1:11434/v1
//                         together    → https://api.together.xyz/v1
//                         deepseek    → https://api.deepseek.com/v1
//                         groq        → https://api.groq.com/openai/v1
//                         openrouter  → https://openrouter.ai/api/v1
//   KOLM_LLM_KEY        Bearer token. Ollama defaults to local + no key.
//   KOLM_LLM_MODEL      Model id. Provider-dependent default if unset.
//   KOLM_LLM_TIMEOUT_MS Per-request timeout (default 30000).
//   KOLM_LLM_RETRIES    Transient-error retry count (default 2).
//
// Public surface:
//   isConfigured()  → bool
//   describeConfig() → {provider, base_url, model, has_key, configured}
//   callLLM({system, user, maxTokens, temperature, signal}) → {text, raw}
//   generateVariations({seed, count, hint}) → [{input, output}]   (concurrency 4)

const PROVIDER_DEFAULTS = {
  openai:      { base: 'https://api.openai.com/v1',        model: 'gpt-4o-mini',         needsKey: true  },
  anthropic:   { base: 'https://api.anthropic.com/v1',     model: 'claude-opus-4-7',     needsKey: true  },
  ollama:      { base: 'http://127.0.0.1:11434/v1',        model: 'llama3.2',            needsKey: false },
  together:    { base: 'https://api.together.xyz/v1',      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', needsKey: true },
  deepseek:    { base: 'https://api.deepseek.com/v1',      model: 'deepseek-chat',       needsKey: true  },
  groq:        { base: 'https://api.groq.com/openai/v1',   model: 'llama-3.1-8b-instant', needsKey: true },
  openrouter:  { base: 'https://openrouter.ai/api/v1',     model: 'openai/gpt-4o-mini',  needsKey: true  },
  custom:      { base: '',                                  model: '',                    needsKey: false },
};

function resolveConfig() {
  const provider = (process.env.KOLM_LLM_PROVIDER || 'openai').toLowerCase();
  const def = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.custom;
  const base_url = process.env.KOLM_LLM_BASE_URL || def.base || '';
  const key = process.env.KOLM_LLM_KEY || '';
  const model = process.env.KOLM_LLM_MODEL || def.model || '';
  const timeout_ms = Number(process.env.KOLM_LLM_TIMEOUT_MS || 30000);
  const retries = Math.max(0, Number(process.env.KOLM_LLM_RETRIES || 2));
  const hasKey = key.length > 0;
  // Configured = the call has somewhere to go AND, when required, a key.
  // ollama / custom-with-base-url can run without a key.
  const configured = !!base_url && (!def.needsKey || hasKey);
  return { provider, base_url, key, model, timeout_ms, retries, has_key: hasKey, configured };
}

export function isConfigured() {
  return resolveConfig().configured;
}

export function describeConfig() {
  const c = resolveConfig();
  return {
    provider: c.provider,
    base_url: c.base_url,
    model: c.model,
    has_key: c.has_key,
    configured: c.configured,
  };
}

// Per-attempt one-shot call. Retries are handled by the outer wrapper.
async function oneShot({ provider, base_url, key, model, system, user, maxTokens, temperature, timeout_ms, signal }) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(), timeout_ms);
  try {
    if (provider === 'anthropic') {
      const url = base_url.replace(/\/+$/, '') + '/messages';
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          system: system || undefined,
          messages: [{ role: 'user', content: user }],
        }),
        signal: ctl.signal,
      });
      const raw = await resp.json().catch(() => ({}));
      if (!resp.ok) throw httpError(resp.status, raw);
      const text = Array.isArray(raw.content)
        ? raw.content.map((b) => b.text || '').join('')
        : '';
      return { text, raw };
    }
    // OpenAI-compatible chat-completions for every other provider.
    const url = base_url.replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      }),
      signal: ctl.signal,
    });
    const raw = await resp.json().catch(() => ({}));
    if (!resp.ok) throw httpError(resp.status, raw);
    const text = raw?.choices?.[0]?.message?.content || '';
    return { text, raw };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function httpError(status, body) {
  const msg = body?.error?.message || body?.error || body?.message || `HTTP ${status}`;
  const err = new Error(`llm_http_${status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  err.status = status;
  err.transient = status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
  return err;
}

export async function callLLM({ system = '', user, maxTokens = 1024, temperature = 0.3, signal } = {}) {
  if (!user) throw new Error('callLLM: user prompt required');
  const c = resolveConfig();
  if (!c.configured) throw new Error('llm_not_configured');
  let lastErr;
  for (let attempt = 0; attempt <= c.retries; attempt++) {
    try {
      return await oneShot({
        provider: c.provider,
        base_url: c.base_url,
        key: c.key,
        model: c.model,
        system, user, maxTokens, temperature,
        timeout_ms: c.timeout_ms,
        signal,
      });
    } catch (e) {
      lastErr = e;
      const isAbort = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
      // Retry on transient HTTP and on network-level (no status) errors.
      const transient = (e && e.transient) || (!e?.status && !isAbort);
      if (!transient || attempt === c.retries) break;
      // Bounded exponential backoff: 100ms, 200ms, 400ms ...
      const wait = 100 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr || new Error('llm_unknown_error');
}

// Try to extract a JSON array from arbitrary model text. Models often wrap
// JSON in prose or markdown fences; this is the smallest robust extractor
// that handles both. Returns null when nothing parses.
function extractJsonArray(text) {
  if (!text) return null;
  // Strip fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  // Greedy bracketed-slice fallback: first [ to last ].
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  const slice = candidate.slice(start, end + 1);
  try {
    const arr = JSON.parse(slice);
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
}

// generateVariations({seed, count, hint}) — calls the LLM to fan out a
// single (input, output) seed pair into `count` semantically-equivalent
// variations. Concurrency 4 — splits the request into ceil(count/4)
// batches so we stay polite with rate-limited APIs but still finish in
// reasonable wall time. Each batch returns up to ~6 rows; we trim to the
// requested count. Caller is responsible for the deterministic fallback
// when isConfigured() returns false.
export async function generateVariations({ seed, count = 10, hint = '' } = {}) {
  if (!isConfigured()) throw new Error('llm_not_configured');
  if (!seed || typeof seed !== 'object') throw new Error('generateVariations: seed required');
  if (count < 1) return [];
  const system = 'You expand a single labeled training example into N semantically-equivalent variations. '
    + 'Each variation must preserve the input -> output mapping (same task, same answer shape). '
    + 'Output ONLY a JSON array. No prose. Each element is {"input": string, "output": string}.';
  const perBatch = Math.min(8, Math.max(2, Math.ceil(count / 4)));
  const batches = Math.ceil(count / perBatch);
  const buildUser = (n, batchIdx) => {
    const seedJson = JSON.stringify({
      input: typeof seed.input === 'string' ? seed.input : JSON.stringify(seed.input),
      output: typeof seed.output === 'string' ? seed.output : JSON.stringify(seed.output),
    }, null, 2);
    return `SEED PAIR (input -> output mapping to preserve):
${seedJson}

${hint ? `HINT: ${hint}\n` : ''}Generate exactly ${n} semantically-equivalent variations.
Vary phrasing, syntax, and surface form of the INPUT while preserving the underlying task.
Keep the OUTPUT shape identical to the seed (same JSON keys / same answer kind / same level of detail).
Batch index: ${batchIdx + 1}/${batches} — make this batch DISTINCT from other batches (vary along a different axis).

Output ONLY the JSON array.`;
  };
  // Concurrency 4 across batches.
  const out = [];
  const indexes = Array.from({ length: batches }, (_, i) => i);
  const limit = Math.min(4, batches);
  let cursor = 0;
  async function worker() {
    while (cursor < indexes.length) {
      const idx = indexes[cursor++];
      const n = Math.min(perBatch, count - idx * perBatch);
      if (n <= 0) break;
      try {
        const { text } = await callLLM({
          system,
          user: buildUser(n, idx),
          maxTokens: 1024,
          temperature: 0.5 + (idx % 3) * 0.1,
        });
        const arr = extractJsonArray(text) || [];
        for (const row of arr) {
          if (!row || typeof row !== 'object') continue;
          const inp = typeof row.input === 'string' ? row.input : (row.input != null ? JSON.stringify(row.input) : null);
          const outp = typeof row.output === 'string' ? row.output : (row.output != null ? JSON.stringify(row.output) : null);
          if (inp && outp) out.push({ input: inp, output: outp });
        }
      } catch (_) {
        // Per-batch failure is non-fatal; other batches keep going.
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return out.slice(0, count);
}

export default { isConfigured, describeConfig, callLLM, generateVariations };
