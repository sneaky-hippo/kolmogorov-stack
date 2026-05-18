#!/usr/bin/env node
// workers/distill/distill.mjs
//
// Wave J — isolated kolm distillation worker. Lives in its own package so
// the heavy ML deps (torch, transformers, peft, bitsandbytes, sentencepiece,
// accelerate, datasets) NEVER land in the root kolm install. The root CLI
// invokes this worker only when the tenant explicitly opts in via
// `kolm distill --local-worker`.
//
// Pipeline:
//   1. Read spec.json + seeds.jsonl
//   2. Split train/holdout deterministically (matches src/spec-compile.js
//      seed gate)
//   3. For each train row:
//        a. Redact PHI via src/phi-redactor.js (Q+3a)
//        b. Call teacher (Anthropic / OpenAI / local) via teacher-bridge
//        c. Reinject identifiers into teacher response
//        d. Append { input, teacher_output } to training-pairs.jsonl
//   4. Optional: invoke scripts/train_lora.py for the actual LoRA fine-tune.
//      ONLY runs when both python3 AND torch are detected. Otherwise stops
//      at step 3 and writes an honest manifest:
//        ml_pipeline_run: false
//        training_pairs_collected: <N>
//        next: "install torch + transformers + peft in a Python venv to run
//               the LoRA fine-tune; this worker remains the right entry"
//
// Modes:
//   --doctor           print toolchain readiness and exit
//   --mode=collect     run steps 1-3 (collect training pairs only)
//   --mode=stub        run steps 1-2 + emit deterministic stub manifest (no
//                      teacher calls; used in offline tests)
//   --mode=full        run 1-4 (requires Python ML stack present)
//
// Required flags for collect/full:
//   --spec <path>
//   --seeds <path>
//   --out <dir>
//   --teacher <vendor:model>     (or --no-teacher in stub mode)
//   --student-base <name>        (informational; recorded in manifest)
//
// Optional:
//   --max-rows <N>               cap teacher calls (default: 200)
//   --split-seed <int>           defaults to 1 (matches kolm compile)
//   --redact / --no-redact       default: --redact
//   --redact-class <class>       (wave 157) tag the redactor profile applied to this
//                                run: phi | pci | multi | none | auto. Recorded in
//                                manifest.redact_class so the artifact's verifier
//                                check #14 can confirm receipt-chain completeness
//                                (redaction_map_hash + teacher_call_log_hash +
//                                reinjection_log_hash all present when class != 'none').
//   --local-endpoint <url>       for vendor=local
//   --local-api-key <key>        for vendor=local
//   --teacher-holdout            (wave 145) invoke teacher on holdout inputs
//                                AFTER training-pair collection; record
//                                teacher_holdout_accuracy + teacher_holdout_log_hash
//                                in the manifest so the K-score T axis
//                                (student_holdout / teacher_holdout) is
//                                computable downstream. Comparator is
//                                exact-after-normalize by default.
//   --teacher-holdout-max <N>    cap teacher holdout calls (default: 50)
//   --teacher-holdout-comparator <name>
//                                exact (default) | substring | jaccard

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { callTeacher, parseTeacherSpec } from './teacher-bridge.mjs';
import {
  isKnownStudentBase,
  studentBaseEntry,
  isKnownDistillationMethod,
  DISTILLATION_METHODS,
  STUDENT_BASES,
  formatCatalogSummary,
} from './catalog.mjs';
// Wave 253 ML#7: delegate splitting to the canonical src/seeds.js so the
// distill worker and the build path agree on what holdout is. The legacy
// in-worker `splitSeeds` used a divergent `% 5` bucket scheme that did not
// match `src/seeds.js`'s 1000-bucket scheme, so a row that was "train" for the
// build was sometimes "holdout" for the distill worker. The audit flagged
// this as ML#7. The wrapper below preserves the (rows, splitSeed:number)
// signature this file calls with while delegating the actual logic.
import { splitSeeds as canonicalSplitSeeds } from '../../src/seeds.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..', '..');

const args = parseArgs(process.argv.slice(2));

if (args.doctor) {
  console.log(JSON.stringify(await doctor(), null, 2));
  process.exit(0);
}

