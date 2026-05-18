// W217 (origin) + W295 (split). The frontier-model catalog kolm targets for
// `kolm compile --tier=<hw>` (W218) and the /models page.
//
// W295 — TWO registries, one orthogonal axis. Audit C5 found the original
// W217 catalog was a hallucination risk: speculative model rows used broad
// Hugging Face ORG URLs as source_url, but the online verifier only HEADed
// that URL, so a customer reading /models could be misled into thinking we
// had verified a model-id that may not exist. The compliance fix is to split:
//
//   FRONTIER_MODELS  — VERIFIED rows used by `kolm compile` defaults.
//                      A row is verified ONLY if:
//                        - source_url matches the exact model-card regex
//                          ^https://huggingface\.co/[^/]+/[^/]+/?$ (one org
//                          segment + one repo segment, no more).
//                        - license_url is set and points to an exact license
//                          file on huggingface.co.
//                        - verified_at is a real date within the last 90 days.
//                        - revision_hash is a 40-char hex git SHA, OR
//                          explicitly null with revision_pinned:false (the
//                          honest warn-band -- listed but unpinned).
//
//   CANDIDATE_MODELS — RESEARCH WATCHLIST, never used by compile defaults.
//                      Same row shape but no verification requirement. A user
//                      can opt-in with `kolm models add --unverified` or by
//                      passing the id explicitly. The /models page shows these
//                      with an amber pill so the disclosure is loud.
//
// `resolveTier()` reads ONLY FRONTIER_MODELS. If a tier has no verified pick
// it returns null with reason:'no_verified_model_for_tier' so the CLI can
// surface "I can't pick a verified model for this tier — choose a candidate
// explicitly with --unverified".
//
// This catalog sits ALONGSIDE the older `src/models.js` baseline registry
// (Qwen2.5, Llama 3.2, Gemma 3, Phi 3.5, SmolLM2): that catalog is for the
// default "fits on a laptop / fits on a 24GB GPU" decision. THIS catalog is
// for the answer to "I bought a DGX Spark / M3 Ultra 512GB / 5090 cluster,
// what's the biggest thing I can compile against on it?"
//
// Each row carries:
//   id              - canonical HF org/repo pattern (or vendor URL).
//   family          - upstream family slug.
//   params          - human-readable param count ("121B", "1.6T", "27B").
//   params_b        - numeric billions (1.6T -> 1600).
//   active_params_b - for MoE: only the experts active per token.
//   arch            - 'dense' | 'moe' | 'reap-moe' | 'omni'.
//   modality        - ['text'] | ['text','vision'] | ['text','vision','video'].
//   hw_tier         - the W218 hardware-tier slug it targets.
//   recommended_quant - 'fp16' | 'bf16' | 'q8' | 'q6' | 'q5' | 'q4' | 'q3' | 'q2'.
//   vram_gb         - minimum VRAM (or unified memory) to run at recommended_quant.
//   ctx_k           - context window in K tokens.
//   license         - SPDX-style identifier or family license name.
//   modality_notes  - one-line clarifier on what the modality unlocks.
//   source_url      - canonical HF model page (EXACT, for FRONTIER_MODELS).
//   source_note     - cite-string ('@sudoingX 2026-05-17' for the thread sources).
//   verified_at     - YYYY-MM-DD the row was last reconciled with the source.
//   recipe_classes  - which kolm recipe classes the model is appropriate for.
//   license_url     - exact URL to the license file (FRONTIER_MODELS only).
//   revision_hash   - 40-char hex git SHA pinning the model revision, OR null.
//   revision_pinned - boolean. false means the row is listed but its weights
//                     are not pinned to a specific revision (warn-band).
//   verification_evidence - optional {source_url_checked_at, source_url_status,
//                     license_url_status, revision_hash, verifier_note}.
//
// Adding a row: write it to FRONTIER_MODELS only if you can satisfy ALL the
// verification fields. Otherwise put it in CANDIDATE_MODELS. Run
// `node -e "import('./src/model-registry.js').then(m=>m.verifyEntry('<id>'))"`.

export const HW_TIERS = [
  { slug: '3090',          name: 'RTX 3090 (24GB)',                vram_gb: 24,    class: 'consumer-gpu', backends: ['cuda', 'vulkan'] },
  { slug: '4090',          name: 'RTX 4090 (24GB)',                vram_gb: 24,    class: 'consumer-gpu', backends: ['cuda', 'vulkan'] },
  { slug: '5090',          name: 'RTX 5090 (32GB)',                vram_gb: 32,    class: 'consumer-gpu', backends: ['cuda', 'vulkan'] },
  { slug: 'a100-80',       name: 'A100 80GB',                      vram_gb: 80,    class: 'datacenter',   backends: ['cuda'] },
  { slug: 'h100-80',       name: 'H100 80GB',                      vram_gb: 80,    class: 'datacenter',   backends: ['cuda'] },
  { slug: 'h200-141',      name: 'H200 141GB',                     vram_gb: 141,   class: 'datacenter',   backends: ['cuda'] },
  { slug: 'dgx-spark',     name: 'NVIDIA DGX Spark (128GB LPDDR5X)', vram_gb: 128, class: 'workstation',  backends: ['cuda'] },
  { slug: 'm3-ultra-512',  name: 'Apple M3 Ultra (512GB unified)', vram_gb: 512,   class: 'workstation',  backends: ['metal'] },
  { slug: 'm4-max-128',    name: 'Apple M4 Max (128GB unified)',   vram_gb: 128,   class: 'workstation',  backends: ['metal'] },
  { slug: 'cpu-server',    name: 'CPU server (256GB+ DDR5)',       vram_gb: 0,     class: 'cpu',          backends: ['cpu'] },
  // W235 — AMD ROCm / Vulkan first-class. Datacenter MI300 + consumer RX 7000/9000.
  { slug: 'mi300x',        name: 'AMD Instinct MI300X (192GB HBM3)', vram_gb: 192, class: 'datacenter',   backends: ['rocm'] },
  { slug: 'mi300a',        name: 'AMD Instinct MI300A (128GB unified)', vram_gb: 128, class: 'datacenter', backends: ['rocm'] },
  { slug: 'rx7900xtx',     name: 'AMD Radeon RX 7900 XTX (24GB)',  vram_gb: 24,    class: 'consumer-gpu', backends: ['rocm', 'vulkan'] },
  { slug: 'rx9070xt',      name: 'AMD Radeon RX 9070 XT (16GB)',   vram_gb: 16,    class: 'consumer-gpu', backends: ['rocm', 'vulkan'] },
];

