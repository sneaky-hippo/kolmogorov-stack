// src/auditor-attestation.js
//
// Wave 166 (N+7) — third-party auditor attestation. The eval-credibility
// ladder Wave 144 Doc 2 §7 named five tiers; N+7 is the top tier above
// tenant shadow (W165):
//
//   N+1.5 / Q+2  - tenant seeds.jsonl train/holdout split (src/seeds.js)
//   N+3          - external public benchmark holdouts (src/external-holdout.js)
//   N+4          - adversarial cross-family LLM-pair holdouts (W164)
//   N+5          - tenant shadow corpus (src/tenant-holdout.js)
//   N+6          - teacher-delta T axis (W160)
//   N+7          - THIRD-PARTY AUDITOR ATTESTATION (this module)
//
// The distinguishing property of N+7: the signature comes from a party OTHER
// than the kolm builder. The builder's own Ed25519 signature (W161) proves
// "the build pipeline ran on a machine holding this key." The auditor's
// signature proves "an independent party with their own Ed25519 key observed
// this artifact's verification outputs and stands behind them." The two keys
// MUST be different — that's the entire point. The verifier check #22
// records both key fingerprints so a downstream party can audit the chain
// of trust end-to-end.
//
// Storage model:
//
//   The auditor's PRIVATE key never enters the builder's pipeline. They
//   generate a keypair offline (`kolm auditor keygen`), keep the private
//   key in their own HSM / signing service / encrypted file, and publish
//   their public key separately. They produce an attestation JSON over a
//   specific artifact (`kolm auditor sign <artifact.kolm>`) and hand the
//   JSON to the tenant. The tenant embeds it at build time via
//   `--auditor-attestation <file>` (or via the runtime endpoint
//   POST /v1/auditor/attach, future scope), and the verifier check #22
//   re-validates the signature using the public key embedded in the
//   attestation block.
//
// The attestation block:
//
//   {
//     spec: 'kolm-auditor-attestation-v1',
//     auditor_id:       string ('deloitte-2026-q2', 'aicpa-member-XXXXXX')
//     accreditation:    string|null (URL or human-readable scope)
//     scope:            string|null (e.g., 'SOC 2 Type II AI controls')
//     artifact_hash:    hex64       (binds to the specific artifact)
//     cid:              string|null (optional CID anchor)
//     eval_set_hash:    hex64|null
//     k_score:          object|null (the K-score the auditor observed)
//     eval_score:       number|null
//     artifact_class:   string|null
//     external_holdout_hash:       hex64|null (claim auditor re-anchored holdouts)
//     tenant_shadow_corpus_hash:   hex64|null (claim auditor verified shadow corpus)
//     checks_passed:    string[]  (named binder checks the auditor re-ran)
//     notes:            string|null
//     public_key:       PEM string (auditor's Ed25519 SPKI)
//     key_fingerprint:  hex32     (sha256 of SPKI DER, first 32 hex)
//     signed_at:        ISO 8601
//     signature:        base64url Ed25519 signature over canonicalJson(block - signature)
//   }
//
// Verifier semantics (binder check #22):
//
//   - Block absent → pass + upgrade hint (no auditor attached this artifact).
//   - Block present + signature verifies + signed claims match manifest →
//     pass with auditor identity + fingerprint surfaced.
//   - Block present + signature invalid → fail (tamper or wrong key).
//   - Block present + signature OK but signed claim (artifact_hash, k_score,
//     etc.) differs from current manifest → fail (attestation drift).
//   - Auditor key fingerprint matches builder key fingerprint → fail (the
//     attestation is structurally an auditor block but signed by the builder;
//     this defeats the entire point — third-party attestation requires a
//     distinct party).

import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  sign as ed25519Sign,
  verify as ed25519Verify,
  keyFingerprint as ed25519Fingerprint,
  ED25519_ALG,
} from './ed25519.js';

export const AUDITOR_ATTESTATION_SPEC_VERSION = 'kolm-auditor-attestation-v1';

// SAFE_ID matches the pattern used in tenant-holdout.js / external-holdout.js
// so all three modules share the same character class for identifier fields
// that participate in user-visible diagnostics. Filesystem-safe.
const SAFE_ID = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');
}

