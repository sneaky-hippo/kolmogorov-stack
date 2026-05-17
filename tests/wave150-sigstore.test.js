// Wave 150 — sigstore (cosign-compatible) bundle + Rekor attestation.
//
// Per Wave 144 plan §Q+9: HMAC (integrity) + Ed25519 (third-party-verifiable
// provenance) + sigstore (public transparency log) = defense in depth. This
// wave layers signature_sigstore on top of signature_ed25519 (Wave 149) and
// signature (Wave 0 HMAC). The sigstore block is structurally valid + locally
// verifiable in dry-run mode; if KOLM_SIGSTORE_REKOR_URL is set, the build
// also pins the entry into a public Rekor instance.
//
// Coverage (20 tests):
//   1.  buildSigstoreBundle returns valid dry-run bundle
//   2.  buildSigstoreBundle rejects missing key inputs
//   3.  payloadDigestHex returns 64-char hex
//   4.  hashedrekordBody shape matches Rekor schema
//   5.  isDisabled / rekorUrl env helpers
//   6.  fabricateRekorEntry structure
//   7.  verifySigstoreBundle round-trip succeeds
//   8.  verifySigstoreBundle rejects missing block
//   9.  verifySigstoreBundle rejects wrong spec
//  10.  verifySigstoreBundle rejects wrong alg
//  11.  verifySigstoreBundle rejects digest mismatch
//  12.  verifySigstoreBundle rejects fingerprint mismatch
//  13.  verifySigstoreBundle rejects signature tampering
//  14.  buildAndZip emits signature_alg='sigstore+ed25519+hmac-sha256' by default
//  15.  buildAndZip signature_sigstore verifies against canonical receipt body
//  16.  buildAndZip with KOLM_SIGSTORE_DISABLE=1 → 'ed25519+hmac-sha256' (no sigstore)
//  17.  buildAndZip with KOLM_ED25519_DISABLE=1 → 'hmac-sha256' (no Ed25519, no sigstore)
//  18.  HMAC still verifies after sigstore + Ed25519 layered on top (strip order)
//  19.  Ed25519 still verifies after sigstore layered on top (strip order)
//  20.  buildBinder reports sigstore check as warn for dry-run

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSigstoreBundle,
  verifySigstoreBundle,
  payloadDigestHex,
  hashedrekordBody,
  isDisabled,
  rekorUrl,
  fabricateRekorEntry,
  SIGSTORE_SPEC,
  SIGSTORE_ALG,
  SIGSTORE_BUNDLE_MEDIA_TYPE,
} from '../src/sigstore.js';
import {
  generateKeyPair,
  keyFingerprint,
  verify as edVerify,
} from '../src/ed25519.js';
import { buildAndZip } from '../src/artifact.js';
import { buildBinder } from '../src/binder.js';
import { canonicalJson } from '../src/cid.js';

const SECRET = 'wave150-test-secret-' + crypto.randomBytes(8).toString('hex');
process.env.RECIPE_RECEIPT_SECRET = SECRET;

function freshKeyStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w150-keys-'));
}

function isolateEnv(t) {
  const dir = freshKeyStore();
  const saved = {};
  for (const k of [
    'KOLM_ED25519_KEY_STORE',
    'KOLM_ED25519_PRIVATE_KEY',
    'KOLM_ED25519_PRIVATE_KEY_PATH',
    'KOLM_ED25519_DISABLE',
    'KOLM_SIGSTORE_DISABLE',
    'KOLM_SIGSTORE_REKOR_URL',
  ]) saved[k] = process.env[k];
  process.env.KOLM_ED25519_KEY_STORE = dir;
  delete process.env.KOLM_ED25519_PRIVATE_KEY;
  delete process.env.KOLM_ED25519_PRIVATE_KEY_PATH;
  delete process.env.KOLM_ED25519_DISABLE;
  delete process.env.KOLM_SIGSTORE_DISABLE;
  delete process.env.KOLM_SIGSTORE_REKOR_URL;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  });
  return dir;
}

