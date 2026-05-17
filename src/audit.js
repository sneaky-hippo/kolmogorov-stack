// Durable append-only audit log with per-tenant HMAC chain.
//
// Every load-bearing tenant operation (compile started, compile completed,
// artifact downloaded, run, plan change, key rotation, team invite/accept,
// tunnel created, byoc deploy) writes one row here. Rows are append-only —
// they are never updated or deleted from this module. Each row carries the
// HMAC-SHA256 of (prev_event_hash || event_payload), so a leak that tampers
// with history breaks the chain at the first mutated row.
//
// The HMAC key comes from `effectiveReceiptSecret()` so it is the same secret
// that signs receipts and chained artifact manifests. In production this MUST
// be set to a strong RECIPE_RECEIPT_SECRET (>=32 chars); env.js refuses to
// boot otherwise.
//
// Verification: `verifyAuditChain(tenant_id)` walks all rows for a tenant in
// insertion order, recomputes the chain, and reports any breaks. The CLI
// `kolm audit verify` (cli/kolm.js) calls this and exits non-zero on break.

import crypto from 'node:crypto';
import { all, find, insert } from './store.js';
import { effectiveReceiptSecret } from './env.js';

const TABLE = 'audit_events';
const CHAIN_VERSION = 1;

// Operations we audit. New op codes are fine — keep them stable; the chain
// hashes the op code so renaming an old op breaks verification of past rows.
export const AUDIT_OPS = Object.freeze({
  // Compile + artifact lifecycle
  COMPILE_CREATED: 'compile.created',
  COMPILE_COMPLETED: 'compile.completed',
  COMPILE_FAILED: 'compile.failed',
  ARTIFACT_DOWNLOADED: 'artifact.downloaded',
  // Recipe / concept lifecycle
  CONCEPT_CREATED: 'concept.created',
  CONCEPT_DELETED: 'concept.deleted',
  VERSION_PUBLISHED: 'version.published',
  // Run + capture
  RECIPE_RUN: 'recipe.run',
  CAPTURE_OBSERVED: 'capture.observed',
  // Auth + key
  KEY_ROTATED: 'auth.key_rotated',
  // Billing + plan
  PLAN_CHANGED: 'billing.plan_changed',
  PLAN_CANCELED: 'billing.plan_canceled',
  STRIPE_EVENT: 'billing.stripe_event',
  // Teams + tunnels + BYOC
  TEAM_CREATED: 'teams.created',
  TEAM_MEMBER_INVITED: 'teams.member_invited',
  TEAM_MEMBER_JOINED: 'teams.member_joined',
  TEAM_MEMBER_REMOVED: 'teams.member_removed',
  TUNNEL_CREATED: 'tunnels.created',
  TUNNEL_REVOKED: 'tunnels.revoked',
  BYOC_DEPLOY_REQUESTED: 'byoc.deploy_requested',
  BYOC_DEPLOY_COMPLETED: 'byoc.deploy_completed',
  // Eval surface (Wave 165 N+5 tenant shadow corpus + future N+7 auditor)
  EVAL_TENANT_HOLDOUT_SAVE: 'eval.tenant_holdout.save',
  EVAL_TENANT_HOLDOUT_DELETE: 'eval.tenant_holdout.delete',
  // Admin / system
  ADMIN_ACTION: 'admin.action',
});

function chainSecret() {
  return effectiveReceiptSecret({ includeLegacyArtifactSecret: false }) || '';
}

function hmacHex(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function canonicalisePayload(payload) {
  // Deterministic JSON: sorted keys at every level. Two callers writing the
  // same logical event produce byte-identical canonical strings, so the chain
  // is reproducible by any replicator.
  const seen = new WeakSet();
  const sort = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(sort);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
    return out;
  };
  return JSON.stringify(sort(payload));
}

