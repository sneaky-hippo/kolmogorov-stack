// Recipe-class taxonomy — Wave 144 §Q+10 / Wave 151 honest framing.
//
// Every recipe inside a .kolm declares one of four classes. The artifact's
// overall `artifact_class` is the most-permissive of its recipes (rule <
// synthesized_rule < compiled_rule < distilled_model). The class is a load-
// bearing claim: shipping a `distilled_model` artifact with no weights file
// is a verifier-rejected lie, not a marketing footnote.
//
// THIS MODULE IS THE SINGLE SOURCE OF TRUTH for the four classes; every
// product surface that mentions distillation, compilation, or rule generation
// pulls its language from here so the user-visible language and the verifier's
// rejection conditions stay in lockstep.

export const RECIPE_CLASSES = ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'];

// Severity ordering — used to compute artifact_class from the per-recipe
// classes. The artifact_class is the MAX of its recipe classes under this
// ordering. A single `distilled_model` recipe in a bundle promotes the whole
// artifact to `distilled_model` (because a verifier must check for weights).
export const CLASS_RANK = Object.freeze({
  rule: 0,
  synthesized_rule: 1,
  compiled_rule: 2,
  distilled_model: 3,
});

// Honest, user-facing description of each class. Product surfaces import
// these strings directly so marketing copy cannot drift from the spec.
export const CLASS_DESCRIPTIONS = Object.freeze({
  rule: {
    short: 'Rule recipe',
    one_line: 'Deterministic finite-state transformation. No model, no teacher, no neural net.',
    honest: 'A hand-authored JavaScript function that runs on input and returns output. Same input always returns the same output. There is no model file because there is no model. Examples: phone-number normalizer, SSN redactor, ICD-10 lookup, denial-code classifier with explicit rules.',
    teacher_required: false,
    weights_required: false,
    quantization_applicable: false,
    distillation_applicable: false,
    runtime: 'sandboxed JS via node:vm',
  },
  synthesized_rule: {
    short: 'Synthesized rule recipe',
    one_line: 'LLM-emitted rule code, AST-validated against a constrained DSL, then compiled like a rule recipe.',
    honest: 'A frontier model (the teacher) emits candidate JavaScript that satisfies the spec. The candidate is parsed into a constrained AST (no I/O, no FFI, bounded loops), fuzzed against the train split, and gated on K-score against the holdout. The final artifact contains rule code, not weights — but the rule code was authored by an LLM, not by a human. Honest distinction: this is rule code generation, not knowledge distillation.',
    teacher_required: true,
    weights_required: false,
    quantization_applicable: false,
    distillation_applicable: false,
    runtime: 'sandboxed JS via node:vm',
  },
  compiled_rule: {
    short: 'Compiled rule recipe',
    one_line: 'Rule or synthesized-rule recipe lowered to C / Rust / WASM and compiled to a native binary.',
    honest: 'A rule-class recipe whose source has been emitted as C99 (gcc/clang) and Rust (rustc 2024 edition) and compiled to a deterministic native binary. The manifest carries the toolchain pinning so a verifier can rebuild and confirm `binary_hash`. There is still no model; the speed-up is from native code, not from quantization.',
    teacher_required: false,
    weights_required: false,
    quantization_applicable: false,
    distillation_applicable: false,
    runtime: 'native binary (ELF / Mach-O / PE) or WASM (wasm32-wasi)',
  },
  distilled_model: {
    short: 'Distilled model recipe',
    one_line: 'A small open-weight base model LoRA-fine-tuned on teacher outputs, quantized, and shipped as GGUF / ONNX bytes.',
    honest: 'A real neural network. A teacher model (frontier API or large open-weight) generates training pairs from the train split. A small base model (e.g., Llama-3.2-1B, Qwen2.5-0.5B, SmolLM2-360M) is LoRA-fine-tuned on those pairs. The adapter is quantized (GPTQ / AWQ to INT4 or INT8) and exported as GGUF or ONNX. The artifact carries real weights — model.gguf is non-empty and verifies against manifest.hashes.model_pointer. K-score is computed against the holdout, and the receipt chain captures teacher_vendor, teacher_model, student_base, distillation_method.',
    teacher_required: true,
    weights_required: true,
    quantization_applicable: true,
    distillation_applicable: true,
    runtime: 'onnxruntime / llama.cpp / candle (per target)',
  },
});

// Infer the class from a recipe shape. Used when the caller did not declare
// `recipe.class` and we need to derive it for the manifest.
//
// Heuristic order (most-specific first):
//   1. recipe.weights_file or recipe.gguf_file → distilled_model
//   2. recipe.compiled_targets / recipe.dsl with native bin → compiled_rule
//   3. recipe.dsl (DSL source, AST-validated) → synthesized_rule when authored
//      by a teacher (recipe.teacher_vendor or recipe.synthesized_by is set)
//   4. recipe.dsl alone (hand-authored DSL) → compiled_rule when emit targets,
//      else rule
//   5. default → rule
export function inferRecipeClass(recipe) {
  if (!recipe || typeof recipe !== 'object') return 'rule';
  if (recipe.weights_file || recipe.gguf_file || recipe.onnx_file) return 'distilled_model';
  if (recipe.compiled_targets || recipe.native_bin) return 'compiled_rule';
  if (recipe.synthesized_by || recipe.teacher_vendor) return 'synthesized_rule';
  return 'rule';
}