// Wave 158 — `--list-catalog` prints the teacher vendor/model + student-base
// + distillation-method catalog and exits. Used by `kolm distill --list-catalog`
// surface so tenants don't have to crack open catalog.mjs.
if (args['list-catalog']) {
  console.log(formatCatalogSummary());
  process.exit(0);
}

const mode = args.mode || 'collect';
if (!['collect', 'stub', 'full'].includes(mode)) {
  fail(`unknown --mode=${mode}; expected collect | stub | full`);
}

const specPath  = args.spec  ? path.resolve(process.cwd(), args.spec)  : null;
const seedsPath = args.seeds ? path.resolve(process.cwd(), args.seeds) : null;
const outDir    = args.out   ? path.resolve(process.cwd(), args.out)   : null;

if (!specPath || !seedsPath || !outDir) {
  fail('--spec, --seeds, and --out are required (use --mode=stub for offline)');
}
if (!fs.existsSync(specPath))  fail(`spec not found: ${specPath}`);
if (!fs.existsSync(seedsPath)) fail(`seeds not found: ${seedsPath}`);

fs.mkdirSync(outDir, { recursive: true });

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const seeds = readSeeds(seedsPath);
const split = splitSeeds(seeds, Number(args['split-seed'] || 1));

// Summary form of the split: counts + hashes only, never row content. The
// full row content lives in (train|holdout).jsonl on disk so a downstream
// consumer (kolm compile --distill-provenance) can re-hash and confirm.
const splitSummary = {
  seeds_path: seedsPath,
  seeds_basename: path.basename(seedsPath),
  split_seed: Number(args['split-seed'] || 1),
  train_count: split.train.length,
  holdout_count: split.holdout.length,
  train_hash: rowsHash(split.train),
  holdout_hash: rowsHash(split.holdout),
};
writeJson(path.join(outDir, 'split.json'), splitSummary);
fs.writeFileSync(path.join(outDir, 'train.jsonl'),
  split.train.map(r => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'holdout.jsonl'),
  split.holdout.map(r => JSON.stringify(r)).join('\n') + '\n');

// Wave 158 — student-base catalog validation. Accepts catalog slugs OR any
// "org/repo" form (for HF repos that aren't in the catalog yet) when
// --allow-unknown-student-base is set. Default behavior: catalog only.
const studentBaseArg = args['student-base'] || null;
const allowUnknownBase = args['allow-unknown-student-base'] === true;
if (studentBaseArg && !isKnownStudentBase(studentBaseArg) && !allowUnknownBase) {
  fail(`unknown --student-base "${studentBaseArg}"; expected one of [${Object.keys(STUDENT_BASES).join(', ')}] or pass --allow-unknown-student-base`);
}

// Wave 158 — distillation method (record-only when ml_pipeline_run=false,
// authoritative when true). Defaults: 'lora' when --mode=full and ML stack
// present, 'prompt-distill' when collect mode only. Tenants can override
// (e.g., --distillation-method=qlora) so the receipt chain records what they
// actually ran with downstream scripts.
const distillMethodArg = args['distillation-method'] || null;
if (distillMethodArg && !isKnownDistillationMethod(distillMethodArg)) {
  fail(`unknown --distillation-method "${distillMethodArg}"; expected one of [${DISTILLATION_METHODS.join(', ')}]`);
}

// Wave 158 — optional --teacher-version + --student-base-revision pin the
// vendor's response version + the HF commit hash so a verifier can rebuild
// the exact corpus that produced the LoRA. Both are informational strings;
// validation is "non-empty if provided." Stored in receipt chain.
const teacherVersionArg = args['teacher-version'] || null;
const studentBaseRevArg = args['student-base-revision'] || null;

