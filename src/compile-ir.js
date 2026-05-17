// Trace → IR compile pass.
//
// Reads a structured trace from src/trace-capture.js and emits a workflow IR
// (src/workflow-ir.js) that can be embedded inside a workflow_capsule .kolm
// artifact. The IR is the deterministic, replayable skeleton; the seeds list
// inside it is the captured (input → output) pairs that let the runtime
// short-circuit known traffic without calling the executors at all.
//
// Honest scope:
//
//   IS:
//     - traceToIr(trace_id, opts) — read the trace via trace-capture.readTrace,
//       filter to replayable spans (LLM, TOOL, BRANCH, ARTIFACT, USER_INPUT),
//       emit nodes + edges + seeds, return the IR
//     - tracesToIr(trace_ids, opts) — multi-trace fold: merges multiple runs
//       of the same workflow into one IR by accumulating seeds for repeated
//       input shapes; nodes/edges must match across traces or compile fails
//     - per-trace fingerprinting so duplicate-shape traces collapse
//
//   IS NOT:
//     - A static-analysis tool that infers branches not actually taken in any
//       trace. The IR's coverage is exactly the coverage of the input traces.
//       This is intentional: kolm artifacts ship with explicit coverage, not
//       guessed coverage.
//     - A runtime. compile-ir.js produces the IR; workflow-ir.js executes it.
//     - A redactor. If the trace carries PHI, call traceCapture.redactForExport
//       BEFORE handing it to this pass.

import * as traceCapture from './trace-capture.js';
import { WORKFLOW_IR_VERSION, NODE_KINDS, hashIr, validateIr } from './workflow-ir.js';

// Span kinds from trace-capture that become IR nodes. IO and STATE spans are
// skipped: they are runtime side-effects, not replayable program steps.
const REPLAYABLE = new Set([
  traceCapture.SPAN_KINDS.USER_INPUT,
  traceCapture.SPAN_KINDS.LLM_CALL,
  traceCapture.SPAN_KINDS.TOOL_CALL,
  traceCapture.SPAN_KINDS.BRANCH,
  traceCapture.SPAN_KINDS.ARTIFACT,
]);

function _spanToNode(span, spanIdToNodeId) {
  const id = spanIdToNodeId.get(span.span_id);
  switch (span.kind) {
    case traceCapture.SPAN_KINDS.USER_INPUT:
      // The first user_input becomes the INPUT node; later ones become
      // CONST nodes carrying the captured text (rare but legal).
      return { id, kind: NODE_KINDS.INPUT, source_span_id: span.span_id };
    case traceCapture.SPAN_KINDS.LLM_CALL:
      return {
        id,
        kind: NODE_KINDS.LLM,
        vendor: span.payload.vendor,
        model: span.payload.model,
        // Prompt is captured verbatim; the compile pass does not template-ify.
        // Future pass: parameter extraction — replace literal substrings with
        // ${input} placeholders when they match the user input.
        prompt_template: span.payload.prompt,
        // Captured response — used as the seed-cache fallback for this node.
        captured_response: span.payload.response,
        tokens_in: span.payload.tokens_in,
        tokens_out: span.payload.tokens_out,
        source_span_id: span.span_id,
      };
    case traceCapture.SPAN_KINDS.TOOL_CALL:
      return {
        id,
        kind: NODE_KINDS.TOOL,
        tool_name: span.payload.tool_name,
        args_template: span.payload.args,
        captured_result: span.payload.result,
        source_span_id: span.span_id,
      };
    case traceCapture.SPAN_KINDS.BRANCH:
      return {
        id,
        kind: NODE_KINDS.BRANCH,
        condition: span.payload.value,
        // then_ref / else_ref filled in by the second pass after node ids
        // are minted, since we need to know which sibling-of-parent the
        // taken edge actually corresponded to.
        captured_taken: span.payload.taken_edge,
        source_span_id: span.span_id,
      };
    case traceCapture.SPAN_KINDS.ARTIFACT:
      return {
        id,
        kind: NODE_KINDS.ARTIFACT,
        artifact_hash: span.payload.artifact_hash,
        recipe_id: span.payload.recipe_id,
        input_template: span.payload.input,
        captured_output: span.payload.output,
        source_span_id: span.span_id,
      };
    default:
      throw new Error(`non-replayable span kind reached _spanToNode: ${span.kind}`);
  }
}

// Compile one trace into an IR. Returns {ir, dropped: [...]} where dropped
// lists the span ids skipped (IO/STATE) so the compile pass is auditable.
export async function traceToIr(trace_id, opts = {}) {
  const spans = await traceCapture.readTrace(trace_id);
  if (spans.length === 0) throw new Error(`empty trace: ${trace_id}`);
  return spansToIr(spans, { ...opts, source_trace_id: trace_id });
}