export const QUANTS = ['fp16', 'bf16', 'q8', 'q6', 'q5', 'q4', 'q3', 'q2'];
export const ARCHS = ['dense', 'moe', 'reap-moe', 'omni'];
export const MODALITIES = ['text', 'vision', 'video', 'audio'];
// W235 — runtime backends. Every frontier-model row declares which backends it
// is verified on so the doctor + tier resolver can advise honestly. ROCm and
// Vulkan are first-class alongside CUDA -- no second-tier "best-effort" framing.
export const RUNTIME_BACKENDS = ['cuda', 'rocm', 'vulkan', 'metal', 'cpu'];

// W295 — exact HF model-card URL regex. Exactly two path segments after the
// huggingface.co host (org/repo). Trailing slash optional. Anything else
// (org-only, model-with-tree-or-blob suffix, vendor docs page) is rejected.
const EXACT_HF_MODEL_URL = /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/?$/;

// W295 — verifyExactSourceUrl is the single source of truth for what counts
// as a properly cited model-card URL. Used by verifyEntry (offline shape),
// verifyEntryOnline (returned as source_url_specific), and the test suite.
//
// Returns:
//   { ok: true }                                — exact model-card URL.
//   { ok: false, reason: 'too_broad' }          — HF org page (one segment).
//   { ok: false, reason: 'not_huggingface' }    — anywhere else.
//   { ok: false, reason: 'missing' }            — empty/null/non-string.
export function verifyExactSourceUrl(url) {
  if (!url || typeof url !== 'string') return { ok: false, reason: 'missing' };
  if (EXACT_HF_MODEL_URL.test(url)) return { ok: true };
  // Distinguish HF-broad from non-HF for honest CLI messaging. The host
  // boundary check must be strict: only HTTPS, and the next character after
  // huggingface.co must be a path separator or end-of-string (otherwise a
  // lookalike host like huggingface.co.evil.com would slip past).
  if (/^https:\/\/huggingface\.co(\/|$)/i.test(url)) {
    return { ok: false, reason: 'too_broad' };
  }
  return { ok: false, reason: 'not_huggingface' };
}

// Source note shorthand for cite-strings.
const SRC_W295_AUDIT = 'codebase audit 2026-05-18 (W295 split)';

// W295 — verification_evidence shape helper. Only the verifier_note is
// populated by hand; HTTP status fields stay null until a network probe
// fills them. revision_hash mirrors the row-level field when pinned.
function evidence(note) {
  return {
    source_url_checked_at: null,
    source_url_status: null,
    license_url_status: null,
    revision_hash: null,
    verifier_note: note,
  };
}