if (mode === 'stub') {
  const sbEntry = studentBaseArg && isKnownStudentBase(studentBaseArg) ? studentBaseEntry(studentBaseArg) : null;
  const manifest = {
    worker: 'kolm-distill-worker',
    worker_version: '0.1.0',
    mode: 'stub',
    spec_id: spec.job_id || null,
    teacher_vendor: null,
    teacher_model: null,
    teacher_version: null,
    student_base: studentBaseArg,
    student_base_repo: sbEntry ? sbEntry.repo : null,
    student_base_origin: sbEntry ? sbEntry.origin : null,
    student_base_license: sbEntry ? sbEntry.license : null,
    student_base_revision: studentBaseRevArg,
    distillation_method: null,
    ml_pipeline_run: false,
    training_pairs_collected: 0,
    redaction_map_hash: null,
    // wave 157 — stub mode never invokes the teacher so the redactor wasn't
    // exercised; redact_class is 'none' and the log hashes are null. Downstream
    // schema stays consistent (verifier check #14 treats absence-of-class as
    // not-applicable).
    redact_class: 'none',
    teacher_call_log_hash: null,
    reinjection_log_hash: null,
    split: splitSummary,
    // wave 145 — teacher-holdout fields always present as keys so downstream
    // schema is consistent across modes. Stub mode never calls a teacher, so
    // these stay null even when --teacher-holdout is passed.
    teacher_holdout_accuracy: null,
    teacher_holdout_count: null,
    teacher_holdout_log_hash: null,
    note: 'stub mode — no teacher calls were made; offline split/manifest only.',
    finished_at: new Date().toISOString(),
  };
  writeJson(path.join(outDir, 'manifest.json'), manifest);
  console.log(`[distill-worker] stub mode complete. wrote ${outDir}/manifest.json`);
  process.exit(0);
}

const teacherSpec = args.teacher;
if (!teacherSpec) fail('--teacher <vendor:model> required for collect/full mode (or use --mode=stub)');
const { vendor, model } = parseTeacherSpec(teacherSpec);
const redact = args['no-redact'] !== true; // default true
const maxRows = Number(args['max-rows'] || 200);

// wave 157 — record the redactor profile applied to this run so verifier
// check #14 can confirm the receipt chain matches the declared class. Default
// 'auto' when --redact is on (no explicit class), 'none' when --no-redact.
const VALID_REDACT_CLASSES = ['none', 'phi', 'pci', 'multi', 'auto'];
let redactClass = args['redact-class'];
if (redactClass && !VALID_REDACT_CLASSES.includes(redactClass)) {
  fail(`--redact-class must be one of [${VALID_REDACT_CLASSES.join(', ')}]; got ${redactClass}`);
}
if (!redactClass) redactClass = redact ? 'auto' : 'none';
if (!redact && redactClass !== 'none') {
  fail(`--no-redact conflicts with --redact-class=${redactClass}; pick one`);
}

const pairsPath = path.join(outDir, 'training-pairs.jsonl');
const teacherLogPath = path.join(outDir, 'teacher-call-log.jsonl');
const reinjectionLogPath = path.join(outDir, 'reinjection-log.jsonl');
const pairsOut = fs.createWriteStream(pairsPath, { flags: 'w' });
const logOut = fs.createWriteStream(teacherLogPath, { flags: 'w' });
const reinjectOut = fs.createWriteStream(reinjectionLogPath, { flags: 'w' });

let allMapHashes = [];
let collected = 0;

