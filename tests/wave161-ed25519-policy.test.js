// Wave 161 (Q+8) — Ed25519 authoritative signer + policy gate tests.
//
// Wave 149 made Ed25519 the DEFAULT signature. Wave 161 makes it a CONTRACT:
// every artifact carries `manifest.policy.require_ed25519` (true by default;
// only false when the build explicitly opts out via KOLM_ED25519_DISABLE=1 or
// KOLM_POLICY_OPT_OUT=1). The new binder check #17 ("Signature policy
// (Ed25519)") fails any artifact whose declared policy demands Ed25519 but
// whose receipt only carries an HMAC. The verifier can also override via
// env KOLM_REQUIRE_ED25519=1, which is the procurement-side gate.
//
// Coverage (14 tests):
//   1.  Default build: manifest.policy.require_ed25519 === true
//   2.  KOLM_ED25519_DISABLE=1 build: manifest.policy.require_ed25519 === false
//   3.  KOLM_POLICY_OPT_OUT=1 build: manifest.policy.require_ed25519 === false
//   4.  Default build: check #17 pass with "policy requires Ed25519" detail
//   5.  Default build: check #17 detail mentions HMAC retained as legacy
//   6.  HMAC-only build + verifier KOLM_REQUIRE_ED25519=1: check #17 FAIL
//   7.  HMAC-only build + verifier KOLM_REQUIRE_ED25519=1: fail detail names
//       env source ("env KOLM_REQUIRE_ED25519=1")
//   8.  HMAC-only build + no env: check #17 pass (informational)
//   9.  HMAC-only build + no env: detail names the upgrade path
//  10.  Manifest-policy fail detail names the artifact source
//       ("manifest.policy.require_ed25519=true")
//  11.  Default build + no env: check #17 pass detail acknowledges policy met
//  12.  Pre-W161 artifact (no policy field) + no env: check #17 pass
//  13.  Pre-W161 artifact + env KOLM_REQUIRE_ED25519=1 + Ed25519 present:
//       check #17 pass (verifier opt-in honored, artifact still has Ed25519)
//  14.  Check #17 is always emitted (every artifact gets a row) — sanity check
//       that #17 never silently skips (Wave 153 pass/warn/fail-no-skip rule).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import archiver from 'archiver';

import { buildAndZip } from '../src/artifact.js';
import { buildBinder } from '../src/binder.js';

const SECRET = 'wave161-test-secret-' + crypto.randomBytes(8).toString('hex');
process.env.RECIPE_RECEIPT_SECRET = SECRET;

function freshKeyStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w161-keys-'));
}

// Snapshot + clear every env flag the policy + signature paths read so each
// test starts from a known baseline; restore on teardown.
function isolateEnv(t) {
  const dir = freshKeyStore();
  const prev = {
    keyStore: process.env.KOLM_ED25519_KEY_STORE,
    privKey: process.env.KOLM_ED25519_PRIVATE_KEY,
    privPath: process.env.KOLM_ED25519_PRIVATE_KEY_PATH,
    disable: process.env.KOLM_ED25519_DISABLE,
    policyOptOut: process.env.KOLM_POLICY_OPT_OUT,
    sigstore: process.env.KOLM_SIGSTORE_DISABLE,
    requireEd: process.env.KOLM_REQUIRE_ED25519,
  };
  process.env.KOLM_ED25519_KEY_STORE = dir;
  delete process.env.KOLM_ED25519_PRIVATE_KEY;
  delete process.env.KOLM_ED25519_PRIVATE_KEY_PATH;
  delete process.env.KOLM_ED25519_DISABLE;
  delete process.env.KOLM_POLICY_OPT_OUT;
  delete process.env.KOLM_REQUIRE_ED25519;
  // Wave 161 contract tests assume sigstore is OFF so receipt.signature_alg
  // stays at 'ed25519+hmac-sha256' (not 'sigstore+ed25519+hmac-sha256').
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  t.after(() => {
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('KOLM_ED25519_KEY_STORE', prev.keyStore);
    restore('KOLM_ED25519_PRIVATE_KEY', prev.privKey);
    restore('KOLM_ED25519_PRIVATE_KEY_PATH', prev.privPath);
    restore('KOLM_ED25519_DISABLE', prev.disable);
    restore('KOLM_POLICY_OPT_OUT', prev.policyOptOut);
    restore('KOLM_SIGSTORE_DISABLE', prev.sigstore);
    restore('KOLM_REQUIRE_ED25519', prev.requireEd);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  });
  return dir;
}