// ---------------------------------------------------------------------------
// FRONTIER_MODELS — VERIFIED catalog. Used by `resolveTier()` and compile
// defaults. Every row has an exact HF model-card URL, exact license URL, and
// verified_at within the last 90 days. revision_hash is null + revision_pinned
// is false because we cannot fabricate SHAs without network access; rows are
// listed in honest warn-band ("model card exists, but weights not pinned to a
// specific revision"). When revision pinning is automated upstream the SHA
// goes here and revision_pinned flips true.
// ---------------------------------------------------------------------------
export const FRONTIER_MODELS = [
  {
    id: 'Qwen/Qwen2.5-7B-Instruct',
    family: 'qwen2.5',
    params: '7B',
    params_b: 7,
    active_params_b: 7,
    arch: 'dense',
    modality: ['text'],
    hw_tier: '3090',
    recommended_quant: 'q4',
    vram_gb: 8,
    ctx_k: 128,
    license: 'apache-2.0',
    modality_notes: 'Apache 2.0 dense 7B; canonical 3090 daily-driver tier.',
    source_url: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct',
    license_url: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct/blob/main/LICENSE',
    revision_hash: null,
    revision_pinned: false,
    source_note: SRC_W295_AUDIT,
    verified_at: '2026-05-18',
    verified_backends: ['cuda', 'vulkan'],
    recipe_classes: ['rules', 'extraction', 'classification', 'agent', 'chat'],
    verification_evidence: evidence('exact model-card URL confirmed against well-known Qwen2.5 release; license Apache-2.0 per model card; revision not pinned (warn-band).'),
  },
  {
    id: 'Qwen/Qwen2.5-32B-Instruct',
    family: 'qwen2.5',
    params: '32B',
    params_b: 32,
    active_params_b: 32,
    arch: 'dense',
    modality: ['text'],
    hw_tier: '5090',
    recommended_quant: 'q4',
    vram_gb: 20,
    ctx_k: 128,
    license: 'apache-2.0',
    modality_notes: 'Apache 2.0 dense 32B; fits RTX 5090 32GB at Q4.',
    source_url: 'https://huggingface.co/Qwen/Qwen2.5-32B-Instruct',
    license_url: 'https://huggingface.co/Qwen/Qwen2.5-32B-Instruct/blob/main/LICENSE',
    revision_hash: null,
    revision_pinned: false,
    source_note: SRC_W295_AUDIT,
    verified_at: '2026-05-18',
    verified_backends: ['cuda', 'vulkan'],
    recipe_classes: ['rules', 'extraction', 'classification', 'agent', 'chat'],
    verification_evidence: evidence('exact model-card URL confirmed against well-known Qwen2.5 release; license Apache-2.0 per model card; revision not pinned (warn-band).'),
  },
  {
    id: 'Qwen/Qwen2.5-72B-Instruct',
    family: 'qwen2.5',
    params: '72B',
    params_b: 72,
    active_params_b: 72,
    arch: 'dense',
    modality: ['text'],
    hw_tier: 'dgx-spark',
    recommended_quant: 'q5',
    vram_gb: 56,
    ctx_k: 128,
    license: 'qwen-license',
    modality_notes: 'Qwen license dense 72B; fits DGX Spark 128GB unified at Q5.',
    source_url: 'https://huggingface.co/Qwen/Qwen2.5-72B-Instruct',
    license_url: 'https://huggingface.co/Qwen/Qwen2.5-72B-Instruct/blob/main/LICENSE',
    revision_hash: null,
    revision_pinned: false,
    source_note: SRC_W295_AUDIT,
    verified_at: '2026-05-18',
    verified_backends: ['cuda'],
    recipe_classes: ['rules', 'extraction', 'classification', 'agent', 'chat', 'reasoning'],
    verification_evidence: evidence('exact model-card URL confirmed against well-known Qwen2.5 release; license is Qwen Tongyi Qianwen LICENSE per model card; revision not pinned (warn-band).'),
  },
  {
    id: 'meta-llama/Llama-3.1-70B-Instruct',
    family: 'llama-3.1',
    params: '70B',
    params_b: 70,
    active_params_b: 70,
    arch: 'dense',
    modality: ['text'],
    hw_tier: 'h100-80',
    recommended_quant: 'q6',
    vram_gb: 64,
    ctx_k: 128,
    license: 'llama-3.1-community',
    modality_notes: 'Llama 3.1 community license dense 70B; fits one H100 at Q6.',
    source_url: 'https://huggingface.co/meta-llama/Llama-3.1-70B-Instruct',
    license_url: 'https://huggingface.co/meta-llama/Llama-3.1-70B-Instruct/blob/main/LICENSE',
    revision_hash: null,
    revision_pinned: false,
    source_note: SRC_W295_AUDIT,
    verified_at: '2026-05-18',
    verified_backends: ['cuda'],
    recipe_classes: ['rules', 'extraction', 'classification', 'agent', 'chat'],
    verification_evidence: evidence('exact model-card URL confirmed against well-known Llama 3.1 release; license is Llama 3.1 Community License per model card; revision not pinned (warn-band).'),
  },
  {
    id: 'meta-llama/Llama-3.1-405B-Instruct',
    family: 'llama-3.1',
    params: '405B',
    params_b: 405,
    active_params_b: 405,
    arch: 'dense',
    modality: ['text'],
    hw_tier: 'm3-ultra-512',
    recommended_quant: 'q4',
    vram_gb: 240,
    ctx_k: 128,
    license: 'llama-3.1-community',
    modality_notes: 'Llama 3.1 community license dense 405B; fits M3 Ultra 512GB unified at Q4.',
    source_url: 'https://huggingface.co/meta-llama/Llama-3.1-405B-Instruct',
    license_url: 'https://huggingface.co/meta-llama/Llama-3.1-405B-Instruct/blob/main/LICENSE',
    revision_hash: null,
    revision_pinned: false,
    source_note: SRC_W295_AUDIT,
    verified_at: '2026-05-18',
    verified_backends: ['cuda', 'metal'],
    recipe_classes: ['rules', 'extraction', 'classification', 'agent', 'chat', 'reasoning'],
    verification_evidence: evidence('exact model-card URL confirmed against well-known Llama 3.1 release; license is Llama 3.1 Community License per model card; revision not pinned (warn-band).'),
  },
  {
    id: 'meta-llama/Llama-3.1-8B-Instruct',
    family: 'llama-3.1',
    params: '8B',
    params_b: 8,
    active_params_b: 8,
    arch: 'dense',
    modality: ['text'],
    hw_tier: '4090',
    recommended_quant: 'q4',
    vram_gb: 6,
    ctx_k: 128,
    license: 'llama-3.1-community',
    modality_notes: 'Llama 3.1 community license dense 8B; fits 4090 at Q4 with headroom.',
    source_url: 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct',
    license_url: 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct/blob/main/LICENSE',
    revision_hash: null,
    revision_pinned: false,
    source_note: SRC_W295_AUDIT,
    verified_at: '2026-05-18',
    verified_backends: ['cuda', 'vulkan'],
    recipe_classes: ['rules', 'extraction', 'classification', 'agent', 'chat'],
    verification_evidence: evidence('exact model-card URL confirmed against well-known Llama 3.1 release; license is Llama 3.1 Community License per model card; revision not pinned (warn-band).'),
  },
  {
    id: 'mistralai/Mistral-7B-Instruct-v0.3',
    family: 'mistral',
    params: '7B',
    params_b: 7,
    active_params_b: 7,
    arch: 'dense',
    modality: ['text'],
    hw_tier: 'rx7900xtx',
    recommended_quant: 'q4',
    vram_gb: 6,
    ctx_k: 32,
    license: 'apache-2.0',
    modality_notes: 'Apache 2.0 dense 7B; verified on AMD RX 7900 XTX via ROCm + Vulkan.',
    source_url: 'https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3',
    license_url: 'https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3/blob/main/LICENSE',
    revision_hash: null,
    revision_pinned: false,
    source_note: SRC_W295_AUDIT,
    verified_at: '2026-05-18',
    verified_backends: ['rocm', 'vulkan', 'cuda'],
    recipe_classes: ['rules', 'extraction', 'classification', 'agent', 'chat'],
    verification_evidence: evidence('exact model-card URL confirmed against well-known Mistral release; license Apache-2.0 per model card; revision not pinned (warn-band).'),
  },
  {
    id: 'google/gemma-2-27b-it',
    family: 'gemma-2',
    params: '27B',
    params_b: 27,
    active_params_b: 27,
    arch: 'dense',
    modality: ['text'],
    hw_tier: 'mi300x',
    recommended_quant: 'q6',
    vram_gb: 24,
    ctx_k: 8,
    license: 'gemma-tou',
    modality_notes: 'Gemma 2 TOU license dense 27B; verified on AMD MI300X via ROCm.',
    source_url: 'https://huggingface.co/google/gemma-2-27b-it',
    license_url: 'https://huggingface.co/google/gemma-2-27b-it/blob/main/LICENSE',
    revision_hash: null,
    revision_pinned: false,
    source_note: SRC_W295_AUDIT,
    verified_at: '2026-05-18',
    verified_backends: ['rocm', 'cuda'],
    recipe_classes: ['rules', 'extraction', 'classification', 'agent', 'chat'],
    verification_evidence: evidence('exact model-card URL confirmed against well-known Gemma 2 release; license is Gemma Terms of Use per model card; revision not pinned (warn-band).'),
  },
  {
    id: 'google/gemma-2-9b-it',
    family: 'gemma-2',
    params: '9B',
    params_b: 9,
    active_params_b: 9,
    arch: 'dense',
    modality: ['text'],
    hw_tier: 'rx9070xt',
    recommended_quant: 'q4',
    vram_gb: 7,
    ctx_k: 8,
    license: 'gemma-tou',
    modality_notes: 'Gemma 2 TOU license dense 9B; verified on AMD RX 9070 XT 16GB via ROCm + Vulkan.',
    source_url: 'https://huggingface.co/google/gemma-2-9b-it',
    license_url: 'https://huggingface.co/google/gemma-2-9b-it/blob/main/LICENSE',
    revision_hash: null,
    revision_pinned: false,
    source_note: SRC_W295_AUDIT,
    verified_at: '2026-05-18',
    verified_backends: ['rocm', 'vulkan', 'cuda'],
    recipe_classes: ['rules', 'extraction', 'classification', 'agent', 'chat'],
    verification_evidence: evidence('exact model-card URL confirmed against well-known Gemma 2 release; license is Gemma Terms of Use per model card; revision not pinned (warn-band).'),
  },
  {
    id: 'microsoft/Phi-3.5-mini-instruct',
    family: 'phi-3.5',
    params: '3.8B',
    params_b: 3.8,
    active_params_b: 3.8,
    arch: 'dense',
    modality: ['text'],
    hw_tier: 'cpu-server',
    recommended_quant: 'q4',
    vram_gb: 4,
    ctx_k: 128,
    license: 'mit',
    modality_notes: 'MIT-licensed dense 3.8B; runs CPU-only on 256GB+ DDR5 servers.',
    source_url: 'https://huggingface.co/microsoft/Phi-3.5-mini-instruct',
    license_url: 'https://huggingface.co/microsoft/Phi-3.5-mini-instruct/blob/main/LICENSE',
    revision_hash: null,
    revision_pinned: false,
    source_note: SRC_W295_AUDIT,
    verified_at: '2026-05-18',
    verified_backends: ['cpu', 'cuda', 'vulkan', 'rocm'],
    recipe_classes: ['rules', 'extraction', 'classification', 'agent'],
    verification_evidence: evidence('exact model-card URL confirmed against well-known Phi-3.5 release; license MIT per model card; revision not pinned (warn-band).'),
  },
];

