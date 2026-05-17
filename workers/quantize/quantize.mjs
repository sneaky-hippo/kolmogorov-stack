#!/usr/bin/env node
// workers/quantize/quantize.mjs
//
// Wave 195 (Q+5): isolated kolm quantization worker. Lives in its own
// package so the heavy ML deps (bitsandbytes, auto-gptq, optimum, torch,
// accelerate) NEVER land in the root kolm install. The root CLI invokes
// this worker only when the tenant explicitly opts in via
// `kolm quantize --local-worker`.
//
// Modes:
//   --doctor           print toolchain readiness and exit
//   (default)          read --in / --out / --method and either invoke
//                      scripts/quantize.py when present + deps satisfied,
//                      or emit an honest "not_yet_wired" manifest naming
//                      what is missing.
//
// Supported methods (mirrors workers/distill semantics):
//   int4    bitsandbytes 4-bit weight quantization
//   int8    bitsandbytes 8-bit weight quantization
//   gptq    auto-gptq post-training quantization
//   awq     AutoAWQ activation-aware weight quantization
//
// Honest-scope contract:
//   * kolm ships the Node entrypoint + dep detection + honest manifest. The
//     python script (scripts/quantize.py) is OUT OF SCOPE for wave 195 and
//     is left to the customer to drop in. The worker handles the absence
//     gracefully: running the verb today returns a "scaffolding present,
//     python script not yet shipped" manifest with no crash.
//   * The Python ML stack must be installed by the customer in a separate
//     venv at workers/quantize/.venv (see README.md). kolm does not pip
//     install on the customer's behalf.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const VALID_METHODS = ['int4', 'int8', 'gptq', 'awq'];
const WORKER_NAME    = 'kolm-quantize-worker';
const WORKER_VERSION = '0.1.0';

const args = parseArgs(process.argv.slice(2));
const wantJson = args.json === true;

if (args.doctor) {
  const report = await doctor();
  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[${WORKER_NAME}] doctor report`);
    console.log(`  node_version:    ${report.node_version}`);
    console.log(`  python_ok:       ${report.python_ok}` + (report.python_version ? ` (${report.python_version})` : ''));
    console.log(`  torch_ok:        ${report.torch_ok}` + (report.torch_version ? ` (${report.torch_version})` : ''));
    console.log(`  bitsandbytes_ok: ${report.bitsandbytes_ok}`);
    console.log(`  ready:           ${report.ready_for_quantize}`);
    if (report.hint) console.log(`  hint:            ${report.hint}`);
  }
  process.exit(report.ready_for_quantize ? 0 : 1);
}

const method = args.method || 'int4';
if (!VALID_METHODS.includes(method)) {
  fail(`unknown --method=${method}; expected one of [${VALID_METHODS.join(', ')}]`);
}

const inDir  = args.in  ? path.resolve(process.cwd(), args.in)  : null;
const outDir = args.out ? path.resolve(process.cwd(), args.out) : null;

const report = await doctor();
const pyScript = path.join(__dirname, 'scripts', 'quantize.py');
const pyScriptExists = fs.existsSync(pyScript);

if (!report.ready_for_quantize || !pyScriptExists) {
  // Honest manifest: scaffolding present, python path NOT YET WIRED.
  const manifest = {
    worker: WORKER_NAME,
    worker_version: WORKER_VERSION,
    method,
    in:  inDir,
    out: outDir,
    ml_pipeline_run: false,
    api_status: 'not_yet_wired',
    python_script_present: pyScriptExists,
    doctor: report,
    note: pyScriptExists
      ? 'python stack missing; install workers/quantize/requirements.txt in a venv'
      : 'scripts/quantize.py not yet shipped with this worker; kolm ships the scaffolding, the python heavy lifting is the customer opt-in',
    next: pyScriptExists
      ? 'cd workers/quantize && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt'
      : 'drop a scripts/quantize.py in workers/quantize/ that takes --method --in --out and runs the chosen quantizer',
    finished_at: new Date().toISOString(),
  };
  if (outDir) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'quantize-manifest.json'), JSON.stringify(manifest, null, 2));
    } catch { /* swallow; the manifest still prints to stdout */ }
  }
  if (wantJson) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(`[${WORKER_NAME}] quantize ${method} not run.`);
    console.log(`  reason: ${manifest.note}`);
    console.log(`  next:   ${manifest.next}`);
  }
  // Honest exit: 0 because the worker did exactly what it documents (emit a
  // scaffolding manifest). The CLI surfaces the "scaffolding-only" status
  // back to the user via the manifest body, not via an error code.
  process.exit(0);
}

// Python ready + script present: invoke it. kolm does not interpret the
// script's output beyond exit code; the script writes its own quantized
// weights to --out.
console.log(`[${WORKER_NAME}] invoking python quantizer (method=${method})`);
const res = spawnSync('python3', [
  pyScript,
  `--method=${method}`,
  `--in=${inDir}`,
  `--out=${outDir}`,
], { stdio: 'inherit' });
process.exit(res.status ?? 1);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
  let bitsandbytes_ok = false;
  if (python_ok) {
    const bnb = spawnSync('python3', ['-c', 'import bitsandbytes; print(bitsandbytes.__version__)'], { encoding: 'utf8' });
    bitsandbytes_ok = bnb.status === 0;
  }
  return {
    node_version: process.versions.node,
    python_ok,
    python_version: python_ok ? (python.stdout || '').trim() : null,
    torch_ok,
    torch_version,
    bitsandbytes_ok,
    ready_for_quantize: python_ok && torch_ok && bitsandbytes_ok,
    hint: (python_ok && torch_ok && bitsandbytes_ok)
      ? null
      : 'install Python 3.10+ then: cd workers/quantize && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
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
  process.stderr.write(`[${WORKER_NAME}] ${msg}\n`);
  process.exit(2);
}