async function buildOne(jobIdSuffix) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w161-artifact-'));
  const result = await buildAndZip({
    job_id: `wave161-${jobIdSuffix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    task: 'wave161-test',
    base_model: 'none',
    recipes: [{ id: 'r1', source: 'export default function r1(x){return String(x).toUpperCase()}', positives: [{ input: 'hi', expected: 'HI' }] }],
    evals: { cases: [{ input: 'hi', expected: 'HI' }] },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 10, cost_usd_per_call: 0 },
    outDir,
    tier: 'recipe',
  });
  return { ...result, outDir };
}

// Canonical JSON used by artifact.js for signature payloads. Mirrors the
// helper in tests/wave144-verifier-states.test.js so a tamper test can
// recompute the HMAC signature after rewriting the manifest.
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

// Re-sign signature.sig after manifest.json has been edited inside the rewrite
// mutator. Without this, loadArtifact throws KOLM_E_SIGNATURE_INVALID with
// "manifest_hash mismatch" before any binder check fires. Pattern lifted from
// tests/wave144-verifier-states.test.js resignManifest().
function resignManifest(api) {
  const secret = process.env.RECIPE_RECEIPT_SECRET;
  const manifestText = api.readAsText('manifest.json');
  const newManifestHash = crypto.createHash('sha256').update(Buffer.from(manifestText)).digest('hex');
  const sig = JSON.parse(api.readAsText('signature.sig'));
  sig.manifest_hash = newManifestHash;
  const payload = canonicalJson({
    spec: sig.spec,
    manifest_hash: newManifestHash,
    job_id: sig.job_id,
    artifact_hash: sig.artifact_hash,
    eval_set_hash: sig.eval_set_hash,
    eval_score: sig.eval_score,
    judge_id: sig.judge_id,
  });
  sig.hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  api.updateFile('signature.sig', JSON.stringify(sig, null, 2));
}

// Re-write a built .kolm zip via archiver (NOT AdmZip.writeZip — the latter
// strips the CRC data descriptors that artifact-runner.js relies on and the
// re-loaded zip throws "ADM-ZIP: No descriptor present"). Reads entries via
// AdmZip, applies the mutator, then re-emits via archiver. Pattern lifted
// verbatim from tests/wave144-verifier-states.test.js rewriteZip().
async function rewriteZip(srcPath, dstPath, mutator) {
  const zip = new AdmZip(srcPath);
  const entries = new Map();
  for (const e of zip.getEntries()) {
    entries.set(e.entryName, e.getData());
  }
  const api = {
    readAsText: (name) => entries.has(name) ? entries.get(name).toString('utf8') : null,
    updateFile: (name, buf) => entries.set(name, Buffer.isBuffer(buf) ? buf : Buffer.from(buf)),
    deleteFile: (name) => entries.delete(name),
  };
  await mutator(api);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dstPath);
    const z = archiver('zip', { zlib: { level: 9 } });
    z.on('warning', (e) => { if (e.code !== 'ENOENT') reject(e); });
    z.on('error', reject);
    out.on('close', resolve);
    z.pipe(out);
    for (const [name, buf] of entries) {
      z.append(buf, { name });
    }
    z.finalize();
  });
}

// Strip manifest.policy. Models a pre-W161 artifact (built before the policy
// field existed). Re-signs the HMAC so loadArtifact still accepts it. The
// Ed25519 block stays as the original signs (post-W149 receipts include
// signature_ed25519 that signs the receipt body); check #5 may re-verify or
// downgrade, but check #17 only reads manifest.policy + signature_ed25519
// presence, so the stale Ed25519 block on a stripped-policy manifest does not
// affect the assertions we care about.
async function stripPolicyFromArtifact(zipPath) {
  const stripped = zipPath.replace(/\.kolm$/, '.stripped.kolm');
  await rewriteZip(zipPath, stripped, (api) => {
    const m = JSON.parse(api.readAsText('manifest.json'));
    delete m.policy;
    api.updateFile('manifest.json', JSON.stringify(m, null, 2));
    resignManifest(api);
  });
  return stripped;
}

// -----------------------------------------------------------------------------
// 1. Default build → policy.require_ed25519 === true
// -----------------------------------------------------------------------------
test('1. default build sets manifest.policy.require_ed25519 = true', async (t) => {
  isolateEnv(t);
  const result = await buildOne('default-policy-true');
  assert.ok(result.manifest.policy, 'manifest.policy exists');
  assert.equal(result.manifest.policy.require_ed25519, true);
});

// -----------------------------------------------------------------------------
// 2. KOLM_ED25519_DISABLE=1 → policy.require_ed25519 === false
// -----------------------------------------------------------------------------
test('2. KOLM_ED25519_DISABLE=1 build sets policy.require_ed25519 = false', async (t) => {
  isolateEnv(t);
  process.env.KOLM_ED25519_DISABLE = '1';
  const result = await buildOne('disable-flag');
  assert.equal(result.manifest.policy.require_ed25519, false);
});

// -----------------------------------------------------------------------------
// 3. KOLM_POLICY_OPT_OUT=1 → policy.require_ed25519 === false
// -----------------------------------------------------------------------------
test('3. KOLM_POLICY_OPT_OUT=1 build sets policy.require_ed25519 = false', async (t) => {
  isolateEnv(t);
  process.env.KOLM_POLICY_OPT_OUT = '1';
  const result = await buildOne('policy-optout');
  assert.equal(result.manifest.policy.require_ed25519, false);
});

// -----------------------------------------------------------------------------
// 4. Default build → check #17 PASS with "policy requires Ed25519" detail
// -----------------------------------------------------------------------------
test('4. default build: binder check #17 passes with policy-required detail', async (t) => {
  isolateEnv(t);
  const result = await buildOne('check17-pass-default');
  const report = await buildBinder(result.outPath);
  const c17 = report.checks.find(c => c.name === 'Signature policy (Ed25519)');
  assert.ok(c17, 'check #17 present in binder report');
  assert.equal(c17.status, 'pass', `check #17 should pass: ${c17.detail}`);
  assert.match(c17.detail, /policy requires Ed25519/i);
});

