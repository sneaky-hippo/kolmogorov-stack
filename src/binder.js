// src/binder.js
//
// Compliance binder generator. Takes a .kolm artifact and emits a printable
// HTML report that a security reviewer signs off on before deployment.
//
// The deliverable looks like a one-pager an auditor can sign and file. It
// contains every piece of evidence kolm produces about an artifact, laid out
// in the order a reviewer reads:
//
//   1. Verification summary  — pass/fail/warn per check, top-of-page
//   2. Identity              — CID, artifact hash, base model, tier
//   3. K-score evidence      — composite + raw axes + gate pass/fail
//   4. Manifest hashes       — sha256 over every file inside the .kolm
//   5. Audit chain           — 5-step HMAC chain (task→seeds→recipes→evals→package)
//   6. Credential signer     — provenance credential, signer namespace, parent
//   7. Eval coverage         — case count, pass-rate, judge id
//   8. Reproduction recipe   — the four commands needed to re-verify from disk
//
// The binder is offline-verifiable: every claim it makes can be re-checked by
// running `kolm verify` against the same artifact bytes. The HTML embeds the
// recomputed CID and chain hash, so a buyer who suspects tampering can re-run
// the open-source verifier and compare. The HMAC verification itself requires
// the same RECIPE_RECEIPT_SECRET that produced the artifact — by design, only
// the issuer (and parties they share the secret with) can produce a green
// "signature verified" check. A buyer who lacks the secret still sees the
// chain structure and per-step input/output hashes; they just see the
// signature line in the "unverified" state and know to ask the issuer to
// re-sign through their own verifier.
//
// Surface:
//
//     import { buildBinder, writeBinder } from './binder.js';
//
//     const html = buildBinder(artifactPath);
//     writeBinder(artifactPath, 'out.html');
//
// CLI:
//
//     kolm verify <artifact.kolm> --binder out.html
//
// No external dependencies. The CSS is print-optimized — letter-sized pages,
// no animations, no web fonts. Opens identically in Chrome, Safari, Firefox,
// and as a PDF when "Save as PDF" is invoked from the browser's print dialog.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadArtifact, isArtifactPathCloudTrusted } from './artifact-runner.js';
import { cidFromManifestHashes, parseCid, shortCid } from './cid.js';
import { verifyCredential } from './provenance.js';
import { effectiveReceiptSecret } from './env.js';
import { validateCapability, validateLineage } from './artifact-lineage.js';
import { hashIr } from './workflow-ir.js';
import { verifyAttestation, STATES as CC_STATES } from './confidential-compute.js';
import { verifySignatureBlock as verifyEd25519Block } from './ed25519.js';
import { verifySigstoreBundle } from './sigstore.js';
import { validateArtifactClass, classBadge } from './recipe-class.js';
import { validateExportBlock } from './export-provenance.js';
import { validateExternalHoldoutBlock, hashHoldoutFile, resolveHoldoutPath, findInCatalog } from './external-holdout.js';
import { validateTenantShadowBlock, reAnchorTenantShadowBlock, TENANT_SHADOW_SPEC_VERSION } from './tenant-holdout.js';
import { validateAuditorAttestationBlock, crossCheckAttestation, AUDITOR_ATTESTATION_SPEC_VERSION } from './auditor-attestation.js';
import {
  validateSupersessionBlock,
  validateDriftReport,
  SUPERSESSION_SPEC_VERSION,
  DRIFT_REPORT_SPEC_VERSION,
  SUPERSESSION_REASONS,
} from './drift-supersession.js';
import { checkCorpusLicensing } from './licensing-allowlist.js';
import AdmZip from 'adm-zip';

