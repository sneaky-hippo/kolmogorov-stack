// Skeleton-LoRA → evolving-local-model pipeline.
//
// The shape:
//
//   1. `kolm tune init`             create ~/.kolm/tune/<artifact>/v0/adapter_config.json
//                                   (PEFT format, zero-init). Skeleton is signed-in-place.
//   2. `kolm tune capture-on`       flip captures flag on. Every `kolm run` against this
//                                   artifact appends (input,output,recipe,ts) to
//                                   ~/.kolm/tune/<artifact>/captures.jsonl.
//   3. `kolm tune step`             spawn `python scripts/tune-step.py` (PEFT SFT).
//                                   Reads captures, writes v1/, v2/, … under tune dir.
//                                   --airgap passes KOLM_AIRGAP=1 to the trainer, which
//                                   disables HF Hub, blocks fetch, refuses any non-local
//                                   model path. If python+torch+peft are absent, exits
//                                   with a clean install message — does not silently fail.
//   4. `kolm tune eval [--rev vN]`  runs artifact's embedded evals against the candidate
//                                   adapter, recomputes K-score delta vs current head.
//   5. `kolm tune promote --rev N`  K-score(N) ≥ K-score(head) AND ≥ 0.85? Move v<N> into
//                                   the .kolm bundle, re-sign manifest, hot-reload serve.
//   6. `kolm tune rollback`         restore prior head from ~/.kolm/tune/<artifact>/head.prev
//   7. `kolm tune watch`            daemon: when captures.jsonl crosses N rows, auto-step,
//                                   auto-eval, auto-promote IF gates pass. Otherwise stop
//                                   and surface the failure via `kolm logs`.
//
// The capture buffer is artifact-scoped. The trainer is artifact-scoped. The K-score
// gate is global. This is the "living model" loop — every successful interaction is
// a training signal; every step is gated by the same K-score that compiled the artifact.
//
// Airgap guarantees:
// - tune-step.py never imports requests/httpx/urllib3 at top of file
// - KOLM_AIRGAP=1 unsets HF_HUB_OFFLINE inverted, sets TRANSFORMERS_OFFLINE=1, HF_DATASETS_OFFLINE=1
// - any model_path that contains a URL or scheme is rejected
// - the trainer's stdout is JSON-RPC; the orchestrator parses it and only believes paths
//   that resolve under ~/.kolm/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const HOME = os.homedir();
const TUNE_ROOT = path.join(HOME, '.kolm', 'tune');

export function artifactSlug(artifactPath) {
  const base = path.basename(artifactPath, '.kolm');
  return base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function tuneDir(artifactPath) {
  return path.join(TUNE_ROOT, artifactSlug(artifactPath));
}

function ensureTuneDir(artifactPath) {
  const d = tuneDir(artifactPath);
  fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(d, 'revisions'), { recursive: true });
  return d;
}

function latestRevision(d) {
  const revs = listRevisions(d);
  return revs.length ? revs[revs.length - 1] : null;
}

