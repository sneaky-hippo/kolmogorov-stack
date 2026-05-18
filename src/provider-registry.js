// W368 provider registry — per-provider upstream / auth / path / cost table.
//
// The daemon-connector reads this to resolve:
//   - upstream base URL (override via KOLM_UPSTREAM_<PROVIDER>_BASE env)
//   - auth scheme (bearer vs x-api-key vs ?key=)
//   - env var name for the user's own upstream key
//   - the price-per-1k-tokens table (input/output) for cost-estimator.js
//
// Cost tables are 2026 published prices for the most-used models. Numbers
// are in USD per 1k tokens. If a model is not in the table, estimateCost()
// returns 0 (we never invent fake costs). Keep the table sorted by family
// for grep-ability.

const env = (k, fallback) => process.env[k] || fallback;

export const PROVIDERS = {
  openai: {
    upstream: env('KOLM_UPSTREAM_OPENAI_BASE', 'https://api.openai.com'),
    auth: 'bearer',
    env_key: 'OPENAI_API_KEY',
    paths: [
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/embeddings',
      '/v1/audio/transcriptions',
      '/v1/audio/translations',
      '/v1/audio/speech',
      '/v1/images/generations',
      '/v1/moderations',
    ],
    // 2026 OpenAI pricing per 1k tokens.
    cost_per_1k: {
      'gpt-4o':              { input: 0.0025,  output: 0.010 },
      'gpt-4o-mini':         { input: 0.00015, output: 0.0006 },
      'gpt-4-turbo':         { input: 0.010,   output: 0.030 },
      'gpt-4':               { input: 0.030,   output: 0.060 },
      'gpt-3.5-turbo':       { input: 0.0005,  output: 0.0015 },
      'o1':                  { input: 0.015,   output: 0.060 },
      'o1-mini':             { input: 0.003,   output: 0.012 },
      'o3-mini':             { input: 0.0011,  output: 0.0044 },
      'text-embedding-3-small': { input: 0.00002, output: 0 },
      'text-embedding-3-large': { input: 0.00013, output: 0 },
    },
  },
  anthropic: {
    upstream: env('KOLM_UPSTREAM_ANTHROPIC_BASE', 'https://api.anthropic.com'),
    auth: 'x-api-key',
    env_key: 'ANTHROPIC_API_KEY',
    paths: ['/v1/messages', '/v1/complete'],
    // 2026 Anthropic pricing per 1k tokens.
    cost_per_1k: {
      'claude-opus-4-7':     { input: 0.015,   output: 0.075 },
      'claude-opus-4-6':     { input: 0.015,   output: 0.075 },
      'claude-sonnet-4-7':   { input: 0.003,   output: 0.015 },
      'claude-sonnet-4-6':   { input: 0.003,   output: 0.015 },
      'claude-sonnet-4-5':   { input: 0.003,   output: 0.015 },
      'claude-haiku-4-5':    { input: 0.0008,  output: 0.004 },
      'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
      'claude-3-5-haiku-20241022':  { input: 0.0008, output: 0.004 },
      'claude-3-opus-20240229':     { input: 0.015, output: 0.075 },
    },
  },
  openrouter: {
    upstream: env('KOLM_UPSTREAM_OPENROUTER_BASE', 'https://openrouter.ai/api'),
    auth: 'bearer',
    env_key: 'OPENROUTER_API_KEY',
    paths: ['/v1/chat/completions', '/v1/completions'],
    // OpenRouter exposes 100s of models; we list the high-traffic ones.
    cost_per_1k: {
      'openai/gpt-4o':                { input: 0.0025,  output: 0.010 },
      'openai/gpt-4o-mini':           { input: 0.00015, output: 0.0006 },
      'anthropic/claude-opus-4-7':    { input: 0.015,   output: 0.075 },
      'anthropic/claude-sonnet-4-6':  { input: 0.003,   output: 0.015 },
      'anthropic/claude-haiku-4-5':   { input: 0.0008,  output: 0.004 },
      'google/gemini-2.5-flash':      { input: 0.000075, output: 0.0003 },
      'google/gemini-2.5-pro':        { input: 0.00125, output: 0.005 },
      'deepseek/deepseek-v4-flash':   { input: 0.00014, output: 0.00028 },
      'deepseek/deepseek-v4-pro':     { input: 0.00027, output: 0.0011 },
      'qwen/qwen-3.6-27b':            { input: 0.00018, output: 0.00072 },
      'meta-llama/llama-3.3-70b':     { input: 0.00023, output: 0.00040 },
    },
  },
  gemini: {
    upstream: env('KOLM_UPSTREAM_GEMINI_BASE', 'https://generativelanguage.googleapis.com'),
    auth: 'key-param',
    env_key: 'GEMINI_API_KEY',
    paths: ['/v1beta/models/*'],
    // 2026 Google AI Studio pricing per 1k tokens (text+image).
    cost_per_1k: {
      'gemini-2.5-flash':   { input: 0.000075, output: 0.0003 },
      'gemini-2.5-pro':     { input: 0.00125,  output: 0.005 },
      'gemini-2.5-flash-lite': { input: 0.00004, output: 0.00016 },
      'gemini-2.0-flash':   { input: 0.00010,  output: 0.0004 },
    },
  },
};

// Map an inbound HTTP path (as proxied through the daemon) to a provider id.
// The daemon-connector calls this for forwarding routes that don't carry an
// explicit provider tag in the path (e.g. /v1/chat/completions → openai).
export function pickProviderFromPath(p) {
  const s = String(p || '');
  if (s.startsWith('/anthropic/') || s === '/v1/messages' || s === '/v1/complete') return 'anthropic';
  if (s.startsWith('/openrouter/') || s.includes('openrouter')) return 'openrouter';
  if (s.startsWith('/v1beta/models') || s.startsWith('/gemini/')) return 'gemini';
  return 'openai';
}

// Helper for the doctor verb: return a short summary keyed by provider id.
export function summarizeProviders() {
  const out = {};
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    const k = process.env[cfg.env_key] || '';
    out[id] = {
      env_key_set: !!k,
      env_key_name: cfg.env_key,
      upstream: cfg.upstream,
      auth: cfg.auth,
      paths: cfg.paths,
      model_count: Object.keys(cfg.cost_per_1k || {}).length,
    };
  }
  return out;
}