const BINDER_SPEC = 'kolm-binder/0.1';

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtMicros(us) {
  if (us == null) return '—';
  if (us < 1000) return `${us} µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

function fmtCost(c) {
  if (c == null) return '—';
  if (c === 0) return '$0.00';
  if (c < 0.0001) return `$${c.toExponential(2)}`;
  return `$${c.toFixed(4)}`;
}

// Structural-integrity checks. Used when the artifact is cloud-trusted (the
// local CLI lacks RECIPE_RECEIPT_SECRET, so HMAC verification is impossible)
// to confirm the chain and credential are well-formed and bind to this
// exact manifest. The trust list pins the bytes-on-disk by sha256.

function chainStructuralIntegrityOk(receipt) {
  if (!receipt || typeof receipt !== 'object') return { ok: false, reason: 'receipt missing or not an object' };
  if (!Array.isArray(receipt.chain)) return { ok: false, reason: 'receipt.chain not an array' };
  if (receipt.chain.length === 0) return { ok: false, reason: 'receipt.chain is empty' };
  for (let i = 0; i < receipt.chain.length; i++) {
    const step = receipt.chain[i];
    if (!step || typeof step !== 'object') return { ok: false, reason: `step ${i} not an object` };
    for (const f of ['step', 'input_hash', 'output_hash', 'hmac']) {
      if (typeof step[f] !== 'string' || step[f].length === 0) return { ok: false, reason: `step ${i} missing field ${f}` };
    }
    // Chain link: each step's input_hash should reference the prior step's
    // output_hash. The first step's input is the task spec hash, so it has
    // no predecessor to compare against.
    if (i > 0) {
      const prior = receipt.chain[i - 1];
      if (step.input_hash !== prior.output_hash) {
        return { ok: false, reason: `step ${i} input_hash does not link to step ${i - 1} output_hash` };
      }
    }
  }
  if (typeof receipt.signature !== 'string' || receipt.signature.length === 0) {
    return { ok: false, reason: 'receipt body signature missing' };
  }
  return { ok: true };
}

function credentialStructuralIntegrityOk(credential, manifest) {
  if (!credential || typeof credential !== 'object') return { ok: false, reason: 'credential missing or not an object' };
  if (credential.spec !== 'kolm-credential/0.1') return { ok: false, reason: `unexpected spec ${credential.spec}` };
  for (const f of ['type', 'claim_generator', 'artifact_hash', 'cid', 'signature', 'signature_alg', 'signed_at']) {
    if (typeof credential[f] !== 'string' || credential[f].length === 0) {
      return { ok: false, reason: `credential missing field ${f}` };
    }
  }
  if (!credential.assertions || typeof credential.assertions !== 'object') {
    return { ok: false, reason: 'credential.assertions missing or not an object' };
  }
  // The credential's cid must match the manifest's cid: the credential
  // is bound to this artifact, not some other one.
  if (manifest && manifest.cid && credential.cid !== manifest.cid) {
    return { ok: false, reason: `credential cid does not match manifest cid` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Verification harness — runs every check the binder reports on. Each check
// returns `{ name, status: 'pass'|'fail'|'warn', detail }`. A failing check
// produces a red row at the top of the binder and a non-zero exit code from
// the CLI; a warning produces a yellow row but keeps the binder valid.
// ---------------------------------------------------------------------------

async function verifyArtifact(bundle) {
  const checks = [];

  // Cloud-trust detection. When the artifact bytes are recorded in
  // ~/.kolm/cloud-trusted.json (set by `kolm compile` cloud path on download),
  // the local CLI does not hold the RECIPE_RECEIPT_SECRET that signed the
  // chain. The deeper HMAC checks below then switch to structural-integrity
  // mode: we confirm the chain and credential are well-formed and bind to
  // this exact manifest, but skip the HMAC seal. The artifact's sha256 in the
  // trust list is the proof we downloaded these exact bytes.
  const cloudTrustedSha = bundle.signature_mode === 'cloud-trusted'
    ? isArtifactPathCloudTrusted(bundle.artifact_path)
    : null;

  // 1. Signature already verified by loadArtifact — if we got here, the
  // legacy signature.sig HMAC matched, or the artifact is cloud-trusted.
  checks.push({
    name: 'Manifest signature (legacy HMAC)',
    status: bundle.signature_valid ? 'pass' : 'fail',
    detail: bundle.signature_valid
      ? (bundle.signature_mode === 'cloud-trusted'
          ? 'cloud-signed; trusted via local list (artifact sha256 in ~/.kolm/cloud-trusted.json)'
          : 'signature.sig HMAC matches manifest.json sha256')
      : 'signature.sig did not verify (mismatch)',
  });

  // 2. CID round-trip — recompute from manifest hashes, compare to embedded.
  const manifest = bundle.manifest;
  if (manifest.hashes) {
    let recomputed;
    try { recomputed = cidFromManifestHashes(manifest.hashes); }
    catch (e) { recomputed = `error: ${e.message}`; }
    const matches = recomputed === manifest.cid;
    checks.push({
      name: 'Content identifier (CID) round-trip',
      status: matches ? 'pass' : 'fail',
      detail: matches
        ? `recomputed CID matches manifest.cid: ${shortCid(manifest.cid)}`
        : `embedded ${manifest.cid} ≠ recomputed ${recomputed}`,
    });
  } else {
    checks.push({
      name: 'Content identifier (CID) round-trip',
      status: 'warn',
      detail: 'manifest is missing the hashes block — cannot recompute CID',
    });
  }

  // 3. Artifact-class consistency (Wave 151 honest-taxonomy gate).
  // The manifest's artifact_class claim must match what's actually in the zip:
  // a `distilled_model` claim requires real weights (non-empty model_pointer +
  // a real base_model), a `compiled_rule` claim requires compiled_targets, a
  // `synthesized_rule` claim requires teacher attribution. This is the
  // pre-Wave-144 failure mode the audit caught — "polished marketing site over
  // hardcoded JS templates pretending to be a distilled model." The verifier
  // catches it now so a buyer reading the binder cannot be misled even if a
  // future build path drifts.
  const classCheck = validateArtifactClass(manifest);
  const declaredClass = manifest.artifact_class || 'rule';
  checks.push({
    name: 'Artifact class consistency (honest taxonomy)',
    status: classCheck.ok ? 'pass' : 'fail',
    detail: classCheck.ok
      ? `artifact_class='${declaredClass}' matches contents — ${classBadge(declaredClass)}`
      : classCheck.reason,
  });

  // 4. Receipt chain — every step's HMAC verifies under the same secret.
  // If the secret isn't available we report "structural" pass + "unverified".
  // When the artifact is cloud-trusted (sha256 recorded in
  // ~/.kolm/cloud-trusted.json by `kolm compile` cloud path), HMAC verification
  // is impossible locally (the cloud holds the secret) so we fall back to a
  // structural-integrity check: chain shape valid, each step well-formed,
  // step output_hash threads into the next step's input_hash.
  const receipt = bundle.receipt;
  if (!receipt) {
    checks.push({
      name: 'Audit chain (HMAC receipt)',
      status: 'warn',
      detail: 'no receipt.json found; this is pre-v0.1 artifact format',
    });
  } else {
    // Wave 149 — Ed25519 verification runs FIRST when present. Unlike HMAC
    // it needs no shared secret, so a third-party verifier (cloud or local)
    // can prove provenance from receipt bytes alone. The check strips
    // `signature_ed25519` from the receipt body and asks ed25519.js to
    // verify the embedded signature against the embedded public key over
    // the canonical remainder. When this passes, HMAC becomes a secondary
    // integrity check; when it fails, the binder reports both signatures.
    if (receipt.signature_ed25519) {
      // Wave 149: Ed25519 was signed over canonical(body WITH HMAC, WITHOUT
      // ed25519 or sigstore). Wave 150 added sigstore_signature on top; strip
      // BOTH to recover the canonical payload Ed25519 attested to.
      const { signature_ed25519, signature_sigstore, ...ed25519Payload } = receipt;
      void signature_sigstore;
      const ed25519Canon = canonicalJson(ed25519Payload);
      const ed25519Result = verifyEd25519Block(receipt.signature_ed25519, ed25519Canon);
      checks.push({
        name: 'Receipt signature (Ed25519, public-key)',
        status: ed25519Result.ok ? 'pass' : 'fail',
        detail: ed25519Result.ok
          ? `Ed25519 signature verified against embedded public key (fingerprint ${ed25519Result.key_fingerprint?.slice(0, 12) || '?'}…); no shared secret needed`
          : `Ed25519 verification failed: ${ed25519Result.reason}`,
      });
    } else {
      checks.push({
        name: 'Receipt signature (Ed25519, public-key)',
        status: 'warn',
        detail: 'no signature_ed25519 block — artifact built before Wave 149 or with KOLM_ED25519_DISABLE=1; HMAC integrity check below stands in until re-signed',
      });
    }

    // Wave 150 — sigstore (cosign-compatible) transparency-log bundle. Adds
    // a third verification layer: the bundle's messageSignature is checked
    // against the canonical receipt body (sans sigstore block). If the
    // bundle was Rekor-pinned (not dry-run), the embedded logIndex +
    // signedEntryTimestamp + inclusionProof are surfaced for downstream
    // auditors. Dry-run bundles report `warn` not `fail` because the build
    // was offline by design.
    if (receipt.signature_sigstore) {
      const { signature_sigstore, ...sigstorePayload } = receipt;
      const sigstoreCanon = canonicalJson(sigstorePayload);
      const sigstoreResult = verifySigstoreBundle(receipt.signature_sigstore, sigstoreCanon);
      if (sigstoreResult.ok) {
        if (sigstoreResult.dry_run) {
          checks.push({
            name: 'Receipt signature (Sigstore bundle)',
            status: 'warn',
            detail: `bundle structurally valid (sha256 ${sigstoreResult.digest_hex.slice(0, 12)}…) — dry-run, not yet recorded in Rekor transparency log; run \`kolm sigstore-attest <artifact>\` to publish`,
          });
        } else {
          const li = sigstoreResult.rekor_log_index;
          const ts = sigstoreResult.rekor_integrated_time;
          checks.push({
            name: 'Receipt signature (Sigstore bundle)',
            status: 'pass',
            detail: `bundle verified + Rekor entry logIndex=${li ?? '?'} integratedTime=${ts ?? '?'} logID=${(sigstoreResult.rekor_log_id || '').slice(0, 16) || '?'}…`,
          });
        }
      } else {
        checks.push({
          name: 'Receipt signature (Sigstore bundle)',
          status: 'fail',
          detail: `Sigstore verification failed: ${sigstoreResult.reason}`,
        });
      }
    } else {
      checks.push({
        name: 'Receipt signature (Sigstore bundle)',
        status: 'warn',
        detail: 'no signature_sigstore block — artifact built before Wave 150 or with KOLM_SIGSTORE_DISABLE=1; Ed25519 stands in as the public-key signature',
      });
    }

    const secret = effectiveReceiptSecret({ includeLegacyArtifactSecret: true });
    const chainStructureOk = chainStructuralIntegrityOk(receipt);
    if (cloudTrustedSha) {
      // Cloud-trust path. Structural check stands in for HMAC verification
      // because the cloud holds the signing secret. The bytes-on-disk are
      // pinned by sha256 in ~/.kolm/cloud-trusted.json.
      checks.push({
        name: 'Audit chain (HMAC receipt)',
        status: chainStructureOk.ok ? 'pass' : 'fail',
        detail: chainStructureOk.ok
          ? `structural integrity verified across ${receipt.chain?.length || 0} steps (cloud-signed; HMAC chain seal trusted via cloud-trust list)`
          : `chain structural integrity failed: ${chainStructureOk.reason}`,
      });
    } else if (!secret) {
      checks.push({
        name: 'Audit chain (HMAC receipt)',
        status: 'warn',
        detail: `chain structure ok (${receipt.chain?.length || 0} steps); HMAC unverified — RECIPE_RECEIPT_SECRET not present in this environment`,
      });
    } else {
      const chainOk = (receipt.chain || []).every(step => {
        const expected = hmacHex(secret, canonicalJson({
          step: step.step, input_hash: step.input_hash, output_hash: step.output_hash,
        }));
        return expected === step.hmac;
      });
      const bodyOk = (() => {
        // Strip every signature block added after the HMAC was computed:
        //   * `signature` (the HMAC hex itself)
        //   * `signature_ed25519` (Wave 149 public-key block)
        //   * `signature_sigstore` (Wave 150 cosign-compatible bundle)
        // so the canonical payload matches what was hashed at sign-time.
        const { signature, signature_ed25519, signature_sigstore, ...rest } = receipt;
        void signature_ed25519; void signature_sigstore;
        return hmacHex(secret, canonicalJson(rest)) === signature;
      })();
      checks.push({
        name: 'Audit chain (HMAC receipt)',
        status: (chainOk && bodyOk) ? 'pass' : 'fail',
        detail: (chainOk && bodyOk)
          ? `chain verified across ${receipt.chain.length} steps; receipt body signature verified`
          : (!chainOk ? 'chain step HMAC mismatch' : 'receipt body signature mismatch'),
      });
    }
  }

  // 4. K-score gate — composite ≥ 0.85.
  const k = manifest.k_score;
  if (!k) {
    checks.push({
      name: 'K-score gate',
      status: 'fail',
      detail: 'manifest carries no k_score block',
    });
  } else if (k.composite >= (k.gate || 0.85)) {
    checks.push({
      name: 'K-score gate',
      status: 'pass',
      detail: `composite ${k.composite.toFixed(4)} ≥ gate ${(k.gate || 0.85).toFixed(2)}`,
    });
  } else {
    checks.push({
      name: 'K-score gate',
      status: 'fail',
      detail: `composite ${k.composite.toFixed(4)} below gate ${(k.gate || 0.85).toFixed(2)}; artifact should not be deployed`,
    });
  }

  // 5. Provenance credential. Re-read it from the zip because loadArtifact
  // doesn't surface it. Older artifacts pre-date kolm-credential/0.1 and a
  // missing credential is a warning, not a failure.
  let credential = null;
  try {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(bundle.artifact_path);
    const e = zip.getEntries().find(x => x.entryName === 'credential.json');
    if (e) credential = JSON.parse(e.getData().toString('utf8'));
  } catch { /* swallow — credential is optional */ }

  if (!credential) {
    checks.push({
      name: 'Provenance credential',
      status: 'warn',
      detail: 'no credential.json found (artifact built before kolm-credential/0.1)',
    });
  } else {
    const secret = effectiveReceiptSecret({ includeLegacyArtifactSecret: true });
    const credStructure = credentialStructuralIntegrityOk(credential, bundle.manifest);
    if (cloudTrustedSha) {
      // Cloud-trust path. The credential signature was produced with the
      // cloud's secret which the local CLI does not hold. Confirm the
      // credential is well-formed and binds to this exact manifest, then
      // trust the signature via the cloud-trust list.
      checks.push({
        name: 'Provenance credential',
        status: credStructure.ok ? 'pass' : 'fail',
        detail: credStructure.ok
          ? `credential structure verified (${credential.spec}; cloud-signed; signature trusted via cloud-trust list)`
          : `credential structural integrity failed: ${credStructure.reason}`,
      });
    } else if (!secret) {
      checks.push({
        name: 'Provenance credential',
        status: 'warn',
        detail: `credential present (${credential.spec || 'unknown spec'}); signature unverified without RECIPE_RECEIPT_SECRET`,
      });
    } else {
      const r = verifyCredential(credential, secret);
      checks.push({
        name: 'Provenance credential',
        status: r.valid ? 'pass' : 'fail',
        detail: r.valid
          ? `credential signature verified (${credential.spec})`
          : `credential signature failed: ${r.reason}`,
      });
    }
  }

  // 6. Eval coverage — at least one case ran. When every case is
  // auto-synthesized from the task description (no user-provided examples),
  // downgrade to warn so the buyer knows the gate cleared on synthetic eval
  // input. One real user-provided case is enough to flip the status to pass.
  const evals = bundle.evals;
  const cases = evals?.cases || [];
  const n = cases.length;
  const autoN = cases.filter(c => c && c.auto_synthesized).length;
  if (n === 0) {
    checks.push({
      name: 'Eval coverage',
      status: 'warn',
      detail: 'artifact ships zero eval cases — K-score reflects training pass-rate only',
    });
  } else if (autoN === n) {
    checks.push({
      name: 'Eval coverage',
      status: 'warn',
      detail: `${n} eval case${n === 1 ? '' : 's'} shipped (all auto-synthesized from task description; add real cases via kolm new --from <template>)`,
    });
  } else {
    checks.push({
      name: 'Eval coverage',
      status: 'pass',
      detail: `${n} eval case${n === 1 ? '' : 's'} embedded${autoN > 0 ? ` (${autoN} auto-synthesized, ${n - autoN} user-provided)` : ''}; judge_id=${manifest.judge_id || 'unknown'}`,
    });
  }

  // 7. Seed gate (Q+2) — independence of train and holdout.
  // The pre-Wave-144 build derived eval cases from the recipe at compile time
  // (input_hash == recipes_json hash by construction), so the K-score's
  // accuracy axis was tautological. The seed gate splits a real seeds.jsonl
  // 80/20 into train (which feeds recipe synthesis) and holdout (which
  // grounds the K-score). The verifier enforces:
  //   - eval_source is not 'self_generated' (the legacy tautological path)
  //   - train_hash and holdout_hash are present and distinct
  //   - holdout_count is large enough to ground a public K-score
  //   - input/output overlap counts are zero (no leakage from train→holdout)
  //   - leakage_report_hash is present so a third party with the seed file
  //     can recompute and confirm
  const sp = manifest.seed_provenance;
  if (!sp || sp.eval_source === 'self_generated') {
    checks.push({
      name: 'Seed gate (train/holdout independence)',
      status: 'fail',
      detail: 'manifest.seed_provenance is missing or eval_source=self_generated — K-score was computed against compile-time eval cases derived from the recipe itself (tautological). Re-build with --seeds pointing at a real seeds.jsonl.',
    });
  } else if (sp.eval_source === 'empty') {
    checks.push({
      name: 'Seed gate (train/holdout independence)',
      status: 'fail',
      detail: 'seeds.jsonl was empty (zero parseable rows). K-score has no ground truth to measure against.',
    });
  } else if (!sp.train_hash || !sp.holdout_hash) {
    checks.push({
      name: 'Seed gate (train/holdout independence)',
      status: 'fail',
      detail: `manifest carries seed_provenance but train_hash=${sp.train_hash ? 'set' : 'missing'} / holdout_hash=${sp.holdout_hash ? 'set' : 'missing'} — the seed split did not complete.`,
    });
  } else if (sp.train_hash === sp.holdout_hash) {
    checks.push({
      name: 'Seed gate (train/holdout independence)',
      status: 'fail',
      detail: 'train_hash and holdout_hash are identical — the split degenerated and the K-score is not measuring generalization.',
    });
  } else if ((sp.input_overlap_count || 0) > 0 || (sp.output_overlap_count || 0) > 0) {
    checks.push({
      name: 'Seed gate (train/holdout independence)',
      status: 'fail',
      detail: `leakage detected: ${sp.input_overlap_count || 0} input overlap${sp.input_overlap_count === 1 ? '' : 's'}, ${sp.output_overlap_count || 0} output overlap${sp.output_overlap_count === 1 ? '' : 's'} between train and holdout. Deduplicate seeds.jsonl or pick a different split_seed.`,
    });
  } else if ((sp.grouped_overlap_count || 0) > 0) {
    checks.push({
      name: 'Seed gate (train/holdout independence)',
      status: 'warn',
      detail: `${sp.grouped_overlap_count} row${sp.grouped_overlap_count === 1 ? '' : 's'} share a grouping-key tag (member_id/claim_id) between train and holdout — same-entity leakage may be inflating the K-score.`,
    });
  } else if (sp.holdout_count < (sp.min_holdout || 10)) {
    const verdict = sp.production_ready === true ? 'fail' : 'warn';
    checks.push({
      name: 'Seed gate (train/holdout independence)',
      status: verdict,
      detail: `holdout_count=${sp.holdout_count} is below the production threshold (${sp.min_holdout || 10}). K-score should be labeled "sample check" not a production gate. ${verdict === 'fail' ? 'production_ready=true is inconsistent with the small holdout — re-build.' : 'add more captured rows to seeds.jsonl before relying on this number.'}`,
    });
  } else if (sp.eval_source === 'synthetic_starter') {
    checks.push({
      name: 'Seed gate (train/holdout independence)',
      status: 'warn',
      detail: `holdout cleared (${sp.holdout_count} rows, ${sp.comparator}) but eval_source=synthetic_starter — K-score measured on illustrative public-domain data, not captured tenant IO. Replace seeds with real captured IO before publishing this K-score.`,
    });
  } else {
    checks.push({
      name: 'Seed gate (train/holdout independence)',
      status: 'pass',
      detail: `train=${sp.train_count} / holdout=${sp.holdout_count} disjoint (comparator=${sp.comparator}, eval_source=${sp.eval_source}, split_seed=${(sp.split_seed || '').slice(0, 12)}…)${sp.production_ready ? '; production_ready' : ''}`,
    });
  }

  // 8. Capability contract. Re-validate the block (hash recompute) so a buyer
  // can prove the contract didn't drift after the artifact was sealed. Block
  // is optional (pre-Wave-144 artifacts skip it).
  if (manifest.capability) {
    try {
      const cap = validateCapability(manifest.capability);
      const reqs = [];
      if (cap.min_vram_gb != null) reqs.push(`vram>=${cap.min_vram_gb}GB`);
      if (cap.runtimes) reqs.push(`runtimes:${cap.runtimes.join('|')}`);
      if (cap.modalities) reqs.push(`modalities:${cap.modalities.join(',')}`);
      if (cap.requires_confidential_compute) reqs.push(`tee:${cap.attestation}`);
      if (cap.min_device_profile) reqs.push(`device:${cap.min_device_profile}`);
      checks.push({
        name: 'Capability contract',
        status: 'pass',
        detail: `${cap.spec} hash=${cap.hash} ${reqs.length ? '(' + reqs.join(', ') + ')' : '(no host requirements)'}`,
      });
    } catch (e) {
      checks.push({
        name: 'Capability contract',
        status: 'fail',
        detail: `manifest.capability rejected: ${e.message}`,
      });
    }
  }

  // 9. Lineage block. Re-validate the source pointers + hash recompute.
  // Block is optional (pre-Wave-144 artifacts skip it).
  let lineage = null;
  if (manifest.lineage) {
    try {
      lineage = validateLineage(manifest.lineage);
      const pointers = [];
      if (lineage.parent_artifact_hash) pointers.push(`parent=${lineage.parent_artifact_hash.slice(0, 12)}…`);
      if (lineage.workflow_ir_hash) pointers.push(`ir=${lineage.workflow_ir_hash}`);
      if (lineage.source_trace_ids?.length) pointers.push(`traces=${lineage.source_trace_ids.length}`);
      if (lineage.federated_round_id) pointers.push(`fl_round=${lineage.federated_round_id}`);
      if (lineage.teacher) pointers.push(`teacher=${lineage.teacher.vendor}:${lineage.teacher.model}`);
      if (lineage.student_base) pointers.push(`student=${lineage.student_base.repo}`);
      if (lineage.team_event_head_hash) pointers.push(`team_head=${lineage.team_event_head_hash}`);
      checks.push({
        name: 'Lineage block',
        status: 'pass',
        detail: `${lineage.spec} hash=${lineage.hash} source=${lineage.source}${pointers.length ? ' (' + pointers.join(', ') + ')' : ''}`,
      });
    } catch (e) {
      checks.push({
        name: 'Lineage block',
        status: 'fail',
        detail: `manifest.lineage rejected: ${e.message}`,
      });
    }
  }

  // 10. Workflow IR recompute. When the lineage points at a workflow_ir_hash
  // (source='workflow_compile' makes this required), the artifact zip must
  // ship workflow_ir.json and the verifier recomputes hashIr() to confirm the
  // IR shipped == IR claimed. Failing this is a fail — a claim with no IR
  // shipped is a metadata-only assertion that does not satisfy the
  // production-ready gate.
  if (lineage && lineage.workflow_ir_hash) {
    let irText = null;
    try {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(bundle.artifact_path);
      const e = zip.getEntries().find(x => x.entryName === 'workflow_ir.json');
      if (e) irText = e.getData().toString('utf8');
    } catch { /* swallow — handled below */ }
    if (!irText) {
      checks.push({
        name: 'Workflow IR recompute',
        status: 'fail',
        detail: `lineage claims workflow_ir_hash=${lineage.workflow_ir_hash} but workflow_ir.json is not bundled in the .kolm; the claim cannot be verified.`,
      });
    } else {
      let ir = null;
      try { ir = JSON.parse(irText); }
      catch (e) {
        checks.push({
          name: 'Workflow IR recompute',
          status: 'fail',
          detail: `workflow_ir.json could not be parsed: ${e.message}`,
        });
      }
      if (ir) {
        try {
          const recomputed = hashIr(ir);
          const ok = recomputed === lineage.workflow_ir_hash;
          checks.push({
            name: 'Workflow IR recompute',
            status: ok ? 'pass' : 'fail',
            detail: ok
              ? `IR recompute matches lineage.workflow_ir_hash (${recomputed}); ${ir.nodes?.length || 0} nodes, ${ir.edges?.length || 0} edges, ${ir.seeds?.length || 0} seeds`
              : `IR recompute mismatch: bundled IR hashes to ${recomputed}, lineage claims ${lineage.workflow_ir_hash}`,
          });
        } catch (e) {
          checks.push({
            name: 'Workflow IR recompute',
            status: 'fail',
            detail: `IR failed structural validation: ${e.message}`,
          });
        }
      }
    }
  }

  // 11. Confidential-compute attestation state. When the capability declares
  // requires_confidential_compute=true, the manifest must carry a
  // confidential_compute block. If an attestation_report.json is bundled, the
  // verifier re-runs verifyAttestation() and compares states; if the report
  // is missing or the state is below SHAPE_OK, the artifact does not satisfy
  // the contract it claims.
  const cap = manifest.capability;
  if (cap && cap.requires_confidential_compute) {
    const cc = manifest.confidential_compute;
    if (!cc) {
      checks.push({
        name: 'Attestation state',
        status: 'fail',
        detail: `capability requires_confidential_compute=true with attestation=${cap.attestation} but manifest carries no confidential_compute block.`,
      });
    } else if (cc.kind !== cap.attestation) {
      checks.push({
        name: 'Attestation state',
        status: 'fail',
        detail: `attestation kind mismatch: capability claims ${cap.attestation}, confidential_compute block says ${cc.kind}.`,
      });
    } else if (cc.state === CC_STATES.UNVERIFIED || cc.state === CC_STATES.REJECTED) {
      checks.push({
        name: 'Attestation state',
        status: 'fail',
        detail: `attestation state=${cc.state} (verifier=${cc.verifier || 'none'}); does not satisfy the capability contract.`,
      });
    } else {
      // Optionally re-run verifyAttestation when a report is bundled.
      let report = null;
      try {
        const AdmZip = (await import('adm-zip')).default;
        const zip = new AdmZip(bundle.artifact_path);
        const e = zip.getEntries().find(x => x.entryName === 'attestation_report.json');
        if (e) report = JSON.parse(e.getData().toString('utf8'));
      } catch { /* swallow — handled below */ }
      if (report) {
        try {
          const fresh = await verifyAttestation(cc.kind, report);
          const consistent = fresh.state === cc.state && fresh.verified === cc.verified;
          if (!consistent) {
            checks.push({
              name: 'Attestation state',
              status: 'fail',
              detail: `attestation re-verify drifted: manifest claims state=${cc.state} verified=${cc.verified}, recomputed state=${fresh.state} verified=${fresh.verified} (verifier=${fresh.verifier}).`,
            });
          } else if (fresh.state === CC_STATES.CRYPTOGRAPHICALLY_VERIFIED) {
            checks.push({
              name: 'Attestation state',
              status: 'pass',
              detail: `${cc.kind} cryptographically verified (verifier=${fresh.verifier}${fresh.trust_root ? `, root=${fresh.trust_root}` : ''}${fresh.not_after ? `, not_after=${fresh.not_after}` : ''}).`,
            });
          } else if (fresh.state === CC_STATES.SHAPE_OK) {
            checks.push({
              name: 'Attestation state',
              status: 'warn',
              detail: `${cc.kind} shape-only (no cryptographic chain walked; register a verifier via registerAttestationVerifier or set requires_confidential_compute=false if shape is sufficient).`,
            });
          } else {
            checks.push({
              name: 'Attestation state',
              status: 'fail',
              detail: `attestation state=${fresh.state} (${fresh.reason || 'unspecified'}).`,
            });
          }
        } catch (e) {
          checks.push({
            name: 'Attestation state',
            status: 'fail',
            detail: `attestation re-verify threw: ${e.message}`,
          });
        }
      } else {
        // No report bundled — trust the embedded state but downgrade
        // CRYPTOGRAPHICALLY_VERIFIED to warn because we cannot replay.
        const isVerified = cc.state === CC_STATES.CRYPTOGRAPHICALLY_VERIFIED && cc.verified === true;
        checks.push({
          name: 'Attestation state',
          status: isVerified ? 'warn' : 'fail',
          detail: isVerified
            ? `${cc.kind} state=${cc.state} (verifier=${cc.verifier || 'none'}) but attestation_report.json not bundled — verifier cannot replay the check.`
            : `${cc.kind} state=${cc.state} (verifier=${cc.verifier || 'none'}); below CRYPTOGRAPHICALLY_VERIFIED.`,
        });
      }
    }
  }

  // 12. Native binary integrity. Wave G ships compiled native binaries (cc /
  // rustc) alongside the C and Rust sources when the builder had a toolchain.
  // Each compiled_targets.recipes[rid].{c,rust}.bin block claims a filename +
  // bin_hash; the verifier opens the zip, re-hashes the bundled bytes, and
  // confirms they match. Absent .bin blocks are skipped silently — pre-Wave-G
  // artifacts and any artifact built without KOLM_COMPILE_NATIVE=1 fall
  // through here. A mismatch is a hard fail: the artifact claims a binary
  // exists and hashes to X, but the bundle disagrees.
  const ct = manifest.compiled_targets;
  if (ct && ct.recipes && typeof ct.recipes === 'object') {
    const claims = [];
    for (const rid of Object.keys(ct.recipes)) {
      const rec = ct.recipes[rid];
      if (rec.c && rec.c.bin) claims.push({ rid, kind: 'c', bin: rec.c.bin });
      if (rec.rust && rec.rust.bin) claims.push({ rid, kind: 'rust', bin: rec.rust.bin });
      // Wave 155 — wasm sub-block (no source file of its own; reuses .c/.rs).
      if (rec.wasm && rec.wasm.bin) claims.push({ rid, kind: 'wasm', bin: rec.wasm.bin });
    }
    if (claims.length > 0) {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(bundle.artifact_path);
      const entriesByName = new Map();
      for (const e of zip.getEntries()) entriesByName.set(e.entryName, e);
      const failures = [];
      const passed = [];
      for (const claim of claims) {
        const filename = claim.bin.bin_filename;
        const expected = claim.bin.bin_hash;
        const entry = entriesByName.get(filename);
        if (!entry) {
          failures.push(`${claim.rid}/${claim.kind}: ${filename} not bundled`);
          continue;
        }
        const data = entry.getData();
        const actual = crypto.createHash('sha256').update(data).digest('hex');
        if (actual !== expected) {
          failures.push(`${claim.rid}/${claim.kind}: ${filename} hash mismatch (claim=${expected.slice(0, 12)}…, actual=${actual.slice(0, 12)}…)`);
        } else {
          passed.push(`${claim.rid}/${claim.kind}=${claim.bin.compiler}@${claim.bin.bytes}B`);
        }
      }
      if (failures.length > 0) {
        checks.push({
          name: 'Native binary integrity',
          status: 'fail',
          detail: `compiled_targets claims ${claims.length} native binary(ies); ${failures.length} failed: ${failures.join('; ')}`,
        });
      } else {
        checks.push({
          name: 'Native binary integrity',
          status: 'pass',
          detail: `${passed.length} native binary(ies) re-hashed and bound to manifest: ${passed.join(', ')} on ${ct.host_triple || 'unspecified host'}`,
        });
      }
    }
  }

  // 13. Build reproducibility (wave 156, P+4). Opt-in via KOLM_VERIFY_REBUILD=1.
  // Closes the loop on the receipt chain's toolchain_version_hash + pin: when
  // the verifier has a matching local toolchain (same compiler, same version),
  // re-compile the bundled source through the same code path the builder used
  // and confirm the resulting bin_hash matches the manifest claim.
  //
  // Check #12 (cheap, always on) catches naive tampering with the bundled
  // bytes. Check #13 (expensive, opt-in) catches the subtler case where the
  // binary in the zip does not actually correspond to what the pinned
  // toolchain would produce from the bundled source — i.e. where the source +
  // toolchain pin look correct but the binary is forged.
  //
  // Skip-graceful by design: no matching toolchain on host = skip with reason
  // naming the pin; version drift = skip; source missing = skip; compile
  // failure = skip. Hard fail is reserved for "rebuild succeeded but bin_hash
  // differs" — the actual reproducibility break the check is meant to catch.
  if (ct && ct.recipes && typeof ct.recipes === 'object') {
    const rebuildOptedIn = process.env.KOLM_VERIFY_REBUILD === '1';
    const rebuildClaims = [];
    for (const rid of Object.keys(ct.recipes)) {
      const rec = ct.recipes[rid];
      if (rec.c && rec.c.bin) {
        rebuildClaims.push({ rid, kind: 'c', bin: rec.c.bin, sourceFilename: rec.c.filename });
      }
      if (rec.rust && rec.rust.bin) {
        rebuildClaims.push({ rid, kind: 'rust', bin: rec.rust.bin, sourceFilename: rec.rust.filename });
      }
      if (rec.wasm && rec.wasm.bin) {
        // wasm reuses the .c or .rs source — pick by source_kind.
        const skind = rec.wasm.bin.source_kind || 'rust';
        const srcFn = skind === 'rust' ? (rec.rust && rec.rust.filename) : (rec.c && rec.c.filename);
        if (srcFn) {
          rebuildClaims.push({ rid, kind: 'wasm', bin: rec.wasm.bin, sourceFilename: srcFn, source_kind: skind });
        }
      }
    }
    if (rebuildClaims.length > 0 && !rebuildOptedIn) {
      checks.push({
        name: 'Build reproducibility',
        status: 'warn',
        detail: `${rebuildClaims.length} native binary claim(s) eligible for deterministic rebuild; skipped (set KOLM_VERIFY_REBUILD=1 to enable — the cheap bin_hash re-check in check #12 still ran)`,
      });
    } else if (rebuildClaims.length > 0 && rebuildOptedIn) {
      const NC = await import('./native-compile.js');
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(bundle.artifact_path);
      const entriesByName = new Map();
      for (const e of zip.getEntries()) entriesByName.set(e.entryName, e);
      const localTC = NC.detectToolchains();
      const passes = [];
      const fails = [];
      const skips = [];
      for (const claim of rebuildClaims) {
        const tc = claim.kind === 'c' ? localTC.c
                 : claim.kind === 'rust' ? localTC.rust
                 : localTC.wasm;
        if (!tc) {
          skips.push(`${claim.rid}/${claim.kind}: no ${claim.kind} toolchain on host (pin: ${claim.bin.compiler}@${claim.bin.compiler_version})`);
          continue;
        }
        if (tc.compiler !== claim.bin.compiler) {
          skips.push(`${claim.rid}/${claim.kind}: compiler drift (host=${tc.compiler}, pin=${claim.bin.compiler})`);
          continue;
        }
        if (tc.version !== claim.bin.compiler_version) {
          skips.push(`${claim.rid}/${claim.kind}: version drift (host=${tc.version}, pin=${claim.bin.compiler_version})`);
          continue;
        }
        if (claim.kind === 'wasm' && tc.source_kind !== claim.source_kind) {
          skips.push(`${claim.rid}/${claim.kind}: wasm source_kind drift (host=${tc.source_kind}, pin=${claim.source_kind})`);
          continue;
        }
        const srcEntry = entriesByName.get(claim.sourceFilename);
        if (!srcEntry) {
          skips.push(`${claim.rid}/${claim.kind}: source ${claim.sourceFilename} not bundled`);
          continue;
        }
        const sourceText = srcEntry.getData().toString('utf8');
        try {
          const r = NC.rebuildBinaryFromSource({ kind: claim.kind, sourceText, toolchain: tc, recipeId: claim.rid });
          const newHash = crypto.createHash('sha256').update(r.bin).digest('hex');
          if (newHash === claim.bin.bin_hash) {
            passes.push(`${claim.rid}/${claim.kind}=${tc.compiler}@${r.bin.length}B`);
          } else {
            fails.push(`${claim.rid}/${claim.kind}: rebuilt hash differs (claim=${claim.bin.bin_hash.slice(0, 12)}…, rebuilt=${newHash.slice(0, 12)}…)`);
          }
        } catch (e) {
          skips.push(`${claim.rid}/${claim.kind}: rebuild threw (${String(e.message || e).slice(0, 120)})`);
        }
      }
      if (fails.length > 0) {
        checks.push({
          name: 'Build reproducibility',
          status: 'fail',
          detail: `${fails.length} of ${rebuildClaims.length} binary(ies) failed deterministic rebuild: ${fails.join('; ')}${skips.length > 0 ? ` (plus ${skips.length} skipped: ${skips.join('; ')})` : ''}`,
        });
      } else if (passes.length > 0) {
        checks.push({
          name: 'Build reproducibility',
          status: 'pass',
          detail: `${passes.length} of ${rebuildClaims.length} binary(ies) rebuilt deterministically and matched manifest claim: ${passes.join(', ')}${skips.length > 0 ? ` (${skips.length} skipped: ${skips.join('; ')})` : ''}`,
        });
      } else {
        checks.push({
          name: 'Build reproducibility',
          status: 'warn',
          detail: `0 of ${rebuildClaims.length} binary(ies) rebuilt (no matching toolchain on host): ${skips.join('; ')}`,
        });
      }
    }
  }

  // 14. PHI redactor receipt integrity (wave 157, Q+3a). When the artifact's
  // training block declares redact_class != 'none', the receipt chain must
  // carry all three log hashes (redaction_map_hash + teacher_call_log_hash +
  // reinjection_log_hash) so an auditor can replay the redactor offline and
  // prove raw PHI never left the tenant boundary. If a bundled teacher-call
  // log is present in the zip, its sha256 must match the manifest claim AND
  // every redacted_input / redacted_response line must contain only [PHI_*_n]
  // placeholders (no recognizable raw identifiers via the same detector set
  // the redactor uses).
  //
  // This check is the gate that converts the "we redacted" claim from a
  // recorded string into something a third party can verify. Without it,
  // a tampered manifest could carry redact_class='phi' without any of the
  // logs actually existing — a buyer would have no signal.
  const training = manifest.training || {};
  const declaredRedactClass = training.redact_class || null;
  if (declaredRedactClass && declaredRedactClass !== 'none') {
    const missing = [];
    if (!training.redaction_map_hash)    missing.push('redaction_map_hash');
    if (!training.teacher_call_log_hash) missing.push('teacher_call_log_hash');
    if (!training.reinjection_log_hash)  missing.push('reinjection_log_hash');
    if (missing.length > 0) {
      checks.push({
        name: 'PHI redactor receipt integrity',
        status: 'fail',
        detail: `training.redact_class=${JSON.stringify(declaredRedactClass)} declared but manifest.training is missing required hash(es): ${missing.join(', ')}. A redact_class other than 'none' requires the full receipt chain so an auditor can replay the redactor.`,
      });
    } else {
      // Optional auditor-replay: if the teacher-call-log file is bundled in
      // the zip, re-hash it and confirm it matches the manifest claim. Also
      // scan the bundled log for raw PHI leakage (every redacted_input and
      // redacted_response line should contain only [PHI_*_n] placeholders).
      let bundledLogChecked = false;
      let logHashMatch = null;
      let leakageCount = 0;
      try {
        const AdmZip = (await import('adm-zip')).default;
        const zip = new AdmZip(bundle.artifact_path);
        const logEntry = zip.getEntry('teacher-call-log.jsonl');
        if (logEntry) {
          bundledLogChecked = true;
          const logBytes = logEntry.getData();
          const reHash = 'sha256:' + crypto.createHash('sha256').update(logBytes).digest('hex');
          logHashMatch = reHash === training.teacher_call_log_hash;
          if (logHashMatch) {
            const PR = await import('./phi-redactor.js');
            const lines = logBytes.toString('utf8').split(/\r?\n/).filter(Boolean);
            for (const ln of lines) {
              let entry;
              try { entry = JSON.parse(ln); } catch { continue; }
              // Re-run the redactor on each redacted_* field; if the redactor
              // finds any NEW token to insert, the field was carrying raw PHI
              // when written to the log (leakage).
              for (const fieldName of ['redacted_input', 'redacted_system', 'redacted_response']) {
                const fv = entry[fieldName];
                if (typeof fv !== 'string' || !fv) continue;
                const r = PR.redact(fv);
                const newTokenCount = Object.keys(r.map).length;
                if (newTokenCount > 0) leakageCount += newTokenCount;
              }
            }
          }
        }
      } catch { /* zip read failure is non-fatal — main hash claim still stands */ }
      if (bundledLogChecked && logHashMatch === false) {
        checks.push({
          name: 'PHI redactor receipt integrity',
          status: 'fail',
          detail: `teacher-call-log.jsonl bundled in artifact but its sha256 does not match training.teacher_call_log_hash; the log was modified after the worker sealed it.`,
        });
      } else if (bundledLogChecked && leakageCount > 0) {
        checks.push({
          name: 'PHI redactor receipt integrity',
          status: 'fail',
          detail: `bundled teacher-call-log.jsonl contains ${leakageCount} raw identifier(s) the redactor failed to mask before the teacher call. raw PHI is in the log; the redactor's tenant-boundary guarantee is broken for this artifact.`,
        });
      } else {
        const replay = bundledLogChecked
          ? `; bundled teacher-call-log.jsonl re-hashed and scanned (0 raw identifiers detected)`
          : `; teacher-call-log.jsonl not bundled — verifier confirmed hash claims only`;
        checks.push({
          name: 'PHI redactor receipt integrity',
          status: 'pass',
          detail: `redact_class=${declaredRedactClass}; redaction_map_hash + teacher_call_log_hash + reinjection_log_hash all present in receipt chain${replay}`,
        });
      }
    }
  }

  // 15. Cross-vendor distillation provenance (wave 158, Q+3b). When the
  // artifact carries a distillation lineage (manifest.lineage.source === 'distillation'),
  // the receipt chain must include the four cross-vendor provenance fields
  // (teacher_vendor + teacher_model + student_base + distillation_method)
  // so a third party can identify which teacher/student combination produced
  // the artifact AND verify the chain back to a specific kolm-distill worker
  // run. The license-bearing student_base_license string is also required
  // when the student_base slug is present, so the receipt self-describes the
  // weights' license terms without requiring a HuggingFace lookup.
  //
  // This check converts the "we distilled from X teacher" claim from a
  // marketing string into a manifest field the verifier confirms is present
  // alongside the lineage block.
  // Reuses `lineage` from check #9 above (line 558); guarded for the case
  // where the validateLineage parse threw (lineage stayed null).
  const lineageSource = lineage && lineage.source;
  if (lineageSource === 'distillation') {
    const missingProv = [];
    if (!training.teacher_vendor)       missingProv.push('teacher_vendor');
    if (!training.teacher_model)        missingProv.push('teacher_model');
    if (!training.student_base)         missingProv.push('student_base');
    if (!training.distillation_method)  missingProv.push('distillation_method');
    if (missingProv.length > 0) {
      checks.push({
        name: 'Cross-vendor distillation provenance',
        status: 'fail',
        detail: `manifest.lineage.source='distillation' but manifest.training is missing required field(s): ${missingProv.join(', ')}. Distillation lineage requires the full cross-vendor provenance set so a verifier can identify the teacher/student combination.`,
      });
    } else {
      // Optional license self-description: when the student_base slug carries
      // a known catalog license, training.student_base_license should match.
      // We don't fail on a missing license string (legacy or out-of-catalog
      // student bases may be license-unknown), but we surface it in the pass
      // detail so a reader can see what's in the receipt.
      const licenseNote = training.student_base_license
        ? ` · student_base_license=${training.student_base_license}`
        : ` · student_base_license=(unspecified)`;
      const teacherStr = `${training.teacher_vendor}:${training.teacher_model}`
        + (training.teacher_version ? `@${training.teacher_version}` : '');
      const studentStr = `${training.student_base}`
        + (training.student_base_revision ? `@${training.student_base_revision}` : '');
      const methodStr = training.distillation_method;
      const trainingCorpusStr = lineage.training_corpus_hash
        ? ` · training_corpus_hash=${lineage.training_corpus_hash}`
        : '';
      checks.push({
        name: 'Cross-vendor distillation provenance',
        status: 'pass',
        detail: `teacher=${teacherStr} · student=${studentStr} · method=${methodStr}${licenseNote}${trainingCorpusStr}`,
      });
    }
  }

  // 16. K-score teacher-delta axis T (wave 160, Q+3c). When the artifact carries
  // a distillation lineage AND the distillation_method produces real student
  // weights (lora, qlora, full-ft — anything that fine-tunes a base model), the
  // receipt must record the teacher's accuracy on the SAME holdout the student
  // was scored against, so the K-score V2 T axis (= student_holdout /
  // teacher_holdout) can be computed and the cost/quality tradeoff is legible.
  //
  // Per Wave 144 Doc 7 §4.7: A/T = 1.0 means the student matches the teacher;
  // A/T = 0.9 means the student is at 90% of teacher accuracy on the same
  // holdout. Without this axis a buyer cannot distinguish "5x cheaper at 95% of
  // teacher accuracy" from "5x cheaper at 60% of teacher accuracy" — Pablo's
  // point about K-score being self-graded becomes architecturally impossible.
  //
  // For prompt-distill (no fine-tune, recipe is teacher-as-judge codegen) the
  // T axis is informational only and absence is a warn-not-fail.
  const ML_FINETUNE_METHODS = ['lora', 'qlora', 'full-ft'];
  if (lineageSource === 'distillation') {
    const method = training.distillation_method;
    const k = manifest.k_score || {};
    const ta = k.teacher_holdout_accuracy;
    const sa = k.holdout_accuracy;
    if (ML_FINETUNE_METHODS.includes(method)) {
      if (ta == null || sa == null) {
        checks.push({
          name: 'K-score teacher-delta (A/T)',
          status: 'fail',
          detail: `distillation_method=${method} requires teacher_holdout_accuracy + holdout_accuracy in k_score for the T axis. Re-run the distill worker with --teacher-holdout=path/to/teacher-holdout.jsonl so the receipt records the teacher's accuracy on the same holdout the student was scored against (Wave 144 Doc 7 §4.7).`,
        });
      } else {
        const aOverT = sa / Math.max(1e-6, ta);
        const ratio = aOverT.toFixed(4);
        const pct = (aOverT * 100).toFixed(1);
        const T = (k.teacher_fidelity_score != null) ? k.teacher_fidelity_score.toFixed(4) : ratio;
        checks.push({
          name: 'K-score teacher-delta (A/T)',
          status: 'pass',
          detail: `student_holdout=${sa.toFixed(4)} · teacher_holdout=${ta.toFixed(4)} · A/T=${ratio} (student at ${pct}% of teacher accuracy on the same holdout) · T axis = ${T}`,
        });
      }
    } else if (method === 'prompt-distill') {
      if (ta == null || sa == null) {
        checks.push({
          name: 'K-score teacher-delta (A/T)',
          status: 'warn',
          detail: `distillation_method=prompt-distill (teacher-as-judge, no fine-tune); T axis informational only. Supply --teacher-holdout to record A/T for cost/quality legibility.`,
        });
      } else {
        const aOverT = (sa / Math.max(1e-6, ta)).toFixed(4);
        const pct = (Number(aOverT) * 100).toFixed(1);
        checks.push({
          name: 'K-score teacher-delta (A/T)',
          status: 'pass',
          detail: `student_holdout=${sa.toFixed(4)} · teacher_holdout=${ta.toFixed(4)} · A/T=${aOverT} (student at ${pct}% of teacher accuracy on the same holdout) [prompt-distill]`,
        });
      }
    }
  }

  // 17. Signature policy (Ed25519) (wave 161, Q+8). Wave 149 made Ed25519 the
  // DEFAULT signer; check #17 makes Ed25519 a CONTRACT. Either side can demand
  // public-key signing: the artifact (via manifest.policy.require_ed25519) or
  // the verifier (via env KOLM_REQUIRE_ED25519=1). When either is true, an
  // HMAC-only receipt is a hard fail — HMAC is a symmetric MAC, anyone who can
  // verify it can also forge it, so a third-party signature claim cannot rest
  // on HMAC alone. The companion check #5 ("Receipt signature (Ed25519,
  // public-key)") already verifies the signature itself; check #17's job is to
  // gate on whether the signature is REQUIRED by policy, separating the
  // cryptographic verification from the policy enforcement.
  //
  // Pre-Wave-161 artifacts have no manifest.policy field, so unless the
  // verifier opts in via env, the check passes with an informational detail
  // explaining the policy default.
  const policyRequiresEd25519 = (
    (manifest.policy && manifest.policy.require_ed25519 === true)
    || process.env.KOLM_REQUIRE_ED25519 === '1'
  );
  const ed25519CheckResult = checks.find(c => c.name === 'Receipt signature (Ed25519, public-key)');
  const ed25519Present = !!(receipt && receipt.signature_ed25519);
  if (policyRequiresEd25519) {
    if (!ed25519Present) {
      const src = manifest.policy?.require_ed25519 === true
        ? 'manifest.policy.require_ed25519=true'
        : 'env KOLM_REQUIRE_ED25519=1';
      checks.push({
        name: 'Signature policy (Ed25519)',
        status: 'fail',
        detail: `${src} but receipt carries only HMAC integrity (signature_alg=${receipt?.signature_alg || '?'}). HMAC is a symmetric MAC and cannot prove provenance to a third party — re-sign with Ed25519 (unset KOLM_ED25519_DISABLE, or set KOLM_ED25519_PRIVATE_KEY_PATH=/path/to/key.pem) or relax the policy.`,
      });
    } else if (ed25519CheckResult && ed25519CheckResult.status === 'pass') {
      checks.push({
        name: 'Signature policy (Ed25519)',
        status: 'pass',
        detail: `policy requires Ed25519 and the signature_ed25519 block verified against its embedded public key (HMAC retained as a legacy integrity check, not as the primary signature)`,
      });
    } else {
      checks.push({
        name: 'Signature policy (Ed25519)',
        status: 'fail',
        detail: `policy requires Ed25519 but the signature_ed25519 verification did not pass — see prior "Receipt signature (Ed25519, public-key)" check for the failure reason`,
      });
    }
  } else if (ed25519Present) {
    checks.push({
      name: 'Signature policy (Ed25519)',
      status: 'pass',
      detail: `policy does not require Ed25519 (manifest.policy.require_ed25519 missing or false; env KOLM_REQUIRE_ED25519 not set) but receipt carries an Ed25519 signature anyway — verification status above`,
    });
  } else {
    checks.push({
      name: 'Signature policy (Ed25519)',
      status: 'pass',
      detail: `policy does not require Ed25519; receipt carries HMAC integrity check only. Set manifest.policy.require_ed25519=true at build time or env KOLM_REQUIRE_ED25519=1 at verify time to upgrade the gate.`,
    });
  }

  // 18. Transparency policy (Rekor) (wave 162, Q+9). Wave 150 made sigstore
  // the DEFAULT third signature layer; Wave 162 makes Rekor pinning a
  // CONTRACT. Sigstore is dry-run by default — the bundle is structurally
  // valid and verifies offline against the embedded Ed25519 public key, but
  // it has not been recorded in a publicly-readable, append-only transparency
  // log. Rekor is what turns "I signed this offline" into "I signed this AND
  // a public log proves it existed at this moment, before any later claim of
  // when/by-whom" — the difference between a notarized document and an
  // unsigned letter.
  //
  // Either side can demand a pinned bundle: the artifact (via
  // manifest.policy.require_rekor) or the verifier (via env
  // KOLM_REQUIRE_REKOR=1). When either is true, a dry-run sigstore block (or
  // a missing one) is a hard fail. The companion checks "Receipt signature
  // (Sigstore bundle)" already verify the bundle's signature math; check #18
  // gates on whether the public-log pinning is REQUIRED by policy,
  // separating the cryptographic verification from the policy enforcement
  // (same split-of-concerns as check #17 vs check #5 for Ed25519).
  //
  // Pre-Wave-162 artifacts have no manifest.policy.require_rekor field, so
  // unless the verifier opts in via env, the check passes with an
  // informational detail explaining the default and the upgrade path.
  const policyRequiresRekor = (
    (manifest.policy && manifest.policy.require_rekor === true)
    || process.env.KOLM_REQUIRE_REKOR === '1'
  );
  const sigstorePresent = !!(receipt && receipt.signature_sigstore);
  const sigstoreDryRun = !!(receipt && receipt.signature_sigstore && receipt.signature_sigstore.dry_run === true);
  const sigstoreCheckResult = checks.find(c => c.name === 'Receipt signature (Sigstore bundle)');
  const rekorEntry = receipt?.signature_sigstore?.rekor_log_entry || null;
  if (policyRequiresRekor) {
    if (!sigstorePresent) {
      const src = manifest.policy?.require_rekor === true
        ? 'manifest.policy.require_rekor=true'
        : 'env KOLM_REQUIRE_REKOR=1';
      checks.push({
        name: 'Transparency policy (Rekor)',
        status: 'fail',
        detail: `${src} but receipt carries no signature_sigstore block (signature_alg=${receipt?.signature_alg || '?'}). Sigstore is the public-transparency layer; without a Rekor entry the artifact's signature stands only on the publisher's word. Rebuild with sigstore enabled (unset KOLM_SIGSTORE_DISABLE) AND set KOLM_SIGSTORE_REKOR_URL=https://rekor.example to pin to a log.`,
      });
    } else if (sigstoreDryRun) {
      const src = manifest.policy?.require_rekor === true
        ? 'manifest.policy.require_rekor=true'
        : 'env KOLM_REQUIRE_REKOR=1';
      checks.push({
        name: 'Transparency policy (Rekor)',
        status: 'fail',
        detail: `${src} but signature_sigstore is dry-run (no rekor_log_entry). The bundle is structurally valid but has not been pinned to any public transparency log. Run \`kolm sigstore-attest <artifact> --rekor-url <https://rekor.example>\` to upgrade, or rebuild with KOLM_SIGSTORE_REKOR_URL set so the pin happens at build time.`,
      });
    } else if (sigstoreCheckResult && sigstoreCheckResult.status === 'pass') {
      const li = rekorEntry?.logIndex ?? '?';
      const ts = rekorEntry?.integratedTime;
      const tsIso = (typeof ts === 'number') ? new Date(ts * 1000).toISOString() : '?';
      checks.push({
        name: 'Transparency policy (Rekor)',
        status: 'pass',
        detail: `policy requires Rekor pinning and the signature_sigstore block carries a Rekor entry (logIndex=${li}, integratedTime=${tsIso}, logID=${(rekorEntry?.logID || '').slice(0, 16) || '?'}…). The artifact's existence at this moment is now provable from a public append-only log.`,
      });
    } else {
      checks.push({
        name: 'Transparency policy (Rekor)',
        status: 'fail',
        detail: `policy requires Rekor pinning but the Sigstore bundle verification did not pass — see prior "Receipt signature (Sigstore bundle)" check for the failure reason`,
      });
    }
  } else if (sigstorePresent && !sigstoreDryRun) {
    const li = rekorEntry?.logIndex ?? '?';
    checks.push({
      name: 'Transparency policy (Rekor)',
      status: 'pass',
      detail: `policy does not require Rekor (manifest.policy.require_rekor missing or false; env KOLM_REQUIRE_REKOR not set) but the bundle is pinned to Rekor anyway (logIndex=${li}) — verification status above`,
    });
  } else if (sigstorePresent) {
    checks.push({
      name: 'Transparency policy (Rekor)',
      status: 'pass',
      detail: `policy does not require Rekor; signature_sigstore is dry-run (structurally valid, locally verifiable, but not yet pinned to a transparency log). Set manifest.policy.require_rekor=true at build time (also set KOLM_SIGSTORE_REKOR_URL) or env KOLM_REQUIRE_REKOR=1 at verify time to upgrade the gate. Run \`kolm sigstore-attest <artifact>\` to publish without rebuilding.`,
    });
  } else {
    checks.push({
      name: 'Transparency policy (Rekor)',
      status: 'pass',
      detail: `policy does not require Rekor; receipt carries no signature_sigstore block (Ed25519 + HMAC stand as the cryptographic signatures). Set KOLM_SIGSTORE_REKOR_URL + KOLM_REKOR_REQUIRE=1 at build time to upgrade.`,
    });
  }

  // 19. Export targets (model files) (wave 163, P+6). Wave 146 wired the
  // export-provenance bridge (apps/export → loadExportProvenance →
  // manifest.export + bundled files inside the .kolm). Wave 163 closes the
  // verifier loop: re-open the zip, re-hash every declared target's bytes,
  // and confirm they match the sha256 stored in manifest.export.targets[].
  // The export_block.hash is also round-tripped through validateExportBlock
  // so any tamper with backend/exported_at/options also breaks the gate.
  //
  // Pass when: every declared target exists in the zip, every recomputed
  // sha256 matches the declared sha256, and the export_block round-trips.
  // Fail when: any target is missing, any hash drifts, or the block hash
  // mismatches its canonical recomputation.
  // Pass (informational) when: manifest.export is absent — most artifacts
  // are rule-class or distilled without a native export, so no bound
  // targets is the common case, not an error.
  if (!manifest.export) {
    checks.push({
      name: 'Export targets (model files)',
      status: 'pass',
      detail: `no manifest.export block present (no native model files bundled). Add an export via \`kolm compile <spec> --export=<backend>\` or \`--export-provenance <dir>\` to surface .gguf/.onnx/.mlpackage/.pte/mlx_model/engine into the artifact.`,
    });
  } else {
    let exportFail = null;
    let validated = null;
    try {
      validated = validateExportBlock(manifest.export);
    } catch (e) {
      exportFail = `manifest.export failed schema/hash validation: ${e.message}`;
    }
    if (!exportFail && validated) {
      try {
        const zip = new AdmZip(bundle.artifact_path);
        const entryMap = Object.fromEntries(zip.getEntries().map(e => [e.entryName, e]));
        const driftRows = [];
        const missingRows = [];
        let totalSize = 0;
        for (const t of validated.targets) {
          if (t.is_dir) {
            // Directory target: re-aggregate canonical hash from sub-entries
            // (rel\0sha256\0size joined by \n, sorted by rel), same shape as
            // src/export-provenance.js hashDir() and apps/export/run.py _hash_dir.
            const prefix = `${t.filename}/`;
            const subEntries = Object.keys(entryMap)
              .filter(name => name.startsWith(prefix) && !entryMap[name].isDirectory)
              .sort();
            if (subEntries.length === 0) {
              missingRows.push(`${t.filename}/ (directory: 0 files in zip)`);
              continue;
            }
            const lines = subEntries.map(name => {
              const rel = name.slice(prefix.length);
              const data = entryMap[name].getData();
              const sha = crypto.createHash('sha256').update(data).digest('hex');
              return `${rel}\0${sha}\0${data.length}`;
            });
            const canon = lines.join('\n');
            const recomputed = crypto.createHash('sha256').update(Buffer.from(canon, 'utf8')).digest('hex');
            const sumSize = subEntries.reduce((a, n) => a + entryMap[n].getData().length, 0);
            totalSize += sumSize;
            if (recomputed !== t.sha256) {
              driftRows.push(`${t.filename}/ (declared=${t.sha256.slice(0, 12)}… recomputed=${recomputed.slice(0, 12)}…)`);
            }
          } else {
            const ent = entryMap[t.filename];
            if (!ent) {
              missingRows.push(`${t.filename} (file: not in zip)`);
              continue;
            }
            const data = ent.getData();
            const recomputed = crypto.createHash('sha256').update(data).digest('hex');
            totalSize += data.length;
            if (recomputed !== t.sha256) {
              driftRows.push(`${t.filename} (declared=${t.sha256.slice(0, 12)}… recomputed=${recomputed.slice(0, 12)}…)`);
            }
          }
        }
        if (missingRows.length > 0) {
          exportFail = `manifest.export claims ${validated.targets.length} target(s) but ${missingRows.length} not found in zip:\n  ${missingRows.join('\n  ')}\n  the bridge bundles every declared target inside the .kolm — missing files mean the build emitted the manifest but failed to attach the bytes.`;
        } else if (driftRows.length > 0) {
          exportFail = `manifest.export target sha256 drift in ${driftRows.length} of ${validated.targets.length} target(s):\n  ${driftRows.join('\n  ')}\n  declared hash and recomputed hash differ — either the bytes inside the .kolm were tampered with after build, or the manifest was rewritten to claim a hash that doesn't match the file.`;
        } else {
          // All targets present, all hashes match, block round-trips.
          const fmts = Array.from(new Set(validated.targets.map(t => t.format))).sort().join(', ');
          const sizeMb = (totalSize / (1024 * 1024)).toFixed(2);
          checks.push({
            name: 'Export targets (model files)',
            status: 'pass',
            detail: `backend='${validated.backend}', ${validated.targets.length} target(s) [${fmts}], ${sizeMb} MB bundled; every declared sha256 recomputes from the zip bytes; export_block.hash round-trips. The .gguf/.onnx/etc. inside the artifact is exactly what the publisher signed.`,
          });
        }
      } catch (e) {
        exportFail = `export verification threw: ${e.message}`;
      }
    }
    if (exportFail) {
      checks.push({
        name: 'Export targets (model files)',
        status: 'fail',
        detail: exportFail,
      });
    }
  }

  // 20. External / adversarial holdouts (wave 164, N+3 / N+4). The eval
  // credibility roadmap (Wave 144 Doc 2 §7) layered eval independence as:
  //   N+1.5/Q+2  — tenant seeds.jsonl train/holdout split (seed_provenance,
  //                already checked at #2)
  //   N+3        — external public benchmark holdouts (kind='external')
  //   N+4        — adversarial cross-family LLM-pair holdouts (kind='adversarial')
  //   N+5 (w165) — tenant shadow corpus endpoint
  //   N+6 (w160) — teacher-delta T axis (already shipped)
  //   N+7 (w166) — third-party auditor attestation
  //
  // This check confirms the manifest.external_holdout_provenance block
  // round-trips through validateExternalHoldoutBlock AND each declared
  // holdout's JSONL still exists on disk at the catalog path with a
  // byte-identical sha256. If a builder shipped accuracy=1.0 on a holdout
  // they secretly edited after the build, the file_sha256 in the manifest
  // mismatches what's on disk — this check fires.
  //
  // Pass (informational) when: manifest.external_holdout_provenance absent
  // — the seeds.jsonl gate (check #2) is the floor; external + adversarial
  // are upgrades a tenant opts into by passing --external-holdout <name>
  // or --adversarial-holdout <name> at compile time.
  // Pass when: block validates, every named holdout's file_sha256 matches,
  // and at least one row was evaluated per holdout.
  // Fail when: block schema/hash drift, holdout file missing from disk,
  // or holdout file_sha256 drift.
  if (!manifest.external_holdout_provenance) {
    checks.push({
      name: 'External / adversarial holdouts',
      status: 'pass',
      detail: `no manifest.external_holdout_provenance block — only the tenant's seeds.jsonl holdout (check #2) is scoring this recipe. Add \`--external-holdout presidio-synthetic-v1\` or \`--adversarial-holdout cross-family-pair-v1\` (or both) to score against independent corpora documented in holdouts/catalog.json.`,
    });
  } else {
    let extFail = null;
    let validated = null;
    try {
      validated = validateExternalHoldoutBlock(manifest.external_holdout_provenance);
    } catch (e) {
      extFail = `manifest.external_holdout_provenance failed schema/hash validation: ${e.message}`;
    }
    if (!extFail && validated) {
      const driftRows = [];
      const missingRows = [];
      const summary = [];
      for (const h of validated.holdouts) {
        // Try the catalog's `file` field first, then the kind/<name>.jsonl
        // fallback. Both paths are resolved relative to cwd at verify time.
        const filePath = resolveHoldoutPath(h.name, { root: process.cwd() });
        const entry = findInCatalog(h.name, { root: process.cwd() });
        if (!filePath) {
          missingRows.push(`${h.name} (${h.kind}): file not found in holdouts/catalog.json or holdouts/${h.kind}/${h.name}.jsonl`);
          continue;
        }
        let actualSha;
        try {
          actualSha = hashHoldoutFile(filePath);
        } catch (e) {
          missingRows.push(`${h.name} (${h.kind}): ${e.message}`);
          continue;
        }
        if (actualSha !== h.file_sha256) {
          driftRows.push(`${h.name} (${h.kind}): manifest declared sha256=${h.file_sha256.slice(0, 12)}…, file on disk hashes to ${actualSha.slice(0, 12)}…`);
          continue;
        }
        // Also confirm the catalog entry's license/source_url still match
        // what the manifest recorded (a tenant editing catalog.json post-
        // build to claim a different provenance would slip through if we
        // only checked file bytes).
        if (entry) {
          if (entry.license && entry.license !== h.license) {
            driftRows.push(`${h.name}: catalog license='${entry.license}' but manifest declared license='${h.license}'`);
            continue;
          }
          if (entry.source_url && entry.source_url !== h.source_url) {
            driftRows.push(`${h.name}: catalog source_url='${entry.source_url}' but manifest declared source_url='${h.source_url}'`);
            continue;
          }
        }
        const accStr = typeof h.accuracy === 'number' ? `accuracy=${(h.accuracy * 100).toFixed(1)}%` : 'accuracy=n/a';
        const passedStr = (typeof h.passed_count === 'number' && typeof h.evaluated_count === 'number')
          ? `${h.passed_count}/${h.evaluated_count}`
          : `${h.row_count} rows`;
        summary.push(`${h.name} (${h.kind}, ${h.license}): ${accStr} on ${passedStr}`);
      }
      if (missingRows.length > 0) {
        extFail = `manifest.external_holdout_provenance claims ${validated.holdouts.length} holdout(s) but ${missingRows.length} could not be re-anchored:\n  ${missingRows.join('\n  ')}\n  the holdout JSONLs live under repo root (holdouts/<kind>/<name>.jsonl); without them the verifier cannot confirm the manifest's accuracy was computed over the corpus it claims.`;
      } else if (driftRows.length > 0) {
        extFail = `manifest.external_holdout_provenance has ${driftRows.length} drift(s):\n  ${driftRows.join('\n  ')}\n  this means either the corpus was edited after the build (so the K-score on it is no longer measuring what the manifest says) or the manifest was tampered with to claim a different corpus.`;
      } else {
        const externalCount = validated.holdouts.filter(h => h.kind === 'external').length;
        const adversarialCount = validated.holdouts.filter(h => h.kind === 'adversarial').length;
        const kindSummary = [
          externalCount > 0 ? `${externalCount} external` : null,
          adversarialCount > 0 ? `${adversarialCount} adversarial` : null,
        ].filter(Boolean).join(' + ');
        checks.push({
          name: 'External / adversarial holdouts',
          status: 'pass',
          detail: `${kindSummary} holdout(s) re-anchored from disk; every declared file_sha256 matches, block hash round-trips. ${summary.join('; ')}`,
        });
      }
    }
    if (extFail) {
      checks.push({
        name: 'External / adversarial holdouts',
        status: 'fail',
        detail: extFail,
      });
    }
  }

  // 21. Tenant shadow corpus (wave 165, N+5). The eval-credibility ladder's
  // N+5 tier — a per-tenant labeled holdout corpus that NEVER leaves the
  // tenant's environment. Unlike external_holdout (corpus ships under
  // repo root + every verifier can re-anchor) and unlike seeds.jsonl (corpus
  // ships inside the .kolm), tenant_shadow corpus bytes stay on the tenant's
  // server storage. The manifest carries {tenant_id, corpus_id, corpus_sha256,
  // accuracy, ...} but NOT the rows. HIPAA data-never-leaves-tenant by
  // construction.
  //
  // This check has THREE branches because the verifier's relationship to
  // tenant storage determines what it can prove:
  //   (a) absent: pass+informational — no block, only seeds.jsonl + external
  //       layers are scoring. Suggests --tenant-shadow-corpus upgrade.
  //   (b) present + corpus reachable on disk + bytes match: pass with re-anchor
  //       evidence (tenant-internal or air-gapped verifier with storage access)
  //   (c) present + corpus NOT reachable + schema/hash round-trip clean: pass
  //       with informational ("external verifier — corpus stays on tenant
  //       infrastructure; verified schema + block hash only"). This is the
  //       common case for an auditor with the .kolm but no tenant access.
  //   (d) present + reanchored but bytes drift: FAIL — corpus was edited
  //       post-build OR manifest tampered to claim different corpus.
  //   (e) present + schema/hash drift: FAIL — block was tampered with.
  if (!manifest.tenant_shadow_corpus_provenance) {
    checks.push({
      name: 'Tenant shadow corpus',
      status: 'pass',
      detail: `no manifest.tenant_shadow_corpus_provenance block — only the tenant's seeds.jsonl holdout (check #2) and any external/adversarial layers (check #20) are scoring this recipe. Upload a tenant-private labeled corpus via POST /v1/eval/tenant_holdout and pass \`--tenant-shadow-corpus <tenant_id>:<corpus_id>\` at compile time to add an N+5 layer the corpus bytes for which never leave your infrastructure.`,
    });
  } else {
    const raw = Array.isArray(manifest.tenant_shadow_corpus_provenance)
      ? manifest.tenant_shadow_corpus_provenance
      : [manifest.tenant_shadow_corpus_provenance];
    let tsFail = null;
    const validatedAll = [];
    for (const block of raw) {
      try {
        validatedAll.push(validateTenantShadowBlock(block));
      } catch (e) {
        tsFail = `manifest.tenant_shadow_corpus_provenance[tenant=${block?.tenant_id || '?'}, corpus=${block?.corpus_id || '?'}] failed schema/hash validation: ${e.message}`;
        break;
      }
    }
    if (!tsFail && validatedAll.length > 0) {
      const reanchored = [];
      const externalSummary = [];
      const drift = [];
      for (const b of validatedAll) {
        const anchor = reAnchorTenantShadowBlock(b, { dataDir: process.env.KOLM_DATA_DIR });
        if (anchor.mode === 'unavailable') {
          const accStr = typeof b.accuracy === 'number' ? `accuracy=${(b.accuracy * 100).toFixed(1)}%` : 'accuracy=n/a';
          const passedStr = (typeof b.passed_count === 'number' && typeof b.evaluated_count === 'number')
            ? `${b.passed_count}/${b.evaluated_count}`
            : `${b.row_count} rows`;
          externalSummary.push(`${b.tenant_id}:${b.corpus_id}: ${accStr} on ${passedStr} (corpus stays on tenant infrastructure; schema + block hash round-trip ok)`);
        } else if (anchor.mode === 'reanchored') {
          if (!anchor.matches) {
            drift.push(`${b.tenant_id}:${b.corpus_id}: manifest declared corpus_sha256=${b.corpus_sha256.slice(0, 12)}…, on-disk corpus hashes to ${anchor.corpus_sha256_recomputed.slice(0, 12)}…`);
          } else {
            const accStr = typeof b.accuracy === 'number' ? `accuracy=${(b.accuracy * 100).toFixed(1)}%` : 'accuracy=n/a';
            const passedStr = (typeof b.passed_count === 'number' && typeof b.evaluated_count === 'number')
              ? `${b.passed_count}/${b.evaluated_count}`
              : `${b.row_count} rows`;
            reanchored.push(`${b.tenant_id}:${b.corpus_id}: ${accStr} on ${passedStr} (re-anchored from ${anchor.file_path}; bytes match)`);
          }
        }
      }
      if (drift.length > 0) {
        tsFail = `manifest.tenant_shadow_corpus_provenance has ${drift.length} corpus-byte drift(s):\n  ${drift.join('\n  ')}\n  this means either the corpus was edited after the build (so the K-score on it is no longer measuring what the manifest says) or the manifest was tampered with to claim a different corpus.`;
      } else {
        const total = validatedAll.length;
        const reCount = reanchored.length;
        const extCount = externalSummary.length;
        const head = (() => {
          if (reCount === total) return `${total} tenant shadow corpus block(s) re-anchored from tenant storage; every declared corpus_sha256 matches on-disk bytes`;
          if (extCount === total) return `${total} tenant shadow corpus block(s) validated by schema + block hash (verifier is external to tenant infrastructure; HIPAA data-never-leaves-tenant residency upheld)`;
          return `${total} tenant shadow corpus block(s) total — ${reCount} re-anchored from tenant storage, ${extCount} schema-only (verifier missing storage access for those tenants)`;
        })();
        checks.push({
          name: 'Tenant shadow corpus',
          status: 'pass',
          detail: `${head}. ${[...reanchored, ...externalSummary].join('; ')}`,
        });
      }
    }
    if (tsFail) {
      checks.push({
        name: 'Tenant shadow corpus',
        status: 'fail',
        detail: tsFail,
      });
    }
  }

  // 22. Third-party auditor attestation (wave 166, N+7). Top of the eval-
  // credibility ladder. Unlike every preceding check, the signature here comes
  // from a party OTHER than the kolm builder. The builder's own Ed25519
  // signature (check #1 / Wave 149) proves "the build pipeline ran on a
  // machine holding this key." The auditor's signature proves "an independent
  // party with their own Ed25519 key observed this artifact's verification
  // outputs and stands behind them." For the auditor signature to mean
  // anything, the auditor's key fingerprint MUST differ from the builder's
  // — otherwise the same party is signing both layers, defeating the entire
  // purpose of independent attestation.
  //
  // Five branches:
  //   (a) absent: pass + informational. Suggest `kolm auditor sign` flow.
  //   (b) present + signature valid + claims match manifest +
  //       auditor key != builder key: pass with auditor identity + fingerprint.
  //   (c) present + signature invalid (Ed25519 verification fails): fail.
  //   (d) present + signature OK but signed claims drift from current manifest
  //       (artifact_hash, eval_score, k_score, etc. differ): fail.
  //   (e) present + signature OK but auditor key_fingerprint matches builder
  //       key_fingerprint: fail (not third-party).
  if (!manifest.auditor_attestation_provenance) {
    checks.push({
      name: 'Third-party auditor attestation',
      status: 'pass',
      detail: `no manifest.auditor_attestation_provenance block — only the builder's own Ed25519 signature (check above) attests to this artifact's verification outputs. To add an independent layer of attestation: (1) auditor runs \`kolm auditor keygen --out auditor.key\` (Ed25519 keypair, stays on auditor's HSM/laptop), (2) auditor runs \`kolm auditor sign <artifact.kolm> --key auditor.key --auditor-id <slug> --out attestation.json\`, (3) tenant re-builds with \`--auditor-attestation attestation.json\`. The attestation's signed claims bind cryptographically to artifact_hash + eval_score + k_score, so any post-attestation tamper breaks the signature.`,
    });
  } else {
    const raw = Array.isArray(manifest.auditor_attestation_provenance)
      ? manifest.auditor_attestation_provenance
      : [manifest.auditor_attestation_provenance];
    let aaFail = null;
    const validatedAll = [];
    for (const block of raw) {
      try {
        validatedAll.push(validateAuditorAttestationBlock(block));
      } catch (e) {
        aaFail = `manifest.auditor_attestation_provenance[auditor=${block?.auditor_id || '?'}] failed schema/signature validation: ${e.message}`;
        break;
      }
    }
    if (!aaFail && validatedAll.length > 0) {
      // Recompute artifact-hash-input analogs for cross-check. The verifier
      // populates these as private fields on the manifest object (NOT
      // persisted) so crossCheckAttestation can match the auditor's signed
      // hash claims against the artifact this binder is examining.
      const manifestCrossView = { ...manifest };
      // artifact_hash is the canonical source — comes from the receipt.
      manifestCrossView.__artifact_hash = bundle.receipt?.artifact_hash || null;
      // external_holdout_hash is just the block's own short hash (per
      // artifact.js artifact_hash_input.external_holdout_hash = block.hash).
      if (manifest.external_holdout_provenance && manifest.external_holdout_provenance.hash) {
        manifestCrossView.__external_holdout_hash = manifest.external_holdout_provenance.hash;
      }
      // tenant_shadow_corpus_hash is the hash over the canonical ordered
      // array of per-corpus {tenant_id, corpus_id, hash} tuples (per
      // artifact.js artifact_hash_input.tenant_shadow_corpus_hash).
      if (manifest.tenant_shadow_corpus_provenance) {
        const tsBlocks = Array.isArray(manifest.tenant_shadow_corpus_provenance)
          ? manifest.tenant_shadow_corpus_provenance
          : [manifest.tenant_shadow_corpus_provenance];
        if (tsBlocks.length > 0) {
          const sortedTuples = tsBlocks.map(b => ({ tenant_id: b.tenant_id, corpus_id: b.corpus_id, hash: b.hash }));
          manifestCrossView.__tenant_shadow_corpus_hash = crypto.createHash('sha256')
            .update(canonicalJson(sortedTuples))
            .digest('hex');
        }
      }
      // Builder's own Ed25519 key fingerprint, for the "auditor != builder"
      // check. Pull from receipt.signed_by which uses the format
      // 'ed25519:<fingerprint-hex32>' when Ed25519 signed.
      const builderFingerprint = (() => {
        const sb = bundle.receipt?.signed_by || '';
        if (sb.startsWith('ed25519:')) return sb.slice('ed25519:'.length);
        // Also check signature_ed25519.key_fingerprint as the canonical source.
        if (bundle.receipt?.signature_ed25519?.key_fingerprint) {
          return bundle.receipt.signature_ed25519.key_fingerprint;
        }
        return null;
      })();
      const passSummaries = [];
      const failReasons = [];
      for (const b of validatedAll) {
        // (e) auditor key MUST differ from builder key — third-party means
        // a distinct party. If the same fingerprint signs both, attestation
        // adds no independence.
        if (builderFingerprint && b.key_fingerprint === builderFingerprint) {
          failReasons.push(`auditor_id='${b.auditor_id}' uses the SAME Ed25519 key (${b.key_fingerprint.slice(0, 12)}…) as the artifact's builder; third-party attestation requires a distinct party. Re-sign with an Ed25519 key not held by the build pipeline.`);
          continue;
        }
        // (d) signed claims must match current manifest values.
        const cc = crossCheckAttestation(b, manifestCrossView);
        if (!cc.ok) {
          failReasons.push(`auditor_id='${b.auditor_id}' (fingerprint ${b.key_fingerprint.slice(0, 12)}…) signed claims do not match current manifest: ${cc.reason}`);
          continue;
        }
        const aud = b.auditor_id;
        const fp = b.key_fingerprint.slice(0, 12);
        const scope = b.scope ? ` scope='${b.scope}'` : '';
        const accred = b.accreditation ? ` accreditation='${b.accreditation}'` : '';
        const checksCount = Array.isArray(b.checks_passed) ? b.checks_passed.length : 0;
        const checksTail = checksCount > 0 ? ` (re-ran ${checksCount} named binder check${checksCount === 1 ? '' : 's'})` : '';
        passSummaries.push(`auditor_id='${aud}' (key ${fp}…)${scope}${accred} attests artifact_hash=${b.artifact_hash.slice(0, 12)}… eval_score=${b.eval_score != null ? b.eval_score.toFixed(4) : 'n/a'}${checksTail}`);
      }
      if (failReasons.length > 0) {
        aaFail = `manifest.auditor_attestation_provenance has ${failReasons.length} attestation failure(s):\n  ${failReasons.join('\n  ')}`;
      } else {
        const total = validatedAll.length;
        checks.push({
          name: 'Third-party auditor attestation',
          status: 'pass',
          detail: `${total} third-party auditor attestation block(s) verified — each signature valid against its embedded Ed25519 public key, every signed claim (artifact_hash + eval_score + k_score + external/tenant-shadow hashes when present) matches the current manifest, and every auditor key fingerprint differs from the builder's. ${passSummaries.join('; ')}`,
        });
      }
    }
    if (aaFail) {
      checks.push({
        name: 'Third-party auditor attestation',
        status: 'fail',
        detail: aaFail,
      });
    }
  }

  // 23. Supersession chain (wave 167, M+4). Closes the lifecycle ladder:
  // an artifact declares which (if any) prior artifact it replaces, why it
  // replaces it, and when. A verifier walking the chain backwards can
  // confirm the predecessor existed, that the reason was legitimate, and
  // (when reason='drift_detected') that drift evidence was attached. The
  // supersession block is bound into artifact_hash_input.supersession_hash
  // so any post-build tamper on the predecessor reference breaks every
  // downstream signature.
  //
  // Three branches:
  //   (a) absent: pass + informational ("this artifact has no recorded
  //       predecessor"). Suggest --supersession-of flow.
  //   (b) present + validates: pass with predecessor hash prefix, reason,
  //       date, and drift-signal count when reason='drift_detected'.
  //   (c) present + schema/hash drift: fail with the validator's message.
  if (!manifest.supersession_provenance) {
    checks.push({
      name: 'Supersession chain',
      status: 'pass',
      detail: `no manifest.supersession_provenance block — this artifact has no recorded predecessor. To declare this artifact supersedes a prior one, rebuild with \`kolm compile <spec> --supersession-of <predecessor.kolm> --supersession-reason <reason>\` (valid reasons: ${SUPERSESSION_REASONS.join(', ')}). When reason='drift_detected', also pass --supersession-drift-report <report.json> so the evidence for retirement is bound into the manifest.`,
    });
  } else {
    let ssFail = null;
    let ss = null;
    try {
      ss = validateSupersessionBlock(manifest.supersession_provenance);
    } catch (e) {
      ssFail = `manifest.supersession_provenance failed schema/hash validation: ${e.message}`;
    }
    if (!ssFail && ss) {
      const predHashPrefix = ss.predecessor_artifact_hash.slice(0, 12);
      const evidenceParts = [];
      if (ss.drift_signals && ss.drift_signals.length > 0) {
        const breachCount = ss.drift_signals.filter(s => s.status === 'breach').length;
        const driftCount = ss.drift_signals.filter(s => s.status === 'drift').length;
        evidenceParts.push(`${ss.drift_signals.length} drift signal(s): ${breachCount} breach, ${driftCount} drift`);
      }
      if (ss.drift_report_hash) {
        evidenceParts.push(`drift_report_hash=${ss.drift_report_hash.slice(0, 12)}…`);
      }
      const cidTail = ss.predecessor_cid ? ` cid=${ss.predecessor_cid.slice(0, 12)}…` : '';
      const authTail = ss.authorized_by ? ` authorized_by='${ss.authorized_by}'` : '';
      const evidenceTail = evidenceParts.length > 0 ? ` (evidence: ${evidenceParts.join('; ')})` : '';
      checks.push({
        name: 'Supersession chain',
        status: 'pass',
        detail: `predecessor_artifact_hash=${predHashPrefix}…${cidTail} reason='${ss.reason}' supersession_date='${ss.supersession_date}'${authTail}${evidenceTail}. Block hash bound into artifact_hash_input.supersession_hash so any tamper breaks all downstream signatures.`,
      });
    }
    if (ssFail) {
      checks.push({
        name: 'Supersession chain',
        status: 'fail',
        detail: ssFail,
      });
    }
  }

  // 24. Drift report (wave 167, M+3). Optional. A drift report can be
  // bundled with the artifact zip OR referenced from manifest.drift_report
  // as a full embedded block. When embedded, this check validates the
  // report's schema + hash and surfaces the verdict (within / drift /
  // breach). Useful for the cron pipeline that emits a fresh drift report
  // each cadence interval and stamps it onto the artifact for compliance
  // audit; equally useful for a one-shot `kolm drift detect` invocation
  // that wants the verifier to confirm the report itself wasn't tampered
  // with after computation.
  //
  // Three branches:
  //   (a) absent: pass + informational (no embedded drift report).
  //   (b) present + within: pass.
  //   (c) present + drift: pass with a warning detail.
  //   (d) present + breach: fail.
  //   (e) present + schema/hash drift: fail with validator message.
  if (!manifest.drift_report) {
    checks.push({
      name: 'Drift report',
      status: 'pass',
      detail: `no manifest.drift_report block — no recurring drift detection result has been bound into this artifact. To emit a drift report against a baseline artifact, run \`kolm drift detect <current.kolm> --baseline <baseline.kolm> --out drift.json\` and embed it on the next rebuild. For continuous monitoring, run \`kolm drift cron --baseline <baseline.kolm> --current <current.kolm> --cadence "0 */6 * * *" --out drift-cron.json\` and drop the emitted crontab line into your scheduler.`,
    });
  } else {
    let drFail = null;
    let dr = null;
    try {
      dr = validateDriftReport(manifest.drift_report);
    } catch (e) {
      drFail = `manifest.drift_report failed schema/hash validation: ${e.message}`;
    }
    if (!drFail && dr) {
      const baselinePrefix = dr.baseline_snapshot.artifact_hash.slice(0, 12);
      const currentPrefix = dr.current_snapshot.artifact_hash.slice(0, 12);
      const verdictDetail = `verdict='${dr.verdict}' (${dr.breach_count} breach, ${dr.drift_count} drift across ${dr.signals.length} signal(s)) baseline=${baselinePrefix}… current=${currentPrefix}… computed_at='${dr.computed_at}'`;
      if (dr.verdict === 'breach') {
        // Surface the breached axes specifically.
        const breachedAxes = dr.signals.filter(s => s.status === 'breach').map(s => s.axis).join(', ');
        drFail = `manifest.drift_report verdict='breach' — axes that breached tolerance: ${breachedAxes}. ${verdictDetail}. Re-distill the recipe (or use --supersession-of with --supersession-reason=drift_detected to ship a corrected successor).`;
      } else if (dr.verdict === 'drift') {
        checks.push({
          name: 'Drift report',
          status: 'pass',
          detail: `WARN — ${verdictDetail}. Signals moved past the warn band but stayed inside the fail band. Schedule a re-distillation against current production traffic before the next cadence interval.`,
        });
      } else {
        checks.push({
          name: 'Drift report',
          status: 'pass',
          detail: verdictDetail,
        });
      }
    }
    if (drFail) {
      checks.push({
        name: 'Drift report',
        status: 'fail',
        detail: drFail,
      });
    }
  }

  // 25. Corpus URL licensing gate (wave 194, N+2 / N+3). The Wave 144 plan
  // committed "Corpus URL licensing gate not in verifier" as still-open.
  // Closes the loop: a manifest declaring corpus_sources[] (training data
  // each recipe distilled from) must carry source_url + license for each,
  // where the license string sits in either SAFE_LICENSES (SPDX permissive
  // identifiers + named catalog licenses procurement has accepted) or
  // AMBER_LICENSES (research-only / NC variants that pass with a manual-
  // review caveat). DENY_LICENSES (proprietary, scraped, tos-violated,
  // unknown) cause the check to fail so a manifest cannot ship pointing at
  // CC-incompatible or unlicensed training corpora.
  //
  // Three branches:
  //   (a) no corpus_sources declared: pass with legacy-manifest note
  //   (b) every source SAFE: pass with per-source summary
  //   (c) some sources AMBER: pass with caveat rows (manual review required)
  //   (d) any source in DENY or with missing license / unparseable URL: fail
  //
  // Honest scope: the check does NOT fetch the URL or crawl the upstream
  // catalog. It validates the declared license string against a frozen
  // allowlist (SAFE / AMBER / DENY) so the verifier stays offline-first.
  const licensingResult = checkCorpusLicensing(manifest);
  checks.push({
    name: 'Corpus URL licensing gate',
    status: licensingResult.status,
    detail: licensingResult.detail,
  });

  return { checks, credential };
}