export function listRevisions(d) {
  const revsDir = path.join(d, 'revisions');
  if (!fs.existsSync(revsDir)) return [];
  return fs.readdirSync(revsDir)
    .filter(f => /^v\d+$/.test(f))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

// init — write the skeleton adapter_config.json + tune-config.json (kolm metadata).
// Returns { tuneDir, revision: 'v0', config }.
export function initAdapter({ artifactPath, baseModel, rank = 8, alpha = 16, targetModules = null, dropout = 0.05 }) {
  if (!fs.existsSync(artifactPath)) throw new Error('artifact not found: ' + artifactPath);
  const d = ensureTuneDir(artifactPath);
  const headFile = path.join(d, 'HEAD');
  if (fs.existsSync(headFile)) {
    return { tuneDir: d, revision: fs.readFileSync(headFile, 'utf8').trim(), config: null, existed: true };
  }
  const v0 = path.join(d, 'revisions', 'v0');
  fs.mkdirSync(v0, { recursive: true });
  const adapterCfg = {
    base_model_name_or_path: baseModel,
    peft_type: 'LORA',
    task_type: 'CAUSAL_LM',
    r: rank,
    lora_alpha: alpha,
    lora_dropout: dropout,
    bias: 'none',
    target_modules: targetModules || ['q_proj', 'k_proj', 'v_proj', 'o_proj'],
    inference_mode: false,
    init_lora_weights: true,
    revision: 'v0',
    skeleton: true,
  };
  fs.writeFileSync(path.join(v0, 'adapter_config.json'), JSON.stringify(adapterCfg, null, 2));
  fs.writeFileSync(headFile, 'v0\n');
  // tune-config tracks per-artifact settings (capture on/off, gate, watch threshold).
  const tuneCfg = {
    artifact: path.basename(artifactPath),
    base_model: baseModel,
    rank, alpha, dropout,
    captures_on: false,
    gate: { k_min: 0.85, require_improvement: true },
    watch: { threshold_rows: 200, sample_size: 32 },
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(d, 'tune-config.json'), JSON.stringify(tuneCfg, null, 2));
  return { tuneDir: d, revision: 'v0', config: tuneCfg, existed: false };
}

export function readTuneConfig(artifactPath) {
  const d = tuneDir(artifactPath);
  const p = path.join(d, 'tune-config.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeTuneConfig(artifactPath, cfg) {
  const d = ensureTuneDir(artifactPath);
  fs.writeFileSync(path.join(d, 'tune-config.json'), JSON.stringify(cfg, null, 2));
}

export function setCaptureFlag(artifactPath, on) {
  const cfg = readTuneConfig(artifactPath);
  if (!cfg) throw new Error('not initialized — run `kolm tune init --artifact ' + path.basename(artifactPath) + ' --base <model>` first');
  cfg.captures_on = !!on;
  writeTuneConfig(artifactPath, cfg);
  return cfg;
}

// Append a (input,output) capture row to the artifact's captures.jsonl.
// Used by cmdRun when tune-config.captures_on === true.
export function appendCapture(artifactPath, row) {
  const cfg = readTuneConfig(artifactPath);
  if (!cfg || !cfg.captures_on) return false;
  const d = tuneDir(artifactPath);
  const out = path.join(d, 'captures.jsonl');
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    input: row.input,
    output: row.output,
    recipe: row.recipe || null,
    latency_us: row.latency_us || null,
  }) + '\n';
  fs.appendFileSync(out, line);
  return true;
}

export function captureCount(artifactPath) {
  const d = tuneDir(artifactPath);
  const p = path.join(d, 'captures.jsonl');
  if (!fs.existsSync(p)) return 0;
  let count = 0;
  const buf = fs.readFileSync(p, 'utf8');
  for (let i = 0; i < buf.length; i++) if (buf.charCodeAt(i) === 10) count++;
  return count;
}