// -----------------------------------------------------------------------------
// 5. Default build: detail mentions HMAC kept as a legacy integrity check
// -----------------------------------------------------------------------------
test('5. default build: check #17 detail acknowledges HMAC as legacy integrity', async (t) => {
  isolateEnv(t);
  const result = await buildOne('check17-hmac-legacy-label');
  const report = await buildBinder(result.outPath);
  const c17 = report.checks.find(c => c.name === 'Signature policy (Ed25519)');
  assert.match(c17.detail, /HMAC retained as a legacy integrity check/i);
});

// -----------------------------------------------------------------------------
// 6. HMAC-only build + verifier env KOLM_REQUIRE_ED25519=1 → check #17 FAIL
// -----------------------------------------------------------------------------
test('6. HMAC-only build with verifier KOLM_REQUIRE_ED25519=1 fails check #17', async (t) => {
  isolateEnv(t);
  process.env.KOLM_ED25519_DISABLE = '1';
  const result = await buildOne('hmac-only-verifier-env');
  // Sanity: receipt is HMAC-only.
  assert.equal(result.receipt.signature_alg, 'hmac-sha256');
  assert.equal(result.receipt.signature_ed25519, undefined);
  // Now flip the verifier env and re-run the binder.
  process.env.KOLM_REQUIRE_ED25519 = '1';
  const report = await buildBinder(result.outPath);
  const c17 = report.checks.find(c => c.name === 'Signature policy (Ed25519)');
  assert.equal(c17.status, 'fail', `check #17 should fail: ${c17.detail}`);
  assert.match(c17.detail, /HMAC is a symmetric MAC/i);
});

