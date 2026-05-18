// src/keys.js
//
// Wave 193: `kolm keys` rotation lifecycle backend. Builds directly on the
// Ed25519 primitive shipped in src/ed25519.js (Wave H + Wave 149) and the
// public-key directory shipped in src/pubkey-directory.js (Wave 149). This
// module supplies the rotation receipt + KMS export intent shapes the CLI
// `kolm keys list | rotate | fingerprint | export` verb wraps.
//
// Air-gap-first contract:
//   * rotateKey({oldKeyId, kmsTarget, overlapDays}) always succeeds offline:
//     it generates a fresh Ed25519 keypair, writes the new private PEM to
//     disk when kmsTarget === 'local', and returns a rotation manifest that
//     the customer's KMS hook applies. kolm itself never calls AWS / GCP /
//     Azure / Vault. The wrap intent block records what kolm WOULD pass to
//     the named KMS so the customer's wrapper script can act on the receipt
//     without re-deriving anything.
//   * listKeys({path}) reads the on-disk store and returns active +
//     rotated + retired entries. Works fully offline.
//   * 30-day overlap window default matches NIST SP 800-57 Part 1 Rev 5
//     recommendation for high-assurance signing keys; customer can override.
//
// What this module does NOT do:
//   * does not call any KMS API (aws-sdk, @google-cloud/kms, @azure/keyvault,
//     node-vault). Those are operator-side concerns. The kmsTarget enum is
//     bound to a concrete `api_status` flag in the returned manifest
//     ('applied' for local; 'awaiting_operator_hook' for hosted KMS) so a
//     verifier can confirm whether the wrap intent has been acted on.
//   * does not pick the cadence. Customer's compliance officer picks the
//     overlap window; this module records what was picked.
//   * does not register the new public key with the directory. That is the
//     proof-of-control challenge in src/pubkey-directory.js. The CLI verb
//     calls that challenge separately after the new key is on disk.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateKeyPair,
  keyFingerprint,
} from './ed25519.js';

// ---------------------------------------------------------------------------
// Constants the CLI + tests reference directly so changes here surface as
// test diffs rather than silent behavior shifts.
// ---------------------------------------------------------------------------
export const KMS_TARGETS = ['aws-kms', 'gcp-kms', 'azure-keyvault', 'vault', 'local'];
export const DEFAULT_OVERLAP_DAYS = 30;
// Hosted-KMS api_status: 'awaiting_operator_hook' (kolm emitted the wrap intent;
// customer's KMS hook has not yet pushed the key to the named KMS).
// Local: 'applied' (key is on disk; nothing further to do).
export const KMS_API_STATUS_AWAITING_HOOK = 'awaiting_operator_hook';
// Back-compat alias so older callers that imported KMS_API_STATUS_NOT_WIRED
// keep resolving to the same value. New callers should use the renamed const.
export const KMS_API_STATUS_NOT_WIRED = KMS_API_STATUS_AWAITING_HOOK;
export const KEY_STATUSES = ['active', 'rotated', 'retired'];

// Per-target import format hint. The customer KMS hook reads this to know
// which native import API to call.
const KMS_IMPORT_FORMAT = {
  'aws-kms':        'pkcs8-pem',
  'gcp-kms':        'pkcs8-pem',
  'azure-keyvault': 'pkcs8-pem',
  'vault':          'pkcs8-pem-transit-import',
  'local':          'pkcs8-pem-on-disk',
};

const KMS_NATIVE_API = {
  'aws-kms':        'aws kms import-key-material',
  'gcp-kms':        'gcloud kms keys versions import',
  'azure-keyvault': 'az keyvault key import',
  'vault':          'vault write transit/keys/<name>/import',
  'local':          'fs.writeFileSync(<path>, pem, {mode: 0o600})',
};

function defaultStoreDir() {
  return process.env.KOLM_ED25519_KEY_STORE || path.join(os.homedir(), '.kolm');
}

function defaultStateFile(dir) {
  return path.join(dir || defaultStoreDir(), 'keys-state.json');
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return { keys: [] };
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { keys: [] };
    if (!Array.isArray(parsed.keys)) parsed.keys = [];
    return parsed;
  } catch {
    return { keys: [] };
  }
}

function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// listKeys({path})
//
// Returns array of {key_fingerprint, created_at, status} entries from the
// on-disk state file. Empty array when no state file exists yet (fresh
// install, no rotation ever run).
// ---------------------------------------------------------------------------
export function listKeys(opts = {}) {
  const dir = opts.path || defaultStoreDir();
  const stateFile = defaultStateFile(dir);
  const state = loadState(stateFile);
  return state.keys.map((k) => ({
    key_fingerprint: k.key_fingerprint,
    created_at: k.created_at,
    status: k.status,
    rotated_at: k.rotated_at || null,
    overlap_until: k.overlap_until || null,
    kms_target: k.kms_target || null,
  }));
}

