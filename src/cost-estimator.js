// W368 cost estimator.
//
// Given (provider, model, prompt_tokens, completion_tokens) return the USD
// cost from PROVIDERS[provider].cost_per_1k[model]. Unknown model → 0 (we
// never invent fake costs; the row is still written with cost=0 so the
// downstream dashboard can highlight the gap).
//
// Models in OpenRouter sometimes carry the publisher prefix
// ("anthropic/claude-sonnet-4-6"); we look up the full key first, then fall
// back to the bare model name, so both spellings work.

import { PROVIDERS } from './provider-registry.js';

export function estimateCost({ provider, model, prompt_tokens, completion_tokens }) {
  const pcfg = PROVIDERS[provider];
  if (!pcfg || !pcfg.cost_per_1k) return 0;
  const table = pcfg.cost_per_1k;
  const key = String(model || '');
  let row = table[key];
  if (!row && key.includes('/')) {
    const bare = key.split('/').pop();
    row = table[bare];
  }
  if (!row && key) {
    // Fuzzy fallback: strip a trailing date stamp (claude-3-5-sonnet-20241022 → claude-3-5-sonnet).
    const stripped = key.replace(/-2\d{7}$/, '');
    row = table[stripped];
  }
  if (!row) return 0;
  const pin = Number(prompt_tokens) || 0;
  const pout = Number(completion_tokens) || 0;
  const inCost = (pin / 1000) * (Number(row.input) || 0);
  const outCost = (pout / 1000) * (Number(row.output) || 0);
  return Number((inCost + outCost).toFixed(6));
}

// Extract usage from a provider response body. Each provider names the
// tokens differently; this helper normalizes to {prompt_tokens, completion_tokens}.
// Returns zeros if usage block is absent.
export function extractUsage(body, provider) {
  if (!body || typeof body !== 'object') return { prompt_tokens: 0, completion_tokens: 0 };
  if (provider === 'openai' || provider === 'openrouter') {
    const u = body.usage || {};
    return {
      prompt_tokens: Number(u.prompt_tokens || u.input_tokens || 0),
      completion_tokens: Number(u.completion_tokens || u.output_tokens || 0),
    };
  }
  if (provider === 'anthropic') {
    const u = body.usage || {};
    return {
      prompt_tokens: Number(u.input_tokens || 0),
      completion_tokens: Number(u.output_tokens || 0),
    };
  }
  if (provider === 'gemini') {
    const u = body.usageMetadata || {};
    return {
      prompt_tokens: Number(u.promptTokenCount || 0),
      completion_tokens: Number(u.candidatesTokenCount || 0),
    };
  }
  return { prompt_tokens: 0, completion_tokens: 0 };
}