// -----------------------------------------------------------------------------
// 7. Fail detail names the env-source ("env KOLM_REQUIRE_ED25519=1")
// -----------------------------------------------------------------------------
test('7. verifier-env fail detail names the env source', async (t) => {
  isolateEnv(t);
  process.env.KOLM_ED25519_DISABLE = '1';
  const result = await buildOne('check17-env-source');
  process.env.KOLM_REQUIRE_ED25519 = '1';
  const report = await buildBinder(result.outPath);
  const c17 = report.checks.find(c => c.name === 'Signature policy (Ed25519)');
  assert.equal(c17.status, 'fail');
  assert.match(c17.detail, /env KOLM_REQUIRE_ED25519=1/);
});

// -----------------------------------------------------------------------------
// 8. HMAC-only build + no env → check #17 PASS (informational)
// -----------------------------------------------------------------------------
test('8. HMAC-only build with no verifier env passes check #17 informationally', async (t) => {
  isolateEnv(t);
  process.env.KOLM_ED25519_DISABLE = '1';
  const result = await buildOne('hmac-only-no-env');
  const report = await buildBinder(result.outPath);
  const c17 = report.checks.find(c => c.name === 'Signature policy (Ed25519)');
  assert.equal(c17.status, 'pass', `check #17 should pass: ${c17.detail}`);
  assert.match(c17.detail, /policy does not require Ed25519/i);
});

// -----------------------------------------------------------------------------
// 9. HMAC-only build + no env: detail names the upgrade path
// -----------------------------------------------------------------------------
test('9. check #17 informational detail names the upgrade path', async (t) => {
  isolateEnv(t);
  process.env.KOLM_ED25519_DISABLE = '1';
  const result = await buildOne('check17-upgrade-hint');
  const report = await buildBinder(result.outPath);
  const c17 = report.checks.find(c => c.name === 'Signature policy (Ed25519)');
  // The pass detail should mention either upgrade lever.
  assert.match(
    c17.detail,
    /manifest\.policy\.require_ed25519=true|KOLM_REQUIRE_ED25519=1/,
    `upgrade hint missing from: ${c17.detail}`,
  );
});

// -----------------------------------------------------------------------------
// 10. Manifest-policy fail detail names the artifact source
//     ("manifest.policy.require_ed25519=true")
// -----------------------------------------------------------------------------
test('10. manifest-policy fail detail names the manifest source', async (t) => {
  isolateEnv(t);
  // Build HMAC-only so signature_ed25519 is absent.
  process.env.KOLM_ED25519_DISABLE = '1';
  const result = await buildOne('manifest-policy-source');
  // Now post-edit the manifest to force policy.require_ed25519=true even
  // though signature_ed25519 is missing — models the "downstream tenant
  // hand-edits the policy stance to upgrade an older artifact" attack
  // surface. Check #17 must FAIL and the detail must name the artifact
  // source, not the env source.
  const hacked = result.outPath.replace(/\.kolm$/, '.hacked.kolm');
  await rewriteZip(result.outPath, hacked, (api) => {
    const m = JSON.parse(api.readAsText('manifest.json'));
    m.policy = { require_ed25519: true };
    api.updateFile('manifest.json', JSON.stringify(m, null, 2));
    resignManifest(api);
  });
  const report = await buildBinder(hacked);
  const c17 = report.checks.find(c => c.name === 'Signature policy (Ed25519)');
  assert.equal(c17.status, 'fail', `check #17 should fail: ${c17.detail}`);
  assert.match(c17.detail, /manifest\.policy\.require_ed25519=true/);
  // And critically NOT the env source, since KOLM_REQUIRE_ED25519 is unset.
  assert.doesNotMatch(c17.detail, /env KOLM_REQUIRE_ED25519=1/);
});