// ---------------------------------------------------------------------------
// Auditor key loader. Mirrors src/ed25519.js loadSignerKeyFromEnv shape but
// reads a DIFFERENT pair of env vars — the auditor's key namespace is
// deliberately separate from the builder's so a CI runner that signs
// artifacts cannot accidentally also sign attestations.
//
// Env vars (first non-empty wins):
//   KOLM_AUDITOR_ED25519_PRIVATE_KEY        - PEM-encoded private key
//   KOLM_AUDITOR_ED25519_PRIVATE_KEY_PATH   - path to PEM file on disk
// ---------------------------------------------------------------------------
export function loadAuditorKeyFromEnv() {
  let pem = process.env.KOLM_AUDITOR_ED25519_PRIVATE_KEY || null;
  if (!pem && process.env.KOLM_AUDITOR_ED25519_PRIVATE_KEY_PATH) {
    try {
      pem = fs.readFileSync(process.env.KOLM_AUDITOR_ED25519_PRIVATE_KEY_PATH, 'utf8');
    } catch (e) {
      throw new Error(`auditor-attestation.loadAuditorKeyFromEnv: cannot read ${process.env.KOLM_AUDITOR_ED25519_PRIVATE_KEY_PATH}: ${e.message}`);
    }
  }
  if (!pem) return null;
  let publicKey;
  try {
    const keyObj = crypto.createPrivateKey(pem);
    publicKey = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' });
  } catch (e) {
    throw new Error(`auditor-attestation.loadAuditorKeyFromEnv: invalid PEM private key: ${e.message}`);
  }
  return {
    privateKey: pem,
    publicKey,
    key_fingerprint: ed25519Fingerprint(publicKey),
  };
}

// Load an auditor private key from an explicit file path (for the CLI's
// `kolm auditor sign --key <path>` flow, which keeps the private key out of
// process env so it cannot leak via subprocess inheritance).
export function loadAuditorKeyFromFile(filePath) {
  if (!filePath) {
    throw new Error('auditor-attestation.loadAuditorKeyFromFile: filePath required');
  }
  let pem;
  try {
    pem = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`auditor-attestation.loadAuditorKeyFromFile: cannot read ${filePath}: ${e.message}`);
  }
  let publicKey;
  try {
    const keyObj = crypto.createPrivateKey(pem);
    publicKey = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' });
  } catch (e) {
    throw new Error(`auditor-attestation.loadAuditorKeyFromFile: invalid PEM private key at ${filePath}: ${e.message}`);
  }
  return {
    privateKey: pem,
    publicKey,
    key_fingerprint: ed25519Fingerprint(publicKey),
  };
}

// Generate a fresh auditor Ed25519 keypair. Same primitive as
// src/ed25519.js#generateKeyPair but exported separately so the CLI's
// `kolm auditor keygen` cannot accidentally write a builder key by mis-call.
export function generateAuditorKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey, key_fingerprint: ed25519Fingerprint(publicKey) };
}

