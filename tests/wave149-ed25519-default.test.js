// Wave 149 — Ed25519 default-signature path + public-key directory tests.
//
// Per Wave 144 plan §Q+8: HMAC-SHA256 (Wave 0) is a symmetric MAC and cannot
// prove provenance to a third party. Wave 149 flips the default so every
// artifact ships with an Ed25519 signature_ed25519 block layered on top of
// the existing HMAC integrity check. The HMAC stays so historical receipts
// keep verifying; the Ed25519 block is what a verifier with no shared secret
// trusts.
//
// Coverage:
//   1.  generateKeyPair returns valid PEM pair
//   2.  sign / verify round-trip with the generated pair
//   3.  keyFingerprint is stable across calls + 32 hex chars
//   4.  loadOrCreateDefaultSigner generates + persists key on first call
//   5.  loadOrCreateDefaultSigner returns same key on second call (cache hit)
//   6.  loadOrCreateDefaultSigner with KOLM_ED25519_DISABLE=1 → null
//   7.  loadOrCreateDefaultSigner honors KOLM_ED25519_PRIVATE_KEY env
//   8.  buildAndZip emits signature_alg = 'ed25519+hmac-sha256' by default
//   9.  buildAndZip emits signed_by prefixed with 'ed25519:' by default
//  10.  buildAndZip with KOLM_ED25519_DISABLE=1 falls back to HMAC-only
//  11.  receipt.signature_ed25519 present + verifies against embedded pubkey
//  12.  receipt HMAC still verifies after Ed25519 layered on top
//  13.  binder verifyArtifact includes "Receipt signature (Ed25519, public-key)" check
//  14.  pubkey-directory: empty list initially
//  15.  pubkey-directory: issueChallenge + registerKey round-trip
//  16.  pubkey-directory: registerKey rejects forged signature

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  generateKeyPair,
  sign,
  verify,
  keyFingerprint,
  loadOrCreateDefaultSigner,
  buildSignatureBlock,
  verifySignatureBlock,
  ED25519_SPEC,
  ED25519_ALG,
} from '../src/ed25519.js';
import { buildAndZip } from '../src/artifact.js';
import { buildBinder } from '../src/binder.js';
import * as pubkeyDir from '../src/pubkey-directory.js';

// Test isolation: every Wave 149 test gets its own key store + receipt
// directory so we never collide with the developer's real ~/.kolm dir or
// with a sibling test's freshly-generated key.
const SECRET = 'wave149-test-secret-' + crypto.randomBytes(8).toString('hex');
process.env.RECIPE_RECEIPT_SECRET = SECRET;

function freshKeyStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w149-keys-'));
  return dir;
}

function freshPubkeyFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w149-pub-'));
  return path.join(dir, 'keys-public.json');
}

function isolateKeyStore(t) {
  const dir = freshKeyStore();
  const prevStore = process.env.KOLM_ED25519_KEY_STORE;
  const prevKey = process.env.KOLM_ED25519_PRIVATE_KEY;
  const prevPath = process.env.KOLM_ED25519_PRIVATE_KEY_PATH;
  const prevDisable = process.env.KOLM_ED25519_DISABLE;
  const prevSigstore = process.env.KOLM_SIGSTORE_DISABLE;
  process.env.KOLM_ED25519_KEY_STORE = dir;
  delete process.env.KOLM_ED25519_PRIVATE_KEY;
  delete process.env.KOLM_ED25519_PRIVATE_KEY_PATH;
  delete process.env.KOLM_ED25519_DISABLE;
  // Wave 150 — these wave-149 tests pin the signature_alg to 'ed25519+hmac-sha256',
  // which is only true when sigstore is disabled. Wave 150's default is to layer
  // sigstore on top. Disable sigstore here so wave-149 contract tests remain valid.
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  t.after(() => {
    if (prevStore === undefined) delete process.env.KOLM_ED25519_KEY_STORE;
    else process.env.KOLM_ED25519_KEY_STORE = prevStore;
    if (prevKey === undefined) delete process.env.KOLM_ED25519_PRIVATE_KEY;
    else process.env.KOLM_ED25519_PRIVATE_KEY = prevKey;
    if (prevPath === undefined) delete process.env.KOLM_ED25519_PRIVATE_KEY_PATH;
    else process.env.KOLM_ED25519_PRIVATE_KEY_PATH = prevPath;
    if (prevDisable === undefined) delete process.env.KOLM_ED25519_DISABLE;
    else process.env.KOLM_ED25519_DISABLE = prevDisable;
    if (prevSigstore === undefined) delete process.env.KOLM_SIGSTORE_DISABLE;
    else process.env.KOLM_SIGSTORE_DISABLE = prevSigstore;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  });
  return dir;
}

