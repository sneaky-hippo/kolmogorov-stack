// Curated base-model registry. Single source of truth for default selection.
//
// Selection criteria (in order):
//   1. License — Apache 2.0 / MIT / OpenRAIL-M preferred. Llama Community
//      license has a 700M-MAU clause that scares enterprise; allowed but not
//      default.
//   2. Tool/structured-output behavior — Qwen 2.5 family was trained on
//      tool-call traces; Llama 3.2 was not (only Llama 3.1 70B/405B). For a
//      compile-once-run-anywhere artifact that has to emit JSON receipts and
//      function calls, this is load-bearing.
//   3. VRAM at 4-bit QLoRA — fits-in-N rules let us match the tier to the
//      box. 0.5B fits in 1GB, 1.5B in 2GB, 3B in 4GB, 7B in 8GB.
//   4. Tokenizer quality + multilingual — Qwen tokenizer is BPE w/ 151K vocab
//      and handles non-Latin scripts cleanly. Llama 3.2 has 128K vocab with
//      better English compression but weaker on CJK / Cyrillic / Arabic.
//   5. Healthcare/medical benchmarks at scale — Qwen 2.5 3B sits within 2pp
//      of Llama 3.2 3B on MedQA / MMLU-medical at its size class.
//
// We canonicalize HuggingFace org/name. GGUF aliases (e.g. "qwen2.5:3b") are
// not in this registry; they belong to the runtime layer (Ollama, llama.cpp).

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const MODELS = [
  // ----- Qwen 2.5 family (DEFAULT FAMILY) -----
  {
    id: 'Qwen/Qwen2.5-0.5B-Instruct',
    family: 'qwen2.5',
    params_b: 0.5,
    license: 'apache-2.0',
    tier: 'tiny',
    vram_gb_4bit: 1.0,
    vram_gb_bf16: 1.5,
    context_tokens: 32768,
    tokenizer_vocab: 151936,
    tool_use: 'native',
    multilingual: true,
    notes: 'Phone / Raspberry Pi / WASM. Fastest inference; weakest reasoning.',
    use_for: ['edge', 'mobile', 'wasm'],
  },
  {
    id: 'Qwen/Qwen2.5-1.5B-Instruct',
    family: 'qwen2.5',
    params_b: 1.5,
    license: 'apache-2.0',
    tier: 'small',
    vram_gb_4bit: 2.0,
    vram_gb_bf16: 3.5,
    context_tokens: 32768,
    tokenizer_vocab: 151936,
    tool_use: 'native',
    multilingual: true,
    notes: 'Laptop iGPU / Apple Silicon 8GB. Solid SFT target for classifiers.',
    use_for: ['laptop', 'classifier', 'extractor'],
  },
  {
    id: 'Qwen/Qwen2.5-3B-Instruct',
    family: 'qwen2.5',
    params_b: 3,
    license: 'apache-2.0',
    tier: 'default',
    vram_gb_4bit: 4.0,
    vram_gb_bf16: 7.0,
    context_tokens: 32768,
    tokenizer_vocab: 151936,
    tool_use: 'native',
    multilingual: true,
    notes: 'DEFAULT. Apache 2.0, strong tool/JSON, fits in 8GB consumer GPU.',
    use_for: ['default', 'chat', 'agent', 'healthcare', 'finance', 'legal'],
  },
  {
    id: 'Qwen/Qwen2.5-7B-Instruct',
    family: 'qwen2.5',
    params_b: 7,
    license: 'apache-2.0',
    tier: 'quality',
    vram_gb_4bit: 8.0,
    vram_gb_bf16: 16.0,
    context_tokens: 131072,
    tokenizer_vocab: 151936,
    tool_use: 'native',
    multilingual: true,
    notes: 'Quality tier. 128K context via YaRN. RTX 4090 / single A100 friendly.',
    use_for: ['quality', 'long-context', 'rag'],
  },
  {
    id: 'Qwen/Qwen2.5-Coder-7B-Instruct',
    family: 'qwen2.5-coder',
    params_b: 7,
    license: 'apache-2.0',
    tier: 'coder',
    vram_gb_4bit: 8.0,
    vram_gb_bf16: 16.0,
    context_tokens: 131072,
    tokenizer_vocab: 151936,
    tool_use: 'native',
    multilingual: true,
    notes: 'Code-specialized. HumanEval 88.4. Use for IDE / repo agents.',
    use_for: ['code', 'agent'],
  },
  {
    id: 'Qwen/Qwen2.5-14B-Instruct',
    family: 'qwen2.5',
    params_b: 14,
    license: 'apache-2.0',
    tier: 'large',
    vram_gb_4bit: 16.0,
    vram_gb_bf16: 30.0,
    context_tokens: 131072,
    tokenizer_vocab: 151936,
    tool_use: 'native',
    multilingual: true,
    notes: 'Server-class. A100-40GB / H100. Best K-score in tests at 14B.',
    use_for: ['server', 'high-stakes'],
  },

  // ----- Llama 3.2 family (alternate, English-first) -----
  {
    id: 'meta-llama/Llama-3.2-1B-Instruct',
    family: 'llama3.2',
    params_b: 1,
    license: 'llama-community',
    tier: 'tiny',
    vram_gb_4bit: 1.5,
    vram_gb_bf16: 2.5,
    context_tokens: 131072,
    tokenizer_vocab: 128256,
    tool_use: 'limited',
    multilingual: false,
    notes: 'English-first edge model. Use when Apache license not required.',
    use_for: ['edge', 'english-only'],
  },
  {
    id: 'meta-llama/Llama-3.2-3B-Instruct',
    family: 'llama3.2',
    params_b: 3,
    license: 'llama-community',
    tier: 'alternate-default',
    vram_gb_4bit: 4.0,
    vram_gb_bf16: 7.5,
    context_tokens: 131072,
    tokenizer_vocab: 128256,
    tool_use: 'limited',
    multilingual: false,
    notes: 'Stronger raw English than Qwen 2.5 3B; weaker JSON/tool. 128K context.',
    use_for: ['english-only', 'long-context'],
  },
  {
    id: 'meta-llama/Llama-3.1-8B-Instruct',
    family: 'llama3.1',
    params_b: 8,
    license: 'llama-community',
    tier: 'quality',
    vram_gb_4bit: 9.0,
    vram_gb_bf16: 18.0,
    context_tokens: 131072,
    tokenizer_vocab: 128256,
    tool_use: 'good',
    multilingual: false,
    notes: 'Mature stack, lots of LoRA examples, strong eval coverage.',
    use_for: ['quality', 'english-only'],
  },

  // ----- Phi 3.5 family (small + reasoning) -----
  {
    id: 'microsoft/Phi-3.5-mini-instruct',
    family: 'phi3.5',
    params_b: 3.8,
    license: 'mit',
    tier: 'reasoning-small',
    vram_gb_4bit: 4.5,
    vram_gb_bf16: 8.0,
    context_tokens: 131072,
    tokenizer_vocab: 32064,
    tool_use: 'good',
    multilingual: true,
    notes: 'MIT license. Stronger reasoning than Qwen 3B; weaker generation diversity.',
    use_for: ['reasoning', 'classifier', 'mit-only'],
  },

  // ----- Gemma 3 family (Google, instruction-tuned, 2025) -----
  {
    id: 'google/gemma-3-1b-it',
    family: 'gemma3',
    params_b: 1,
    license: 'gemma',
    tier: 'tiny',
    vram_gb_4bit: 1.5,
    vram_gb_bf16: 2.5,
    context_tokens: 32768,
    tokenizer_vocab: 262144,
    tool_use: 'limited',
    multilingual: true,
    notes: 'Mobile target. Released 2025-03. Verified on iPhone 15 Pro via MLC.',
    use_for: ['mobile', 'edge'],
  },
  {
    id: 'google/gemma-3-4b-it',
    family: 'gemma3',
    params_b: 4,
    license: 'gemma',
    tier: 'small',
    vram_gb_4bit: 4.5,
    vram_gb_bf16: 8.5,
    context_tokens: 131072,
    tokenizer_vocab: 262144,
    tool_use: 'good',
    multilingual: true,
    notes: 'Closest match to the "Gemma 3B" target user referenced. Image+text input.',
    use_for: ['mobile', 'vision', 'multilingual'],
  },
  {
    id: 'google/gemma-3-12b-it',
    family: 'gemma3',
    params_b: 12,
    license: 'gemma',
    tier: 'large',
    vram_gb_4bit: 14.0,
    vram_gb_bf16: 26.0,
    context_tokens: 131072,
    tokenizer_vocab: 262144,
    tool_use: 'good',
    multilingual: true,
    notes: 'Vision+text 12B. Fits 5090 4-bit with room for batch.',
    use_for: ['vision', 'quality'],
  },

  // ----- Gemma 2 family (Google, kept for legacy compat) -----
  {
    id: 'google/gemma-2-2b-it',
    family: 'gemma2',
    params_b: 2,
    license: 'gemma',
    tier: 'small',
    vram_gb_4bit: 2.5,
    vram_gb_bf16: 5.0,
    context_tokens: 8192,
    tokenizer_vocab: 256000,
    tool_use: 'limited',
    multilingual: true,
    notes: 'Legacy. Prefer gemma-3-1b-it for new edge work.',
    use_for: ['classifier', 'extractor'],
  },

  // ----- Gemma 3n family (Google, on-device, Per-Layer Embeddings) -----
  // Released Google I/O 2025. "E2B" and "E4B" describe effective parameters
  // after selective activation; raw weight counts are larger (5B / 8B). RAM
  // figures reflect the selective-activation footprint, not raw bytes on disk.
  {
    id: 'google/gemma-3n-E2B-it',
    family: 'gemma3n',
    params_b: 2,
    params_b_raw: 5,
    license: 'gemma',
    tier: 'mobile-selective',
    vram_gb_4bit: 2.5,
    vram_gb_bf16: 4.0,
    context_tokens: 32768,
    tokenizer_vocab: 262144,
    tool_use: 'good',
    multilingual: true,
    modalities: ['text', 'image', 'audio', 'video'],
    notes: 'On-device Gemma. Per-Layer Embeddings: 2B effective, 5B raw weights.',
    use_for: ['mobile', 'edge', 'multimodal', 'on-device-clinical-intake'],
  },
  {
    id: 'google/gemma-3n-E4B-it',
    family: 'gemma3n',
    params_b: 4,
    params_b_raw: 8,
    license: 'gemma',
    tier: 'mobile-selective',
    vram_gb_4bit: 4.0,
    vram_gb_bf16: 6.5,
    context_tokens: 32768,
    tokenizer_vocab: 262144,
    tool_use: 'good',
    multilingual: true,
    modalities: ['text', 'image', 'audio', 'video'],
    notes: 'On-device Gemma. 4B effective, 8B raw weights. Stronger than E2B.',
    use_for: ['mobile', 'edge', 'multimodal', 'on-device-clinical-intake'],
  },

  // ----- MedGemma family (Google, medical Q&A; HIPAA workloads need BAA) -----
  // Released May 2025 at I/O. Trained on deidentified medical literature and
  // clinical notes. Intended use is decision-support; downstream clinical
  // deployment requires human review + local validation per Google model card.
  {
    id: 'google/medgemma-4b-it',
    family: 'medgemma',
    params_b: 4,
    license: 'health-ai-developer-foundations',
    tier: 'medical-small',
    vram_gb_4bit: 4.5,
    vram_gb_bf16: 8.0,
    context_tokens: 8192,
    tokenizer_vocab: 262144,
    tool_use: 'limited',
    multilingual: false,
    modalities: ['text', 'image'],
    notes: 'Medical-tuned Gemma 3 4B. Vision+text; supports radiology Q&A. Not for direct clinical decisions; require local eval + clinician review.',
    use_for: ['medical-qa', 'radiology-text', 'clinical-summary'],
  },
  {
    id: 'google/medgemma-4b-pt',
    family: 'medgemma',
    params_b: 4,
    license: 'health-ai-developer-foundations',
    tier: 'medical-small-pt',
    vram_gb_4bit: 4.5,
    vram_gb_bf16: 8.0,
    context_tokens: 8192,
    tokenizer_vocab: 262144,
    tool_use: 'none',
    multilingual: false,
    modalities: ['text', 'image'],
    notes: 'Pretrained (not instruction-tuned). Use as base for domain SFT/LoRA.',
    use_for: ['medical-finetune-base'],
  },
  {
    id: 'google/medgemma-27b-text-it',
    family: 'medgemma',
    params_b: 27,
    license: 'health-ai-developer-foundations',
    tier: 'medical-large',
    vram_gb_4bit: 18.0,
    vram_gb_bf16: 54.0,
    context_tokens: 8192,
    tokenizer_vocab: 262144,
    tool_use: 'limited',
    multilingual: false,
    modalities: ['text'],
    notes: 'Text-only MedGemma. Best benchmark scores in family; A100-40GB+ class.',
    use_for: ['medical-qa', 'clinical-summary', 'high-stakes-medical'],
  },

  // ----- EmbeddingGemma (Google, 308M, multilingual embeddings) -----
  // Released September 2025. Top MTEB scores at the <500M tier. 100+ languages.
  // Use for kolm RAG / index.sqlite-vec when staying on the Gemma stack matters
  // (consistent tokenizer; same provider; compact).
  {
    id: 'google/embeddinggemma-300m',
    family: 'embeddinggemma',
    params_b: 0.308,
    license: 'gemma',
    tier: 'embedding',
    vram_gb_4bit: 0.5,
    vram_gb_bf16: 0.8,
    context_tokens: 2048,
    tokenizer_vocab: 262144,
    tool_use: 'none',
    multilingual: true,
    modalities: ['text'],
    embedding_dim: 768,
    embedding_matryoshka: [768, 512, 256, 128],
    notes: 'Embedding model. 100+ languages. Matryoshka representation (truncatable). Pair with EmbeddingGemma tokenizer; do not mix with Qwen embeddings in same index.',
    use_for: ['embedding', 'rag', 'similarity-search', 'on-device-rag'],
  },

  // ----- DeepSeek R1 distilled (Chinese-origin; Q1 2025) -----
  // The user's Round-10 "Chinese models distill American models" pattern.
  // R1 itself is 671B MoE and not a kolm target; the distilled-to-smaller
  // variants are real, ship as MIT, and are practical SFT bases.
  {
    id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B',
    family: 'deepseek-r1-distill',
    params_b: 1.5,
    license: 'mit',
    tier: 'reasoning-tiny',
    vram_gb_4bit: 2.0,
    vram_gb_bf16: 3.5,
    context_tokens: 131072,
    tokenizer_vocab: 151936,
    tool_use: 'limited',
    multilingual: true,
    notes: 'Reasoning trace distilled into Qwen 2.5 1.5B base. MIT. Strong on math/code at this size.',
    use_for: ['reasoning', 'math', 'classifier'],
  },
  {
    id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
    family: 'deepseek-r1-distill',
    params_b: 7,
    license: 'mit',
    tier: 'reasoning-quality',
    vram_gb_4bit: 8.0,
    vram_gb_bf16: 16.0,
    context_tokens: 131072,
    tokenizer_vocab: 151936,
    tool_use: 'limited',
    multilingual: true,
    notes: 'Reasoning trace distilled into Qwen 2.5 7B. Best <10B reasoning at MIT license.',
    use_for: ['reasoning', 'math', 'agent'],
  },
  {
    id: 'deepseek-ai/DeepSeek-R1-Distill-Llama-8B',
    family: 'deepseek-r1-distill',
    params_b: 8,
    license: 'llama-community',
    tier: 'reasoning-quality',
    vram_gb_4bit: 9.0,
    vram_gb_bf16: 18.0,
    context_tokens: 131072,
    tokenizer_vocab: 128256,
    tool_use: 'limited',
    multilingual: false,
    notes: 'Reasoning trace distilled into Llama 3.1 8B. Llama-Community license.',
    use_for: ['reasoning', 'english-only'],
  },

  // ----- GLM-4 (Zhipu AI; Apache 2.0 since GLM-4.5; verify exact SKU) -----
  {
    id: 'THUDM/glm-4-9b-chat',
    family: 'glm-4',
    params_b: 9,
    license: 'glm-license',
    tier: 'quality',
    vram_gb_4bit: 10.0,
    vram_gb_bf16: 19.0,
    context_tokens: 131072,
    tokenizer_vocab: 151552,
    tool_use: 'good',
    multilingual: true,
    notes: 'Zhipu AI. Strong CJK. License terms tighter than Apache; verify before commercial ship.',
    use_for: ['chinese-language', 'multilingual', 'long-context'],
  },

  // ----- Yi-1.5 (01.AI; Apache 2.0) -----
  {
    id: '01-ai/Yi-1.5-6B-Chat',
    family: 'yi-1.5',
    params_b: 6,
    license: 'apache-2.0',
    tier: 'quality',
    vram_gb_4bit: 7.0,
    vram_gb_bf16: 13.0,
    context_tokens: 4096,
    tokenizer_vocab: 64000,
    tool_use: 'limited',
    multilingual: true,
    notes: 'Apache 2.0 alternate for ~7B class. Smaller context than Qwen 2.5 7B.',
    use_for: ['quality', 'chinese-language'],
  },

  // ----- Mistral / Ministral (newer small) -----
  {
    id: 'mistralai/Ministral-3B-Instruct-2410',
    family: 'ministral',
    params_b: 3,
    license: 'mrl-research',
    tier: 'small',
    vram_gb_4bit: 4.0,
    vram_gb_bf16: 7.0,
    context_tokens: 131072,
    tokenizer_vocab: 131072,
    tool_use: 'good',
    multilingual: true,
    notes: 'MRL license blocks commercial use; research/eval only by default.',
    use_for: ['research'],
  },

  // ----- SmolLM 2 (HF, MIT, very small) -----
  {
    id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
    family: 'smollm2',
    params_b: 1.7,
    license: 'apache-2.0',
    tier: 'tiny',
    vram_gb_4bit: 2.5,
    vram_gb_bf16: 4.0,
    context_tokens: 8192,
    tokenizer_vocab: 49152,
    tool_use: 'limited',
    multilingual: false,
    notes: 'Apache 2.0 alternate for tiny tier. English only.',
    use_for: ['edge', 'classifier'],
  },
];

