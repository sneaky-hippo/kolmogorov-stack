// kolm compile orchestrator.
//
// `kolm compile <task>` is the one user-facing primitive. Beneath it, four
// engines participate: Recall (multimodal substrate), Distill (verified
// inference labels), Decompose (recipe pack), Run (artifact bundling).
//
// In Sprint 1 only Recall + Distill + Run participate. Decompose ships in
// Sprint 2; LoRA training ships in Sprint 3. Until then `compile` produces
// a *cloud-runtime* artifact whose `model.gguf` field is a pointer that
// `kolm run` resolves over HTTPS.

import crypto from 'node:crypto';
import { all, findOne, insert, update } from './store.js';
import { buildAndZip, buildPayload } from './artifact.js';

const JOBS = new Map(); // in-memory; persists in `compile_jobs` table

function ensureJobsTable() {
  if (!Array.isArray(all('compile_jobs'))) {
    // the store is a JSON-blob db; insert/all auto-create the collection
    insert('compile_jobs', { id: '__bootstrap__', _bootstrap: true });
    update('compile_jobs', x => x.id === '__bootstrap__', { _deleted: true });
  }
}

export function createJob({ task, examples, corpus_namespace, base_model, tenant }) {
  ensureJobsTable();
  const id = 'job_' + crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    tenant,
    task: typeof task === 'string' ? task : JSON.stringify(task),
    examples_n: Array.isArray(examples) ? examples.length : 0,
    corpus_namespace: corpus_namespace || null,
    base_model: base_model || 'qwen2.5-coder-7b-instruct-q4_0',
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

// Run the orchestrator. This is fire-and-forget — the HTTP handler returns
// the job id immediately, and this function drives the four engines in the
// background.
export async function runJob(job, ctx) {
  const { tenant } = job;
  try {
    setStatus(job, 'running', { progress: 5 });

    // Stage 1 — Recall: gather grounding chunks. Sprint 1 stub: no-op
    // unless a recall.namespace is configured; in that case we ask the
    // recall engine for the top-K most-relevant chunks for the task text.
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

    // Stage 2 — Distill: synthesize a verifier from examples, then ask
    // the verified-inference loop to label N candidate tasks. In Sprint
    // 1 we synthesize a verifier from the examples without actually
    // calling the frontier — the pattern-mode synthesizer is enough to
    // get a working artifact out the door.
    setStage(job, 'distill.start');
    let synthesis_result = null;
    try {
      // Pattern-mode synthesis — no API key required.
      // Normalize {input, output} into the synthesizer's {input, expected} shape.
      const norm = (e) => ({ ...e, expected: e.expected ?? e.output });
      const positives = (ctx.examples || []).filter(e => e.kind !== 'negative').map(norm);
      const negatives = (ctx.examples || []).filter(e => e.kind === 'negative').map(norm);
      synthesis_result = await ctx.synthesize({
        positives: positives.length ? positives : [{ input: job.task, expected: job.task }],
        negatives,
        priors: {},
      });
    } catch (e) { setStage(job, 'distill.error', { error: String(e.message || e) }); }
    setStage(job, 'distill.done', {
      accepted: !!synthesis_result?.accepted,
      pass_rate: synthesis_result?.pass_rate_positive ?? null,
    });
    setStatus(job, 'running', { progress: 60 });

    // Stage 3 — Decompose: pull the registry slice that covers this task's
    // expected outputs. Sprint 1 stub: snapshot the public registry as the
    // recipe pack. Sprint 2 will narrow this to the deterministic-token
    // subset of the model's behavior on this task.
    setStage(job, 'decompose.start');
    const baseRecipes = ctx.publicRecipes() || [];
    const recipes = [];
    if (synthesis_result && synthesis_result.accepted && synthesis_result.source) {
      recipes.push({
        id: `cpt_synth_${job.id}`,
        version_id: `ver_synth_${job.id}`,
        name: (job.task || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'synthesized',
        source: synthesis_result.source,
        synthesized: true,
      });
    }
    for (const r of baseRecipes) recipes.push(r);
    setStage(job, 'decompose.done', { recipes_n: recipes.length, synthesized: !!(synthesis_result && synthesis_result.accepted) });
    setStatus(job, 'running', { progress: 80 });

    // Stage 4 — Run / package: assemble + sign the .kolm artifact.
    setStage(job, 'package.start');

    // Build the eval suite from positives. "No eval, no compile" gate —
    // every artifact carries the test cases the K-score is computed against.
    const positives = (ctx.examples || []).filter(e => e.kind !== 'negative');
    const evals_obj = {
      spec: 'rs-1-evals',
      n: positives.length,
      cases: positives.map((e, i) => ({
        id: `case-${i + 1}`,
        input: e.input ?? null,
        expected: e.output ?? e.expected ?? null,
      })),
      coverage: positives.length > 0
        ? (synthesis_result?.pass_rate_positive ?? 0)
        : 0,
    };

    const built = await buildAndZip({
      job_id: job.id,
      task: job.task,
      base_model: job.base_model,
      recipes,
      lora_pointer: null,                  // Sprint 3
      recall_namespace: job.corpus_namespace,
      training_stats: synthesis_result ? {
        distilled_pairs: 0,                // Sprint 3 once /v1/labels/synthesize-corpus ships
        verifier_accepted: !!synthesis_result.accepted,
        pass_rate_positive: synthesis_result.pass_rate_positive ?? null,
        latency_p50_us: synthesis_result.latency_p50_us ?? 50,
      } : null,
      evals: evals_obj,
      outDir: ctx.outDir,
    });
    setStage(job, 'package.done', { bytes: built.bytes, k_score: built.k_score });

    setStatus(job, 'completed', {
      progress: 100,
      artifact_path: built.outPath,
      artifact_bytes: built.bytes,
      manifest: built.manifest,
      receipt: built.receipt,
      artifact_hash: built.artifact_hash,
      eval_set_hash: built.eval_set_hash,
      k_score: built.k_score,
      completed_at: new Date().toISOString(),
    });
  } catch (e) {
    setStatus(job, 'failed', {
      error: String(e.message || e),
      failed_at: new Date().toISOString(),
    });
  }
}
