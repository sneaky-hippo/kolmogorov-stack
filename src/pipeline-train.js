// Wave 361 — kolm train --watch: stream training progress as TrainEvents.
//
// Async iterator yielding TrainEvent = { step, name, status, detail?, hint? }.
//
// Two execution modes:
//
//   1. Local worker (workers/distill/distill.mjs or workers/quantize)
//      Spawns the worker as child_process and parses stderr for progress
//      markers. Workers emit [progress] epoch=N k=0.XX. The parser also
//      tolerates JSON-line emission ({"progress": {epoch, k}}).
//
//   2. Cloud job (when --job-id or KOLM_JOB_ID is set OR the spec asks for
//      a hosted run via base_model:"cloud:*").
//      Polls GET <base>/v1/jobs/:id every 2s and emits a progress event each
//      poll. The endpoint already exists (src/jobs.js).
//
// Auto-stop: when holdout K drops in TWO consecutive epochs, the iterator
// emits a `{status:'ok', detail:{auto_stop:true, reason:'overfit'}}` event
// and tells the local worker to stop (SIGINT). The best-K-so-far checkpoint
// is returned.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(dirname(__filename), '..');

const STEPS = [
  { step: 1, name: 'start training' },
  { step: 2, name: 'progress' },
  { step: 3, name: 'finalize' },
];

export async function* train(specPathOrJobRef, opts = {}) {
  // Cloud-job mode: opts.jobId OR specPathOrJobRef starts with "job:"
  if (opts.jobId || (typeof specPathOrJobRef === 'string' && specPathOrJobRef.startsWith('job:'))) {
    const id = opts.jobId || specPathOrJobRef.slice('job:'.length);
    yield* trainCloud(id, opts);
    return;
  }
  if (typeof specPathOrJobRef !== 'string') {
    yield ev(1, 'err', { error: 'spec path required' });
    return;
  }
  const specAbs = path.resolve(specPathOrJobRef);
  if (!fs.existsSync(specAbs)) {
    yield ev(1, 'err', { error: `spec not found: ${specAbs}` });
    return;
  }
  yield* trainLocal(specAbs, opts);
}

async function* trainLocal(specPath, opts) {
  yield ev(1, 'started', { spec: specPath, mode: 'local-worker' });
  const workerPath = opts.workerPath
    ? path.resolve(opts.workerPath)
    : path.join(ROOT, 'workers', 'distill', 'distill.mjs');
  if (!fs.existsSync(workerPath)) {
    yield ev(1, 'err', { error: `worker not found: ${workerPath}` }, 'pass --worker <path> or install workers/distill');
    return;
  }
  const outDir = opts.outDir || path.join(path.dirname(specPath), 'distill-out');
  fs.mkdirSync(outDir, { recursive: true });

  const args = [workerPath, '--spec', specPath, '--out', outDir, ...(opts.workerArgs || [])];
  if (opts.seedsPath) args.push('--seeds', opts.seedsPath);

  // Spawn. Set TERM=dumb so child does not try to ANSI-paint progress bars
  // (we already parse plain [progress] lines).
  const child = spawn(process.execPath, args, {
    env: { ...process.env, TERM: 'dumb', KOLM_TRAIN_WATCH: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  yield ev(1, 'ok', { pid: child.pid, worker: workerPath });

  // Bridge stdout + stderr into a unified line stream we can yield as
  // progress events. The async iterator pattern: queue events, resolve a
  // promise each line.
  const queue = [];
  let resolveNext = null;
  let done = false;
  let exitCode = null;

  function push(eobj) {
    if (resolveNext) { const r = resolveNext; resolveNext = null; r(eobj); }
    else queue.push(eobj);
  }

  const epochHistory = []; // [{epoch, k}]
  let bestEpoch = null;
  let bestK = -Infinity;
  let autoStopFired = false;

  function handleLine(line) {
    if (!line) return;
    // JSON-line progress
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line);
        if (j && j.progress && typeof j.progress.epoch === 'number') {
          const epoch = j.progress.epoch;
          const k = typeof j.progress.k === 'number' ? j.progress.k : null;
          recordEpoch(epoch, k);
          push(ev(2, 'ok', { epoch, k, best_epoch: bestEpoch, best_k: bestK === -Infinity ? null : bestK }));
          return;
        }
      } catch { /* fall through to text */ }
    }
    // Text progress: [progress] epoch=N k=0.XX
    const m = line.match(/\[progress\][^\n]*?epoch=(\d+)(?:[^\n]*?k=([0-9.]+))?/);
    if (m) {
      const epoch = Number(m[1]);
      const k = m[2] != null ? Number(m[2]) : null;
      recordEpoch(epoch, k);
      push(ev(2, 'ok', { epoch, k, best_epoch: bestEpoch, best_k: bestK === -Infinity ? null : bestK }));
      return;
    }
    // Heartbeat / non-progress lines: surface as a passthrough event when
    // they contain keywords the caller might want to render.
    if (/error|fail|warn/i.test(line)) {
      push(ev(2, 'err', { error: line.trim() }));
    }
  }

  function recordEpoch(epoch, k) {
    if (k != null) {
      epochHistory.push({ epoch, k });
      if (k > bestK) { bestK = k; bestEpoch = epoch; }
      // Auto-stop: two consecutive drops in holdout K.
      if (!autoStopFired && epochHistory.length >= 3) {
        const last3 = epochHistory.slice(-3);
        if (last3[2].k < last3[1].k && last3[1].k < last3[0].k) {
          autoStopFired = true;
          push(ev(2, 'ok', { auto_stop: true, reason: 'overfit', best_epoch: bestEpoch, best_k: bestK }));
          try { child.kill('SIGINT'); } catch (_) {}
        }
      }
    }
  }

  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (b) => {
    stdoutBuf += b.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      handleLine(stdoutBuf.slice(0, idx).trim());
      stdoutBuf = stdoutBuf.slice(idx + 1);
    }
  });
  child.stderr.on('data', (b) => {
    stderrBuf += b.toString('utf8');
    let idx;
    while ((idx = stderrBuf.indexOf('\n')) >= 0) {
      handleLine(stderrBuf.slice(0, idx).trim());
      stderrBuf = stderrBuf.slice(idx + 1);
    }
  });
  child.on('close', (code) => {
    exitCode = code;
    done = true;
    // flush any trailing buffer
    if (stdoutBuf.trim()) handleLine(stdoutBuf.trim());
    if (stderrBuf.trim()) handleLine(stderrBuf.trim());
    push(ev(3, code === 0 || autoStopFired ? 'ok' : 'err', { exit_code: code, auto_stop: autoStopFired, best_epoch: bestEpoch, best_k: bestK === -Infinity ? null : bestK, out_dir: outDir }));
  });

  // Pull events from the queue/promise loop until done + drained.
  while (true) {
    if (queue.length) { yield queue.shift(); continue; }
    if (done) return;
    yield await new Promise((resolve) => { resolveNext = resolve; });
  }
}

