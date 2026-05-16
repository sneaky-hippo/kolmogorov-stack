// .kolm artifact packager.
//
// A `.kolm` is a signed zip containing:
//   manifest.json     - task descriptor, hashes, training stats, tier
//   recipes.json      - deterministic recipe pack (executed in a vm sandbox)
//   evals.json        - eval cases that ship inside the artifact
//   model.gguf        - base-model pointer record. v0.1 is recipe-tier so this
//                       is metadata only; the LoRA tier will resolve it to
//                       real weights at first launch.
//   lora.bin          - artifact-bound binary slot. v0.1 carries an optional
//                       behaviour pack here (KOLMPACK\x01 magic + length-
//                       prefixed UTF-8 JSON body — patterns, lookup tables,
//                       rule packs that recipes call into via `lib.pack`).
//                       The LoRA tier (v0.2+) will swap this for a real
//                       weight delta. Empty buffer when no pack is supplied.
//   index.sqlite-vec  - artifact-bound lookup slot. v0.1 carries an optional
//                       JSON lookup index (KOLMIDX\x01 magic + length-prefixed
//                       UTF-8 JSON body — keyword→recipe maps, embedded
//                       lookup tables that recipes call via `lib.index`).
//                       The retrieval tier (v0.3+) will swap this for a real
//                       sqlite-vec database. Empty buffer when no index supplied.
//   signature.sig     - HMAC chain bound to the artifact receipt
//   receipt.json      - 5-step HMAC chain, body sig, anchor list
//
// Tenant-runtime customisation: callers of runArtifact can supply a `params`
// object that recipes read via `lib.params`. The artifact does NOT embed
// tenant data — params are passed at run time, never re-signed, never
// persisted by the runtime. This lets any buyer customise an artifact for
// their use case (extra patterns, vertical-specific rules, allowlists) while
// the signed artifact stays the same byte-exact bundle the issuer published.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import archiver from 'archiver';
import { effectiveReceiptSecret, isProductionRuntime } from './env.js';
import { cidFromManifestHashes } from './cid.js';
import { buildArtifactCredential } from './provenance.js';

const ARTIFACT_SPEC = 'kolm-1';
const PACK_MAGIC = 'KOLMPACK\x01';
const INDEX_MAGIC = 'KOLMIDX\x01';

// Encode an optional behaviour pack for the lora.bin slot. Returns an empty
// Buffer when no pack is supplied so v0.1 artifacts that don't ship one are
// byte-stable with prior releases.
function encodePack(pack) {
  if (!pack || (typeof pack === 'object' && Object.keys(pack).length === 0)) return Buffer.alloc(0);
  const body = Buffer.from(JSON.stringify(pack), 'utf8');
  const head = Buffer.from(PACK_MAGIC, 'binary');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, len, body]);
}

function encodeIndex(index) {
  if (!index || (typeof index === 'object' && Object.keys(index).length === 0)) return Buffer.alloc(0);
  const body = Buffer.from(JSON.stringify(index), 'utf8');
  const head = Buffer.from(INDEX_MAGIC, 'binary');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, len, body]);
}

// Decode a pack or index buffer. Tolerates empty buffers (returns null) and
// throws on magic mismatch so a corrupt slot doesn't silently expose
// arbitrary bytes to recipes.
export function decodePack(buf) { return decodeContainer(buf, PACK_MAGIC); }
export function decodeIndex(buf) { return decodeContainer(buf, INDEX_MAGIC); }
function decodeContainer(buf, magic) {
  if (!buf || !buf.length) return null;
  if (buf.length < magic.length + 4) throw new Error('container too short');
  const head = buf.slice(0, magic.length).toString('binary');
  if (head !== magic) throw new Error(`container magic mismatch: expected ${JSON.stringify(magic)}`);
  const len = buf.readUInt32LE(magic.length);
  const body = buf.slice(magic.length + 4, magic.length + 4 + len);
  if (body.length !== len) throw new Error('container length mismatch');
  return JSON.parse(body.toString('utf8'));
}
// IMPORTANT: keep this in lock-step with router.js's RECEIPT_SECRET. The
// receipt the artifact builder seals here is verified by /v1/receipts/verify
// using that same secret — a mismatch produces "signature mismatch" + "chain
// hmac mismatch" failures even though both sides are byte-identical canonical
// JSON. The legacy KOLM_ARTIFACT_SECRET env name is still honoured for
// back-compat, but the default must match router.js's default.
let warnedMissingSignSecret = false;

