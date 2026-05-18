// W250 — remote-compute rental catalog + launch primitives.
//
// When the user's hardware is too weak (no GPU, low RAM, mobile), they can
// rent compute from a remote provider. This module:
//
//   1. Enumerates known providers with capability + pricing + endpoint fields
//   2. Resolves a provider by capability + budget + region
//   3. Builds the curl-equivalent request payload (no live network call here)
//   4. Returns a launch plan the CLI can either print or execute
//
// Two capability buckets:
//   - inference: serve a model behind an OpenAI-compatible HTTP API
//   - training:  spin up a GPU box, run a distill/finetune job, return artifact
//
// No live API calls live in this module. cli/kolm.js wraps these with a
// concrete HTTP client. Tests assert the catalog shape + plan shape, not
// any provider's runtime behavior (which would be brittle + cost money).
//
// Provider fields:
//   id           — short slug (fireworks / together / modal / runpod / ...)
//   name         — display name
//   kind         — 'inference' | 'training' | 'both'
//   homepage     — public URL for billing + signup
//   docs         — public URL for the API docs
//   auth_env     — env var name carrying the API key (e.g. FIREWORKS_API_KEY)
//   base_url     — API root for inference (null for training-only providers)
//   models       — array of model ids known to be available
//   billing      — { unit: 'token'|'gpu_hr'|'job', currency: 'USD',
//                    rate_in?: <USD per 1M input tokens>,
//                    rate_out?: <USD per 1M output tokens>,
//                    gpu?: { kind: 'A100'|'H100'|..., usd_hr: <num> } }
//   region       — array of regions where it has capacity
//   verified_at  — ISO date of last manual verification
//   notes        — short string about pitfalls / quotas

const _UNVERIFIED = '2026-05-18';

export const PROVIDERS = Object.freeze([
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    kind: 'inference',
    homepage: 'https://fireworks.ai',
    docs: 'https://docs.fireworks.ai',
    auth_env: 'FIREWORKS_API_KEY',
    base_url: 'https://api.fireworks.ai/inference/v1',
    models: [
      'accounts/fireworks/models/qwen2p5-72b-instruct',
      'accounts/fireworks/models/llama-v3p1-70b-instruct',
      'accounts/fireworks/models/deepseek-v3-0324',
      'accounts/fireworks/models/mixtral-8x22b-instruct',
    ],
    billing: { unit: 'token', currency: 'USD', rate_in: 0.9, rate_out: 0.9 },
    region: ['us-east', 'us-west'],
    verified_at: _UNVERIFIED,
    notes: 'OpenAI-compatible. Fastest startup for spot inference.',
  },
  {
    id: 'together',
    name: 'Together AI',
    kind: 'inference',
    homepage: 'https://together.ai',
    docs: 'https://docs.together.ai',
    auth_env: 'TOGETHER_API_KEY',
    base_url: 'https://api.together.xyz/v1',
    models: [
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'deepseek-ai/DeepSeek-V3',
      'mistralai/Mixtral-8x22B-Instruct-v0.1',
    ],
    billing: { unit: 'token', currency: 'USD', rate_in: 0.88, rate_out: 0.88 },
    region: ['us-east'],
    verified_at: _UNVERIFIED,
    notes: 'OpenAI-compatible. Wide open-weight model coverage.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'inference',
    homepage: 'https://openrouter.ai',
    docs: 'https://openrouter.ai/docs',
    auth_env: 'OPENROUTER_API_KEY',
    base_url: 'https://openrouter.ai/api/v1',
    models: [
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o-mini',
      'qwen/qwen-2.5-72b-instruct',
      'deepseek/deepseek-chat',
    ],
    billing: { unit: 'token', currency: 'USD', rate_in: 1.0, rate_out: 1.0 },
    region: ['global'],
    verified_at: _UNVERIFIED,
    notes: 'Routes to many providers via one key. Useful for teacher selection.',
  },
  {
    id: 'modal',
    name: 'Modal Labs',
    kind: 'training',
    homepage: 'https://modal.com',
    docs: 'https://modal.com/docs',
    auth_env: 'MODAL_TOKEN_ID',
    base_url: null,
    models: [],
    billing: { unit: 'gpu_hr', currency: 'USD', gpu: { kind: 'A100-40G', usd_hr: 1.78 } },
    region: ['us-east'],
    verified_at: _UNVERIFIED,
    notes: 'Python-first. Best for kolm distill jobs that need PEFT/Unsloth.',
  },
  {
    id: 'runpod',
    name: 'RunPod',
    kind: 'training',
    homepage: 'https://runpod.io',
    docs: 'https://docs.runpod.io',
    auth_env: 'RUNPOD_API_KEY',
    base_url: 'https://api.runpod.io/graphql',
    models: [],
    billing: { unit: 'gpu_hr', currency: 'USD', gpu: { kind: 'RTX4090', usd_hr: 0.34 } },
    region: ['us-east', 'eu-central'],
    verified_at: _UNVERIFIED,
    notes: 'Cheapest single-GPU. Good for small-model distill.',
  },
  {
    id: 'predibase',
    name: 'Predibase',
    kind: 'training',
    homepage: 'https://predibase.com',
    docs: 'https://docs.predibase.com',
    auth_env: 'PREDIBASE_API_TOKEN',
    base_url: 'https://api.app.predibase.com/v1',
    models: [],
    billing: { unit: 'job', currency: 'USD' },
    region: ['us-east'],
    verified_at: _UNVERIFIED,
    notes: 'Rubrik-acquired (June 2025). Enterprise governance baked in.',
  },
  {
    id: 'replicate',
    name: 'Replicate',
    kind: 'both',
    homepage: 'https://replicate.com',
    docs: 'https://replicate.com/docs',
    auth_env: 'REPLICATE_API_TOKEN',
    base_url: 'https://api.replicate.com/v1',
    models: [
      'meta/meta-llama-3.1-70b-instruct',
      'qwen/qwen2.5-72b-instruct',
    ],
    billing: { unit: 'token', currency: 'USD', rate_in: 0.65, rate_out: 2.75 },
    region: ['global'],
    verified_at: _UNVERIFIED,
    notes: 'Long-tail model coverage. Slower cold-start than Fireworks.',
  },
  {
    id: 'lambda',
    name: 'Lambda Labs',
    kind: 'training',
    homepage: 'https://lambda.ai',
    docs: 'https://docs.lambda.ai',
    auth_env: 'LAMBDA_API_KEY',
    base_url: 'https://cloud.lambda.ai/api/v1',
    models: [],
    billing: { unit: 'gpu_hr', currency: 'USD', gpu: { kind: 'H100-80G', usd_hr: 2.49 } },
    region: ['us-east', 'us-west'],
    verified_at: _UNVERIFIED,
    notes: 'On-demand H100/A100. Reserve for batch distills.',
  },
]);

