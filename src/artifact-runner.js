// .kolm artifact runner — opens a signed zip, verifies the signature, and
// executes one of its recipes against a given input. This is the "Run" leg
// of the four-engine compose: every other engine has fed forward; this is
// the one that actually emits an output for an end-user input.
//
// Hard limits (v0.1):
//   - input payload     : 1 MiB
//   - per-recipe timeout: 1000 ms (cooperative)
//   - max recipes tried : artifact-defined (no upper bound, but each is timed)
//
// Errors carry a stable `code` so MCP clients and SDKs can branch on them:
//   KOLM_E_INPUT_TOO_LARGE   - input bytes exceeded MAX_INPUT_BYTES
//   KOLM_E_NO_RECIPES        - artifact has zero executable recipes
//   KOLM_E_NO_RECIPE_HANDLED - all recipes threw or timed out
//   KOLM_E_RECIPE_TIMEOUT    - a recipe exceeded the per-call timeout
//   KOLM_E_SIGNATURE_INVALID - signature failed to verify (thrown from loadArtifact)
//
// Usage from JS:
//   const r = await runArtifact('./support-triage.kolm', { text: '...' })
//   // r = { output, recipe_id, latency_us, k_score, receipt, audit }
//
// Usage from CLI:
//   kolm run support-triage.kolm '{"text":"..."}'

import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileJs } from './verifier.js';
import { verifyManifestSignature, decodePack, decodeIndex } from './artifact.js';

const MAX_INPUT_BYTES = 1024 * 1024;          // 1 MiB
const DEFAULT_TIMEOUT_MS = 1000;              // 1 s per recipe
const MAX_AUDIT_INPUT_PREVIEW = 200;

// Cloud-trusted artifacts (HMAC verify workaround). Cloud-built .kolms are
// signed with the server's RECIPE_RECEIPT_SECRET which the local CLI does not
// possess - so local HMAC verify would fail with KOLM_E_SIGNATURE_INVALID.
// When `kolm compile` (cloud path) downloads an artifact, it records the
// downloaded file's sha256 in ~/.kolm/cloud-trusted.json. loadArtifact()
// honors that trust list: structural integrity is still checked (manifest_hash
// must bind to the signature payload's claimed manifest_hash, and the
// signature must have the expected shape) but the HMAC step is skipped.
// Users can re-verify any time via `kolm verify --remote` once that is wired.
// Env override: KOLM_TRUST_CLOUD_ARTIFACTS=0 disables this fallback (strict
// mode). KOLM_TRUST_CLOUD_ARTIFACTS=1 (default) keeps the fallback.
const CLOUD_TRUST_PATH = path.join(os.homedir(), '.kolm', 'cloud-trusted.json');

function loadCloudTrust() {
  try {
    if (!fs.existsSync(CLOUD_TRUST_PATH)) return { trusted: {} };
    const j = JSON.parse(fs.readFileSync(CLOUD_TRUST_PATH, 'utf8'));
    if (!j || typeof j !== 'object' || !j.trusted || typeof j.trusted !== 'object') return { trusted: {} };
    return j;
  } catch { return { trusted: {} }; }
}

export function recordCloudTrusted(artifactPath, meta = {}) {
  try {
    const buf = fs.readFileSync(artifactPath);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const j = loadCloudTrust();
    j.trusted[sha] = {
      path: artifactPath,
      recorded_at: new Date().toISOString(),
      bytes: buf.length,
      ...meta,
    };
    fs.mkdirSync(path.dirname(CLOUD_TRUST_PATH), { recursive: true });
    fs.writeFileSync(CLOUD_TRUST_PATH, JSON.stringify(j, null, 2));
    try { fs.chmodSync(CLOUD_TRUST_PATH, 0o600); } catch {}
    return sha;
  } catch (e) {
    return null;
  }
}

export function isCloudTrusted(artifactBuf) {
  const flag = process.env.KOLM_TRUST_CLOUD_ARTIFACTS;
  if (flag === '0' || flag === 'false') return null;
  try {
    const sha = crypto.createHash('sha256').update(artifactBuf).digest('hex');
    const j = loadCloudTrust();
    return j.trusted[sha] ? sha : null;
  } catch { return null; }
}