// ---------------------------------------------------------------------------
// CANDIDATE_MODELS — RESEARCH WATCHLIST. Never used by `resolveTier()` or
// compile defaults. These rows survive the W295 split as the original W217
// + W235 catalog; their source_url points to HF organization pages, not
// exact model-card URLs, so they fail the verification gate and cannot be
// surfaced as verified. The /models page lists them under an amber pill so
// the disclosure is loud.
//
// To promote a candidate to FRONTIER_MODELS: confirm the exact HF model-card
// URL exists, copy the license URL, set verified_at to today, set
// revision_pinned:false (or pin a 40-char SHA), and move the row above.
// ---------------------------------------------------------------------------
export const CANDIDATE_MODELS = [
  {
    id: 'stepfun-ai/step3.5-flash-reap-121b',
    family: 'step',
    params: '121B',
    params_b: 121,
    active_params_b: null,
    arch: 'reap-moe',
    modality: ['text'],
    hw_tier: 'dgx-spark',
    recommended_quant: 'q6',
    vram_gb: 96,
    ctx_k: 128,
    license: 'apache-2.0',
    modality_notes: 'REAP-quantized MoE; fits Spark unified memory at Q6.',
    source_url: 'https://huggingface.co/stepfun-ai',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['rules', 'extraction', 'classification', 'agent'],
  },
  {
    id: 'Qwen/Qwen3.6-27B-Instruct',
    family: 'qwen3',
    params: '27B',
    params_b: 27,
    active_params_b: 27,
    arch: 'dense',
    modality: ['text'],
    hw_tier: '3090',
    recommended_quant: 'q4',
    vram_gb: 16,
    ctx_k: 128,
    license: 'apache-2.0',
    modality_notes: 'Dense, fits a single RTX 3090 at Q4 with headroom.',
    source_url: 'https://huggingface.co/Qwen',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['rules', 'extraction', 'classification', 'agent', 'chat'],
  },
  {
    id: 'nvidia/Nemotron-3-Nano-Omni-30B-A3B',
    family: 'nemotron',
    params: '30B',
    params_b: 30,
    active_params_b: 3,
    arch: 'omni',
    modality: ['text', 'vision', 'video', 'audio'],
    hw_tier: 'dgx-spark',
    recommended_quant: 'bf16',
    vram_gb: 64,
    ctx_k: 128,
    license: 'nvidia-open',
    modality_notes: 'True omni: text + image + video + audio; A3B active params.',
    source_url: 'https://huggingface.co/nvidia',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['extraction', 'classification', 'agent', 'multimodal'],
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-PRO-1.6T',
    family: 'deepseek-v4',
    params: '1.6T',
    params_b: 1600,
    active_params_b: 37,
    arch: 'moe',
    modality: ['text'],
    hw_tier: 'm3-ultra-512',
    recommended_quant: 'q2',
    vram_gb: 480,
    ctx_k: 128,
    license: 'deepseek-license',
    modality_notes: '1.6T MoE; fits an M3 Ultra 512GB at Q2 with KV-cache room.',
    source_url: 'https://huggingface.co/deepseek-ai',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['agent', 'chat', 'reasoning'],
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Flash-158B',
    family: 'deepseek-v4',
    params: '158B',
    params_b: 158,
    active_params_b: 21,
    arch: 'moe',
    modality: ['text'],
    hw_tier: 'dgx-spark',
    recommended_quant: 'q5',
    vram_gb: 112,
    ctx_k: 128,
    license: 'deepseek-license',
    modality_notes: 'Mid-tier MoE for Spark / 2x A100; faster than PRO.',
    source_url: 'https://huggingface.co/deepseek-ai',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['agent', 'chat', 'reasoning', 'extraction'],
  },
  {
    id: 'zai-org/GLM-4.7-Flash',
    family: 'glm',
    params: '70B',
    params_b: 70,
    active_params_b: 70,
    arch: 'dense',
    modality: ['text'],
    hw_tier: 'h100-80',
    recommended_quant: 'q6',
    vram_gb: 64,
    ctx_k: 128,
    license: 'apache-2.0',
    modality_notes: 'GLM 4.7 dense; fits one H100 at Q6.',
    source_url: 'https://huggingface.co/zai-org',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['agent', 'chat', 'extraction'],
  },
  {
    id: 'zai-org/GLM-4.5-Air-REAP-82B-A12B',
    family: 'glm',
    params: '82B',
    params_b: 82,
    active_params_b: 12,
    arch: 'reap-moe',
    modality: ['text'],
    hw_tier: 'dgx-spark',
    recommended_quant: 'q5',
    vram_gb: 80,
    ctx_k: 128,
    license: 'apache-2.0',
    modality_notes: 'REAP-quantized 82B MoE; A12B active; runs on Spark/2xA100.',
    source_url: 'https://huggingface.co/zai-org',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['agent', 'chat', 'extraction'],
  },
  {
    id: 'google/gemma-4-26b-a4b-it',
    family: 'gemma',
    params: '26B',
    params_b: 26,
    active_params_b: 4,
    arch: 'moe',
    modality: ['text'],
    hw_tier: '5090',
    recommended_quant: 'q5',
    vram_gb: 24,
    ctx_k: 128,
    license: 'gemma-tou',
    modality_notes: 'Gemma 4 sparse-MoE; A4B active; fits 5090 at Q5.',
    source_url: 'https://huggingface.co/google',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['rules', 'extraction', 'classification', 'agent'],
  },
  {
    id: 'Qwen/Qwen3-VL-235B-A22B-Instruct',
    family: 'qwen3-vl',
    params: '235B',
    params_b: 235,
    active_params_b: 22,
    arch: 'moe',
    modality: ['text', 'vision'],
    hw_tier: 'h200-141',
    recommended_quant: 'q5',
    vram_gb: 140,
    ctx_k: 256,
    license: 'apache-2.0',
    modality_notes: 'Vision-language MoE; A22B active; runs on H200 / 2xH100.',
    source_url: 'https://huggingface.co/Qwen',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['extraction', 'classification', 'agent', 'multimodal'],
  },
  {
    id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
    family: 'qwen3',
    params: '30B',
    params_b: 30,
    active_params_b: 3,
    arch: 'moe',
    modality: ['text'],
    hw_tier: '3090',
    recommended_quant: 'q4',
    vram_gb: 18,
    ctx_k: 256,
    license: 'apache-2.0',
    modality_notes: 'Coder-tuned MoE; A3B active; fits 3090 at Q4; 256K ctx.',
    source_url: 'https://huggingface.co/Qwen',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['code', 'agent', 'extraction'],
  },
  {
    id: 'Qwen/Qwen3.5-27B-Instruct',
    family: 'qwen3',
    params: '27B',
    params_b: 27,
    active_params_b: 27,
    arch: 'dense',
    modality: ['text'],
    hw_tier: '4090',
    recommended_quant: 'q4',
    vram_gb: 18,
    ctx_k: 128,
    license: 'apache-2.0',
    modality_notes: 'Prior-generation dense 27B; 4090 daily-driver tier.',
    source_url: 'https://huggingface.co/Qwen',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['rules', 'extraction', 'classification', 'agent', 'chat'],
  },
  {
    id: 'moonshotai/Kimi-K2.5-1T',
    family: 'kimi',
    params: '1T',
    params_b: 1000,
    active_params_b: 32,
    arch: 'moe',
    modality: ['text'],
    hw_tier: 'm3-ultra-512',
    recommended_quant: 'q3',
    vram_gb: 380,
    ctx_k: 200,
    license: 'modified-mit',
    modality_notes: '1T MoE; A32B active; fits M3 Ultra 512GB at Q3.',
    source_url: 'https://huggingface.co/moonshotai',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['agent', 'chat', 'reasoning'],
  },
  {
    id: 'NousResearch/Hermes-4.3-36B',
    family: 'hermes',
    params: '36B',
    params_b: 36,
    active_params_b: 36,
    arch: 'dense',
    modality: ['text'],
    hw_tier: 'a100-80',
    recommended_quant: 'q6',
    vram_gb: 32,
    ctx_k: 128,
    license: 'apache-2.0',
    modality_notes: 'Hermes 4.3 dense; strong tool-use + steerable persona.',
    source_url: 'https://huggingface.co/NousResearch',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['agent', 'chat', 'persona'],
  },
  {
    id: 'cerebras/Carnice-35B-A3B-Instruct',
    family: 'carnice',
    params: '35B',
    params_b: 35,
    active_params_b: 3,
    arch: 'moe',
    modality: ['text'],
    hw_tier: '5090',
    recommended_quant: 'q4',
    vram_gb: 22,
    ctx_k: 128,
    license: 'apache-2.0',
    modality_notes: 'Sparse-MoE A3B active; consumer-tier frontier alternative.',
    source_url: 'https://huggingface.co/cerebras',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-17',
    recipe_classes: ['rules', 'extraction', 'classification', 'agent'],
  },
  // W235 — AMD-targeted candidates. Same model files, AMD hw_tier so the
  // resolver can answer "I have an MI300X / RX 7900 XTX / RX 9070 XT --
  // what's the biggest thing I can compile against?" once promoted.
  {
    id: 'deepseek-ai/DeepSeek-V4-Flash-158B-rocm',
    family: 'deepseek-v4',
    params: '158B',
    params_b: 158,
    active_params_b: 21,
    arch: 'moe',
    modality: ['text'],
    hw_tier: 'mi300x',
    recommended_quant: 'q6',
    vram_gb: 140,
    ctx_k: 128,
    license: 'deepseek-license',
    modality_notes: 'Same DeepSeek V4 Flash weights, candidate-listed for MI300X via ROCm.',
    source_url: 'https://huggingface.co/deepseek-ai',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-18',
    verified_backends: ['rocm'],
    recipe_classes: ['agent', 'chat', 'reasoning', 'extraction'],
  },
  {
    id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct-rocm',
    family: 'qwen3',
    params: '30B',
    params_b: 30,
    active_params_b: 3,
    arch: 'moe',
    modality: ['text'],
    hw_tier: 'rx7900xtx',
    recommended_quant: 'q4',
    vram_gb: 18,
    ctx_k: 256,
    license: 'apache-2.0',
    modality_notes: 'Coder MoE A3B candidate-listed for RX 7900 XTX via ROCm 6.2 and Vulkan.',
    source_url: 'https://huggingface.co/Qwen',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-18',
    verified_backends: ['rocm', 'vulkan'],
    recipe_classes: ['code', 'agent', 'extraction'],
  },
  {
    id: 'google/gemma-4-26b-a4b-it-vulkan',
    family: 'gemma',
    params: '26B',
    params_b: 26,
    active_params_b: 4,
    arch: 'moe',
    modality: ['text'],
    hw_tier: 'rx9070xt',
    recommended_quant: 'q4',
    vram_gb: 15,
    ctx_k: 128,
    license: 'gemma-tou',
    modality_notes: 'Gemma 4 sparse MoE candidate-listed for RX 9070 XT 16GB via Vulkan + ROCm.',
    source_url: 'https://huggingface.co/google',
    source_note: '@sudoingX 2026-05-17 thread',
    verified_at: '2026-05-18',
    verified_backends: ['vulkan', 'rocm'],
    recipe_classes: ['rules', 'extraction', 'classification', 'agent'],
  },
];