// Build an attestation block over an observed artifact's verification
// outputs. The caller provides:
//   - signerKey: { privateKey, publicKey, key_fingerprint } (the auditor's own
//                Ed25519 key, NOT the builder's)
//   - observation: object with at minimum {artifact_hash}. Additional keys
//                  documented above are bound into the signed payload.
//   - identity: { auditor_id, accreditation?, scope?, notes? }
//
// Returns the signed block (object) suitable for embedding directly in
// manifest.auditor_attestation_provenance (which is an array, since multiple
// auditors can sign one artifact).
export function buildAuditorAttestationBlock({ signerKey, observation, identity, signed_at } = {}) {
  if (!signerKey || typeof signerKey !== 'object') {
    throw new Error('buildAuditorAttestationBlock: signerKey required');
  }
  if (typeof signerKey.privateKey !== 'string' || signerKey.privateKey.length === 0) {
    throw new Error('buildAuditorAttestationBlock: signerKey.privateKey required (PEM string)');
  }
  if (typeof signerKey.publicKey !== 'string' || signerKey.publicKey.length === 0) {
    throw new Error('buildAuditorAttestationBlock: signerKey.publicKey required (PEM string)');
  }
  if (!observation || typeof observation !== 'object') {
    throw new Error('buildAuditorAttestationBlock: observation required');
  }
  if (typeof observation.artifact_hash !== 'string' || !HEX64.test(observation.artifact_hash)) {
    throw new Error(`buildAuditorAttestationBlock: observation.artifact_hash must be hex64 (got ${observation.artifact_hash})`);
  }
  if (!identity || typeof identity !== 'object') {
    throw new Error('buildAuditorAttestationBlock: identity required');
  }
  if (typeof identity.auditor_id !== 'string' || !SAFE_ID.test(identity.auditor_id)) {
    throw new Error(`buildAuditorAttestationBlock: identity.auditor_id='${identity.auditor_id}' must match ${SAFE_ID}`);
  }
  const fingerprint = signerKey.key_fingerprint || ed25519Fingerprint(signerKey.publicKey);
  if (!HEX32.test(fingerprint)) {
    throw new Error('buildAuditorAttestationBlock: signerKey.key_fingerprint must be hex32');
  }
  // Build the unsigned body first, then canonical-hash + sign it. The
  // signed payload is everything EXCEPT the `signature` field — same pattern
  // src/ed25519.js#buildSignatureBlock uses.
  const checksPassed = Array.isArray(identity.checks_passed)
    ? identity.checks_passed.filter(s => typeof s === 'string' && s.length > 0).map(String)
    : Array.isArray(observation.checks_passed)
      ? observation.checks_passed.filter(s => typeof s === 'string' && s.length > 0).map(String)
      : [];
  const block = {
    spec: AUDITOR_ATTESTATION_SPEC_VERSION,
    alg: ED25519_ALG,
    auditor_id: identity.auditor_id,
    accreditation: identity.accreditation != null ? String(identity.accreditation) : null,
    scope: identity.scope != null ? String(identity.scope) : null,
    notes: identity.notes != null ? String(identity.notes) : null,
    artifact_hash: observation.artifact_hash,
    cid: observation.cid != null ? String(observation.cid) : null,
    eval_set_hash: observation.eval_set_hash != null ? String(observation.eval_set_hash) : null,
    eval_score: typeof observation.eval_score === 'number' ? observation.eval_score : null,
    artifact_class: observation.artifact_class != null ? String(observation.artifact_class) : null,
    k_score: observation.k_score != null ? observation.k_score : null,
    external_holdout_hash: observation.external_holdout_hash != null ? String(observation.external_holdout_hash) : null,
    tenant_shadow_corpus_hash: observation.tenant_shadow_corpus_hash != null ? String(observation.tenant_shadow_corpus_hash) : null,
    checks_passed: checksPassed,
    public_key: signerKey.publicKey,
    key_fingerprint: fingerprint,
    signed_at: signed_at || new Date().toISOString(),
  };
  const payloadCanonical = canonicalJson(block);
  const signature = ed25519Sign(signerKey.privateKey, payloadCanonical);
  block.signature = signature;
  // Bind a short block hash for the artifact_hash_input chain — this is
  // sha256(canonicalJson(block)) including the signature field, so any
  // tamper with the block AFTER it's embedded breaks the artifact hash.
  block.hash = sha256Hex(canonicalJson(block));
  return block;
}