export const DEFAULT_MODEL = 'Qwen/Qwen2.5-3B-Instruct';

export const TIER_BY_USE = {
  default: 'Qwen/Qwen2.5-3B-Instruct',
  chat: 'Qwen/Qwen2.5-3B-Instruct',
  agent: 'Qwen/Qwen2.5-3B-Instruct',
  healthcare: 'Qwen/Qwen2.5-3B-Instruct',
  finance: 'Qwen/Qwen2.5-3B-Instruct',
  legal: 'Qwen/Qwen2.5-3B-Instruct',
  code: 'Qwen/Qwen2.5-Coder-7B-Instruct',
  edge: 'Qwen/Qwen2.5-0.5B-Instruct',
  mobile: 'Qwen/Qwen2.5-0.5B-Instruct',
  wasm: 'Qwen/Qwen2.5-0.5B-Instruct',
  laptop: 'Qwen/Qwen2.5-1.5B-Instruct',
  classifier: 'Qwen/Qwen2.5-1.5B-Instruct',
  extractor: 'Qwen/Qwen2.5-1.5B-Instruct',
  quality: 'Qwen/Qwen2.5-7B-Instruct',
  'long-context': 'Qwen/Qwen2.5-7B-Instruct',
  rag: 'Qwen/Qwen2.5-7B-Instruct',
  server: 'Qwen/Qwen2.5-14B-Instruct',
  'high-stakes': 'Qwen/Qwen2.5-14B-Instruct',
  reasoning: 'microsoft/Phi-3.5-mini-instruct',
  // Healthcare lighthouse tier picks.
  'medical-qa': 'google/medgemma-4b-it',
  'radiology-text': 'google/medgemma-4b-it',
  'clinical-summary': 'google/medgemma-27b-text-it',
  'high-stakes-medical': 'google/medgemma-27b-text-it',
  'medical-finetune-base': 'google/medgemma-4b-pt',
  // On-device intake (HIPAA-friendly: never leaves device).
  'on-device-clinical-intake': 'google/gemma-3n-E2B-it',
  multimodal: 'google/gemma-3n-E4B-it',
  // Embeddings for RAG / index.sqlite-vec.
  embedding: 'google/embeddinggemma-300m',
  'similarity-search': 'google/embeddinggemma-300m',
  'on-device-rag': 'google/embeddinggemma-300m',
  'reasoning-quality': 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
  math: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B',
  'chinese-language': 'Qwen/Qwen2.5-7B-Instruct',
};

