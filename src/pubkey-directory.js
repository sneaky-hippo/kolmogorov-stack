// src/pubkey-directory.js
//
// Wave 149 — Public-key directory for Ed25519 receipt signing keys.
//
// The Wave 144 plan §Q+8 demanded a third-party-verifiable signature scheme.
// `src/ed25519.js` (Wave H) provides the asymmetric primitive; this module is
// the discovery layer. When a tenant publishes a receipt signed with their
// Ed25519 private key, a verifier needs to look up the matching public key by
// fingerprint. This directory is that lookup.
//
// Storage layout: file-backed JSON map keyed by hex SHA-256 fingerprint of
// the SPKI DER bytes (matching `ed25519.keyFingerprint`).
//
//   {
//     "<fingerprint-32-hex>": {
//       fingerprint:      "<full 64-hex sha256 of DER>",
//       short_fingerprint:"<first 32 hex chars — what receipts carry>",
//       alg:              "ed25519",
//       public_key:       "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
//       label:            "tenant-friendly name",
//       tenant_id:        "<owning tenant; null for org-global>",
//       registered_at:    "<ISO8601>",
//       challenge_id:     "<sha256 of the proof-of-control challenge>"
//     }
//   }
//
// Registration is gated by a proof-of-control challenge: the caller signs a
// server-issued nonce with the private key, and the server only accepts the
// public key after verifying the signature. This prevents anyone from
// registering arbitrary public keys against a tenant they don't control.
//
// File path defaults to data/keys-public.json (gitignored by convention).
// Override with KOLM_PUBKEY_DIRECTORY_FILE.
//
// The directory is intentionally additive: existing HMAC-only artifacts work
// without any key registered, and Ed25519 verification falls back to the
// embedded public key in `signature_ed25519` if the directory lookup is
// absent. The directory is the long-term authority — embedded keys can be
// trusted on first use but a tenant who rotates their key publishes the new
// fingerprint here, and the verifier prefers the directory's answer.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { keyFingerprint, verify as edVerify } from './ed25519.js';

const DEFAULT_FILE = path.join(process.cwd(), 'data', 'keys-public.json');
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function storePath() {
  return process.env.KOLM_PUBKEY_DIRECTORY_FILE || DEFAULT_FILE;
}

// Lazy-init store from disk. Returns a mutable object that callers can mutate
// and pass back to persist().
function loadStore() {
  const p = storePath();
  if (!fs.existsSync(p)) return { keys: {}, challenges: {} };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { keys: {}, challenges: {} };
    if (!parsed.keys || typeof parsed.keys !== 'object') parsed.keys = {};
    if (!parsed.challenges || typeof parsed.challenges !== 'object') parsed.challenges = {};
    return parsed;
  } catch (e) {
    // Corrupt file — start fresh rather than locking out registration. The
    // old file is renamed with .corrupt suffix so the operator can recover.
    try { fs.renameSync(p, p + '.corrupt.' + Date.now()); } catch { /* swallow */ }
    return { keys: {}, challenges: {} };
  }
}

function persist(store) {
  const p = storePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(store, null, 2));
  } catch (e) {
    throw new Error(`pubkey-directory.persist: cannot write ${p}: ${e.message}`);
  }
}

function pruneChallenges(store) {
  const now = Date.now();
  for (const [id, ch] of Object.entries(store.challenges || {})) {
    if (!ch || !ch.expires_at_ms || ch.expires_at_ms < now) delete store.challenges[id];
  }
}

// ---------------------------------------------------------------------------
// listKeys — return all registered public keys. Suitable for GET
// /v1/keys/public. Strips sensitive fields (challenge_id) for the public
// listing.
// ---------------------------------------------------------------------------
export function listKeys() {
  const store = loadStore();
  return Object.values(store.keys || {}).map(k => ({
    fingerprint: k.fingerprint,
    short_fingerprint: k.short_fingerprint,
    alg: k.alg,
    public_key: k.public_key,
    label: k.label || null,
    tenant_id: k.tenant_id || null,
    registered_at: k.registered_at,
  }));
}

// ---------------------------------------------------------------------------
// getKey — fetch a single key by its short fingerprint (the 32-hex prefix
// receipts carry). Returns null when not found.
// ---------------------------------------------------------------------------
export function getKey(shortFingerprint) {
  if (typeof shortFingerprint !== 'string' || !/^[0-9a-f]{8,64}$/i.test(shortFingerprint)) return null;
  const store = loadStore();
  const norm = shortFingerprint.toLowerCase();
  const entry = store.keys[norm]
    || Object.values(store.keys).find(k => (k.fingerprint || '').toLowerCase().startsWith(norm))
    || null;
  if (!entry) return null;
  return {
    fingerprint: entry.fingerprint,
    short_fingerprint: entry.short_fingerprint,
    alg: entry.alg,
    public_key: entry.public_key,
    label: entry.label || null,
    tenant_id: entry.tenant_id || null,
    registered_at: entry.registered_at,
  };
}