// Validate an auditor attestation block standalone: schema + signature.
// Does NOT check that the signed claims match a particular manifest — that
// cross-check is the verifier's job (binder check #22). This function is
// safe to call at build time (to reject malformed attestation files) and
// at verify time (as the first gate before the cross-check).
export function validateAuditorAttestationBlock(block) {
  if (!block || typeof block !== 'object') {
    throw new Error('auditor-attestation: block must be an object');
  }
  if (block.spec !== AUDITOR_ATTESTATION_SPEC_VERSION) {
    throw new Error(`auditor-attestation: block.spec='${block.spec}' expected '${AUDITOR_ATTESTATION_SPEC_VERSION}'`);
  }
  if (block.alg !== ED25519_ALG) {
    throw new Error(`auditor-attestation: block.alg='${block.alg}' expected '${ED25519_ALG}'`);
  }
  for (const k of ['auditor_id', 'artifact_hash', 'public_key', 'key_fingerprint', 'signed_at', 'signature']) {
    if (block[k] == null || block[k] === '') {
      throw new Error(`auditor-attestation: block missing required field '${k}'`);
    }
  }
  if (!SAFE_ID.test(block.auditor_id)) {
    throw new Error(`auditor-attestation: auditor_id='${block.auditor_id}' invalid shape`);
  }
  if (!HEX64.test(block.artifact_hash)) {
    throw new Error(`auditor-attestation: artifact_hash not hex64`);
  }
  if (!HEX32.test(block.key_fingerprint)) {
    throw new Error(`auditor-attestation: key_fingerprint not hex32`);
  }
  // Re-derive fingerprint from public_key bytes; the claimed fingerprint
  // must match. Stops a tamperer from swapping the fingerprint label while
  // leaving the actual key bytes intact (we'd still verify the signature,
  // but downstream identity-tracking would break silently).
  let actualFingerprint;
  try { actualFingerprint = ed25519Fingerprint(block.public_key); }
  catch (e) { throw new Error(`auditor-attestation: cannot derive fingerprint from public_key: ${e.message}`); }
  if (block.key_fingerprint !== actualFingerprint) {
    throw new Error(`auditor-attestation: key_fingerprint claim (${block.key_fingerprint.slice(0, 12)}…) does not match public_key bytes (${actualFingerprint.slice(0, 12)}…)`);
  }
  // Verify the Ed25519 signature against the canonical payload (block minus
  // `signature` and `hash` fields — `hash` is computed AFTER signing so it
  // is not part of the signed payload).
  const { signature, hash, ...payload } = block;
  void hash;
  const payloadCanonical = canonicalJson(payload);
  const ok = ed25519Verify(block.public_key, payloadCanonical, signature);
  if (!ok) {
    throw new Error('auditor-attestation: Ed25519 signature does not verify against canonical payload');
  }
  // Verify the optional block hash (post-signature) was computed
  // consistently. Tamper with any block field after embedding and the
  // block.hash drifts; the artifact_hash binding downstream catches it but
  // we also throw here for clarity.
  if (block.hash != null) {
    const recomputed = sha256Hex(canonicalJson({ ...payload, signature }));
    if (block.hash !== recomputed) {
      throw new Error(`auditor-attestation: block.hash drift — declared ${block.hash.slice(0, 12)}…, recomputed ${recomputed.slice(0, 12)}…`);
    }
  }
  return block;
}