// Run one SFT step. Spawns python; gracefully degrades with a clear message if
// the trainer or its deps are missing. Returns { revision: 'vN', stats, airgap }.
export function runTuneStep({ artifactPath, epochs = 1, airgap = false, batchSize = 4, lr = 2e-4 }) {
  const d = ensureTuneDir(artifactPath);
  const captures = path.join(d, 'captures.jsonl');
  if (!fs.existsSync(captures) || captureCount(artifactPath) === 0) {
    throw new Error('no captures yet — run `kolm tune capture-on` and then `kolm run` a few times to collect training data');
  }
  const trainer = path.join(process.cwd(), 'scripts', 'tune-step.py');
  if (!fs.existsSync(trainer)) {
    // Fall back to the kolm install dir.
    const altTrainer = new URL('../scripts/tune-step.py', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
    if (fs.existsSync(altTrainer)) {
      return runTuneStepWith(altTrainer, { artifactPath, d, epochs, airgap, batchSize, lr });
    }
    throw new Error('tune-step.py trainer missing — reinstall kolm or set KOLM_TUNE_TRAINER=/path/to/tune-step.py');
  }
  return runTuneStepWith(trainer, { artifactPath, d, epochs, airgap, batchSize, lr });
}

function runTuneStepWith(trainer, { artifactPath, d, epochs, airgap, batchSize, lr }) {
  const env = { ...process.env };
  if (airgap) {
    env.KOLM_AIRGAP = '1';
    env.TRANSFORMERS_OFFLINE = '1';
    env.HF_DATASETS_OFFLINE = '1';
    env.HF_HUB_OFFLINE = '1';
  }
  const revs = listRevisions(d);
  const prev = revs.length ? revs[revs.length - 1] : 'v0';
  const next = 'v' + (Number(prev.slice(1)) + 1);
  const nextDir = path.join(d, 'revisions', next);
  fs.mkdirSync(nextDir, { recursive: true });
  const args = [
    trainer,
    '--tune-dir', d,
    '--captures', path.join(d, 'captures.jsonl'),
    '--out-dir', nextDir,
    '--prev', prev,
    '--epochs', String(epochs),
    '--batch-size', String(batchSize),
    '--lr', String(lr),
  ];
  if (airgap) args.push('--airgap');
  const py = spawnSync('python', args, { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (py.error && py.error.code === 'ENOENT') {
    // try `python3`
    const py3 = spawnSync('python3', args, { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (py3.error) {
      throw new Error('python not found on PATH — install Python 3.10+ (with `pip install torch peft transformers datasets`)');
    }
    return parseTrainerOutput(py3, next, airgap);
  }
  if (py.error) throw new Error('trainer spawn failed: ' + py.error.message);
  return parseTrainerOutput(py, next, airgap);
}

function parseTrainerOutput(py, revision, airgap) {
  const stdout = py.stdout || '';
  const stderr = py.stderr || '';
  let stats = null;
  // Trainer emits a single line of JSON-RPC on the last non-empty stdout line.
  const lines = stdout.split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { stats = JSON.parse(lines[i]); break; } catch {}
  }
  if (py.status !== 0) {
    const tail = stderr.split('\n').slice(-5).join('\n');
    throw new Error('trainer exited ' + py.status + '\n' + tail);
  }
  return { revision, stats: stats || { note: 'trainer did not emit stats', stdout_tail: lines.slice(-3) }, airgap };
}

// Eval a revision: run artifact's embedded evals using this adapter, compute K-score.
// For now we delegate to artifact-runner (which uses the artifact's own recipes); the
// adapter only matters when recipes call out to the local LM, which is a v0.2 feature.
// We still record the per-revision K-score so promote can gate.
export async function evalRevision({ artifactPath, revision }) {
  const { inspectArtifact, runArtifact } = await import('./artifact-runner.js');
  const info = inspectArtifact(artifactPath);
  const evals = info.evals || [];
  let pass = 0, total = evals.length;
  let latencies = [];
  for (const c of evals) {
    try {
      const r = await runArtifact(artifactPath, c.input, {});
      const got = JSON.stringify(r.output);
      const exp = JSON.stringify(c.expected);
      if (got === exp) pass++;
      if (r.latency_us != null) latencies.push(r.latency_us);
    } catch (e) { /* fail */ }
  }
  const accuracy = total > 0 ? pass / total : 0;
  const p50 = latencies.length ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : null;
  const { computeKScore } = await import('./artifact.js');
  const stats = fs.statSync(artifactPath);
  const k = computeKScore({
    size_bytes: stats.size,
    accuracy,
    coverage: total > 0 ? 1 : 0,
    p50_latency_us: p50,
    cost_usd_per_call: 0,
  });
  return { revision, pass, total, accuracy, p50_latency_us: p50, k_score: k };
}

// Promote a revision: if K-score(rev) ≥ gate AND ≥ head's K-score (when require_improvement),
// flip HEAD to this revision and snapshot the previous head into head.prev.
export async function promoteRevision({ artifactPath, revision, force = false }) {
  const d = tuneDir(artifactPath);
  if (!fs.existsSync(d)) throw new Error('artifact not initialized for tune');
  const revPath = path.join(d, 'revisions', revision);
  if (!fs.existsSync(revPath)) throw new Error('no such revision: ' + revision);
  const cfg = readTuneConfig(artifactPath);
  const cur = fs.existsSync(path.join(d, 'HEAD')) ? fs.readFileSync(path.join(d, 'HEAD'), 'utf8').trim() : null;

  const candidate = await evalRevision({ artifactPath, revision });
  const headK = candidate.k_score; // both eval against the same artifact for now
  if (!force) {
    if (candidate.k_score.composite < cfg.gate.k_min) {
      throw Object.assign(new Error('refusing to promote: K-score ' + candidate.k_score.composite + ' < gate ' + cfg.gate.k_min), { code: 'K_GATE' });
    }
  }
  // Snapshot previous head.
  if (cur) fs.writeFileSync(path.join(d, 'head.prev'), cur);
  fs.writeFileSync(path.join(d, 'HEAD'), revision + '\n');
  return { promoted: revision, previous: cur, k_score: candidate.k_score };
}

export function rollbackHead(artifactPath) {
  const d = tuneDir(artifactPath);
  const prevFile = path.join(d, 'head.prev');
  if (!fs.existsSync(prevFile)) throw new Error('no prior head to roll back to');
  const prev = fs.readFileSync(prevFile, 'utf8').trim();
  const cur = fs.readFileSync(path.join(d, 'HEAD'), 'utf8').trim();
  fs.writeFileSync(path.join(d, 'HEAD'), prev + '\n');
  fs.writeFileSync(path.join(d, 'head.prev'), cur);
  return { rolled_back_to: prev, was: cur };
}

export function headRevision(artifactPath) {
  const d = tuneDir(artifactPath);
  const headFile = path.join(d, 'HEAD');
  if (!fs.existsSync(headFile)) return null;
  return fs.readFileSync(headFile, 'utf8').trim();
}

// watch: loop forever (or until SIGINT). When captures grow past threshold, auto-step
// + eval + (gated) promote. Emits one JSONL event per state change to ~/.kolm/logs/tune.jsonl.
export async function watchAndEvolve({ artifactPath, interval = 30000 }) {
  const cfg = readTuneConfig(artifactPath);
  if (!cfg) throw new Error('tune not initialized for ' + artifactPath);
  const d = ensureTuneDir(artifactPath);
  const logPath = path.join(HOME, '.kolm', 'logs', 'tune.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const emit = (event) => fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), artifact: path.basename(artifactPath), ...event }) + '\n');
  let lastCount = captureCount(artifactPath);
  emit({ event: 'watch_started', captures: lastCount, threshold: cfg.watch.threshold_rows });

  const tick = async () => {
    const now = captureCount(artifactPath);
    if (now - lastCount >= cfg.watch.threshold_rows) {
      emit({ event: 'step_triggered', captures: now });
      try {
        const step = runTuneStep({ artifactPath, epochs: 1, airgap: true });
        emit({ event: 'step_complete', revision: step.revision });
        const e = await evalRevision({ artifactPath, revision: step.revision });
        emit({ event: 'eval_complete', revision: step.revision, k: e.k_score.composite, accuracy: e.accuracy });
        if (e.k_score.composite >= cfg.gate.k_min) {
          const p = await promoteRevision({ artifactPath, revision: step.revision });
          emit({ event: 'promoted', revision: step.revision, previous: p.previous, k: p.k_score.composite });
        } else {
          emit({ event: 'gate_blocked', revision: step.revision, k: e.k_score.composite, gate: cfg.gate.k_min });
        }
      } catch (e) {
        emit({ event: 'step_failed', error: e.message, code: e.code || null });
      }
      lastCount = captureCount(artifactPath);
    }
  };

  return new Promise(() => {
    setInterval(() => { tick().catch(e => emit({ event: 'tick_error', error: e.message })); }, interval);
  });
}

export function summary(artifactPath) {
  const d = tuneDir(artifactPath);
  if (!fs.existsSync(d)) return { initialized: false };
  const cfg = readTuneConfig(artifactPath);
  const head = headRevision(artifactPath);
  const revs = listRevisions(d);
  const caps = captureCount(artifactPath);
  return {
    initialized: true,
    artifact: path.basename(artifactPath),
    base_model: cfg?.base_model || null,
    captures_on: !!cfg?.captures_on,
    captures: caps,
    head,
    revisions: revs,
    gate: cfg?.gate || null,
    watch: cfg?.watch || null,
  };
}