// Convenience wrapper: returns the sha of the artifact at `artifactPath`
// if it is in the cloud-trust list, else null. Used by the verifier so the
// deeper HMAC checks (audit chain, credential) can switch to structural
// integrity mode without duplicating the file-read + sha logic.
export function isArtifactPathCloudTrusted(artifactPath) {
  try {
    const buf = fs.readFileSync(artifactPath);
    return isCloudTrusted(buf);
  } catch { return null; }
}

// Structural-integrity check used when HMAC verification fails but the
// artifact is in the cloud-trust list. Confirms the signature envelope is
// shaped correctly and that manifest_hash inside it matches the actual
// manifest bytes. This is NOT a cryptographic verification - it ensures the
// artifact bytes you have on disk are the bytes whose sha256 was trusted.
function structuralIntegrityOk(manifest_json, signature) {
  try {
    const sig = typeof signature === 'string' ? JSON.parse(signature) : signature;
    if (!sig || typeof sig !== 'object') return { ok: false, reason: 'signature not an object' };
    if (!sig.spec || !sig.hmac || !sig.manifest_hash) return { ok: false, reason: 'signature missing required fields' };
    const manifest_hash = crypto.createHash('sha256').update(Buffer.from(manifest_json)).digest('hex');
    if (manifest_hash !== sig.manifest_hash) return { ok: false, reason: 'manifest_hash mismatch' };
    return { ok: true };
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}

function kolmError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function inputBytes(input) {
  if (input == null) return 0;
  if (typeof input === 'string') return Buffer.byteLength(input, 'utf8');
  try { return Buffer.byteLength(JSON.stringify(input), 'utf8'); }
  catch { return Number.POSITIVE_INFINITY; }
}

function previewInput(input) {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    return s.length > MAX_AUDIT_INPUT_PREVIEW ? s.slice(0, MAX_AUDIT_INPUT_PREVIEW) + '…' : s;
  } catch { return '[unserializable]'; }
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Open a .kolm and return its contents as a structured bundle. Verifies the
// signature; throws if mangled.
export function loadArtifact(artifactPath) {
  const fileBuf = fs.readFileSync(artifactPath);
  const zip = new AdmZip(fileBuf);
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

  // Verify HMAC locally first. This works for offline-compiled artifacts
  // (signed with the per-user local_receipt_secret) and for fleet-shared
  // artifacts (signed with the shared RECIPE_RECEIPT_SECRET both sides have).
  const verification = verifyManifestSignature(manifest_json, signature);
  let signatureMode = 'hmac-local';
  if (!verification.valid) {
    // Cloud-trust fallback. When the artifact bytes match an entry recorded
    // by `kolm compile` (cloud path), accept the artifact - the cloud signed
    // it with RECIPE_RECEIPT_SECRET we don't have local access to, but we
    // downloaded it ourselves over an authenticated channel and recorded its
    // sha256. We still confirm structural integrity (signature envelope is
    // well-formed and manifest_hash binds to the manifest we're about to
    // execute) so a swapped-in malicious manifest is still rejected.
    const trustedSha = isCloudTrusted(fileBuf);
    if (trustedSha) {
      const integrity = structuralIntegrityOk(manifest_json, signature);
      if (!integrity.ok) {
        throw kolmError('KOLM_E_SIGNATURE_INVALID', `signature invalid (cloud-trust set, but structural integrity failed: ${integrity.reason})`);
      }
      signatureMode = 'cloud-trusted';
    } else {
      throw kolmError('KOLM_E_SIGNATURE_INVALID', `signature invalid: ${verification.reason}. If this artifact was downloaded via \`kolm compile\` (cloud), make sure the download finished and re-run \`kolm compile\` to refresh the local trust entry. Set KOLM_TRUST_CLOUD_ARTIFACTS=0 to disable the cloud-trust fallback.`);
    }
  }

  const manifest = JSON.parse(manifest_json);
  const recipes = JSON.parse(recipes_json);
  const evals = evals_json ? JSON.parse(evals_json) : null;
  const receipt = receipt_json ? JSON.parse(receipt_json) : null;
  const model = model_pointer ? (() => { try { return JSON.parse(model_pointer); } catch { return null; } })() : null;

  // Optional behaviour-pack and lookup-index slots. Missing or empty buffers
  // are normal for v0.1 'recipe' tier with no pack supplied.
  let pack = null;
  let index = null;
  try { pack = decodePack(entries['lora.bin']); }
  catch (e) { throw kolmError('KOLM_E_PACK_DECODE', `lora.bin pack decode failed: ${e.message}`); }
  try { index = decodeIndex(entries['index.sqlite-vec']); }
  catch (e) { throw kolmError('KOLM_E_INDEX_DECODE', `index.sqlite-vec decode failed: ${e.message}`); }

  return {
    manifest,
    recipes,
    evals,
    receipt,
    model,
    pack,
    index,
    signature_valid: true,
    signature_mode: signatureMode,
    artifact_path: artifactPath,
  };
}

// Run the artifact against a single input. Returns { output, recipe_id, latency_us, receipt, audit }.
//
// Recipe dispatch: try each recipe in order, return the first one that
// compiles + executes within the timeout without throwing. The artifact
// author orders recipes by specificity (most-specific first); the runner
// trusts that order.
//
// opts.timeoutMs   - per-recipe timeout (default 1000ms)
// opts.maxBytes    - input size cap (default 1 MiB)
// opts.audit       - optional audit-sink callback({ artifact_job_id, recipe_id, input_sha256, input_bytes, latency_us, ok })
export async function runArtifact(artifactPath, input, opts = {}) {
  const bundle = loadArtifact(artifactPath);
  const { recipes, manifest, pack, index } = bundle;
  if (!recipes.recipes || !recipes.recipes.length) {
    throw kolmError('KOLM_E_NO_RECIPES', 'artifact has no executable recipes');
  }

  const maxBytes = opts.maxBytes || MAX_INPUT_BYTES;
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const bytes = inputBytes(input);
  if (bytes > maxBytes) {
    throw kolmError('KOLM_E_INPUT_TOO_LARGE', `input ${bytes}B exceeds limit ${maxBytes}B`);
  }

  // Tenant-supplied parameters: any buyer can pass per-call config (extra
  // patterns, allowlists, vertical-specific rules) via opts.params or as
  // input.params on a structured input. Tenant params are NEVER persisted
  // by the runtime and never re-signed into the artifact.
  const params = opts.params || (input && typeof input === 'object' && !Array.isArray(input) ? input.params : null) || null;

  const inputSha = sha256Hex(Buffer.from(typeof input === 'string' ? input : JSON.stringify(input ?? null), 'utf8')).slice(0, 16);
  const t0 = process.hrtime.bigint();
  const tried = [];
  let lastError = null;

  for (const r of recipes.recipes) {
    if (!r.source) continue;
    let fn;
    try {
      fn = compileJs(r.source);
    } catch (e) {
      tried.push({ id: r.id, stage: 'compile', error: e.message });
      lastError = `compile ${r.id}: ${e.message}`;
      continue;
    }
    try {
      const output = fn(input, { timeout, pack, index, params });
      const us = Number(process.hrtime.bigint() - t0) / 1000;
      const audit = {
        spec: 'kolm-audit-1',
        artifact_job_id: manifest.job_id,
        recipe_id: r.id,
        recipe_name: r.name,
        input_sha256_prefix: inputSha,
        input_bytes: bytes,
        input_preview: previewInput(input),
        latency_us: Math.round(us),
        ran_at: new Date().toISOString(),
        ok: true,
      };
      if (typeof opts.audit === 'function') { try { opts.audit(audit); } catch {} }
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
        audit,
      };
    } catch (e) {
      const code = /exceeded \d+ms/.test(e.message || '') ? 'KOLM_E_RECIPE_TIMEOUT' : null;
      tried.push({ id: r.id, stage: 'run', error: e.message, code });
      lastError = `run ${r.id}: ${e.message}`;
      continue;
    }
  }

  const err = kolmError('KOLM_E_NO_RECIPE_HANDLED', `no recipe in artifact handled the input. tried ${tried.length}; last: ${lastError}`);
  err.tried = tried;
  if (typeof opts.audit === 'function') {
    try {
      opts.audit({
        spec: 'kolm-audit-1',
        artifact_job_id: manifest.job_id,
        input_sha256_prefix: inputSha,
        input_bytes: bytes,
        input_preview: previewInput(input),
        latency_us: Math.round(Number(process.hrtime.bigint() - t0) / 1000),
        ran_at: new Date().toISOString(),
        ok: false,
        error_code: 'KOLM_E_NO_RECIPE_HANDLED',
        tried,
      });
    } catch {}
  }
  throw err;
}

