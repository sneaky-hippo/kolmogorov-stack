// kolm compile orchestrator.
//
// `kolm compile <task>` is the one user-facing primitive. Beneath it, four
// engines participate: Recall (multimodal substrate), Distill (verified
// inference labels), Decompose (recipe pack), Run (artifact bundling).
//
// Wave 282 — every build path now routes through `src/spec-compile.js`. The
// pre-W282 pipeline synthesized fake eval cases from the task description
// when the caller provided no examples and shipped the resulting artifact
// with an essentially-meaningless K-score. Per audit finding C1 that path
// is closed: compile without positive examples is a structured failure.
// The single canonical build path is compileSpec (which delegates to the
// signed zip writer internally).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, findOne, insert, update } from './store.js';
import { compileSpec } from './spec-compile.js';
import { prepareSeedSplit, hashSeeds } from './seeds.js';
import { TEMPLATES as CHAT_TEMPLATES, pickTemplate, manifestBlock } from './chat-templates.js';

// W234 — resolve the chat_template block that gets stamped into the artifact
// manifest. Callers can either name a template explicitly (chat_template) or
// rely on inference from the base_model name. thinking_mode is a per-job
// override that opts in to (or out of) the qwen-3-thinking scratchpad even
// when the template would otherwise default the other way.
function resolveChatTemplateBlock({ chat_template, base_model, thinking_mode }) {
  let name = null;
  if (chat_template && typeof chat_template === 'string' && CHAT_TEMPLATES[chat_template]) {
    name = chat_template;
  } else if (base_model) {
    const picked = pickTemplate(base_model);
    name = picked && picked.name;
  }
  if (!name) name = 'plain';
  const overrides = (typeof thinking_mode === 'boolean') ? { thinking: thinking_mode } : {};
  return manifestBlock(name, overrides);
}

const JOBS = new Map(); // in-memory; persists in `compile_jobs` table

function ensureJobsTable() {
  if (!Array.isArray(all('compile_jobs'))) {
    insert('compile_jobs', { id: '__bootstrap__', _bootstrap: true });
    update('compile_jobs', x => x.id === '__bootstrap__', { _deleted: true });
  }
}

const VALID_PRESETS = new Set([
  'sft',            // plain SFT
  'lora-fast',      // Unsloth-style fast LoRA (default)
  'long-context',   // YaRN/NTK/Linear PI
  'vlm',            // Qwen2.5-VL frozen vision tower
  'merge-adapters', // SLERP/TIES/DARE
  'embed',          // InfoNCE + Matryoshka
  'fc-tools',       // function-calling SFT (Hermes-FC)
  'grpo-reasoning', // verifiable-reward online RL
  'instant',        // TAID-inspired zero-shot
]);

function clampRank(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 16;
  if (v < 4) return 4;
  if (v > 64) return 64;
  return Math.round(v);
}

function clampThreshold(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.85;
  if (v < 0.50) return 0.50;
  if (v > 0.99) return 0.99;
  return Math.round(v * 100) / 100;
}

export function createJob({
  task, examples, corpus_namespace, base_model,
  tenant, tenant_id, deploy_hook,
  preset, lora_rank, k_threshold,
  chat_template, thinking_mode,
  allow_below_gate,
}) {
  ensureJobsTable();
  const id = 'job_' + crypto.randomBytes(6).toString('hex');
  const envHook = process.env.KOLM_DEPLOY_HOOK_URL || '';
  const rawHook = typeof deploy_hook === 'string' && deploy_hook ? deploy_hook : envHook;
  const hook = /^https:\/\//i.test(rawHook) ? rawHook : null;
  const chatBlock = resolveChatTemplateBlock({ chat_template, base_model, thinking_mode });
  const job = {
    id,
    tenant,
    tenant_id: tenant_id || null,
    task: typeof task === 'string' ? task : JSON.stringify(task),
    examples_n: Array.isArray(examples) ? examples.length : 0,
    corpus_namespace: corpus_namespace || null,
    base_model: base_model || 'none',
    preset: preset && VALID_PRESETS.has(preset) ? preset : 'lora-fast',
    lora_rank: clampRank(lora_rank),
    k_threshold: clampThreshold(k_threshold),
    chat_template: chatBlock,
    thinking_mode: typeof thinking_mode === 'boolean' ? thinking_mode : chatBlock.thinking,
    allow_below_gate: allow_below_gate === true,
    deploy_hook: hook,
    deploy_status: hook ? 'pending' : 'skipped',
    deploy_attempted_at: null,
    deploy_response_code: null,
    status: 'queued',
    progress: 0,
    stages: [],
    artifact_path: null,
    artifact_bytes: null,
    manifest: null,
    error: null,
    created_at: new Date().toISOString(),
  };
  insert('compile_jobs', job);
  JOBS.set(id, job);
  return job;
}

