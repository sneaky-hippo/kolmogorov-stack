// workers/distill/catalog.mjs
//
// Wave 158 (Q+3b) — cross-vendor distillation catalog. The single source of
// truth for which (teacher_vendor, teacher_model) pairs and which
// (student_base) repos the worker accepts.
//
// This file is DATA, not documentation. The companion spec text lives at
// public/spec/rs-1.html §7.7 (which links here so third-party tooling can
// consume the JSON form). The license tags carry "verify_before_ship: true"
// when the upstream license text has not been re-checked since the entry
// was added; treat that flag as a build-time TODO, not a legal opinion.

// ----- Teacher vendors and models ------------------------------------------

export const VENDORS = ['anthropic', 'openai', 'google', 'xai', 'local'];

// Each vendor: { transport: 'anthropic-messages' | 'openai-chat' |
//                            'google-generate' | 'openai-compatible',
//                env_var: <required env var for auth or '' for local>,
//                models: [string] }
//
// Models are an allow-list of well-known SKUs at catalog time. Local vendor
// accepts anything because it's an OpenAI-compatible passthrough to the
// tenant's own endpoint (vLLM, TGI, llama.cpp server, ollama, lmstudio).
export const VENDOR_PROFILES = {
  anthropic: {
    transport: 'anthropic-messages',
    env_var: 'ANTHROPIC_API_KEY',
    models: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      // Older minor revisions retained for tenants on pinned versions.
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
      'claude-3-opus-latest',
    ],
  },
  openai: {
    transport: 'openai-chat',
    env_var: 'OPENAI_API_KEY',
    models: [
      'gpt-5',
      'gpt-5-mini',
      'o3',
      'o3-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
      'gpt-4o-mini',
    ],
  },
  google: {
    transport: 'google-generate',
    env_var: 'GOOGLE_API_KEY',
    models: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
    ],
  },
  xai: {
    transport: 'openai-compatible',
    env_var: 'XAI_API_KEY',
    endpoint: 'https://api.x.ai',
    models: [
      'grok-3',
      'grok-3-mini',
      'grok-2-1212',
      'grok-2-vision-1212',
    ],
  },
  local: {
    transport: 'openai-compatible',
    env_var: '',
    // Local accepts any model id; the OpenAI-compatible server enforces.
    models: null,
  },
};

// ----- Student bases (open-weight small models) ----------------------------

// origin: 'western' | 'chinese'. license: known SPDX-ish string + a flag for
// whether the legal text has been re-verified at catalog time. verify_before_ship
// = true means "treat as approximate until counsel signs off."
export const STUDENT_BASES = {
  // ----- Western / permissive ----------------------------------------------
  'smollm2-360m': {
    repo: 'HuggingFaceTB/SmolLM2-360M',
    origin: 'western',
    params: 360e6,
    license: 'Apache-2.0',
    verify_before_ship: false,
  },
  'smollm2-1.7b': {
    repo: 'HuggingFaceTB/SmolLM2-1.7B',
    origin: 'western',
    params: 1.7e9,
    license: 'Apache-2.0',
    verify_before_ship: false,
  },
  'llama-3.2-1b': {
    repo: 'meta-llama/Llama-3.2-1B',
    origin: 'western',
    params: 1e9,
    license: 'Llama-3.2-Community',
    verify_before_ship: true,
  },
  'llama-3.2-3b': {
    repo: 'meta-llama/Llama-3.2-3B',
    origin: 'western',
    params: 3e9,
    license: 'Llama-3.2-Community',
    verify_before_ship: true,
  },
  'phi-3.5-mini': {
    repo: 'microsoft/Phi-3.5-mini-instruct',
    origin: 'western',
    params: 3.8e9,
    license: 'MIT',
    verify_before_ship: false,
  },
  'gemma-2-2b': {
    repo: 'google/gemma-2-2b',
    origin: 'western',
    params: 2.6e9,
    license: 'Gemma-Terms-of-Use',
    verify_before_ship: true,
  },
  'mistral-7b-v0.3': {
    repo: 'mistralai/Mistral-7B-v0.3',
    origin: 'western',
    params: 7e9,
    license: 'Apache-2.0',
    verify_before_ship: false,
  },
  // ----- Chinese-origin / often permissive ---------------------------------
  'qwen2.5-0.5b': {
    repo: 'Qwen/Qwen2.5-0.5B',
    origin: 'chinese',
    params: 0.5e9,
    license: 'Apache-2.0',
    verify_before_ship: false,
  },
  'qwen2.5-1.5b': {
    repo: 'Qwen/Qwen2.5-1.5B',
    origin: 'chinese',
    params: 1.5e9,
    license: 'Apache-2.0',
    verify_before_ship: false,
  },
  'qwen2.5-3b': {
    repo: 'Qwen/Qwen2.5-3B',
    origin: 'chinese',
    params: 3e9,
    license: 'Qwen-Research',
    verify_before_ship: true,
  },
  'qwen2.5-7b': {
    repo: 'Qwen/Qwen2.5-7B',
    origin: 'chinese',
    params: 7e9,
    license: 'Apache-2.0',
    verify_before_ship: false,
  },
  'deepseek-v3-distill-1.5b': {
    repo: 'deepseek-ai/DeepSeek-V3-distill-1.5B',
    origin: 'chinese',
    params: 1.5e9,
    license: 'MIT',
    verify_before_ship: true,
  },
  'glm-4-9b': {
    repo: 'THUDM/glm-4-9b',
    origin: 'chinese',
    params: 9e9,
    license: 'GLM-4-License',
    verify_before_ship: true,
  },
  'yi-1.5-6b': {
    repo: '01-ai/Yi-1.5-6B',
    origin: 'chinese',
    params: 6e9,
    license: 'Apache-2.0',
    verify_before_ship: false,
  },
};

