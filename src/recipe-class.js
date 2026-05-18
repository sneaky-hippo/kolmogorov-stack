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

import fs from 'node:fs';

export const RECIPE_CLASSES = ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model', 'workflow_capsule'];

// Severity ordering — used to compute artifact_class from the per-recipe
// classes. The artifact_class is the MAX of its recipe classes under this
// ordering. A single `distilled_model` recipe in a bundle promotes the whole
// artifact to `distilled_model`. A single `workflow_capsule` recipe (a graph
// of recipes) promotes the whole artifact to `workflow_capsule` — verifier
// MUST also check the workflow_ir hash matches manifest.lineage.workflow_ir_hash.
export const CLASS_RANK = Object.freeze({
  rule: 0,
  synthesized_rule: 1,
  compiled_rule: 2,
  distilled_model: 3,
  workflow_capsule: 4,
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
  workflow_capsule: {
    short: 'Workflow capsule',
    one_line: 'A graph of recipes (LLM / tool / branch / artifact nodes) compiled to a frozen, replayable workflow IR.',
    honest: 'An artifact whose execution is described by a workflow IR (src/workflow-ir.js, spec wir-v1). The IR is a DAG of input / llm / tool / branch / artifact / const / output nodes. The artifact carries the IR alongside a seed cache of (input → output) pairs captured at compile time; the runtime is cache-first (replays cached outputs byte-for-byte when input matches a seed) and fail-loud (throws if it would need to call an executor but no executor is wired). The artifact-level workflow_ir_hash MUST match the IR shape carried in the zip; verifiers reject any mismatch. Source: traced from a real production session (kolm capture → kolm compile --ir) or hand-authored.',
    teacher_required: false,
    weights_required: false,
    quantization_applicable: false,
    distillation_applicable: false,
    runtime: 'workflow-IR interpreter + caller-supplied node executors',
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
  // W252b Bug 5 — detect ambiguous shapes early. A recipe that names BOTH a
  // teacher (teacher_vendor or synthesized_by) AND weights (weights_file,
  // gguf_file, or onnx_file) cannot be honestly classified: synthesized_rule
  // (teacher emits source code) and distilled_model (teacher emits training
  // pairs that fine-tune real weights) are different classes with different
  // verifier guarantees. The caller MUST disambiguate by removing the field
  // that doesn't belong, or by setting recipe.class explicitly.
  const hasTeacher = !!(recipe.teacher_vendor || recipe.synthesized_by);
  const hasWeights = !!(recipe.weights_file || recipe.gguf_file || recipe.onnx_file);
  if (hasTeacher && hasWeights) {
    throw new Error(
      `recipe class ambiguous: recipe '${recipe.id || '?'}' carries BOTH ` +
      `teacher_vendor/synthesized_by AND weights_file/gguf_file/onnx_file. ` +
      `Pick one: distilled_model (weights, teacher trained them) or ` +
      `synthesized_rule (LLM-emitted source, no weights). Set recipe.class ` +
      `explicitly to disambiguate.`
    );
  }
  if (recipe.workflow_ir || recipe.workflow_ir_hash) return 'workflow_capsule';
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
      `taxonomy: a distilled_model artifact MUST ship real model bytes. ` +
      `If this is a rule-class recipe, set class='rule' or omit the field.`
    );
  }
  // W252b Bug 3 + W258-ML-8 — every weights pointer declared by a
  // distilled_model recipe must EXIST on disk and be NON-EMPTY at build
  // time. Earlier this checked only the FIRST non-null pointer
  // (weights_file || gguf_file || onnx_file); a recipe that named all
  // three with one valid + two bogus passed. The manifest hash check
  // that runs later re-binds to bytes for whichever pointer the artifact
  // actually carries.
  if (declared === 'distilled_model') {
    const pointers = [
      ['weights_file', recipe.weights_file],
      ['gguf_file', recipe.gguf_file],
      ['onnx_file', recipe.onnx_file],
    ].filter(([, v]) => typeof v === 'string' && v.length > 0);
    for (const [field, wf] of pointers) {
      let st;
      try {
        st = fs.statSync(wf);
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          throw new Error(
            `recipe '${recipe.id || '?'}' ${field} weights file does not exist at path: ${wf}. ` +
            `A distilled_model artifact MUST ship real model bytes. Re-run the ` +
            `distillation worker or correct the ${field} path.`
          );
        }
        throw e;
      }
      if (st.size === 0) {
        throw new Error(
          `recipe '${recipe.id || '?'}' ${field} weights file is empty (0 bytes) at path: ${wf}. ` +
          `A distilled_model artifact MUST ship real model bytes; a 0-byte file ` +
          `is the exact shape this verifier rejects. Re-run the distillation ` +
          `worker to populate the file.`
        );
      }
    }
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
  // Wave 286 — workflow_capsule claim requires a workflow_ir block (or a
  // workflow_ir_hash if the IR was already detached for hashing).
  if (declared === 'workflow_capsule' && !recipe.workflow_ir && !recipe.workflow_ir_hash) {
    throw new Error(
      `recipe '${recipe.id || '?'}' declares class='workflow_capsule' but carries no workflow_ir block. ` +
      `A workflow_capsule recipe must ship its workflow_ir (or workflow_ir_hash) so verifiers can replay the graph.`
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
  // Wave 286 — workflow_capsule artifact MUST carry the workflow_ir_hash in
  // its lineage block so the IR shape can be byte-checked against the zip's
  // workflow_ir.json. Without this, the runtime would happily replay a tampered
  // IR.
  if (declared === 'workflow_capsule') {
    const wih = manifest.lineage && manifest.lineage.workflow_ir_hash;
    if (!wih) {
      return { ok: false, reason: 'artifact_class=workflow_capsule requires manifest.lineage.workflow_ir_hash; without it the runtime cannot prove the IR has not been tampered with.' };
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

// ----------------------------------------------------------------------------
// Wave 285 — honest source_type taxonomy.
//
// `class` says WHAT a recipe behaves like at runtime (rule, synthesized_rule,
// compiled_rule, distilled_model). `source_type` says HOW the recipe source
// was produced. Both are load-bearing claims and the verifier rejects any
// mismatch between them.
//
// The five honest source types:
//   hand_written      — human author, no LLM in the loop
//   pattern_generated — deterministic pattern-matcher emitted the code
//   llm_emitted       — an LLM teacher emitted the source
//   distilled         — LoRA-finetuned weights derived from teacher pairs
//   compiled_from_dsl — emitted by a DSL → JS / native lowering
// ----------------------------------------------------------------------------

export const RECIPE_SOURCE_TYPES = Object.freeze([
  'hand_written',
  'pattern_generated',
  'llm_emitted',
  'distilled',
  'compiled_from_dsl',
]);

// Class × source_type compatibility matrix. The verifier consults this; any
// combination not listed under `accepts` is rejected at build time. Keeping
// the matrix here (next to RECIPE_CLASSES + CLASS_DESCRIPTIONS) prevents
// drift between the spec, the verifier, and the marketing copy.
export const CLASS_SOURCE_TYPE_RULES = Object.freeze({
  rule: {
    accepts: ['hand_written', 'pattern_generated'],
    rejects: ['llm_emitted', 'distilled'],
  },
  synthesized_rule: {
    requires: ['llm_emitted'],
    accepts: ['llm_emitted'],
  },
  compiled_rule: {
    accepts: ['hand_written', 'pattern_generated', 'llm_emitted', 'compiled_from_dsl'],
    rejects: ['distilled'],
  },
  distilled_model: {
    requires: ['distilled'],
    accepts: ['distilled'],
  },
  // Wave 286 — a workflow_capsule's source can be a captured production trace
  // (counts as llm_emitted when the trace contains LLM calls) OR a hand-
  // authored IR (hand_written). It can also be the output of a DSL → IR
  // lowering (compiled_from_dsl). It is NEVER distilled — a workflow is a
  // graph of executors, not a model.
  workflow_capsule: {
    accepts: ['hand_written', 'llm_emitted', 'compiled_from_dsl'],
    rejects: ['distilled'],
  },
});

// Infer the honest source_type from a recipe's shape. Used when the caller
// did not declare `recipe.source_type` and we need to derive it for the
// manifest. Heuristic order (most-specific first):
//   1. recipe has weights / gguf / onnx → distilled
//   2. recipe has teacher_vendor / synthesized_by / synthesis_strategy=claude
//      → llm_emitted
//   3. recipe has synthesis_strategy=pattern → pattern_generated
//   4. recipe has dsl block AND no teacher → compiled_from_dsl
//   5. otherwise → hand_written
export function inferSourceType(recipe) {
  if (!recipe || typeof recipe !== 'object') return 'hand_written';
  if (recipe.weights_file || recipe.gguf_file || recipe.onnx_file) return 'distilled';
  if (recipe.class === 'distilled_model') return 'distilled';
  const strat = recipe.synthesis_strategy || (recipe.synthesis && recipe.synthesis.strategy);
  if (strat === 'pattern' || strat === 'patterns' || strat === 'pattern_match') return 'pattern_generated';
  if (strat === 'claude' || strat === 'llm' || strat === 'teacher') return 'llm_emitted';
  if (recipe.teacher_vendor || recipe.teacher_model || recipe.synthesized_by) return 'llm_emitted';
  if (recipe.class === 'synthesized_rule') return 'llm_emitted';
  // DSL counts as compiled_from_dsl when the recipe declares emit targets,
  // a pre-built native_bin, OR the caller has explicitly declared
  // class='compiled_rule'. A bare DSL on a rule-class recipe is just a
  // hand-authored declarative form and stays hand_written.
  if (recipe.dsl && (recipe.compiled_targets || recipe.native_bin || recipe.class === 'compiled_rule')) {
    return 'compiled_from_dsl';
  }
  return 'hand_written';
}

// Validate a recipe's declared source_type against its declared class.
// Throws with a verifier-grade error message on mismatch. The error text
// is asserted by the lock-in tests; keep the verbatim shape stable.
export function validateRecipeSourceType(recipe) {
  if (!recipe || typeof recipe !== 'object') {
    throw new Error('recipe must be an object');
  }
  const klass = recipe.class || recipe.recipe_class;
  const st = recipe.source_type;
  if (!st) {
    throw new Error(
      `recipe '${recipe.id || '?'}' is missing source_type. ` +
      `Every recipe must declare one of [${RECIPE_SOURCE_TYPES.join(', ')}].`
    );
  }
  if (!RECIPE_SOURCE_TYPES.includes(st)) {
    throw new Error(
      `recipe '${recipe.id || '?'}' source_type ${JSON.stringify(st)} is not in [${RECIPE_SOURCE_TYPES.join(', ')}]`
    );
  }
  if (!klass) return st;
  const rule = CLASS_SOURCE_TYPE_RULES[klass];
  if (!rule) return st;
  if (rule.requires && !rule.requires.includes(st)) {
    throw new Error(
      `recipe '${recipe.id || '?'}' class=${klass} requires source_type in [${rule.requires.join(', ')}], got ${JSON.stringify(st)}. ` +
      `Honest taxonomy: a ${klass} recipe MUST carry source_type=${rule.requires[0]}.`
    );
  }
  if (rule.rejects && rule.rejects.includes(st)) {
    throw new Error(
      `recipe '${recipe.id || '?'}' class=${klass} rejects source_type=${st}. ` +
      `A ${klass} recipe cannot have been produced as ${st}; ` +
      `accepted source_type values: [${rule.accepts.join(', ')}].`
    );
  }
  if (rule.accepts && !rule.accepts.includes(st)) {
    throw new Error(
      `recipe '${recipe.id || '?'}' class=${klass} accepts source_type in [${rule.accepts.join(', ')}], got ${JSON.stringify(st)}`
    );
  }
  return st;
}
