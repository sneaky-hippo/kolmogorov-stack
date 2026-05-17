// src/ed25519.js
//
// Wave H — Ed25519 signing for public receipt verification.
//
// HMAC-SHA256 (the original signature path) is a symmetric MAC: anyone who can
// verify can also forge. That's fine for internal integrity inside a trusted
// tenant boundary, but it cannot prove provenance to an outside party. The
// honest fix is asymmetric signing.
//
// This module is intentionally additive:
//   * If no Ed25519 private key is available, artifacts ship exactly as before
//     (HMAC only). No regression.
//   * If a private key is available, the receipt grows a `signature_ed25519`
//     block that carries `{alg, public_key, key_fingerprint, signature,
//     signed_at}`. The HMAC block stays in place as an integrity check.
//
// Verifier behavior:
//   * If `signature_ed25519` exists on receipt, recompute the canonical
//     payload (receipt minus this block AND minus the HMAC `signature`) and
//     ask Node's built-in `crypto.verify` to check the Ed25519 signature
//     against the embedded public key. This requires no secret on the
//     verifier side — that's the whole point.
//   * The HMAC `signature` field continues to verify as before, but the
//     binder strips BOTH `signature` and `signature_ed25519` when forming
//     the HMAC payload (Wave H signed material order: HMAC inside, Ed25519
//     outside; see `build-time order` below).
//
// Build-time signature order (matches what verifier expects):
//   1. Receipt body built with no signature fields.
//   2. HMAC computed over canonical(body) → body.signature = hex.
//   3. Ed25519 computed over canonical(body) // body now has HMAC sig.
//   4. body.signature_ed25519 = { alg, public_key, key_fingerprint, signature,
//      signed_at }.
//
// Why HMAC stays: many existing receipts already verified in CI with the
// shared RECIPE_RECEIPT_SECRET. Dropping HMAC would break every saved
// artifact. Ed25519 layered on top adds the public-cryptography property
// without invalidating historical bytes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ED25519_SPEC = 'kolm-ed25519-v1';
export const ED25519_ALG = 'ed25519';

// ---------------------------------------------------------------------------
// Keypair generation.
//
// Returns PEM-encoded public + private keys. PEM is chosen for human-
// readability, tooling compatibility (openssl, ssh-keygen, sigstore, etc.),
// and because it round-trips cleanly through env vars and JSON without
// base64-of-base64 contortions.
// ---------------------------------------------------------------------------
export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

// ---------------------------------------------------------------------------
// Sign / verify primitives.
//
// Ed25519 with Node's crypto.sign uses algorithm=null because Ed25519 has a
// fixed hash (SHA-512 internally). Output is raw 64 bytes; we base64url-
// encode for compact JSON storage that's URL-safe and copy-paste-friendly.
// ---------------------------------------------------------------------------
export function sign(privateKeyPem, data) {
  if (typeof privateKeyPem !== 'string' || privateKeyPem.length === 0) {
    throw new Error('ed25519.sign: privateKeyPem must be a non-empty PEM string');
  }
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const signature = crypto.sign(null, buf, privateKeyPem);
  return signature.toString('base64url');
}