// Verify the auditor's signed claims AGAINST the artifact they purport to
// describe. Returns { ok: true } when every signed claim that is non-null
// in the attestation matches the corresponding manifest field, or
// { ok: false, reason } when any claim drifts. Used by binder check #22.
//
// Cross-check fields: artifact_hash, cid, eval_set_hash, eval_score,
// artifact_class, external_holdout_hash, tenant_shadow_corpus_hash. The
// k_score cross-check tolerates floating-point noise (compare composite to
// 4 decimal places); the rest are exact-match.
export function crossCheckAttestation(block, manifest) {
  if (!block || !manifest) {
    return { ok: false, reason: 'crossCheckAttestation requires block + manifest' };
  }
  // artifact_hash binding — the attestation claims to describe a specific
  // artifact. The manifest's artifact-hash anchor lives in hashes.artifact
  // (when set) but the canonical source is the receipt's artifact_hash.
  // The verifier passes manifest.__artifact_hash explicitly so this module
  // does not need to know about receipt internals.
  const declaredArtifactHash = manifest.__artifact_hash || null;
  if (declaredArtifactHash && block.artifact_hash !== declaredArtifactHash) {
    return {
      ok: false,
      reason: `signed artifact_hash=${block.artifact_hash.slice(0, 12)}… does not match current artifact_hash=${declaredArtifactHash.slice(0, 12)}…`,
    };
  }
  if (block.cid != null && manifest.cid && block.cid !== manifest.cid) {
    return {
      ok: false,
      reason: `signed cid=${String(block.cid).slice(0, 24)}… does not match manifest.cid=${String(manifest.cid).slice(0, 24)}…`,
    };
  }
  if (block.eval_set_hash != null && manifest.evals?.hash && block.eval_set_hash !== manifest.evals.hash) {
    return {
      ok: false,
      reason: `signed eval_set_hash=${block.eval_set_hash.slice(0, 12)}… does not match manifest.evals.hash=${manifest.evals.hash.slice(0, 12)}…`,
    };
  }
  if (block.eval_score != null && typeof manifest.eval_score === 'number') {
    const drift = Math.abs(block.eval_score - manifest.eval_score);
    if (drift > 1e-6) {
      return {
        ok: false,
        reason: `signed eval_score=${block.eval_score} does not match manifest.eval_score=${manifest.eval_score} (drift=${drift})`,
      };
    }
  }
  if (block.artifact_class != null && manifest.artifact_class && block.artifact_class !== manifest.artifact_class) {
    return {
      ok: false,
      reason: `signed artifact_class='${block.artifact_class}' does not match manifest.artifact_class='${manifest.artifact_class}'`,
    };
  }
  if (block.k_score != null && manifest.k_score != null) {
    const sComp = typeof block.k_score?.composite === 'number' ? block.k_score.composite : null;
    const mComp = typeof manifest.k_score?.composite === 'number' ? manifest.k_score.composite : null;
    if (sComp != null && mComp != null) {
      const drift = Math.abs(sComp - mComp);
      if (drift > 1e-4) {
        return {
          ok: false,
          reason: `signed k_score.composite=${sComp.toFixed(4)} does not match manifest.k_score.composite=${mComp.toFixed(4)} (drift=${drift.toFixed(5)})`,
        };
      }
    }
  }
  // External holdout / tenant shadow hashes — when the auditor's attestation
  // claims they re-verified those layers, the manifest's `artifact_hash_input`
  // analogs MUST match. We do not have direct access to artifact_hash_input
  // here (it's not in manifest), so the verifier passes hints via
  // manifest.__external_holdout_hash / manifest.__tenant_shadow_corpus_hash.
  if (block.external_holdout_hash != null) {
    const expected = manifest.__external_holdout_hash;
    if (expected && block.external_holdout_hash !== expected) {
      return {
        ok: false,
        reason: `signed external_holdout_hash=${block.external_holdout_hash.slice(0, 12)}… does not match current external_holdout_hash=${expected.slice(0, 12)}…`,
      };
    }
    if (!expected) {
      return {
        ok: false,
        reason: `attestation claims external_holdout_hash=${block.external_holdout_hash.slice(0, 12)}… but artifact has no external_holdout block`,
      };
    }
  }
  if (block.tenant_shadow_corpus_hash != null) {
    const expected = manifest.__tenant_shadow_corpus_hash;
    if (expected && block.tenant_shadow_corpus_hash !== expected) {
      return {
        ok: false,
        reason: `signed tenant_shadow_corpus_hash=${block.tenant_shadow_corpus_hash.slice(0, 12)}… does not match current tenant_shadow_corpus_hash=${expected.slice(0, 12)}…`,
      };
    }
    if (!expected) {
      return {
        ok: false,
        reason: `attestation claims tenant_shadow_corpus_hash=${block.tenant_shadow_corpus_hash.slice(0, 12)}… but artifact has no tenant_shadow_corpus block`,
      };
    }
  }
  return { ok: true };
}

// Load + validate a JSON attestation file from disk. Used by the build
// pipeline (--auditor-attestation flag) and by the CLI's
// `kolm auditor verify` subcommand.
export function loadAttestationFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('loadAttestationFile: filePath required');
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`loadAttestationFile: cannot read ${filePath}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`loadAttestationFile: ${filePath} is not valid JSON: ${e.message}`);
  }
  return validateAuditorAttestationBlock(parsed);
}

// Write an attestation block to disk in pretty JSON. Used by
// `kolm auditor sign`.
export function writeAttestationFile(filePath, block) {
  // Validate before writing so the file is always either absent or valid.
  validateAuditorAttestationBlock(block);
  fs.writeFileSync(filePath, JSON.stringify(block, null, 2), 'utf8');
  return { filePath, bytes: Buffer.byteLength(JSON.stringify(block, null, 2), 'utf8') };
}

// Convenience: extract just the observation fields from a built artifact's
// manifest. Used by the CLI's `kolm auditor sign` subcommand to build the
// payload the auditor signs without the caller having to know every field
// name. Reads receipt.json for artifact_hash + cid (the receipt is the
// canonical source for both).
export function extractObservationFromManifest(manifest, receipt, artifact_hash_input) {
  const observation = {
    artifact_hash: receipt?.artifact_hash || null,
    cid: manifest?.cid || receipt?.cid || null,
    eval_set_hash: manifest?.evals?.hash || receipt?.eval_set_hash || null,
    eval_score: typeof manifest?.eval_score === 'number' ? manifest.eval_score : null,
    artifact_class: manifest?.artifact_class || null,
    k_score: manifest?.k_score || null,
    external_holdout_hash: artifact_hash_input?.external_holdout_hash || null,
    tenant_shadow_corpus_hash: artifact_hash_input?.tenant_shadow_corpus_hash || null,
  };
  return observation;
}
