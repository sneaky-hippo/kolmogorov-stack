// .kolm artifact packager.
//
// A `.kolm` is a signed zip containing:
//   manifest.json     - task descriptor, hashes, training stats, tier
//   recipes.json      - deterministic recipe pack (executed in a vm sandbox)
//   evals.json        - eval cases that ship inside the artifact
//   model.gguf        - base-model pointer record. v0.1 is recipe-tier so this
//                       is metadata only; the LoRA tier will resolve it to
//                       real weights at first launch.
//   lora.bin          - artifact-bound binary slot. v0.1 carries an optional
//                       behaviour pack here (KOLMPACK\x01 magic + length-
//                       prefixed UTF-8 JSON body — patterns, lookup tables,
//                       rule packs that recipes call into via `lib.pack`).
//                       The LoRA tier (v0.2+) will swap this for a real
//                       weight delta. Empty buffer when no pack is supplied.
//   index.sqlite-vec  - artifact-bound lookup slot. v0.1 carries an optional
//                       JSON lookup index (KOLMIDX\x01 magic + length-prefixed
//                       UTF-8 JSON body — keyword→recipe maps, embedded
//                       lookup tables that recipes call via `lib.index`).
//                       The retrieval tier (v0.3+) will swap this for a real
//                       sqlite-vec database. Empty buffer when no index supplied.
//   signature.sig     - HMAC chain bound to the artifact receipt
//   receipt.json      - 5-step HMAC chain, body sig, anchor list
//
// Tenant-runtime customisation: callers of runArtifact can supply a `params`
// object that recipes read via `lib.params`. The artifact does NOT embed
// tenant data — params are passed at run time, never re-signed, never
// persisted by the runtime. This lets any buyer customise an artifact for
// their use case (extra patterns, vertical-specific rules, allowlists) while
// the signed artifact stays the same byte-exact bundle the issuer published.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import archiver from 'archiver';
import { effectiveReceiptSecret, isProductionRuntime } from './env.js';
import { cidFromManifestHashes } from './cid.js';
import { buildArtifactCredential } from './provenance.js';
import { validateCapability, validateLineage } from './artifact-lineage.js';
import { validateExportBlock, EXPORT_SPEC_VERSION } from './export-provenance.js';
import { validateMoeBlock, MOE_SPEC_VERSION } from './moe-provenance.js';
import { validatePretokenizeBlock, PRETOKENIZE_SPEC_VERSION } from './pretokenize-provenance.js';
import { validateExternalHoldoutBlock, EXTERNAL_HOLDOUT_SPEC_VERSION } from './external-holdout.js';
import { validateTenantShadowBlock, TENANT_SHADOW_SPEC_VERSION } from './tenant-holdout.js';
import { validateAuditorAttestationBlock, AUDITOR_ATTESTATION_SPEC_VERSION } from './auditor-attestation.js';
import { validateSupersessionBlock, validateDriftReport, buildSupersessionBlock, buildDriftReport, SUPERSESSION_SPEC_VERSION, DRIFT_REPORT_SPEC_VERSION } from './drift-supersession.js';
import { RECIPE_CLASSES, validateRecipeClass, rollupArtifactClass, validateArtifactClass, CLASS_DESCRIPTIONS, RECIPE_SOURCE_TYPES, inferSourceType, validateRecipeSourceType } from './recipe-class.js';
import { hashIr } from './workflow-ir.js';
import { computeKScore as computeKScoreFromKscoreModule } from './kscore.js';
import { verifyAttestation, manifestBlock as ccManifestBlock, STATES as CC_STATES } from './confidential-compute.js';
import { loadSignerKeyFromEnv as loadEd25519SignerFromEnv, loadOrCreateDefaultSigner as loadEd25519DefaultSigner, buildSignatureBlock as buildEd25519Block } from './ed25519.js';
import { buildSigstoreBundle, isDisabled as isSigstoreDisabled, attestArtifactWithRekor, rekorUrl as sigstoreRekorUrl } from './sigstore.js';

const ARTIFACT_SPEC = 'kolm-1';
const PACK_MAGIC = 'KOLMPACK\x01';
const INDEX_MAGIC = 'KOLMIDX\x01';

// Artifact classes — see Wave 144 user redirect.
//   'rule'           — deterministic JS/rule artifact. No model.gguf / lora.bin
//                      / index.sqlite-vec padding when no real pack/index is
//                      supplied. This is the only class that ships today.
//   'compiled_rule'  — generated C/Rust/WASM artifact from a constrained rule
//                      AST (Wave F). Adds target/target_source_hash/target_binary_hash
//                      manifest fields.
//   'distilled_model'- real teacher->student model artifact with LoRA/quantization
//                      metadata + real weights (Wave J/K). Re-introduces
//                      model.gguf / lora.bin slots with real bytes.
// Wave 151 — RECIPE_CLASSES is the new canonical list (adds 'synthesized_rule').
// ARTIFACT_CLASSES stays as the historical export for backward compat; it now
// re-exports the full RECIPE_CLASSES list. Validators import RECIPE_CLASSES.
export const ARTIFACT_CLASSES = RECIPE_CLASSES;
const EMPTY_BUF = Buffer.alloc(0);
const EMPTY_SHA = crypto.createHash('sha256').update(EMPTY_BUF).digest('hex');

// Encode an optional behaviour pack for the lora.bin slot. Returns an empty
// Buffer when no pack is supplied so v0.1 artifacts that don't ship one are
// byte-stable with prior releases.
function encodePack(pack) {
  if (!pack || (typeof pack === 'object' && Object.keys(pack).length === 0)) return Buffer.alloc(0);
  const body = Buffer.from(JSON.stringify(pack), 'utf8');
  const head = Buffer.from(PACK_MAGIC, 'binary');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, len, body]);
}

function encodeIndex(index) {
  if (!index || (typeof index === 'object' && Object.keys(index).length === 0)) return Buffer.alloc(0);
  const body = Buffer.from(JSON.stringify(index), 'utf8');
  const head = Buffer.from(INDEX_MAGIC, 'binary');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, len, body]);
}

// Decode a pack or index buffer. Tolerates empty buffers (returns null) and
// throws on magic mismatch so a corrupt slot doesn't silently expose
// arbitrary bytes to recipes.
export function decodePack(buf) { return decodeContainer(buf, PACK_MAGIC); }
export function decodeIndex(buf) { return decodeContainer(buf, INDEX_MAGIC); }
function decodeContainer(buf, magic) {
  if (!buf || !buf.length) return null;
  if (buf.length < magic.length + 4) throw new Error('container too short');
  const head = buf.slice(0, magic.length).toString('binary');
  if (head !== magic) throw new Error(`container magic mismatch: expected ${JSON.stringify(magic)}`);
  const len = buf.readUInt32LE(magic.length);
  const body = buf.slice(magic.length + 4, magic.length + 4 + len);
  if (body.length !== len) throw new Error('container length mismatch');
  return JSON.parse(body.toString('utf8'));
}
// IMPORTANT: keep this in lock-step with router.js's RECEIPT_SECRET. The
// receipt the artifact builder seals here is verified by /v1/receipts/verify
// using that same secret — a mismatch produces "signature mismatch" + "chain
// hmac mismatch" failures even though both sides are byte-identical canonical
// JSON. The legacy KOLM_ARTIFACT_SECRET env name is still honoured for
// back-compat, but the default must match router.js's default.
let warnedMissingSignSecret = false;

function signSecret() {
  const secret = effectiveReceiptSecret({ includeLegacyArtifactSecret: true });
  if (secret) return secret;
  if (isProductionRuntime() && !warnedMissingSignSecret) {
    console.error('[artifact] WARNING: RECIPE_RECEIPT_SECRET not set - /v1/compile will 503. Set it on Railway env.');
    warnedMissingSignSecret = true;
  }
  return null;
}

