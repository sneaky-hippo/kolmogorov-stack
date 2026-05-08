// .kolm artifact runner — opens a signed zip, verifies the signature, and
// executes one of its recipes against a given input. This is the "Run" leg
// of the four-engine compose: every other engine has fed forward; this is
// the one that actually emits an output for an end-user input.
//
// Usage from JS:
//   const r = await runArtifact('./support-triage.kolm', { text: '...' })
//   // r = { output, recipe_id, latency_us, k_score, receipt }
//
// Usage from CLI:
//   kolm run support-triage.kolm '{"text":"..."}'

import AdmZip from 'adm-zip';
import { compileJs } from './verifier.js';
import { verifyManifestSignature } from './artifact.js';

// Open a .kolm and return its contents as a structured bundle. Verifies the
// signature; throws if mangled.
export function loadArtifact(artifactPath) {
  const zip = new AdmZip(artifactPath);
  const entries = Object.fromEntries(zip.getEntries().map(e => [e.entryName, e.getData()]));

  const required = ['manifest.json', 'recipes.json', 'signature.sig'];
  for (const f of required) {
    if (!entries[f]) throw new Error(`malformed .kolm: missing ${f}`);
  }

  const manifest_json = entries['manifest.json'].toString('utf8');
  const recipes_json = entries['recipes.json'].toString('utf8');
  const signature = entries['signature.sig'].toString('utf8');
  const evals_json = entries['evals.json']?.toString('utf8') || null;
  const receipt_json = entries['receipt.json']?.toString('utf8') || null;
  const model_pointer = entries['model.gguf']?.toString('utf8') || null;

  const verification = verifyManifestSignature(manifest_json, signature);
  if (!verification.valid) {
    throw new Error(`signature invalid: ${verification.reason}`);
  }

  const manifest = JSON.parse(manifest_json);
  const recipes = JSON.parse(recipes_json);
  const evals = evals_json ? JSON.parse(evals_json) : null;
  const receipt = receipt_json ? JSON.parse(receipt_json) : null;
  const model = model_pointer ? (() => { try { return JSON.parse(model_pointer); } catch { return null; } })() : null;

  return {
    manifest,
    recipes,
    evals,
    receipt,
    model,
    signature_valid: true,
    artifact_path: artifactPath,
  };
}

// Run the artifact against a single input. Returns { output, recipe_id, latency_us, receipt }.
//
// Sprint 1 dispatch: try each recipe in order, return the first one that
// compiles + executes without throwing. Sprint 2 will add structural matching
// (input shape → recipe selection) and the LoRA fallback for fuzzy inputs.
export async function runArtifact(artifactPath, input) {
  const bundle = loadArtifact(artifactPath);
  const { recipes, manifest } = bundle;
  if (!recipes.recipes || !recipes.recipes.length) {
    throw new Error('artifact has no executable recipes');
  }

  const t0 = process.hrtime.bigint();
  let lastError = null;
  for (const r of recipes.recipes) {
    if (!r.source) continue;
    let fn;
    try { fn = compileJs(r.source); } catch (e) { lastError = `compile ${r.id}: ${e.message}`; continue; }
    try {
      const output = fn(input);
      const us = Number(process.hrtime.bigint() - t0) / 1000;
      return {
        output,
        recipe_id: r.id,
        recipe_name: r.name,
        latency_us: Math.round(us),
        k_score: manifest.k_score || null,
        receipt: {
          spec: 'rs-1-run',
          artifact_job_id: manifest.job_id,
          recipe_id: r.id,
          version_id: r.version_id,
          ran_at: new Date().toISOString(),
        },
      };
    } catch (e) {
      lastError = `run ${r.id}: ${e.message}`;
      continue;
    }
  }
  throw new Error('no recipe in artifact handled the input. last error: ' + lastError);
}

// Re-run the embedded eval suite against the artifact's recipes. This is
// what backs `kolm eval <artifact>` — recompute K-score axes from scratch
// to confirm the bundle still passes.
export async function evalArtifact(artifactPath) {
  const bundle = loadArtifact(artifactPath);
  const cases = bundle.evals?.cases || [];
  if (!cases.length) {
    return { n: 0, passed: 0, accuracy: 0, latencies_us: [], note: 'no evals embedded' };
  }
  const latencies = [];
  let passed = 0;
  const errors = [];
  for (const c of cases) {
    try {
      const t0 = process.hrtime.bigint();
      const r = await runArtifact(artifactPath, c.input);
      latencies.push(r.latency_us);
      if (deepEqual(r.output, c.expected)) passed++;
      else errors.push({ id: c.id, expected: c.expected, got: r.output });
    } catch (e) {
      errors.push({ id: c.id, error: String(e.message || e) });
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  return {
    n: cases.length,
    passed,
    accuracy: cases.length ? passed / cases.length : 0,
    p50_latency_us: p50,
    errors: errors.slice(0, 5),
  };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(a[k], b[k]));
  }
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return false;
}

// Return the manifest + recipe summary + K-score for a UI-style overview.
export function inspectArtifact(artifactPath) {
  const bundle = loadArtifact(artifactPath);
  return {
    artifact_path: artifactPath,
    spec: bundle.manifest.spec,
    job_id: bundle.manifest.job_id,
    task: bundle.manifest.task,
    runtime: bundle.manifest.runtime,
    base_model: bundle.manifest.base_model,
    created_at: bundle.manifest.created_at,
    recipes_n: bundle.recipes.n || (bundle.recipes.recipes?.length || 0),
    evals_n: bundle.evals?.cases?.length || 0,
    k_score: bundle.manifest.k_score,
    signature_valid: bundle.signature_valid,
    recipe_names: (bundle.recipes.recipes || []).slice(0, 8).map(r => r.name),
  };
}
