// Wave 162 — Q+9 Sigstore + Rekor transparency log policy.
//
// Wave 150 made sigstore the DEFAULT third signature layer (dry-run bundle,
// locally verifiable, not pinned to any public transparency log). Wave 162
// makes Rekor pinning a CONTRACT — manifest.policy.require_rekor on the
// artifact side and KOLM_REQUIRE_REKOR=1 on the verifier side together gate
// whether a dry-run-only sigstore block fails verification.
//
// Coverage (14 tests):
//   1.  manifest.policy.require_rekor defaults to false (Rekor needs network)
//   2.  manifest.policy.require_rekor=true when KOLM_REKOR_REQUIRE=1
//   3.  manifest.policy.require_rekor=false when KOLM_POLICY_OPT_OUT=1 (even if KOLM_REKOR_REQUIRE=1)
//   4.  attestArtifactWithRekor success path (fake fetch + fabricated entry)
//   5.  attestArtifactWithRekor fails when KOLM_SIGSTORE_REKOR_URL unset and no url passed
//   6.  attestArtifactWithRekor fails when artifact has no signature_sigstore (KOLM_SIGSTORE_DISABLE=1)
//   7.  attestArtifactWithRekor fails when artifact already has rekor_log_entry (not dry-run)
//   8.  attestArtifactWithRekor fails when Rekor returns non-2xx (fake fetch)
//   9.  check #18 require_rekor=true + no sigstore → fail (names the deciding side)
//   10. check #18 require_rekor=true + dry-run sigstore → fail (names the upgrade path)
//   11. check #18 require_rekor=true + pinned sigstore + sigstore check pass → pass (names logIndex)
//   12. check #18 require_rekor=false + pinned sigstore → pass (informational)
//   13. check #18 require_rekor=false + dry-run sigstore → pass (with upgrade hint)
//   14. Strip-order safety — HMAC + Ed25519 still verify after Rekor pinning mutates signature_sigstore

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  attestArtifactWithRekor,
  fabricateRekorEntry,
  verifySigstoreBundle,
  hashedrekordBody,
} from '../src/sigstore.js';
import { buildAndZip } from '../src/artifact.js';
import { buildBinder } from '../src/binder.js';
import { canonicalJson } from '../src/cid.js';
import { loadArtifact } from '../src/artifact-runner.js';

const SECRET = 'wave162-test-secret-' + crypto.randomBytes(8).toString('hex');
process.env.RECIPE_RECEIPT_SECRET = SECRET;

function freshKeyStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w162-keys-'));
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
    'KOLM_REKOR_REQUIRE',
    'KOLM_REQUIRE_REKOR',
    'KOLM_REQUIRE_ED25519',
    'KOLM_POLICY_OPT_OUT',
  ]) saved[k] = process.env[k];
  process.env.KOLM_ED25519_KEY_STORE = dir;
  delete process.env.KOLM_ED25519_PRIVATE_KEY;
  delete process.env.KOLM_ED25519_PRIVATE_KEY_PATH;
  delete process.env.KOLM_ED25519_DISABLE;
  delete process.env.KOLM_SIGSTORE_DISABLE;
  delete process.env.KOLM_SIGSTORE_REKOR_URL;
  delete process.env.KOLM_REKOR_REQUIRE;
  delete process.env.KOLM_REQUIRE_REKOR;
  delete process.env.KOLM_REQUIRE_ED25519;
  delete process.env.KOLM_POLICY_OPT_OUT;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  });
  return dir;
}

