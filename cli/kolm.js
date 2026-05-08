#!/usr/bin/env node
// kolm - the private AI compiler.
//
// One CLI. Eight verbs. Compiles, runs, evals, scores, and serves
// .kolm artifacts so frontier agents quietly call them via MCP.
//
//   kolm login                          auth -> ~/.kolm/config.json
//   kolm compile "<task>" [--data dir]  cloud compile -> download .kolm
//   kolm run <art.kolm> '<input-json>'  local artifact runner
//   kolm eval <art.kolm>                re-run embedded evals, recompute K-score
//   kolm benchmark <art.kolm>           emit reproducible artifact benchmark JSON
//   kolm score <art.kolm>               show K-score
//   kolm inspect <art.kolm>             manifest + recipes + signature
//   kolm serve [--mcp] [--http]         expose ~/.kolm/artifacts/* as MCP tools
//   kolm publish <art.kolm>             public gallery stub
//
// The whole point: humans run `kolm compile`; frontier models discover the
// result via `kolm serve --mcp` and call it without being asked.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import http from 'node:http';

const VERSION = '0.1.0';
const HOME = os.homedir();
const KOLM_DIR = path.join(HOME, '.kolm');
const CONFIG_PATH = path.join(KOLM_DIR, 'config.json');
const ARTIFACTS_DIR = path.join(KOLM_DIR, 'artifacts');

function ensureDir() {
  fs.mkdirSync(KOLM_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function loadConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_PATH)) return { base: process.env.KOLM_BASE || 'https://kolm.ai', api_key: process.env.KOLM_API_KEY || null };
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}
function saveConfig(c) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
}

function authHeaders(c) {
  return c.api_key ? { 'Authorization': 'Bearer ' + c.api_key } : {};
}

async function api(c, method, path_, body) {
  const url = c.base.replace(/\/+$/, '') + path_;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders(c) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) {
    const msg = json.error || json._raw || ('http ' + res.status);
    throw Object.assign(new Error(msg), { status: res.status, body: json });
  }
  return json;
}

// ---------- helpers ----------
function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / (1024 * 1024)).toFixed(1) + 'MB';
}

function fmtKScore(k) {
  if (!k) return '(no k-score)';
  return [
    `  composite: ${k.composite}`,
    `  accuracy:  ${(k.accuracy * 100).toFixed(1)}%`,
    `  coverage:  ${(k.coverage * 100).toFixed(1)}%`,
    `  size:      ${fmtBytes(k.size_bytes)}`,
    `  p50_lat:   ${k.p50_latency_us}us`,
    `  cost/call: $${k.cost_usd_per_call}`,
  ].join('\n');
}

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a); }));
}

function usage() {
  console.log(`kolm v${VERSION} - compile private AI behavior into the smallest signed artifact that passes the tests.

USAGE
  kolm <command> [args...]

COMMANDS
  login                            authenticate to a kolm cloud
  compile "<task>" [opts]          compile a task into a .kolm artifact
  run <art.kolm> '<input>'         execute a .kolm against an input
  eval <art.kolm>                  re-run embedded evals, print K-score
  benchmark <art.kolm> [opts]      emit artifact benchmark JSON
  score <art.kolm>                 print just the K-score
  inspect <art.kolm>               manifest + recipes + signature
  serve [--mcp] [--http] [--port]  expose ~/.kolm/artifacts/* as MCP tools
  publish <art.kolm>               push to public gallery (Sprint 4)
  config [base|api_key] [value]    inspect or set config
  version                          print version

COMPILE OPTIONS
  --data <dir>                 corpus dir to ground the compile in (Recall)
  --base-model <name>          base model (default: qwen2.5-coder-7b-instruct-q4_0)
  --examples <file.jsonl>      seed examples for the verifier
  --out <dir>                  where to drop the .kolm (default ~/.kolm/artifacts)

BENCHMARK OPTIONS
  --runs <n>                   runs per embedded eval case (default: 1)
  --input '<json-or-string>'    fallback input when the artifact has no evals
  --target <name>              target label for the report
  --device <name>              device label for the report
  --out <file>                 also write the JSON report to a file

ENVIRONMENT
  KOLM_BASE        cloud endpoint (default: https://kolm.ai)
  KOLM_API_KEY     bearer token (overrides ~/.kolm/config.json)
`);
}