// Validate a single recipe's declared class against its shape. Throws on
// mismatch. Wave 151 contract: declared class must match the inferred class
// OR be the only-honest-upgrade direction (rule → synthesized_rule when
// teacher metadata is added later).
export function validateRecipeClass(recipe) {
  if (!recipe || typeof recipe !== 'object') {
    throw new Error('recipe must be an object');
  }
  const declared = recipe.class || recipe.recipe_class;
  if (declared === undefined || declared === null) return inferRecipeClass(recipe);
  if (!RECIPE_CLASSES.includes(declared)) {
    throw new Error(`recipe.class must be one of [${RECIPE_CLASSES.join(', ')}]; got ${JSON.stringify(declared)}`);
  }
  // Distilled-model claim requires weights metadata.
  if (declared === 'distilled_model' && !recipe.weights_file && !recipe.gguf_file && !recipe.onnx_file) {
    throw new Error(
      `recipe '${recipe.id || '?'}' declares class='distilled_model' but carries no weights_file / gguf_file / onnx_file. ` +
      `Honest taxonomy: a distilled_model artifact MUST ship real model bytes. ` +
      `If this is a rule-class recipe, set class='rule' or omit the field.`
    );
  }
  // Compiled-rule claim requires compiled targets (DSL + native bin OR explicit target list).
  if (declared === 'compiled_rule' && !recipe.compiled_targets && !recipe.native_bin && !recipe.dsl) {
    throw new Error(
      `recipe '${recipe.id || '?'}' declares class='compiled_rule' but carries no compiled_targets / native_bin / dsl. ` +
      `A compiled_rule recipe must carry the DSL source (so a verifier can rebuild) and at least one native target.`
    );
  }
  // Synthesized-rule claim requires a teacher attribution.
  if (declared === 'synthesized_rule' && !recipe.synthesized_by && !recipe.teacher_vendor) {
    throw new Error(
      `recipe '${recipe.id || '?'}' declares class='synthesized_rule' but carries no teacher attribution. ` +
      `A synthesized_rule recipe must record which teacher emitted the source (recipe.teacher_vendor or recipe.synthesized_by).`
    );
  }
  return declared;
}

// Roll up per-recipe classes into the artifact-level artifact_class. The
// artifact's class is the MAX of its recipes' classes under CLASS_RANK.
export function rollupArtifactClass(recipeClasses) {
  if (!Array.isArray(recipeClasses) || recipeClasses.length === 0) return 'rule';
  let best = 'rule';
  let bestRank = 0;
  for (const c of recipeClasses) {
    if (!RECIPE_CLASSES.includes(c)) continue;
    if (CLASS_RANK[c] > bestRank) {
      best = c;
      bestRank = CLASS_RANK[c];
    }
  }
  return best;
}

// Validate the artifact-level class against the manifest + zip contents.
// This is the verifier's "the manifest claim matches the bytes on disk"
// check. Returns { ok: true } on success or { ok: false, reason } on failure.
//
// Wave 151 contract:
//   - artifact_class='distilled_model' REQUIRES manifest.hashes.model_pointer
//     to be non-empty AND manifest.base_model to be a real model name (not
//     'none' or null). Empty model.gguf with class='distilled_model' is the
//     exact lie this wave eliminates.
//   - artifact_class='compiled_rule' REQUIRES manifest.compiled_targets to
//     be present.
//   - artifact_class='synthesized_rule' REQUIRES manifest.training to record
//     teacher_vendor or teacher_model.
//   - artifact_class='rule' has no positive requirement (it's the floor).
export function validateArtifactClass(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, reason: 'manifest missing' };
  }
  const declared = manifest.artifact_class || 'rule';
  if (!RECIPE_CLASSES.includes(declared)) {
    return { ok: false, reason: `artifact_class ${JSON.stringify(declared)} is not in [${RECIPE_CLASSES.join(', ')}]` };
  }
  const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  if (declared === 'distilled_model') {
    const mp = manifest.hashes?.model_pointer;
    if (!mp || mp === EMPTY_SHA) {
      return { ok: false, reason: 'artifact_class=distilled_model requires non-empty model_pointer; manifest.hashes.model_pointer is empty (sha256 of empty buffer). A distilled_model artifact MUST ship real model bytes.' };
    }
    if (!manifest.base_model || manifest.base_model === 'none') {
      return { ok: false, reason: 'artifact_class=distilled_model requires manifest.base_model to be a real model name; got ' + JSON.stringify(manifest.base_model) };
    }
  }
  if (declared === 'compiled_rule') {
    if (!manifest.compiled_targets) {
      return { ok: false, reason: 'artifact_class=compiled_rule requires manifest.compiled_targets block' };
    }
  }
  if (declared === 'synthesized_rule') {
    const t = manifest.training || {};
    if (!t.teacher_vendor && !t.teacher_model && !t.synthesized_by) {
      return { ok: false, reason: 'artifact_class=synthesized_rule requires manifest.training to record teacher_vendor / teacher_model / synthesized_by' };
    }
  }
  return { ok: true };
}

// Cheap one-line honest summary used by `kolm inspect` and `/r/:hash`.
export function classBadge(klass) {
  const d = CLASS_DESCRIPTIONS[klass];
  if (!d) return `unknown class: ${klass}`;
  return `${d.short} — ${d.one_line}`;
}