function previousChainHashFor(tenant_id) {
  // Last row for this tenant by insertion order. We rely on rows being a flat
  // append-only sequence — both json + sqlite drivers iterate in insertion
  // order.
  const rows = all(TABLE).filter(r => r.tenant_id === tenant_id);
  if (!rows.length) return ''.padEnd(64, '0');
  return rows[rows.length - 1].event_hash;
}

// Synchronous append. Caller passes plain JS values; we canonicalise + chain.
// Returns the inserted row (including event_hash and seq).
export function appendAudit({ tenant_id, tenant_name = null, actor = null, op, payload = {}, request_id = null }) {
  if (!tenant_id) throw new Error('appendAudit requires tenant_id');
  if (!op || typeof op !== 'string') throw new Error('appendAudit requires op');
  const secret = chainSecret();
  // In dev without a configured secret, the receipt module returns DEV secret;
  // in production env.js makes the secret mandatory. Never write rows with no
  // chain key — that defeats the point of the table.
  if (!secret) throw new Error('audit chain disabled: no receipt secret available');

  const prev = previousChainHashFor(tenant_id);
  const at = new Date().toISOString();
  const body = {
    v: CHAIN_VERSION,
    tenant_id,
    op,
    at,
    payload: payload || {},
  };
  const canonical = canonicalisePayload(body);
  const event_hash = hmacHex(secret, `${prev}|${canonical}`);
  const row = {
    id: 'aud_' + crypto.randomBytes(8).toString('hex'),
    tenant_id,
    tenant_name,
    actor,
    request_id,
    op,
    at,
    payload: payload || {},
    prev_hash: prev,
    event_hash,
    chain_version: CHAIN_VERSION,
  };
  insert(TABLE, row);
  return row;
}

// Best-effort wrapper: if anything goes wrong, swallow + log. Use this on hot
// paths where we'd rather drop an audit row than fail the user's request.
export function tryAppendAudit(args) {
  try {
    return appendAudit(args);
  } catch (err) {
    if (process.env.KOLM_AUDIT_DEBUG === '1') {
      console.error(`[audit] append failed: ${err.message}`);
    }
    return null;
  }
}

export function listAuditEvents(tenant_id, { limit = 100, since = null, until = null, op = null } = {}) {
  const rows = find(TABLE, r => r.tenant_id === tenant_id)
    .filter(r => !op || r.op === op)
    .filter(r => !since || (r.at && Date.parse(r.at) >= Date.parse(since)))
    .filter(r => !until || (r.at && Date.parse(r.at) <= Date.parse(until)))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return rows.slice(0, Math.max(1, Math.min(limit, 1000)));
}

export function countAuditEvents(tenant_id) {
  return find(TABLE, r => r.tenant_id === tenant_id).length;
}

// Walk the chain, recompute hashes, report any breaks. Used by the CLI
// `kolm audit verify` and the /v1/audit/verify endpoint.
export function verifyAuditChain(tenant_id) {
  const secret = chainSecret();
  if (!secret) return { ok: false, reason: 'no_chain_secret', total: 0, breaks: [] };
  const rows = all(TABLE).filter(r => r.tenant_id === tenant_id);
  if (!rows.length) return { ok: true, total: 0, breaks: [], note: 'no audit rows for tenant' };
  let prev = ''.padEnd(64, '0');
  const breaks = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const body = { v: r.chain_version || CHAIN_VERSION, tenant_id: r.tenant_id, op: r.op, at: r.at, payload: r.payload || {} };
    const canonical = canonicalisePayload(body);
    const expected = hmacHex(secret, `${prev}|${canonical}`);
    if (r.prev_hash !== prev) {
      breaks.push({ index: i, id: r.id, reason: 'prev_hash_mismatch', expected_prev: prev, got_prev: r.prev_hash });
    }
    if (r.event_hash !== expected) {
      breaks.push({ index: i, id: r.id, reason: 'event_hash_mismatch', expected, got: r.event_hash });
    }
    prev = r.event_hash;
  }
  return { ok: breaks.length === 0, total: rows.length, breaks, last_hash: prev };
}
