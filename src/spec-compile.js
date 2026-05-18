// Spec-driven local compile.
//
// Anyone — human OR AI agent — can write a JSON spec describing a task plus
// a deterministic recipe (a JS function), pipe it to `kolm compile --spec -`,
// and get back a signed `.kolm` that runs locally. No cloud round-trip, no
// account, no SaaS dependency.
//
// Spec shape (every field is checked):
//   {
//     "job_id":     "job_<slug>",                       // unique per artifact
//     "task":       "human-readable description",       // appears in manifest
//     "base_model": "none" | "qwen2.5-3b" | ...,        // optional
//     "recipes": [
//       {
//         "id":      "rcp_<slug>",
//         "name":    "human-readable",
//         "source":  "function generate(input, lib) { ... }",
//         "tags":    ["..."],                            // optional
//         "schema":  { "input": {...}, "output": {...} } // optional
//       }, ...
//     ],
//     "pack":   { ... },                                  // optional KOLMPACK
//     "index":  { ... },                                  // optional KOLMIDX
//     "evals": {
//       "spec":     "rs-1-evals",
//       "n":        <count>,
//       "cases":    [{ "id", "input", "expected", "params"? }, ...],
//       "coverage": <0..1>
//     },
//     "training_stats": { ... }                           // optional
//   }
//
// The receipt is HMAC-signed with whichever secret is set at compile time.
// For solo local use we auto-derive a stable per-user secret on first run
// (stored in ~/.kolm/config.json mode 0600). Fleet operators can pin
// RECIPE_RECEIPT_SECRET in env so any teammate's verifier accepts the result.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileJs, verify as verifyRecipe } from './verifier.js';
import { subroutines as LIBRARY } from './library.js';
import { prepareSeedSplit, MIN_PRODUCTION_HOLDOUT, MIN_PRODUCTION_TRAIN } from './seeds.js';
import { computeSeedProductionReady } from './production-ready.js';
import { scoreHoldout, SUPPORTED_COMPARATORS } from './comparators.js';
import { validateDsl, emitJs, emitCompiledTargets, DSL_SPEC } from './dsl.js';
import { loadDistillProvenance } from './distill-provenance.js';
import { loadExportProvenance } from './export-provenance.js';
import { loadMoeProvenance } from './moe-provenance.js';
import { loadPretokenizeProvenance } from './pretokenize-provenance.js';
import { loadHoldouts, buildExternalHoldoutBlock } from './external-holdout.js';
import { loadCorpus as loadTenantCorpus, buildTenantShadowBlock } from './tenant-holdout.js';
import { loadAttestationFile as loadAuditorAttestationFile, crossCheckAttestation as crossCheckAuditorAttestation } from './auditor-attestation.js';
import { buildSupersessionBlock, validateSupersessionBlock, validateDriftReport, loadDriftReport, SUPERSESSION_REASONS } from './drift-supersession.js';
const BUILTIN_PATTERNS = LIBRARY.patterns;

function err(msg) {
  const e = new Error(msg);
  e.code = 'KOLM_E_SPEC_INVALID';
  return e;
}

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

// Local canonical-json (key-sorted recursive) helper for hash bindings that
// have to match the artifact.js side bit-for-bit. Same shape as the one in
// artifact.js / tenant-holdout.js — kept inline here so the wave-166 cross-
// check after buildAndZip doesn't have to import a private helper.
function canonicalJsonLocal(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJsonLocal).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJsonLocal(v[x])).join(',') + '}';
}