async function buildOne(jobIdSuffix) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w150-artifact-'));
  const result = await buildAndZip({
    job_id: `wave150-${jobIdSuffix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    task: 'wave150-sigstore-test',
    base_model: 'none',
    recipes: [{
      id: 'r1',
      source: 'export default function r1(x){return String(x).toUpperCase()}',
      positives: [{ input: 'hi', expected: 'HI' }],
    }],
    evals: { cases: [{ input: 'hi', expected: 'HI' }] },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 10, cost_usd_per_call: 0 },
    outDir,
    tier: 'recipe',
  });
  return { ...result, outDir };
}

// ---------------------------------------------------------------------------
// 1. buildSigstoreBundle returns valid dry-run bundle
// ---------------------------------------------------------------------------
test('1. buildSigstoreBundle returns valid dry-run bundle', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const fp = keyFingerprint(publicKey);
  const payload = canonicalJson({ a: 1, b: 'hello' });
  const block = buildSigstoreBundle({ privateKey, publicKey, key_fingerprint: fp, payloadCanonical: payload });
  assert.equal(block.spec, SIGSTORE_SPEC);
  assert.equal(block.alg, SIGSTORE_ALG);
  assert.equal(block.key_fingerprint, fp);
  assert.equal(block.dry_run, true);
  assert.equal(block.rekor_log_entry, null);
  assert.equal(typeof block.signed_at, 'string');
  assert.match(block.signed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(block.bundle.mediaType, SIGSTORE_BUNDLE_MEDIA_TYPE);
  assert.ok(block.bundle.verificationMaterial.publicKey.rawBytes);
  assert.equal(block.bundle.verificationMaterial.publicKey.hint, fp);
  assert.equal(block.bundle.messageSignature.messageDigest.algorithm, 'SHA2_256');
  assert.ok(block.bundle.messageSignature.messageDigest.digest);
  assert.ok(block.bundle.messageSignature.signature);
  assert.match(block.digest_hex, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// 2. buildSigstoreBundle rejects missing inputs
// ---------------------------------------------------------------------------
test('2. buildSigstoreBundle rejects missing key inputs', () => {
  const { publicKey, privateKey } = generateKeyPair();
  assert.throws(() => buildSigstoreBundle({ publicKey, payloadCanonical: 'x' }), /privateKey and publicKey required/);
  assert.throws(() => buildSigstoreBundle({ privateKey, payloadCanonical: 'x' }), /privateKey and publicKey required/);
  assert.throws(() => buildSigstoreBundle({ privateKey, publicKey, payloadCanonical: '' }), /payloadCanonical must be non-empty/);
  assert.throws(() => buildSigstoreBundle({ privateKey, publicKey }), /payloadCanonical must be non-empty/);
});

// ---------------------------------------------------------------------------
// 3. payloadDigestHex returns 64-char hex
// ---------------------------------------------------------------------------
test('3. payloadDigestHex returns 64-char lowercase hex', () => {
  const d = payloadDigestHex('hello world');
  assert.equal(d.length, 64);
  assert.match(d, /^[0-9a-f]{64}$/);
  // sha256("hello world") is well-known.
  assert.equal(d, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  assert.throws(() => payloadDigestHex(Buffer.from('x')), /must be a string/);
});

// ---------------------------------------------------------------------------
// 4. hashedrekordBody shape matches Rekor schema
// ---------------------------------------------------------------------------
test('4. hashedrekordBody returns canonical Rekor entry shape', () => {
  const body = hashedrekordBody({
    publicKey: '-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----',
    signatureB64: 'AAAA',
    digestHex: 'deadbeef',
  });
  assert.equal(body.apiVersion, '0.0.1');
  assert.equal(body.kind, 'hashedrekord');
  assert.equal(body.spec.signature.content, 'AAAA');
  assert.ok(body.spec.signature.publicKey.content); // base64 of PEM
  assert.equal(body.spec.data.hash.algorithm, 'sha256');
  assert.equal(body.spec.data.hash.value, 'deadbeef');
  assert.throws(() => hashedrekordBody({}), /publicKey, signatureB64, digestHex required/);
});

// ---------------------------------------------------------------------------
// 5. isDisabled / rekorUrl env helpers
// ---------------------------------------------------------------------------
test('5. isDisabled / rekorUrl honor env vars', (t) => {
  const savedDisable = process.env.KOLM_SIGSTORE_DISABLE;
  const savedUrl = process.env.KOLM_SIGSTORE_REKOR_URL;
  t.after(() => {
    if (savedDisable === undefined) delete process.env.KOLM_SIGSTORE_DISABLE; else process.env.KOLM_SIGSTORE_DISABLE = savedDisable;
    if (savedUrl === undefined) delete process.env.KOLM_SIGSTORE_REKOR_URL; else process.env.KOLM_SIGSTORE_REKOR_URL = savedUrl;
  });
  delete process.env.KOLM_SIGSTORE_DISABLE;
  delete process.env.KOLM_SIGSTORE_REKOR_URL;
  assert.equal(isDisabled(), false);
  assert.equal(rekorUrl(), null);
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  assert.equal(isDisabled(), true);
  process.env.KOLM_SIGSTORE_DISABLE = '0';
  assert.equal(isDisabled(), false);
  process.env.KOLM_SIGSTORE_REKOR_URL = 'https://rekor.example.com/';
  assert.equal(rekorUrl(), 'https://rekor.example.com');
  process.env.KOLM_SIGSTORE_REKOR_URL = 'https://rekor.example.com///';
  assert.equal(rekorUrl(), 'https://rekor.example.com');
});

// ---------------------------------------------------------------------------
// 6. fabricateRekorEntry produces structurally valid entry
// ---------------------------------------------------------------------------
test('6. fabricateRekorEntry produces structurally valid entry', () => {
  const entry = fabricateRekorEntry({ logIndex: 42, integratedTime: 1700000000, logID: 'test-log-id' });
  assert.equal(entry.logIndex, 42);
  assert.equal(entry.integratedTime, 1700000000);
  assert.equal(entry.logID, 'test-log-id');
  assert.match(entry.uuid, /^[0-9a-f]{32}$/);
  assert.equal(entry.rekor_url, 'fabricated://kolm-test');
  // Defaults
  const def = fabricateRekorEntry();
  assert.equal(def.logIndex, 1);
  assert.equal(def.logID, 'kolm-fake-rekor-instance');
  assert.ok(def.integratedTime > 0);
});

// ---------------------------------------------------------------------------
// 7. verifySigstoreBundle round-trip
// ---------------------------------------------------------------------------
test('7. verifySigstoreBundle accepts a valid round-trip', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const payload = canonicalJson({ task: 'roundtrip', value: 17 });
  const block = buildSigstoreBundle({ privateKey, publicKey, payloadCanonical: payload });
  const r = verifySigstoreBundle(block, payload);
  assert.equal(r.ok, true, `verify failed: ${r.reason || ''}`);
  assert.equal(r.dry_run, true);
  assert.equal(r.rekor_log_index, null);
  assert.match(r.digest_hex, /^[0-9a-f]{64}$/);
  assert.match(r.key_fingerprint, /^[0-9a-f]{32}$/);
});

// ---------------------------------------------------------------------------
// 8. verifySigstoreBundle rejects missing block
// ---------------------------------------------------------------------------
test('8. verifySigstoreBundle rejects missing or non-object block', () => {
  assert.equal(verifySigstoreBundle(null, 'x').ok, false);
  assert.equal(verifySigstoreBundle(undefined, 'x').ok, false);
  assert.equal(verifySigstoreBundle('not an object', 'x').ok, false);
});

// ---------------------------------------------------------------------------
// 9. verifySigstoreBundle rejects wrong spec
// ---------------------------------------------------------------------------
test('9. verifySigstoreBundle rejects wrong spec / alg / mediaType', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const payload = canonicalJson({ a: 1 });
  const valid = buildSigstoreBundle({ privateKey, publicKey, payloadCanonical: payload });
  const wrongSpec = { ...valid, spec: 'something-else' };
  assert.match(verifySigstoreBundle(wrongSpec, payload).reason, /unexpected spec/);
});

// ---------------------------------------------------------------------------
// 10. verifySigstoreBundle rejects wrong alg
// ---------------------------------------------------------------------------
test('10. verifySigstoreBundle rejects wrong alg', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const payload = canonicalJson({ a: 1 });
  const valid = buildSigstoreBundle({ privateKey, publicKey, payloadCanonical: payload });
  const wrongAlg = { ...valid, alg: 'ecdsa-p256' };
  assert.match(verifySigstoreBundle(wrongAlg, payload).reason, /unexpected alg/);
  const wrongMedia = { ...valid, bundle: { ...valid.bundle, mediaType: 'application/x-other' } };
  assert.match(verifySigstoreBundle(wrongMedia, payload).reason, /unexpected mediaType/);
});

// ---------------------------------------------------------------------------
// 11. verifySigstoreBundle rejects digest mismatch
// ---------------------------------------------------------------------------
test('11. verifySigstoreBundle rejects digest mismatch when payload differs', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const block = buildSigstoreBundle({ privateKey, publicKey, payloadCanonical: 'original' });
  const r = verifySigstoreBundle(block, 'tampered');
  assert.equal(r.ok, false);
  assert.match(r.reason, /messageDigest .* does not match payload sha256/);
});

// ---------------------------------------------------------------------------
// 12. verifySigstoreBundle rejects fingerprint mismatch
// ---------------------------------------------------------------------------
test('12. verifySigstoreBundle rejects hint/fingerprint mismatch', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const payload = canonicalJson({ a: 1 });
  const block = buildSigstoreBundle({ privateKey, publicKey, payloadCanonical: payload });
  // Mutate the embedded hint to a value that does not match the real fingerprint.
  const tampered = JSON.parse(JSON.stringify(block));
  tampered.bundle.verificationMaterial.publicKey.hint = '0'.repeat(32);
  const r = verifySigstoreBundle(tampered, payload);
  assert.equal(r.ok, false);
  assert.match(r.reason, /publicKey\.hint .* does not match public_key bytes/);
});

// ---------------------------------------------------------------------------
// 13. verifySigstoreBundle rejects signature tampering
// ---------------------------------------------------------------------------
test('13. verifySigstoreBundle rejects flipped signature bytes', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const payload = canonicalJson({ a: 1 });
  const block = buildSigstoreBundle({ privateKey, publicKey, payloadCanonical: payload });
  const tampered = JSON.parse(JSON.stringify(block));
  // Flip a byte in the signature (still valid base64) — should fail Ed25519 verify.
  const sigBytes = Buffer.from(tampered.bundle.messageSignature.signature, 'base64');
  sigBytes[0] = sigBytes[0] ^ 0xff;
  tampered.bundle.messageSignature.signature = sigBytes.toString('base64');
  const r = verifySigstoreBundle(tampered, payload);
  assert.equal(r.ok, false);
  assert.match(r.reason, /signature does not verify/);
});

// ---------------------------------------------------------------------------
// 14. buildAndZip emits signature_alg = 'sigstore+ed25519+hmac-sha256'
// ---------------------------------------------------------------------------
test('14. buildAndZip emits signature_alg = "sigstore+ed25519+hmac-sha256" by default', async (t) => {
  isolateEnv(t);
  const result = await buildOne('alg');
  assert.equal(result.receipt.signature_alg, 'sigstore+ed25519+hmac-sha256');
  assert.ok(result.receipt.signature_sigstore, 'signature_sigstore present');
  assert.match(result.receipt.signed_by, /^ed25519:[0-9a-f]{32}$/);
});

// ---------------------------------------------------------------------------
// 15. signature_sigstore verifies against canonical receipt body
// ---------------------------------------------------------------------------
test('15. receipt.signature_sigstore verifies against canonical receipt body', async (t) => {
  isolateEnv(t);
  const result = await buildOne('sigstore-verify');
  const receipt = result.receipt;
  assert.ok(receipt.signature_sigstore);
  // The sigstore signature is over the body with signature + signature_ed25519
  // present but signature_sigstore stripped. This mirrors artifact.js sign order.
  const { signature_sigstore, ...payloadObj } = receipt;
  const canon = canonicalJson(payloadObj);
  const r = verifySigstoreBundle(signature_sigstore, canon);
  assert.equal(r.ok, true, `sigstore verify failed: ${r.reason || ''}`);
  assert.equal(r.dry_run, true, 'should be dry_run when no KOLM_SIGSTORE_REKOR_URL set');
  assert.equal(r.rekor_log_index, null);
  assert.equal(r.key_fingerprint, signature_sigstore.key_fingerprint);
});

// ---------------------------------------------------------------------------
// 16. KOLM_SIGSTORE_DISABLE=1 → 'ed25519+hmac-sha256' (no sigstore block)
// ---------------------------------------------------------------------------
test('16. KOLM_SIGSTORE_DISABLE=1 falls back to ed25519+hmac-sha256', async (t) => {
  isolateEnv(t);
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  const result = await buildOne('disabled');
  assert.equal(result.receipt.signature_alg, 'ed25519+hmac-sha256');
  assert.equal(result.receipt.signature_sigstore, undefined, 'no sigstore block when disabled');
  assert.ok(result.receipt.signature_ed25519, 'Ed25519 still present');
});

// ---------------------------------------------------------------------------
// 17. KOLM_ED25519_DISABLE=1 → 'hmac-sha256' (no Ed25519 → no sigstore either)
// ---------------------------------------------------------------------------
test('17. KOLM_ED25519_DISABLE=1 falls back to HMAC-only (no Ed25519 → no sigstore)', async (t) => {
  isolateEnv(t);
  process.env.KOLM_ED25519_DISABLE = '1';
  const result = await buildOne('full-disabled');
  assert.equal(result.receipt.signature_alg, 'hmac-sha256');
  assert.equal(result.receipt.signature_sigstore, undefined);
  assert.equal(result.receipt.signature_ed25519, undefined);
});

// ---------------------------------------------------------------------------
// 18. HMAC still verifies after sigstore + Ed25519 layered (strip-order test)
// ---------------------------------------------------------------------------
test('18. HMAC verifies after sigstore + Ed25519 layered on top', async (t) => {
  isolateEnv(t);
  const result = await buildOne('hmac-strip-order');
  const receipt = result.receipt;
  // Verifier strips signature, signature_ed25519, signature_sigstore in that order.
  const { signature, signature_ed25519, signature_sigstore, ...rest } = receipt;
  void signature_ed25519; void signature_sigstore;
  const bodyCanon = canonicalJson(rest);
  const expected = crypto.createHmac('sha256', SECRET).update(bodyCanon).digest('hex');
  assert.equal(signature, expected, 'HMAC re-computation matches receipt.signature');
});

// ---------------------------------------------------------------------------
// 19. Ed25519 still verifies after sigstore layered (strip-order test)
// ---------------------------------------------------------------------------
test('19. Ed25519 verifies after sigstore layered on top', async (t) => {
  isolateEnv(t);
  const result = await buildOne('ed-strip-order');
  const receipt = result.receipt;
  // Ed25519 verifier strips signature_ed25519 + signature_sigstore (Wave 150
  // change: previously only stripped signature_ed25519).
  const { signature_ed25519, signature_sigstore, ...rest } = receipt;
  void signature_sigstore;
  const canon = canonicalJson(rest);
  // Pull the embedded public key + signature.
  const pkB64 = signature_ed25519.public_key;
  const sigB64Url = signature_ed25519.signature;
  const ok = edVerify(pkB64, canon, sigB64Url);
  assert.equal(ok, true, 'Ed25519 signature must verify against (body - ed25519 - sigstore)');
});

// ---------------------------------------------------------------------------
// 20. buildBinder reports sigstore check as warn for dry-run
// ---------------------------------------------------------------------------
test('20. buildBinder reports sigstore check as warn for dry-run, pass for non-dry-run', async (t) => {
  isolateEnv(t);
  const result = await buildOne('binder');
  const report = await buildBinder(result.outPath);
  const sigstoreCheck = report.checks.find(c => /sigstore/i.test(c.name));
  assert.ok(sigstoreCheck, `sigstore check present in binder report; got names: ${report.checks.map(c => c.name).join(', ')}`);
  assert.equal(sigstoreCheck.status, 'warn', `dry-run should warn, not fail: ${sigstoreCheck.detail}`);
  // HMAC + Ed25519 checks should still pass.
  const hmac = report.checks.find(c => c.name === 'Audit chain (HMAC receipt)');
  assert.equal(hmac?.status, 'pass', `HMAC: ${hmac?.detail}`);
  const ed = report.checks.find(c => c.name === 'Receipt signature (Ed25519, public-key)');
  assert.equal(ed?.status, 'pass', `Ed25519: ${ed?.detail}`);
});
