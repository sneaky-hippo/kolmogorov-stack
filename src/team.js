// W379 — team backend: shared namespaces + RBAC + reviewer queues + approval gates.
//
// File-only storage under $KOLM_DATA_DIR/team (or ~/.kolm/team), all writes
// durable + idempotent. Pure ESM, zero npm deps — node:fs / node:path /
// node:crypto / node:os only. Round 2 consolidator wires the routes + CLI
// verbs; this module owns the data model.
//
// Storage layout:
//   $KOLM_DATA_DIR/team/
//     workspace.json    # { workspace_id, name, plan_tier, members[],
//                       #   shared_namespaces[] }
//     invites.jsonl     # append-only invite log (one JSON per line)
//     approvals.jsonl   # append-only approval queue (one JSON per line)
//
// Permission matrix (single source of truth — tests/wave379 lock this in):
//
//   action             | admin | reviewer | contributor | viewer
//   -------------------+-------+----------+-------------+--------
//   capture            |   y   |    y     |     y       |   n
//   label              |   y   |    y     |     y       |   n
//   split_dataset      |   y   |    y     |     n       |   n
//   publish_artifact   |   y   |    y     |     n       |   n
//   enable_cloud_sync  |   y   |    n     |     n       |   n
//   change_plan        |   y   |    n     |     n       |   n
//   invite_member      |   y   |    n     |     n       |   n
//   view               |   y   |    y     |     y       |   y
//
// Contributors call submitApproval() for split_dataset / publish_artifact /
// sync_state_change; reviewers + admins decide via decideApproval(). A
// submitter cannot approve their own item (self_review).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ─── constants ────────────────────────────────────────────────────────────────

export const ROLES = ['admin', 'reviewer', 'contributor', 'viewer'];
export const APPROVAL_KINDS = ['dataset_split', 'artifact_publish', 'sync_state_change'];
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];
export const ACTIONS = [
  'capture', 'label', 'split_dataset', 'publish_artifact',
  'enable_cloud_sync', 'change_plan', 'invite_member', 'view',
];

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Permission matrix — ordered exactly as in the table above so the test can
// walk it cell-by-cell.
const PERMS = {
  admin: new Set(['capture', 'label', 'split_dataset', 'publish_artifact',
    'enable_cloud_sync', 'change_plan', 'invite_member', 'view']),
  reviewer: new Set(['capture', 'label', 'split_dataset', 'publish_artifact', 'view']),
  contributor: new Set(['capture', 'label', 'view']),
  viewer: new Set(['view']),
};

// ─── errors ───────────────────────────────────────────────────────────────────

export class TeamError extends Error {
  constructor(code, message, extras = {}) {
    super(message || code);
    this.name = 'TeamError';
    this.code = code;
    for (const [k, v] of Object.entries(extras)) this[k] = v;
  }
}