// ----- Distillation methods ------------------------------------------------

// Allow-list of methods the kolm distill pipeline understands. Receipt chain
// captures this verbatim. "prompt-distill" is the fallback when no Python
// stack is available (worker collects pairs but doesn't train); "lora" is the
// default real-training method; "qlora" pairs quantization with LoRA; "full-ft"
// is full-parameter fine-tune (rare for small bases but legal to record).
export const DISTILLATION_METHODS = ['lora', 'qlora', 'full-ft', 'prompt-distill'];

// ----- Helpers -------------------------------------------------------------

export function isKnownVendor(v) {
  return VENDORS.includes(v);
}

export function isKnownModelFor(vendor, model) {
  const prof = VENDOR_PROFILES[vendor];
  if (!prof) return false;
  if (prof.models === null) return true; // local accepts any
  return prof.models.includes(model);
}

export function isKnownStudentBase(slug) {
  return Object.prototype.hasOwnProperty.call(STUDENT_BASES, slug);
}

export function studentBaseEntry(slug) {
  return STUDENT_BASES[slug] || null;
}

export function isKnownDistillationMethod(m) {
  return DISTILLATION_METHODS.includes(m);
}

// Pretty-print a catalog summary for `--list-catalog`. Used by the doctor /
// catalog command surfaces so users don't have to dig into this file.
export function formatCatalogSummary() {
  const lines = [];
  lines.push('teacher vendors + models:');
  for (const v of VENDORS) {
    const prof = VENDOR_PROFILES[v];
    if (!prof) continue;
    const models = prof.models === null ? '<any local model>' : prof.models.join(', ');
    lines.push(`  ${v}: ${models}`);
  }
  lines.push('');
  lines.push('student bases (slug → repo · params · license · verify_before_ship):');
  for (const [slug, e] of Object.entries(STUDENT_BASES)) {
    const flag = e.verify_before_ship ? ' [VERIFY]' : '';
    const paramsB = e.params >= 1e9 ? `${(e.params / 1e9).toFixed(1)}B` : `${(e.params / 1e6).toFixed(0)}M`;
    lines.push(`  ${slug} → ${e.repo} · ${paramsB} · ${e.license}${flag}`);
  }
  lines.push('');
  lines.push('distillation methods: ' + DISTILLATION_METHODS.join(', '));
  return lines.join('\n');
}

export default {
  VENDORS,
  VENDOR_PROFILES,
  STUDENT_BASES,
  DISTILLATION_METHODS,
  isKnownVendor,
  isKnownModelFor,
  isKnownStudentBase,
  studentBaseEntry,
  isKnownDistillationMethod,
  formatCatalogSummary,
};
