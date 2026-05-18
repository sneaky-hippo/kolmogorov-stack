// W236 — Hermes-agent recipe export + self-growing agent blueprint.
//
// Two concerns live here:
//
//   1. `exportHermesAgent(artifact)` — take a .kolm artifact manifest and emit
//      a Hermes-4-compatible agent definition: a system prompt + the tool
//      schema NousResearch uses for tool-calling. The artifact's recipes
//      become tools. The artifact's chat_template (W234) becomes the prompt
//      wrapping. Output is a single JSON object the user can hand to a
//      Hermes runtime (vLLM, llama.cpp, hf transformers serve).
//
//   2. `buildSelfGrowingBlueprint(opts)` — a YAML/JSON blueprint describing
//      an agent that captures its own interactions, distills new specialists
//      when capture thresholds fire (W215), and exposes the grown specialists
//      as new tools without a human in the loop. The blueprint is the
//      machine-readable contract for "self-growing" — kolm runs the loop;
//      kolm does not hide what the loop is doing.
//
// Why this matters: the @sudoingX 2026-05-17 thread calls out Hermes as the
// agent layer most worth shipping a clean export to. The blueprint side
// addresses the user's "FINISH OUR ENTIRE PRODUCT OFFERING" + "We should be
// so frontier as to offer these features in product" — a self-growing agent
// is the difference between "you can use kolm" and "kolm runs the loop".

import crypto from 'node:crypto';

export const BLUEPRINT_SCHEMA_VERSION = '1.0.0';
export const HERMES_TOOL_SCHEMA_VERSION = 'hermes-fn-v1';

// The system-prompt framing Hermes is trained on for tool-call mode. Keep
// terse — the artifact's own system prompt slots in below.
const HERMES_SYSTEM_PREAMBLE =
  'You are a function-calling AI. You can call the tools below by emitting a ' +
  '<tool_call>{"name": "<tool>", "arguments": {...}}</tool_call> block. ' +
  'Wait for the <tool_response>...</tool_response> reply before continuing. ' +
  'When done, emit a final answer outside any tool tags.';

// Map a .kolm recipe to a Hermes tool definition. Each recipe becomes a
// single callable function: the recipe id is the function name, the recipe's
// signature (inputs + outputs) becomes the JSON schema.
function recipeToHermesTool(recipe) {
  const id = recipe.id || recipe.name || 'recipe';
  const description = recipe.description || recipe.one_line || `Run the ${id} recipe.`;
  const inputSchema = recipe.input_schema || {
    type: 'object',
    properties: { input: { type: 'string', description: 'Free-text input to the recipe.' } },
    required: ['input'],
  };
  return {
    type: 'function',
    function: {
      name: id.replace(/[^a-zA-Z0-9_]/g, '_'),
      description,
      parameters: inputSchema,
    },
  };
}

// Take a .kolm artifact manifest and emit a Hermes-compatible agent JSON.
// `artifact` should be the manifest object (the JSON inside the .kolm at
// manifest.json). Returns { system_prompt, tools, chat_template,
// integrity_hash, runtime_hints }.
export function exportHermesAgent(artifact, opts = {}) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('exportHermesAgent: artifact must be an object');
  }
  const recipes = Array.isArray(artifact.recipes) ? artifact.recipes : [];
  const tools = recipes.map(recipeToHermesTool);
  const persona = opts.persona ||
    artifact.persona ||
    artifact.system_prompt ||
    `kolm-compiled agent. Spec: ${artifact.task || artifact.spec || 'unspecified'}.`;
  const system_prompt = `${HERMES_SYSTEM_PREAMBLE}\n\n${persona}`;
  const chat_template = artifact.chat_template || { name: 'chatml', version_id: 'chatml@1.0' };
  const body = {
    schema_version: HERMES_TOOL_SCHEMA_VERSION,
    system_prompt,
    tools,
    chat_template,
    artifact_class: artifact.artifact_class || 'rule',
    artifact_hash: artifact.artifact_hash || null,
    runtime_hints: {
      stop_tokens: chat_template.stop_tokens || ['<|im_end|>', '</tool_call>'],
      max_tool_calls: opts.max_tool_calls || 12,
      tool_choice: opts.tool_choice || 'auto',
    },
  };
  const canonical = JSON.stringify(body);
  const integrity_hash = crypto.createHash('sha256').update(canonical).digest('hex');
  return { ...body, integrity_hash };
}