console.log(`[distill-worker] collecting ${Math.min(maxRows, split.train.length)} training pairs from teacher ${vendor}:${model}`);
for (let i = 0; i < Math.min(maxRows, split.train.length); i++) {
  const row = split.train[i];
  const inputText = typeof row.input === 'string' ? row.input : JSON.stringify(row.input);
  try {
    const r = await callTeacher({
      vendor, model,
      input: inputText,
      system: spec.system || '',
      redact,
      maxTokens: Number(args['max-tokens'] || 1024),
      localEndpoint: args['local-endpoint'],
      localApiKey: args['local-api-key'],
    });
    pairsOut.write(JSON.stringify({
      id: row.id || `train_${i + 1}`,
      input: row.input,
      teacher_output: r.response,
      seed_output: row.output,
    }) + '\n');
    logOut.write(JSON.stringify(r.teacher_call_log_entry) + '\n');
    // wave 157 — capture per-row reinjection metadata so an auditor can replay
    // the substitution offline. Stores token counts + a preservation_ok flag
    // (the callTeacher path already reinjected — this log captures whether
    // every input token was echoed back, so a tampered or dropping teacher
    // surfaces in the log). Never stores raw PHI; only the [PHI_*_n] token
    // identifiers.
    const inputTokens   = (r.teacher_call_log_entry.redacted_input || '').match(/\[PHI_[A-Z]+_\d+\]/g) || [];
    const outputTokens  = (r.teacher_call_log_entry.redacted_response || '').match(/\[PHI_[A-Z]+_\d+\]/g) || [];
    const inputUnique   = Array.from(new Set(inputTokens));
    const outputUnique  = Array.from(new Set(outputTokens));
    const preservationOk = inputUnique.every(t => outputUnique.includes(t));
    reinjectOut.write(JSON.stringify({
      row_index: i,
      id: row.id || `train_${i + 1}`,
      input_token_count: inputTokens.length,
      output_token_count: outputTokens.length,
      input_unique_tokens: inputUnique,
      output_unique_tokens: outputUnique,
      preservation_ok: preservationOk,
    }) + '\n');
    allMapHashes.push(r.redaction_map_hash);
    collected++;
    if (collected % 10 === 0) process.stderr.write(`  collected ${collected}\n`);
  } catch (e) {
    process.stderr.write(`  [skip ${i + 1}] ${e.message}\n`);
    logOut.write(JSON.stringify({ error: e.message, row_index: i }) + '\n');
  }
}
pairsOut.end();
logOut.end();
reinjectOut.end();

const combinedMapHash = 'sha256:' + crypto.createHash('sha256').update(allMapHashes.join('\n')).digest('hex');
const trainingPairsHash = fileSha256(pairsPath);
// wave 157 — hash the teacher-call-log and reinjection-log so the receipt
// chain can prove these files weren't modified after the worker wrote them.
const teacherCallLogHash = fileSha256(teacherLogPath);
const reinjectionLogHash = fileSha256(reinjectionLogPath);

let mlRun = false;
let mlReport = null;
if (mode === 'full') {
  const ready = await doctor();
  if (!ready.python_ok || !ready.torch_ok) {
    console.error('[distill-worker] python+torch required for --mode=full; falling back to collect-only.');
    console.error('  install hint: pip install torch transformers peft bitsandbytes accelerate datasets sentencepiece');
  } else {
    const pyScript = path.join(__dirname, 'scripts', 'train_lora.py');
    if (!fs.existsSync(pyScript)) {
      console.error(`[distill-worker] expected scripts/train_lora.py; not found.`);
    } else {
      console.log('[distill-worker] invoking Python LoRA trainer (this may take a while)...');
      const res = spawnSync('python3', [
        pyScript,
        '--pairs', pairsPath,
        '--out', path.join(outDir, 'student'),
        '--student-base', args['student-base'] || 'Qwen/Qwen2.5-0.5B',
      ], { stdio: 'inherit' });
      mlRun = res.status === 0;
      mlReport = { exit_code: res.status, signal: res.signal || null };
    }
  }
}