// ─── paths ────────────────────────────────────────────────────────────────────

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function teamDir() {
  const base = process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
  const p = path.join(base, 'team');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function workspacePath() { return path.join(teamDir(), 'workspace.json'); }
function invitesPath()   { return path.join(teamDir(), 'invites.jsonl'); }
function approvalsPath() { return path.join(teamDir(), 'approvals.jsonl'); }

// ─── id + token helpers ───────────────────────────────────────────────────────

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function newWorkspaceId() { return newId('ws'); }
function newMemberId()    { return newId('mem'); }
function newApprovalId()  { return newId('apr'); }

function newInviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function nowIso() { return new Date().toISOString(); }

// ─── workspace IO ─────────────────────────────────────────────────────────────

function defaultWorkspace() {
  const wsId = newWorkspaceId();
  const adminId = newMemberId();
  const now = nowIso();
  const selfEmail = process.env.KOLM_TEAM_SELF_EMAIL || 'you@kolm.local';
  return {
    workspace_id: wsId,
    name: 'My Workspace',
    plan_tier: 'free',
    created_at: now,
    members: [{
      member_id: adminId,
      email: selfEmail,
      role: 'admin',
      joined_at: now,
      invited_by: null,
    }],
    shared_namespaces: [],
  };
}

function readWorkspace() {
  const fp = workspacePath();
  if (!fs.existsSync(fp)) {
    const ws = defaultWorkspace();
    writeWorkspace(ws);
    return ws;
  }
  try {
    const txt = fs.readFileSync(fp, 'utf8');
    const obj = JSON.parse(txt);
    // Defensive: backfill arrays if a hand-edited file dropped them.
    if (!Array.isArray(obj.members)) obj.members = [];
    if (!Array.isArray(obj.shared_namespaces)) obj.shared_namespaces = [];
    return obj;
  } catch (e) {
    throw new TeamError('workspace_corrupt', `workspace.json unreadable: ${e.message}`);
  }
}

function writeWorkspace(ws) {
  const fp = workspacePath();
  // Atomic-ish: write to tmp, rename. Two concurrent CLI processes can still
  // race the rename — that's acceptable for a single-tenant local datastore.
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ws, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
  return ws;
}

// ─── JSONL helpers ────────────────────────────────────────────────────────────

function appendJsonl(fp, record) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

function readJsonl(fp) {
  if (!fs.existsSync(fp)) return [];
  const txt = fs.readFileSync(fp, 'utf8');
  const out = [];
  for (const ln of txt.split(/\r?\n/)) {
    if (!ln) continue;
    try { out.push(JSON.parse(ln)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

// Replace an append-only JSONL file with the rewritten history. Used by the
// approval-decision path; keeps the latest record per id as the truth.
function rewriteJsonl(fp, records) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, fp);
}

// ─── lookups ──────────────────────────────────────────────────────────────────

function findMember(ws, memberId) {
  return ws.members.find(m => m.member_id === memberId) || null;
}

function requireMember(ws, memberId) {
  const m = findMember(ws, memberId);
  if (!m) throw new TeamError('member_not_found', `member ${memberId} not found`);
  return m;
}

function requireAdmin(ws, actorMemberId) {
  const m = requireMember(ws, actorMemberId);
  if (m.role !== 'admin') {
    throw new TeamError('forbidden', `member ${actorMemberId} is not admin`);
  }
  return m;
}

function countAdmins(ws) {
  return ws.members.filter(m => m.role === 'admin').length;
}

function assertRole(role) {
  if (!ROLES.includes(role)) {
    throw new TeamError('bad_role', `role must be one of ${ROLES.join(', ')}; got ${role}`);
  }
}

function assertKind(kind) {
  if (!APPROVAL_KINDS.includes(kind)) {
    throw new TeamError('bad_kind', `kind must be one of ${APPROVAL_KINDS.join(', ')}; got ${kind}`);
  }
}

// ─── public: workspace ────────────────────────────────────────────────────────

export function getWorkspace() {
  return readWorkspace();
}

export function setWorkspace({ name, plan_tier, actor_member_id }) {
  const ws = readWorkspace();
  requireAdmin(ws, actor_member_id);
  if (typeof name === 'string' && name.trim()) ws.name = name.trim();
  if (typeof plan_tier === 'string' && plan_tier.trim()) ws.plan_tier = plan_tier.trim();
  ws.updated_at = nowIso();
  return writeWorkspace(ws);
}

// ─── public: members ──────────────────────────────────────────────────────────

export function listMembers() {
  return readWorkspace().members.slice();
}

export function invite({ email, role, invited_by, ttl_ms } = {}) {
  if (!email || typeof email !== 'string') {
    throw new TeamError('bad_email', 'email required');
  }
  assertRole(role);
  const ws = readWorkspace();
  requireAdmin(ws, invited_by);

  const token = newInviteToken();
  const memberId = newMemberId();
  const issuedAt = Date.now();
  const ttl = Number.isFinite(ttl_ms) && ttl_ms > 0 ? ttl_ms : DEFAULT_INVITE_TTL_MS;
  const expiresAt = new Date(issuedAt + ttl).toISOString();

  const base = process.env.KOLM_TEAM_INVITE_BASE
    || process.env.KOLM_BASE_URL
    || 'https://kolm.ai';
  const inviteUrl = `${base.replace(/\/$/, '')}/invite?token=${token}`;

  const record = {
    type: 'invite_issued',
    member_id: memberId,
    email,
    role,
    invited_by,
    invite_token: token,
    invite_url: inviteUrl,
    issued_at: new Date(issuedAt).toISOString(),
    expires_at: expiresAt,
    consumed: false,
  };
  appendJsonl(invitesPath(), record);

  return {
    member_id: memberId,
    invite_token: token,
    invite_url: inviteUrl,
    expires_at: expiresAt,
    role,
    email,
  };
}

function findInvite(token) {
  const records = readJsonl(invitesPath());
  // Latest record per token wins so a consume-mark replaces the original.
  let latest = null;
  for (const r of records) {
    if (r.invite_token === token) latest = r;
  }
  return latest;
}

function markInviteConsumed(token, consumerMemberId) {
  const records = readJsonl(invitesPath());
  appendJsonl(invitesPath(), {
    type: 'invite_consumed',
    invite_token: token,
    consumed: true,
    consumed_at: nowIso(),
    consumer_member_id: consumerMemberId,
  });
  return records;
}

export function acceptInvite({ invite_token, member_email } = {}) {
  if (!invite_token) throw new TeamError('bad_token', 'invite_token required');
  const rec = findInvite(invite_token);
  if (!rec) throw new TeamError('invite_not_found', 'invite_token not recognized');
  if (rec.consumed) throw new TeamError('invite_consumed', 'invite already used');
  if (rec.type === 'invite_consumed') {
    throw new TeamError('invite_consumed', 'invite already used');
  }
  if (Date.parse(rec.expires_at) < Date.now()) {
    throw new TeamError('invite_expired', `invite expired at ${rec.expires_at}`);
  }

  const ws = readWorkspace();
  if (findMember(ws, rec.member_id)) {
    // Idempotent: already accepted but consume-mark missing for some reason.
    markInviteConsumed(invite_token, rec.member_id);
    const existing = findMember(ws, rec.member_id);
    return { member_id: existing.member_id, role: existing.role };
  }

  const member = {
    member_id: rec.member_id,
    email: member_email || rec.email,
    role: rec.role,
    joined_at: nowIso(),
    invited_by: rec.invited_by,
  };
  ws.members.push(member);
  writeWorkspace(ws);
  markInviteConsumed(invite_token, member.member_id);

  return { member_id: member.member_id, role: member.role };
}

export function setRole({ member_id, role, actor_member_id } = {}) {
  assertRole(role);
  const ws = readWorkspace();
  requireAdmin(ws, actor_member_id);
  const target = requireMember(ws, member_id);

  if (target.role === 'admin' && role !== 'admin' && countAdmins(ws) <= 1) {
    throw new TeamError('last_admin', 'cannot demote the last admin');
  }

  target.role = role;
  target.role_changed_at = nowIso();
  target.role_changed_by = actor_member_id;
  writeWorkspace(ws);
  return { ...target };
}

export function removeMember({ member_id, actor_member_id } = {}) {
  const ws = readWorkspace();
  requireAdmin(ws, actor_member_id);
  const target = requireMember(ws, member_id);

  if (target.role === 'admin' && countAdmins(ws) <= 1) {
    throw new TeamError('last_admin', 'cannot remove the last admin');
  }

  ws.members = ws.members.filter(m => m.member_id !== member_id);
  // Also drop shared-namespace ownership entries owned by the removed member.
  ws.shared_namespaces = ws.shared_namespaces.filter(s => s.namespace_owner_id !== member_id);
  writeWorkspace(ws);
  return { ok: true, removed_member_id: member_id };
}

// ─── public: permissions ──────────────────────────────────────────────────────

export function permits(memberId, action) {
  if (!ACTIONS.includes(action)) {
    throw new TeamError('bad_action', `action must be one of ${ACTIONS.join(', ')}; got ${action}`);
  }
  const ws = readWorkspace();
  const m = findMember(ws, memberId);
  if (!m) return false;
  const allow = PERMS[m.role];
  if (!allow) return false;
  return allow.has(action);
}

// ─── public: approvals ────────────────────────────────────────────────────────

function readApprovals() {
  const records = readJsonl(approvalsPath());
  // Latest record per approval_id wins (decideApproval appends a new line).
  const map = new Map();
  for (const r of records) {
    if (!r.approval_id) continue;
    map.set(r.approval_id, r);
  }
  return Array.from(map.values());
}

export function submitApproval({ kind, payload, submitter_id } = {}) {
  assertKind(kind);
  const ws = readWorkspace();
  const submitter = requireMember(ws, submitter_id);

  // Contributor and above may submit. Viewer cannot (they're read-only).
  if (submitter.role === 'viewer') {
    throw new TeamError('forbidden', 'viewer cannot submit approvals');
  }

  const id = newApprovalId();
  const record = {
    approval_id: id,
    kind,
    payload: payload === undefined ? null : payload,
    submitter_id,
    submitter_email: submitter.email,
    status: 'pending',
    submitted_at: nowIso(),
    decided_at: null,
    reviewer_id: null,
    comment: null,
  };
  appendJsonl(approvalsPath(), record);
  return { approval_id: id, status: 'pending', kind, submitter_id };
}

export function decideApproval({ approval_id, decision, reviewer_id, comment } = {}) {
  if (!approval_id) throw new TeamError('bad_request', 'approval_id required');
  if (decision !== 'approve' && decision !== 'reject') {
    throw new TeamError('bad_decision', `decision must be approve|reject; got ${decision}`);
  }
  const ws = readWorkspace();
  const reviewer = requireMember(ws, reviewer_id);
  if (reviewer.role !== 'admin' && reviewer.role !== 'reviewer') {
    throw new TeamError('forbidden', `role ${reviewer.role} cannot decide approvals`);
  }

  const current = readApprovals();
  const existing = current.find(r => r.approval_id === approval_id);
  if (!existing) throw new TeamError('approval_not_found', `approval ${approval_id} not found`);

  if (existing.submitter_id === reviewer_id) {
    throw new TeamError('self_review', 'cannot decide on your own submission');
  }

  if (existing.status !== 'pending') {
    throw new TeamError('already_decided', `approval ${approval_id} already ${existing.status}`);
  }

  const updated = {
    ...existing,
    status: decision === 'approve' ? 'approved' : 'rejected',
    decided_at: nowIso(),
    reviewer_id,
    reviewer_email: reviewer.email,
    comment: typeof comment === 'string' ? comment : null,
  };
  // Append the new state — readApprovals takes the latest per id.
  appendJsonl(approvalsPath(), updated);
  return updated;
}

export function listApprovals({ status, kind, limit = 50 } = {}) {
  let rows = readApprovals();
  if (status) {
    if (!APPROVAL_STATUSES.includes(status)) {
      throw new TeamError('bad_status', `status must be one of ${APPROVAL_STATUSES.join(', ')}; got ${status}`);
    }
    rows = rows.filter(r => r.status === status);
  }
  if (kind) {
    if (!APPROVAL_KINDS.includes(kind)) {
      throw new TeamError('bad_kind', `kind must be one of ${APPROVAL_KINDS.join(', ')}; got ${kind}`);
    }
    rows = rows.filter(r => r.kind === kind);
  }
  // Newest first.
  rows.sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  return rows.slice(0, n);
}

// ─── public: shared namespaces ────────────────────────────────────────────────

// addSharedNamespace registers a namespace with an owner. The `shared` flag
// (default true) controls whether non-owner members can see it. Admins call
// this for both shared team namespaces and individual-owned scratch spaces so
// canSee has a complete view of ownership.
export function addSharedNamespace({ namespace, namespace_owner_id, actor_member_id, shared } = {}) {
  if (!namespace || typeof namespace !== 'string') {
    throw new TeamError('bad_namespace', 'namespace required');
  }
  if (!namespace_owner_id) {
    throw new TeamError('bad_owner', 'namespace_owner_id required');
  }
  const ws = readWorkspace();
  requireAdmin(ws, actor_member_id);
  requireMember(ws, namespace_owner_id); // owner must be a member

  const isShared = shared === false ? false : true;

  const existing = ws.shared_namespaces.find(s => s.namespace === namespace);
  if (existing) {
    existing.namespace_owner_id = namespace_owner_id;
    existing.shared = isShared;
    existing.updated_at = nowIso();
    writeWorkspace(ws);
    return { ...existing };
  }

  const entry = {
    namespace,
    namespace_owner_id,
    shared: isShared,
    shared_by: actor_member_id,
    shared_at: nowIso(),
  };
  ws.shared_namespaces.push(entry);
  writeWorkspace(ws);
  return { ...entry };
}

export function removeSharedNamespace({ namespace, actor_member_id } = {}) {
  if (!namespace) throw new TeamError('bad_namespace', 'namespace required');
  const ws = readWorkspace();
  requireAdmin(ws, actor_member_id);
  const before = ws.shared_namespaces.length;
  ws.shared_namespaces = ws.shared_namespaces.filter(s => s.namespace !== namespace);
  writeWorkspace(ws);
  return { ok: true, removed: before - ws.shared_namespaces.length };
}

// canSee returns true when:
//   • the namespace has a registered entry with shared:true (visible to all
//     workspace members), or
//   • the member is the registered namespace_owner_id, or
//   • the member is an admin (admins see everything).
//
// A namespace with no registered entry is treated as fully private — no
// member (other than an admin) can see it.
export function canSee(memberId, namespace) {
  const ws = readWorkspace();
  const m = findMember(ws, memberId);
  if (!m) return false;
  if (m.role === 'admin') return true;
  const entry = ws.shared_namespaces.find(s => s.namespace === namespace);
  if (!entry) return false;
  if (entry.shared) return true;
  return entry.namespace_owner_id === memberId;
}

// ─── default export for convenience ───────────────────────────────────────────

export default {
  TeamError,
  ROLES,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  ACTIONS,
  getWorkspace,
  setWorkspace,
  listMembers,
  invite,
  acceptInvite,
  setRole,
  removeMember,
  permits,
  submitApproval,
  decideApproval,
  listApprovals,
  addSharedNamespace,
  removeSharedNamespace,
  canSee,
};