export const PERMISSIVE_LICENSES = new Set(['apache-2.0', 'mit']);

export function list(filter = {}) {
  let out = MODELS.slice();
  if (filter.family) out = out.filter(m => m.family === filter.family);
  if (filter.tier) out = out.filter(m => m.tier === filter.tier);
  if (filter.license) out = out.filter(m => m.license === filter.license);
  if (filter.permissive) out = out.filter(m => PERMISSIVE_LICENSES.has(m.license));
  if (filter.max_vram_gb != null) {
    out = out.filter(m => m.vram_gb_4bit <= filter.max_vram_gb);
  }
  if (filter.tool_use) out = out.filter(m => m.tool_use === filter.tool_use || m.tool_use === 'native');
  return out;
}

export function info(id) {
  return MODELS.find(m => m.id === id) || null;
}

// Pick a base model from a soft requirements bag.
// reqs: {use, vram_gb, license, english_only, tool_use, context_tokens,
//        target_device, train_device}
// Score: weight by license-strength, vram-fit, tool-use, context, multilingual.
//
// If target_device or train_device is provided, hard-filter to models that
// actually fit / can train there. This is the device-first path the artifact
// uses when compile-for-device is set.
export function recommend(reqs = {}) {
  const use = reqs.use || 'default';
  const explicit = TIER_BY_USE[use];
  let vram = reqs.vram_gb != null ? Number(reqs.vram_gb) : null;
  const requirePermissive = reqs.permissive === true;

  // Resolve device-derived vram if devices are passed.
  if (reqs.target_device && vram == null) {
    vram = reqs.target_device.vram_gb;
  }

  // Score every candidate; pick max.
  const scored = MODELS.map(m => {
    let s = 0;
    // license: apache/mit > gemma > llama-community > mrl-research
    if (m.license === 'apache-2.0') s += 0.30;
    else if (m.license === 'mit') s += 0.28;
    else if (m.license === 'gemma') s += 0.15;
    else if (m.license === 'llama-community') s += 0.10;
    else s += 0.0;
    if (requirePermissive && !PERMISSIVE_LICENSES.has(m.license)) s -= 1.0;

    // vram fit (4-bit): hard fail if doesn't fit; soft prefer larger.
    if (vram != null) {
      if (m.vram_gb_4bit > vram) s -= 1.0;
      else s += 0.20 * (1 - (vram - m.vram_gb_4bit) / Math.max(vram, 1));
    } else {
      // No vram constraint: prefer 3B class.
      if (m.params_b >= 2 && m.params_b <= 4) s += 0.15;
    }

    // tool use
    if (reqs.tool_use === 'native' && m.tool_use === 'native') s += 0.10;
    else if (m.tool_use === 'native' || m.tool_use === 'good') s += 0.05;

    // context
    if (reqs.context_tokens != null && m.context_tokens >= reqs.context_tokens) s += 0.05;

    // multilingual unless explicitly english_only
    if (reqs.english_only !== true && m.multilingual) s += 0.05;

    // explicit-use bonus
    if (m.use_for.includes(use)) s += 0.20;

    // device fit gating: hard-fail if won't fit on target_device.
    if (reqs.target_device) {
      if (!fitsOn(m.id, reqs.target_device)) s -= 1.0;
    }
    if (reqs.train_device) {
      if (!trainOn(m.id, reqs.train_device)) s -= 1.0;
    }

    return { model: m, score: Number(s.toFixed(4)) };
  }).sort((a, b) => b.score - a.score);

  // Filter out negative-score picks (failed device gate) from the public result.
  const viable = scored.filter(s => s.score > 0);
  const fallback = scored[0];
  const pickRow = viable[0] || fallback;

  return {
    pick: pickRow.model.id,
    explicit_tier_pick: explicit || null,
    top: scored.slice(0, 5).map(s => ({ id: s.model.id, score: s.score })),
    device_fit: reqs.target_device ? fitsOn(pickRow.model.id, reqs.target_device) : null,
    device_train: reqs.train_device ? trainOn(pickRow.model.id, reqs.train_device) : null,
  };
}