// wave 145 — optional teacher-holdout pass. When --teacher-holdout is set
// AND a teacher is configured, invoke teacher on holdout INPUTS and score
// teacher responses against holdout outputs. Produces:
//   teacher_holdout_log.jsonl  one entry per holdout call (redacted)
//   teacher_holdout_accuracy   number in [0,1]
//   teacher_holdout_count      int (rows scored)
//   teacher_holdout_log_hash   sha256 of the log file
// Downstream K-score V2 reads teacher_holdout_accuracy + (student) holdout
// accuracy and emits T = student/teacher fidelity ratio.
let teacherHoldoutAccuracy = null;
let teacherHoldoutCount = null;
let teacherHoldoutLogHash = null;
if (args['teacher-holdout'] && split.holdout.length > 0) {
  const thMax = Number(args['teacher-holdout-max'] || 50);
  const cap = Math.min(thMax, split.holdout.length);
  const comparator = (args['teacher-holdout-comparator'] || 'exact');
  const thLogPath = path.join(outDir, 'teacher-holdout-log.jsonl');
  const thLog = fs.createWriteStream(thLogPath, { flags: 'w' });
  let correct = 0;
  let counted = 0;
  console.log(`[distill-worker] scoring teacher on ${cap} holdout rows (comparator=${comparator})`);
  for (let i = 0; i < cap; i++) {
    const row = split.holdout[i];
    const inputText = typeof row.input === 'string' ? row.input : JSON.stringify(row.input);
    const expected  = typeof row.output === 'string' ? row.output : JSON.stringify(row.output);
    try {
      const r = await callTeacher({
        vendor, model,
        input: inputText,
        system: spec.system || '',
        redact,
        maxTokens: Number(args['max-tokens'] || 1024),
        localEndpoint: args['local-endpoint'],
        localApiKey: args['local-api-key'],
      });
      const ok = compareTeacherResponse(r.response, expected, comparator);
      if (ok) correct++;
      counted++;
      thLog.write(JSON.stringify({
        ...r.teacher_call_log_entry,
        holdout_index: i,
        comparator,
        correct: ok,
      }) + '\n');
    } catch (e) {
      thLog.write(JSON.stringify({ error: e.message, row_index: i, holdout_index: i }) + '\n');
    }
  }
  thLog.end();
  teacherHoldoutAccuracy = counted > 0 ? correct / counted : 0;
  teacherHoldoutCount = counted;
  teacherHoldoutLogHash = fileSha256(thLogPath);
  console.log(`[distill-worker] teacher holdout accuracy: ${(teacherHoldoutAccuracy * 100).toFixed(1)}% on ${counted} rows`);
}

// Wave 158 — compute the authoritative distillation_method. CLI arg wins;
// fallback derives from ml_pipeline_run (lora when trained, prompt-distill
// when only pairs collected).
const distillMethod = distillMethodArg || (mlRun ? 'lora' : 'prompt-distill');
const sbEntryFull = studentBaseArg && isKnownStudentBase(studentBaseArg) ? studentBaseEntry(studentBaseArg) : null;

const manifest = {
  worker: 'kolm-distill-worker',
  worker_version: '0.1.0',
  mode,
  spec_id: spec.job_id || null,
  teacher_vendor: vendor,
  teacher_model: model,
  // wave 158 — teacher_version pin (vendor's response version string when
  // provided; null otherwise). Receipt chain records verbatim.
  teacher_version: teacherVersionArg,
  student_base: studentBaseArg,
  // wave 158 — student-base catalog metadata. Recording the repo + origin +
  // license alongside the slug means the receipt chain self-describes the
  // weights' license terms instead of requiring an external lookup.
  student_base_repo: sbEntryFull ? sbEntryFull.repo : null,
  student_base_origin: sbEntryFull ? sbEntryFull.origin : null,
  student_base_license: sbEntryFull ? sbEntryFull.license : null,
  student_base_revision: studentBaseRevArg,
  // wave 158 — explicit distillation method (lora/qlora/full-ft/prompt-distill).
  // Verifier check #15 demands this field be present when ml_pipeline_run=true.
  distillation_method: distillMethod,
  redact,
  // wave 157 — redact_class + receipt-chain extension. Verifier check #14
  // requires all three log hashes when redact_class != 'none'.
  redact_class: redactClass,
  ml_pipeline_run: mlRun,
  ml_report: mlReport,
  training_pairs_collected: collected,
  training_pairs_path: path.relative(outDir, pairsPath),
  training_pairs_hash: trainingPairsHash,
  teacher_call_log_path: path.relative(outDir, teacherLogPath),
  teacher_call_log_hash: teacherCallLogHash,
  reinjection_log_path: path.relative(outDir, reinjectionLogPath),
  reinjection_log_hash: reinjectionLogHash,
  redaction_map_hash: combinedMapHash,
  teacher_holdout_accuracy: teacherHoldoutAccuracy,
  teacher_holdout_count: teacherHoldoutCount,
  teacher_holdout_log_hash: teacherHoldoutLogHash,
  split: splitSummary,
  finished_at: new Date().toISOString(),
};
writeJson(path.join(outDir, 'manifest.json'), manifest);
console.log(`[distill-worker] done. ${collected} pairs → ${pairsPath}`);
if (!mlRun) {
  console.log(`[distill-worker] ML training stage not run. next:`);
  console.log(`  cd workers/distill && pip install -r requirements.txt && \\`);
  console.log(`    python3 scripts/train_lora.py --pairs ${pairsPath} --out ${outDir}/student --student-base ${args['student-base'] || 'Qwen/Qwen2.5-0.5B'}`);
}
process.exit(0);

