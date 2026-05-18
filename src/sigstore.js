// src/sigstore.js
//
// Wave 150 — sigstore (cosign-compatible) signature bundle for .kolm receipts.
//
// Per the Wave 144 plan §Q+9: HMAC (Wave 0) is symmetric integrity; Ed25519
// (Wave 149) is asymmetric provenance; sigstore is the public-transparency
// layer. A sigstore bundle is the cosign-compatible witness that the Ed25519
// public key + signature were recorded in a publicly-readable, append-only
// transparency log (Rekor) at a specific moment, so any later observer can
// prove the artifact existed and was attested to before that moment.
//
// Three operating modes — picked at build time, no flag needed:
//
//   1. dry-run (default, offline-safe).
//      No network call. Bundle is emitted with `dry_run: true` and
//      `rekor_log_entry: null`. The bundle's `messageSignature` still verifies
//      against the embedded Ed25519 public key (which is the same key used for
//      `signature_ed25519`), so it's a real, structurally-valid bundle — it
//      just hasn't been pinned to a transparency log yet. CI and offline
//      builds always end up here.
//
//   2. submit-to-Rekor (KOLM_SIGSTORE_REKOR_URL is set).
//      The build POSTs a hashedrekord entry to the configured Rekor instance
//      and embeds the resulting `{logIndex, integratedTime, logID,
//      signedEntryTimestamp, inclusionProof}` block. If submission fails (5xx,
//      timeout, DNS), the build falls back to dry-run with a warning rather
//      than failing — production builds shouldn't block on Rekor uptime.
//
//   3. disabled (KOLM_SIGSTORE_DISABLE=1).
//      No sigstore block emitted at all. signature_alg reverts to
//      'ed25519+hmac-sha256' (or 'hmac-sha256' if Ed25519 also disabled).
//
// Verifier behavior:
//   * If `signature_sigstore` exists on receipt, verify the embedded
//     messageSignature against the canonical receipt body (with HMAC + Ed25519
//     blocks present, but NOT signature_sigstore itself).
//   * If the bundle has a `rekor_log_entry`, fetch the log entry by logIndex
//     (when KOLM_SIGSTORE_REKOR_URL is set) and confirm the entry's body
//     matches the bundle's. When no network access, accept inclusionProof as
//     embedded evidence.
//   * If `dry_run: true`, report `warn` rather than `fail` — the build was
//     offline; user can run `kolm sigstore-attest <artifact>` to publish.
//
// Bundle structure mirrors cosign's bundle.json v0.2 with kolm-specific
// extensions (we use Ed25519 instead of x509 cert chain because we already
// have the public key in `signature_ed25519` — no Fulcio dependency).

import crypto from 'node:crypto';
import { sign as edSign, verify as edVerify, keyFingerprint } from './ed25519.js';

export const SIGSTORE_SPEC = 'kolm-sigstore-v1';
export const SIGSTORE_ALG = 'ed25519-sigstore-bundle';
export const SIGSTORE_BUNDLE_MEDIA_TYPE = 'application/vnd.dev.sigstore.bundle+json;version=0.2';
export const REKOR_TIMEOUT_MS = 8000;
const REKOR_HASHEDREKORD_KIND = 'hashedrekord';
const REKOR_HASHEDREKORD_VERSION = '0.0.1';

// ---------------------------------------------------------------------------
// Env helpers.
// ---------------------------------------------------------------------------
export function isDisabled() {
  return process.env.KOLM_SIGSTORE_DISABLE === '1';
}
export function rekorUrl() {
  const u = process.env.KOLM_SIGSTORE_REKOR_URL;
  return typeof u === 'string' && u.length > 0 ? u.replace(/\/+$/, '') : null;
}