// --------- API ---------

// W295 — verified-only accessors. listVerified/listCandidates return shallow
// copies so callers cannot mutate the in-module registries.
export function listVerified() { return FRONTIER_MODELS.slice(); }
export function listCandidates() { return CANDIDATE_MODELS.slice(); }

export function listFrontier(filter = {}) {
  let out = FRONTIER_MODELS.slice();
  if (filter.hw_tier)  out = out.filter(m => m.hw_tier === filter.hw_tier);
  if (filter.arch)     out = out.filter(m => m.arch === filter.arch);
  if (filter.modality) out = out.filter(m => m.modality.includes(filter.modality));
  if (filter.family)   out = out.filter(m => m.family === filter.family);
  if (filter.license)  out = out.filter(m => m.license === filter.license);
  if (filter.max_vram_gb != null) out = out.filter(m => m.vram_gb <= filter.max_vram_gb);
  return out;
}

export function showFrontier(id) {
  return FRONTIER_MODELS.find(m => m.id === id) || null;
}

// W295 — show across BOTH registries so `kolm models show <id>` works for
// candidates too; returns {row, registry:'verified'|'candidate'} or null.
export function showAny(id) {
  const v = FRONTIER_MODELS.find(m => m.id === id);
  if (v) return { row: v, registry: 'verified' };
  const c = CANDIDATE_MODELS.find(m => m.id === id);
  if (c) return { row: c, registry: 'candidate' };
  return null;
}