function isolatePubkeyDir(t) {
  const file = freshPubkeyFile();
  const prev = process.env.KOLM_PUBKEY_DIRECTORY_FILE;
  process.env.KOLM_PUBKEY_DIRECTORY_FILE = file;
  t.after(() => {
    if (prev === undefined) delete process.env.KOLM_PUBKEY_DIRECTORY_FILE;
    else process.env.KOLM_PUBKEY_DIRECTORY_FILE = prev;
    try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* swallow */ }
  });
  return file;
}

// Minimal spec → buildAndZip invocation reused across the receipt-shape tests.
async function buildOne(jobIdSuffix) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w149-artifact-'));
  const result = await buildAndZip({
    job_id: `wave149-${jobIdSuffix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    task: 'wave149-test',
    base_model: 'none',
    recipes: [{ id: 'r1', source: 'export default function r1(x){return String(x).toUpperCase()}', positives: [{ input: 'hi', expected: 'HI' }] }],
    evals: { cases: [{ input: 'hi', expected: 'HI' }] },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 10, cost_usd_per_call: 0 },
    outDir,
    tier: 'recipe',
  });
  return { ...result, outDir };
}

// ---------------------------------------------------------------------------
// 1. generateKeyPair → valid PEM pair
// ---------------------------------------------------------------------------
test('1. generateKeyPair returns valid PEM-encoded public + private keys', () => {
  const { publicKey, privateKey } = generateKeyPair();
  assert.equal(typeof publicKey, 'string');
  assert.equal(typeof privateKey, 'string');
  assert.match(publicKey, /-----BEGIN PUBLIC KEY-----/);
  assert.match(publicKey, /-----END PUBLIC KEY-----/);
  assert.match(privateKey, /-----BEGIN PRIVATE KEY-----/);
  assert.match(privateKey, /-----END PRIVATE KEY-----/);
  // Node can round-trip both forms.
  const pubObj = crypto.createPublicKey(publicKey);
  const privObj = crypto.createPrivateKey(privateKey);
  assert.equal(pubObj.asymmetricKeyType, 'ed25519');
  assert.equal(privObj.asymmetricKeyType, 'ed25519');
});

// ---------------------------------------------------------------------------
// 2. sign + verify round-trip
// ---------------------------------------------------------------------------
test('2. sign + verify round-trip with the generated pair', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const payload = 'wave149-payload-' + crypto.randomBytes(4).toString('hex');
  const signature = sign(privateKey, payload);
  assert.equal(typeof signature, 'string');
  assert.ok(signature.length > 40, 'base64url ed25519 sig is ~86 chars');
  assert.equal(verify(publicKey, payload, signature), true);
  // Tampered payload fails.
  assert.equal(verify(publicKey, payload + 'x', signature), false);
  // Wrong key fails.
  const other = generateKeyPair();
  assert.equal(verify(other.publicKey, payload, signature), false);
});

// ---------------------------------------------------------------------------
// 3. keyFingerprint stable, 32 hex
// ---------------------------------------------------------------------------
test('3. keyFingerprint is deterministic + 32 hex chars', () => {
  const { publicKey } = generateKeyPair();
  const fp1 = keyFingerprint(publicKey);
  const fp2 = keyFingerprint(publicKey);
  assert.equal(fp1, fp2);
  assert.match(fp1, /^[0-9a-f]{32}$/);
});

// ---------------------------------------------------------------------------
// 4. loadOrCreateDefaultSigner generates + persists on first call
// ---------------------------------------------------------------------------
test('4. loadOrCreateDefaultSigner generates + persists on first call', (t) => {
  const dir = isolateKeyStore(t);
  const signer = loadOrCreateDefaultSigner();
  assert.ok(signer);
  assert.equal(signer.source, 'generated');
  assert.match(signer.publicKey, /BEGIN PUBLIC KEY/);
  assert.match(signer.privateKey, /BEGIN PRIVATE KEY/);
  assert.match(signer.key_fingerprint, /^[0-9a-f]{32}$/);
  const onDisk = path.join(dir, 'signing-key.pem');
  assert.ok(fs.existsSync(onDisk), 'signing-key.pem was written to KOLM_ED25519_KEY_STORE');
  const raw = fs.readFileSync(onDisk, 'utf8');
  assert.equal(raw, signer.privateKey, 'persisted PEM matches in-memory PEM');
});

// ---------------------------------------------------------------------------
// 5. loadOrCreateDefaultSigner cache hit on second call
// ---------------------------------------------------------------------------
test('5. loadOrCreateDefaultSigner returns same key on second call (cache hit)', (t) => {
  isolateKeyStore(t);
  const a = loadOrCreateDefaultSigner();
  const b = loadOrCreateDefaultSigner();
  assert.equal(a.source, 'generated');
  assert.equal(b.source, 'cache');
  assert.equal(a.key_fingerprint, b.key_fingerprint);
  assert.equal(a.publicKey, b.publicKey);
});

// ---------------------------------------------------------------------------
// 6. KOLM_ED25519_DISABLE=1 → null
// ---------------------------------------------------------------------------
test('6. loadOrCreateDefaultSigner respects KOLM_ED25519_DISABLE=1', (t) => {
  isolateKeyStore(t);
  process.env.KOLM_ED25519_DISABLE = '1';
  const signer = loadOrCreateDefaultSigner();
  assert.equal(signer, null);
});

// ---------------------------------------------------------------------------
// 7. KOLM_ED25519_PRIVATE_KEY env path wins over cache
// ---------------------------------------------------------------------------
test('7. loadOrCreateDefaultSigner honors KOLM_ED25519_PRIVATE_KEY env (source=env)', (t) => {
  isolateKeyStore(t);
  const { privateKey, publicKey } = generateKeyPair();
  const fp = keyFingerprint(publicKey);
  process.env.KOLM_ED25519_PRIVATE_KEY = privateKey;
  const signer = loadOrCreateDefaultSigner();
  assert.ok(signer);
  assert.equal(signer.source, 'env');
  assert.equal(signer.key_fingerprint, fp);
});

// ---------------------------------------------------------------------------
// 8. buildAndZip → signature_alg = 'ed25519+hmac-sha256'
// ---------------------------------------------------------------------------
test('8. buildAndZip emits signature_alg = "ed25519+hmac-sha256" by default', async (t) => {
  isolateKeyStore(t);
  const result = await buildOne('alg');
  assert.equal(result.receipt.signature_alg, 'ed25519+hmac-sha256');
});

// ---------------------------------------------------------------------------
// 9. buildAndZip → signed_by starts with 'ed25519:'
// ---------------------------------------------------------------------------
test('9. buildAndZip emits signed_by prefixed with "ed25519:"', async (t) => {
  isolateKeyStore(t);
  const result = await buildOne('signedby');
  assert.match(result.receipt.signed_by, /^ed25519:[0-9a-f]{32}$/);
});

// ---------------------------------------------------------------------------
// 10. KOLM_ED25519_DISABLE=1 → HMAC-only fallback
// ---------------------------------------------------------------------------
test('10. buildAndZip with KOLM_ED25519_DISABLE=1 falls back to HMAC-only signing', async (t) => {
  isolateKeyStore(t);
  process.env.KOLM_ED25519_DISABLE = '1';
  const result = await buildOne('disabled');
  assert.equal(result.receipt.signature_alg, 'hmac-sha256');
  assert.equal(result.receipt.signed_by, 'kolm-dev-hmac-1');
  assert.equal(result.receipt.signature_ed25519, undefined, 'no Ed25519 block when disabled');
});

// ---------------------------------------------------------------------------
// 11. signature_ed25519 verifies against embedded public key
// ---------------------------------------------------------------------------
test('11. receipt.signature_ed25519 verifies against embedded public key', async (t) => {
  isolateKeyStore(t);
  const result = await buildOne('ed25519-verify');
  const receipt = result.receipt;
  assert.ok(receipt.signature_ed25519, 'signature_ed25519 block present');
  assert.equal(receipt.signature_ed25519.spec, ED25519_SPEC);
  assert.equal(receipt.signature_ed25519.alg, ED25519_ALG);
  // Reconstruct the canonical payload by stripping the Ed25519 + sigstore
  // (Wave 150) blocks — Ed25519 signs the body BEFORE sigstore is layered.
  const { signature_ed25519, signature_sigstore, ...payloadObj } = receipt;
  void signature_sigstore;
  const canonicalJson = (await import('../src/cid.js')).canonicalJson;
  const canon = canonicalJson(payloadObj);
  const r = verifySignatureBlock(signature_ed25519, canon);
  assert.equal(r.ok, true, `verify failed: ${r.reason || ''}`);
  assert.equal(r.key_fingerprint, signature_ed25519.key_fingerprint);
});

// ---------------------------------------------------------------------------
// 12. HMAC still verifies alongside Ed25519
// ---------------------------------------------------------------------------
test('12. receipt HMAC still verifies after Ed25519 layered on top', async (t) => {
  isolateKeyStore(t);
  const result = await buildOne('hmac-coexist');
  const receipt = result.receipt;
  // Verifier strips ALL signature blocks (HMAC + Ed25519 + sigstore-wave-150)
  // and re-canonicalizes; HMAC is the innermost of the three.
  const { signature, signature_ed25519, signature_sigstore, ...rest } = receipt;
  void signature_ed25519; void signature_sigstore;
  const canonicalJson = (await import('../src/cid.js')).canonicalJson;
  const bodyCanon = canonicalJson(rest);
  const expected = crypto.createHmac('sha256', SECRET).update(bodyCanon).digest('hex');
  assert.equal(signature, expected, 'HMAC re-computation matches receipt.signature');
});

// ---------------------------------------------------------------------------
// 13. binder verifyArtifact reports Ed25519 check
// ---------------------------------------------------------------------------
test('13. binder buildBinder includes Ed25519 public-key check', async (t) => {
  isolateKeyStore(t);
  const result = await buildOne('binder');
  const report = await buildBinder(result.outPath);
  const edCheck = report.checks.find(c => c.name === 'Receipt signature (Ed25519, public-key)');
  assert.ok(edCheck, 'Ed25519 check present in binder report');
  assert.equal(edCheck.status, 'pass', `Ed25519 check should pass: ${edCheck.detail}`);
  const hmacCheck = report.checks.find(c => c.name === 'Audit chain (HMAC receipt)');
  assert.ok(hmacCheck, 'HMAC check still present');
  assert.equal(hmacCheck.status, 'pass', `HMAC should still pass: ${hmacCheck.detail}`);
});

// ---------------------------------------------------------------------------
// 14. pubkey-directory: empty list initially
// ---------------------------------------------------------------------------
test('14. pubkey-directory listKeys returns empty array on fresh file', (t) => {
  isolatePubkeyDir(t);
  pubkeyDir._resetForTests();
  const keys = pubkeyDir.listKeys();
  assert.deepEqual(keys, []);
  const stats = pubkeyDir.stats();
  assert.equal(stats.key_count, 0);
  assert.equal(stats.active_challenges, 0);
});

// ---------------------------------------------------------------------------
// 15. pubkey-directory: issueChallenge + registerKey round-trip
// ---------------------------------------------------------------------------
test('15. pubkey-directory issueChallenge + registerKey round-trip', (t) => {
  isolatePubkeyDir(t);
  pubkeyDir._resetForTests();
  const { publicKey, privateKey } = generateKeyPair();
  const ch = pubkeyDir.issueChallenge({ tenant_id: 't-test', label: 'wave149 test' });
  assert.ok(ch.challenge_id);
  assert.ok(ch.nonce);
  assert.ok(ch.expires_at);
  const signature = sign(privateKey, ch.nonce);
  const entry = pubkeyDir.registerKey({
    challenge_id: ch.challenge_id,
    public_key: publicKey,
    signature,
    label: 'wave149 test',
    tenant_id: 't-test',
  });
  assert.equal(entry.alg, 'ed25519');
  assert.equal(entry.tenant_id, 't-test');
  // keyFingerprint truncates SHA256 to 32 hex chars; short_fingerprint mirrors it.
  assert.equal(entry.fingerprint.length, 32);
  assert.equal(entry.short_fingerprint.length, 32);
  assert.match(entry.fingerprint, /^[0-9a-f]{32}$/);
  // Now visible in listKeys + getKey lookup.
  const listed = pubkeyDir.listKeys();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].fingerprint, entry.fingerprint);
  const fetched = pubkeyDir.getKey(entry.short_fingerprint);
  assert.ok(fetched);
  assert.equal(fetched.fingerprint, entry.fingerprint);
  // deleteKey removes it.
  assert.equal(pubkeyDir.deleteKey(entry.short_fingerprint), true);
  assert.equal(pubkeyDir.listKeys().length, 0);
});

// ---------------------------------------------------------------------------
// 16. pubkey-directory: registerKey rejects forged signature
// ---------------------------------------------------------------------------
test('16. pubkey-directory registerKey rejects forged signature', (t) => {
  isolatePubkeyDir(t);
  pubkeyDir._resetForTests();
  const { publicKey } = generateKeyPair();
  const ch = pubkeyDir.issueChallenge({ tenant_id: 't-test' });
  // Forge with a different key — should fail proof-of-control.
  const forger = generateKeyPair();
  const forgedSig = sign(forger.privateKey, ch.nonce);
  assert.throws(
    () => pubkeyDir.registerKey({
      challenge_id: ch.challenge_id,
      public_key: publicKey,
      signature: forgedSig,
    }),
    /signature does not verify/i,
  );
  // Unknown challenge_id also rejected.
  assert.throws(
    () => pubkeyDir.registerKey({
      challenge_id: 'never-issued',
      public_key: publicKey,
      signature: forgedSig,
    }),
    /unknown or expired challenge/i,
  );
});
