// src/build-preview.js
//
// W347 — Dry-run build preview helper. Powers POST /v1/build/preview.
//
// Why this exists: the builder UI (public/builder.html) needs to show the
// caller a real K-score, the first few train + holdout rows, the
// production_ready verdict, and which gates would block ship — WITHOUT
// writing an artifact, charging the tenant, or spawning a synthesis job.
//
// Inputs:
//   spec              — spec.json-shaped object (name, task, output_spec, ...)
//   seeds_jsonl_text  — raw JSONL text (one row per line, canonical
//                       {input,output} or legacy {prompt,completion} shape).
//
// Outputs:
//   {
//     ok: true,
//     k_score: { composite, accuracy, coverage, size_score, latency_score, cost_score, ships },
//     train_rows: [{input,output}, ...] (first 3),
//     holdout_rows: [{input,output}, ...] (first 3),
//     train_count, holdout_count,
//     production_ready: { ok, gates, reasons },
//     gate_reasons: [string, ...],
//     accepted: boolean,           // synth.accepted
//     recipe_source: string,       // for diff / inspect
//     warnings: [{code, message}],
//   }
//
// Failure modes:
//   - bad input → throws Error('invalid_seeds' | 'invalid_spec' | 'empty_seeds')
//   - synthesis failure → throws Error('synthesis_failed: <reason>')
//
// Pure (no I/O): operates entirely on in-memory text. The helper writes a
// temp seeds.jsonl into os.tmpdir() so prepareSeedSplit (which is filesystem-
// based) can read it, then deletes it immediately. No artifact is written.

import { computeKScore } from './kscore.js';
import { synthesize } from './synthesis.js';
import { prepareSeedSplit } from './seeds.js';
import { productionReadySync } from './production-ready.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_SEEDS_BYTES = 1_048_576; // 1 MB cap on seeds text.
const MAX_SPEC_BYTES = 65_536;
const MAX_SHOW_ROWS = 3;

function parseJsonlText(text) {
  if (typeof text !== 'string') return { rows: [], errors: ['seeds_text must be a string'] };
  if (text.length > MAX_SEEDS_BYTES) {
    return { rows: [], errors: [`seeds_text exceeds ${MAX_SEEDS_BYTES} bytes`] };
  }
  const lines = text.split(/\r?\n/);
  const rows = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    try {
      const j = JSON.parse(ln);
      if (!j || typeof j !== 'object') { errors.push(`line ${i + 1}: not an object`); continue; }
      // Canonical: {input, output}. Legacy: {prompt, completion}.
      const input = j.input != null ? j.input : j.prompt;
      const output = j.output != null ? j.output : j.completion;
      if (input == null || output == null) {
        errors.push(`line ${i + 1}: missing input/output (or prompt/completion)`);
        continue;
      }
      rows.push({ input, output });
    } catch (e) {
      errors.push(`line ${i + 1}: ${e.message}`);
    }
  }
  return { rows, errors };
}

function shapeSpec(specIn) {
  if (!specIn || typeof specIn !== 'object') return null;
  // Defensive subset — the preview path only needs name + task + output_spec.
  return {
    name: typeof specIn.name === 'string' ? specIn.name.slice(0, 128) : 'preview',
    task: typeof specIn.task === 'string' ? specIn.task.slice(0, 8000) : '',
    output_spec: specIn.output_spec && typeof specIn.output_spec === 'object'
      ? specIn.output_spec
      : { type: 'string' },
    positives: Array.isArray(specIn.positives) ? specIn.positives.slice(0, 100) : [],
    negatives: Array.isArray(specIn.negatives) ? specIn.negatives.slice(0, 100) : [],
  };
}