export const KINDS = Object.freeze(['inference', 'training', 'both']);

export function listProviders({ kind = null } = {}) {
  if (!kind) return PROVIDERS.slice();
  return PROVIDERS.filter((p) => p.kind === kind || p.kind === 'both');
}

export function findProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

// Rank inference providers by lowest combined cost for a given token mix.
// in_M / out_M are input/output tokens in millions. Returns ranked list with
// { provider, est_usd } so the CLI can show a quick price comparison.
export function rankByInferenceCost({ in_M = 1, out_M = 1, model = null } = {}) {
  const inf = listProviders({ kind: 'inference' });
  return inf
    .filter((p) => p.billing && p.billing.unit === 'token')
    .filter((p) => !model || p.models.some((m) => m.toLowerCase().includes(model.toLowerCase())))
    .map((p) => ({
      provider: p,
      est_usd: (in_M * (p.billing.rate_in || 0)) + (out_M * (p.billing.rate_out || 0)),
    }))
    .sort((a, b) => a.est_usd - b.est_usd);
}

// Rank training providers by lowest USD/hr on a given GPU kind. Returns the
// ranked list. gpu kind is a substring match: 'A100' matches 'A100-40G' etc.
export function rankByTrainingCost({ gpu = 'A100' } = {}) {
  const train = listProviders({ kind: 'training' });
  return train
    .filter((p) => p.billing && p.billing.unit === 'gpu_hr' && p.billing.gpu)
    .filter((p) => (p.billing.gpu.kind || '').toLowerCase().includes(gpu.toLowerCase()))
    .map((p) => ({ provider: p, usd_hr: p.billing.gpu.usd_hr }))
    .sort((a, b) => a.usd_hr - b.usd_hr);
}

// Build a launch plan for an inference call. Pure function — returns an
// object the CLI can either render as a curl command or hand to a runtime
// HTTP client. Does NOT make a network call.
export function planInference({ providerId, model, messages, max_tokens = 256, temperature = 0.7 }) {
  const p = findProvider(providerId);
  if (!p) throw new Error(`unknown provider: ${providerId}`);
  if (p.kind === 'training') throw new Error(`provider ${providerId} is training-only`);
  const url = (p.base_url || '').replace(/\/$/, '') + '/chat/completions';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer $${p.auth_env}`,
  };
  const body = { model, messages, max_tokens, temperature };
  return {
    provider: p.id,
    method: 'POST',
    url,
    headers,
    body,
    auth_env: p.auth_env,
  };
}

// Build a launch plan for a training job. Provider-shape-dependent; this
// returns a uniform structure { provider, mode, payload } that the CLI can
// translate into the provider-specific call (modal run, runpod gql, etc.).
export function planTraining({ providerId, recipe, base_model, dataset, gpu = 'A100', hours = 1 }) {
  const p = findProvider(providerId);
  if (!p) throw new Error(`unknown provider: ${providerId}`);
  if (p.kind === 'inference') throw new Error(`provider ${providerId} is inference-only`);
  const est_usd = (p.billing && p.billing.gpu) ? p.billing.gpu.usd_hr * hours : null;
  return {
    provider: p.id,
    mode: 'training',
    payload: { recipe, base_model, dataset, gpu, hours },
    auth_env: p.auth_env,
    est_usd,
    notes: p.notes,
  };
}

// Default recommendation: pick the cheapest inference provider for general
// chat workloads (1M in / 1M out as the canonical small mix).
export function recommendInference() {
  const ranked = rankByInferenceCost({ in_M: 1, out_M: 1 });
  return ranked[0] || null;
}

export function recommendTraining({ gpu = 'A100' } = {}) {
  const ranked = rankByTrainingCost({ gpu });
  return ranked[0] || null;
}