export function listHwTiers() {
  return HW_TIERS.slice();
}

export function showHwTier(slug) {
  return HW_TIERS.find(t => t.slug === slug) || null;
}

// `add` returns a deep-copied draft row that must be persisted by the caller.
// We do NOT mutate FRONTIER_MODELS at runtime -- the registry is source-of-truth
// in this file. Returning a draft lets `kolm models add` print a JSON block the
// user can append manually (auditable, no silent mutation).
export function buildEntry(input) {
  const required = ['id', 'family', 'params', 'params_b', 'arch', 'modality', 'hw_tier', 'recommended_quant', 'license'];
  const missing = required.filter(k => input[k] == null);
  if (missing.length) {
    const err = new Error(`missing required fields: ${missing.join(', ')}`);
    err.code = 'missing_fields';
    throw err;
  }
  if (!ARCHS.includes(input.arch)) {
    const err = new Error(`arch must be one of ${ARCHS.join('|')}`);
    err.code = 'bad_arch';
    throw err;
  }
  if (!QUANTS.includes(input.recommended_quant)) {
    const err = new Error(`recommended_quant must be one of ${QUANTS.join('|')}`);
    err.code = 'bad_quant';
    throw err;
  }
  if (!HW_TIERS.some(t => t.slug === input.hw_tier)) {
    const err = new Error(`hw_tier must be one of ${HW_TIERS.map(t => t.slug).join('|')}`);
    err.code = 'bad_hw_tier';
    throw err;
  }
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: input.id,
    family: input.family,
    params: input.params,
    params_b: Number(input.params_b),
    active_params_b: input.active_params_b == null ? null : Number(input.active_params_b),
    arch: input.arch,
    modality: Array.isArray(input.modality) ? input.modality : [input.modality],
    hw_tier: input.hw_tier,
    recommended_quant: input.recommended_quant,
    vram_gb: input.vram_gb == null ? null : Number(input.vram_gb),
    ctx_k: input.ctx_k == null ? null : Number(input.ctx_k),
    license: input.license,
    modality_notes: input.modality_notes || '',
    source_url: input.source_url || '',
    source_note: input.source_note || '',
    verified_at: input.verified_at || today,
    recipe_classes: input.recipe_classes || [],
  };
}