function signSecret() {
  const secret = effectiveReceiptSecret({ includeLegacyArtifactSecret: true });
  if (secret) return secret;
  if (isProductionRuntime() && !warnedMissingSignSecret) {
    console.error('[artifact] WARNING: RECIPE_RECEIPT_SECRET not set - /v1/compile will 503. Set it on Railway env.');
    warnedMissingSignSecret = true;
  }
  return null;
}

function requireSignSecret() {
  const secret = signSecret();
  if (secret) return secret;
  const e = new Error('cannot build .kolm: RECIPE_RECEIPT_SECRET not set on server');
  e.statusCode = 503;
  throw e;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

// Compute the K-score — the visible scoreboard for "smallest artifact that
// still passes the tests wins." Implements the documented formula at
// /k-score: K = 0.40·A + 0.15·S + 0.15·L + 0.15·C + 0.15·V, on [0..1].
// Ship gate is 0.85; below that, kolm compile fails closed.
//
// Raw axes (kept on the manifest for downstream tooling):
//   accuracy:          verifier pass-rate on the training positives [0..1]
//   coverage:          fraction of declared task surface handled [0..1]
//   p50_latency_us:    median run-time per call
//   cost_usd_per_call: marginal $ at run-time (0 for pure-recipe)
//   size_bytes:        seal-time probe zip size (the zip before the manifest
//                      embeds the K-score itself); typically 64-100 bytes
//                      less than the final on-disk size. Stored on the
//                      manifest so K-score is deterministically recomputable
//                      from artifact bytes alone.
//
// Each non-fractional axis (S, L, C) is normalized to [0..1] via a smooth
// curve calibrated so that typical recipe-mode artifacts (~10KB, ~100us, $0)
// score near 1, and pathological cases asymptote toward 0:
//   S = max(0, 1 - log2(max(size_kb, 1)) / 30)   // 10KB->0.89, 1MB->0.67, 1GB->0.33
//   L = 1 / (1 + p50_us / 100000)                // 100us->1.0, 100ms->0.50
//   C = 1 / (1 + cost_per_call * 1000)           // $0->1.0, $0.001->0.50
// A and V are already on [0..1].
export function computeKScore({ size_bytes, accuracy, coverage, p50_latency_us, cost_usd_per_call }) {
  const acc = Math.max(0, Math.min(1, accuracy ?? 0));
  const cov = Math.max(0, Math.min(1, coverage ?? 0));
  const size_kb = Math.max(1, (size_bytes || 0) / 1024);
  const lat_us = p50_latency_us == null ? 100 : Math.max(0, p50_latency_us);
  const cost = Math.max(0, cost_usd_per_call ?? 0);
  const sNorm = Math.max(0, Math.min(1, 1 - Math.log2(size_kb) / 30));
  const lNorm = 1 / (1 + lat_us / 100000);
  const cNorm = 1 / (1 + cost * 1000);
  const composite = Number((0.40 * acc + 0.15 * sNorm + 0.15 * lNorm + 0.15 * cNorm + 0.15 * cov).toFixed(4));
  return {
    accuracy: Number(acc.toFixed(4)),
    coverage: Number(cov.toFixed(4)),
    p50_latency_us: p50_latency_us ?? null,
    cost_usd_per_call: cost_usd_per_call ?? 0,
    size_bytes: size_bytes || 0,
    size_score: Number(sNorm.toFixed(4)),
    latency_score: Number(lNorm.toFixed(4)),
    cost_score: Number(cNorm.toFixed(4)),
    composite,
    ships: composite >= 0.85,
    gate: 0.85,
    spec: 'k-score-1',
  };
}

// Build the artifact payload (the parts that end up *inside* the zip).
// Returns a list of {filename, content} entries plus the manifest.
//
// New in v0.1: a receipt.json file ships alongside signature.sig. The
// receipt binds (artifact_hash, eval_set_hash, eval_score, judge_id) via an
// HMAC chain so any third party can re-verify offline without trusting the
// runtime that produced the artifact.
function normalizeLicense(license) {
  if (!license) {
    return {
      id: 'LicenseRef-kolm-default-1.0',
      name: 'kolm default artifact license (1.0)',
      url: 'https://kolm.ai/license#artifact-default-1-0',
      allows: ['inference', 'evaluation', 'redistribution-with-attribution'],
      requires: ['preserve-receipt', 'preserve-attribution'],
      forbids: [],
    };
  }
  if (typeof license === 'string') {
    return { id: license, name: license, url: null, allows: [], requires: [], forbids: [] };
  }
  return {
    id: String(license.id || license.spdx || 'LicenseRef-unknown'),
    name: license.name ? String(license.name) : String(license.id || 'unknown'),
    url: license.url ? String(license.url) : null,
    allows: Array.isArray(license.allows) ? license.allows.map(String) : [],
    requires: Array.isArray(license.requires) ? license.requires.map(String) : [],
    forbids: Array.isArray(license.forbids) ? license.forbids.map(String) : [],
  };
}

export function buildPayload({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, k_score, judge_id, eval_score, tier, pack, index, target_device, train_device, license }) {
  const secret = requireSignSecret();
  const recipes_json = JSON.stringify({
    spec: 'rs-1',
    n: recipes.length,
    recipes: recipes.map(r => ({
      id: r.id,
      name: r.name,
      source: r.source,
      source_hash: r.source_hash,
      version_id: r.version_id,
      tags: r.tags || [],
      schema: r.schema || null,
    })),
  }, null, 2);

  // v0.1 'recipe' tier:
  //   - lora.bin carries an optional KOLMPACK behaviour pack (or stays empty)
  //   - index.sqlite-vec carries an optional KOLMIDX lookup index (or stays empty)
  // When the caller doesn't pass `pack`/`index`, both slots are empty buffers
  // so byte counts and hashes match prior recipe-tier artifacts exactly.
  const lora_bin = encodePack(pack);
  const index_bin = encodeIndex(index);

  // model.gguf is a pointer record, not weights. `kolm run` resolves it.
  const model_pointer = JSON.stringify({
    spec: ARTIFACT_SPEC,
    base_model: base_model || 'Qwen/Qwen2.5-3B-Instruct',
    runtime: 'cloud',
    note: 'pointer-only artifact; weights resolved on `kolm run` first launch.',
  }, null, 2);

  // evals.json — the "no eval, no compile" gate. Synthesized from the
  // user's positives at compile time; surfaced in the artifact so anyone
  // can recompute K-score by re-running them.
  const evals_obj = evals && evals.cases ? evals : {
    spec: 'rs-1-evals',
    n: 0,
    cases: [],
    notes: 'compile-time evals were not supplied; K-score uses synthesizer pass-rate only',
  };
  const evals_json = JSON.stringify(evals_obj, null, 2);
  const eval_set_hash = sha256(Buffer.from(evals_json));
  const _evalScore = (typeof eval_score === 'number')
    ? eval_score
    : (typeof evals_obj.coverage === 'number' ? evals_obj.coverage
      : (typeof training_stats?.pass_rate_positive === 'number' ? training_stats.pass_rate_positive : 0));
  const _judgeId = judge_id || process.env.KOLM_JUDGE_ID || 'kolm-pattern-synth-1';
  const _tier = tier || 'recipe';

  const hashes = {
    model_pointer: sha256(Buffer.from(model_pointer)),
    recipes_json: sha256(Buffer.from(recipes_json)),
    lora_bin: sha256(lora_bin),
    index_bin: sha256(index_bin),
    evals_json: eval_set_hash,
  };
  // Deterministic content-id over the per-file hashes — independent of the
  // K-score, signature, or receipt. Same content always produces the same
  // CID, even across signing key rotations.
  const cid = cidFromManifestHashes(hashes);

  const manifest = {
    spec: ARTIFACT_SPEC,
    job_id,
    task,
    created_at: new Date().toISOString(),
    runtime: 'cloud',  // becomes 'on-device' once Sprint 3 LoRA bridge ships
    base_model: base_model || 'Qwen/Qwen2.5-3B-Instruct',
    target_device: target_device || null,
    train_device: train_device || null,
    tier: _tier,
    judge_id: _judgeId,
    eval_score: Number(Math.max(0, Math.min(1, _evalScore)).toFixed(4)),
    recipes: {
      n: recipes.length,
      registry_hash: sha256(canonicalJson(recipes.map(r => ({ id: r.id, hash: r.source_hash })))),
    },
    lora: lora_pointer || null,
    recall: recall_namespace ? { namespace: recall_namespace } : null,
    training: training_stats || { distilled_pairs: 0, accuracy: null },
    evals: { n: evals_obj.n || (evals_obj.cases?.length || 0), spec: evals_obj.spec, hash: eval_set_hash },
    k_score: k_score || null,  // patched after zipping for the size_bytes axis
    license: normalizeLicense(license),
    cid,
    hashes,
  };
  const manifest_json = JSON.stringify(manifest, null, 2);
  const manifest_hash = sha256(Buffer.from(manifest_json));

  // The artifact_hash is the sha256 of the canonical join of every file
  // we are about to put in the zip (excluding signature.sig and receipt.json
  // which seal it). Computing it here lets the receipt bind to the artifact
  // *before* the zip is finalised, while the manifest_hash anchors the
  // legacy signature.sig.
  const artifact_hash = sha256(canonicalJson({
    manifest_hash,
    model_pointer_hash: manifest.hashes.model_pointer,
    recipes_json_hash: manifest.hashes.recipes_json,
    lora_bin_hash: manifest.hashes.lora_bin,
    index_bin_hash: manifest.hashes.index_bin,
    evals_json_hash: eval_set_hash,
  }));

  // Build the HMAC chain. Each step seals the previous step's output.
  const stepSeal = (step, input_hash, output_hash) => {
    const hmac = crypto.createHmac('sha256', secret)
      .update(canonicalJson({ step, input_hash, output_hash }))
      .digest('hex');
    return { step, input_hash, output_hash, hmac };
  };
  const taskHash = sha256(canonicalJson({ task: task || '' }));
  const seedsHash = sha256(canonicalJson({ training: training_stats || null }));
  const recipesHash = manifest.hashes.recipes_json;
  const evalsHash = eval_set_hash;
  const chain = [
    stepSeal('task',    sha256(canonicalJson({ spec: ARTIFACT_SPEC })), taskHash),
    stepSeal('seeds',   taskHash,    seedsHash),
    stepSeal('recipes', seedsHash,   recipesHash),
    stepSeal('evals',   recipesHash, evalsHash),
    stepSeal('package', evalsHash,   artifact_hash),
  ];

  // Receipt body — bound by the HMAC over (artifact_hash, eval_set_hash,
  // eval_score, judge_id, chain). The signed_by field identifies the current
  // HMAC key namespace; future asymmetric signatures should use a new
  // signature_alg value. Verifiers re-check both the chain and the body HMAC.
  const issued_at = new Date().toISOString();
  const receipt_id = crypto.randomUUID();
  const receiptBody = {
    kolm_version: '0.1',
    receipt_id,
    cid,
    artifact_hash,
    eval_set_hash,
    eval_score: manifest.eval_score,
    judge_id: _judgeId,
    tier: _tier,
    chain,
    anchors: [],
    signature_alg: 'hmac-sha256',
    signed_at: issued_at,
    signed_by: 'kolm-dev-hmac-1',
  };
  const bodyCanon = canonicalJson(receiptBody);
  const bodySig = crypto.createHmac('sha256', secret).update(bodyCanon).digest('hex');
  // For interop with the JSON Schema we keep the field name `signature` and
  // store the hex HMAC. Ed25519 can be added later as a new explicit
  // signature_alg value without mislabeling today's receipts.
  receiptBody.signature = bodySig;
  const receipt_json = JSON.stringify(receiptBody, null, 2);

  // Legacy signature.sig — kept for back-compat with v0 verifiers. The new
  // receipt.json supersedes it.
  const sig_payload = canonicalJson({
    spec: ARTIFACT_SPEC,
    manifest_hash,
    job_id,
    artifact_hash,
    eval_set_hash,
    eval_score: manifest.eval_score,
    judge_id: _judgeId,
  });
  const hmac = crypto.createHmac('sha256', secret).update(sig_payload).digest('hex');
  const signature = JSON.stringify({
    spec: ARTIFACT_SPEC,
    job_id,
    manifest_hash,
    artifact_hash,
    eval_set_hash,
    eval_score: manifest.eval_score,
    judge_id: _judgeId,
    hmac_alg: 'HMAC-SHA256',
    hmac,
    issued_at,
  }, null, 2);

  // Build an artifact-scoped provenance credential. Signed with the same
  // secret as the receipt chain. Shipped as a sidecar `credential.json` in
  // the zip (not embedded in receipt.json — receipt.json is already signed,
  // and we don't want to invalidate that signature).
  const credential = buildArtifactCredential({
    secret,
    artifact_hash,
    cid,
    k_score: manifest.k_score ?? null,
    base_model,
    signed_at: issued_at,
    judge_id: _judgeId,
    tier: _tier,
    ingredients: [],
  });
  const credential_json = JSON.stringify(credential, null, 2);

  return {
    manifest,
    receipt: receiptBody,
    credential,
    artifact_hash,
    cid,
    eval_set_hash,
    files: [
      { filename: 'manifest.json',    content: Buffer.from(manifest_json) },
      { filename: 'model.gguf',       content: Buffer.from(model_pointer) },
      { filename: 'recipes.json',     content: Buffer.from(recipes_json) },
      { filename: 'lora.bin',         content: lora_bin },
      { filename: 'index.sqlite-vec', content: index_bin },
      { filename: 'evals.json',       content: Buffer.from(evals_json) },
      { filename: 'signature.sig',    content: Buffer.from(signature) },
      { filename: 'receipt.json',     content: Buffer.from(receipt_json) },
      { filename: 'credential.json',  content: Buffer.from(credential_json) },
    ],
  };
}

// Stream the .kolm zip to a writable target (file path or HTTP response).
export function packageArtifact({ job_id, payload, outPath }) {
  return new Promise((resolve, reject) => {
    const target = outPath
      ? fs.createWriteStream(outPath)
      : null;
    const z = archiver('zip', { zlib: { level: 9 } });
    if (target) {
      z.pipe(target);
      target.on('close', () => resolve({ bytes: z.pointer() }));
    }
    z.on('warning', (e) => { if (e.code !== 'ENOENT') reject(e); });
    z.on('error', reject);
    for (const f of payload.files) {
      z.append(f.content, { name: f.filename });
    }
    z.finalize();
    if (!target) {
      // caller will pipe z elsewhere
      resolve({ archive: z });
    }
  });
}

// Convenience: build + zip in one step. Returns the zip path.
//
// We zip twice when k_score is requested: once to measure size, then again
// with the size-aware K-score patched into the manifest. The double-zip is
// cheap (≤10ms for 5KB artifacts) and keeps the K-score honest — the size
// axis includes the K-score bytes themselves.
export async function buildAndZip({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, outDir, judge_id, tier, pack, index, target_device, train_device, license }) {
  requireSignSecret();
  const dir = outDir || path.join(os.tmpdir(), 'kolm-artifacts');
  fs.mkdirSync(dir, { recursive: true });

  // Derive eval_score from the synthesis result. Pattern-mode synthesis
  // returns pass_rate_positive in [0..1]; the artifact tier defaults to
  // "recipe" (the only tier the Sprint-1 toolchain produces today —
  // adapter/specialist/bundle land in later sprints).
  const accuracy = training_stats?.pass_rate_positive ?? (training_stats?.verifier_accepted ? 1.0 : 0.0);
  const coverage = evals && evals.coverage != null ? evals.coverage : accuracy;
  const eval_score = (evals && typeof evals.coverage === 'number') ? evals.coverage : accuracy;
  const _tier = tier || 'recipe';
  const _judgeId = judge_id || process.env.KOLM_JUDGE_ID || 'kolm-pattern-synth-1';

  // Pass 1 — zip to measure size.
  const probePayload = buildPayload({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, judge_id: _judgeId, eval_score, tier: _tier, pack, index, target_device, train_device, license });
  const outPath = path.join(dir, `${job_id}.kolm`);
  await packageArtifact({ job_id, payload: probePayload, outPath });
  const probeBytes = fs.statSync(outPath).size;

  // K-score: derive accuracy/coverage/latency/cost from training stats and
  // any supplied evals. For Sprint 1 stub: pure-recipe artifacts have
  // cost=0 (no run-time API calls), latency = compiled-fn p50 ~50us, and
  // accuracy = synthesizer pass-rate. Coverage starts at the eval count
  // ratio; if no evals supplied, it equals accuracy (best-effort).
  const k_score = computeKScore({
    size_bytes: probeBytes,
    accuracy,
    coverage,
    p50_latency_us: training_stats?.latency_p50_us ?? 50,
    cost_usd_per_call: training_stats?.cost_usd_per_call ?? 0,
  });

  // Pass 2 — repackage with the K-score in the manifest. The K-score size
  // axis reflects the probe zip size (Pass 1); the final zip is typically
  // 64-100 bytes larger because the manifest now embeds the K-score JSON.
  // We do NOT mutate the manifest after writing — the returned manifest is
  // exactly what's inside the on-disk artifact, so a verifier recomputing
  // K-score from the artifact bytes will reproduce manifest.k_score
  // deterministically (size_bytes axis matches the embedded value).
  const finalPayload = buildPayload({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, k_score, judge_id: _judgeId, eval_score, tier: _tier, pack, index, target_device, train_device, license });
  await packageArtifact({ job_id, payload: finalPayload, outPath });
  const stat = fs.statSync(outPath);

  return {
    outPath,
    manifest: finalPayload.manifest,
    receipt: finalPayload.receipt,
    credential: finalPayload.credential,
    artifact_hash: finalPayload.artifact_hash,
    cid: finalPayload.cid,
    eval_set_hash: finalPayload.eval_set_hash,
    bytes: stat.size,
    k_score: finalPayload.manifest.k_score,
  };
}

export function verifyManifestSignature(manifest_json, signature) {
  const secret = signSecret();
  if (!secret) return { valid: false, reason: 'sign secret unavailable on server' };
  try {
    const sig = typeof signature === 'string' ? JSON.parse(signature) : signature;
    if (!sig || sig.spec !== ARTIFACT_SPEC || !sig.hmac) return { valid: false, reason: 'bad signature shape' };
    const manifest_hash = sha256(Buffer.from(manifest_json));
    if (manifest_hash !== sig.manifest_hash) return { valid: false, reason: 'manifest_hash mismatch' };
    const payloads = [];
    if (
      sig.artifact_hash &&
      sig.eval_set_hash &&
      typeof sig.eval_score === 'number' &&
      sig.judge_id
    ) {
      payloads.push({
        spec: ARTIFACT_SPEC,
        manifest_hash,
        job_id: sig.job_id,
        artifact_hash: sig.artifact_hash,
        eval_set_hash: sig.eval_set_hash,
        eval_score: sig.eval_score,
        judge_id: sig.judge_id,
      });
    }
    payloads.push({ spec: ARTIFACT_SPEC, manifest_hash, job_id: sig.job_id });

    for (const payload of payloads) {
      const expected = crypto.createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
      if (constantTimeEqualHex(sig.hmac, expected)) return { valid: true };
    }
    return { valid: false, reason: 'hmac mismatch' };
  } catch (e) {
    return { valid: false, reason: String(e.message || e) };
  }
}

function constantTimeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Device-fit verification. Given a manifest carrying target_device and the
// current host's detected device, return {ok, reason}. Two failure modes:
//   1. Hard fail: the model in this artifact cannot physically fit on the
//      host (vram too small, arch wrong).
//   2. Soft warn: the artifact was compiled for a different device of the
//      same class; performance won't match the K-score baseline.
export async function verifyDeviceFit(manifest, hostDeviceId) {
  if (!manifest) return { ok: false, reason: 'no manifest' };
  const target = manifest.target_device;
  if (!target) {
    return { ok: true, reason: 'no target_device pinned in manifest', soft: true };
  }
  if (!hostDeviceId) {
    return { ok: false, reason: 'host device could not be detected' };
  }
  if (target === hostDeviceId) {
    return { ok: true, reason: `exact match: ${target}` };
  }
  // Cross-device: load the device registry and check vram/arch.
  const D = await import('./devices.js');
  const tgtDev = D.info(target);
  const hostDev = D.info(hostDeviceId);
  if (!tgtDev || !hostDev) {
    return { ok: false, reason: `unknown device: target=${target} host=${hostDeviceId}` };
  }
  // Same class + host has >= vram of target -> ok with soft warn.
  if (hostDev.class === tgtDev.class &&
      (hostDev.vram_gb || 0) >= (tgtDev.vram_gb || 0)) {
    return {
      ok: true,
      reason: `host ${hostDeviceId} can run an artifact compiled for ${target} (same class, sufficient vram)`,
      soft: true,
    };
  }
  // Host has less vram than target -> hard fail.
  if ((hostDev.vram_gb || 0) < (tgtDev.vram_gb || 0)) {
    return {
      ok: false,
      reason: `host ${hostDeviceId} has ${hostDev.vram_gb}GB vram; artifact was compiled for ${target} (${tgtDev.vram_gb}GB)`,
    };
  }
  return {
    ok: true,
    reason: `host ${hostDeviceId} differs from compile target ${target}; proceeding`,
    soft: true,
  };
}