// ---------------------------------------------------------------------------
// Helpers (exported for tests via package.json#main re-export)
// ---------------------------------------------------------------------------
function readSeeds(p) {
  const txt = fs.readFileSync(p, 'utf8');
  const lines = txt.trim().split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const ln of lines) {
    try {
      const obj = JSON.parse(ln);
      // Normalize legacy {prompt, completion} to canonical {input, output}.
      if (obj.prompt !== undefined && obj.input === undefined) obj.input = obj.prompt;
      if (obj.completion !== undefined && obj.output === undefined) obj.output = obj.completion;
      if (obj.input !== undefined && obj.output !== undefined) rows.push(obj);
    } catch { /* skip malformed */ }
  }
  return rows;
}

function splitSeeds(rows, splitSeed) {
  // Wave 253 ML#7: delegate to the canonical implementation in src/seeds.js
  // so train/holdout assignments are identical across the build path and the
  // distill worker. The old divergent five-bucket scheme has been removed.
  const out = canonicalSplitSeeds(rows, { split_seed: String(splitSeed) });
  return { train: out.train, holdout: out.holdout };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function fileSha256(p) {
  if (!fs.existsSync(p)) return null;
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function rowsHash(rows) {
  const lines = rows.map(r => JSON.stringify({ input: r.input, output: r.output })).join('\n');
  return 'sha256:' + crypto.createHash('sha256').update(lines).digest('hex');
}

// Compare a teacher response to an expected output. Comparators kept simple
// because the worker should not pull in a heavyweight scoring lib — the goal
// is a reproducible accuracy number, not perfect semantic scoring. Tenants
// who want richer scoring run a follow-up evaluator outside the worker.
function compareTeacherResponse(actual, expected, comparator) {
  const a = String(actual ?? '').trim();
  const e = String(expected ?? '').trim();
  if (comparator === 'substring') {
    return a.toLowerCase().includes(e.toLowerCase()) || e.toLowerCase().includes(a.toLowerCase());
  }
  if (comparator === 'jaccard') {
    const toks = (s) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean));
    const A = toks(a); const E = toks(e);
    if (A.size === 0 && E.size === 0) return true;
    let inter = 0;
    for (const t of A) if (E.has(t)) inter++;
    const union = A.size + E.size - inter;
    return union > 0 && (inter / union) >= 0.7;
  }
  // default: exact-after-normalize (case-insensitive, whitespace collapsed)
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return norm(a) === norm(e);
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

async function doctor() {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  const python_ok = python.status === 0;
  let torch_ok = false;
  let torch_version = null;
  if (python_ok) {
    const t = spawnSync('python3', ['-c', 'import torch; print(torch.__version__)'], { encoding: 'utf8' });
    torch_ok = t.status === 0;
    torch_version = torch_ok ? (t.stdout || '').trim() : null;
  }
  let transformers_ok = false;
  if (python_ok) {
    const tr = spawnSync('python3', ['-c', 'import transformers; print(transformers.__version__)'], { encoding: 'utf8' });
    transformers_ok = tr.status === 0;
  }
  const node = process.versions.node;
  return {
    node_version: node,
    python_ok,
    python_version: python_ok ? (python.stdout || '').trim() : null,
    torch_ok,
    torch_version,
    transformers_ok,
    ready_for_full_pipeline: python_ok && torch_ok && transformers_ok,
    hint: (python_ok && torch_ok)
      ? null
      : 'install Python 3.10+ then: pip install torch transformers peft bitsandbytes accelerate datasets sentencepiece',
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[k] = next;
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`[distill-worker] ${msg}\n`);
  process.exit(2);
}
