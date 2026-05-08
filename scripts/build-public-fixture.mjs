// scripts/build-public-fixture.mjs
// Builds the public, reproducible fixture at test/fixtures/sample.kolm.
//
// Anyone with this repo + node + the documented RECIPE_RECEIPT_SECRET can
// reproduce this artifact byte-for-byte and run `kolm bench` against it.
// Used by /benchmarks to anchor a real, verifiable run.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PUBLIC_FIXTURE_SECRET = 'kolm-public-fixture-v0-1-0';
process.env.RECIPE_RECEIPT_SECRET = PUBLIC_FIXTURE_SECRET;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');

const { buildAndZip } = await import(pathToFileURL(path.join(repo, 'src/artifact.js')).href);

const recipeSource = "function generate(input, lib){ const t = (input && input.text) || ''; return { upper: t.toUpperCase() }; }";
const recipeHash = crypto.createHash('sha256').update(recipeSource).digest('hex').slice(0, 16);

const recipes = [{
  id: 'rcp_public_upper',
  name: 'public uppercase fixture',
  source: recipeSource,
  source_hash: recipeHash,
  version_id: 'ver_public_001',
  tags: ['public', 'fixture', 'demo'],
  schema: null,
}];

const evals = {
  spec: 'rs-1-evals',
  n: 4,
  cases: [
    { id: 'case-1', input: { text: 'hello' },     expected: { upper: 'HELLO' } },
    { id: 'case-2', input: { text: 'kolm' },      expected: { upper: 'KOLM' } },
    { id: 'case-3', input: { text: 'Kolmogorov' },expected: { upper: 'KOLMOGOROV' } },
    { id: 'case-4', input: { text: '' },          expected: { upper: '' } },
  ],
  coverage: 1.0,
};

const outDir = path.join(repo, 'test', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

const built = await buildAndZip({
  job_id: 'job_public_fixture_v0_1_0',
  task: 'public reproducible fixture: uppercase the input text',
  base_model: 'none',
  recipes,
  evals,
  training_stats: { pass_rate_positive: 1.0, latency_p50_us: 30 },
  outDir,
});

const finalPath = path.join(outDir, 'sample.kolm');
fs.copyFileSync(built.outPath, finalPath);

const bytes = fs.statSync(finalPath).size;
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex');
console.log(`built: ${finalPath}`);
console.log(`bytes: ${bytes}`);
console.log(`sha256: ${sha256}`);
console.log(`secret: RECIPE_RECEIPT_SECRET=${PUBLIC_FIXTURE_SECRET}`);
console.log(`k_score: ${built.k_score?.composite}`);
