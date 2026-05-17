// src/distill-provenance.js
//
// Wave 144 — bridge between the isolated workers/distill output dir and the
// in-process artifact builder. Reads the worker's manifest.json + training-
// pairs.jsonl, recomputes hashes, and emits a validated lineage block
// (source='distillation') that buildAndZip will hash into the artifact.
//
// Inputs:
//   loadDistillProvenance(dirPath, opts)
//     dirPath  — path to a workers/distill output dir (contains manifest.json)
//     opts.cwd — base for resolving relative paths
//
// Returns:
//   {
//     worker_version, teacher_vendor, teacher_model, student_base,
//     training_pairs_collected, training_pairs_hash, redaction_map_hash,
//     ml_pipeline_run,
//     lineage: { spec, source: 'distillation', teacher: {...},
//                student_base: {...}, distillation_method, training_corpus_hash }
//   }
//
// This module is the receipt-chain anchor for distilled artifacts: the
// hashes it returns are bound into manifest.lineage.hash inside the .kolm,
// so a third party can resolve the worker's outputs back to the artifact
// without trusting either side independently.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildLineage } from './artifact-lineage.js';

const HEX16_RE = /^[0-9a-f]{16}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Pull just the 16-hex shorthand the lineage block accepts. Worker emits
// `sha256:<hex>`; lineage block accepts hex16 for the optional redaction_map
// and hex64 for training_corpus.
function _short16(s) {
  if (typeof s !== 'string') return null;
  const stripped = s.replace(/^sha256:/, '');
  return stripped.slice(0, 16);
}

function _full64(s) {
  if (typeof s !== 'string') return null;
  const stripped = s.replace(/^sha256:/, '');
  if (HEX64_RE.test(stripped)) return stripped;
  return null;
}

export function loadDistillProvenance(dirPath, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const abs = path.isAbsolute(dirPath) ? dirPath : path.resolve(cwd, dirPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`distill provenance dir not found: ${abs}`);
  }
  const manifestPath = path.join(abs, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`distill manifest.json missing in ${abs}`);
  }
  let workerManifest;
  try {
    workerManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`distill manifest.json could not be parsed: ${e.message}`);
  }
  if (workerManifest.worker !== 'kolm-distill-worker') {
    throw new Error(`unexpected worker tag in manifest: ${workerManifest.worker}`);
  }

  // Recompute training-pairs hash from disk so the lineage cannot drift from
  // what the worker recorded. If the file is missing (stub mode) we accept a
  // null hash but still emit a lineage block — the block just records that
  // the artifact came from a distill provenance dir, not that a training
  // corpus was produced.
  let trainingCorpusHash64 = null;
  if (workerManifest.training_pairs_path) {
    const pairsAbs = path.resolve(abs, workerManifest.training_pairs_path);
    if (fs.existsSync(pairsAbs)) {
      trainingCorpusHash64 = sha256Hex(fs.readFileSync(pairsAbs));
      const recorded = (workerManifest.training_pairs_hash || '').replace(/^sha256:/, '');
      if (recorded && recorded !== trainingCorpusHash64) {
        throw new Error(`training-pairs hash drift: worker said ${recorded}, disk says ${trainingCorpusHash64}`);
      }
    }
  }

  const teacher = (workerManifest.teacher_vendor && workerManifest.teacher_model)
    ? {
        vendor: workerManifest.teacher_vendor,
        model: workerManifest.teacher_model,
        ...(workerManifest.teacher_version ? { version: workerManifest.teacher_version } : {}),
        ...(workerManifest.redaction_map_hash && HEX16_RE.test(_short16(workerManifest.redaction_map_hash))
          ? { redaction_map_hash: _short16(workerManifest.redaction_map_hash) }
          : {}),
      }
    : null;

  const studentBase = workerManifest.student_base
    ? {
        repo: String(workerManifest.student_base),
        ...(workerManifest.student_base_revision ? { revision: String(workerManifest.student_base_revision) } : {}),
      }
    : null;

  // buildLineage demands teacher + student_base for source='distillation'.
  // Stub-mode worker manifests have neither — for those we fall back to
  // source='rebuild' (just records provenance dir) so the artifact still
  // carries a lineage block but doesn't lie about being distilled.
  //
  // Wave 158 — distillation_method now respects worker manifest field if
  // present (set by --distillation-method CLI flag); falls back to old
  // derive-from-ml_pipeline_run behavior so legacy manifests keep working.
  const distillMethod = workerManifest.distillation_method
    || (workerManifest.ml_pipeline_run ? 'lora' : 'prompt-distill');

  let lineage;
  if (teacher && studentBase) {
    lineage = buildLineage({
      source: 'distillation',
      teacher,
      student_base: studentBase,
      distillation_method: distillMethod,
      ...(trainingCorpusHash64 ? { training_corpus_hash: trainingCorpusHash64 } : {}),
      notes: `kolm-distill-worker ${workerManifest.worker_version || ''} mode=${workerManifest.mode || ''} pairs=${workerManifest.training_pairs_collected || 0}`,
    });
  } else {
    lineage = buildLineage({
      source: 'rebuild',
      notes: `kolm-distill-worker ${workerManifest.worker_version || ''} mode=${workerManifest.mode || 'stub'} (no teacher/student; no distillation claim)`,
    });
  }

  return {
    worker_version: workerManifest.worker_version || null,
    teacher_vendor: workerManifest.teacher_vendor || null,
    teacher_model: workerManifest.teacher_model || null,
    // wave 158 — cross-vendor distillation provenance. Verifier check #15
    // reads these to confirm the distillation provenance is complete
    // (teacher_vendor + teacher_model + student_base + distillation_method
    // are all required when the lineage source is 'distillation').
    teacher_version: workerManifest.teacher_version || null,
    student_base: workerManifest.student_base || null,
    student_base_repo: workerManifest.student_base_repo || null,
    student_base_origin: workerManifest.student_base_origin || null,
    student_base_license: workerManifest.student_base_license || null,
    student_base_revision: workerManifest.student_base_revision || null,
    distillation_method: distillMethod,
    training_pairs_collected: workerManifest.training_pairs_collected || 0,
    training_pairs_hash: workerManifest.training_pairs_hash || null,
    redaction_map_hash: workerManifest.redaction_map_hash || null,
    // wave 157 — receipt-chain extension. redact_class + teacher_call_log_hash
    // + reinjection_log_hash flow through to the artifact manifest so verifier
    // check #14 can confirm a PHI workload's auditor-replay surface is intact.
    redact_class: workerManifest.redact_class || null,
    teacher_call_log_hash: workerManifest.teacher_call_log_hash || null,
    reinjection_log_hash: workerManifest.reinjection_log_hash || null,
    ml_pipeline_run: !!workerManifest.ml_pipeline_run,
    // wave 145 — teacher-holdout pass-through for K-score T axis.
    // Worker writes these only when --teacher-holdout was set AND a teacher
    // was configured. Null otherwise. Verifier can replay (offline) the
    // teacher_holdout_log to confirm the recorded accuracy was actually
    // computed, not asserted.
    teacher_holdout_accuracy: typeof workerManifest.teacher_holdout_accuracy === 'number'
      ? workerManifest.teacher_holdout_accuracy : null,
    teacher_holdout_count: typeof workerManifest.teacher_holdout_count === 'number'
      ? workerManifest.teacher_holdout_count : null,
    teacher_holdout_log_hash: workerManifest.teacher_holdout_log_hash || null,
    lineage,
  };
}
