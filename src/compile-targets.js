// Canonical compile-target catalog (W266).
//
// The runner side of the dispatch chain (artifact-runner.js, W287-W290)
// knows five runtime_target values: js, wasm, native, gguf, onnx. The
// compile side needed a parallel catalog: which target slug a user picks
// at `kolm compile --target=...` time, what runtime_target it produces,
// and what manifest fields the binder must populate for the runner to
// later succeed.
//
// COMPILE_TARGETS is the user-facing slug set. COMPILE_TARGET_INFO is the
// per-target descriptor consumed by the CLI, the /compile page, the
// pricing tier matrix, and the manifest validator. Adding a target is a
// one-place edit; the CLI, UI, and runner all read from here.
//
// Honest scope:
//   - This module is the CATALOG. It does not perform the compile
//     itself (that's src/compile.js + src/compile-ir.js + workers/quantize)
//     nor the runtime dispatch (that's src/artifact-runner.js
//     dispatchRuntime). It is the single source of truth for "what
//     target slugs are legal and what does each one require".
//   - It does NOT enforce hardware availability at validate time. The
//     binder runs the hw-availability probe separately via
//     runtimeAvailable() in artifact-runner.js.

export const COMPILE_TARGETS = Object.freeze([
  // Rule family (function in a sandbox, no model weights).
  'js',
  'wasm',
  // Adapter family (weights on top of a base model).
  'lora',
  // Compiled family (native binary or quantized weights).
  'native',
  'int4',
  // Model family (full-weight artifact with its own runtime).
  'gguf',
  'onnx',
]);

export const COMPILE_TARGET_INFO = Object.freeze({
  js: Object.freeze({
    id: 'js',
    family: 'rule',
    runtime_target: 'js',
    required_artifact_fields: [],
    description: 'JavaScript function compiled in a sandboxed verifier. Default; runs anywhere Node runs.',
    typical_use_case: 'Pure rules, parsers, validators. No model weights.',
  }),
  wasm: Object.freeze({
    id: 'wasm',
    family: 'rule',
    runtime_target: 'wasm',
    required_artifact_fields: [],
    description: 'WebAssembly module executed by node:wasi. Lets a kolm artifact bundle a non-JS rule.',
    typical_use_case: 'Compiled-from-Rust / Zig / C rules that need predictable performance.',
  }),
  lora: Object.freeze({
    id: 'lora',
    family: 'adapter',
    runtime_target: 'gguf',
    required_artifact_fields: ['lora_adapter'],
    description: 'LoRA adapter on top of a named base model. Distillation output for parameter-efficient fine-tuning.',
    typical_use_case: 'Specialized behavior on a shared base model; one base + many adapters.',
  }),
  native: Object.freeze({
    id: 'native',
    family: 'compiled',
    runtime_target: 'native',
    required_artifact_fields: ['entrypoint'],
    description: 'Native binary entrypoint produced by the compiled_rule path. Bundles one binary per target arch.',
    typical_use_case: 'Latency-critical rules compiled to a per-arch executable.',
  }),
  int4: Object.freeze({
    id: 'int4',
    family: 'compiled',
    runtime_target: 'gguf',
    required_artifact_fields: ['quantization'],
    description: 'INT4 quantized weights for memory-constrained edge runtime.',
    typical_use_case: '7B / 13B models on consumer GPUs (3090, 5090) or laptops with unified memory.',
  }),
  gguf: Object.freeze({
    id: 'gguf',
    family: 'model',
    runtime_target: 'gguf',
    required_artifact_fields: ['runtime_target_config.gguf_path'],
    description: 'GGUF model file executed by the llama.cpp adapter. Default for distilled_model artifacts.',
    typical_use_case: 'Self-hosted distilled student models. Runs on CPU, CUDA, ROCm, Metal, Vulkan.',
  }),
  onnx: Object.freeze({
    id: 'onnx',
    family: 'model',
    runtime_target: 'onnx',
    required_artifact_fields: ['runtime_target_config.onnx_path'],
    description: 'ONNX model file executed via onnxruntime-node. Cross-runtime portable.',
    typical_use_case: 'Models exported from PyTorch / TF for portable cross-platform inference.',
  }),
});

// Resolve a dotted path against an object. Returns undefined on miss.
function _get(obj, dotted) {
  if (!obj || !dotted) return undefined;
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// Validate that `target` is a known compile target AND that the given
// manifest carries all fields the target requires. Throws on the first
// failure so the binder can report a single root cause.
//
// Returns `true` on success. Callers can ignore the return value; the
// throw-on-fail signal is the load-bearing path.
export function validateCompileTarget(target, manifest) {
  if (!target || typeof target !== 'string') {
    throw new Error('validateCompileTarget: target required (one of: ' + COMPILE_TARGETS.join(', ') + ')');
  }
  if (!COMPILE_TARGETS.includes(target)) {
    throw new Error(`unknown compile target ${JSON.stringify(target)} (must be one of: ${COMPILE_TARGETS.join(', ')})`);
  }
  const info = COMPILE_TARGET_INFO[target];
  if (!info) {
    throw new Error(`compile target ${target} missing descriptor — registry inconsistency`);
  }
  const m = manifest || {};
  for (const field of info.required_artifact_fields) {
    const v = _get(m, field);
    if (v === undefined || v === null || v === '') {
      throw new Error(`compile target ${target} requires manifest field ${field} (missing or empty)`);
    }
  }
  return true;
}

// Look at a manifest and guess which compile target it represents. The
// order matters: explicit runtime_target is the strongest signal, then
// quantization hints, then lora hints, then default to js.
export function inferCompileTarget(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'js';
  if (manifest.runtime_target && COMPILE_TARGETS.includes(manifest.runtime_target)) {
    // Special-case: a manifest with runtime_target=gguf could be either
    // gguf (raw model) or int4 (quantized) or lora (adapter on a base).
    // The explicit hints take precedence.
    if (manifest.quantization && manifest.quantization.method === 'int4') return 'int4';
    if (manifest.lora_adapter) return 'lora';
    return manifest.runtime_target;
  }
  if (manifest.quantization && manifest.quantization.method === 'int4') return 'int4';
  if (manifest.lora_adapter) return 'lora';
  return 'js';
}

// UI-facing descriptor. Returns null for unknown targets so callers can
// skip rendering rather than throw.
export function describeCompileTarget(target) {
  if (!target || !COMPILE_TARGET_INFO[target]) return null;
  return COMPILE_TARGET_INFO[target];
}

export default {
  COMPILE_TARGETS,
  COMPILE_TARGET_INFO,
  validateCompileTarget,
  inferCompileTarget,
  describeCompileTarget,
};