// ---------- commands ----------
async function cmdLogin() {
  const c = loadConfig();
  console.log('kolm login - paste your API key from the cloud dashboard.');
  console.log(`Cloud: ${c.base}`);
  const key = (await prompt('API key (ks_...): ')).trim();
  if (!key.startsWith('ks_')) {
    console.error('error: API key must start with "ks_"');
    process.exit(1);
  }
  c.api_key = key;
  saveConfig(c);
  // sanity-check
  try {
    const a = await api(c, 'GET', '/v1/account');
    console.log(`logged in. tenant=${a.id || 'admin'} plan=${a.plan || '-'}`);
  } catch (e) {
    console.error('saved config but health check failed:', e.message);
  }
}

async function cmdCompile(args) {
  const c = loadConfig();
  if (!c.api_key) { console.error('not logged in. run: kolm login'); process.exit(1); }

  const task = args.find(a => !a.startsWith('--'));
  const dataIdx = args.indexOf('--data');
  const baseIdx = args.indexOf('--base-model');
  const exIdx = args.indexOf('--examples');
  const outIdx = args.indexOf('--out');

  const dataDir = dataIdx >= 0 ? args[dataIdx + 1] : null;
  const baseModel = baseIdx >= 0 ? args[baseIdx + 1] : null;
  const examplesPath = exIdx >= 0 ? args[exIdx + 1] : null;
  const outDir = outIdx >= 0 ? args[outIdx + 1] : ARTIFACTS_DIR;

  if (!task) { console.error('error: compile needs a task. e.g. kolm compile "triage support tickets"'); process.exit(1); }

  // Optional: if --data given, ingest first.
  let corpus_namespace = null;
  if (dataDir) {
    const ns = path.basename(path.resolve(dataDir));
    corpus_namespace = ns;
    console.log(`ingesting ${dataDir} into namespace "${ns}"`);
    try {
      const r = await api(c, 'POST', '/v1/embed', {
        namespace: ns,
        paths: [path.resolve(dataDir)],
      });
      const t = r.tokenized;
      console.log(`  added ${t.added}, skipped ${t.skipped}, ${r.embedded ? 'embedded' : 'NOT embedded (qmd absent; sidecars written)'}`);
    } catch (e) {
      console.error('  ingest failed (continuing without corpus):', e.message);
      corpus_namespace = null;
    }
  }

  let examples = [];
  if (examplesPath) {
    const lines = fs.readFileSync(examplesPath, 'utf-8').split(/\r?\n/).filter(Boolean);
    for (const ln of lines) {
      try { examples.push(JSON.parse(ln)); } catch { console.warn('  skipping malformed line:', ln); }
    }
    console.log(`loaded ${examples.length} examples from ${examplesPath}`);
  }

  console.log(`POST /v1/compile`);
  const job = await api(c, 'POST', '/v1/compile', {
    task,
    examples,
    corpus_namespace,
    base_model: baseModel,
  });
  console.log(`  job_id=${job.job_id} status=${job.status}`);

  // Poll
  let state;
  process.stdout.write('  ');
  for (let i = 0; i < 60; i++) {
    state = await api(c, 'GET', '/v1/compile/' + job.job_id);
    process.stdout.write(`[${state.progress}%] ${state.status} `);
    if (state.status === 'completed' || state.status === 'failed') break;
    await new Promise(r => setTimeout(r, 1000));
  }
  process.stdout.write('\n');
  if (state.status !== 'completed') {
    console.error('compile failed:', state.error || JSON.stringify(state, null, 2));
    process.exit(1);
  }

  // Download
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${state.id}.kolm`);
  const url = c.base.replace(/\/+$/, '') + state.artifact_url;
  const res = await fetch(url, { headers: authHeaders(c) });
  if (!res.ok) { console.error('download failed:', res.status); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  console.log(`wrote ${outPath} (${fmtBytes(buf.length)})`);
  console.log('K-score:');
  console.log(fmtKScore(state.k_score));
  console.log(`\nrun:    kolm run ${path.basename(outPath)} '<input-json>'`);
  console.log(`serve:  kolm serve --mcp     # frontier agents will see this skill`);
}

async function withRunner(fn) {
  const m = await import('../src/artifact-runner.js');
  return fn(m);
}

async function withBenchmark(fn) {
  const m = await import('../src/benchmark.js');
  return fn(m);
}

function resolveArtifact(p) {
  if (!p) return null;
  if (fs.existsSync(p)) return path.resolve(p);
  // Try ~/.kolm/artifacts/<arg>
  const cand = path.join(ARTIFACTS_DIR, p);
  if (fs.existsSync(cand)) return cand;
  const candKolm = cand.endsWith('.kolm') ? cand : cand + '.kolm';
  if (fs.existsSync(candKolm)) return candKolm;
  return null;
}