// ---------------------------------------------------------------------------
// issueChallenge — create a server-side nonce the caller must sign with the
// private key matching the public key they want to register. Returns
// { challenge_id, nonce, expires_at } — the caller signs `nonce` (utf8
// bytes) with Ed25519 and submits { challenge_id, public_key, signature }
// to registerKey().
// ---------------------------------------------------------------------------
export function issueChallenge({ tenant_id = null, label = null } = {}) {
  const store = loadStore();
  pruneChallenges(store);
  const nonce = crypto.randomBytes(32).toString('hex');
  const challenge_id = crypto.createHash('sha256').update(nonce).digest('hex');
  const issued_at = new Date().toISOString();
  const expires_at_ms = Date.now() + CHALLENGE_TTL_MS;
  store.challenges[challenge_id] = {
    challenge_id, nonce, tenant_id, label, issued_at, expires_at_ms,
  };
  persist(store);
  return { challenge_id, nonce, expires_at: new Date(expires_at_ms).toISOString() };
}

// ---------------------------------------------------------------------------
// registerKey — validate the signed challenge and persist the public key.
// On success returns the stored entry; on failure throws with a clear
// reason. The verifier never has to trust this directory blindly — every
// stored entry was proved by a signature over a server-issued nonce.
// ---------------------------------------------------------------------------
export function registerKey({ challenge_id, public_key, signature, label = null, tenant_id = null }) {
  if (typeof challenge_id !== 'string' || !challenge_id) {
    throw new Error('registerKey: challenge_id required');
  }
  if (typeof public_key !== 'string' || !public_key.includes('BEGIN PUBLIC KEY')) {
    throw new Error('registerKey: public_key must be a PEM-encoded Ed25519 SPKI key');
  }
  if (typeof signature !== 'string' || !signature) {
    throw new Error('registerKey: signature required (base64url over the challenge nonce)');
  }
  const store = loadStore();
  pruneChallenges(store);
  const ch = store.challenges[challenge_id];
  if (!ch) throw new Error('registerKey: unknown or expired challenge_id');
  // Verify signature over the nonce using the supplied public key.
  const ok = edVerify(public_key, ch.nonce, signature);
  if (!ok) throw new Error('registerKey: signature does not verify against challenge nonce');
  let fp;
  try { fp = keyFingerprint(public_key); }
  catch (e) { throw new Error(`registerKey: cannot fingerprint public_key: ${e.message}`); }
  const short = fp.slice(0, 32);
  const entry = {
    fingerprint: fp,
    short_fingerprint: short,
    alg: 'ed25519',
    public_key,
    label: label || ch.label || null,
    tenant_id: tenant_id || ch.tenant_id || null,
    registered_at: new Date().toISOString(),
    challenge_id,
  };
  store.keys[short] = entry;
  delete store.challenges[challenge_id];
  persist(store);
  return {
    fingerprint: entry.fingerprint,
    short_fingerprint: entry.short_fingerprint,
    alg: entry.alg,
    public_key: entry.public_key,
    label: entry.label,
    tenant_id: entry.tenant_id,
    registered_at: entry.registered_at,
  };
}

// ---------------------------------------------------------------------------
// deleteKey — admin-only removal. Returns true when something was removed,
// false when the fingerprint wasn't present.
// ---------------------------------------------------------------------------
export function deleteKey(shortFingerprint) {
  if (typeof shortFingerprint !== 'string' || !shortFingerprint) return false;
  const store = loadStore();
  const norm = shortFingerprint.toLowerCase();
  const matchKey = store.keys[norm]
    ? norm
    : Object.keys(store.keys).find(k => (store.keys[k].fingerprint || '').toLowerCase().startsWith(norm));
  if (!matchKey) return false;
  delete store.keys[matchKey];
  persist(store);
  return true;
}

// ---------------------------------------------------------------------------
// stats — quick health probe used by /v1/keys/public diagnostics.
// ---------------------------------------------------------------------------
export function stats() {
  const store = loadStore();
  return {
    key_count: Object.keys(store.keys || {}).length,
    active_challenges: Object.keys(store.challenges || {}).length,
    file_path: storePath(),
  };
}

// Test helper: reset state. Skipped in production.
export function _resetForTests() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('pubkey-directory._resetForTests: refused in production');
  }
  const p = storePath();
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* swallow */ }
}