function requireSignSecret() {
  const secret = signSecret();
  if (secret) return secret;
  const e = new Error('cannot build .kolm: RECIPE_RECEIPT_SECRET not set on server');
  e.statusCode = 503;
  throw e;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

// Compute the K-score — the visible scoreboard for "smallest artifact that
// still passes the tests wins." Implements the documented formula at
// /k-score: K = 0.40·A + 0.15·S + 0.15·L + 0.15·C + 0.15·V, on [0..1].
// Ship gate is 0.85; below that, kolm compile fails closed.
//
// Raw axes (kept on the manifest for downstream tooling):
//   accuracy:          verifier pass-rate on the training positives [0..1]
//   coverage:          fraction of declared task surface handled [0..1]
//   p50_latency_us:    median run-time per call
//   cost_usd_per_call: marginal $ at run-time (0 for pure-recipe)
//   size_bytes:        seal-time probe zip size (the zip before the manifest
//                      embeds the K-score itself); typically 64-100 bytes
//                      less than the final on-disk size. Stored on the
//                      manifest so K-score is deterministically recomputable
//                      from artifact bytes alone.
//
// Each non-fractional axis (S, L, C) is normalized to [0..1] via a smooth
// curve calibrated so that typical recipe-mode artifacts (~10KB, ~100us, $0)
// score near 1, and pathological cases asymptote toward 0:
//   S = max(0, 1 - log2(max(size_kb, 1)) / 30)   // 10KB->0.89, 1MB->0.67, 1GB->0.33
//   L = 1 / (1 + p50_us / 100000)                // 100us->1.0, 100ms->0.50
//   C = 1 / (1 + cost_per_call * 1000)           // $0->1.0, $0.001->0.50
// A and V are already on [0..1].
// Wave 145 — delegates to src/kscore.js so V2 axes (R/F/E/Z/T) are available
// to any caller that supplies them. V1-only callers continue to receive a v1
// envelope (auto-detected by kscore.js when no V2 inputs are present). The
// gate (0.85) and v1 weights (0.40/0.15/0.15/0.15/0.15) are unchanged, so
// every artifact built before wave 145 verifies identically.
export function computeKScore(input) {
  return computeKScoreFromKscoreModule(input);
}

// Build the artifact payload (the parts that end up *inside* the zip).
// Returns a list of {filename, content} entries plus the manifest.
//
// New in v0.1: a receipt.json file ships alongside signature.sig. The
// receipt binds (artifact_hash, eval_set_hash, eval_score, judge_id) via an
// HMAC chain so any third party can re-verify offline without trusting the
// runtime that produced the artifact.
function normalizeLicense(license) {
  if (!license) {
    return {
      id: 'LicenseRef-kolm-default-1.0',
      name: 'kolm default artifact license (1.0)',
      url: 'https://kolm.ai/license#artifact-default-1-0',
      allows: ['inference', 'evaluation', 'redistribution-with-attribution'],
      requires: ['preserve-receipt', 'preserve-attribution'],
      forbids: [],
    };
  }
  if (typeof license === 'string') {
    return { id: license, name: license, url: null, allows: [], requires: [], forbids: [] };
  }
  return {
    id: String(license.id || license.spdx || 'LicenseRef-unknown'),
    name: license.name ? String(license.name) : String(license.id || 'unknown'),
    url: license.url ? String(license.url) : null,
    allows: Array.isArray(license.allows) ? license.allows.map(String) : [],
    requires: Array.isArray(license.requires) ? license.requires.map(String) : [],
    forbids: Array.isArray(license.forbids) ? license.forbids.map(String) : [],
  };
}

export function buildPayload({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, k_score, judge_id, eval_score, tier, pack, index, target_device, train_device, license, artifact_class, seed_provenance, compiled_targets, capability, lineage, workflow_ir, attestation_report, confidential_compute, extra_files, export: exportInput, moe: moeInput, pretokenize: pretokenizeInput, external_holdout: externalHoldoutInput, tenant_shadow_corpus: tenantShadowInput, auditor_attestation: auditorAttestationInput, supersession: supersessionInput, drift_report: driftReportInput, allow_below_gate }) {
  const secret = requireSignSecret();
  // W252 — K-score ship gate is load-bearing. If a K-score is supplied AND
  // it says ships=false, the builder must refuse unless the caller explicitly
  // passes allow_below_gate=true (which gets stamped on the manifest so the
  // verifier and downstream procurement gates can flag it). Without this
  // check, the gate is a comment, not a contract.
  if (k_score && k_score.ships === false && !allow_below_gate) {
    const composite = typeof k_score.composite === 'number' ? k_score.composite : 0;
    const gate = typeof k_score.gate === 'number' ? k_score.gate : 0.85;
    throw new Error(`k_score below ship gate: composite=${composite}, gate=${gate}. ` +
      `Pass allow_below_gate=true to override; the manifest will record ship_gate_overridden=true.`);
  }
  // Default class is 'rule' — the floor. Wave 151 adds 'synthesized_rule' and
  // keeps 'compiled_rule' / 'distilled_model'. The class is load-bearing: the
  // verifier rejects any artifact whose class doesn't match what's in the zip.
  // Callers can pass artifact_class explicitly OR let the builder roll up from
  // the per-recipe classes (computed below from recipes[].class).
  const _class = artifact_class && ARTIFACT_CLASSES.includes(artifact_class) ? artifact_class : null;
  if (_class === 'compiled_rule' && !compiled_targets) {
    throw new Error('compiled_rule artifact requires compiled_targets (call spec-compile with artifact_class=compiled_rule)');
  }

  // Wave V — capability contract, lineage, workflow IR, and attestation report
  // are optional manifest blocks. Validation runs at build time so a malformed
  // block is caught here instead of at verify time. workflow_ir and
  // attestation_report ride along inside the zip as separate files so the
  // verifier can replay hashIr() / verifyAttestation() and confirm the claims.
  let capability_block = null;
  if (capability) {
    capability_block = validateCapability(capability);
  }
  let lineage_block = null;
  if (lineage) {
    lineage_block = validateLineage(lineage);
  }
  // Wave 146 — export block. The src/export-provenance.js bridge builds and
  // validates this; we re-validate here (cheap) so a caller that constructed
  // an export block by hand still gets schema-checked. The block's own short
  // hash is folded into artifact_hash_input below so any post-build mutation
  // breaks the receipt chain.
  let export_block = null;
  if (exportInput) {
    export_block = validateExportBlock(exportInput);
  }
  // Wave 147 — moe block. Same pattern as export: src/moe-provenance.js
  // bridge builds + validates; we re-validate here so a hand-rolled block
  // still gets schema-checked. The block's short hash folds into
  // artifact_hash_input below.
  let moe_block = null;
  if (moeInput) {
    moe_block = validateMoeBlock(moeInput);
  }
  // Wave 148 — pretokenize block. Same shape as moe: bridge builds + validates;
  // we re-validate so a hand-rolled block still gets schema-checked. Drift in
  // either tokens.idx or tokens.pack changes idx_file.sha256/pack_file.sha256
  // → block.hash → artifact_hash. The bundled binary files also fold into
  // extra_files_hash below for double anchoring.
  let pretokenize_block = null;
  if (pretokenizeInput) {
    pretokenize_block = validatePretokenizeBlock(pretokenizeInput);
  }
  // Wave 164 — external + adversarial holdout block. Bridge built + validated;
  // we re-validate here so hand-rolled blocks still get schema-checked. Drift
  // in any holdout's file_sha256 or recorded accuracy changes block.hash →
  // artifact_hash → every signature.
  let external_holdout_block = null;
  if (externalHoldoutInput) {
    external_holdout_block = validateExternalHoldoutBlock(externalHoldoutInput);
  }
  // Wave 165 (N+5) — tenant shadow corpus provenance. Unlike external_holdout
  // (one block per recipe, holding many holdouts), tenant_shadow is one block
  // per tenant-corpus pair, and the caller may name multiple. Stored as an
  // array of validated blocks so the verifier can re-anchor each independently.
  // The corpus bytes themselves are NEVER bundled into the .kolm (HIPAA
  // data-never-leaves-tenant) — only the {tenant_id, corpus_id, corpus_sha256,
  // accuracy, ...} fingerprint rides in the manifest.
  let tenant_shadow_blocks = null;
  if (tenantShadowInput) {
    const arr = Array.isArray(tenantShadowInput) ? tenantShadowInput : [tenantShadowInput];
    tenant_shadow_blocks = arr.map(b => validateTenantShadowBlock(b));
  }
  // Wave 166 (N+7) — third-party auditor attestation blocks. Same array shape
  // as tenant_shadow (an artifact may carry multiple auditor signatures —
  // e.g., Deloitte signed at issue time, AICPA member re-signed at procurement
  // gate). Each block is validated standalone here (schema + Ed25519 signature
  // self-consistency); cross-checking the signed claims against this artifact's
  // own manifest values happens in binder check #22 at verify time so we don't
  // need access to the just-built manifest fields during construction.
  let auditor_attestation_blocks = null;
  if (auditorAttestationInput) {
    const arr = Array.isArray(auditorAttestationInput) ? auditorAttestationInput : [auditorAttestationInput];
    auditor_attestation_blocks = arr.map(b => validateAuditorAttestationBlock(b));
  }
  // Wave 167 (M+4) — supersession block. Exactly one predecessor per artifact
  // (chains form by walking predecessor_artifact_hash recursively). Validated
  // here so a hand-rolled block still gets schema-checked; the block's short
  // hash folds into artifact_hash_input below so any post-build mutation
  // breaks the receipt chain.
  let supersession_block = null;
  if (supersessionInput) {
    // Accept either a raw input (no spec/hash — CLI passes this shape) or a
    // pre-built block (spec/hash present — programmatic callers). buildSupersessionBlock
    // is idempotent on a raw input and validates required fields; validateSupersessionBlock
    // then re-checks schema + hash so the resulting object is canonical.
    const block = supersessionInput.spec === SUPERSESSION_SPEC_VERSION
      ? supersessionInput
      : buildSupersessionBlock(supersessionInput);
    supersession_block = validateSupersessionBlock(block);
  }
  // Wave 167 (M+3) — optional embedded drift report. When present the verifier
  // re-checks its schema + hash and surfaces the verdict (within / drift /
  // breach). Embedding is opt-in: most tenants will ship drift reports as
  // sibling files rather than baking them into the manifest, but compliance-
  // sensitive deployments may want the verdict cryptographically bound.
  let drift_report_block = null;
  if (driftReportInput) {
    // Same pattern as supersession: accept raw input or pre-built block.
    // buildDriftReport demands baseline_snapshot + current_snapshot + signals
    // so callers must already have those; raw shape here means "spec/hash not yet set".
    const block = driftReportInput.spec === DRIFT_REPORT_SPEC_VERSION
      ? driftReportInput
      : buildDriftReport(driftReportInput);
    drift_report_block = validateDriftReport(block);
  }
  const workflow_ir_json = workflow_ir ? JSON.stringify(workflow_ir, null, 2) : null;
  const attestation_report_json = attestation_report ? JSON.stringify(attestation_report, null, 2) : null;
  let confidential_compute_block = null;
  if (confidential_compute) {
    if (typeof confidential_compute !== 'object') {
      throw new Error('confidential_compute must be an object (the precomputed state from verifyAttestation)');
    }
    confidential_compute_block = ccManifestBlock(confidential_compute.kind, confidential_compute);
  } else if (capability_block && capability_block.requires_confidential_compute && !attestation_report_json) {
    // Honest default: contract demands TEE but no report supplied. Emit a
    // visibly UNVERIFIED block so the verifier can fail loudly instead of
    // silently shipping an artifact with no attestation state at all.
    confidential_compute_block = ccManifestBlock(capability_block.attestation, null);
  }
  if (lineage_block && lineage_block.workflow_ir_hash && !workflow_ir_json) {
    throw new Error(`lineage claims workflow_ir_hash=${lineage_block.workflow_ir_hash} but no workflow_ir was supplied to buildPayload; the artifact would fail verification.`);
  }
  if (workflow_ir_json && lineage_block && lineage_block.workflow_ir_hash) {
    const recomputed = hashIr(workflow_ir);
    if (recomputed !== lineage_block.workflow_ir_hash) {
      throw new Error(`workflow_ir hash mismatch: lineage claims ${lineage_block.workflow_ir_hash}, supplied IR hashes to ${recomputed}`);
    }
  }
  // Wave 151 — validate each recipe's declared class (or infer if omitted).
  // The per-recipe class lives inside recipes.json so a verifier can re-check
  // it without trusting the manifest. The artifact-level class is the
  // most-permissive of the per-recipe classes (see rollupArtifactClass).
  const per_recipe_classes = recipes.map(r => {
    try {
      return validateRecipeClass(r);
    } catch (err) {
      throw new Error(`recipe ${JSON.stringify(r.id)} failed class validation: ${err.message}`);
    }
  });
  // Wave 285 — every recipe carries an honest source_type declaring HOW the
  // source was produced (hand_written / pattern_generated / llm_emitted /
  // distilled / compiled_from_dsl). The verifier rejects any class/source_type
  // mismatch at build time so a `rule` artifact can never silently ship LLM-
  // emitted source.
  const per_recipe_source_types = recipes.map((r, i) => {
    const inferred = r.source_type || inferSourceType({ ...r, class: per_recipe_classes[i] });
    const stamped = { ...r, class: per_recipe_classes[i], source_type: inferred };
    try {
      validateRecipeSourceType(stamped);
    } catch (err) {
      throw new Error(`recipe ${JSON.stringify(r.id)} failed source_type validation: ${err.message}`);
    }
    return inferred;
  });
  const recipes_json = JSON.stringify({
    spec: 'rs-1',
    n: recipes.length,
    recipes: recipes.map((r, i) => ({
      id: r.id,
      name: r.name,
      source: r.source,
      source_hash: r.source_hash,
      version_id: r.version_id,
      tags: r.tags || [],
      schema: r.schema || null,
      // Wave 151 — honest per-recipe class. One of rule / synthesized_rule /
      // compiled_rule / distilled_model. The artifact-level artifact_class
      // is the max of these. See src/recipe-class.js for definitions.
      class: per_recipe_classes[i],
      // Wave 285 — honest per-recipe source_type. One of hand_written /
      // pattern_generated / llm_emitted / distilled / compiled_from_dsl.
      // Verifiers reject any class/source_type mismatch (rule + llm_emitted
      // is rejected; synthesized_rule + pattern_generated is rejected; etc.).
      source_type: per_recipe_source_types[i],
      // Wave F — when the recipe was authored as a DSL, ship the DSL block
      // inside recipes.json so an external verifier can recompute the JS
      // source (via emitJs) AND the native.c / native.rs source (via
      // emitCompiledTargets) and confirm every hash in manifest.compiled_targets
      // matches. Recipes that arrived as raw JS get null here.
      dsl: r.dsl || null,
      // Wave 151 — teacher attribution for synthesized_rule and distilled_model.
      // null when not applicable. Verifiers cross-check against artifact_class.
      teacher_vendor: r.teacher_vendor || null,
      teacher_model: r.teacher_model || null,
      synthesized_by: r.synthesized_by || null,
    })),
  }, null, 2);

  // Pack + index slots carry optional real bytes. For 'rule' class with no
  // pack/index supplied we drop the file from the zip entirely (instead of
  // emitting an empty placeholder that pretends to be a LoRA/vector slot).
  const lora_bin = encodePack(pack);
  const index_bin = encodeIndex(index);
  const has_pack = lora_bin.length > 0;
  const has_index = index_bin.length > 0;

  // model.gguf was historically a JSON pointer record padding the zip. For
  // 'rule' class we drop it. For 'distilled_model' (future) it will hold
  // real quantized weights. For backward compat with the four shipped
  // fixtures, when base_model is set to a non-'none' value we still emit
  // the pointer record so existing artifacts that pin a base_model keep
  // their model.gguf entry on disk.
  // Wave 151 — roll up per-recipe classes into the artifact-level class.
  // The artifact_class is the MAX of recipes' classes under CLASS_RANK. An
  // explicit artifact_class arg from the caller takes precedence (allows
  // callers to pin a higher class for cross-compatibility) but must not be
  // LOWER than the rolled-up class.
  const _rolledUpClass = rollupArtifactClass(per_recipe_classes);
  const _finalClass = _class || _rolledUpClass;
  // (We don't reject downgrades here — buildPayload still produces the
  // artifact, but validateArtifactClass below would reject a misdeclared one
  // before the receipt is signed.)
  const want_model_pointer = (_finalClass === 'distilled_model') || (base_model && base_model !== 'none');
  const model_pointer = want_model_pointer ? JSON.stringify({
    spec: ARTIFACT_SPEC,
    base_model: base_model || 'Qwen/Qwen2.5-3B-Instruct',
    runtime: 'cloud',
    note: 'pointer-only artifact; weights resolved on `kolm run` first launch.',
  }, null, 2) : null;

  // evals.json — the "no eval, no compile" gate. Synthesized from the
  // user's positives at compile time; surfaced in the artifact so anyone
  // can recompute K-score by re-running them.
  const evals_obj = evals && evals.cases ? evals : {
    spec: 'rs-1-evals',
    n: 0,
    cases: [],
    notes: 'compile-time evals were not supplied; K-score uses synthesizer pass-rate only',
  };
  const evals_json = JSON.stringify(evals_obj, null, 2);
  const eval_set_hash = sha256(Buffer.from(evals_json));
  const _evalScore = (typeof eval_score === 'number')
    ? eval_score
    : (typeof evals_obj.coverage === 'number' ? evals_obj.coverage
      : (typeof training_stats?.pass_rate_positive === 'number' ? training_stats.pass_rate_positive : 0));
  const _judgeId = judge_id || process.env.KOLM_JUDGE_ID || 'kolm-pattern-synth-1';
  const _tier = tier || 'recipe';

  // CID parts always include the five canonical slots so existing verifiers
  // and the cid schema keep working. When a file is physically absent from
  // the zip (rule-class with no pack/index/model), the slot hash is the
  // sha256 of an empty buffer — an explicit "this slot intentionally has no
  // content" sentinel rather than a fake byte payload.
  const hashes = {
    model_pointer: model_pointer ? sha256(Buffer.from(model_pointer)) : EMPTY_SHA,
    recipes_json: sha256(Buffer.from(recipes_json)),
    lora_bin: has_pack ? sha256(lora_bin) : EMPTY_SHA,
    index_bin: has_index ? sha256(index_bin) : EMPTY_SHA,
    evals_json: eval_set_hash,
  };
  // Wave V — optional per-file hashes for new bundled blocks. We add them only
  // when the block is present so legacy CIDs stay byte-stable.
  if (workflow_ir_json) hashes.workflow_ir = sha256(Buffer.from(workflow_ir_json));
  if (attestation_report_json) hashes.attestation_report = sha256(Buffer.from(attestation_report_json));
  // Wave 144 — extra files (e.g. tokenizer.json) ride inside the .kolm zip.
  // Each gets a hash in manifest.hashes.extra_files keyed by filename, and the
  // canonical hash-of-extra-files folds into artifact_hash_input so tampering
  // breaks the receipt chain. Filenames sort for determinism.
  const extra_files_list = Array.isArray(extra_files) ? extra_files.slice() : [];
  if (extra_files_list.length) {
    const map = {};
    const sorted = extra_files_list.slice().sort((a, b) => a.filename.localeCompare(b.filename));
    for (const f of sorted) {
      if (!f || typeof f.filename !== 'string' || !Buffer.isBuffer(f.content)) {
        throw new Error('extra_files entries must be { filename:string, content:Buffer }');
      }
      map[f.filename] = sha256(f.content);
    }
    hashes.extra_files = map;
  }
  // Deterministic content-id over the per-file hashes — independent of the
  // K-score, signature, or receipt. Same content always produces the same
  // CID, even across signing key rotations.
  const cid = cidFromManifestHashes(hashes);

  // Honest seed provenance block. Always present in the manifest so the
  // verifier can branch on shape. When the compile path did NOT split seeds
  // (legacy/hardcoded-evals path) `eval_source` is 'self_generated' and the
  // verifier downgrades the artifact to 'sample_check' regardless of the
  // K-score — see verifier.js (Wave D).
  const seed_provenance_block = seed_provenance ? {
    seeds_hash: seed_provenance.seeds_hash,
    split_seed: seed_provenance.split_seed,
    holdout_ratio: seed_provenance.holdout_ratio,
    train_hash: seed_provenance.train_hash,
    holdout_hash: seed_provenance.holdout_hash,
    train_count: seed_provenance.train_count,
    holdout_count: seed_provenance.holdout_count,
    eval_source: seed_provenance.eval_source || 'unknown',
    leakage_report_hash: seed_provenance.leakage_report_hash || null,
    comparator: seed_provenance.comparator || 'exact',
    source_format_mix: seed_provenance.source_format_mix || null,
    seeds_path_basename: seed_provenance.seeds_path_basename || null,
    production_ready: seed_provenance.production_ready === true,
    min_train: typeof seed_provenance.min_train === 'number' ? seed_provenance.min_train : null,
    min_holdout: typeof seed_provenance.min_holdout === 'number' ? seed_provenance.min_holdout : null,
    input_overlap_count: typeof seed_provenance.input_overlap_count === 'number' ? seed_provenance.input_overlap_count : null,
    output_overlap_count: typeof seed_provenance.output_overlap_count === 'number' ? seed_provenance.output_overlap_count : null,
    near_duplicate_count: typeof seed_provenance.near_duplicate_count === 'number' ? seed_provenance.near_duplicate_count : null,
    grouped_overlap_count: typeof seed_provenance.grouped_overlap_count === 'number' ? seed_provenance.grouped_overlap_count : null,
    // Wave 283 — hash of the rows the teacher actually received. When the
    // policy held (train-only synthesis) this equals train_hash; the
    // verifier (and an external auditor) reads this to confirm no holdout
    // leaked into recipe construction.
    synthesis_input_hash: typeof seed_provenance.synthesis_input_hash === 'string' ? seed_provenance.synthesis_input_hash : null,
    // Wave 284 — when group-aware splitting was requested, this records
    // which row-metadata key was used to define a "group" so two rows
    // about the same member / claim / case never straddle the split.
    group_key: typeof seed_provenance.group_key === 'string' ? seed_provenance.group_key : null,
  } : {
    seeds_hash: null,
    split_seed: null,
    holdout_ratio: null,
    train_hash: null,
    holdout_hash: null,
    train_count: 0,
    holdout_count: 0,
    eval_source: 'self_generated',
    leakage_report_hash: null,
    comparator: 'exact',
    source_format_mix: null,
    seeds_path_basename: null,
    production_ready: false,
    min_train: null,
    min_holdout: null,
    input_overlap_count: null,
    output_overlap_count: null,
    near_duplicate_count: null,
    grouped_overlap_count: null,
    synthesis_input_hash: null,
    group_key: null,
  };

  // Compiled-targets manifest block. Only present for compiled_rule artifacts.
  // The source bodies themselves live on disk as native.c / native.rs entries
  // in the zip (added to `files` below). The manifest carries the hashes so a
  // verifier can recompute them from recipes_json.dsl + emitCompiledTargets
  // and confirm every byte matches.
  //
  // Wave G — when the caller also supplies `compiled_targets.native`
  // (produced by src/native-compile.js when a toolchain is present), each
  // recipe entry gains a `c.bin` / `rust.bin` sub-block recording compiler
  // version, flags, and bin_hash; the binary files are appended to the zip.
  // Absence of `.native` is the JS-rule fallback — manifest stays
  // source-only and verification works without any toolchain.
  let compiled_targets_block = null;
  let compiled_target_files = [];
  if (_finalClass === 'compiled_rule' && compiled_targets) {
    const native = compiled_targets.native || null;
    const out = {
      spec: compiled_targets.spec,
      single_recipe: compiled_targets.single_recipe,
      targets: compiled_targets.targets,
      recipes: {},
    };
    if (native) {
      out.native_spec = native.bundle.spec;
      out.host_triple = native.bundle.host_triple;
      // Wave 153 — bundle-level toolchain pin record. One pin per kind (c,
      // rust) capturing compiler + version + shim hash + source_date_epoch.
      // The receipt chain absorbs this via compiled_targets_hash; product
      // surfaces (binder PDF, /spec/rs-1, /how-it-works) read it to display
      // "this compiled_rule artifact was built with rustc X / gcc Y."
      if (native.bundle.target_toolchain_pin && Object.keys(native.bundle.target_toolchain_pin).length) {
        out.target_toolchain_pin = native.bundle.target_toolchain_pin;
      }
      if (native.bundle.skipped && Object.keys(native.bundle.skipped).length) {
        out.native_skipped = native.bundle.skipped;
      }
    }
    for (const rid of Object.keys(compiled_targets.recipes)) {
      const t = compiled_targets.recipes[rid];
      const recipeBlock = {
        c: { filename: t.c.filename, source_hash: t.c.source_hash, bytes: t.c.bytes },
        rust: { filename: t.rust.filename, source_hash: t.rust.source_hash, bytes: t.rust.bytes },
      };
      if (native && native.bundle.recipes[rid]) {
        const nr = native.bundle.recipes[rid];
        if (nr.c) recipeBlock.c.bin = nr.c;
        else if (nr.c_error) recipeBlock.c.bin_error = nr.c_error;
        if (nr.rust) recipeBlock.rust.bin = nr.rust;
        else if (nr.rust_error) recipeBlock.rust.bin_error = nr.rust_error;
        // Wave 155 §P+3 — WASM lands as its own sub-block. Unlike c/rust the
        // wasm block does not carry its own source file (it reuses whichever
        // c/rust source was used); the bin is the only new artifact.
        if (nr.wasm) recipeBlock.wasm = { bin: nr.wasm };
        else if (nr.wasm_error) recipeBlock.wasm = { bin_error: nr.wasm_error };
      }
      out.recipes[rid] = recipeBlock;
      compiled_target_files.push({ filename: t.c.filename, content: Buffer.from(t.c.source, 'utf8') });
      compiled_target_files.push({ filename: t.rust.filename, content: Buffer.from(t.rust.source, 'utf8') });
    }
    if (native) {
      for (const f of native.files) compiled_target_files.push(f);
    }
    compiled_targets_block = out;
  }

  const manifest = {
    spec: ARTIFACT_SPEC,
    job_id,
    task,
    created_at: new Date().toISOString(),
    runtime: 'cloud',  // becomes 'on-device' once Sprint 3 LoRA bridge ships
    artifact_class: _finalClass,
    // Wave 151 — per-class recipe count surfaces "we have 6 rule recipes and
    // 1 distilled-model recipe" without forcing readers to parse recipes.json.
    artifact_class_breakdown: per_recipe_classes.reduce((acc, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {}),
    base_model: base_model || 'Qwen/Qwen2.5-3B-Instruct',
    target_device: target_device || null,
    train_device: train_device || null,
    tier: _tier,
    judge_id: _judgeId,
    eval_score: Number(Math.max(0, Math.min(1, _evalScore)).toFixed(4)),
    recipes: {
      n: recipes.length,
      registry_hash: sha256(canonicalJson(recipes.map(r => ({ id: r.id, hash: r.source_hash })))),
    },
    lora: lora_pointer || null,
    recall: recall_namespace ? { namespace: recall_namespace } : null,
    // Wave 151 — when the rolled-up class is synthesized_rule or distilled_model,
    // teacher attribution from the per-recipe shape must be promoted into the
    // manifest.training block so validateArtifactClass passes. The verifier
    // reads training.teacher_vendor / teacher_model / synthesized_by; a tenant
    // who only set them per-recipe gets them rolled up automatically here so
    // they do not have to repeat themselves in `training_stats`.
    training: (() => {
      const t = { ...(training_stats || { distilled_pairs: 0, accuracy: null }) };
      if (!t.teacher_vendor) {
        const tv = recipes.find(r => r.teacher_vendor)?.teacher_vendor;
        if (tv) t.teacher_vendor = tv;
      }
      if (!t.teacher_model) {
        const tm = recipes.find(r => r.teacher_model)?.teacher_model;
        if (tm) t.teacher_model = tm;
      }
      if (!t.synthesized_by) {
        const sb = recipes.find(r => r.synthesized_by)?.synthesized_by;
        if (sb) t.synthesized_by = sb;
      }
      return t;
    })(),
    evals: { n: evals_obj.n || (evals_obj.cases?.length || 0), spec: evals_obj.spec, hash: eval_set_hash },
    seed_provenance: seed_provenance_block,
    compiled_targets: compiled_targets_block,
    capability: capability_block,
    lineage: lineage_block,
    export: export_block,
    moe: moe_block,
    pretokenize: pretokenize_block,
    external_holdout_provenance: external_holdout_block,
    tenant_shadow_corpus_provenance: tenant_shadow_blocks,
    auditor_attestation_provenance: auditor_attestation_blocks,
    supersession_provenance: supersession_block,
    drift_report: drift_report_block,
    confidential_compute: confidential_compute_block,
    k_score: k_score || null,  // patched after zipping for the size_bytes axis
    ship_gate_overridden: allow_below_gate === true ? true : undefined,
    license: normalizeLicense(license),
    // Wave 161 (Q+8) — signature policy. Every modern artifact ships with
    // Ed25519 by default (Wave 149); the policy field records this stance so
    // a verifier (or a downstream tenant procurement gate) can REJECT an
    // HMAC-only re-issuance of the same task. Default true unless Ed25519 is
    // explicitly disabled at build time (KOLM_ED25519_DISABLE=1) or the
    // tenant has explicitly opted out of policy enforcement
    // (KOLM_POLICY_OPT_OUT=1). The matching binder check #17 reads this
    // field PLUS the verifier-side env KOLM_REQUIRE_ED25519=1 — either side
    // can demand Ed25519; both sides false means HMAC-only is acceptable.
    //
    // Wave 162 (Q+9) — Rekor transparency policy. Sigstore is dry-run by
    // default (Wave 150 emits a structurally-valid bundle that verifies
    // offline, but is not pinned to a public transparency log). Setting
    // KOLM_REKOR_REQUIRE=1 at build time flips this to a CONTRACT — the
    // build will fail unless KOLM_SIGSTORE_REKOR_URL is set AND the Rekor
    // submission succeeds. Default false because Rekor pinning needs
    // network egress; most builds are offline by design. The matching
    // binder check #18 reads this field PLUS env KOLM_REQUIRE_REKOR=1 —
    // either side can demand a pinned bundle; both sides false means a
    // dry-run sigstore block is acceptable.
    policy: {
      require_ed25519: process.env.KOLM_ED25519_DISABLE !== '1'
        && process.env.KOLM_POLICY_OPT_OUT !== '1',
      require_rekor: process.env.KOLM_REKOR_REQUIRE === '1'
        && process.env.KOLM_POLICY_OPT_OUT !== '1',
    },
    cid,
    hashes,
  };
  // Wave 151 — validate the rolled-up artifact_class against the manifest
  // contents. A `distilled_model` claim with no weights, a `compiled_rule`
  // claim with no compiled_targets, or a `synthesized_rule` claim with no
  // teacher attribution all throw here, before the receipt is signed.
  const classCheck = validateArtifactClass(manifest);
  if (!classCheck.ok) {
    throw new Error(`artifact class validation failed: ${classCheck.reason}`);
  }
  const manifest_json = JSON.stringify(manifest, null, 2);
  const manifest_hash = sha256(Buffer.from(manifest_json));

  // The artifact_hash is the sha256 of the canonical join of every file
  // we are about to put in the zip (excluding signature.sig and receipt.json
  // which seal it). Computing it here lets the receipt bind to the artifact
  // *before* the zip is finalised, while the manifest_hash anchors the
  // legacy signature.sig.
  //
  // Wave F — compiled_rule artifacts add a `compiled_targets_hash` field over
  // the canonical compiled_targets manifest block (per-recipe filename +
  // source_hash + bytes). The field is omitted for non-compiled artifacts so
  // existing CIDs and artifact_hashes stay byte-stable.
  const artifact_hash_input = {
    manifest_hash,
    model_pointer_hash: manifest.hashes.model_pointer,
    recipes_json_hash: manifest.hashes.recipes_json,
    lora_bin_hash: manifest.hashes.lora_bin,
    index_bin_hash: manifest.hashes.index_bin,
    evals_json_hash: eval_set_hash,
  };
  if (compiled_targets_block) {
    artifact_hash_input.compiled_targets_hash = sha256(canonicalJson(compiled_targets_block));
  }
  // Wave V — bind capability/lineage/IR/attestation into the artifact hash so
  // tampering with any of them after seal-time breaks the receipt chain.
  if (capability_block) {
    artifact_hash_input.capability_hash = capability_block.hash;
  }
  if (lineage_block) {
    artifact_hash_input.lineage_hash = lineage_block.hash;
  }
  // Wave 146 — bind export block into artifact_hash. The block's hash is the
  // short hash over its own canonical contents (see export-provenance.js
  // buildExportBlock); tamper with any target sha256, the block hash drifts,
  // the artifact hash drifts, the receipt chain breaks.
  if (export_block) {
    artifact_hash_input.export_hash = export_block.hash;
  }
  // Wave 147 — bind moe block into artifact_hash. Same drift-propagation as
  // export: tamper any expert sha256, the moe block hash drifts, the
  // artifact hash drifts, the receipt chain breaks. The bundled expert
  // files themselves also folded into extra_files_hash below for double
  // anchoring.
  if (moe_block) {
    artifact_hash_input.moe_hash = moe_block.hash;
  }
  // Wave 148 — bind pretokenize block into artifact_hash. Same drift-
  // propagation as moe/export: tamper either binary, the file's sha256 drifts,
  // the block hash drifts, the artifact hash drifts, the receipt chain breaks.
  if (pretokenize_block) {
    artifact_hash_input.pretokenize_hash = pretokenize_block.hash;
  }
  // Wave 164 — bind external/adversarial holdout block into artifact_hash.
  // Tamper with any holdout's file_sha256, normalized_hash, or recorded
  // accuracy: the block hash drifts, the artifact hash drifts, every
  // signature breaks. The holdout JSONLs themselves live under repo root
  // (holdouts/<kind>/<name>.jsonl), not inside the .kolm zip, because they
  // are independent corpora that a third party can re-download and re-anchor
  // against catalog.json's expected_sha256.
  if (external_holdout_block) {
    artifact_hash_input.external_holdout_hash = external_holdout_block.hash;
  }
  // Wave 165 — bind tenant shadow corpus blocks into artifact_hash. Hash
  // over the canonical ordered array of per-corpus block hashes so any
  // post-build mutation (added corpus, dropped corpus, swapped corpus_sha256,
  // edited accuracy) breaks the receipt chain. The hash binds only the
  // fingerprint, never the corpus bytes — those stay on tenant storage.
  if (tenant_shadow_blocks && tenant_shadow_blocks.length > 0) {
    artifact_hash_input.tenant_shadow_corpus_hash = sha256(canonicalJson(
      tenant_shadow_blocks.map(b => ({ tenant_id: b.tenant_id, corpus_id: b.corpus_id, hash: b.hash }))
    ));
  }
  // Wave 166 (N+7) — bind auditor attestation blocks into artifact_hash. Hash
  // over the canonical ordered array of per-block {auditor_id, key_fingerprint,
  // hash} tuples so any post-build mutation (added attestation, dropped one,
  // swapped signature, edited claimed eval_score) breaks the receipt chain.
  // The auditor's Ed25519 signature inside each block is the third-party
  // anchor; THIS artifact_hash binding is what stops a tamperer from quietly
  // removing an attestation after the fact.
  if (auditor_attestation_blocks && auditor_attestation_blocks.length > 0) {
    artifact_hash_input.auditor_attestation_hash = sha256(canonicalJson(
      auditor_attestation_blocks.map(b => ({ auditor_id: b.auditor_id, key_fingerprint: b.key_fingerprint, hash: b.hash }))
    ));
  }
  // Wave 167 (M+4) — bind supersession block into artifact_hash via the
  // block's own short hash. Tamper with predecessor_artifact_hash, reason,
  // supersession_date, drift_signals, etc.: the block hash drifts → artifact
  // hash drifts → every downstream signature breaks. This is what makes the
  // supersession chain auditable end-to-end: a verifier walking from any
  // artifact back to its genesis can confirm every successor was legitimately
  // signed against the predecessor it claims to replace.
  if (supersession_block) {
    artifact_hash_input.supersession_hash = supersession_block.hash;
  }
  // Wave 167 (M+3) — bind drift report into artifact_hash. Same pattern as
  // supersession: tamper the verdict, the breach_count, any signal value, and
  // the block hash drifts → artifact hash drifts → all signatures break.
  if (drift_report_block) {
    artifact_hash_input.drift_report_hash = drift_report_block.hash;
  }
  if (workflow_ir_json) {
    artifact_hash_input.workflow_ir_hash = manifest.hashes.workflow_ir;
  }
  if (attestation_report_json) {
    artifact_hash_input.attestation_report_hash = manifest.hashes.attestation_report;
  }
  if (confidential_compute_block) {
    artifact_hash_input.confidential_compute_hash = sha256(canonicalJson(confidential_compute_block));
  }
  if (hashes.extra_files) {
    artifact_hash_input.extra_files_hash = sha256(canonicalJson(hashes.extra_files));
  }
  const artifact_hash = sha256(canonicalJson(artifact_hash_input));

  // Build the HMAC chain. Each step seals the previous step's output.
  const stepSeal = (step, input_hash, output_hash) => {
    const hmac = crypto.createHmac('sha256', secret)
      .update(canonicalJson({ step, input_hash, output_hash }))
      .digest('hex');
    return { step, input_hash, output_hash, hmac };
  };
  const taskHash = sha256(canonicalJson({ task: task || '' }));
  // The 'seeds' step in the chain MUST bind to a real seeds_hash when a seed
  // split was performed. Falling back to a hash of training_stats (the
  // pre-Wave-144 behavior) made the step content-free and broke the receipt
  // chain's purpose. Honest fallback when no seed split happened: hash of
  // the (now explicit) self_generated provenance block, so a verifier can
  // tell at-a-glance that the artifact didn't use a real seed gate.
  const seedsHash = seed_provenance && seed_provenance.seeds_hash
    ? seed_provenance.seeds_hash
    : sha256(canonicalJson({ eval_source: 'self_generated', training: training_stats || null }));
  const recipesHash = manifest.hashes.recipes_json;
  const evalsHash = eval_set_hash;
  const chain = [
    stepSeal('task',    sha256(canonicalJson({ spec: ARTIFACT_SPEC })), taskHash),
    stepSeal('seeds',   taskHash,    seedsHash),
    stepSeal('recipes', seedsHash,   recipesHash),
    stepSeal('evals',   recipesHash, evalsHash),
    stepSeal('package', evalsHash,   artifact_hash),
  ];

  // Receipt body — bound by the HMAC over (artifact_hash, eval_set_hash,
  // eval_score, judge_id, chain). The signed_by field identifies the current
  // HMAC key namespace; future asymmetric signatures should use a new
  // signature_alg value. Verifiers re-check both the chain and the body HMAC.
  const issued_at = new Date().toISOString();
  const receipt_id = crypto.randomUUID();
  const receiptBody = {
    kolm_version: '0.1',
    receipt_id,
    cid,
    artifact_hash,
    eval_set_hash,
    eval_score: manifest.eval_score,
    judge_id: _judgeId,
    tier: _tier,
    chain,
    anchors: [],
  };

  // Wave 149 — Ed25519 is now the DEFAULT signature alg.
  //
  // Prior to Wave 149 the Ed25519 block only appeared when
  // `KOLM_ED25519_PRIVATE_KEY` was explicitly set. Per the Wave 144 plan
  // §Q+8 the HMAC-only path was downgraded to an integrity check; the
  // third-party-verifiable signature has to be the default.
  // `loadEd25519DefaultSigner()` (a) prefers the env-var key when present,
  // (b) falls back to a per-machine cached key at ~/.kolm/signing-key.pem
  // (generated on first build, persists across subsequent builds so the
  // fingerprint is stable). Set `KOLM_ED25519_DISABLE=1` for legacy
  // HMAC-only signing.
  //
  // Field order MUST be: load signer → set signature_alg + signed_by →
  // compute HMAC over the upgraded body → add HMAC `signature` field →
  // compute Ed25519 over canonical(body INCLUDING HMAC signature) → add
  // `signature_ed25519` block. The verifier strips `signature_ed25519`
  // and `signature` independently and re-canonicalizes both.
  let ed25519Signer = null;
  try {
    ed25519Signer = loadEd25519DefaultSigner();
  } catch (e) {
    console.error(`[artifact] WARNING: ed25519 signer load skipped: ${e.message}`);
  }
  // Wave 150 — sigstore (cosign-compatible) bundle is layered on top of
  // Ed25519 when both the Ed25519 signer is present AND sigstore is not
  // explicitly disabled. signature_alg upgrades to reflect every active
  // signature scheme so verifiers can quickly decide which checks apply.
  const sigstoreEnabled = ed25519Signer && !isSigstoreDisabled();
  if (sigstoreEnabled) {
    receiptBody.signature_alg = 'sigstore+ed25519+hmac-sha256';
    receiptBody.signed_at = issued_at;
    receiptBody.signed_by = `ed25519:${ed25519Signer.key_fingerprint}`;
  } else if (ed25519Signer) {
    receiptBody.signature_alg = 'ed25519+hmac-sha256';
    receiptBody.signed_at = issued_at;
    receiptBody.signed_by = `ed25519:${ed25519Signer.key_fingerprint}`;
  } else {
    receiptBody.signature_alg = 'hmac-sha256';
    receiptBody.signed_at = issued_at;
    receiptBody.signed_by = 'kolm-dev-hmac-1';
  }

  const bodyCanon = canonicalJson(receiptBody);
  const bodySig = crypto.createHmac('sha256', secret).update(bodyCanon).digest('hex');
  receiptBody.signature = bodySig;

  if (ed25519Signer) {
    try {
      const ed25519Payload = canonicalJson(receiptBody);
      receiptBody.signature_ed25519 = buildEd25519Block({
        privateKey: ed25519Signer.privateKey,
        publicKey: ed25519Signer.publicKey,
        key_fingerprint: ed25519Signer.key_fingerprint,
        payloadCanonical: ed25519Payload,
        signed_at: issued_at,
      });
    } catch (e) {
      console.error(`[artifact] WARNING: ed25519 sign skipped: ${e.message}`);
    }
  }

  // Wave 150 — sigstore layer. Always dry-run-by-default at build time
  // (KOLM_SIGSTORE_REKOR_URL not consulted here because that's an async
  // network call; `kolm sigstore-attest` upgrades to a Rekor-pinned bundle
  // post-build). The bundle still verifies offline against the embedded
  // Ed25519 public key, so even a dry-run block is structurally useful.
  if (sigstoreEnabled) {
    try {
      const sigstorePayload = canonicalJson(receiptBody);
      receiptBody.signature_sigstore = buildSigstoreBundle({
        privateKey: ed25519Signer.privateKey,
        publicKey: ed25519Signer.publicKey,
        key_fingerprint: ed25519Signer.key_fingerprint,
        payloadCanonical: sigstorePayload,
        signed_at: issued_at,
      });
    } catch (e) {
      console.error(`[artifact] WARNING: sigstore bundle skipped: ${e.message}`);
    }
  }

  const receipt_json = JSON.stringify(receiptBody, null, 2);

  // Legacy signature.sig — kept for back-compat with v0 verifiers. The new
  // receipt.json supersedes it.
  const sig_payload = canonicalJson({
    spec: ARTIFACT_SPEC,
    manifest_hash,
    job_id,
    artifact_hash,
    eval_set_hash,
    eval_score: manifest.eval_score,
    judge_id: _judgeId,
  });
  const hmac = crypto.createHmac('sha256', secret).update(sig_payload).digest('hex');
  const signature = JSON.stringify({
    spec: ARTIFACT_SPEC,
    job_id,
    manifest_hash,
    artifact_hash,
    eval_set_hash,
    eval_score: manifest.eval_score,
    judge_id: _judgeId,
    hmac_alg: 'HMAC-SHA256',
    hmac,
    issued_at,
  }, null, 2);

  // Build an artifact-scoped provenance credential. Signed with the same
  // secret as the receipt chain. Shipped as a sidecar `credential.json` in
  // the zip (not embedded in receipt.json — receipt.json is already signed,
  // and we don't want to invalidate that signature).
  const credential = buildArtifactCredential({
    secret,
    artifact_hash,
    cid,
    k_score: manifest.k_score ?? null,
    base_model,
    signed_at: issued_at,
    judge_id: _judgeId,
    tier: _tier,
    ingredients: [],
  });
  const credential_json = JSON.stringify(credential, null, 2);

  // Physically drop padding entries when there is no real content. Loader
  // (artifact-runner.js) already tolerates missing optional files. The
  // manifest.hashes object still records EMPTY_SHA for absent slots so the
  // CID computation and any external integrity scanner sees a consistent
  // schema. Honest "this slot is empty" beats fake "this slot contains an
  // empty placeholder pretending to be a model."
  const files = [
    { filename: 'manifest.json',    content: Buffer.from(manifest_json) },
    { filename: 'recipes.json',     content: Buffer.from(recipes_json) },
    { filename: 'evals.json',       content: Buffer.from(evals_json) },
    { filename: 'signature.sig',    content: Buffer.from(signature) },
    { filename: 'receipt.json',     content: Buffer.from(receipt_json) },
    { filename: 'credential.json',  content: Buffer.from(credential_json) },
  ];
  if (model_pointer != null) files.push({ filename: 'model.gguf', content: Buffer.from(model_pointer) });
  if (has_pack) files.push({ filename: 'lora.bin', content: lora_bin });
  if (has_index) files.push({ filename: 'index.sqlite-vec', content: index_bin });
  // Wave F — emit the C and Rust sources for compiled_rule artifacts. They
  // are the source-of-truth the verifier rebuilds against. Wave G adds the
  // compiled binary alongside (target binary hash also enters the manifest).
  for (const f of compiled_target_files) files.push(f);
  // Wave V — emit workflow_ir.json and attestation_report.json so the verifier
  // can replay hashIr() / verifyAttestation() instead of trusting the manifest
  // claim. A claim without bundled evidence is treated as fail by binder.js.
  if (workflow_ir_json) files.push({ filename: 'workflow_ir.json', content: Buffer.from(workflow_ir_json) });
  if (attestation_report_json) files.push({ filename: 'attestation_report.json', content: Buffer.from(attestation_report_json) });
  // Wave 144 — append extra files (e.g. tokenizer.json) last so they don't
  // shift offsets of the load-bearing files above. Filename collisions with
  // the reserved set would silently shadow; we guard here.
  const RESERVED_FILENAMES = new Set(['manifest.json', 'recipes.json', 'signature.sig', 'evals.json', 'receipt.json', 'credential.json', 'model.gguf', 'lora.bin', 'index.sqlite-vec', 'workflow_ir.json', 'attestation_report.json']);
  for (const f of extra_files_list) {
    if (RESERVED_FILENAMES.has(f.filename)) {
      throw new Error(`extra_files: filename '${f.filename}' is reserved`);
    }
    files.push({ filename: f.filename, content: f.content });
  }

  return {
    manifest,
    receipt: receiptBody,
    credential,
    artifact_hash,
    cid,
    eval_set_hash,
    files,
  };
}

// Stream the .kolm zip to a writable target (file path or HTTP response).
export function packageArtifact({ job_id, payload, outPath }) {
  return new Promise((resolve, reject) => {
    const target = outPath
      ? fs.createWriteStream(outPath)
      : null;
    const z = archiver('zip', { zlib: { level: 9 } });
    if (target) {
      z.pipe(target);
      target.on('close', () => resolve({ bytes: z.pointer() }));
    }
    z.on('warning', (e) => { if (e.code !== 'ENOENT') reject(e); });
    z.on('error', reject);
    for (const f of payload.files) {
      z.append(f.content, { name: f.filename });
    }
    z.finalize();
    if (!target) {
      // caller will pipe z elsewhere
      resolve({ archive: z });
    }
  });
}

// Convenience: build + zip in one step. Returns the zip path.
//
// We zip twice when k_score is requested: once to measure size, then again
// with the size-aware K-score patched into the manifest. The double-zip is
// cheap (≤10ms for 5KB artifacts) and keeps the K-score honest — the size
// axis includes the K-score bytes themselves.
export async function buildAndZip({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, outDir, judge_id, tier, pack, index, target_device, train_device, license, artifact_class, seed_provenance, compiled_targets, capability, lineage, workflow_ir, attestation_report, extra_files, export: exportInput, moe: moeInput, pretokenize: pretokenizeInput, external_holdout: externalHoldoutInput, tenant_shadow_corpus: tenantShadowInput, auditor_attestation: auditorAttestationInput, supersession: supersessionInput, drift_report: driftReportInput, allow_below_gate }) {
  requireSignSecret();
  const dir = outDir || path.join(os.tmpdir(), 'kolm-artifacts');
  fs.mkdirSync(dir, { recursive: true });

  // Derive eval_score from the synthesis result. Pattern-mode synthesis
  // returns pass_rate_positive in [0..1]; the artifact tier defaults to
  // "recipe" (the only tier the Sprint-1 toolchain produces today —
  // adapter/specialist/bundle land in later sprints).
  const accuracy = training_stats?.pass_rate_positive ?? (training_stats?.verifier_accepted ? 1.0 : 0.0);
  const coverage = evals && evals.coverage != null ? evals.coverage : accuracy;
  const eval_score = (evals && typeof evals.coverage === 'number') ? evals.coverage : accuracy;
  const _tier = tier || 'recipe';
  const _judgeId = judge_id || process.env.KOLM_JUDGE_ID || 'kolm-pattern-synth-1';

  // Wave V — when an attestation_report is supplied, run the verifier here
  // (async) and pass the resulting state into the sync buildPayload as
  // confidential_compute. The kind comes from the capability block when the
  // contract demands TEE; otherwise the caller must pre-supply a kind via
  // attestation_report.kind (used only as a hint to verifyAttestation).
  let confidential_compute = null;
  if (attestation_report) {
    const kind = capability?.attestation || attestation_report._kind || attestation_report.kind || null;
    if (!kind) {
      throw new Error('attestation_report supplied without an attestation kind (set capability.attestation or attestation_report._kind)');
    }
    confidential_compute = await verifyAttestation(kind, attestation_report);
  }

  const sharedBlocks = { capability, lineage, workflow_ir, attestation_report, confidential_compute, extra_files, export: exportInput, moe: moeInput, pretokenize: pretokenizeInput, external_holdout: externalHoldoutInput, tenant_shadow_corpus: tenantShadowInput, auditor_attestation: auditorAttestationInput, supersession: supersessionInput, drift_report: driftReportInput, allow_below_gate };

  // Pass 1 — zip to measure size.
  const probePayload = buildPayload({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, judge_id: _judgeId, eval_score, tier: _tier, pack, index, target_device, train_device, license, artifact_class, seed_provenance, compiled_targets, ...sharedBlocks });
  const outPath = path.join(dir, `${job_id}.kolm`);
  await packageArtifact({ job_id, payload: probePayload, outPath });
  const probeBytes = fs.statSync(outPath).size;

  // K-score: derive accuracy/coverage/latency/cost from training stats and
  // any supplied evals. For Sprint 1 stub: pure-recipe artifacts have
  // cost=0 (no run-time API calls), latency = compiled-fn p50 ~50us, and
  // accuracy = synthesizer pass-rate. Coverage starts at the eval count
  // ratio; if no evals supplied, it equals accuracy (best-effort).
  //
  // Wave 145 — also passes optional V2 axes when training_stats carries them.
  // The distill-provenance bridge surfaces teacher_holdout_accuracy +
  // holdout_accuracy from the worker manifest, which makes the K-score
  // emit a v2 envelope with R + T axes (student-on-holdout / teacher-on-
  // holdout fidelity). v1-only callers continue to get a v1 envelope.
  const k_score = computeKScore({
    size_bytes: probeBytes,
    accuracy,
    coverage,
    p50_latency_us: training_stats?.latency_p50_us ?? 50,
    cost_usd_per_call: training_stats?.cost_usd_per_call ?? 0,
    holdout_accuracy: training_stats?.holdout_accuracy ?? null,
    teacher_holdout_accuracy: training_stats?.teacher_holdout_accuracy ?? null,
    subgroup_min_accuracy: training_stats?.subgroup_min_accuracy ?? null,
    joules_per_call: training_stats?.joules_per_call ?? null,
    eval_set_drift: training_stats?.eval_set_drift ?? null,
  });

  // Pass 2 — repackage with the K-score in the manifest. The K-score size
  // axis reflects the probe zip size (Pass 1); the final zip is typically
  // 64-100 bytes larger because the manifest now embeds the K-score JSON.
  // We do NOT mutate the manifest after writing — the returned manifest is
  // exactly what's inside the on-disk artifact, so a verifier recomputing
  // K-score from the artifact bytes will reproduce manifest.k_score
  // deterministically (size_bytes axis matches the embedded value).
  const finalPayload = buildPayload({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, k_score, judge_id: _judgeId, eval_score, tier: _tier, pack, index, target_device, train_device, license, artifact_class, seed_provenance, compiled_targets, ...sharedBlocks });
  await packageArtifact({ job_id, payload: finalPayload, outPath });

  // Wave 162 (Q+9) — opportunistic Rekor pinning. The build is sync; the
  // sigstore block emitted inside buildPayload is dry-run by design. When
  // KOLM_SIGSTORE_REKOR_URL is set, post the bundle's digest+sig+pubkey to
  // that Rekor instance now (async, post-zip) and rewrite the artifact in
  // place with the pinned bundle. If manifest.policy.require_rekor=true and
  // the submission fails, the build fails — that's the contract. Otherwise
  // log a warning and proceed with the dry-run artifact (the artifact is
  // still structurally valid + locally verifiable; the user can rerun
  // `kolm sigstore-attest <artifact>` later).
  let rekorAttestation = null;
  const requiresRekor = !!finalPayload.manifest.policy?.require_rekor;
  const hasRekorUrl = !!sigstoreRekorUrl();
  const sigstorePresent = !!finalPayload.receipt.signature_sigstore;
  if (sigstorePresent && (hasRekorUrl || requiresRekor)) {
    if (!hasRekorUrl && requiresRekor) {
      throw new Error('policy.require_rekor=true but KOLM_SIGSTORE_REKOR_URL is unset — cannot pin sigstore bundle to a transparency log');
    }
    try {
      rekorAttestation = await attestArtifactWithRekor(outPath);
      finalPayload.receipt.signature_sigstore = {
        ...finalPayload.receipt.signature_sigstore,
        rekor_log_entry: {
          uuid: rekorAttestation.rekor_uuid,
          logIndex: rekorAttestation.rekor_log_index,
          integratedTime: rekorAttestation.integrated_time,
          logID: rekorAttestation.log_id,
          rekor_url: rekorAttestation.rekor_url,
        },
        dry_run: false,
      };
    } catch (e) {
      if (requiresRekor) {
        throw new Error(`policy.require_rekor=true but Rekor pinning failed: ${e.message}`);
      }
      console.error(`[artifact] WARNING: sigstore Rekor pinning skipped: ${e.message}`);
    }
  }
  const stat = fs.statSync(outPath);

  return {
    outPath,
    manifest: finalPayload.manifest,
    receipt: finalPayload.receipt,
    credential: finalPayload.credential,
    artifact_hash: finalPayload.artifact_hash,
    cid: finalPayload.cid,
    eval_set_hash: finalPayload.eval_set_hash,
    bytes: stat.size,
    k_score: finalPayload.manifest.k_score,
    rekor_attestation: rekorAttestation,
  };
}

export function verifyManifestSignature(manifest_json, signature) {
  const secret = signSecret();
  if (!secret) return { valid: false, reason: 'sign secret unavailable on server' };
  try {
    const sig = typeof signature === 'string' ? JSON.parse(signature) : signature;
    if (!sig || sig.spec !== ARTIFACT_SPEC || !sig.hmac) return { valid: false, reason: 'bad signature shape' };
    const manifest_hash = sha256(Buffer.from(manifest_json));
    if (manifest_hash !== sig.manifest_hash) return { valid: false, reason: 'manifest_hash mismatch' };
    const payloads = [];
    if (
      sig.artifact_hash &&
      sig.eval_set_hash &&
      typeof sig.eval_score === 'number' &&
      sig.judge_id
    ) {
      payloads.push({
        spec: ARTIFACT_SPEC,
        manifest_hash,
        job_id: sig.job_id,
        artifact_hash: sig.artifact_hash,
        eval_set_hash: sig.eval_set_hash,
        eval_score: sig.eval_score,
        judge_id: sig.judge_id,
      });
    }
    payloads.push({ spec: ARTIFACT_SPEC, manifest_hash, job_id: sig.job_id });

    for (const payload of payloads) {
      const expected = crypto.createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
      if (constantTimeEqualHex(sig.hmac, expected)) return { valid: true };
    }
    return { valid: false, reason: 'hmac mismatch' };
  } catch (e) {
    return { valid: false, reason: String(e.message || e) };
  }
}

function constantTimeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Device-fit verification. Given a manifest carrying target_device and the
// current host's detected device, return {ok, reason}. Two failure modes:
//   1. Hard fail: the model in this artifact cannot physically fit on the
//      host (vram too small, arch wrong).
//   2. Soft warn: the artifact was compiled for a different device of the
//      same class; performance won't match the K-score baseline.
export async function verifyDeviceFit(manifest, hostDeviceId) {
  if (!manifest) return { ok: false, reason: 'no manifest' };
  const target = manifest.target_device;
  if (!target) {
    return { ok: true, reason: 'no target_device pinned in manifest', soft: true };
  }
  if (!hostDeviceId) {
    return { ok: false, reason: 'host device could not be detected' };
  }
  if (target === hostDeviceId) {
    return { ok: true, reason: `exact match: ${target}` };
  }
  // Cross-device: load the device registry and check vram/arch.
  const D = await import('./devices.js');
  const tgtDev = D.info(target);
  const hostDev = D.info(hostDeviceId);
  if (!tgtDev || !hostDev) {
    return { ok: false, reason: `unknown device: target=${target} host=${hostDeviceId}` };
  }
  // Same class + host has >= vram of target -> ok with soft warn.
  if (hostDev.class === tgtDev.class &&
      (hostDev.vram_gb || 0) >= (tgtDev.vram_gb || 0)) {
    return {
      ok: true,
      reason: `host ${hostDeviceId} can run an artifact compiled for ${target} (same class, sufficient vram)`,
      soft: true,
    };
  }
  // Host has less vram than target -> hard fail.
  if ((hostDev.vram_gb || 0) < (tgtDev.vram_gb || 0)) {
    return {
      ok: false,
      reason: `host ${hostDeviceId} has ${hostDev.vram_gb}GB vram; artifact was compiled for ${target} (${tgtDev.vram_gb}GB)`,
    };
  }
  return {
    ok: true,
    reason: `host ${hostDeviceId} differs from compile target ${target}; proceeding`,
    soft: true,
  };
}