export function getJob(id, tenant) {
  ensureJobsTable();
  const j = findOne('compile_jobs', x => x.id === id && !x._deleted);
  if (!j) return null;
  if (tenant && j.tenant !== tenant) return null;
  return j;
}

export function listJobs(tenant, limit = 25) {
  ensureJobsTable();
  return all('compile_jobs')
    .filter(j => !j._deleted && (!tenant || j.tenant === tenant))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, limit);
}

function setStage(job, name, payload = {}) {
  const stage = { name, at: new Date().toISOString(), ...payload };
  job.stages = [...(job.stages || []), stage];
  update('compile_jobs', x => x.id === job.id, { stages: job.stages });
  JOBS.set(job.id, job);
}

function setStatus(job, status, patch = {}) {
  Object.assign(job, { status }, patch);
  update('compile_jobs', x => x.id === job.id, { status, ...patch });
  JOBS.set(job.id, job);
}

// Slug a free-text task description into a valid recipe id.
function slugify(s) {
  return (s || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'synthesized';
}

// Run the orchestrator. Fire-and-forget on long-running nodes; awaited on
// serverless. Wave 282 — every successful path produces an artifact via
// `compileSpec` (the same code that `kolm compile --spec -` runs). There is
// no longer a "synthesize-and-zip without a real eval set" branch — the spec-compile
// seed gate is the only build path.
export async function runJob(job, ctx) {
  try {
    setStatus(job, 'running', { progress: 5 });

    // Stage 1 — Recall.
    setStage(job, 'recall.start');
    let recall_chunks = [];
    if (ctx.recall && job.corpus_namespace) {
      try {
        recall_chunks = await ctx.recall.query({
          namespace: job.corpus_namespace, query: job.task, k: 12,
        });
      } catch (e) { setStage(job, 'recall.error', { error: String(e.message || e) }); }
    }
    setStage(job, 'recall.done', { chunks_n: recall_chunks.length });
    setStatus(job, 'running', { progress: 25 });

    // Wave 282 no-seeds refusal. Pre-W282 a compile with empty examples
    // synthesized fake test cases from the task description and shipped a
    // 0.98+ K-score artifact whose accuracy was measured against the
    // recipe's own outputs. Per audit C1 that is a stub artifact; refuse.
    const examples = Array.isArray(ctx.examples) ? ctx.examples : [];
    const positives = examples.filter(e => e && e.kind !== 'negative');
    const negatives = examples.filter(e => e && e.kind === 'negative');
    if (positives.length === 0) {
      setStatus(job, 'failed', {
        error: 'no_seeds_provided: compile refused — at least one positive example (an {input, output} pair) is required so the artifact has a real evaluation set. Pre-Wave-282 builds synthesized fake eval cases from the task description; that path is closed.',
        error_code: 'KOLM_E_NO_SEEDS',
        progress: 25,
        failed_at: new Date().toISOString(),
      });
      return;
    }

    // Wave 283 — split the seeds BEFORE synthesis so the teacher only ever
    // sees train rows. Pre-W283 we passed every positive to ctx.synthesize,
    // which meant the holdout the K-score later measured against had been
    // seen at recipe-construction time — a textbook leakage and a real
    // audit finding. Now we write seeds.jsonl first, run prepareSeedSplit
    // deterministically (same split_seed compileSpec will use later), and
    // feed only `train` to synthesis. The manifest carries
    // `synthesis_input_hash` so an external auditor can prove the policy.
    const outDir = ctx.outDir || path.join(os.tmpdir(), 'kolm-artifacts');
    fs.mkdirSync(outDir, { recursive: true });
    const seedsDir = path.join(outDir, 'seeds-' + job.id);
    fs.mkdirSync(seedsDir, { recursive: true });
    const seedsPath = path.join(seedsDir, 'seeds.jsonl');
    const seedRows = positives.map((e) => {
      const row = { input: e.input, expected: e.output ?? e.expected };
      if (e.id) row.metadata = { id: String(e.id) };
      if (Array.isArray(e.tags) && e.tags.length) {
        row.tags = e.tags.slice();
      }
      return row;
    });
    fs.writeFileSync(seedsPath, seedRows.map(r => JSON.stringify(r)).join('\n') + '\n');

    let preSplit = null;
    try {
      preSplit = prepareSeedSplit({ seedsPath });
    } catch (e) {
      setStage(job, 'split.error', { error: String(e.message || e) });
    }
    const trainForSynthesis = preSplit && Array.isArray(preSplit.train) && preSplit.train.length > 0
      ? preSplit.train
      : seedRows; // single-row corner case: split has empty train, fall back
    const synthesisInputHash = hashSeeds(trainForSynthesis);
    setStage(job, 'split.done', {
      train_count: preSplit?.train_count ?? trainForSynthesis.length,
      holdout_count: preSplit?.holdout_count ?? 0,
      synthesis_input_hash: synthesisInputHash,
    });

    // Stage 2 — Distill: synthesize a JS recipe from the train slice only.
    setStage(job, 'distill.start');
    let synthesis_result = null;
    try {
      const norm = (e) => ({
        input: e.input,
        expected: e.expected ?? e.output,
        metadata: e.metadata || null,
      });
      synthesis_result = await ctx.synthesize({
        positives: trainForSynthesis.map(norm),
        negatives: negatives.map((e) => ({ ...e, expected: e.expected ?? e.output })),
        priors: {},
      });
    } catch (e) { setStage(job, 'distill.error', { error: String(e.message || e) }); }
    setStage(job, 'distill.done', {
      accepted: !!synthesis_result?.accepted,
      pass_rate: synthesis_result?.pass_rate_positive ?? null,
    });

    if (!synthesis_result || !synthesis_result.accepted || !synthesis_result.source) {
      try { fs.rmSync(seedsDir, { recursive: true, force: true }); } catch {}
      setStatus(job, 'failed', {
        error: 'recipe_synthesis_failed: could not synthesize a recipe from the provided examples that passes the quality gate. Add more examples or sharpen the input/output pairs.',
        error_code: 'KOLM_E_RECIPE_SYNTHESIS_FAILED',
        progress: 50,
        failed_at: new Date().toISOString(),
      });
      return;
    }
    setStatus(job, 'running', { progress: 60 });

    // Stage 3 — Decompose: register the synthesized recipe as a real
    // concept so the caller can POST /v1/recipes/{id}/run against their
    // freshly compiled artifact.
    setStage(job, 'decompose.start');
    const synthName = slugify(job.task || 'task');
    let registered_concept_id = null;
    let registered_version_id = null;
    if (ctx.registry && typeof ctx.registry.createConcept === 'function') {
      try {
        const concept = ctx.registry.createConcept({
          name: synthName,
          description: (job.task || '').slice(0, 400),
          tenant: job.tenant,
          schema: null,
          tags: ['compiled'],
          visibility: 'private',
        });
        const version = ctx.registry.publishVersion({
          concept_id: concept.id,
          source: synthesis_result.source,
          evaluation: {
            quality_score: synthesis_result.quality_score ?? null,
            pass_rate_positive: synthesis_result.pass_rate_positive ?? null,
            reject_rate_negative: synthesis_result.reject_rate_negative ?? null,
            latency_p50_us: synthesis_result.latency_p50_us ?? null,
            size_bytes: synthesis_result.size_bytes ?? null,
            source_hash: synthesis_result.source_hash ?? null,
            strategy: synthesis_result.strategy ?? null,
          },
          lineage: { compiled_from_job: job.id },
        });
        registered_concept_id = concept.id;
        registered_version_id = version.id;
      } catch (e) {
        setStage(job, 'register.error', { error: String(e.message || e) });
      }
    }
    setStage(job, 'decompose.done', {
      recipes_n: 1,
      synthesized: true,
      concept_id: registered_concept_id,
    });
    setStatus(job, 'running', { progress: 80 });

    // Stage 4 — Package via compileSpec. The seeds.jsonl was already written
    // in the pre-split phase above; compileSpec will re-run the deterministic
    // split (same split_seed) so the holdout the K-score is measured against
    // is identical to the holdout we held back from the teacher.
    setStage(job, 'package.start');

    // Honest artifact_class — strategy 'claude' means an LLM teacher emitted
    // the source (synthesized_rule). Strategy 'pattern' is deterministic
    // template matching with no teacher (rule). The audit (C2) requires
    // build-time class enforcement so we never default to a claim the bytes
    // can't back up.
    const strategy = synthesis_result.strategy || 'pattern';
    const isTeacherSynthesized = strategy === 'claude';
    const artifactClass = isTeacherSynthesized ? 'synthesized_rule' : 'rule';
    const synthesisTrainingStats = isTeacherSynthesized
      ? {
          synthesized_by: 'anthropic',
          teacher_vendor: 'anthropic',
          teacher_model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-7',
          synthesis_strategy: strategy,
          synthesis_input_hash: synthesisInputHash,
        }
      : {
          synthesis_strategy: strategy,
          synthesis_input_hash: synthesisInputHash,
        };

    const recipeId = registered_concept_id || ('rcp_synth_' + job.id);
    const spec = {
      job_id: job.id,
      task: job.task,
      base_model: job.base_model || 'none',
      recipes: [{
        id: recipeId,
        name: synthName,
        source: synthesis_result.source,
        version_id: registered_version_id || `ver_synth_${job.id}`,
        tags: ['compiled'],
      }],
      artifact_class: artifactClass,
      training_stats: synthesisTrainingStats,
    };

    let built;
    try {
      built = await compileSpec(spec, {
        seedsPath,
        outDir,
        useSeedsGate: true,
        allow_below_gate: job.allow_below_gate === true,
      });
    } catch (e) {
      setStatus(job, 'failed', {
        error: 'compile_failed: ' + String(e.message || e),
        error_code: 'KOLM_E_COMPILE',
        progress: 80,
        failed_at: new Date().toISOString(),
      });
      try { fs.rmSync(seedsDir, { recursive: true, force: true }); } catch {}
      return;
    }
    // The build payload returns either a number (legacy v1 K-score) or the v2
    // envelope { composite, ships, axes, ... }. Normalize to one number.
    const composite = typeof built.k_score === 'number'
      ? built.k_score
      : (built.k_score && typeof built.k_score.composite === 'number' ? built.k_score.composite : null);
    setStage(job, 'package.done', { bytes: built.bytes, k_score: composite });

    const threshold = typeof job.k_threshold === 'number' ? job.k_threshold : 0.85;
    if (typeof composite === 'number' && composite < threshold) {
      setStatus(job, 'failed', {
        error: `k_score ${composite.toFixed(3)} below threshold ${threshold.toFixed(2)} — no artifact shipped`,
        error_code: 'KOLM_E_K_SCORE_BELOW_THRESHOLD',
        k_score: composite,
        artifact_path: null,
        artifact_bytes: null,
        failed_at: new Date().toISOString(),
      });
      try { fs.rmSync(seedsDir, { recursive: true, force: true }); } catch {}
      return;
    }

    setStatus(job, 'completed', {
      progress: 100,
      artifact_path: built.outPath,
      artifact_bytes: built.bytes,
      manifest: built.manifest,
      receipt: built.manifest?.receipt || null,
      concept_id: registered_concept_id,
      version_id: registered_version_id,
      artifact_hash: built.manifest?.hashes?.artifact_hash || built.manifest?.artifact_hash || null,
      cid: built.manifest?.cid || null,
      eval_set_hash: built.manifest?.hashes?.evals || null,
      k_score: composite,
      k_score_envelope: built.k_score,
      evals_summary: built.manifest?.evals
        ? { total: built.manifest.evals.n || 0, source: 'seeds.jsonl holdout' }
        : { total: 0, source: 'none' },
      seed_provenance: built.manifest?.seed_provenance || null,
      completed_at: new Date().toISOString(),
    });

    try { fs.rmSync(seedsDir, { recursive: true, force: true }); } catch {}

    // Machine self-serve deploy hook.
    if (job.deploy_hook) {
      const payload = JSON.stringify({
        job_id: job.id,
        artifact_url: `/v1/compile/${job.id}/.kolm`,
        artifact_hash: built.manifest?.hashes?.artifact_hash || built.manifest?.artifact_hash || null,
        cid: built.manifest?.cid || null,
        k_score: composite || null,
        base_model: job.base_model,
        completed_at: job.completed_at,
      });
      try {
        const r = await fetch(job.deploy_hook, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'kolm-compile/1' },
          body: payload,
        });
        update('compile_jobs', x => x.id === job.id, {
          deploy_status: r.ok ? 'sent' : 'failed',
          deploy_response_code: r.status,
          deploy_attempted_at: new Date().toISOString(),
        });
      } catch (e) {
        update('compile_jobs', x => x.id === job.id, {
          deploy_status: 'failed',
          deploy_response_code: null,
          deploy_attempted_at: new Date().toISOString(),
        });
      }
    }
  } catch (e) {
    setStatus(job, 'failed', {
      error: String(e.message || e),
      error_code: 'KOLM_E_UNHANDLED',
      failed_at: new Date().toISOString(),
    });
  }
}