async function* trainCloud(jobId, opts) {
  const base = opts.base || process.env.KOLM_BASE || 'https://kolm.ai';
  const interval = Math.max(500, Number(opts.pollIntervalMs) || 2000);
  yield ev(1, 'started', { job_id: jobId, mode: 'cloud-poll', base });
  yield ev(1, 'ok', { job_id: jobId });

  const epochHistory = [];
  let bestEpoch = null, bestK = -Infinity, autoStop = false;
  let lastEpoch = -1;
  let polls = 0;
  const maxPolls = Number(opts.maxPolls) || 3600; // 2-hour cap at 2s
  while (polls < maxPolls) {
    polls++;
    let st;
    try { st = await getJson(`${base.replace(/\/+$/, '')}/v1/jobs/${encodeURIComponent(jobId)}`, opts.apiKey, opts.timeoutMs || 8000); }
    catch (e) {
      yield ev(2, 'err', { error: `poll failed: ${e.message}` });
      // brief backoff
      await sleep(interval);
      continue;
    }
    if (!st.ok) {
      yield ev(2, 'err', { error: `poll HTTP ${st.status}`, body: st.body });
      if (st.status === 404) { yield ev(3, 'err', { error: 'job not found' }); return; }
      await sleep(interval);
      continue;
    }
    const job = st.body || {};
    // Emit a progress event for each epoch we have not yet seen.
    const epoch = typeof job.epoch === 'number' ? job.epoch : (job.meta && typeof job.meta.epoch === 'number' ? job.meta.epoch : null);
    const k = typeof job.k === 'number' ? job.k : (job.meta && typeof job.meta.k === 'number' ? job.meta.k : null);
    if (epoch != null && epoch !== lastEpoch) {
      lastEpoch = epoch;
      if (k != null) {
        epochHistory.push({ epoch, k });
        if (k > bestK) { bestK = k; bestEpoch = epoch; }
      }
      yield ev(2, 'ok', { epoch, k, best_epoch: bestEpoch, best_k: bestK === -Infinity ? null : bestK });
      if (!autoStop && epochHistory.length >= 3) {
        const last3 = epochHistory.slice(-3);
        if (last3[2].k < last3[1].k && last3[1].k < last3[0].k) {
          autoStop = true;
          yield ev(2, 'ok', { auto_stop: true, reason: 'overfit', best_epoch: bestEpoch, best_k: bestK });
        }
      }
    }
    const status = job.status || 'unknown';
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      yield ev(3, status === 'completed' ? 'ok' : 'err', { status, job_id: jobId, best_epoch: bestEpoch, best_k: bestK === -Infinity ? null : bestK, artifact: job.artifact_path || null });
      return;
    }
    await sleep(interval);
  }
  yield ev(3, 'err', { error: 'max polls exceeded', best_epoch: bestEpoch, best_k: bestK === -Infinity ? null : bestK });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getJson(url, apiKey, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch (e) { return reject(new Error(`bad url ${url}: ${e.message}`)); }
    const isHttps = parsed.protocol === 'https:';
    Promise.resolve().then(async () => {
      const lib = await import(isHttps ? 'node:https' : 'node:http');
      const headers = { Accept: 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const req = lib.request({
        host: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: 'GET',
        headers,
        timeout: timeoutMs,
      }, (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(chunks); } catch { body = { raw: chunks }; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body });
        });
      });
      req.on('error', (e) => reject(e));
      req.on('timeout', () => { try { req.destroy(new Error('request timed out')); } catch (_) {} });
      req.end();
    }).catch(reject);
  });
}

function ev(step, status, detail, hint) {
  const meta = STEPS.find(s => s.step === step);
  const out = { step, name: meta ? meta.name : `step-${step}`, status };
  if (detail !== undefined) out.detail = detail;
  if (hint !== undefined) out.hint = hint;
  return out;
}
