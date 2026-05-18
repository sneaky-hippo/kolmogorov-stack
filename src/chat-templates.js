// W234 — chat templates + Qwen Thinking Mode preset embedded in .kolm.
//
// A .kolm artifact carries a `chat_template` block in its manifest so the
// runtime applies the right BOS/EOS/system/user/assistant markers without
// asking the user. This module is the source of truth for the templates we
// ship out of the box. Each template is a pure function (history → string)
// plus declarative metadata (markers, stop_tokens, preset flags) so the
// .kolm format can serialize it without depending on JS.
//
// Templates ship versioned. Bumping a template MUST bump the version so
// re-compiled artifacts can opt in. The runtime checks
// chat_template.version_id against this registry on load.
//
// Qwen Thinking Mode (qwen-3-thinking): wraps user turns with
// <thinking>...</thinking> assistant scratchpad markers. The preset is
// off by default; opt in per-spec via spec.chat_template = "qwen-3-thinking"
// or per-call via the proxy header x-kolm-think: 1.

import crypto from 'node:crypto';

export const TEMPLATE_REGISTRY_VERSION = '1.0.0';

// Canonical templates. Order matters: first match wins when `pickTemplate`
// is asked to infer from a base-model name.
export const TEMPLATES = Object.freeze({
  'chatml': {
    name: 'chatml',
    version_id: 'chatml@1.0',
    description: 'Standard ChatML markers (Qwen 2.5, many MoE bases).',
    matches: [/^Qwen\/Qwen2\.5/i, /^Qwen\/Qwen3-/i, /^qwen2\.5/i, /chatml/i],
    bos_token: '<|im_start|>',
    eos_token: '<|im_end|>',
    stop_tokens: ['<|im_end|>', '<|endoftext|>'],
    thinking: false,
    apply: (history) => {
      const parts = [];
      for (const m of history) {
        parts.push(`<|im_start|>${m.role}\n${m.content}<|im_end|>`);
      }
      parts.push('<|im_start|>assistant\n');
      return parts.join('\n');
    },
  },
  'qwen-3-thinking': {
    name: 'qwen-3-thinking',
    version_id: 'qwen-3-thinking@1.0',
    description: 'Qwen 3 Thinking Mode: assistant emits <thinking>...</thinking> scratchpad before the visible answer; the runtime strips it from end-user output unless x-kolm-keep-thinking: 1.',
    matches: [/Qwen3-Thinking/i, /Qwen3.*Thinking/i, /qwen-3.*think/i],
    bos_token: '<|im_start|>',
    eos_token: '<|im_end|>',
    stop_tokens: ['<|im_end|>', '<|endoftext|>'],
    thinking: true,
    thinking_open: '<thinking>',
    thinking_close: '</thinking>',
    apply: (history, { think = true } = {}) => {
      const parts = [];
      for (const m of history) {
        parts.push(`<|im_start|>${m.role}\n${m.content}<|im_end|>`);
      }
      parts.push('<|im_start|>assistant\n' + (think ? '<thinking>\n' : ''));
      return parts.join('\n');
    },
    extractAnswer: (text) => {
      const m = String(text || '').match(/<\/thinking>\s*([\s\S]*?)$/);
      return m ? m[1].trim() : String(text || '').trim();
    },
    extractThinking: (text) => {
      const m = String(text || '').match(/<thinking>([\s\S]*?)<\/thinking>/);
      return m ? m[1].trim() : '';
    },
  },
  'llama-3': {
    name: 'llama-3',
    version_id: 'llama-3@1.0',
    description: 'Llama 3 header_id template.',
    matches: [/^meta-llama\/Llama-3/i, /^Meta-Llama-3/i, /llama-?3/i],
    bos_token: '<|begin_of_text|>',
    eos_token: '<|eot_id|>',
    stop_tokens: ['<|eot_id|>', '<|end_of_text|>'],
    thinking: false,
    apply: (history) => {
      const parts = ['<|begin_of_text|>'];
      for (const m of history) {
        parts.push(`<|start_header_id|>${m.role}<|end_header_id|>\n\n${m.content}<|eot_id|>`);
      }
      parts.push('<|start_header_id|>assistant<|end_header_id|>\n\n');
      return parts.join('');
    },
  },
  'phi-3': {
    name: 'phi-3',
    version_id: 'phi-3@1.0',
    description: 'Phi-3 simple <|user|>/<|assistant|> template.',
    matches: [/^microsoft\/phi-3/i, /^phi-3/i],
    bos_token: '<|user|>',
    eos_token: '<|end|>',
    stop_tokens: ['<|end|>', '<|endoftext|>'],
    thinking: false,
    apply: (history) => {
      const parts = [];
      for (const m of history) {
        parts.push(`<|${m.role}|>\n${m.content}<|end|>`);
      }
      parts.push('<|assistant|>\n');
      return parts.join('\n');
    },
  },
  'deepseek-v4': {
    name: 'deepseek-v4',
    version_id: 'deepseek-v4@1.0',
    description: 'DeepSeek v4 dialogue template (User: / Assistant:).',
    matches: [/^DeepSeek-V4/i, /^deepseek-v4/i],
    bos_token: '',
    eos_token: '\n\n',
    stop_tokens: ['\n\nUser:', '\n\nAssistant:'],
    thinking: false,
    apply: (history) => {
      const parts = [];
      for (const m of history) {
        const r = m.role === 'assistant' ? 'Assistant' : (m.role === 'system' ? 'System' : 'User');
        parts.push(`${r}: ${m.content}`);
      }
      parts.push('Assistant: ');
      return parts.join('\n\n');
    },
  },
  'plain': {
    name: 'plain',
    version_id: 'plain@1.0',
    description: 'No markers; raw concatenation. Default fallback.',
    matches: [],
    bos_token: '',
    eos_token: '',
    stop_tokens: [],
    thinking: false,
    apply: (history) => history.map((m) => m.content).join('\n\n'),
  },
});

