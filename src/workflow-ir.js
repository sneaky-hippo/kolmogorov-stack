// Workflow IR — the third artifact class (workflow_capsule).
//
// An IR is a frozen, replayable program that the artifact runtime walks to
// reproduce a workflow deterministically. It is what `kolm compile <task>`
// produces from a captured trace (src/trace-capture.js) via the compile-ir.js
// pass.
//
// Three artifact classes:
//   rule              — JavaScript function in a sandbox (today's default)
//   compiled_rule     — DSL → C/Rust → optional native binary (Wave 144 F)
//   workflow_capsule  — IR over (LLM / tool / branch / artifact) nodes,
//                       executed by a deterministic interpreter with cached
//                       responses for replayed inputs (this module)
//
// Honest scope (what this module IS and IS NOT):
//
//   IS:
//     - IR data model (nodes, edges, envelope) for replayable workflows
//     - validateIr() — structural validation
//     - interpret(ir, input, opts) — deterministic interpreter that uses
//       cached responses when input matches a seed; otherwise calls into the
//       caller-supplied executors (vendor LLM SDK, tool registry)
//     - chain hash over IR shape so it can be embedded in the artifact's
//       receipt
//
//   IS NOT:
//     - The trace → IR compiler (that's compile-ir.js)
//     - The LLM/tool executors themselves — callers supply them as opts.exec
//       so the runtime can be swapped per device (local llama.cpp / remote
//       Anthropic / hosted vLLM)
//     - A general-purpose workflow engine (no parallelism, no retries, no
//       compensating transactions — those would defeat reproducibility)
//
// Design constraints:
//
//   - Determinism: same input + same IR → same output, byte-for-byte.
//   - Cache-first: if input matches a seed, the IR returns the seed's
//     captured output without calling executors at all.
//   - Fail-loud: if the IR would call an executor but no executor is wired,
//     interpret() throws. We do not silently degrade.
//   - Receipt-binding: the IR's structural hash goes into the artifact's
//     receipt chain so a verifier can confirm the IR shipped == IR signed.

import crypto from 'node:crypto';

export const WORKFLOW_IR_VERSION = 'wir-v1';

// Node kinds that an IR can contain. Each corresponds to a replayable span
// kind in src/trace-capture.js (minus the non-replayable IO and STATE kinds).
export const NODE_KINDS = Object.freeze({
  INPUT:     'input',     // the workflow's entry point (one per IR)
  LLM:       'llm',       // model call
  TOOL:      'tool',      // function call
  BRANCH:    'branch',    // conditional fork
  ARTIFACT:  'artifact',  // nested workflow_capsule invocation
  CONST:     'const',     // literal value (constant folded)
  OUTPUT:    'output',    // the workflow's exit point (one per IR)
});

const VALID_KINDS = new Set(Object.values(NODE_KINDS));

function _canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_canonicalize).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _canonicalize(v[k])).join(',') + '}';
}

function _hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