function ensurePerUserSecret() {
  if (process.env.RECIPE_RECEIPT_SECRET) return process.env.RECIPE_RECEIPT_SECRET;
  if (process.env.KOLM_ARTIFACT_SECRET) return process.env.KOLM_ARTIFACT_SECRET;
  const home = os.homedir();
  const dir = path.join(home, '.kolm');
  const cfg = path.join(dir, 'config.json');
  fs.mkdirSync(dir, { recursive: true });
  let json = {};
  if (fs.existsSync(cfg)) {
    try { json = JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch { json = {}; }
  }
  if (!isNonEmptyString(json.local_receipt_secret)) {
    json.local_receipt_secret = 'kolm-local-' + crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(cfg, JSON.stringify(json, null, 2));
    try { fs.chmodSync(cfg, 0o600); } catch {}
  }
  process.env.RECIPE_RECEIPT_SECRET = json.local_receipt_secret;
  return json.local_receipt_secret;
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw err('spec must be a JSON object');
  if (!isNonEmptyString(spec.job_id)) throw err('spec.job_id must be a non-empty string (e.g. "job_my_redactor")');
  if (!/^job_[a-z0-9_-]+$/i.test(spec.job_id)) throw err('spec.job_id must match /^job_[a-z0-9_-]+$/i');
  if (!isNonEmptyString(spec.task)) throw err('spec.task must be a non-empty string');
  if (!Array.isArray(spec.recipes) || spec.recipes.length === 0) throw err('spec.recipes must be a non-empty array');
  const compiledRule = spec.artifact_class === 'compiled_rule';
  for (const r of spec.recipes) {
    if (!isNonEmptyString(r.id)) throw err('every recipe needs an id (e.g. "rcp_my_recipe")');
    if (!isNonEmptyString(r.name)) throw err(`recipe ${r.id}: name is required`);
    const hasSource = isNonEmptyString(r.source);
    const hasDsl = r.dsl && typeof r.dsl === 'object' && !Array.isArray(r.dsl);
    if (!hasSource && !hasDsl) {
      throw err(`recipe ${r.id}: needs either source (JS "function generate(input, lib) { ... }") or dsl (rule-dsl-v1 AST)`);
    }
    if (compiledRule && !hasDsl) {
      throw err(`recipe ${r.id}: artifact_class='compiled_rule' requires a dsl block (rule-dsl-v1); raw JS source is not eligible for native codegen`);
    }
    if (hasDsl) {
      try { validateDsl(r.dsl, { targets: compiledRule ? ['c', 'rust'] : [] }); }
      catch (e) { throw err(`recipe ${r.id}: dsl failed validation: ${e.message}`); }
    }
    if (hasSource) {
      try { compileJs(r.source); }
      catch (e) { throw err(`recipe ${r.id}: source failed to compile: ${e.message}`); }
    }
  }
  if (spec.evals) {
    if (typeof spec.evals !== 'object' || spec.evals === null) throw err('spec.evals must be an object when present');
    if (spec.evals.cases && !Array.isArray(spec.evals.cases)) throw err('spec.evals.cases must be an array');
  }
  return true;
}

// Compile a spec into a signed .kolm. Returns { outPath, manifest, k_score,
// sha256, bytes, evals_report, seed_provenance }.
//
// Q+2 seed gate (Wave 144): when `opts.seedsPath` is supplied (or the spec
// has no inline evals.cases and a seeds file is auto-resolvable), the
// pipeline runs `prepareSeedSplit` and:
//   - recipes are still authored by the spec (recipe synthesis from train
//     pairs is a later wave); but
//   - the K-score accuracy axis is computed by running the recipe over
//     HOLDOUT inputs only, with the chosen comparator;
//   - evals.json that ships inside the artifact is the holdout set, so an
//     external verifier can rerun the same evaluation; and
//   - manifest.seed_provenance records (seeds_hash, split_seed, train_hash,
//     holdout_hash, train_count, holdout_count, eval_source, comparator,
//     leakage_report_hash) so the entire chain is recomputable.
export async function compileSpec(spec, opts = {}) {
  validateSpec(spec);
  ensurePerUserSecret();
  const { buildAndZip } = await import('./artifact.js');

  // A recipe may be authored with: (a) just `source` (legacy JS path),
  // (b) just `dsl` (rule-dsl-v1 AST — source is auto-generated by emitJs so
  // the artifact-runner runs the same byte-for-byte JS path), or (c) both
  // (advanced — caller wants a custom JS source kept in lock-step with a
  // declared DSL; we honor the supplied source verbatim but still ship the
  // DSL on recipes.json so a verifier can recompute the C/Rust targets).
  const recipes = spec.recipes.map(r => {
    const hasDsl = r.dsl && typeof r.dsl === 'object' && !Array.isArray(r.dsl);
    const source = isNonEmptyString(r.source) ? r.source : (hasDsl ? emitJs(r.dsl) : '');
    return {
      id: r.id,
      name: r.name,
      source,
      source_hash: crypto.createHash('sha256').update(source).digest('hex').slice(0, 16),
      version_id: r.version_id || `ver_${r.id.replace(/^rcp_/, '')}_001`,
      tags: r.tags || [],
      schema: r.schema || null,
      params: r.params || null,
      dsl: hasDsl ? r.dsl : null,
    };
  });

  const comparatorName = (opts.comparator || spec.comparator || 'exact').toLowerCase();
  if (!SUPPORTED_COMPARATORS.includes(comparatorName)) {
    throw err(`comparator '${comparatorName}' not supported (use one of: ${SUPPORTED_COMPARATORS.join(', ')})`);
  }
  const splitSeed = opts.splitSeed || spec.split_seed || undefined;
  const holdoutRatio = typeof opts.holdoutRatio === 'number'
    ? opts.holdoutRatio
    : (typeof spec.holdout_ratio === 'number' ? spec.holdout_ratio : undefined);

  // Decide whether to run the seed gate. Path is triggered when:
  //   - opts.seedsPath is explicitly passed (CLI --seeds), OR
  //   - opts.useSeedsGate is true (programmatic call wants the gate), OR
  //   - the spec has no inline evals.cases (then we try to auto-resolve).
  // The legacy hardcoded-evals path stays available for the four fixture
  // artifacts and for buyers who haven't migrated to seeds.jsonl yet.
  const inlineCases = (spec.evals && Array.isArray(spec.evals.cases)) ? spec.evals.cases : [];
  const tryGate = !!opts.seedsPath || !!opts.useSeedsGate || (inlineCases.length === 0 && opts.allowSeedAutoResolve !== false);
  let seedSplit = null;
  if (tryGate) {
    try {
      seedSplit = prepareSeedSplit({
        seedsPath: opts.seedsPath,
        split_seed: splitSeed,
        holdout_ratio: holdoutRatio,
        task: opts.task || spec.task_name || (spec.job_id ? spec.job_id.replace(/^job_/, '') : null),
        cwd: opts.cwd || process.cwd(),
      });
    } catch (e) {
      if (opts.seedsPath) {
        // User explicitly asked for seeds; failing to load is fatal.
        throw err(`could not load seeds at ${opts.seedsPath}: ${e.message}`);
      }
      // Auto-resolve missed; fall through to legacy path.
      seedSplit = null;
    }
  }

  // No seeds AND no inline cases AND no recipe stub override -> blank-spec
  // refusal. The pre-Wave-144 behavior emitted an artifact whose evals.cases
  // was [] and whose K-score reflected only template-author optimism. That
  // path is now closed.
  if (!seedSplit && inlineCases.length === 0 && opts.allowEmptyEvals !== true) {
    throw err('no seeds provided. write seeds.jsonl with at least 5 real input/output rows, or pass --seeds <path>. (set opts.allowEmptyEvals=true if you really want an artifact with no eval set.)');
  }

  // Construct the evals.json that ships in the artifact. With the seed gate,
  // it is the HOLDOUT split — never train, never recipe-derived. Without
  // (legacy path), it is whatever spec.evals.cases contained.
  let evals;
  if (seedSplit) {
    evals = {
      spec: 'rs-1-evals',
      n: seedSplit.holdout.length,
      cases: seedSplit.holdout.map((row, i) => ({
        id: (row.metadata && row.metadata.id) || `holdout_${i + 1}`,
        input: row.input,
        expected: row.expected,
        ...(row.metadata && row.metadata.params ? { params: row.metadata.params } : {}),
        ...(row.metadata && row.metadata.tags && row.metadata.tags.length ? { tags: row.metadata.tags } : {}),
      })),
      coverage: typeof spec.evals?.coverage === 'number' ? spec.evals.coverage : 1.0,
      source: 'seeds.jsonl holdout',
      comparator: comparatorName,
    };
  } else {
    if (spec.evals && Array.isArray(spec.evals.cases) && typeof spec.evals.n === 'number' && spec.evals.n !== spec.evals.cases.length) {
      console.error(`warning: spec.evals.n=${spec.evals.n} but cases.length=${spec.evals.cases.length}; using ${spec.evals.cases.length}.`);
    }
    evals = spec.evals && spec.evals.cases ? {
      spec: spec.evals.spec || 'rs-1-evals',
      n: spec.evals.cases.length,
      cases: spec.evals.cases,
      coverage: typeof spec.evals.coverage === 'number' ? spec.evals.coverage : 1.0,
      comparator: comparatorName,
    } : { spec: 'rs-1-evals', n: 0, cases: [], comparator: comparatorName };
  }

  // Run the first recipe against evals.cases. With the seed gate, accuracy
  // is exactly the chosen comparator's pass-rate over UNSEEN holdout rows.
  // Without the gate, it is the pass-rate over the spec's inline cases
  // (pre-Wave-144 behavior, retained for backward compat with hardcoded
  // template fixtures). Either way, accuracy is now measured, not claimed.
  let measured = null;
  let holdoutScore = null;
  if (evals.cases && evals.cases.length && spec.recipes[0] && typeof spec.recipes[0].source === 'string') {
    try {
      const rawGen = compileJs(spec.recipes[0].source);
      const libCtx = {
        params: spec.recipes[0].params || {},
        patterns: BUILTIN_PATTERNS,
        pack: spec.pack || null,
      };
      const generator = (input) => rawGen(input, libCtx);
      const positives = evals.cases.map(c => ({ input: c.input, expected: c.expected }));
      measured = verifyRecipe(generator, { positives });
      if (seedSplit) {
        // Re-score with comparator (verifyRecipe uses exact match; we may
        // want json_subset / normalized_string / label for richer recipes).
        holdoutScore = scoreHoldout(
          seedSplit.holdout.map((row) => ({ input: row.input, expected: row.expected, metadata: row.metadata })),
          generator,
          comparatorName,
        );
        // Honesty: when the comparator disagrees with verifyRecipe's exact-
        // match, the comparator wins (it is the one the manifest declares).
        if (holdoutScore && typeof holdoutScore.accuracy === 'number') {
          measured.pass_rate_positive = holdoutScore.accuracy;
        }
      }
    } catch (e) {
      measured = null;
    }
  }
  const training_stats = measured
    ? {
        pass_rate_positive: measured.pass_rate_positive,
        latency_p50_us: measured.latency_p50_us || 50,
        evaluated_against: evals.cases.length,
        eval_passed: Math.round(measured.pass_rate_positive * evals.cases.length),
        ...(spec.training_stats || {}),
        pass_rate_positive_measured: measured.pass_rate_positive,
        comparator: comparatorName,
        eval_split: seedSplit ? 'holdout' : 'inline',
        // wave 145 — surface the holdout accuracy as a dedicated field when
        // the seed-split path ran. This is what K-score V2 reads as the R
        // axis (robustness) and the numerator of T = student / teacher.
        ...(seedSplit && holdoutScore && typeof holdoutScore.accuracy === 'number'
          ? { holdout_accuracy: holdoutScore.accuracy }
          : {}),
      }
    : (spec.training_stats || { pass_rate_positive: 1.0, latency_p50_us: 80, eval_split: seedSplit ? 'holdout' : 'inline', comparator: comparatorName });
  if (measured) training_stats.pass_rate_positive = measured.pass_rate_positive;

  const outDir = opts.outDir || path.join(os.homedir(), '.kolm', 'artifacts');
  fs.mkdirSync(outDir, { recursive: true });

  // Seed provenance — what the artifact's manifest will record. Includes a
  // production-readiness flag so the verifier can downgrade artifacts to
  // 'sample_check' when the holdout is too small to ground a public K-score.
  let seed_provenance = null;
  if (seedSplit) {
    // W258-ML-4 + W339: production_ready ANDs every leakage signal seeds.js
    // computes (near-duplicate / group-id / exact input+output overlap) with
    // the min-train + min-holdout counts. Logic now lives in
    // src/production-ready.js so cmdCompile, cmdRun, cmdVerify, and the
    // marketplace gate all read the same definition.
    const production_ready = computeSeedProductionReady(seedSplit);
    seed_provenance = {
      seeds_hash: seedSplit.seeds_hash,
      split_seed: seedSplit.split_seed,
      holdout_ratio: seedSplit.holdout_ratio,
      train_hash: seedSplit.train_hash,
      holdout_hash: seedSplit.holdout_hash,
      train_count: seedSplit.train_count,
      holdout_count: seedSplit.holdout_count,
      eval_source: seedSplit.eval_source,
      leakage_report_hash: seedSplit.leakage_report_hash,
      comparator: comparatorName,
      source_format_mix: seedSplit.source_format_mix,
      seeds_path_basename: path.basename(seedSplit.seeds_path),
      production_ready,
      min_train: MIN_PRODUCTION_TRAIN,
      min_holdout: MIN_PRODUCTION_HOLDOUT,
      // Verifier (Wave D) reads these counts directly from the manifest so it
      // can fail the build without re-loading seeds.jsonl. The leakage_report
      // itself is hashed (above) so a third party with seeds.jsonl can also
      // recompute and confirm.
      input_overlap_count: seedSplit.leakage_report.input_overlap_count,
      output_overlap_count: seedSplit.leakage_report.output_overlap_count,
      near_duplicate_count: seedSplit.leakage_report.near_duplicate_count,
      grouped_overlap_count: seedSplit.leakage_report.grouped_overlap_count,
    };
    // Wave 283 — surface the hash of the rows the teacher actually saw. The
    // caller (compile.js) computes this from `train` before invoking ctx
    // .synthesize so an external auditor can prove the holdout never leaked
    // into recipe construction. When the caller fed train (the policy),
    // synthesis_input_hash will equal train_hash; if it doesn't, the manifest
    // tells the story honestly.
    if (spec.training_stats && spec.training_stats.synthesis_input_hash) {
      seed_provenance.synthesis_input_hash = spec.training_stats.synthesis_input_hash;
    }
  }

  const artifactClass = opts.artifactClass || spec.artifact_class || 'rule';

  // Wave F — when the caller declared a compiled_rule artifact, every recipe
  // already has a validated DSL block (validateSpec enforces this). Emit
  // native.c + native.rs per recipe and bundle into a `compiled_targets`
  // section that buildAndZip writes into the zip + manifest. The runtime
  // still executes the auto-generated JS source — Wave G adds optional
  // native execution when a cc/cargo toolchain is present.
  let compiled_targets = null;
  if (artifactClass === 'compiled_rule') {
    const single = recipes.length === 1;
    const targets_by_recipe = {};
    for (const r of recipes) {
      if (!r.dsl) {
        throw err(`recipe ${r.id}: compiled_rule artifact requires dsl (rule-dsl-v1)`);
      }
      const t = emitCompiledTargets(r.dsl, { recipeName: r.id });
      const cName = single ? 'native.c' : `native.${r.id}.c`;
      const rsName = single ? 'native.rs' : `native.${r.id}.rs`;
      targets_by_recipe[r.id] = {
        c: { filename: cName, source_hash: t.c.source_hash, bytes: t.c.bytes, source: t.c.source },
        rust: { filename: rsName, source_hash: t.rust.source_hash, bytes: t.rust.bytes, source: t.rust.source },
      };
    }
    compiled_targets = {
      spec: DSL_SPEC,
      single_recipe: single,
      targets: ['c', 'rust'],
      recipes: targets_by_recipe,
    };
    // Wave G — opt-in native compilation. Default behaviour stays source-only
    // so the JS-rule path keeps working on machines without cc/cargo. Enable
    // by setting opts.compileNative = true OR env KOLM_COMPILE_NATIVE=1.
    // Toolchain absence is non-fatal — `bundle.skipped` records the reason
    // and the artifact ships without binaries (verifier check #12 is a no-op
    // when no bin entries claim a hash).
    //
    // Wave 155 §P+3 — WASM target is its own opt-in (compileWasm true OR
    // KOLM_COMPILE_WASM=1 OR KOLM_COMPILE_WASM_ONLY=1). Either native or
    // WASM intent triggers compileNativeTargets; the function internally
    // gates which kinds run via its own toggles.
    const wantNative = opts.compileNative === true
      || process.env.KOLM_COMPILE_NATIVE === '1';
    const wantWasm = opts.compileWasm === true
      || process.env.KOLM_COMPILE_WASM === '1'
      || process.env.KOLM_COMPILE_WASM_ONLY === '1';
    if (wantNative || wantWasm) {
      const { compileNativeTargets } = await import('./native-compile.js');
      const native = compileNativeTargets(compiled_targets, {
        toolchains: opts.toolchains, // tests can inject; production detects
        compileWasm: wantWasm,
        cOnly: opts.cOnly,
        rustOnly: opts.rustOnly,
        wasmOnly: opts.wasmOnly,
      });
      compiled_targets.native = native;
    }
  }

  // Wave 144 — optional extra files (e.g. a tokenizer.json) ride inside the
  // .kolm zip. The bytes hash into manifest.hashes.extra_files and
  // artifact_hash so the receipt chain covers them.
  let extraFiles = opts.extra_files || null;
  let trainingStatsForBuild = training_stats;
  if (opts.tokenizerPath) {
    const tokBuf = fs.readFileSync(opts.tokenizerPath);
    let tokMeta = { type: 'unknown', vocab_size: null, sha256: crypto.createHash('sha256').update(tokBuf).digest('hex') };
    try {
      const parsed = JSON.parse(tokBuf.toString('utf-8'));
      tokMeta = { type: parsed.type || 'unknown', vocab_size: parsed.vocab_size || null, sha256: tokMeta.sha256 };
    } catch { /* leave defaults; non-json tokenizers (e.g. binary) still pack */ }
    trainingStatsForBuild = { ...(trainingStatsForBuild || {}), tokenizer: { ...tokMeta, filename: 'tokenizer.json' } };
    extraFiles = [...(extraFiles || []), { filename: 'tokenizer.json', content: tokBuf }];
  }

  // Wave 144 Q+3 — distillation provenance. When the caller points at a
  // workers/distill output dir (or a precomputed inline object), we read its
  // manifest.json + training-pairs.jsonl, recompute hashes, and build a
  // lineage block (source='distillation') that buildAndZip will hash into
  // the artifact_hash. The verifier (src/binder.js) already knows how to
  // walk a lineage block — see wave144-verifier-states tests.
  let lineageBlock = opts.lineage || spec.lineage || null;
  let distillProvenance = null;
  if (opts.distillProvenancePath) {
    distillProvenance = loadDistillProvenance(opts.distillProvenancePath, { cwd: opts.cwd || process.cwd() });
    if (!lineageBlock) lineageBlock = distillProvenance.lineage;
    trainingStatsForBuild = {
      ...(trainingStatsForBuild || {}),
      distill_worker_version: distillProvenance.worker_version,
      teacher_vendor: distillProvenance.teacher_vendor,
      teacher_model: distillProvenance.teacher_model,
      // wave 158 — cross-vendor distillation provenance. Verifier check #15
      // demands all four of {teacher_vendor, teacher_model, student_base,
      // distillation_method} when the lineage source is 'distillation'.
      // The four "student_base_*" fields self-describe the weights' license
      // terms inside the manifest so a third party doesn't need to chase a
      // HuggingFace lookup to know what they're shipping.
      teacher_version: distillProvenance.teacher_version,
      student_base: distillProvenance.student_base,
      student_base_repo: distillProvenance.student_base_repo,
      student_base_origin: distillProvenance.student_base_origin,
      student_base_license: distillProvenance.student_base_license,
      student_base_revision: distillProvenance.student_base_revision,
      distillation_method: distillProvenance.distillation_method,
      training_pairs_collected: distillProvenance.training_pairs_collected,
      training_pairs_hash: distillProvenance.training_pairs_hash,
      redaction_map_hash: distillProvenance.redaction_map_hash,
      // wave 157 — receipt-chain extension for PHI workloads. When
      // redact_class is anything other than 'none' the binder's check #14
      // confirms the matching log hashes are present so an auditor can
      // replay the redaction pipeline offline and prove raw PHI never left
      // the tenant boundary.
      redact_class: distillProvenance.redact_class,
      teacher_call_log_hash: distillProvenance.teacher_call_log_hash,
      reinjection_log_hash: distillProvenance.reinjection_log_hash,
      ml_pipeline_run: distillProvenance.ml_pipeline_run,
      // wave 145 — teacher-holdout pass-through for K-score T axis. When the
      // worker ran --teacher-holdout the worker manifest carries these; they
      // flow through to buildAndZip where computeKScore picks them up and
      // emits a v2 envelope with T (= holdout_accuracy / teacher_holdout_accuracy).
      teacher_holdout_accuracy: distillProvenance.teacher_holdout_accuracy,
      teacher_holdout_count: distillProvenance.teacher_holdout_count,
      teacher_holdout_log_hash: distillProvenance.teacher_holdout_log_hash,
    };
  }

  // Wave 146 — export provenance. When the caller points at an apps/export
  // output dir (manifest-driven preferred; scan-driven fallback) the bridge
  // reads it, recomputes every target sha256, and returns a normalized
  // export_block + files_to_bundle. The block flows into buildAndZip's
  // manifest.export and folds into artifact_hash; each target file rides
  // along inside the .kolm as a bundled extra_file so the .gguf/.onnx/etc.
  // physically ships in the same zip as the recipes/eval/receipt.
  let exportProvenance = null;
  if (opts.exportProvenancePath) {
    exportProvenance = loadExportProvenance(opts.exportProvenancePath, { cwd: opts.cwd || process.cwd() });
    const exportFiles = [];
    for (const f of exportProvenance.files_to_bundle) {
      if (f.is_dir) {
        // Directory target (CoreML .mlpackage / TensorRT engine/ / mlx_model/).
        // We bundle the whole tree under the original dir name so loaders that
        // expect e.g. `model.mlpackage/Manifest.json` keep working. ZIP central
        // directories preserve forward slashes regardless of host OS.
        const walk = (rel) => {
          const items = fs.readdirSync(path.join(f.absPath, rel || ''));
          for (const name of items.sort()) {
            const childRel = rel ? path.posix.join(rel, name) : name;
            const childAbs = path.join(f.absPath, childRel);
            const st = fs.statSync(childAbs);
            if (st.isDirectory()) walk(childRel);
            else if (st.isFile()) {
              exportFiles.push({
                filename: path.posix.join(f.filename, childRel.replace(/\\/g, '/')),
                content: fs.readFileSync(childAbs),
              });
            }
          }
        };
        walk('');
      } else {
        exportFiles.push({ filename: f.filename, content: fs.readFileSync(f.absPath) });
      }
    }
    extraFiles = [...(extraFiles || []), ...exportFiles];
    trainingStatsForBuild = {
      ...(trainingStatsForBuild || {}),
      export_backend: exportProvenance.backend,
      export_targets: exportProvenance.targets.map(t => ({ format: t.format, filename: t.filename, sha256: t.sha256, size_bytes: t.size_bytes })),
    };
  }

  // Wave 147 — MoE composition provenance. When the caller points at an
  // apps/trainer/moe_run.py output dir, the bridge reads the manifest
  // (kolm_moe:true marker required), recomputes router + per-expert
  // sha256s, and returns moe_block + files_to_bundle. The router .pt and
  // each expert file ride along inside the .kolm so the verifier can
  // re-hash them against the moe block's declared values.
  let moeProvenance = null;
  if (opts.moeProvenancePath) {
    moeProvenance = loadMoeProvenance(opts.moeProvenancePath, { cwd: opts.cwd || process.cwd() });
    const moeFiles = [];
    for (const f of moeProvenance.files_to_bundle) {
      if (f.is_dir) {
        const walk = (rel) => {
          const items = fs.readdirSync(path.join(f.absPath, rel || ''));
          for (const name of items.sort()) {
            const childRel = rel ? path.posix.join(rel, name) : name;
            const childAbs = path.join(f.absPath, childRel);
            const st = fs.statSync(childAbs);
            if (st.isDirectory()) walk(childRel);
            else if (st.isFile()) {
              moeFiles.push({
                filename: path.posix.join(f.filename, childRel.replace(/\\/g, '/')),
                content: fs.readFileSync(childAbs),
              });
            }
          }
        };
        walk('');
      } else {
        moeFiles.push({ filename: f.filename, content: fs.readFileSync(f.absPath) });
      }
    }
    extraFiles = [...(extraFiles || []), ...moeFiles];
    trainingStatsForBuild = {
      ...(trainingStatsForBuild || {}),
      moe_base_model: moeProvenance.base_model,
      moe_routing_strategy: moeProvenance.routing_strategy,
      moe_top_k: moeProvenance.top_k,
      moe_n_experts: moeProvenance.experts.length,
      moe_experts: moeProvenance.experts.map(e => ({ name: e.name, filename: e.filename, sha256: e.sha256, size_bytes: e.size_bytes })),
    };
  }

  // Wave 148 — pretokenize composition. Reads manifest.json + tokens.idx +
  // tokens.pack from --pretokenize-provenance dir, recomputes file hashes,
  // re-parses the binary headers, and returns pretokenize_block +
  // files_to_bundle. Both binary files ride along in the .kolm so a
  // verifier can mmap them, re-hash them against the block, and confirm
  // the runtime tokenizer cache matches what was signed.
  let pretokenizeProvenance = null;
  if (opts.pretokenizeProvenancePath) {
    pretokenizeProvenance = loadPretokenizeProvenance(opts.pretokenizeProvenancePath, { cwd: opts.cwd || process.cwd() });
    const ptFiles = [];
    for (const f of pretokenizeProvenance.files_to_bundle) {
      ptFiles.push({ filename: f.filename, content: fs.readFileSync(f.absPath) });
    }
    extraFiles = [...(extraFiles || []), ...ptFiles];
    trainingStatsForBuild = {
      ...(trainingStatsForBuild || {}),
      pretokenize_tokenizer_id: pretokenizeProvenance.tokenizer_id,
      pretokenize_tokenizer_family: pretokenizeProvenance.tokenizer_family,
      pretokenize_vocab_size: pretokenizeProvenance.vocab_size,
      pretokenize_seq_count: pretokenizeProvenance.seq_count,
    };
  }

  // Wave 164 (N+3 / N+4) — external + adversarial holdout provenance. When the
  // caller names one or more holdouts via opts.externalHoldouts (kind=external)
  // and/or opts.adversarialHoldouts (kind=adversarial) the loader pulls each
  // by name from holdouts/catalog.json, normalizes rows via loadSeeds, rescores
  // them against the compiled recipe with the same comparator the seed gate
  // used, and produces a manifest block whose hash binds into artifact_hash.
  //
  // The two kinds share one block + one verifier check (binder #20) because
  // they share substrate: a JSONL corpus shipped under repo root with a
  // documented source_url / license / accessed_at the verifier can re-anchor.
  // The kind field is informational (so the verifier can surface "this is an
  // adversarial cross-family LLM-pair holdout" vs "this is an external public
  // benchmark") but does not change validation logic.
  let externalHoldoutBlock = null;
  const externalHoldoutNames = Array.isArray(opts.externalHoldouts) ? opts.externalHoldouts.slice() : [];
  const adversarialHoldoutNames = Array.isArray(opts.adversarialHoldouts) ? opts.adversarialHoldouts.slice() : [];
  const allHoldoutNames = [...externalHoldoutNames, ...adversarialHoldoutNames];
  if (allHoldoutNames.length > 0) {
    if (!spec.recipes[0] || typeof spec.recipes[0].source !== 'string') {
      throw err('external/adversarial holdouts require a recipe with executable source (JS or emitted from DSL); cannot score against an empty recipe');
    }
    const loadedHoldouts = loadHoldouts(allHoldoutNames, { root: opts.cwd || process.cwd() });
    // Reconstruct the generator the same way the seed-holdout score does
    // (the original lives inside an if-block at the top of compileSpec; we
    // rebuild here so external scoring is independent of seed-split presence).
    const extGen = compileJs(spec.recipes[0].source);
    const extLibCtx = {
      params: spec.recipes[0].params || {},
      patterns: BUILTIN_PATTERNS,
      pack: spec.pack || null,
    };
    const generator = (input) => extGen(input, extLibCtx);
    const scoreFn = (rows) => scoreHoldout(rows, generator, comparatorName);
    externalHoldoutBlock = buildExternalHoldoutBlock(loadedHoldouts, scoreFn, { comparator: comparatorName });
    if (externalHoldoutBlock) {
      // Surface per-holdout accuracy into training_stats so anyone reading
      // the manifest top-level "training" object sees the external numbers
      // without parsing the dedicated block. The block remains the canonical
      // source for the verifier.
      trainingStatsForBuild = {
        ...(trainingStatsForBuild || {}),
        external_holdout_summary: externalHoldoutBlock.holdouts.map(h => ({
          name: h.name,
          kind: h.kind,
          accuracy: h.accuracy,
          evaluated: h.evaluated_count,
        })),
      };
    }
  }

  // Wave 165 (N+5) — tenant shadow corpus provenance. The caller names one
  // or more shadow corpora via opts.tenantShadowCorpora as an array of
  // {tenant_id, corpus_id} pairs (CLI surfaces this as --tenant-shadow-corpus
  // <tenant_id>:<corpus_id>, repeatable). The loader reads each corpus from
  // the per-tenant storage dir (${KOLM_DATA_DIR}/tenant_holdouts/<tenant_id>/
  // <corpus_id>.jsonl), normalizes via loadSeeds, scores against the compiled
  // recipe with the same comparator the seed-gate used, and emits ONE block
  // per corpus into manifest.tenant_shadow_corpus_provenance (array). Unlike
  // external_holdout, the corpus bytes never enter the .kolm artifact — only
  // the hash + per-corpus accuracy + tenant_id/corpus_id are recorded. This
  // is HIPAA-data-never-leaves-tenant by construction.
  let tenantShadowBlocks = [];
  const tenantShadowSpec = Array.isArray(opts.tenantShadowCorpora) ? opts.tenantShadowCorpora.slice() : [];
  if (tenantShadowSpec.length > 0) {
    if (!spec.recipes[0] || typeof spec.recipes[0].source !== 'string') {
      throw err('tenant shadow corpora require a recipe with executable source (JS or emitted from DSL); cannot score against an empty recipe');
    }
    const tsGen = compileJs(spec.recipes[0].source);
    const tsLibCtx = {
      params: spec.recipes[0].params || {},
      patterns: BUILTIN_PATTERNS,
      pack: spec.pack || null,
    };
    const tsGenerator = (input) => tsGen(input, tsLibCtx);
    for (const ref of tenantShadowSpec) {
      const { tenant_id, corpus_id } = ref || {};
      if (!tenant_id || !corpus_id) {
        throw err(`tenant shadow corpus reference missing tenant_id or corpus_id: ${JSON.stringify(ref)}`);
      }
      const loaded = loadTenantCorpus(tenant_id, corpus_id, { dataDir: opts.dataDir });
      const score = scoreHoldout(loaded.rows, tsGenerator, comparatorName);
      tenantShadowBlocks.push(buildTenantShadowBlock(loaded, score, { comparator: comparatorName }));
    }
    if (tenantShadowBlocks.length > 0) {
      trainingStatsForBuild = {
        ...(trainingStatsForBuild || {}),
        tenant_shadow_summary: tenantShadowBlocks.map(b => ({
          tenant_id: b.tenant_id,
          corpus_id: b.corpus_id,
          accuracy: b.accuracy,
          evaluated: b.evaluated_count,
          row_count: b.row_count,
        })),
      };
    }
  }

  // Wave 166 (N+7) — third-party auditor attestation. The caller names one or
  // more attestation JSON files via opts.auditorAttestations (CLI surface:
  // --auditor-attestation <file>, repeatable). Each file holds an Ed25519-
  // signed block produced by `kolm auditor sign` against a PREVIOUS build of
  // this artifact (the attestation binds to artifact_hash). The build pipeline
  // re-validates each block here (schema + signature self-consistency); the
  // cross-check against the FRESHLY built manifest happens AFTER buildAndZip
  // because artifact_hash isn't known until then. If the attestation's signed
  // artifact_hash doesn't match the just-built artifact_hash, the build fails
  // — that's the signal a regulator wants: the attestation was for a different
  // artifact, refuse to embed it under the new build's signature.
  let auditorAttestationBlocks = [];
  const auditorAttestationPaths = Array.isArray(opts.auditorAttestations) ? opts.auditorAttestations.slice() : [];
  if (auditorAttestationPaths.length > 0) {
    for (const filePath of auditorAttestationPaths) {
      try {
        auditorAttestationBlocks.push(loadAuditorAttestationFile(filePath));
      } catch (e) {
        throw err(`auditor attestation ${filePath} failed to load/validate: ${e.message}`);
      }
    }
  }

  // Wave 167 (M+4) — supersession block. The caller passes opts.supersession
  // as either (a) a pre-built validated block (test path) or (b) a
  // construction input object {predecessor_artifact_hash, reason, ...} which
  // we hand to buildSupersessionBlock here. Building the block at the spec-
  // compile layer keeps the CLI surface narrow (one --supersession-of path
  // + --supersession-reason + optional --supersession-drift-report flag) and
  // lets the validation error surface as a build-time failure rather than a
  // bind-time failure later.
  let supersessionBlock = null;
  if (opts.supersession) {
    if (opts.supersession.spec === 'supersession-v1' && opts.supersession.hash) {
      // pre-built block (e.g., test fixture); re-validate to guarantee shape
      supersessionBlock = validateSupersessionBlock(opts.supersession);
    } else {
      try {
        supersessionBlock = buildSupersessionBlock(opts.supersession);
      } catch (e) {
        throw err(`supersession block failed to build: ${e.message} (valid reasons: ${SUPERSESSION_REASONS.join(', ')})`);
      }
    }
  }

  // Wave 167 (M+3) — optional embedded drift report. Caller passes
  // opts.drift_report as either (a) a pre-built validated DriftReport object,
  // (b) a filesystem path to a report.json the spec-compile layer reads, or
  // (c) skips it entirely. Embedding is opt-in: a compliance audit chain that
  // wants the drift verdict cryptographically bound into the artifact uses it;
  // a tenant who keeps drift reports as sibling files for separate review skips
  // and lets the verifier surface the absent-pass branch.
  let driftReportBlock = null;
  if (opts.drift_report) {
    if (typeof opts.drift_report === 'string') {
      try {
        driftReportBlock = loadDriftReport(opts.drift_report);
      } catch (e) {
        throw err(`drift_report path ${opts.drift_report} failed to load/validate: ${e.message}`);
      }
    } else if (opts.drift_report.spec === 'drift-report-v1' && opts.drift_report.hash) {
      driftReportBlock = validateDriftReport(opts.drift_report);
    } else {
      throw err(`drift_report must be either a file path or a pre-built validated drift-report-v1 block`);
    }
  }

  const built = await buildAndZip({
    job_id: spec.job_id,
    task: spec.task,
    base_model: spec.base_model || 'none',
    recipes,
    pack: spec.pack || null,
    index: spec.index || null,
    evals,
    training_stats: trainingStatsForBuild,
    outDir,
    license: opts.license != null ? opts.license : (spec.license || null),
    artifact_class: artifactClass,
    seed_provenance,
    compiled_targets,
    extra_files: extraFiles,
    lineage: lineageBlock,
    export: exportProvenance ? exportProvenance.export_block : null,
    moe: moeProvenance ? moeProvenance.moe_block : null,
    pretokenize: pretokenizeProvenance ? pretokenizeProvenance.pretokenize_block : null,
    external_holdout: externalHoldoutBlock,
    tenant_shadow_corpus: tenantShadowBlocks.length > 0 ? tenantShadowBlocks : null,
    auditor_attestation: auditorAttestationBlocks.length > 0 ? auditorAttestationBlocks : null,
    supersession: supersessionBlock,
    drift_report: driftReportBlock,
    allow_below_gate: opts.allow_below_gate === true || opts.allowBelowGate === true,
  });

  // W350 — once buildAndZip has produced an artifact, any post-build failure
  // (auditor cross-check, copy-to-outPath, hash) must roll back the on-disk
  // .kolm so a half-baked build does not leak into ~/.kolm/artifacts/. The
  // user-supplied opts.outPath is also rolled back to avoid a partial copy
  // looking like a real artifact in CI dirs.
  const postBuildCleanup = [built.outPath];
  let postBuildOk = false;
  let final;
  try {
  // Wave 166 — post-build cross-check: every auditor attestation that was
  // embedded MUST sign-claim the artifact_hash this build just produced. If
  // the attestation was made against an OLDER build (i.e. the tenant tried
  // to re-use last quarter's auditor sign-off on a rebuild that bumped any
  // hash-bearing input), the cross-check fails here and the build aborts.
  // The verifier (binder check #22) re-runs this same cross-check at verify
  // time so a third party gets the same guarantee.
  if (auditorAttestationBlocks.length > 0) {
    const crossManifest = {
      ...built.manifest,
      __artifact_hash: built.artifact_hash,
      __external_holdout_hash: built.manifest.external_holdout_provenance?.hash || null,
      __tenant_shadow_corpus_hash: tenantShadowBlocks.length > 0
        ? crypto.createHash('sha256').update(canonicalJsonLocal(
            tenantShadowBlocks.map(b => ({ tenant_id: b.tenant_id, corpus_id: b.corpus_id, hash: b.hash }))
          )).digest('hex')
        : null,
    };
    for (let i = 0; i < auditorAttestationBlocks.length; i++) {
      const cc = crossCheckAuditorAttestation(auditorAttestationBlocks[i], crossManifest);
      if (!cc.ok) {
        throw err(`auditor attestation ${auditorAttestationPaths[i]} (auditor_id='${auditorAttestationBlocks[i].auditor_id}') does not match this build: ${cc.reason}. The attestation was likely produced against a previous build of this artifact. Re-run \`kolm auditor sign <artifact.kolm>\` to attest the current build.`);
      }
    }
  }

  final = opts.outPath || built.outPath;
  if (final !== built.outPath) {
    // Track the destination too — if copyFileSync throws partway, the partial
    // file at `final` is a leak. The try/finally below removes it on failure.
    postBuildCleanup.push(final);
    fs.copyFileSync(built.outPath, final);
    try { fs.unlinkSync(built.outPath); } catch {}
  }
  postBuildOk = true;
  } finally {
    if (!postBuildOk) {
      for (const p of postBuildCleanup) {
        try { fs.unlinkSync(p); } catch { /* may not exist */ }
      }
    }
  }
  const bytes = fs.statSync(final).size;
  const sha = crypto.createHash('sha256').update(fs.readFileSync(final)).digest('hex');
  // evals_report surfaces honest pass/fail breakdown to callers so the CLI
  // can show "2 / 7 cases pass" + list the failing case IDs. Without this
  // the user sees a sub-gate K-score and has no idea which examples failed.
  let evals_report = null;
  if (measured && evals.cases && evals.cases.length) {
    const failing = (measured.trace || [])
      .map((t, i) => ({ id: evals.cases[i] && evals.cases[i].id, pass: t.pass, error: t.error, latency_us: t.latency_us }))
      .filter(t => !t.pass);
    evals_report = {
      total: evals.cases.length,
      passed: Math.round(measured.pass_rate_positive * evals.cases.length),
      pass_rate: measured.pass_rate_positive,
      latency_p50_us: measured.latency_p50_us,
      failing,
    };
  }

  return {
    outPath: final,
    manifest: built.manifest,
    k_score: built.k_score,
    sha256: sha,
    bytes,
    evals_report,
    distill_provenance: distillProvenance,
    export_provenance: exportProvenance,
    moe_provenance: moeProvenance,
    pretokenize_provenance: pretokenizeProvenance,
    external_holdout_provenance: externalHoldoutBlock,
    tenant_shadow_corpus_provenance: tenantShadowBlocks.length > 0 ? tenantShadowBlocks : null,
    auditor_attestation_provenance: auditorAttestationBlocks.length > 0 ? auditorAttestationBlocks : null,
  };
}