// -----------------------------------------------------------------------------
// 11. Default build + no env: pass detail acknowledges policy met
// -----------------------------------------------------------------------------
test('11. default build pass detail confirms policy met by signature', async (t) => {
  isolateEnv(t);
  const result = await buildOne('check17-policy-met');
  const report = await buildBinder(result.outPath);
  const c17 = report.checks.find(c => c.name === 'Signature policy (Ed25519)');
  assert.equal(c17.status, 'pass');
  // The pass detail should describe that the Ed25519 block verified.
  assert.match(c17.detail, /verified against its embedded public key/i);
});

// -----------------------------------------------------------------------------
// 12. Pre-W161 artifact (no policy field) + no verifier env → check #17 PASS
// -----------------------------------------------------------------------------
test('12. pre-W161 artifact (no manifest.policy) passes check #17 without env', async (t) => {
  isolateEnv(t);
  const result = await buildOne('preW161');
  const stripped = await stripPolicyFromArtifact(result.outPath);
  const report = await buildBinder(stripped);
  const c17 = report.checks.find(c => c.name === 'Signature policy (Ed25519)');
  assert.ok(c17, 'check #17 still emitted for legacy artifacts (Wave 153 rule: no skip)');
  assert.equal(c17.status, 'pass', `pre-W161 artifact should pass when no env: ${c17.detail}`);
});

// -----------------------------------------------------------------------------
// 13. Pre-W161 artifact + env KOLM_REQUIRE_ED25519=1 + Ed25519 present → PASS
// -----------------------------------------------------------------------------
test('13. pre-W161 artifact + env opt-in passes when Ed25519 still present', async (t) => {
  isolateEnv(t);
  const result = await buildOne('preW161-with-ed25519');
  // Artifact still has signature_ed25519 (Wave 149 default). Stripping the
  // policy field models an artifact built before Wave 161 — but Wave 149+
  // builds always include Ed25519 anyway.
  const stripped = await stripPolicyFromArtifact(result.outPath);
  process.env.KOLM_REQUIRE_ED25519 = '1';
  const report = await buildBinder(stripped);
  const c17 = report.checks.find(c => c.name === 'Signature policy (Ed25519)');
  assert.equal(c17.status, 'pass', `env opt-in with Ed25519 present should pass: ${c17.detail}`);
  // The pass detail should reflect "policy requires Ed25519" (env path).
  assert.match(c17.detail, /policy requires Ed25519/i);
});

// -----------------------------------------------------------------------------
// 14. Check #17 always emits a row (no silent skip), per Wave 153 convention
// -----------------------------------------------------------------------------
test('14. check #17 always emits a row for every artifact state', async (t) => {
  isolateEnv(t);
  // Build three artifacts in three different policy states; every binder
  // report must contain a check #17 entry.
  const a = await buildOne('always-emit-A');
  const reportA = await buildBinder(a.outPath);
  assert.ok(reportA.checks.find(c => c.name === 'Signature policy (Ed25519)'), 'default state emits #17');

  process.env.KOLM_ED25519_DISABLE = '1';
  const b = await buildOne('always-emit-B');
  delete process.env.KOLM_ED25519_DISABLE;
  const reportB = await buildBinder(b.outPath);
  assert.ok(reportB.checks.find(c => c.name === 'Signature policy (Ed25519)'), 'HMAC-only state emits #17');

  const c = await buildOne('always-emit-C');
  const stripped = await stripPolicyFromArtifact(c.outPath);
  const reportC = await buildBinder(stripped);
  assert.ok(reportC.checks.find(c => c.name === 'Signature policy (Ed25519)'), 'pre-W161 state emits #17');
});