export const TEMPLATE_NAMES = Object.freeze(Object.keys(TEMPLATES));

// Pick the best template for a base-model name. Returns the template object.
// Falls back to 'plain' if nothing matches.
export function pickTemplate(baseModelName) {
  const name = String(baseModelName || '');
  for (const t of Object.values(TEMPLATES)) {
    for (const re of t.matches) if (re.test(name)) return t;
  }
  return TEMPLATES['plain'];
}

// Resolve by explicit name. Throws on unknown name (callers should validate
// the spec.chat_template field at compile time, not at runtime).
export function getTemplate(name) {
  const t = TEMPLATES[name];
  if (!t) throw new Error(`unknown chat template: ${name} (known: ${TEMPLATE_NAMES.join(', ')})`);
  return t;
}

// Apply a template to a history array. history is [{role, content}, ...].
// Returns the prompt string the runtime will feed to the base model.
export function apply(template, history, opts = {}) {
  const t = typeof template === 'string' ? getTemplate(template) : template;
  return t.apply(Array.isArray(history) ? history : [], opts);
}

// Build the manifest block that gets embedded in a .kolm artifact. Includes
// version + integrity hash so the runtime can verify the template wasn't
// tampered with on disk.
export function manifestBlock(name, { thinking = null } = {}) {
  const t = getTemplate(name);
  const body = {
    name: t.name,
    version_id: t.version_id,
    bos_token: t.bos_token,
    eos_token: t.eos_token,
    stop_tokens: t.stop_tokens,
    thinking: thinking == null ? t.thinking : Boolean(thinking),
    thinking_open: t.thinking_open || null,
    thinking_close: t.thinking_close || null,
  };
  const canonical = JSON.stringify(body);
  const integrity_hash = crypto.createHash('sha256').update(canonical).digest('hex');
  return { ...body, integrity_hash, registry_version: TEMPLATE_REGISTRY_VERSION };
}

export default {
  TEMPLATE_REGISTRY_VERSION,
  TEMPLATES,
  TEMPLATE_NAMES,
  pickTemplate,
  getTemplate,
  apply,
  manifestBlock,
};
