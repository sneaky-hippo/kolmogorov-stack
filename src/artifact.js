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
// still passes the tests wins." We surface the five raw axes plus a single
// composite number so a UI can sort artifacts.
//
//   accuracy:        verifier pass-rate on the training positives [0..1]
//   coverage:        fraction of declared task surface the artifact handles [0..1]
//   p50_latency_us:  median run-time per call (recipe-mode = compiled fn; verified-mode = api round-trip)
//   cost_usd_per_call: marginal $ at run-time (0 for pure-recipe; >0 when routed through wrap/verified)
//   size_bytes:      total .kolm zip on disk
//
// composite is intentionally simple — bigger is better, smaller artifacts
// with higher accuracy/coverage win:
//   composite = (accuracy * coverage * 1000) / log2(size_kb + 2)
// A 5KB artifact at 100% accuracy/coverage scores ~588; a 50MB one scores ~62.
export function computeKScore({ size_bytes, accuracy, coverage, p50_latency_us, cost_usd_per_call }) {
  const acc = Math.max(0, Math.min(1, accuracy ?? 0));
  const cov = Math.max(0, Math.min(1, coverage ?? 0));
  const size_kb = (size_bytes || 0) / 1024;
  const denom = Math.log2(size_kb + 2);
  const composite = denom > 0 ? Number(((acc * cov * 1000) / denom).toFixed(2)) : 0;
  return {
    accuracy: Number(acc.toFixed(4)),
    coverage: Number(cov.toFixed(4)),
    p50_latency_us: p50_latency_us ?? null,
    cost_usd_per_call: cost_usd_per_call ?? 0,
    size_bytes: size_bytes || 0,
    composite,
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
export function buildPayload({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, k_score, judge_id, eval_score, tier, pack, index }) {
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
    base_model: base_model || 'qwen2.5-coder-7b-instruct-q4_0',
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

  const manifest = {
    spec: ARTIFACT_SPEC,
    job_id,
    task,
    created_at: new Date().toISOString(),
    runtime: 'cloud',  // becomes 'on-device' once Sprint 3 LoRA bridge ships
    base_model: base_model || 'qwen2.5-coder-7b-instruct-q4_0',
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
    hashes: {
      model_pointer: sha256(Buffer.from(model_pointer)),
      recipes_json: sha256(Buffer.from(recipes_json)),
      lora_bin: sha256(lora_bin),
      index_bin: sha256(index_bin),
      evals_json: eval_set_hash,
    },
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

  return {
    manifest,
    receipt: receiptBody,
    artifact_hash,
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
export async function buildAndZip({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, outDir, judge_id, tier, pack, index }) {
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
  const probePayload = buildPayload({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, judge_id: _judgeId, eval_score, tier: _tier, pack, index });
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

  // Pass 2 — repackage with the K-score in the manifest. Size delta is small
  // (~80 bytes); we re-derive K-score on the final artifact below.
  const finalPayload = buildPayload({ job_id, task, base_model, recipes, lora_pointer, recall_namespace, training_stats, evals, k_score, judge_id: _judgeId, eval_score, tier: _tier, pack, index });
  await packageArtifact({ job_id, payload: finalPayload, outPath });
  const stat = fs.statSync(outPath);

  // Final K-score reflects the actual on-disk size.
  finalPayload.manifest.k_score = computeKScore({
    size_bytes: stat.size,
    accuracy,
    coverage,
    p50_latency_us: training_stats?.latency_p50_us ?? 50,
    cost_usd_per_call: training_stats?.cost_usd_per_call ?? 0,
  });

  return {
    outPath,
    manifest: finalPayload.manifest,
    receipt: finalPayload.receipt,
    artifact_hash: finalPayload.artifact_hash,
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