// ---------------------------------------------------------------------------
// rotateKey({oldKeyId, kmsTarget, overlapDays, storeDir})
//
// Generates a fresh Ed25519 keypair and returns a rotation manifest. When
// kmsTarget === 'local' the new private PEM is written to disk at
// <storeDir>/<new_fingerprint>.pem (mode 0600). When kmsTarget is one of
// the four hosted KMS slugs the private PEM is returned in-memory only so
// the customer's KMS wrap hook can pass it to the native KMS import API.
//
// Manifest fields (all 5 always present):
//   old_key_fingerprint  prior active key fingerprint (or null if first ever)
//   new_key_fingerprint  freshly generated key fingerprint
//   rotated_at           ISO8601 timestamp
//   overlap_until        ISO8601 timestamp = rotated_at + overlapDays
//   kms_target           one of KMS_TARGETS
//
// Plus a wrap_intent block recording what kolm would pass to the KMS:
//   kms_target, import_format, native_api, api_status, new_key_path (when local)
//
// `api_status` is 'awaiting_operator_hook' for hosted KMS targets. kolm
// emits the rotation receipt; the customer wires the KMS hook to act on it.
// ---------------------------------------------------------------------------
export function rotateKey(opts = {}) {
  const kmsTarget = opts.kmsTarget || 'local';
  if (!KMS_TARGETS.includes(kmsTarget)) {
    throw new Error(`keys.rotateKey: kmsTarget must be one of [${KMS_TARGETS.join(', ')}]; got ${kmsTarget}`);
  }
  const overlapDays = Number.isFinite(opts.overlapDays) ? opts.overlapDays : DEFAULT_OVERLAP_DAYS;
  if (overlapDays < 0) {
    throw new Error(`keys.rotateKey: overlapDays must be >= 0; got ${overlapDays}`);
  }
  const dir = opts.storeDir || defaultStoreDir();
  const stateFile = defaultStateFile(dir);

  const oldKeyId = opts.oldKeyId || null;
  const { publicKey, privateKey } = generateKeyPair();
  const newFingerprint = keyFingerprint(publicKey);
  const rotatedAt = new Date().toISOString();
  const overlapUntil = new Date(Date.now() + overlapDays * 24 * 60 * 60 * 1000).toISOString();

  // Write new key to disk only when kmsTarget === 'local'. Hosted KMS targets
  // return the PEM in-memory; the customer's wrap hook is responsible for
  // pushing it into AWS / GCP / Azure / Vault and then shredding the buffer.
  let newKeyPath = null;
  if (kmsTarget === 'local') {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    newKeyPath = path.join(dir, `${newFingerprint}.pem`);
    fs.writeFileSync(newKeyPath, privateKey, { mode: 0o600 });
  }

  // Update on-disk state: mark old key as rotated, add new key as active.
  const state = loadState(stateFile);
  for (const k of state.keys) {
    if (oldKeyId && k.key_fingerprint === oldKeyId && k.status === 'active') {
      k.status = 'rotated';
      k.rotated_at = rotatedAt;
      k.overlap_until = overlapUntil;
    } else if (!oldKeyId && k.status === 'active') {
      // No explicit oldKeyId: mark whatever was active as rotated.
      k.status = 'rotated';
      k.rotated_at = rotatedAt;
      k.overlap_until = overlapUntil;
    }
  }
  state.keys.push({
    key_fingerprint: newFingerprint,
    created_at: rotatedAt,
    status: 'active',
    kms_target: kmsTarget,
  });
  saveState(stateFile, state);

  const manifest = {
    old_key_fingerprint: oldKeyId,
    new_key_fingerprint: newFingerprint,
    rotated_at: rotatedAt,
    overlap_until: overlapUntil,
    kms_target: kmsTarget,
    overlap_days: overlapDays,
    wrap_intent: {
      kms_target: kmsTarget,
      import_format: KMS_IMPORT_FORMAT[kmsTarget],
      native_api: KMS_NATIVE_API[kmsTarget],
      api_status: kmsTarget === 'local' ? 'applied' : KMS_API_STATUS_AWAITING_HOOK,
      new_key_path: newKeyPath,
    },
    honest_scope: 'kolm emits rotation receipt; customer KMS hook applies the wrapping',
    // Public key is safe to include in the manifest; the private PEM is only
    // returned via the in-memory `private_key_pem` field for the caller to
    // act on (CLI passes it to the KMS wrap script).
    new_public_key: publicKey,
    // private_key_pem is omitted from the receipt-chain serialization by the
    // CLI; it is only present in the in-memory object the CLI receives.
    private_key_pem: privateKey,
  };
  return manifest;
}

// ---------------------------------------------------------------------------
// exportKmsIntent({kmsTarget, fingerprint, storeDir})
//
// Returns a wrap-intent JSON block describing how a customer KMS hook
// should import the active signing key into the named KMS. Does not actually
// call the KMS. The block is consumed by the customer's wrap script (e.g.
// `kolm keys export --kms=aws-kms | jq ... | aws kms import-key-material ...`).
// ---------------------------------------------------------------------------
export function exportKmsIntent(opts = {}) {
  const kmsTarget = opts.kmsTarget;
  if (!KMS_TARGETS.includes(kmsTarget)) {
    throw new Error(`keys.exportKmsIntent: kmsTarget must be one of [${KMS_TARGETS.join(', ')}]; got ${kmsTarget}`);
  }
  return {
    kms_target: kmsTarget,
    import_format: KMS_IMPORT_FORMAT[kmsTarget],
    native_api: KMS_NATIVE_API[kmsTarget],
    api_status: kmsTarget === 'local' ? 'applied' : KMS_API_STATUS_NOT_WIRED,
    key_fingerprint: opts.fingerprint || null,
    honest_scope: 'kolm emits export intent; customer KMS hook performs the import',
  };
}

// ---------------------------------------------------------------------------
// activeFingerprint({storeDir})
//
// Returns the fingerprint of the currently active key, or null when no key
// has been rotated in (CLI falls back to the legacy ~/.kolm/signing-key.pem
// in that case so behavior is unchanged for users who never rotate).
// ---------------------------------------------------------------------------
export function activeFingerprint(opts = {}) {
  const dir = opts.storeDir || defaultStoreDir();
  const stateFile = defaultStateFile(dir);
  const state = loadState(stateFile);
  for (const k of state.keys) {
    if (k.status === 'active') return k.key_fingerprint;
  }
  return null;
}