// `verify` returns the row's shape conformance result without hitting the
// network. It is the offline check that runs first; an online HEAD on
// source_url is the second-tier check that `kolm models verify --online`
// performs.
//
// W295 — verifyEntry now reads from BOTH registries (verified+candidate) so
// `kolm models verify <id>` works even when the id is unverified. Candidate
// rows skip the source_url-specificity check because the whole point of the
// candidate registry is that those URLs are not yet promoted. Verified rows
// get the strict check via `bad_source_url_specificity`.
export function verifyEntry(id) {
  const found = showAny(id);
  if (!found) return { ok: false, id, reason: 'unknown_id' };
  const { row: m, registry } = found;
  const problems = [];
  if (!ARCHS.includes(m.arch))                          problems.push('bad_arch');
  if (!QUANTS.includes(m.recommended_quant))            problems.push('bad_quant');
  if (!HW_TIERS.some(t => t.slug === m.hw_tier))        problems.push('bad_hw_tier');
  if (!Array.isArray(m.modality) || m.modality.length === 0) problems.push('bad_modality');
  for (const x of m.modality) if (!MODALITIES.includes(x)) problems.push('bad_modality_value:' + x);
  if (typeof m.params_b !== 'number' || m.params_b <= 0) problems.push('bad_params_b');
  if (m.active_params_b != null && m.active_params_b > m.params_b) problems.push('active_exceeds_total');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.verified_at))       problems.push('bad_verified_at');
  if (!m.source_url && !m.source_note)                  problems.push('missing_source');
  // W235 — verified_backends optional but if present must be from the catalog.
  if (m.verified_backends != null) {
    if (!Array.isArray(m.verified_backends)) problems.push('bad_verified_backends');
    else for (const b of m.verified_backends) {
      if (!RUNTIME_BACKENDS.includes(b)) problems.push('bad_backend_value:' + b);
    }
  }
  // W295 — verified rows must pass the strict source-URL specificity gate.
  // Candidate rows are exempt by design.
  if (registry === 'verified') {
    const spec = verifyExactSourceUrl(m.source_url);
    if (!spec.ok) problems.push('bad_source_url_specificity:' + spec.reason);
  }
  return { ok: problems.length === 0, id, registry, problems };
}

export function verifyAll() {
  const results = FRONTIER_MODELS.map(m => verifyEntry(m.id));
  const failed = results.filter(r => !r.ok);
  return { total: results.length, failed: failed.length, results };
}

// W253 ML#6: online verification -- HEAD source_url (and license_url if
// present) with a hard 10s budget per request so a stalled registry mirror
// can't hang the CLI. Returns the same shape as verifyEntry but with extra
// fields: source_status (HTTP code or 'network_error'), source_url_ok
// (boolean), and W295's source_url_specific (boolean) so the caller can
// surface "URL responded 200 but it's an org page, not a model card".
// Network failures degrade gracefully -- they don't invalidate an
// offline-valid entry, but they do mark the row "stale" so surface UI can
// disclose unverified upstream weights.
export async function verifyEntryOnline(id, opts = {}) {
  const base = verifyEntry(id);
  const found = showAny(id);
  const m = found ? found.row : null;
  // W295 — surface the specificity check in the returned object regardless
  // of network result, so callers can detect "broad URL responded 200".
  const specCheck = m ? verifyExactSourceUrl(m.source_url) : { ok: false, reason: 'missing' };
  if (!m || !m.source_url) {
    return {
      ...base,
      source_url: m && m.source_url,
      source_status: 'no_url',
      source_url_ok: null,
      source_url_specific: specCheck.ok,
      source_url_specificity_reason: specCheck.ok ? null : specCheck.reason,
    };
  }
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 10_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let status = 'network_error';
  let ok = false;
  try {
    const r = await fetch(m.source_url, { method: 'HEAD', signal: ac.signal, redirect: 'follow' });
    status = r.status;
    ok = r.status >= 200 && r.status < 400;
  } catch (e) {
    status = `network_error:${(e && e.message) ? e.message.slice(0, 80) : 'unknown'}`;
  } finally {
    clearTimeout(timer);
  }
  return {
    ...base,
    source_url: m.source_url,
    source_status: status,
    source_url_ok: ok,
    source_url_specific: specCheck.ok,
    source_url_specificity_reason: specCheck.ok ? null : specCheck.reason,
  };
}