// Build a self-growing agent blueprint. The blueprint declares:
//   - starting_artifact: the .kolm to bootstrap from (can be omitted for a
//     bare agent that grows from zero).
//   - capture: which prompts to capture into which namespace.
//   - growth: when to spawn new specialists from captured prompts.
//   - tools: which recipes (existing + future) to expose as Hermes tools.
//   - mentor_model: the teacher used for growth distillations.
//
// The CLI / runtime consumes this YAML/JSON and runs the loop. The user can
// inspect or hand-edit; nothing about "self-growing" is implicit.
export function buildSelfGrowingBlueprint(opts = {}) {
  const created_at = new Date().toISOString();
  const id = opts.id || 'agent_' + crypto.randomBytes(6).toString('hex');
  const body = {
    schema_version: BLUEPRINT_SCHEMA_VERSION,
    id,
    name: opts.name || id,
    description: opts.description || 'A self-growing kolm agent.',
    created_at,
    starting_artifact: opts.starting_artifact || null,
    base_model: opts.base_model || 'Qwen/Qwen2.5-3B-Instruct',
    mentor_model: opts.mentor_model || 'NousResearch/Hermes-4.3-36B',
    capture: {
      enabled: opts.capture_enabled !== false,
      namespace: opts.capture_namespace || `${id}_capture`,
      include_responses: opts.include_responses !== false,
      redact_phi: opts.redact_phi !== false,
    },
    growth: {
      enabled: opts.growth_enabled !== false,
      thresholds: opts.growth_thresholds || [100, 500, 1000],
      auto_distill_at: opts.auto_distill_at || 1000,
      k_score_floor: opts.k_score_floor || 0.80,
      max_specialists: opts.max_specialists || 16,
      cool_off_hours: opts.cool_off_hours || 24,
    },
    tools: Array.isArray(opts.tools) ? opts.tools.slice() : [],
    constraints: {
      max_tool_calls_per_turn: opts.max_tool_calls_per_turn || 12,
      max_tokens_per_turn:     opts.max_tokens_per_turn || 4096,
      forbid_network:          opts.forbid_network !== false,
    },
    chat_template: opts.chat_template || 'chatml',
    runtime_target: opts.runtime_target || 'llama.cpp',
  };
  const canonical = JSON.stringify(body);
  const integrity_hash = crypto.createHash('sha256').update(canonical).digest('hex');
  return { ...body, integrity_hash };
}

// Validate a blueprint. Returns { ok, problems }. Conservative — only flags
// shapes the runtime would reject; tolerates extra fields for forward-compat.
export function validateBlueprint(bp) {
  const problems = [];
  if (!bp || typeof bp !== 'object') return { ok: false, problems: ['not_object'] };
  if (bp.schema_version !== BLUEPRINT_SCHEMA_VERSION) problems.push('bad_schema_version');
  if (!bp.id || typeof bp.id !== 'string')             problems.push('missing_id');
  if (!bp.base_model)                                  problems.push('missing_base_model');
  if (!bp.mentor_model)                                problems.push('missing_mentor_model');
  if (!bp.capture || typeof bp.capture !== 'object')   problems.push('missing_capture');
  if (!bp.growth || typeof bp.growth !== 'object')     problems.push('missing_growth');
  if (bp.growth) {
    if (typeof bp.growth.auto_distill_at !== 'number' || bp.growth.auto_distill_at <= 0) {
      problems.push('bad_auto_distill_at');
    }
    if (typeof bp.growth.k_score_floor !== 'number' || bp.growth.k_score_floor < 0 || bp.growth.k_score_floor > 1) {
      problems.push('bad_k_score_floor');
    }
  }
  if (bp.tools && !Array.isArray(bp.tools)) problems.push('bad_tools');
  if (typeof bp.integrity_hash !== 'string' || !/^[0-9a-f]{64}$/.test(bp.integrity_hash)) {
    problems.push('bad_integrity_hash');
  } else {
    // Recompute hash from the body sans integrity_hash and compare.
    const { integrity_hash, ...rest } = bp;
    const expected = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    if (expected !== integrity_hash) problems.push('hash_mismatch');
  }
  return { ok: problems.length === 0, problems };
}

// Merge two blueprints (extension / inheritance pattern). Right-side wins on
// scalar conflicts. Tools merge by id. Returns a freshly-signed blueprint.
export function mergeBlueprints(base, override) {
  const merged = { ...base, ...override };
  // Merge nested capture/growth/constraints by field.
  merged.capture     = { ...(base.capture     || {}), ...(override.capture     || {}) };
  merged.growth      = { ...(base.growth      || {}), ...(override.growth      || {}) };
  merged.constraints = { ...(base.constraints || {}), ...(override.constraints || {}) };
  // Tools: union by tool id.
  const seen = new Set();
  const tools = [];
  for (const t of [...(base.tools || []), ...(override.tools || [])]) {
    const k = t.id || t.name || JSON.stringify(t);
    if (seen.has(k)) continue;
    seen.add(k);
    tools.push(t);
  }
  merged.tools = tools;
  // Drop the inherited hash and resign.
  delete merged.integrity_hash;
  const canonical = JSON.stringify(merged);
  const integrity_hash = crypto.createHash('sha256').update(canonical).digest('hex');
  return { ...merged, integrity_hash };
}

// Serialize a blueprint to canonical YAML-lite (deterministic key order,
// 2-space indent). We don't depend on a YAML lib — the format is simple
// enough to handle inline and the user can pipe to `yq` if they want strict.
export function blueprintToYaml(bp) {
  const lines = [];
  const write = (key, val, indent) => {
    const pad = '  '.repeat(indent);
    if (val === null || val === undefined) { lines.push(`${pad}${key}: null`); return; }
    if (Array.isArray(val)) {
      if (val.length === 0) { lines.push(`${pad}${key}: []`); return; }
      lines.push(`${pad}${key}:`);
      for (const item of val) lines.push(`${pad}  - ${JSON.stringify(item)}`);
      return;
    }
    if (typeof val === 'object') {
      lines.push(`${pad}${key}:`);
      for (const k of Object.keys(val)) write(k, val[k], indent + 1);
      return;
    }
    lines.push(`${pad}${key}: ${JSON.stringify(val)}`);
  };
  for (const k of Object.keys(bp)) write(k, bp[k], 0);
  return lines.join('\n') + '\n';
}

export default {
  BLUEPRINT_SCHEMA_VERSION,
  HERMES_TOOL_SCHEMA_VERSION,
  exportHermesAgent,
  buildSelfGrowingBlueprint,
  validateBlueprint,
  mergeBlueprints,
  blueprintToYaml,
};