async function cmdRun(args) {
  const ap = resolveArtifact(args[0]);
  if (!ap) { console.error('error: artifact not found:', args[0]); process.exit(1); }
  const inputRaw = args[1];
  let input = null;
  if (inputRaw) {
    try { input = JSON.parse(inputRaw); }
    catch { input = inputRaw; } // pass as bare string
  }
  await withRunner(async ({ runArtifact }) => {
    const r = await runArtifact(ap, input);
    console.log(JSON.stringify({ output: r.output, recipe: r.recipe_name || r.recipe_id, latency_us: r.latency_us, k_score: r.k_score, receipt: r.receipt }, null, 2));
  });
}

async function cmdEval(args) {
  const ap = resolveArtifact(args[0]);
  if (!ap) { console.error('error: artifact not found:', args[0]); process.exit(1); }
  await withRunner(async ({ evalArtifact }) => {
    const r = await evalArtifact(ap);
    console.log(JSON.stringify(r, null, 2));
  });
}

async function cmdBenchmark(args) {
  const ap = resolveArtifact(args[0]);
  if (!ap) { console.error('error: artifact not found:', args[0]); process.exit(1); }

  const value = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const inputRaw = value('--input');
  let input;
  if (inputRaw !== undefined) {
    try { input = JSON.parse(inputRaw); }
    catch { input = inputRaw; }
  }

  await withBenchmark(async ({ benchmarkArtifact }) => {
    const report = await benchmarkArtifact(ap, {
      runs: value('--runs'),
      input,
      target: value('--target'),
      device: value('--device'),
      outPath: value('--out'),
    });
    console.log(JSON.stringify(report, null, 2));
  });
}

async function cmdScore(args) {
  const ap = resolveArtifact(args[0]);
  if (!ap) { console.error('error: artifact not found:', args[0]); process.exit(1); }
  await withRunner(async ({ inspectArtifact }) => {
    const m = inspectArtifact(ap);
    console.log(`task: ${m.task}`);
    console.log(fmtKScore(m.k_score));
  });
}

async function cmdInspect(args) {
  const ap = resolveArtifact(args[0]);
  if (!ap) { console.error('error: artifact not found:', args[0]); process.exit(1); }
  await withRunner(async ({ inspectArtifact }) => {
    const m = inspectArtifact(ap);
    console.log(JSON.stringify(m, null, 2));
  });
}

async function cmdServe(args) {
  const useMcp = args.includes('--mcp');
  const useHttp = args.includes('--http');
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8765;

  if (!useMcp) {
    console.error('error: only --mcp transport is implemented in Sprint 1. use: kolm serve --mcp');
    process.exit(1);
  }
  const { startMcpServer } = await import('../services/mcp/server.js');
  await startMcpServer({ artifactsDir: ARTIFACTS_DIR, http: useHttp, port });
}

function cmdPublish(args) {
  console.log('kolm publish: public gallery is not implemented yet. For now, share the .kolm file directly.');
  console.log('artifact:', args[0] || '(specify path)');
}

function cmdConfig(args) {
  const c = loadConfig();
  if (args.length === 0) {
    console.log(JSON.stringify({ base: c.base, api_key: c.api_key ? c.api_key.slice(0, 6) + '...(set)' : null }, null, 2));
    return;
  }
  const [k, v] = args;
  if (!['base', 'api_key'].includes(k)) {
    console.error('config keys: base, api_key');
    process.exit(1);
  }
  if (v === undefined) {
    console.log(c[k] || null);
    return;
  }
  c[k] = v;
  saveConfig(c);
  console.log('saved');
}

// ---------- dispatch ----------
async function main() {
  const [, , cmd, ...rest] = process.argv;
  try {
    switch (cmd) {
      case 'login':    await cmdLogin(); break;
      case 'compile':  await cmdCompile(rest); break;
      case 'run':      await cmdRun(rest); break;
      case 'eval':     await cmdEval(rest); break;
      case 'benchmark': await cmdBenchmark(rest); break;
      case 'score':    await cmdScore(rest); break;
      case 'inspect':  await cmdInspect(rest); break;
      case 'serve':    await cmdServe(rest); break;
      case 'publish':  cmdPublish(rest); break;
      case 'config':   cmdConfig(rest); break;
      case 'version':
      case '--version':
      case '-v':       console.log('kolm v' + VERSION); break;
      case 'help':
      case '--help':
      case '-h':
      case undefined:  usage(); break;
      default:         console.error('unknown command:', cmd); usage(); process.exit(1);
    }
  } catch (e) {
    console.error('error:', e.message);
    if (process.env.KOLM_DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

main();