// Public API.
export async function buildPreview({ spec, seeds_jsonl_text } = {}) {
  // --- input validation -----------------------------------------------------
  if (typeof seeds_jsonl_text !== 'string') {
    throw new Error('invalid_seeds: seeds_jsonl_text must be a string');
  }
  const specShaped = shapeSpec(spec);
  if (!specShaped) {
    throw new Error('invalid_spec: spec must be an object with at least task or name');
  }
  if (JSON.stringify(specShaped).length > MAX_SPEC_BYTES) {
    throw new Error('invalid_spec: spec exceeds 64KB');
  }

  // --- parse seeds ---------------------------------------------------------
  const { rows, errors } = parseJsonlText(seeds_jsonl_text);
  if (rows.length === 0) {
    throw new Error('empty_seeds: no parseable rows in seeds_jsonl_text');
  }

  // --- write seeds to a temp file so prepareSeedSplit can read them --------
  const tag = crypto.randomBytes(8).toString('hex');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `kolm-build-preview-${tag}-`));
  const seedsPath = path.join(tmpDir, 'seeds.jsonl');
  let split;
  try {
    const canonicalLines = rows.map((r) => JSON.stringify({ input: r.input, output: r.output })).join('\n') + '\n';
    fs.writeFileSync(seedsPath, canonicalLines);
    split = prepareSeedSplit({ seedsPath, task: specShaped.name, cwd: tmpDir });
  } finally {
    // Best-effort cleanup; the helper must not leak temp files even on success.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
  if (!split) {
    throw new Error('synthesis_failed: prepareSeedSplit returned null (seedsPath unresolved)');
  }

  // --- run synthesis (no artifact write) -----------------------------------
  let synth;
  try {
    synth = await synthesize({
      positives: rows.slice(0, 100),
      negatives: [],
      output_spec: specShaped.output_spec || { type: 'string' },
      priors: { hint: specShaped.task.slice(0, 800) },
    });
  } catch (e) {
    throw new Error('synthesis_failed: ' + (e.message || String(e)));
  }

  const recipe_source = synth.source || synth.best_source || '';
  const passRate = synth.pass_rate_positive ?? synth.best_result?.pass_rate_positive ?? 0;
  const latencyUs = synth.latency_p50_us ?? synth.best_result?.latency_p50_us ?? null;
  const sizeBytes = synth.size_bytes ?? (recipe_source ? Buffer.byteLength(recipe_source, 'utf8') : 0);

  const k_score = computeKScore({
    accuracy: passRate,
    coverage: rows.length > 0 ? 1 : 0,
    size_bytes: sizeBytes,
    p50_latency_us: latencyUs,
    cost_usd_per_call: 0,
  });

  // --- run productionReady on a synthetic preview manifest -----------------
  // The preview manifest mimics what spec-compile.js would emit at compile
  // time so the same gate checks fire. We do NOT lie about durability or
  // drift here — we use the sync helper which records durability as skipped.
  const previewManifest = {
    name: specShaped.name,
    k_score,
    seed_provenance: {
      eval_source: split.eval_source,
      duplicates: (split.duplicates || []).length,
      train_count: split.train_count,
      holdout_count: split.holdout_count,
      leakage_report: split.leakage_report || { input_overlap_count: 0, output_overlap_count: 0 },
      seeds_hash: split.seeds_hash,
      train_hash: split.train_hash,
      holdout_hash: split.holdout_hash,
      split_seed: split.split_seed,
      holdout_ratio: split.holdout_ratio,
    },
    drift: null, // No drift history on a fresh preview.
  };
  let production_ready;
  try {
    production_ready = productionReadySync(previewManifest);
  } catch (_e) {
    production_ready = { ok: false, gates: {}, reasons: ['preview_gate_check_failed'] };
  }

  const warnings = [];
  if (errors.length > 0) {
    warnings.push({ code: 'partial_parse', message: `${errors.length} seed line(s) skipped`, detail: errors.slice(0, 5) });
  }
  if (rows.length < 3) warnings.push({ code: 'few_examples', message: 'add at least 3 examples for a reliable estimate' });
  if (!synth.accepted) warnings.push({ code: 'below_gate', message: synth.reason || 'quality below gate; add more examples or tighten the task' });
  if (passRate < 1 && rows.length > 0) {
    warnings.push({ code: 'partial_pass', message: `recipe passes ${Math.round(passRate * 100)}% of positives` });
  }

  return {
    ok: true,
    k_score,
    train_rows: (split.train || []).slice(0, MAX_SHOW_ROWS).map((r) => ({ input: r.input, output: r.output })),
    holdout_rows: (split.holdout || []).slice(0, MAX_SHOW_ROWS).map((r) => ({ input: r.input, output: r.output })),
    train_count: split.train_count,
    holdout_count: split.holdout_count,
    production_ready,
    gate_reasons: production_ready.reasons || [],
    accepted: !!synth.accepted,
    recipe_source,
    warnings,
    synth: {
      quality_score: synth.quality_score ?? synth.best_result?.quality_score ?? null,
      strategy: synth.strategy || null,
      attempts: synth.attempts_n || null,
    },
  };
}

export default { buildPreview };