// Re-run the embedded eval suite against the artifact's recipes. This is
// what backs `kolm eval <artifact>` — recompute K-score axes from scratch
// to confirm the bundle still passes.
//
// opts.cases overrides the embedded cases (used by `kolm eval --examples <file>`
// to test against fresh data without touching the artifact). Pass an array of
// {id?, input, expected, params?} rows. Missing ids get auto-numbered so the
// failure printer always has something to anchor against.
export async function evalArtifact(artifactPath, opts = {}) {
  const bundle = loadArtifact(artifactPath);
  const embedded = bundle.evals?.cases || [];
  const cases = Array.isArray(opts.cases) && opts.cases.length
    ? opts.cases.map((c, i) => ({ id: c.id || `case_${i + 1}`, ...c }))
    : embedded;
  if (!cases.length) {
    return { n: 0, passed: 0, accuracy: 0, latencies_us: [], note: 'no evals embedded' };
  }
  const latencies = [];
  let passed = 0;
  const errors = [];
  for (const c of cases) {
    try {
      const r = await runArtifact(artifactPath, c.input, { params: c.params || opts.params });
      latencies.push(r.latency_us);
      if (matches(r.output, c.expected)) passed++;
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
    // Returning all errors so the CLI can decide how many to show (--trace
    // shows everything, default tops out at 5). Used to slice here, which
    // truncated --trace too.
    errors,
    source: Array.isArray(opts.cases) && opts.cases.length ? 'override' : 'embedded',
  };
}

// Subset-equal matcher mirroring verifier.verify's `matches`. Compile-time and
// runtime eval must use the same matcher or the user sees different pass counts
// from `kolm compile --spec` vs `kolm eval`. The verifier's logic is canonical;
// this is a copy because src/artifact-runner.js is the runtime hot path and we
// don't want it to pull the full verifier sandbox (vm, source guards, etc.)
// just for the matcher.
function matches(actual, expected) {
  if (expected === undefined || expected === null) return actual !== undefined;
  if (typeof expected === 'function') return expected(actual);
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (actual.length !== expected.length) return false;
    return actual.every((a, i) => matches(a, expected[i]));
  }
  if (typeof expected === 'object' && expected && typeof actual === 'object' && actual) {
    return Object.keys(expected).every(k => matches(actual[k], expected[k]));
  }
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(actual - expected) < 1e-6;
  }
  return actual === expected;
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
    tier: bundle.manifest.tier || 'recipe',
    base_model: bundle.manifest.base_model,
    created_at: bundle.manifest.created_at,
    recipes_n: bundle.recipes.n || (bundle.recipes.recipes?.length || 0),
    evals_n: bundle.evals?.cases?.length || 0,
    k_score: bundle.manifest.k_score,
    pack_present: !!bundle.pack,
    index_present: !!bundle.index,
    pack_keys: bundle.pack ? Object.keys(bundle.pack).slice(0, 8) : [],
    index_keys: bundle.index ? Object.keys(bundle.index).slice(0, 8) : [],
    signature_valid: bundle.signature_valid,
    signature_mode: bundle.signature_mode || 'hmac-local',
    recipe_names: (bundle.recipes.recipes || []).slice(0, 8).map(r => r.name),
    license: bundle.manifest.license || null,
  };
}
