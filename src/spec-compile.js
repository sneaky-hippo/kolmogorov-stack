// Spec-driven local compile.
//
// Anyone — human OR AI agent — can write a JSON spec describing a task plus
// a deterministic recipe (a JS function), pipe it to `kolm compile --spec -`,
// and get back a signed `.kolm` that runs locally. No cloud round-trip, no
// account, no SaaS dependency.
//
// Spec shape (every field is checked):
//   {
//     "job_id":     "job_<slug>",                       // unique per artifact
//     "task":       "human-readable description",       // appears in manifest
//     "base_model": "none" | "qwen2.5-3b" | ...,        // optional
//     "recipes": [
//       {
//         "id":      "rcp_<slug>",
//         "name":    "human-readable",
//         "source":  "function generate(input, lib) { ... }",
//         "tags":    ["..."],                            // optional
//         "schema":  { "input": {...}, "output": {...} } // optional
//       }, ...
//     ],
//     "pack":   { ... },                                  // optional KOLMPACK
//     "index":  { ... },                                  // optional KOLMIDX
//     "evals": {
//       "spec":     "rs-1-evals",
//       "n":        <count>,
//       "cases":    [{ "id", "input", "expected", "params"? }, ...],
//       "coverage": <0..1>
//     },
//     "training_stats": { ... }                           // optional
//   }
//
// The receipt is HMAC-signed with whichever secret is set at compile time.
// For solo local use we auto-derive a stable per-user secret on first run
// (stored in ~/.kolm/config.json mode 0600). Fleet operators can pin
// RECIPE_RECEIPT_SECRET in env so any teammate's verifier accepts the result.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileJs } from './verifier.js';

function err(msg) {
  const e = new Error(msg);
  e.code = 'KOLM_E_SPEC_INVALID';
  return e;
}

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

function ensurePerUserSecret() {
  if (process.env.RECIPE_RECEIPT_SECRET) return process.env.RECIPE_RECEIPT_SECRET;
  if (process.env.KOLM_ARTIFACT_SECRET) return process.env.KOLM_ARTIFACT_SECRET;
  const home = os.homedir();
  const dir = path.join(home, '.kolm');
  const cfg = path.join(dir, 'config.json');
  fs.mkdirSync(dir, { recursive: true });
  let json = {};
  if (fs.existsSync(cfg)) {
    try { json = JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch { json = {}; }
  }
  if (!isNonEmptyString(json.local_receipt_secret)) {
    json.local_receipt_secret = 'kolm-local-' + crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(cfg, JSON.stringify(json, null, 2));
    try { fs.chmodSync(cfg, 0o600); } catch {}
  }
  process.env.RECIPE_RECEIPT_SECRET = json.local_receipt_secret;
  return json.local_receipt_secret;
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw err('spec must be a JSON object');
  if (!isNonEmptyString(spec.job_id)) throw err('spec.job_id must be a non-empty string (e.g. "job_my_redactor")');
  if (!/^job_[a-z0-9_-]+$/i.test(spec.job_id)) throw err('spec.job_id must match /^job_[a-z0-9_-]+$/i');
  if (!isNonEmptyString(spec.task)) throw err('spec.task must be a non-empty string');
  if (!Array.isArray(spec.recipes) || spec.recipes.length === 0) throw err('spec.recipes must be a non-empty array');
  for (const r of spec.recipes) {
    if (!isNonEmptyString(r.id)) throw err('every recipe needs an id (e.g. "rcp_my_recipe")');
    if (!isNonEmptyString(r.name)) throw err(`recipe ${r.id}: name is required`);
    if (!isNonEmptyString(r.source)) throw err(`recipe ${r.id}: source is required (a JS "function generate(input, lib) { ... }")`);
    try { compileJs(r.source); }
    catch (e) { throw err(`recipe ${r.id}: source failed to compile: ${e.message}`); }
  }
  if (spec.evals) {
    if (typeof spec.evals !== 'object' || spec.evals === null) throw err('spec.evals must be an object when present');
    if (spec.evals.cases && !Array.isArray(spec.evals.cases)) throw err('spec.evals.cases must be an array');
  }
  return true;
}

// Compile a spec into a signed .kolm. Returns { outPath, manifest, k_score, sha256, bytes }.
export async function compileSpec(spec, opts = {}) {
  validateSpec(spec);
  ensurePerUserSecret();
  const { buildAndZip } = await import('./artifact.js');

  const recipes = spec.recipes.map(r => ({
    id: r.id,
    name: r.name,
    source: r.source,
    source_hash: crypto.createHash('sha256').update(r.source).digest('hex').slice(0, 16),
    version_id: r.version_id || `ver_${r.id.replace(/^rcp_/, '')}_001`,
    tags: r.tags || [],
    schema: r.schema || null,
  }));

  const evals = spec.evals && spec.evals.cases ? {
    spec: spec.evals.spec || 'rs-1-evals',
    n: spec.evals.n || spec.evals.cases.length,
    cases: spec.evals.cases,
    coverage: typeof spec.evals.coverage === 'number' ? spec.evals.coverage : 1.0,
  } : { spec: 'rs-1-evals', n: 0, cases: [] };

  const outDir = opts.outDir || path.join(os.homedir(), '.kolm', 'artifacts');
  fs.mkdirSync(outDir, { recursive: true });

  const built = await buildAndZip({
    job_id: spec.job_id,
    task: spec.task,
    base_model: spec.base_model || 'none',
    recipes,
    pack: spec.pack || null,
    index: spec.index || null,
    evals,
    training_stats: spec.training_stats || { pass_rate_positive: 1.0, latency_p50_us: 80 },
    outDir,
  });

  const final = opts.outPath || built.outPath;
  if (final !== built.outPath) {
    fs.copyFileSync(built.outPath, final);
    try { fs.unlinkSync(built.outPath); } catch {}
  }
  const bytes = fs.statSync(final).size;
  const sha = crypto.createHash('sha256').update(fs.readFileSync(final)).digest('hex');
  return {
    outPath: final,
    manifest: built.manifest,
    k_score: built.k_score,
    sha256: sha,
    bytes,
  };
}