// Does a model fit on a given device at 4-bit (inference)?
// Reserve 2GB for KV cache + activations.
export function fitsOn(modelId, device) {
  const m = info(modelId);
  if (!m || !device) return false;
  if (device.vram_gb == null) return false;
  if (device.vram_gb === 0) {
    // CPU-only: use cpu_ram_gb_min as the floor; rough rule is 0.6GB / 1B at Q4.
    const need = 0.6 * m.params_b;
    return need <= (device.cpu_ram_gb_min || 8);
  }
  return m.vram_gb_4bit + 2 <= device.vram_gb;
}

// Can we TRAIN this model on the given device at QLoRA?
// Rule: 4-bit base + bf16 LoRA + optimizer state + grad ~= 2x base + 4GB.
export function trainOn(modelId, device) {
  const m = info(modelId);
  if (!m || !device || device.class !== 'training') return false;
  if (device.vram_gb == null || device.vram_gb === 0) return false;
  const need = (m.vram_gb_4bit * 2) + 4;
  return need <= device.vram_gb;
}

// Tenant pin: simple JSON file at .kolm/model-pins.json.
const PIN_FILE = path.join(process.env.KOLM_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kolm'), 'model-pins.json');

export async function getPin(tenant) {
  try {
    const buf = await fs.readFile(PIN_FILE, 'utf8');
    const pins = JSON.parse(buf);
    return pins[tenant] || null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function setPin(tenant, modelId) {
  if (!info(modelId)) throw new Error(`unknown model: ${modelId}`);
  let pins = {};
  try {
    const buf = await fs.readFile(PIN_FILE, 'utf8');
    pins = JSON.parse(buf);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  pins[tenant] = modelId;
  await fs.mkdir(path.dirname(PIN_FILE), { recursive: true });
  await fs.writeFile(PIN_FILE, JSON.stringify(pins, null, 2), 'utf8');
  return modelId;
}

// Resolve the base model: tenant pin > KOLM_BASE_MODEL env > registry default.
export async function resolveBase(opts = {}) {
  if (opts.tenant) {
    const pinned = await getPin(opts.tenant);
    if (pinned) return pinned;
  }
  if (process.env.KOLM_BASE_MODEL) return process.env.KOLM_BASE_MODEL;
  if (opts.use) {
    const t = TIER_BY_USE[opts.use];
    if (t) return t;
  }
  return DEFAULT_MODEL;
}

export default { MODELS, DEFAULT_MODEL, TIER_BY_USE, list, info, recommend, getPin, setPin, resolveBase, fitsOn, trainOn };