// Compile a span list directly. Caller may pass an already-redacted span list.
// Exposed separately so the redactForExport pass can be inserted between
// readTrace and this function.
export function spansToIr(spans, opts = {}) {
  if (!Array.isArray(spans) || spans.length === 0) {
    throw new Error('spans must be a non-empty array');
  }

  // Filter to replayable spans. Record the dropped ones for audit.
  const replayable = [];
  const dropped = [];
  for (const s of spans) {
    if (REPLAYABLE.has(s.kind)) replayable.push(s);
    else dropped.push({ span_id: s.span_id, kind: s.kind, reason: 'non_replayable_kind' });
  }
  if (replayable.length === 0) {
    throw new Error('no replayable spans in trace; cannot compile to IR');
  }

  // Find the root (first user_input or earliest seq). It becomes the INPUT
  // node. The artifact's user-facing input is the payload of this span.
  const userInputs = replayable.filter(s => s.kind === traceCapture.SPAN_KINDS.USER_INPUT);
  const rootSpan = userInputs.length > 0 ? userInputs[0] : replayable[0];

  // Mint a node id per span. Use the span_id directly — short, unique, and
  // already in the trace's span_id space.
  const spanIdToNodeId = new Map();
  for (const s of replayable) spanIdToNodeId.set(s.span_id, 'n_' + s.span_id);

  // Build IR nodes. Skip non-root user_inputs (rare; treat as CONST).
  const nodes = [];
  for (const s of replayable) {
    if (s.kind === traceCapture.SPAN_KINDS.USER_INPUT && s.span_id !== rootSpan.span_id) {
      nodes.push({
        id: 'n_' + s.span_id,
        kind: NODE_KINDS.CONST,
        value: s.payload.text || s.payload,
        source_span_id: s.span_id,
      });
    } else {
      nodes.push(_spanToNode(s, spanIdToNodeId));
    }
  }

  // Build edges from parent_span_id relationships. The IR's edges encode
  // data dependency: a child's parent is upstream in topo order.
  const edges = [];
  const present = new Set(spanIdToNodeId.keys());
  for (const s of replayable) {
    if (s.parent_span_id && present.has(s.parent_span_id)) {
      edges.push({
        from: 'n_' + s.parent_span_id,
        to: 'n_' + s.span_id,
      });
    }
  }

  // Output node: a synthetic node whose value_template references the LAST
  // span's output. This is a reasonable default; the compile pass can be
  // re-run with an explicit output_span_id to point elsewhere.
  const lastSpan = opts.output_span_id
    ? replayable.find(s => s.span_id === opts.output_span_id)
    : replayable[replayable.length - 1];
  if (!lastSpan) throw new Error(`output_span_id not found in trace`);
  const outputNodeId = 'n_output';
  nodes.push({
    id: outputNodeId,
    kind: NODE_KINDS.OUTPUT,
    value_template: { ref: 'n_' + lastSpan.span_id },
  });
  edges.push({ from: 'n_' + lastSpan.span_id, to: outputNodeId });

  // The seed: this trace itself becomes a seed pair. interpret() with the
  // same input gets a cache hit and never touches an executor.
  const rootInput = rootSpan.kind === traceCapture.SPAN_KINDS.USER_INPUT
    ? (rootSpan.payload.text != null ? rootSpan.payload.text : rootSpan.payload)
    : rootSpan.payload;

  // Compute the captured output by walking the trace one last time.
  // Use whatever the OUTPUT node's value_template ref points to.
  const seedOutput = _capturedValue(lastSpan);

  const ir = {
    spec: WORKFLOW_IR_VERSION,
    source_trace_id: opts.source_trace_id || null,
    nodes,
    edges,
    seeds: [{ input: rootInput, output: seedOutput, source_trace_id: opts.source_trace_id || null }],
  };
  validateIr(ir);
  ir.hash = hashIr(ir);
  return { ir, dropped };
}

// Pull the "captured output" value out of any replayable span kind.
function _capturedValue(span) {
  switch (span.kind) {
    case traceCapture.SPAN_KINDS.LLM_CALL:    return span.payload.response;
    case traceCapture.SPAN_KINDS.TOOL_CALL:   return span.payload.result;
    case traceCapture.SPAN_KINDS.BRANCH:      return span.payload.value;
    case traceCapture.SPAN_KINDS.ARTIFACT:    return span.payload.output;
    case traceCapture.SPAN_KINDS.USER_INPUT:  return span.payload.text != null ? span.payload.text : span.payload;
    default: return null;
  }
}