export function verify(publicKeyPem, data, signatureB64Url) {
  if (typeof publicKeyPem !== 'string' || publicKeyPem.length === 0) return false;
  if (typeof signatureB64Url !== 'string' || signatureB64Url.length === 0) return false;
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const sig = Buffer.from(signatureB64Url, 'base64url');
    return crypto.verify(null, buf, publicKeyPem, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Key fingerprint.
//
// Short, stable, human-quotable identifier for a public key. Used in the
// receipt's `signed_by` field and in verifier diagnostics so two artifacts
// signed by the same key can be linked at a glance without diffing PEMs.
//
// Uses the raw SPKI DER bytes (not the PEM string) so whitespace / line-
// ending variation in the PEM does not change the fingerprint.
// ---------------------------------------------------------------------------
export function keyFingerprint(publicKeyPem) {
  if (typeof publicKeyPem !== 'string' || publicKeyPem.length === 0) {
    throw new Error('ed25519.keyFingerprint: publicKeyPem must be a non-empty PEM string');
  }
  const keyObj = crypto.createPublicKey(publicKeyPem);
  const der = keyObj.export({ type: 'spki', format: 'der' });
  const hash = crypto.createHash('sha256').update(der).digest('hex');
  return hash.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Loader — read a signer key from env, falling back to null when absent.
//
// The build pipeline calls this once per artifact build. When null, the
// receipt ships HMAC-only (existing Wave 0 behavior preserved). When
// non-null, the receipt grows a signature_ed25519 block.
//
// Env vars (first non-empty wins):
//   KOLM_ED25519_PRIVATE_KEY  — PEM-encoded private key (production path)
//   KOLM_ED25519_PRIVATE_KEY_PATH — path to a PEM file on disk (CI path)
//
// Returns { privateKey, publicKey, key_fingerprint } or null.
// ---------------------------------------------------------------------------
export function loadSignerKeyFromEnv() {
  let pem = process.env.KOLM_ED25519_PRIVATE_KEY || null;
  if (!pem && process.env.KOLM_ED25519_PRIVATE_KEY_PATH) {
    try {
      pem = fs.readFileSync(process.env.KOLM_ED25519_PRIVATE_KEY_PATH, 'utf8');
    } catch (e) {
      throw new Error(`ed25519.loadSignerKeyFromEnv: cannot read ${process.env.KOLM_ED25519_PRIVATE_KEY_PATH}: ${e.message}`);
    }
  }
  if (!pem) return null;
  let publicKey;
  try {
    const keyObj = crypto.createPrivateKey(pem);
    publicKey = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' });
  } catch (e) {
    throw new Error(`ed25519.loadSignerKeyFromEnv: invalid PEM private key: ${e.message}`);
  }
  return {
    privateKey: pem,
    publicKey,
    key_fingerprint: keyFingerprint(publicKey),
  };
}

// ---------------------------------------------------------------------------
// Default signer — Wave 149.
//
// Before Wave 149 Ed25519 was opt-in: a build only got an `signature_ed25519`
// block when `KOLM_ED25519_PRIVATE_KEY` (or _PATH) was set. The HMAC remained
// the only universally-present signature. After Wave 149 the default is
// flipped: every build gets Ed25519. If no env key is present we generate a
// stable per-machine signing key once and persist it at:
//
//   ~/.kolm/signing-key.pem      (PEM-encoded pkcs8 Ed25519 private key)
//
// This keeps the fingerprint stable across builds for the same developer so
// downstream verifiers see a consistent `signed_by` value, while still
// preferring the explicit env-var path for production (CI, signing servers)
// where keys are managed externally.
//
// The disk file is mode 0o600 (owner-read/write only). The directory is
// created with mode 0o700 if it didn't exist.
//
// Override with KOLM_ED25519_KEY_STORE to a different directory, or set
// KOLM_ED25519_DISABLE=1 to fall back to legacy HMAC-only signing.
//
// Returns { privateKey, publicKey, key_fingerprint, source } where source is
// one of 'env' | 'env-path' | 'cache' | 'generated' | null.
// ---------------------------------------------------------------------------
export function loadOrCreateDefaultSigner(opts = {}) {
  if (process.env.KOLM_ED25519_DISABLE === '1') return null;

  // Path 1: explicit env (production / CI).
  if (process.env.KOLM_ED25519_PRIVATE_KEY) {
    const envSigner = loadSignerKeyFromEnv();
    if (envSigner) return { ...envSigner, source: 'env' };
  }
  if (process.env.KOLM_ED25519_PRIVATE_KEY_PATH) {
    const envSigner = loadSignerKeyFromEnv();
    if (envSigner) return { ...envSigner, source: 'env-path' };
  }

  // Path 2: cached per-machine key.
  const storeDir = opts.storeDir
    || process.env.KOLM_ED25519_KEY_STORE
    || path.join(os.homedir(), '.kolm');
  const keyPath = path.join(storeDir, 'signing-key.pem');

  if (fs.existsSync(keyPath)) {
    let pem;
    try {
      pem = fs.readFileSync(keyPath, 'utf8');
    } catch (e) {
      throw new Error(`ed25519.loadOrCreateDefaultSigner: cannot read ${keyPath}: ${e.message}`);
    }
    let publicKey;
    try {
      const keyObj = crypto.createPrivateKey(pem);
      publicKey = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' });
    } catch (e) {
      throw new Error(`ed25519.loadOrCreateDefaultSigner: corrupt key at ${keyPath}: ${e.message}`);
    }
    return {
      privateKey: pem,
      publicKey,
      key_fingerprint: keyFingerprint(publicKey),
      source: 'cache',
    };
  }

  // Path 3: generate + persist. mkdir is idempotent with recursive:true.
  try {
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(`ed25519.loadOrCreateDefaultSigner: cannot create ${storeDir}: ${e.message}`);
  }
  const { publicKey, privateKey } = generateKeyPair();
  try {
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
  } catch (e) {
    throw new Error(`ed25519.loadOrCreateDefaultSigner: cannot write ${keyPath}: ${e.message}`);
  }
  return {
    privateKey,
    publicKey,
    key_fingerprint: keyFingerprint(publicKey),
    source: 'generated',
  };
}

// ---------------------------------------------------------------------------
// Helper: build a signature_ed25519 block for embedding in a receipt or any
// other manifest-like structure.
//
// `payloadCanonical` is the EXACT canonical string the signature covers — the
// caller is responsible for stripping `signature_ed25519` (and whichever
// other fields its scheme excludes) before passing it in. Doing canonicaliz-
// ation in the caller keeps this module unaware of receipt schemas.
// ---------------------------------------------------------------------------
export function buildSignatureBlock({ privateKey, publicKey, key_fingerprint, payloadCanonical, signed_at }) {
  if (!privateKey || !publicKey) {
    throw new Error('ed25519.buildSignatureBlock: privateKey and publicKey required');
  }
  if (typeof payloadCanonical !== 'string' || payloadCanonical.length === 0) {
    throw new Error('ed25519.buildSignatureBlock: payloadCanonical must be non-empty string');
  }
  const signature = sign(privateKey, payloadCanonical);
  return {
    spec: ED25519_SPEC,
    alg: ED25519_ALG,
    public_key: publicKey,
    key_fingerprint: key_fingerprint || keyFingerprint(publicKey),
    signature,
    signed_at: signed_at || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helper: verify a signature_ed25519 block against a payload.
//
// Mirrors buildSignatureBlock — caller passes the canonical payload string,
// this module just checks the block shape and runs verify().
// ---------------------------------------------------------------------------
export function verifySignatureBlock(block, payloadCanonical) {
  if (!block || typeof block !== 'object') {
    return { ok: false, reason: 'signature block missing or not an object' };
  }
  if (block.spec !== ED25519_SPEC) {
    return { ok: false, reason: `unexpected spec: ${block.spec}` };
  }
  if (block.alg !== ED25519_ALG) {
    return { ok: false, reason: `unexpected alg: ${block.alg}` };
  }
  if (typeof block.public_key !== 'string' || block.public_key.length === 0) {
    return { ok: false, reason: 'public_key missing' };
  }
  if (typeof block.signature !== 'string' || block.signature.length === 0) {
    return { ok: false, reason: 'signature missing' };
  }
  // Cross-check fingerprint claim against actual key bytes.
  let actualFingerprint;
  try { actualFingerprint = keyFingerprint(block.public_key); }
  catch (e) { return { ok: false, reason: `cannot derive fingerprint from public_key: ${e.message}` }; }
  if (block.key_fingerprint && block.key_fingerprint !== actualFingerprint) {
    return {
      ok: false,
      reason: `key_fingerprint claim (${block.key_fingerprint.slice(0, 12)}…) does not match public_key bytes (${actualFingerprint.slice(0, 12)}…)`,
    };
  }
  const ok = verify(block.public_key, payloadCanonical, block.signature);
  if (!ok) {
    return { ok: false, reason: 'Ed25519 signature does not verify against payload' };
  }
  return { ok: true, key_fingerprint: actualFingerprint };
}
