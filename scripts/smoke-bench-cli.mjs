// scripts/smoke-bench-cli.mjs
// End-to-end smoke for `kolm bench`: build a trivial .kolm artifact, run the
// three documented invocations against it (bench, bench --json, benchmark),
// and assert the report carries every field /benchmarks and /launch promise.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'smoke-bench-cli-secret';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');

const { buildAndZip } = await import(pathToFileURL(path.join(repo, 'src/artifact.js')).href);

const recipeSource = "function generate(input, lib){ const t = (input && input.text) || ''; return { upper: t.toUpperCase() }; }";
const recipeHash = crypto.createHash('sha256').update(recipeSource).digest('hex').slice(0, 16);

const recipes = [{
  id: 'rcp_smoke_upper',
  name: 'uppercase smoke',
  source: recipeSource,
  source_hash: recipeHash,
  version_id: 'ver_smoke_001',
  tags: ['smoke'],
  schema: null,
}];

const evals = {
  spec: 'rs-1-evals',
  n: 2,
  cases: [
    { id: 'case-1', input: { text: 'hello' }, expected: { upper: 'HELLO' } },
    { id: 'case-2', input: { text: 'kolm' },  expected: { upper: 'KOLM' } },
  ],
  coverage: 1.0,
};

const outDir = path.join(os.tmpdir(), 'kolm-smoke-bench');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const built = await buildAndZip({
  job_id: 'job_smoke_bench',
  task: 'smoke: uppercase the input text',
  base_model: 'none',
  recipes,
  evals,
  training_stats: { pass_rate_positive: 1.0, latency_p50_us: 30 },
  outDir,
});

console.log(`built: ${built.outPath} (${fs.statSync(built.outPath).size} bytes)`);

function runCli(args) {
  const result = spawnSync(process.execPath, [path.join(repo, 'cli/kolm.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, KOLM_BASE: 'http://127.0.0.1:0' },
  });
  if (result.status !== 0) {
    throw new Error(`kolm ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

const REQUIRED = [
  ['spec', r => r.spec === 'kolm-benchmark-1'],
  ['k_score', r => typeof r.k_score === 'number'],
  ['evals.accuracy', r => typeof r.evals?.accuracy === 'number'],
  ['latency_us.p50', r => typeof r.latency_us?.p50 === 'number'],
  ['latency_us.p95', r => typeof r.latency_us?.p95 === 'number'],
  ['privacy.runtime_egress_attempts', r => typeof r.privacy?.runtime_egress_attempts === 'number'],
  ['integrity.signature_valid', r => r.integrity?.signature_valid === true],
];

function assertReport(label, report) {
  console.log(`\n--- ${label} ---`);
  for (const [field, pred] of REQUIRED) {
    const ok = pred(report);
    const dot = ok ? 'PASS' : 'FAIL';
    console.log(`  [${dot}] ${field}`);
    if (!ok) {
      console.log(`         got: ${JSON.stringify(report[field.split('.')[0]])}`);
      throw new Error(`${label}: required field missing or wrong type: ${field}`);
    }
  }
  console.log(`  k_score=${report.k_score.toFixed(2)} accuracy=${report.evals.accuracy} p50=${report.latency_us.p50}us p95=${report.latency_us.p95}us egress=${report.privacy.runtime_egress_attempts}`);
}

console.log('\n[1/3] kolm bench <art.kolm>');
const r1 = runCli(['bench', built.outPath]);
assertReport('bench', r1);

console.log('\n[2/3] kolm bench <art.kolm> --json');
const r2 = runCli(['bench', built.outPath, '--json']);
assertReport('bench --json', r2);

console.log('\n[3/3] kolm benchmark <art.kolm>  (legacy alias)');
const r3 = runCli(['benchmark', built.outPath]);
assertReport('benchmark', r3);

if (r1.evals.accuracy !== 1.0) throw new Error(`expected accuracy 1.0, got ${r1.evals.accuracy}`);
if (r1.privacy.runtime_egress_attempts !== 0) throw new Error(`expected 0 egress, got ${r1.privacy.runtime_egress_attempts}`);

console.log('\nALL GREEN');
console.log(`spec=${r1.spec}  egress=${r1.privacy.runtime_egress_attempts}  signature_valid=${r1.integrity.signature_valid}`);