// Canonicalize an IR by renaming nodes to position-stable ids. The renamer
// walks the IR in topological order and assigns each node an id of the form
// `c<i>` where `i` is the topo-order position. This makes two structurally
// identical IRs (different trace span ids, same workflow shape) compare equal
// at the fingerprint level and merge cleanly.
function _canonicalizeIr(ir) {
  // Recreate a topo order using only nodes + edges in this IR.
  const adj = {};
  const indeg = {};
  for (const n of ir.nodes) { adj[n.id] = []; indeg[n.id] = 0; }
  for (const e of ir.edges) { adj[e.from].push(e.to); indeg[e.to] += 1; }
  const queue = Object.keys(indeg).filter(id => indeg[id] === 0).sort();
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj[id]) {
      indeg[next] -= 1;
      if (indeg[next] === 0) { queue.push(next); queue.sort(); }
    }
  }
  const rename = new Map();
  order.forEach((oldId, i) => rename.set(oldId, 'c' + i));
  const renameRef = (v) => {
    if (v && typeof v === 'object' && 'ref' in v && rename.has(v.ref)) {
      return { ...v, ref: rename.get(v.ref) };
    }
    if (Array.isArray(v)) return v.map(renameRef);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = renameRef(v[k]);
      return out;
    }
    return v;
  };
  const nodes = order.map(oldId => {
    const n = ir.nodes.find(x => x.id === oldId);
    const renamed = { ...n, id: rename.get(oldId) };
    // Rewrite known ref fields.
    if (renamed.value_template) renamed.value_template = renameRef(renamed.value_template);
    if (renamed.prompt_template) renamed.prompt_template = renameRef(renamed.prompt_template);
    if (renamed.args_template) renamed.args_template = renameRef(renamed.args_template);
    if (renamed.input_template) renamed.input_template = renameRef(renamed.input_template);
    if (renamed.then_ref && rename.has(renamed.then_ref)) renamed.then_ref = rename.get(renamed.then_ref);
    if (renamed.else_ref && rename.has(renamed.else_ref)) renamed.else_ref = rename.get(renamed.else_ref);
    return renamed;
  });
  const edges = ir.edges.map(e => ({ from: rename.get(e.from), to: rename.get(e.to) }));
  return { ...ir, nodes, edges };
}

// Multi-trace fold. Merges N traces of the same workflow into one IR. Each
// trace is first canonicalized (span ids → position-stable ids), then the
// shapes are compared. If shapes match, seeds are merged; otherwise we fail
// loud so the operator can decide to split into separate capsules or expand
// the IR coverage.
export async function tracesToIr(trace_ids, opts = {}) {
  if (!Array.isArray(trace_ids) || trace_ids.length === 0) {
    throw new Error('trace_ids must be a non-empty array');
  }
  const compiled = [];
  for (const tid of trace_ids) {
    const { ir, dropped } = await traceToIr(tid, opts);
    compiled.push({ ir: _canonicalizeIr(ir), dropped });
  }
  const canonical = compiled[0].ir;
  const canonicalShape = _shapeFingerprint(canonical);
  for (let i = 1; i < compiled.length; i++) {
    const shape = _shapeFingerprint(compiled[i].ir);
    if (shape !== canonicalShape) {
      throw new Error(`trace ${trace_ids[i]} has divergent shape from ${trace_ids[0]} — split into separate capsules or expand the IR coverage`);
    }
  }
  // Merge seeds. Drop duplicates by input key. Cross-trace duplicate inputs
  // with diverging outputs are a real bug worth surfacing — but we accept
  // the first seen and surface conflicts via the `conflicts` array so the
  // caller can decide whether to ship or split.
  const seen = new Map();
  const conflicts = [];
  for (const c of compiled) {
    for (const s of c.ir.seeds) {
      const key = JSON.stringify(s.input);
      if (seen.has(key)) {
        const prior = seen.get(key);
        if (JSON.stringify(prior.output) !== JSON.stringify(s.output)) {
          conflicts.push({ input: s.input, outputs: [prior.output, s.output] });
        }
        continue;
      }
      seen.set(key, s);
    }
  }
  const merged = { ...canonical, seeds: Array.from(seen.values()) };
  validateIr(merged);
  merged.hash = hashIr(merged);
  const droppedAll = compiled.flatMap(c => c.dropped);
  return { ir: merged, dropped: droppedAll, merged_from: trace_ids, conflicts };
}

// Shape fingerprint of a CANONICALIZED IR. Two canonicalized IRs with the
// same topology produce the same fingerprint regardless of which underlying
// traces produced them.
function _shapeFingerprint(ir) {
  const kinds = ir.nodes.map(n => `${n.id}:${n.kind}`).sort().join('|');
  const edges = ir.edges.map(e => `${e.from}->${e.to}`).sort().join('|');
  return kinds + '##' + edges;
}

export default {
  REPLAYABLE,
  traceToIr,
  spansToIr,
  tracesToIr,
};