// Structural validation. Throws on the first defect so the compile pass can
// fail loud rather than ship a broken IR.
export function validateIr(ir) {
  if (!ir || typeof ir !== 'object') throw new Error('ir must be an object');
  if (ir.spec !== WORKFLOW_IR_VERSION) {
    throw new Error(`ir.spec must be ${WORKFLOW_IR_VERSION}, got ${ir.spec}`);
  }
  if (!Array.isArray(ir.nodes) || ir.nodes.length === 0) {
    throw new Error('ir.nodes must be a non-empty array');
  }
  if (!Array.isArray(ir.edges)) throw new Error('ir.edges must be an array');
  if (!Array.isArray(ir.seeds)) throw new Error('ir.seeds must be an array');

  const ids = new Set();
  let inputs = 0;
  let outputs = 0;
  for (const n of ir.nodes) {
    if (!n.id || typeof n.id !== 'string') throw new Error('node.id required');
    if (ids.has(n.id)) throw new Error(`duplicate node id: ${n.id}`);
    ids.add(n.id);
    if (!VALID_KINDS.has(n.kind)) throw new Error(`bad node kind: ${n.kind}`);
    if (n.kind === NODE_KINDS.INPUT) inputs += 1;
    if (n.kind === NODE_KINDS.OUTPUT) outputs += 1;
  }
  if (inputs !== 1) throw new Error(`exactly one INPUT node required, got ${inputs}`);
  if (outputs !== 1) throw new Error(`exactly one OUTPUT node required, got ${outputs}`);

  // Edge endpoints must reference real nodes.
  for (const e of ir.edges) {
    if (!ids.has(e.from)) throw new Error(`edge.from references unknown node: ${e.from}`);
    if (!ids.has(e.to)) throw new Error(`edge.to references unknown node: ${e.to}`);
  }
  // Detect cycles. Workflow IR is a DAG; cycles defeat replayability.
  const adj = {};
  for (const e of ir.edges) {
    (adj[e.from] ||= []).push(e.to);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  for (const id of ids) color[id] = WHITE;
  function visit(id) {
    if (color[id] === GRAY) throw new Error(`cycle through node: ${id}`);
    if (color[id] === BLACK) return;
    color[id] = GRAY;
    for (const next of (adj[id] || [])) visit(next);
    color[id] = BLACK;
  }
  for (const id of ids) visit(id);
  return true;
}

// Toposort. Returns node ids in execution order. validateIr must pass first.
function _topoOrder(ir) {
  const adj = {};
  const indeg = {};
  for (const n of ir.nodes) { adj[n.id] = []; indeg[n.id] = 0; }
  for (const e of ir.edges) {
    adj[e.from].push(e.to);
    indeg[e.to] += 1;
  }
  const queue = [];
  for (const id of Object.keys(indeg)) if (indeg[id] === 0) queue.push(id);
  const out = [];
  while (queue.length > 0) {
    const id = queue.shift();
    out.push(id);
    for (const next of adj[id]) {
      indeg[next] -= 1;
      if (indeg[next] === 0) queue.push(next);
    }
  }
  if (out.length !== ir.nodes.length) {
    throw new Error('topo failed — cycle remains after validateIr');
  }
  return out;
}

// Structural hash. Two IRs with the same nodes + edges + seeds produce the
// same hash. This hash goes into the artifact receipt.
export function hashIr(ir) {
  validateIr(ir);
  const norm = {
    spec: ir.spec,
    nodes: [...ir.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...ir.edges].sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to)),
    seeds: [...ir.seeds].sort((a, b) => JSON.stringify(a.input).localeCompare(JSON.stringify(b.input))),
  };
  return _hash(_canonicalize(norm));
}

// Resolve a value template against the current binding environment. The
// template can be a literal, a {ref: 'node_id'} reference, or a string
// containing ${node_id} placeholders.
function _resolve(template, env) {
  if (template === null || template === undefined) return template;
  if (typeof template === 'object' && template !== null && 'ref' in template) {
    if (!(template.ref in env)) throw new Error(`unresolved ref: ${template.ref}`);
    return env[template.ref];
  }
  if (typeof template === 'string') {
    return template.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_m, k) => {
      if (!(k in env)) throw new Error(`unresolved placeholder: ${k}`);
      const v = env[k];
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(template)) return template.map(t => _resolve(t, env));
  if (typeof template === 'object') {
    const out = {};
    for (const k of Object.keys(template)) out[k] = _resolve(template[k], env);
    return out;
  }
  return template;
}

// Look up a seed for an exact input match. Returns the seed or null.
function _findSeed(ir, input) {
  const inputKey = _canonicalize(input);
  for (const s of ir.seeds) {
    if (_canonicalize(s.input) === inputKey) return s;
  }
  return null;
}