async function buildOne(jobIdSuffix, extra = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w162-artifact-'));
  const result = await buildAndZip({
    job_id: `wave162-${jobIdSuffix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    task: 'wave162-rekor-test',
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
    ...extra,
  });
  return { ...result, outDir };
}

// Install a fake global.fetch that mimics the Rekor POST/GET response shape.
// Returns a teardown that restores the original.
function withFakeFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

function fakeRekorPostResponse(entry) {
  const uuid = entry.uuid || crypto.randomBytes(16).toString('hex');
  return {
    ok: true,
    json: async () => ({
      [uuid]: {
        logIndex: entry.logIndex,
        integratedTime: entry.integratedTime,
        logID: entry.logID,
        body: Buffer.from(JSON.stringify(hashedrekordBody({
          publicKey: '-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----',
          signatureB64: 'AAAA',
          digestHex: 'deadbeef',
        }))).toString('base64'),
        verification: {
          signedEntryTimestamp: 'fake-set-' + uuid,
          inclusionProof: { logIndex: entry.logIndex, treeSize: 12345 },
        },
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// 1. manifest.policy.require_rekor defaults to false
// ---------------------------------------------------------------------------
test('1. manifest.policy.require_rekor defaults to false', async (t) => {
  isolateEnv(t);
  const { manifest } = await buildOne('default-policy');
  assert.equal(manifest.policy?.require_rekor, false,
    'default build should NOT require Rekor pinning (network egress not assumed)');
  // require_ed25519 still defaults to true — Wave 161 contract is unchanged
  assert.equal(manifest.policy?.require_ed25519, true,
    'Ed25519 default contract should still hold');
});

// ---------------------------------------------------------------------------
// 2. manifest.policy.require_rekor=true when KOLM_REKOR_REQUIRE=1
// ---------------------------------------------------------------------------
test('2. manifest.policy.require_rekor=true when KOLM_REKOR_REQUIRE=1', async (t) => {
  isolateEnv(t);
  process.env.KOLM_REKOR_REQUIRE = '1';
  // No Rekor URL set, but the build doesn't need one to set the policy field
  // (the buildAndZip Rekor-pin call would fail, but only if URL or policy is set;
  // policy=true without URL set is the build-time failure path that test 5 covers,
  // so here we just check the policy field is written correctly).
  // We set KOLM_SIGSTORE_DISABLE=1 to avoid the attempted pin path.
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  const { manifest } = await buildOne('opt-in-policy');
  assert.equal(manifest.policy?.require_rekor, true,
    'KOLM_REKOR_REQUIRE=1 should set policy.require_rekor=true');
});

// ---------------------------------------------------------------------------
// 3. KOLM_POLICY_OPT_OUT=1 suppresses policy.require_rekor (even if REKOR_REQUIRE=1)
// ---------------------------------------------------------------------------
test('3. KOLM_POLICY_OPT_OUT=1 suppresses policy.require_rekor', async (t) => {
  isolateEnv(t);
  process.env.KOLM_REKOR_REQUIRE = '1';
  process.env.KOLM_POLICY_OPT_OUT = '1';
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  const { manifest } = await buildOne('policy-opt-out');
  assert.equal(manifest.policy?.require_rekor, false,
    'KOLM_POLICY_OPT_OUT=1 should suppress the policy field even when KOLM_REKOR_REQUIRE=1');
});

// ---------------------------------------------------------------------------
// 4. attestArtifactWithRekor success path (fake fetch + fabricated entry)
// ---------------------------------------------------------------------------
test('4. attestArtifactWithRekor pins a dry-run artifact via fake fetch', async (t) => {
  isolateEnv(t);
  const { outPath } = await buildOne('attest-success');
  const fake = fabricateRekorEntry({ logIndex: 99999, integratedTime: 1763419200, logID: 'fake-log-id-w162' });
  const restore = withFakeFetch(async (url, init) => {
    assert.match(url, /\/api\/v1\/log\/entries$/, 'POST should hit /api/v1/log/entries');
    assert.equal(init.method, 'POST');
    return fakeRekorPostResponse(fake);
  });
  t.after(restore);
  const r = await attestArtifactWithRekor(outPath, { url: 'https://fake-rekor.example' });
  assert.equal(r.ok, true);
  assert.equal(r.rekor_log_index, 99999);
  assert.equal(r.integrated_time, 1763419200);
  assert.equal(r.log_id, 'fake-log-id-w162');
  // Re-read the artifact; signature_sigstore.rekor_log_entry should be populated
  const reloaded = await loadArtifact(outPath);
  const rekorEntry = reloaded.receipt.signature_sigstore?.rekor_log_entry;
  assert.ok(rekorEntry, 'rekor_log_entry should be present after attest');
  assert.equal(rekorEntry.logIndex, 99999);
  assert.equal(rekorEntry.integratedTime, 1763419200);
  assert.equal(reloaded.receipt.signature_sigstore.dry_run, false);
});

// ---------------------------------------------------------------------------
// 5. attestArtifactWithRekor fails when no URL is configured
// ---------------------------------------------------------------------------
test('5. attestArtifactWithRekor errors when no Rekor URL is configured', async (t) => {
  isolateEnv(t);
  const { outPath } = await buildOne('no-url');
  await assert.rejects(
    () => attestArtifactWithRekor(outPath),
    /no rekor url/,
    'should error with explicit "no rekor url" message',
  );
});

// ---------------------------------------------------------------------------
// 6. attestArtifactWithRekor fails when artifact has no signature_sigstore
// ---------------------------------------------------------------------------
test('6. attestArtifactWithRekor errors when artifact has no signature_sigstore', async (t) => {
  isolateEnv(t);
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  const { outPath } = await buildOne('no-sigstore');
  await assert.rejects(
    () => attestArtifactWithRekor(outPath, { url: 'https://fake-rekor.example' }),
    /no signature_sigstore block/,
  );
});

// ---------------------------------------------------------------------------
// 7. attestArtifactWithRekor refuses to re-attest an already-pinned artifact
// ---------------------------------------------------------------------------
test('7. attestArtifactWithRekor refuses to re-attest already-pinned artifact', async (t) => {
  isolateEnv(t);
  const { outPath } = await buildOne('already-pinned');
  // Pin once
  const fake = fabricateRekorEntry({ logIndex: 1, integratedTime: 1763419200 });
  const restore = withFakeFetch(async () => fakeRekorPostResponse(fake));
  t.after(restore);
  await attestArtifactWithRekor(outPath, { url: 'https://fake-rekor.example' });
  // Pin again — should reject because dry_run is now false
  await assert.rejects(
    () => attestArtifactWithRekor(outPath, { url: 'https://fake-rekor.example' }),
    /already attested/,
  );
});

// ---------------------------------------------------------------------------
// 8. attestArtifactWithRekor surfaces network failures
// ---------------------------------------------------------------------------
test('8. attestArtifactWithRekor surfaces network failures', async (t) => {
  isolateEnv(t);
  const { outPath } = await buildOne('network-fail');
  const restore = withFakeFetch(async () => ({ ok: false, json: async () => ({}) }));
  t.after(restore);
  await assert.rejects(
    () => attestArtifactWithRekor(outPath, { url: 'https://fake-rekor.example' }),
    /Rekor submission failed/,
  );
});

// ---------------------------------------------------------------------------
// 9. check #18: require_rekor=true + no sigstore → fail
// ---------------------------------------------------------------------------
test('9. check #18 fails on require_rekor=true + no signature_sigstore', async (t) => {
  isolateEnv(t);
  // Build with sigstore disabled so no signature_sigstore is present,
  // then run the binder with env KOLM_REQUIRE_REKOR=1.
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  const { outPath } = await buildOne('no-sig-but-required');
  // Now flip verifier-side env
  process.env.KOLM_REQUIRE_REKOR = '1';
  const report = await buildBinder(outPath);
  const c18 = report.checks.find(c => c.name === 'Transparency policy (Rekor)');
  assert.ok(c18, 'check #18 should always emit');
  assert.equal(c18.status, 'fail', `check #18 should fail: ${c18.detail}`);
  assert.match(c18.detail, /env KOLM_REQUIRE_REKOR=1/);
  assert.match(c18.detail, /no signature_sigstore block/);
});

// ---------------------------------------------------------------------------
// 10. check #18: require_rekor=true + dry-run sigstore → fail
// ---------------------------------------------------------------------------
test('10. check #18 fails on require_rekor=true + dry-run sigstore', async (t) => {
  isolateEnv(t);
  // Default build leaves sigstore in dry-run (no URL set)
  const { outPath, receipt } = await buildOne('dryrun-but-required');
  assert.ok(receipt.signature_sigstore, 'sanity: default build has sigstore');
  assert.equal(receipt.signature_sigstore.dry_run, true, 'sanity: dry-run by default without URL');
  process.env.KOLM_REQUIRE_REKOR = '1';
  const report = await buildBinder(outPath);
  const c18 = report.checks.find(c => c.name === 'Transparency policy (Rekor)');
  assert.equal(c18.status, 'fail');
  assert.match(c18.detail, /dry-run/);
  assert.match(c18.detail, /sigstore-attest/);
});

// ---------------------------------------------------------------------------
// 11. check #18: require_rekor=true + pinned sigstore + sigstore check pass → pass
// ---------------------------------------------------------------------------
test('11. check #18 passes on require_rekor=true + pinned sigstore', async (t) => {
  isolateEnv(t);
  // Build, then pin via attestArtifactWithRekor with a fake fetch
  const { outPath } = await buildOne('pinned-and-required');
  const fake = fabricateRekorEntry({ logIndex: 12345, integratedTime: 1763500000, logID: 'pinned-test-logid' });
  const restore = withFakeFetch(async () => fakeRekorPostResponse(fake));
  t.after(restore);
  await attestArtifactWithRekor(outPath, { url: 'https://fake-rekor.example' });
  // Verify the sigstore block is no longer dry-run
  const reloaded = await loadArtifact(outPath);
  assert.equal(reloaded.receipt.signature_sigstore.dry_run, false);
  // Run binder with verifier-side env
  process.env.KOLM_REQUIRE_REKOR = '1';
  const report = await buildBinder(outPath);
  // Sanity: sigstore bundle check should pass (signature still verifies after only
  // rekor_log_entry + dry_run were mutated)
  const sigstoreCheck = report.checks.find(c => c.name === 'Receipt signature (Sigstore bundle)');
  assert.equal(sigstoreCheck.status, 'pass',
    `sigstore bundle check should pass after Rekor pin (got ${sigstoreCheck.status}: ${sigstoreCheck.detail})`);
  // Now check #18
  const c18 = report.checks.find(c => c.name === 'Transparency policy (Rekor)');
  assert.equal(c18.status, 'pass', `check #18 should pass: ${c18.detail}`);
  assert.match(c18.detail, /logIndex=12345/);
  assert.match(c18.detail, /pinned-test-logi/); // logID prefix
});

// ---------------------------------------------------------------------------
// 12. check #18: require_rekor=false + pinned sigstore → pass (informational)
// ---------------------------------------------------------------------------
test('12. check #18 passes informationally on no-policy + pinned sigstore', async (t) => {
  isolateEnv(t);
  const { outPath } = await buildOne('pinned-no-policy');
  const fake = fabricateRekorEntry({ logIndex: 77, integratedTime: 1763500000 });
  const restore = withFakeFetch(async () => fakeRekorPostResponse(fake));
  t.after(restore);
  await attestArtifactWithRekor(outPath, { url: 'https://fake-rekor.example' });
  // No KOLM_REQUIRE_REKOR env, no policy.require_rekor on manifest
  const report = await buildBinder(outPath);
  const c18 = report.checks.find(c => c.name === 'Transparency policy (Rekor)');
  assert.equal(c18.status, 'pass');
  assert.match(c18.detail, /does not require Rekor/);
  assert.match(c18.detail, /pinned to Rekor anyway/);
  assert.match(c18.detail, /logIndex=77/);
});

// ---------------------------------------------------------------------------
// 13. check #18: require_rekor=false + dry-run sigstore → pass with upgrade hint
// ---------------------------------------------------------------------------
test('13. check #18 passes with upgrade hint on default dry-run sigstore', async (t) => {
  isolateEnv(t);
  const { outPath } = await buildOne('default-dryrun');
  // No env, default policy.require_rekor=false, default dry-run sigstore
  const report = await buildBinder(outPath);
  const c18 = report.checks.find(c => c.name === 'Transparency policy (Rekor)');
  assert.equal(c18.status, 'pass');
  assert.match(c18.detail, /does not require Rekor/);
  assert.match(c18.detail, /dry-run/);
  assert.match(c18.detail, /upgrade the gate/);
});

// ---------------------------------------------------------------------------
// 14. Strip-order safety — HMAC + Ed25519 still verify after Rekor pinning
// ---------------------------------------------------------------------------
test('14. HMAC + Ed25519 still verify after Rekor pinning mutates signature_sigstore', async (t) => {
  isolateEnv(t);
  const { outPath } = await buildOne('strip-order');
  // Capture pre-pin Ed25519 + HMAC bytes
  const pre = await loadArtifact(outPath);
  const preEd25519Sig = pre.receipt.signature_ed25519?.signature;
  const preHmacSig = pre.receipt.signature;
  assert.ok(preEd25519Sig, 'sanity: Ed25519 signature present pre-pin');
  assert.ok(preHmacSig, 'sanity: HMAC signature present pre-pin');
  // Pin via attestArtifactWithRekor
  const fake = fabricateRekorEntry({ logIndex: 222, integratedTime: 1763600000, logID: 'strip-order-logid' });
  const restore = withFakeFetch(async () => fakeRekorPostResponse(fake));
  t.after(restore);
  await attestArtifactWithRekor(outPath, { url: 'https://fake-rekor.example' });
  // Re-load and run full verifier
  const post = await loadArtifact(outPath);
  // The signatures bytes are unchanged (only signature_sigstore was mutated)
  assert.equal(post.receipt.signature_ed25519.signature, preEd25519Sig,
    'Ed25519 signature bytes must be unchanged by Rekor pin');
  assert.equal(post.receipt.signature, preHmacSig,
    'HMAC signature bytes must be unchanged by Rekor pin');
  // Run binder and confirm Ed25519 + HMAC both pass
  const report = await buildBinder(outPath);
  const ed25519Check = report.checks.find(c => c.name === 'Receipt signature (Ed25519, public-key)');
  assert.equal(ed25519Check.status, 'pass',
    `Ed25519 must still verify after Rekor pin (got ${ed25519Check.status}: ${ed25519Check.detail})`);
  // HMAC check name may vary; look for either Audit chain or Receipt signature (HMAC)
  const hmacCheck = report.checks.find(c =>
    c.name === 'Audit chain (HMAC receipt)'
    || c.name === 'Receipt signature (HMAC)'
    || /HMAC/i.test(c.name)
  );
  assert.ok(hmacCheck, `HMAC check must be present (names: ${report.checks.map(c=>c.name).join(', ')})`);
  assert.equal(hmacCheck.status, 'pass',
    `HMAC must still verify after Rekor pin (got ${hmacCheck.status}: ${hmacCheck.detail})`);
  // And the sigstore bundle itself still verifies (we only added rekor_log_entry)
  const post2 = await loadArtifact(outPath);
  const { signature_sigstore, ...payloadWithoutSigstore } = post2.receipt;
  void signature_sigstore;
  const canonical = canonicalJson(payloadWithoutSigstore);
  const v = verifySigstoreBundle(post2.receipt.signature_sigstore, canonical);
  assert.equal(v.ok, true, `sigstore self-verify must still pass: ${v.reason || ''}`);
  assert.equal(v.dry_run, false);
});