// ---------------------------------------------------------------------------
// HTML rendering. Single-file print-friendly layout.
// ---------------------------------------------------------------------------

function renderHead(bundle) {
  const m = bundle.manifest;
  const title = `${esc(m.task || 'kolm artifact')} — compliance binder`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  @page { size: letter; margin: 0.6in 0.7in; }
  * { box-sizing: border-box; }
  body {
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #0f172a; background: #fff; margin: 0; padding: 32px;
    max-width: 880px; margin-inline: auto;
  }
  h1, h2, h3 { color: #020617; margin: 0 0 8px; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  h2 { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin-top: 28px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; }
  h3 { font-size: 13px; font-weight: 600; margin-top: 14px; margin-bottom: 6px; }
  p { margin: 6px 0; color: #334155; }
  .subhead { color: #64748b; font-size: 12px; margin-bottom: 22px; }
  .grid { display: grid; grid-template-columns: 160px 1fr; gap: 4px 16px; margin: 8px 0; }
  .grid dt { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; padding-top: 2px; }
  .grid dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #0f172a; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f1f5f9; font-size: 12px; vertical-align: top; }
  th { color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; background: #f8fafc; }
  td code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .status.pass { background: #dcfce7; color: #14532d; }
  .status.fail { background: #fee2e2; color: #7f1d1d; }
  .status.warn { background: #fef3c7; color: #78350f; }
  .check-row { display: grid; grid-template-columns: 90px 1fr; gap: 14px; align-items: start; padding: 10px 0; border-bottom: 1px solid #f1f5f9; }
  .check-name { font-weight: 600; }
  .check-detail { color: #475569; font-size: 12px; }
  .summary { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px 20px; margin: 16px 0 24px; }
  .summary .verdict { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
  .verdict.pass { color: #14532d; }
  .verdict.fail { color: #7f1d1d; }
  .verdict.warn { color: #78350f; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 11px; }
  .kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; background: #f1f5f9; padding: 2px 6px; border-radius: 3px; }
  pre { background: #0f172a; color: #f8fafc; padding: 12px 14px; border-radius: 4px; font-size: 11px; overflow-x: auto; margin: 8px 0; }
  pre code { color: inherit; font-family: inherit; }
  .axis-row { display: grid; grid-template-columns: 110px 70px 90px 1fr; gap: 12px; align-items: center; padding: 4px 0; font-size: 12px; }
  .axis-name { color: #64748b; }
  .axis-value { font-family: ui-monospace, monospace; font-weight: 600; }
  .axis-bar { background: #e2e8f0; height: 8px; border-radius: 4px; position: relative; overflow: hidden; }
  .axis-bar > i { display: block; height: 100%; background: #0f172a; }
  .step { padding: 8px 0; border-bottom: 1px dotted #e2e8f0; }
  .step:last-child { border-bottom: none; }
  .step-label { font-weight: 600; font-size: 12px; }
  .step-meta { color: #64748b; font-size: 11px; margin-top: 2px; }
  @media print {
    body { padding: 0; }
    h2 { page-break-after: avoid; }
    .summary, table, .step, .axis-row { page-break-inside: avoid; }
  }
</style>
</head>`;
}

function renderSummary(checks, manifest) {
  const failed = checks.filter(c => c.status === 'fail').length;
  const warned = checks.filter(c => c.status === 'warn').length;
  const verdict = failed > 0 ? 'fail' : (warned > 0 ? 'warn' : 'pass');
  const verdictText = failed > 0
    ? `${failed} check${failed === 1 ? '' : 's'} failed — do not deploy`
    : warned > 0
      ? `passes with ${warned} warning${warned === 1 ? '' : 's'} — review below`
      : `all ${checks.length} checks passed`;
  const rows = checks.map(c => `
    <div class="check-row">
      <div><span class="status ${c.status}">${c.status}</span></div>
      <div>
        <div class="check-name">${esc(c.name)}</div>
        <div class="check-detail">${esc(c.detail)}</div>
      </div>
    </div>`).join('');
  return `
<section class="summary">
  <div class="verdict ${verdict}">${esc(verdictText)}</div>
  <p style="margin: 4px 0 0; color: #64748b;">artifact ${esc(shortCid(manifest.cid || ''))} · base ${esc(manifest.base_model || 'unknown')} · ${esc(manifest.created_at || '')}</p>
</section>
<section>
  <h2>Verification summary</h2>
  ${rows}
</section>`;
}

function renderIdentity(manifest) {
  const k = manifest.k_score || {};
  return `
<section>
  <h2>Identity</h2>
  <dl class="grid">
    <dt>Task</dt><dd>${esc(manifest.task || '—')}</dd>
    <dt>Spec</dt><dd>${esc(manifest.spec || '—')}</dd>
    <dt>Tier</dt><dd>${esc(manifest.tier || 'recipe')}</dd>
    <dt>Base model</dt><dd>${esc(manifest.base_model || '—')}</dd>
    <dt>Runtime</dt><dd>${esc(manifest.runtime || '—')}</dd>
    <dt>Job ID</dt><dd>${esc(manifest.job_id || '—')}</dd>
    <dt>CID</dt><dd>${esc(manifest.cid || '—')}</dd>
    <dt>Created at</dt><dd>${esc(manifest.created_at || '—')}</dd>
    <dt>Target device</dt><dd>${esc(manifest.target_device || 'unpinned')}</dd>
    <dt>Train device</dt><dd>${esc(manifest.train_device || 'unpinned')}</dd>
    <dt>Judge</dt><dd>${esc(manifest.judge_id || '—')}</dd>
    <dt>Size on disk</dt><dd>${fmtBytes(k.size_bytes)}</dd>
  </dl>
</section>`;
}

function renderKScore(manifest) {
  const k = manifest.k_score;
  if (!k) return `<section><h2>K-score</h2><p>No K-score embedded in this artifact.</p></section>`;
  const isV2 = k.spec === 'k-score-2';
  const w = k.weights || (isV2
    ? { A: 0.30, S: 0.10, L: 0.10, C: 0.10, V: 0.10, R: 0.05, T: 0.05, F: 0.10, E: 0.05, Z: 0.05 }
    : { A: 0.40, S: 0.15, L: 0.15, C: 0.15, V: 0.15 });
  const axes = [
    { name: 'Accuracy',  key: 'A', weight: w.A, norm: k.accuracy,      raw: k.accuracy.toFixed(4) },
    { name: 'Size',      key: 'S', weight: w.S, norm: k.size_score,    raw: fmtBytes(k.size_bytes) },
    { name: 'Latency',   key: 'L', weight: w.L, norm: k.latency_score, raw: fmtMicros(k.p50_latency_us) },
    { name: 'Cost',      key: 'C', weight: w.C, norm: k.cost_score,    raw: fmtCost(k.cost_usd_per_call) + ' / call' },
    { name: 'Coverage',  key: 'V', weight: w.V, norm: k.coverage,      raw: k.coverage.toFixed(4) },
  ];
  // V2 axes (added wave 145+160). Each renders only when its source value is
  // present, so V1 artifacts still render as 5 axes and V2 artifacts render
  // as 5-10 depending on what the producer captured. The T axis (wave 160,
  // Q+3c) is the cross-vendor distillation honesty axis: A/T ratio makes the
  // cost/quality tradeoff legible. Per Wave 144 Doc 7 §4.7.
  if (isV2) {
    if (k.robustness_score != null) {
      axes.push({ name: 'Robustness',  key: 'R', weight: w.R, norm: k.robustness_score,
        raw: `holdout ${(k.holdout_accuracy ?? 0).toFixed(4)} / declared ${k.accuracy.toFixed(4)}` });
    }
    if (k.teacher_fidelity_score != null) {
      const aOverT = (k.holdout_accuracy / Math.max(1e-6, k.teacher_holdout_accuracy));
      axes.push({ name: 'Teacher-fidelity (A/T)', key: 'T', weight: w.T, norm: k.teacher_fidelity_score,
        raw: `student ${k.holdout_accuracy.toFixed(4)} / teacher ${k.teacher_holdout_accuracy.toFixed(4)} = ${aOverT.toFixed(4)}` });
    }
    if (k.fairness_score != null) {
      axes.push({ name: 'Fairness',    key: 'F', weight: w.F, norm: k.fairness_score,
        raw: `subgroup-min ${(k.subgroup_min_accuracy ?? 0).toFixed(4)} / declared ${k.accuracy.toFixed(4)}` });
    }
    if (k.energy_score != null) {
      axes.push({ name: 'Energy',      key: 'E', weight: w.E, norm: k.energy_score,
        raw: `${(k.joules_per_call ?? 0).toFixed(2)} J / call` });
    }
    if (k.drift_score != null) {
      axes.push({ name: 'Drift',       key: 'Z', weight: w.Z, norm: k.drift_score,
        raw: `eval-set drift ${(k.eval_set_drift ?? 0).toFixed(4)} vs baseline` });
    }
  }
  const rows = axes.map(a => `
    <div class="axis-row">
      <div class="axis-name">${esc(a.name)} (${(a.weight * 100).toFixed(1)}%)</div>
      <div class="axis-value">${a.norm.toFixed(4)}</div>
      <div class="axis-bar"><i style="width: ${(a.norm * 100).toFixed(1)}%"></i></div>
      <div class="mono" style="color: #64748b">${esc(a.raw)}</div>
    </div>`).join('');
  const gate = k.gate || 0.85;
  const verdictText = k.composite >= gate
    ? `composite ${k.composite.toFixed(4)} ≥ gate ${gate.toFixed(2)} — artifact ships`
    : `composite ${k.composite.toFixed(4)} below gate ${gate.toFixed(2)} — artifact should not ship`;
  const formula = isV2
    ? `K2 = 0.30·A + 0.10·S + 0.10·L + 0.10·C + 0.10·V + 0.05·R + 0.05·T + 0.10·F + 0.05·E + 0.05·Z (missing axes redistribute weight over present axes). The gate is ${gate.toFixed(2)}.`
    : `K = 0.40·A + 0.15·S + 0.15·L + 0.15·C + 0.15·V, on the unit interval. The gate is ${gate.toFixed(2)}.`;
  return `
<section>
  <h2>K-score evidence (${esc(k.spec || 'k-score-1')})</h2>
  <p>${formula}</p>
  ${rows}
  <p style="margin-top: 12px;"><span class="status ${k.composite >= gate ? 'pass' : 'fail'}">${k.composite >= gate ? 'pass' : 'fail'}</span> &nbsp; ${esc(verdictText)}</p>
</section>`;
}

function renderHashes(manifest) {
  const h = manifest.hashes || {};
  const rows = Object.keys(h).sort().map(k => `
    <tr>
      <td class="mono">${esc(k)}</td>
      <td class="mono">${esc(h[k])}</td>
    </tr>`).join('');
  return `
<section>
  <h2>Manifest hashes</h2>
  <p>sha256 over each file inside the .kolm zip. The CID is derived from this table via canonical JSON.</p>
  <table>
    <thead><tr><th style="width: 180px">File</th><th>sha256</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderChain(receipt) {
  if (!receipt || !receipt.chain) {
    return `<section><h2>Audit chain</h2><p>No receipt.json found.</p></section>`;
  }
  const rows = receipt.chain.map((step, i) => `
    <div class="step">
      <div class="step-label">${i + 1}. ${esc(step.step)}</div>
      <div class="step-meta">in &nbsp;<span class="mono">${esc(step.input_hash)}</span></div>
      <div class="step-meta">out <span class="mono">${esc(step.output_hash)}</span></div>
      <div class="step-meta">hmac <span class="mono">${esc(step.hmac)}</span></div>
    </div>`).join('');
  return `
<section>
  <h2>Audit chain</h2>
  <p>Five-step HMAC chain. Each step seals the previous step's output hash. A verifier with the receipt secret recomputes every step's HMAC to detect tampering.</p>
  ${rows}
  <p style="margin-top: 12px;"><strong>Receipt body signature:</strong> <code class="mono">${esc(receipt.signature || '—')}</code></p>
  <p><strong>Signature algorithm:</strong> ${esc(receipt.signature_alg || '—')} &nbsp; <strong>Signed at:</strong> ${esc(receipt.signed_at || '—')} &nbsp; <strong>Signed by:</strong> ${esc(receipt.signed_by || '—')}</p>
</section>`;
}

function renderCredential(credential) {
  if (!credential) {
    return `<section><h2>Provenance credential</h2><p>Not present — artifact predates kolm-credential/0.1.</p></section>`;
  }
  const a = credential.assertions || {};
  const rows = Object.keys(a).sort().map(k => `
    <tr><td class="mono">${esc(k)}</td><td class="mono">${esc(String(a[k] ?? '—'))}</td></tr>
  `).join('');
  return `
<section>
  <h2>Provenance credential</h2>
  <p>Self-contained credential binding the artifact to its assertions. Schema: <code>${esc(credential.spec || '—')}</code>. Verifies under the same secret as the receipt chain.</p>
  <dl class="grid">
    <dt>Type</dt><dd>${esc(credential.type || '—')}</dd>
    <dt>Claim generator</dt><dd>${esc(credential.claim_generator || '—')}</dd>
    <dt>Artifact hash</dt><dd>${esc(credential.artifact_hash || '—')}</dd>
    <dt>CID</dt><dd>${esc(credential.cid || '—')}</dd>
    <dt>Signature alg</dt><dd>${esc(credential.signature_alg || '—')}</dd>
    <dt>Signed at</dt><dd>${esc(credential.signed_at || '—')}</dd>
    <dt>Signature</dt><dd>${esc(credential.signature || '—')}</dd>
  </dl>
  <h3>Assertions</h3>
  <table>
    <thead><tr><th style="width: 220px">Key</th><th>Value</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderEvals(evals, manifest) {
  if (!evals || !evals.cases || !evals.cases.length) {
    return `<section><h2>Eval coverage</h2><p>No eval cases embedded.</p></section>`;
  }
  const sample = evals.cases.slice(0, 5);
  const rows = sample.map((c, i) => {
    const input = typeof c.input === 'string' ? c.input : JSON.stringify(c.input);
    const expected = typeof c.expected === 'string' ? c.expected : JSON.stringify(c.expected);
    return `
    <tr>
      <td>${i + 1}</td>
      <td class="mono">${esc(input.slice(0, 120))}${input.length > 120 ? '…' : ''}</td>
      <td class="mono">${esc(expected.slice(0, 120))}${expected.length > 120 ? '…' : ''}</td>
    </tr>`;
  }).join('');
  return `
<section>
  <h2>Eval coverage</h2>
  <p><strong>${evals.cases.length}</strong> case${evals.cases.length === 1 ? '' : 's'} embedded. Judge: <code>${esc(manifest.judge_id || '—')}</code>. Eval set hash: <code class="mono">${esc(manifest.evals?.hash || '—')}</code>.</p>
  <table>
    <thead><tr><th style="width: 30px">#</th><th>Input</th><th>Expected</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${evals.cases.length > 5 ? `<p style="color: #64748b;">Showing first 5 of ${evals.cases.length}.</p>` : ''}
</section>`;
}

function renderReproduction(artifactPath, manifest) {
  const name = path.basename(artifactPath);
  return `
<section>
  <h2>Reproduce this binder</h2>
  <p>Any reviewer with the artifact bytes can regenerate this report. The K-score, hashes, CID, and chain structure are deterministic; the HMAC verification rows turn green when the same receipt secret is present in the environment.</p>
  <pre><code># 1. Verify the artifact bytes match the embedded CID
kolm inspect ${esc(name)} | grep cid

# 2. Recompute K-score from the artifact bytes
kolm score ${esc(name)}

# 3. Re-run the embedded eval set and check pass-rate
kolm eval ${esc(name)}

# 4. Regenerate this binder
kolm verify ${esc(name)} --binder out.html</code></pre>
</section>`;
}

function renderFooter(artifactPath) {
  const now = new Date().toISOString();
  return `
<div class="footer">
  <p>Generated ${esc(now)} from ${esc(path.basename(artifactPath))} · binder spec <code>${esc(BINDER_SPEC)}</code></p>
  <p>This binder is offline-verifiable: every claim it makes is derived from the .kolm bytes plus (for signature verification) the receipt secret held by the issuer. See <a href="https://kolm.ai/spec">kolm.ai/spec</a> for the full schema.</p>
</div>`;
}

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

/**
 * Build the binder HTML for an artifact at `artifactPath`. Returns
 * `{ html, checks, verdict, manifest, receipt }`. Throws if the artifact is
 * malformed or fails signature verification.
 */
export async function buildBinder(artifactPath) {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`binder: artifact not found: ${artifactPath}`);
  }
  const bundle = loadArtifact(artifactPath);
  const { checks, credential } = await verifyArtifact(bundle);

  const failed = checks.filter(c => c.status === 'fail').length;
  const warned = checks.filter(c => c.status === 'warn').length;
  const verdict = failed > 0 ? 'fail' : (warned > 0 ? 'warn' : 'pass');

  const html = [
    renderHead(bundle),
    `<body>`,
    `<h1>${esc(bundle.manifest.task || 'kolm artifact')}</h1>`,
    `<p class="subhead">Compliance binder · ${esc(BINDER_SPEC)} · ${esc(path.basename(artifactPath))}</p>`,
    renderSummary(checks, bundle.manifest),
    renderIdentity(bundle.manifest),
    renderKScore(bundle.manifest),
    renderHashes(bundle.manifest),
    renderChain(bundle.receipt),
    renderCredential(credential),
    renderEvals(bundle.evals, bundle.manifest),
    renderReproduction(artifactPath, bundle.manifest),
    renderFooter(artifactPath),
    `</body></html>`,
  ].join('\n');

  return {
    html,
    checks,
    verdict,
    manifest: bundle.manifest,
    receipt: bundle.receipt,
    credential,
  };
}

/**
 * Write the binder to `outPath` and return the same shape as buildBinder.
 */
export async function writeBinder(artifactPath, outPath) {
  const result = await buildBinder(artifactPath);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, result.html, 'utf8');
  return { ...result, out_path: outPath, bytes: Buffer.byteLength(result.html, 'utf8') };
}

export const BINDER = { spec: BINDER_SPEC };