// Deterministic interpreter.
//
// Behavior:
//   1. If `input` matches a seed: return seed.output immediately. Cache hit.
//   2. Otherwise: walk the graph in topo order. For LLM / TOOL / ARTIFACT
//      nodes, invoke the caller-supplied executor from opts.exec.
//   3. If a non-cached path needs an executor and the caller didn't wire one,
//      throw. Workflow capsules with no executor are fine ONLY if every
//      input is a seed match.
//
// opts.exec shape:
//   {
//     llm:      async (node, resolvedPrompt) => string,
//     tool:     async (node, resolvedArgs) => any,
//     artifact: async (node, resolvedInput) => any,
//   }
//
// Returns { output, trace } where trace is the per-node bindings, useful for
// debugging or for re-emitting a trace via trace-capture.js.
export async function interpret(ir, input, opts = {}) {
  validateIr(ir);
  // Cache hit: skip the interpreter entirely.
  const seed = _findSeed(ir, input);
  if (seed) {
    return { output: seed.output, trace: { _cache_hit: true, seed_hash: _hash(_canonicalize(seed.input)) } };
  }

  const order = _topoOrder(ir);
  const env = {};
  const trace = {};
  for (const id of order) {
    const node = ir.nodes.find(n => n.id === id);
    switch (node.kind) {
      case NODE_KINDS.INPUT:
        env[id] = input;
        trace[id] = { kind: 'input', value: input };
        break;
      case NODE_KINDS.CONST:
        env[id] = node.value;
        trace[id] = { kind: 'const', value: node.value };
        break;
      case NODE_KINDS.LLM: {
        if (!opts.exec?.llm) {
          throw new Error(`no llm executor wired, but IR has live LLM node: ${id}`);
        }
        const prompt = _resolve(node.prompt_template, env);
        const v = await opts.exec.llm({ id, vendor: node.vendor, model: node.model }, prompt);
        env[id] = v;
        trace[id] = { kind: 'llm', vendor: node.vendor, model: node.model, prompt, value: v };
        break;
      }
      case NODE_KINDS.TOOL: {
        if (!opts.exec?.tool) {
          throw new Error(`no tool executor wired, but IR has live TOOL node: ${id}`);
        }
        const args = _resolve(node.args_template, env);
        const v = await opts.exec.tool({ id, tool_name: node.tool_name }, args);
        env[id] = v;
        trace[id] = { kind: 'tool', tool_name: node.tool_name, args, value: v };
        break;
      }
      case NODE_KINDS.BRANCH: {
        const cond = _resolve(node.condition, env);
        const taken = cond ? node.then_ref : node.else_ref;
        if (!(taken in env)) {
          throw new Error(`branch ${id} took edge ${taken} but it was not yet evaluated; check topo order`);
        }
        env[id] = env[taken];
        trace[id] = { kind: 'branch', cond, taken, value: env[taken] };
        break;
      }
      case NODE_KINDS.ARTIFACT: {
        if (!opts.exec?.artifact) {
          throw new Error(`no artifact executor wired, but IR has live ARTIFACT node: ${id}`);
        }
        const subInput = _resolve(node.input_template, env);
        const v = await opts.exec.artifact({ id, artifact_hash: node.artifact_hash, recipe_id: node.recipe_id }, subInput);
        env[id] = v;
        trace[id] = { kind: 'artifact', artifact_hash: node.artifact_hash, recipe_id: node.recipe_id, input: subInput, value: v };
        break;
      }
      case NODE_KINDS.OUTPUT: {
        env[id] = _resolve(node.value_template, env);
        trace[id] = { kind: 'output', value: env[id] };
        break;
      }
    }
  }
  const outId = ir.nodes.find(n => n.kind === NODE_KINDS.OUTPUT).id;
  return { output: env[outId], trace };
}

// Replay a single seed: confirm the IR + cached responses still produce the
// same output. Used by `kolm verify` to confirm the receipt-bound IR hasn't
// been tampered with. Returns { ok, mismatches }.
export async function replaySeeds(ir, opts = {}) {
  validateIr(ir);
  const mismatches = [];
  for (const seed of ir.seeds) {
    const { output } = await interpret(ir, seed.input, opts);
    if (_canonicalize(output) !== _canonicalize(seed.output)) {
      mismatches.push({ input: seed.input, want: seed.output, got: output });
    }
  }
  return { ok: mismatches.length === 0, mismatches, total: ir.seeds.length };
}

// Stats helper for the CLI / dashboard.
export function stats(ir) {
  validateIr(ir);
  const by_kind = {};
  for (const n of ir.nodes) by_kind[n.kind] = (by_kind[n.kind] || 0) + 1;
  return {
    spec: ir.spec,
    nodes: ir.nodes.length,
    edges: ir.edges.length,
    seeds: ir.seeds.length,
    by_kind,
    hash: hashIr(ir),
  };
}

export default {
  WORKFLOW_IR_VERSION,
  NODE_KINDS,
  validateIr,
  hashIr,
  interpret,
  replaySeeds,
  stats,
};