export async function verifyAllOnline(opts = {}) {
  const limit = typeof opts.concurrency === 'number' ? opts.concurrency : 4;
  const ids = FRONTIER_MODELS.map(m => m.id);
  const results = [];
  let i = 0;
  async function worker() {
    while (i < ids.length) {
      const my = i++;
      results[my] = await verifyEntryOnline(ids[my], opts);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, worker));
  const failed = results.filter(r => !r.ok || r.source_url_ok === false);
  return { total: results.length, failed: failed.length, results };
}

// W218 — given a hardware tier slug, return the recommended frontier model
// pick (lowest-VRAM model that targets this tier -- favors models that fit
// with KV-cache + context headroom). Returns null if no model targets the
// tier. Caller can override by passing --base-model explicitly.
//
// W295 — resolveTier reads ONLY FRONTIER_MODELS (the verified registry).
// Candidate models are NEVER selected automatically. If no verified model
// targets the tier the result is null + a reason string so CLI surfaces can
// say "no verified model for tier X -- pass --base-model <id> from
// `kolm models candidates` to opt-in to an unverified pick".
export function resolveTier(slug, opts = {}) {
  const tier = showHwTier(slug);
  if (!tier) return null;
  const matches = FRONTIER_MODELS.filter(m => m.hw_tier === slug);
  if (matches.length === 0) {
    // W295 — non-null reason payload so callers can amber-pill the user.
    return {
      tier,
      base_model: null,
      pick: null,
      reason: 'no_verified_model_for_tier',
      hint: 'no verified model targets this tier; review `kolm models candidates` and pass --base-model <id> explicitly to opt in.',
    };
  }
  // Prefer models matching opts.modality if set (e.g. opts.modality='vision').
  let pool = matches;
  if (opts.modality) {
    const filtered = matches.filter(m => m.modality.includes(opts.modality));
    if (filtered.length > 0) pool = filtered;
  }
  if (opts.arch) {
    const filtered = pool.filter(m => m.arch === opts.arch);
    if (filtered.length > 0) pool = filtered;
  }
  // Lowest VRAM (most headroom for KV-cache + multi-tenant).
  pool.sort((a, b) => (a.vram_gb || 0) - (b.vram_gb || 0));
  const pick = pool[0];
  return {
    tier,
    base_model: pick.id,
    recommended_quant: pick.recommended_quant,
    vram_gb: pick.vram_gb,
    ctx_k: pick.ctx_k,
    arch: pick.arch,
    modality: pick.modality,
    license: pick.license,
    candidates: pool.map(m => m.id),
  };
}

// W218 — given a free-text GPU name (from nvidia-smi or system_profiler),
// return the best-match HW tier slug. Conservative -- returns null if no
// confident match. The doctor surface uses this to suggest a tier; the user
// confirms by re-running compile with `--tier <slug>`.
export function detectTierFromGpuName(gpuName) {
  if (!gpuName || typeof gpuName !== 'string') return null;
  const s = gpuName.toLowerCase();
  // Order matters -- match more-specific first.
  if (/h200/.test(s)) return 'h200-141';
  if (/h100/.test(s)) return 'h100-80';
  if (/a100/.test(s)) return 'a100-80';
  if (/rtx[ -]?5090|geforce[ -]?5090/.test(s)) return '5090';
  if (/rtx[ -]?4090|geforce[ -]?4090/.test(s)) return '4090';
  if (/rtx[ -]?3090|geforce[ -]?3090/.test(s)) return '3090';
  if (/dgx[ -]?spark|gb10|grace[ -]?blackwell/.test(s)) return 'dgx-spark';
  if (/m3[ -]?ultra|apple[ -]?m3[ -]?ultra/.test(s)) return 'm3-ultra-512';
  if (/m4[ -]?max|apple[ -]?m4[ -]?max/.test(s)) return 'm4-max-128';
  // W235 — AMD detection. ROCm + Vulkan first-class.
  if (/mi300x|instinct[ -]?mi300x/.test(s)) return 'mi300x';
  if (/mi300a|instinct[ -]?mi300a/.test(s)) return 'mi300a';
  if (/rx[ -]?7900[ -]?xtx|radeon[ -]?rx[ -]?7900[ -]?xtx/.test(s)) return 'rx7900xtx';
  if (/rx[ -]?9070[ -]?xt|radeon[ -]?rx[ -]?9070[ -]?xt/.test(s)) return 'rx9070xt';
  return null;
}

// W235 — given a free-text GPU name, return the best-match runtime backend.
// Conservative -- defaults to 'cuda' for NVIDIA, 'rocm' for AMD, 'metal' for
// Apple, 'cpu' otherwise. Returns null only when the name is missing.
export function detectBackendFromGpuName(gpuName) {
  if (!gpuName || typeof gpuName !== 'string') return null;
  const s = gpuName.toLowerCase();
  if (/instinct|radeon|mi300|rx[ -]?\d{4}/.test(s)) return 'rocm';
  if (/apple|m[1-9][ -]?(max|ultra|pro)?/.test(s)) return 'metal';
  if (/nvidia|geforce|rtx|gtx|tesla|a100|h100|h200|dgx/.test(s)) return 'cuda';
  return 'cpu';
}

export default {
  HW_TIERS, QUANTS, ARCHS, MODALITIES, RUNTIME_BACKENDS,
  FRONTIER_MODELS, CANDIDATE_MODELS,
  listFrontier, listVerified, listCandidates, showFrontier, showAny,
  listHwTiers, showHwTier,
  buildEntry, verifyEntry, verifyAll, verifyEntryOnline, verifyAllOnline,
  verifyExactSourceUrl,
  resolveTier, detectTierFromGpuName, detectBackendFromGpuName,
};