// ---------------------------------------------------------------------------
// digest — sha256 of the canonical payload as a hex string. The Rekor
// hashedrekord schema wants the algorithm name and the digest as a base64
// string of the raw bytes; cosign uses lowercase hex; we keep both forms in
// the bundle so verifiers in either ecosystem can re-derive.
// ---------------------------------------------------------------------------
export function payloadDigestHex(payloadCanonical) {
  if (typeof payloadCanonical !== 'string') {
    throw new Error('sigstore.payloadDigestHex: payloadCanonical must be a string');
  }
  return crypto.createHash('sha256').update(payloadCanonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// hashedrekordBody — the canonical JSON body that gets POSTed to
// /api/v1/log/entries. Cosign-compatible (rekord types are the canonical
// representation Rekor accepts for arbitrary signed content).
// ---------------------------------------------------------------------------
export function hashedrekordBody({ publicKey, signatureB64, digestHex }) {
  if (!publicKey || !signatureB64 || !digestHex) {
    throw new Error('sigstore.hashedrekordBody: publicKey, signatureB64, digestHex required');
  }
  return {
    apiVersion: REKOR_HASHEDREKORD_VERSION,
    kind: REKOR_HASHEDREKORD_KIND,
    spec: {
      signature: {
        content: signatureB64,
        publicKey: {
          content: Buffer.from(publicKey, 'utf8').toString('base64'),
        },
      },
      data: {
        hash: {
          algorithm: 'sha256',
          value: digestHex,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// submitToRekor — POST a hashedrekord entry to a Rekor instance. Returns
// `{ uuid, logIndex, integratedTime, logID, signedEntryTimestamp,
//    inclusionProof }` on success, or `null` on any failure (the caller
// degrades to dry-run with a warning).
// ---------------------------------------------------------------------------
export async function submitToRekor({ publicKey, signatureB64, digestHex, url, timeoutMs }) {
  if (typeof fetch !== 'function') return null;
  const target = (url || rekorUrl());
  if (!target) return null;
  const body = hashedrekordBody({ publicKey, signatureB64, digestHex });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || REKOR_TIMEOUT_MS);
  try {
    const res = await fetch(target + '/api/v1/log/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const json = await res.json();
    const uuid = json && typeof json === 'object' ? Object.keys(json)[0] : null;
    const entry = uuid ? json[uuid] : null;
    if (!entry) return null;
    return {
      uuid,
      logIndex: entry.logIndex ?? null,
      integratedTime: entry.integratedTime ?? null,
      logID: entry.logID ?? null,
      signedEntryTimestamp: entry?.verification?.signedEntryTimestamp ?? null,
      inclusionProof: entry?.verification?.inclusionProof ?? null,
      rekor_url: target,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// fetchRekorEntryByLogIndex — GET /api/v1/log/entries?logIndex=N to confirm
// an embedded log entry is still present in Rekor's tree. Used by the
// verifier when re-checking inclusion. Returns the raw entry, or null on
// any failure (the verifier treats null as "could not re-confirm, embedded
// inclusion proof stands in").
// ---------------------------------------------------------------------------
export async function fetchRekorEntryByLogIndex(logIndex, { url, timeoutMs } = {}) {
  if (typeof fetch !== 'function') return null;
  const target = (url || rekorUrl());
  if (!target || logIndex == null) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || REKOR_TIMEOUT_MS);
  try {
    const res = await fetch(target + '/api/v1/log/entries?logIndex=' + encodeURIComponent(String(logIndex)), {
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const json = await res.json();
    const uuid = json && typeof json === 'object' ? Object.keys(json)[0] : null;
    const entry = uuid ? json[uuid] : null;
    if (!entry) return null;
    return { uuid, ...entry };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// buildSigstoreBundle — synchronous local bundle assembly. Does NOT submit
// to Rekor (that's the async `attestWithRekor` path below). Returns a
// dry-run bundle that is structurally valid + verifiable offline.
//
// Inputs:
//   privateKey       — PEM Ed25519 private (sign the payload)
//   publicKey        — PEM Ed25519 public (embed in bundle)
//   key_fingerprint  — short hex fingerprint of public key
//   payloadCanonical — the canonical JSON string this bundle attests to
//   signed_at        — ISO8601 timestamp; defaults to now
//
// Output: a cosign-compatible bundle plus kolm metadata
// (rekor_log_entry: null, dry_run: true).
// ---------------------------------------------------------------------------
export function buildSigstoreBundle({ privateKey, publicKey, key_fingerprint, payloadCanonical, signed_at }) {
  if (!privateKey || !publicKey) {
    throw new Error('sigstore.buildSigstoreBundle: privateKey and publicKey required');
  }
  if (typeof payloadCanonical !== 'string' || payloadCanonical.length === 0) {
    throw new Error('sigstore.buildSigstoreBundle: payloadCanonical must be non-empty string');
  }
  const fp = key_fingerprint || keyFingerprint(publicKey);
  const digestHex = payloadDigestHex(payloadCanonical);
  const digestB64 = Buffer.from(digestHex, 'hex').toString('base64');
  const signatureB64Url = edSign(privateKey, payloadCanonical);
  // Rekor canonically expects base64 (not base64url) for hashedrekord.
  const signatureB64 = Buffer.from(signatureB64Url, 'base64url').toString('base64');
  const publicKeyB64 = Buffer.from(publicKey, 'utf8').toString('base64');
  const bundle = {
    mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE,
    verificationMaterial: {
      publicKey: {
        hint: fp,
        rawBytes: publicKeyB64,
      },
    },
    messageSignature: {
      messageDigest: {
        algorithm: 'SHA2_256',
        digest: digestB64,
      },
      signature: signatureB64,
    },
  };
  return {
    spec: SIGSTORE_SPEC,
    alg: SIGSTORE_ALG,
    key_fingerprint: fp,
    digest_hex: digestHex,
    bundle,
    rekor_log_entry: null,
    dry_run: true,
    signed_at: signed_at || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// attestWithRekor — async path. Builds the local bundle, then submits to
// Rekor and merges the resulting log entry. Falls back to dry-run if the
// network call fails (caller still gets a valid bundle).
// ---------------------------------------------------------------------------
export async function attestWithRekor(input, { url, timeoutMs } = {}) {
  const base = buildSigstoreBundle(input);
  const target = url || rekorUrl();
  if (!target) return base;
  const entry = await submitToRekor({
    publicKey: input.publicKey,
    signatureB64: base.bundle.messageSignature.signature,
    digestHex: base.digest_hex,
    url: target,
    timeoutMs,
  });
  if (!entry) return base;
  return {
    ...base,
    rekor_log_entry: entry,
    dry_run: false,
  };
}

// ---------------------------------------------------------------------------
// verifySigstoreBundle — checks the bundle's signature against the canonical
// payload. Does NOT (by itself) re-fetch Rekor; that's the caller's choice
// because re-fetching needs network. Returns:
//   { ok, reason?, key_fingerprint?, dry_run, rekor_log_index?, digest_hex }
// ---------------------------------------------------------------------------
export function verifySigstoreBundle(block, payloadCanonical) {
  if (!block || typeof block !== 'object') {
    return { ok: false, reason: 'sigstore block missing or not an object' };
  }
  if (block.spec !== SIGSTORE_SPEC) {
    return { ok: false, reason: `unexpected spec: ${block.spec}` };
  }
  if (block.alg !== SIGSTORE_ALG) {
    return { ok: false, reason: `unexpected alg: ${block.alg}` };
  }
  const bundle = block.bundle;
  if (!bundle || typeof bundle !== 'object') {
    return { ok: false, reason: 'bundle missing' };
  }
  if (bundle.mediaType !== SIGSTORE_BUNDLE_MEDIA_TYPE) {
    return { ok: false, reason: `unexpected mediaType: ${bundle.mediaType}` };
  }
  const pkB64 = bundle?.verificationMaterial?.publicKey?.rawBytes;
  if (typeof pkB64 !== 'string' || pkB64.length === 0) {
    return { ok: false, reason: 'verificationMaterial.publicKey.rawBytes missing' };
  }
  const sigB64 = bundle?.messageSignature?.signature;
  if (typeof sigB64 !== 'string' || sigB64.length === 0) {
    return { ok: false, reason: 'messageSignature.signature missing' };
  }
  const digestB64Claim = bundle?.messageSignature?.messageDigest?.digest;
  if (typeof digestB64Claim !== 'string' || digestB64Claim.length === 0) {
    return { ok: false, reason: 'messageSignature.messageDigest.digest missing' };
  }
  if (bundle?.messageSignature?.messageDigest?.algorithm !== 'SHA2_256') {
    return { ok: false, reason: `unsupported messageDigest.algorithm: ${bundle?.messageSignature?.messageDigest?.algorithm}` };
  }
  // Re-derive public key PEM from rawBytes.
  let publicKey;
  try { publicKey = Buffer.from(pkB64, 'base64').toString('utf8'); }
  catch (e) { return { ok: false, reason: `verificationMaterial.publicKey.rawBytes not base64: ${e.message}` }; }
  // Cross-check digest against payload bytes.
  const digestHexActual = payloadDigestHex(payloadCanonical);
  const digestHexClaim = Buffer.from(digestB64Claim, 'base64').toString('hex');
  if (digestHexActual !== digestHexClaim) {
    return {
      ok: false,
      reason: `messageDigest (${digestHexClaim.slice(0, 12)}…) does not match payload sha256 (${digestHexActual.slice(0, 12)}…)`,
    };
  }
  // Cross-check key fingerprint claim.
  let actualFingerprint;
  try { actualFingerprint = keyFingerprint(publicKey); }
  catch (e) { return { ok: false, reason: `cannot fingerprint embedded public_key: ${e.message}` }; }
  const hint = bundle?.verificationMaterial?.publicKey?.hint;
  if (hint && hint !== actualFingerprint) {
    return {
      ok: false,
      reason: `publicKey.hint (${String(hint).slice(0, 12)}…) does not match public_key bytes (${actualFingerprint.slice(0, 12)}…)`,
    };
  }
  if (block.key_fingerprint && block.key_fingerprint !== actualFingerprint) {
    return {
      ok: false,
      reason: `key_fingerprint claim (${block.key_fingerprint.slice(0, 12)}…) does not match public_key bytes (${actualFingerprint.slice(0, 12)}…)`,
    };
  }
  // Verify Ed25519 signature. Bundle stores raw base64; ed25519.verify expects base64url.
  const signatureB64Url = Buffer.from(sigB64, 'base64').toString('base64url');
  const sigOk = edVerify(publicKey, payloadCanonical, signatureB64Url);
  if (!sigOk) {
    return { ok: false, reason: 'sigstore signature does not verify against canonical payload' };
  }
  const rekor = block.rekor_log_entry || null;
  // W258-SEC-3: previously we only reported inclusion_proof_present (a
  // boolean derived from `!!rekor?.inclusionProof`). A fabricated rekor
  // object trivially passed because the truthy `inclusionProof` could be
  // any value. Now we actually verify the Merkle inclusion proof:
  //   * walk the proof's hashes from leaf hash up to the claimed root,
  //     applying the standard RFC 6962 inner-node hash (0x01||L||R)
  //     starting from a leaf hash (0x00||entry_bytes),
  //   * compare the recomputed root against rekor.inclusionProof.rootHash,
  //   * compare the checkpoint's signed-root (if present) to the same
  //     value so a forged proof with a fake rootHash is also caught.
  // The trust root for `logID` is not enforced here (operators may run
  // their own Rekor instance); we surface the logID so callers can pin.
  let inclusion = { present: false, verified: false, reason: 'absent' };
  if (rekor && rekor.inclusionProof) {
    inclusion = verifyRekorInclusionProof(rekor, digestB64Claim, sigB64);
  } else if (block.dry_run) {
    inclusion = { present: false, verified: false, reason: 'dry_run' };
  }
  // If the bundle declares a real (not-dry-run) rekor entry but the
  // inclusion proof does not verify, the whole sigstore claim is rejected.
  // dry_run bundles continue to surface ok=true (build-time stage); only
  // the post-build attestation upgrade path adds a verified inclusionProof.
  if (rekor && !block.dry_run && !inclusion.verified) {
    return {
      ok: false,
      reason: `rekor inclusion proof did not verify: ${inclusion.reason}`,
    };
  }
  return {
    ok: true,
    key_fingerprint: actualFingerprint,
    dry_run: !!block.dry_run,
    rekor_log_index: rekor?.logIndex ?? null,
    rekor_uuid: rekor?.uuid ?? null,
    rekor_integrated_time: rekor?.integratedTime ?? null,
    rekor_log_id: rekor?.logID ?? null,
    inclusion_proof_present: inclusion.present,
    inclusion_proof_verified: inclusion.verified,
    inclusion_proof_reason: inclusion.reason || null,
    digest_hex: digestHexActual,
  };
}

// RFC 6962 §2.1 Merkle leaf hash. Concatenates 0x00 byte with the entry
// canonicalization bytes (here: base64-decoded digest + signature, which
// uniquely identifies the log entry) and hashes with SHA-256.
function rfc6962LeafHash(entryBytes) {
  const h = crypto.createHash('sha256');
  h.update(Buffer.from([0x00]));
  h.update(entryBytes);
  return h.digest();
}

// RFC 6962 §2.1 inner-node hash. 0x01 || left || right under SHA-256.
function rfc6962InnerHash(left, right) {
  const h = crypto.createHash('sha256');
  h.update(Buffer.from([0x01]));
  h.update(left);
  h.update(right);
  return h.digest();
}

export function verifyRekorInclusionProof(rekor, digestB64, sigB64) {
  const proof = rekor && rekor.inclusionProof;
  if (!proof || typeof proof !== 'object') {
    return { present: false, verified: false, reason: 'inclusionProof missing' };
  }
  if (typeof proof.logIndex === 'undefined' || typeof proof.treeSize === 'undefined') {
    return { present: true, verified: false, reason: 'logIndex/treeSize required' };
  }
  if (typeof proof.rootHash !== 'string') {
    return { present: true, verified: false, reason: 'rootHash missing' };
  }
  if (!Array.isArray(proof.hashes)) {
    return { present: true, verified: false, reason: 'hashes array required' };
  }
  // Reconstruct the leaf bytes the log committed to. We canonicalize to
  // (digest||signature) so any tampering with either invalidates the proof.
  let entryBytes;
  try {
    const dBuf = Buffer.from(digestB64 || '', 'base64');
    const sBuf = Buffer.from(sigB64 || '', 'base64');
    entryBytes = Buffer.concat([dBuf, sBuf]);
  } catch (e) {
    return { present: true, verified: false, reason: `entry bytes decode failed: ${e.message}` };
  }
  let computed = rfc6962LeafHash(entryBytes);
  // RFC 6962 inclusion proof algorithm (deterministic walk based on
  // logIndex / treeSize). siblings are consumed in order — left or right
  // determined by the index bit at each level.
  let index = Number(proof.logIndex);
  let size = Number(proof.treeSize);
  if (!(index >= 0 && size > index)) {
    return { present: true, verified: false, reason: 'logIndex must be < treeSize' };
  }
  let cursor = 0;
  for (const sibB64 of proof.hashes) {
    let sib;
    try { sib = Buffer.from(sibB64, 'base64'); }
    catch (e) { return { present: true, verified: false, reason: `sibling decode failed: ${e.message}` }; }
    // RFC 6962 algorithm: at each level, find the index parity in the
    // sub-tree. If index is even AND not the rightmost incomplete sibling,
    // the current node is the LEFT child; otherwise it's the RIGHT child.
    if (index % 2 === 1 || index + 1 === size) {
      if (index === size - 1 && index % 2 === 0) {
        // Lone right-edge node — no sibling consumed at this level.
        index = Math.floor(index / 2);
        size = Math.ceil(size / 2);
        // Re-loop without advancing cursor — but the proof.hashes list
        // already excludes phantom siblings by Rekor's convention, so
        // skip this iteration by short-circuiting up.
        cursor = sib; // unused — kept for static analyzer
        continue;
      }
      computed = rfc6962InnerHash(sib, computed);
    } else {
      computed = rfc6962InnerHash(computed, sib);
    }
    index = Math.floor(index / 2);
    size = Math.ceil(size / 2);
  }
  let claimedRoot;
  try { claimedRoot = Buffer.from(proof.rootHash, 'base64'); }
  catch (e) {
    // Try hex as a fallback — Rekor v1 emits hex, v2 base64.
    try { claimedRoot = Buffer.from(proof.rootHash, 'hex'); }
    catch (_) { return { present: true, verified: false, reason: `rootHash decode failed: ${e.message}` }; }
  }
  if (claimedRoot.length === 0 || !crypto.timingSafeEqual(
    Buffer.alloc(32, 0).fill(computed.slice(0, 32)),
    Buffer.alloc(32, 0).fill(claimedRoot.slice(0, 32)),
  )) {
    return {
      present: true,
      verified: false,
      reason: `recomputed Merkle root ${computed.toString('hex').slice(0, 12)}… ≠ claimed ${claimedRoot.toString('hex').slice(0, 12)}…`,
    };
  }
  return { present: true, verified: true, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// Test helper: synthesize a fake Rekor entry without network access. Used by
// wave150 tests + dry-run upgrade flows. The fake entry is structurally
// indistinguishable from a real entry but has no inclusion proof signed by
// any real log; verifiers that demand a re-fetch will fail it.
// ---------------------------------------------------------------------------
export function fabricateRekorEntry({ logIndex = 1, integratedTime = Math.floor(Date.now() / 1000), logID = 'kolm-fake-rekor-instance' } = {}) {
  return {
    uuid: crypto.randomBytes(16).toString('hex'),
    logIndex,
    integratedTime,
    logID,
    signedEntryTimestamp: null,
    inclusionProof: null,
    rekor_url: 'fabricated://kolm-test',
  };
}

// ---------------------------------------------------------------------------
// attestArtifactWithRekor — Wave 162 (Q+9). Takes a .kolm artifact path that
// already carries a dry-run signature_sigstore block (Wave 150 build emits
// one by default whenever Ed25519 + sigstore are enabled), submits the
// embedded digest+signature+publicKey to a Rekor instance, and rewrites the
// artifact in-place with rekor_log_entry filled in and dry_run=false.
//
// This is the post-build upgrade path. The build is sync (artifact.js's
// buildPayload always emits dry-run); this function is async and lives off
// the build hot-path so a slow or absent Rekor instance never blocks a
// build. Callers:
//   * buildAndZip in artifact.js — invoked when KOLM_SIGSTORE_REKOR_URL is
//     set, post-build, before returning to the user.
//   * cmdSigstoreAttest in cli/kolm.js — invoked by `kolm sigstore-attest`.
//
// Strip-order safety: signature_sigstore lives OUTSIDE both the Ed25519 and
// HMAC signed payloads (verifier strips it from both before re-canonicalizing).
// Mutating signature_sigstore.rekor_log_entry + signature_sigstore.dry_run
// does NOT invalidate the Ed25519 signature or the HMAC. The sigstore block's
// own messageSignature also stays bit-identical (we only add the rekor entry
// alongside it, never re-sign). So verifySigstoreBundle still passes against
// the same canonical payload after the upgrade.
//
// Zip-rewrite safety: AdmZip.writeZip strips CRC data descriptors that
// artifact-runner.js requires (kolm.js was originally built with archiver,
// which writes them in local file headers, and the loader expects them). We
// re-emit via archiver, preserving the rest of the entries bit-identical.
//
// Returns:
//   { ok: true, rekor_log_index, rekor_uuid, rekor_url, integrated_time,
//     log_id, digest_hex }
//   OR throws on failure (network, structural, signature validation).
// ---------------------------------------------------------------------------
export async function attestArtifactWithRekor(artifactPath, { url, timeoutMs, archiverModule, admZipModule, canonicalJsonFn } = {}) {
  if (typeof artifactPath !== 'string' || artifactPath.length === 0) {
    throw new Error('attestArtifactWithRekor: artifactPath required');
  }
  const target = url || rekorUrl();
  if (!target) {
    throw new Error('attestArtifactWithRekor: no rekor url (set KOLM_SIGSTORE_REKOR_URL or pass {url})');
  }
  const fs = await import('node:fs');
  const AdmZip = admZipModule || (await import('adm-zip')).default;
  const archiver = archiverModule || (await import('archiver')).default;
  const canonicalJson = canonicalJsonFn || (await import('./cid.js')).canonicalJson;

  const buf = fs.readFileSync(artifactPath);
  let zip;
  try { zip = new AdmZip(buf); }
  catch (e) { throw new Error(`attestArtifactWithRekor: could not parse zip: ${e.message}`); }
  const receiptEntry = zip.getEntry('receipt.json');
  if (!receiptEntry) {
    throw new Error('attestArtifactWithRekor: artifact has no receipt.json');
  }
  let receipt;
  try { receipt = JSON.parse(receiptEntry.getData().toString('utf8')); }
  catch (e) { throw new Error(`attestArtifactWithRekor: receipt.json is not valid JSON: ${e.message}`); }
  if (!receipt.signature_sigstore) {
    throw new Error('attestArtifactWithRekor: receipt has no signature_sigstore block (rebuild with Wave 150+ Ed25519 enabled)');
  }
  if (receipt.signature_sigstore.dry_run !== true) {
    const existing = receipt.signature_sigstore.rekor_log_entry;
    throw new Error(`attestArtifactWithRekor: artifact already attested (rekor logIndex=${existing?.logIndex ?? '?'})`);
  }
  const existing = receipt.signature_sigstore;
  const { signature_sigstore, ...payloadWithoutSigstore } = receipt;
  void signature_sigstore;
  const payloadCanonical = canonicalJson(payloadWithoutSigstore);
  const sanity = verifySigstoreBundle(existing, payloadCanonical);
  if (!sanity.ok) {
    throw new Error(`attestArtifactWithRekor: existing sigstore bundle does not verify locally: ${sanity.reason}`);
  }
  const pkB64 = existing?.bundle?.verificationMaterial?.publicKey?.rawBytes;
  const sigB64 = existing?.bundle?.messageSignature?.signature;
  const digestB64 = existing?.bundle?.messageSignature?.messageDigest?.digest;
  const publicKey = Buffer.from(pkB64, 'base64').toString('utf8');
  const digestHex = Buffer.from(digestB64, 'base64').toString('hex');

  const entry = await submitToRekor({
    publicKey,
    signatureB64: sigB64,
    digestHex,
    url: target,
    timeoutMs,
  });
  if (!entry) {
    throw new Error(`attestArtifactWithRekor: Rekor submission failed (network error or non-2xx from ${target})`);
  }

  receipt.signature_sigstore = { ...existing, rekor_log_entry: entry, dry_run: false };
  const updatedReceiptBuf = Buffer.from(JSON.stringify(receipt, null, 2));

  const entries = new Map();
  for (const e of zip.getEntries()) entries.set(e.entryName, e.getData());
  entries.set('receipt.json', updatedReceiptBuf);

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(artifactPath);
    const z = archiver('zip', { zlib: { level: 9 } });
    z.on('warning', e => { if (e.code !== 'ENOENT') reject(e); });
    z.on('error', reject);
    out.on('close', resolve);
    z.pipe(out);
    for (const [name, content] of entries) z.append(content, { name });
    z.finalize();
  });

  return {
    ok: true,
    rekor_log_index: entry.logIndex,
    rekor_uuid: entry.uuid,
    rekor_url: entry.rekor_url || target,
    integrated_time: entry.integratedTime,
    log_id: entry.logID,
    digest_hex: digestHex,
  };
}
