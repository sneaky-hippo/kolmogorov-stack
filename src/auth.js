// API key + tenant resolution. One key per tenant.
// Adds per-tenant token-bucket rate limiting and monthly quota enforcement.

import 'dotenv/config';
import crypto from 'node:crypto';
import { findOne, insert, all, update, withTransaction } from './store.js';
import { isProductionRuntime } from './env.js';

export { isProductionRuntime };

// Token bucket: tenant_id → { tokens, last, capacity, refillPerSec }
const buckets = new Map();
const DEFAULT_RATE = parseInt(process.env.RATE_LIMIT_PER_SEC || '20'); // req/s sustained
const DEFAULT_BURST = parseInt(process.env.RATE_LIMIT_BURST || '60');

function mintApiKey(kind = 'user') {
  const prefix = kind === 'anon' ? 'kao_' : 'ks_';
  return prefix + crypto.randomBytes(16).toString('hex');
}

export function hashApiKey(key) {
  return 'sha256:' + crypto.createHash('sha256').update(key).digest('hex');
}

function keyFields(key) {
  return {
    api_key_hash: hashApiKey(key),
    api_key_prefix: key.slice(0, 10),
  };
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export { constantTimeEqual };

function tenantKeyMatches(tenant, key) {
  if (!tenant || !key) return false;
  // api_key_hash is the only authoritative store. Legacy plain-key column was
  // migrated to hashed form by migrateAllPlainKeysOnce() at module-load time;
  // any row that still has a non-empty api_key column at lookup time is a
  // pre-migration leftover that can no longer authenticate (the equivalent of
  // a lost password — owner must rotate via /v1/account/rotate-key after a
  // separate identity-verified recovery flow).
  if (!tenant.api_key_hash) return false;
  return constantTimeEqual(tenant.api_key_hash, hashApiKey(key));
}

export function findTenantByApiKey(key) {
  return findOne('tenants', x => !x._deleted && tenantKeyMatches(x, key)) || null;
}

// One-shot migration: any tenant minted before api_key_hash was a column has
// a plain api_key string. This walks the tenant table once at module load
// and computes api_key_hash + api_key_prefix for those rows, then clears the
// plain api_key column. Idempotent — subsequent boots are no-ops because the
// filter (api_key && !api_key_hash) matches zero rows.
export function migrateAllPlainKeysOnce() {
  let migrated = 0;
  try {
    for (const t of all('tenants')) {
      if (t._deleted) continue;
      if (typeof t.api_key === 'string' && t.api_key.length > 0 && !t.api_key_hash) {
        update('tenants', x => x.id === t.id, {
          ...keyFields(t.api_key),
          api_key: undefined,
          key_migrated_at: t.key_migrated_at || new Date().toISOString(),
        });
        migrated++;
      } else if (typeof t.api_key === 'string' && t.api_key.length > 0 && t.api_key_hash) {
        // Stale plain column on an already-hashed row — clear it.
        update('tenants', x => x.id === t.id, { api_key: undefined });
        migrated++;
      }
    }
  } catch (e) {
    // Never block startup on migration failure — surface but continue.
    console.warn('[auth] plain-key migration error:', e && e.message);
  }
  if (migrated > 0) console.log('[auth] migrated', migrated, 'tenant plain-key column(s) to hash');
}
migrateAllPlainKeysOnce();

export function provisionTenant(name, { quota = 10000, plan = 'free', kind = 'user', expires_at = null, email = null } = {}) {
  const existing = all('tenants').find(t => t.name === name);
  if (existing) return existing;
  const key = mintApiKey(kind);
  const t = {
    id: 'tenant_' + crypto.randomBytes(6).toString('hex'),
    name,
    ...keyFields(key),
    kind,                 // 'user' | 'anon'
    expires_at,           // ISO string for anon tenants; null otherwise
    email,                // null until claimed
    plan,
    quota,
    used: 0,
    rate_per_sec: DEFAULT_RATE,
    burst: DEFAULT_BURST,
    created_at: new Date().toISOString(),
  };
  insert('tenants', t);
  return { ...t, api_key: key };
}

// Mint an anonymous tenant. No email required. 30-day TTL. Lower quota.
// Designed for autonomous CLIs / agents that need to start working immediately.
export function provisionAnonTenant({ ttl_days = 30, quota = 1000 } = {}) {
  const slug = 'anon-' + crypto.randomBytes(4).toString('hex');
  const expires_at = new Date(Date.now() + ttl_days * 24 * 3600 * 1000).toISOString();
  return provisionTenant(slug, { quota, plan: 'anon', kind: 'anon', expires_at });
}

// Claim an anonymous tenant: transfer it to a real account.
// - If an existing real tenant exists for this email, merges anon's recipes/versions into it,
//   then deletes the anon tenant. Returns existing tenant.
// - Otherwise upgrades the anon tenant in-place: rotates key to ks_*, clears expiry, raises quota,
//   marks as 'user'.
export function claimAnonTenant(anonToken, { email, name }) {
  const anon = findTenantByApiKey(anonToken);
  if (!anon || anon.kind !== 'anon') return { ok: false, reason: 'anon token not found or already claimed' };
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, reason: 'valid email required' };
  }
  // Look for an existing real tenant with this email
  const existing = all('tenants').find(t => t.email === email && t.kind !== 'anon');
  if (existing) {
    const newKey = mintApiKey('user');
    // Reassign concepts from anon → existing
    update('concepts', c => c.tenant === anon.name, { tenant: existing.name });
    update('observations', o => o.tenant === anon.name, { tenant: existing.name });
    update('tenants', x => x.id === anon.id, { _deleted: true });
    update('tenants', x => x.id === existing.id, {
      ...keyFields(newKey),
      api_key: undefined,
      key_rotated_at: new Date().toISOString(),
    });
    return { ok: true, mode: 'merged', api_key: newKey, tenant: { ...existing, api_key: newKey } };
  }
  // Otherwise upgrade in place
  const newKey = mintApiKey('user');
  const slug = (name || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'user';
  const uniq = `${slug}-${Date.now().toString(36).slice(-4)}`;
  update('tenants', x => x.id === anon.id, {
    ...keyFields(newKey),
    api_key: undefined,
    name: uniq,
    kind: 'user',
    plan: 'free',
    quota: 10000,
    expires_at: null,
    email,
    claimed_at: new Date().toISOString(),
  });
  // Reassign tenant-tagged rows to the new name (concepts, observations)
  update('concepts', c => c.tenant === anon.name, { tenant: uniq });
  update('observations', o => o.tenant === anon.name, { tenant: uniq });
  return { ok: true, mode: 'upgraded', api_key: newKey, tenant: { ...anon, name: uniq, api_key: newKey } };
}

// Find an existing tenant by email or create a fresh one. Used by OAuth
// callbacks: a Google/GitHub login should sign you in if you've signed up
// before, or sign you up if you haven't. Returns { tenant, api_key, created }.
//
// Note: api_key is only returned on first creation (the OAuth path replaces
// "remember an API key" with "remember to log in via Google/GitHub"). For
// existing tenants we mint a fresh session token by rotating the key, so the
// browser cookie is the new key — old keys still work for CLI/server callers.
export function findOrCreateTenantByEmail({ email, name, provider, provider_id }) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('valid email required');
  }
  const existing = all('tenants').find(t => !t._deleted && t.email === email && t.kind !== 'anon');
  if (existing) {
    // Existing tenant signs in via OAuth: rotate the key so the session
    // cookie has a usable credential (we only store the hash, never the raw
    // key after signup). Old API keys are invalidated — that's the cost of
    // mixing OAuth signin with API-key auth. CLI users keeping a stored
    // ks_*** key should sign in with that key, not OAuth.
    const newKey = mintApiKey('user');
    update('tenants', x => x.id === existing.id, {
      ...keyFields(newKey),
      api_key: undefined,
      key_rotated_at: new Date().toISOString(),
      [`${provider}_id`]: provider_id || existing[`${provider}_id`] || null,
      last_login_at: new Date().toISOString(),
    });
    return {
      tenant: existing,
      api_key: newKey,
      created: false,
    };
  }
  const slug = (name || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'user';
  const uniq = `${slug}-${Date.now().toString(36).slice(-4)}`;
  const key = mintApiKey('user');
  const t = {
    id: 'tenant_' + crypto.randomBytes(6).toString('hex'),
    name: uniq,
    ...keyFields(key),
    kind: 'user',
    expires_at: null,
    email,
    plan: 'free',
    quota: 10000,
    seats: 1,
    used: 0,
    rate_per_sec: DEFAULT_RATE,
    burst: DEFAULT_BURST,
    [`${provider}_id`]: provider_id || null,
    auth_provider: provider,
    created_at: new Date().toISOString(),
    last_login_at: new Date().toISOString(),
  };
  insert('tenants', t);
  return {
    tenant: t,
    api_key: key,
    created: true,
  };
}

// Look up a tenant by email — used by webhook fallback when client_reference_id
// is missing but customer email is present.
export function findTenantByEmail(email) {
  if (!email) return null;
  return all('tenants').find(t => !t._deleted && t.email === email && t.kind !== 'anon') || null;
}

export function rotateTenantKey(tenant_id) {
  const newKey = mintApiKey('user');
  update('tenants', x => x.id === tenant_id, {
    ...keyFields(newKey),
    api_key: undefined,
    key_rotated_at: new Date().toISOString(),
  });
  return newKey;
}

// Rotate a tenant's receipt-signing secret. The previous secret is preserved
// in tenant.previous_receipt_secrets[] so existing artifacts and audit-chain
// rows signed with the old key continue to verify. Verifiers walk the list
// and accept the first match — see env.tenantReceiptVerificationKeys.
export function rotateTenantReceiptSecret(tenant_id) {
  const tenant = findOne('tenants', x => x.id === tenant_id);
  if (!tenant) throw new Error('tenant not found');
  const newSecret = 'ks_receipt_' + crypto.randomBytes(24).toString('hex');
  const newKeyId = `tk_${tenant_id.slice(-8)}_${crypto.randomBytes(3).toString('hex')}`;
  const previous = Array.isArray(tenant.previous_receipt_secrets) ? tenant.previous_receipt_secrets.slice() : [];
  if (tenant.receipt_secret) {
    previous.unshift({
      secret: tenant.receipt_secret,
      key_id: tenant.receipt_key_id || 'previous',
      retired_at: new Date().toISOString(),
    });
  }
  // Keep at most 3 historical keys (current + 3 previous = 4 total verification keys).
  while (previous.length > 3) previous.pop();
  update('tenants', x => x.id === tenant_id, {
    receipt_secret: newSecret,
    receipt_key_id: newKeyId,
    receipt_rotated_at: new Date().toISOString(),
    previous_receipt_secrets: previous,
  });
  return { key_id: newKeyId, rotated_at: new Date().toISOString(), previous_count: previous.length };
}

// Return current + previous key metadata for a tenant. Secrets are NEVER
// returned, only the key_id, rotated_at, and retired_at timestamps so the
// caller can audit what's in the verification fallback ring.
export function listTenantReceiptSecrets(tenant_id) {
  const tenant = findOne('tenants', x => x.id === tenant_id);
  if (!tenant) throw new Error('tenant not found');
  const current = tenant.receipt_secret
    ? {
        key_id: tenant.receipt_key_id || 'current',
        rotated_at: tenant.receipt_rotated_at || null,
        status: 'current',
      }
    : null;
  const previous = Array.isArray(tenant.previous_receipt_secrets)
    ? tenant.previous_receipt_secrets.map(p => ({
        key_id: p.key_id || 'previous',
        retired_at: p.retired_at || null,
        status: 'previous',
      }))
    : [];
  return { current, previous, total: (current ? 1 : 0) + previous.length };
}

// Drop a specific previous key from the verification ring. Once pruned,
// receipts signed with that key will no longer verify against this tenant.
// Refuses to prune the current key — rotate first if you want to retire it.
export function pruneTenantReceiptSecret(tenant_id, key_id) {
  const tenant = findOne('tenants', x => x.id === tenant_id);
  if (!tenant) throw new Error('tenant not found');
  if (tenant.receipt_key_id === key_id) throw new Error('cannot prune the current key; rotate first');
  const previous = Array.isArray(tenant.previous_receipt_secrets) ? tenant.previous_receipt_secrets : [];
  const remaining = previous.filter(p => p.key_id !== key_id);
  if (remaining.length === previous.length) throw new Error('key_id not found in previous_receipt_secrets');
  update('tenants', x => x.id === tenant_id, { previous_receipt_secrets: remaining });
  return { pruned: key_id, remaining_count: remaining.length };
}

function takeToken(t) {
  const now = Date.now();
  let b = buckets.get(t.id);
  if (!b) {
    b = { tokens: t.burst || DEFAULT_BURST, last: now, cap: t.burst || DEFAULT_BURST, refill: t.rate_per_sec || DEFAULT_RATE };
    buckets.set(t.id, b);
  }
  // refill
  const dt = (now - b.last) / 1000;
  b.tokens = Math.min(b.cap, b.tokens + dt * b.refill);
  b.last = now;
  if (b.tokens < 1) {
    const wait = Math.ceil((1 - b.tokens) / b.refill * 1000);
    return { ok: false, retry_after_ms: wait };
  }
  b.tokens -= 1;
  return { ok: true };
}

const PUBLIC_PAGES = new Set(['/', '/dashboard', '/playground', '/docs', '/registry', '/health', '/signup', '/pricing', '/why', '/status', '/specialists']);
// Read-only public endpoints: list/run public recipes, /v1/public/featured, /v1/public/concepts, /v1/public/run.
// Submission (/v1/public/submit) requires auth because it touches a tenant-owned recipe.
// /v1/anon/bootstrap is no-auth so robots can mint a workspace; /v1/anon/claim authenticates
// through its body field (anon_token), so it is also no-auth at the middleware layer.
const PUBLIC_API = (p) =>
  (p.startsWith('/v1/public/') && p !== '/v1/public/submit') ||
  p === '/v1/signup' ||
  p === '/v1/signin' ||
  p === '/v1/signout' ||
  p === '/v1/specialists/waitlist' ||
  p === '/v1/anon/bootstrap' ||
  p === '/v1/anon/claim' ||
  p === '/v1/registry/public' ||
  p === '/v1/hub' ||
  p === '/v1/lead/enterprise' ||                                        // KOLM-102: structured intake post; GET /:id stays admin-gated
  /^\/v1\/hub\/[^/]+\/[^/]+(?:\/download)?$/.test(p) ||
  /^\/v1\/receipts\/[A-Za-z0-9._\-]{8,128}\/public$/.test(p) ||         // public receipt-by-hash lookup, no auth (KOLM-109)
  p === '/v1/stripe/webhook' ||
  p === '/v1/oauth/providers' ||
  p === '/v1/byoc/attestation' ||
  p === '/v1/byoc/targets' ||
  /^\/v1\/teams\/invites\/[A-Za-z0-9_\-]+$/.test(p) ||                  // preview is public; /accept is its own path
  /^\/v1\/oauth\/(google|github)\/(start|callback)$/.test(p) ||
  /^\/v1\/tunnel\/agent\/[A-Za-z0-9_\-]+(?:\/response)?$/.test(p) ||
  // wave-144 stateless validators / catalogs (no tenant state read, pure compute).
  // Trace/IR-compile/FL-round/aggregate stay auth-gated above because they touch tenant data.
  p.startsWith('/v1/device/') ||                                        // profiles catalog + probe/check are stateless
  p.startsWith('/v1/cc/') ||                                            // confidential-compute kinds/shape/verify
  p === '/v1/fl/strategies' ||                                          // FL strategy catalog (round/contribution/aggregate stay authed)
  p.startsWith('/v1/capability/') ||                                    // capability build/validate are stateless
  p.startsWith('/v1/lineage/') ||                                       // lineage build/validate are stateless
  p === '/v1/ir/stats' ||                                               // IR stats over body-supplied IR
  p === '/v1/ir/validate' ||                                            // IR shape validation over body
  p === '/v1/ir/replay' ||                                              // IR cache-seed replay over body
  // W342 marketplace catalog is public (it's a published catalog of signed
  // artifacts). All routes are read-only metadata + download; the download
  // path enforces a productionReady() gate (409 unless ?force=true).
  // publish-request remains queue-write-only (audit ledger), so we keep it
  // bound here too — it doesn't touch tenant rows.
  p === '/v1/marketplace' ||
  p === '/v1/marketplace/list' ||
  p === '/v1/marketplace/catalog.json' ||
  p === '/v1/marketplace/publish-request' ||
  /^\/v1\/marketplace\/[A-Za-z0-9._-]+(?:\/download)?$/.test(p) ||
  // W384 — sync inbox accepts pushes from peer daemons; the sender supplies
  // an Authorization: Bearer <key> via the body/headers and validates it itself
  // (the body's source_device_id + state envelope acts as the auth contract).
  p === '/v1/sync/inbox' ||
  // W384 — accept-invite is invite-token-authenticated (the URL token IS the
  // credential); the workspace lookup happens inside team.js with explicit
  // expiry + consumed checks. Public so a new member with no api_key can join.
  p === '/v1/team/accept-invite';

export function adminApiKey() {
  return process.env.ADMIN_KEY || null;
}

export function authMiddleware(req, res, next) {
  const p = req.path;
  // Non-API paths bypass auth entirely (page routes, static, 404 fallback handle them)
  if (!p.startsWith('/v1/')) return next();
  // W258-SEC-1: ?api_key=... lands in CDN access logs, Referer chains, and
  // browser history. The query-param fallback is removed for tenant API
  // keys. CLI / server-to-server callers already use Authorization or
  // X-API-Key; the browser dashboard uses the httpOnly cookie. Anonymous
  // ?anon=<token> bootstrap (short-lived, scoped) still uses its own
  // dedicated route — it never hits this fallback.
  if (PUBLIC_API(p)) {
    // Soft-auth: never reject, but if the caller sent a valid key, populate
    // req.tenant_record so the route can differentiate anon vs owner reads
    // (e.g. /v1/hub/:owner/:name returning private rows only to their owner).
    const header = req.headers.authorization || '';
    const xApi = req.headers['x-api-key'] || '';
    const cookieKey = (req.cookies && req.cookies.kolm_session) || '';
    const key = cookieKey || header.replace(/^Bearer\s+/i, '').trim() || xApi;
    if (key) {
      const t = findTenantByApiKey(key);
      if (t && !(t.kind === 'anon' && t.expires_at && new Date(t.expires_at) < new Date())) {
        req.tenant_record = t;
        req.tenant = t.id;
      }
    }
    return next();
  }
  const adminKey = adminApiKey();
  const header = req.headers.authorization || '';
  const xApi = req.headers['x-api-key'] || '';
  const cookieKey = (req.cookies && req.cookies.kolm_session) || '';
  // S7 + W258-SEC-1: cookie > Authorization > X-API-Key. Query-param api_key
  // was removed because it leaks credentials through CDN access logs and
  // Referer headers. If a caller sends ?api_key=... we now reject with 401
  // and a hint to use a header, so the regression is loud not silent.
  const queryKey = req.query && req.query.api_key ? String(req.query.api_key) : '';
  if (queryKey) {
    return res.status(401).json({
      error: 'api_key_in_query_unsupported',
      hint: 'pass the key via Authorization: Bearer <key> or X-API-Key header. The ?api_key= form was removed to keep credentials out of CDN logs.',
    });
  }
  const key = cookieKey || header.replace(/^Bearer\s+/i, '').trim() || xApi;

  if (adminKey && key === adminKey) {
    req.tenant = process.env.DEFAULT_TENANT || 'demo';
    req.is_admin = true;
    return next();
  }

  if (!key) return res.status(401).json({ error: 'missing api key', hint: 'set Authorization: Bearer <key> or X-API-Key header' });
  const t = findTenantByApiKey(key);
  if (!t) return res.status(401).json({ error: 'invalid api key' });

  // Anon tokens expire — deny + nudge to claim
  if (t.kind === 'anon' && t.expires_at && new Date(t.expires_at) < new Date()) {
    return res.status(401).json({
      error: 'anonymous workspace expired',
      hint: 'run `recipe claim --email you@co.com` to convert to a permanent account',
      expired_at: t.expires_at,
    });
  }

  // rate limit
  const tk = takeToken(t);
  res.set('X-RateLimit-Limit', String(t.rate_per_sec || DEFAULT_RATE));
  res.set('X-RateLimit-Burst', String(t.burst || DEFAULT_BURST));
  if (!tk.ok) {
    res.set('Retry-After', String(Math.ceil(tk.retry_after_ms / 1000)));
    res.set('X-RateLimit-Remaining', '0');
    return res.status(429).json({ error: 'rate limit exceeded', retry_after_ms: tk.retry_after_ms });
  }
  res.set('X-RateLimit-Remaining', String(Math.max(0, Math.floor(buckets.get(t.id)?.tokens || 0))));

  // quota check (count per call where billing applies)
  if (typeof t.quota === 'number') {
    res.set('X-Quota-Limit', String(t.quota));
    res.set('X-Quota-Used', String(t.used || 0));
    res.set('X-Quota-Remaining', String(Math.max(0, t.quota - (t.used || 0))));
    if (t.used >= t.quota) {
      return res.status(429).json({ error: 'monthly quota exceeded', used: t.used, quota: t.quota });
    }
  }

  req.tenant = t.name;
  req.tenant_record = t;
  // Stash the verified raw key so handlers can use it (e.g. /v1/account
  // mirroring api_key into a sliding-session cookie). Tenants store only
  // api_key_hash post-migration, so without this the raw key is unrecoverable.
  req.api_key = key;
  next();
}

// Lightweight billing increment. Call from billable handlers.
// W258-BE-4: previously did a read-modify-write off the stale tenant_record
// snapshot the middleware captured at request entry. Two concurrent billable
// requests on the same tenant would both read `used=N`, both write `N+units`,
// and the second increment was lost — paying-plan tenants drifted past quota
// and we under-billed. Wrap the read-modify-write in withTransaction so
// SQLite's BEGIN IMMEDIATE serializes the increment. Re-read the row inside
// the transaction so we increment from the latest committed value, not the
// possibly-stale tenant_record handed to the middleware.
export function chargeUsage(tenant_record, units = 1) {
  if (!tenant_record) return;
  withTransaction(() => {
    const fresh = findOne('tenants', x => x.id === tenant_record.id) || tenant_record;
    update('tenants', x => x.id === tenant_record.id, {
      used: (fresh.used || 0) + units,
      last_used_at: new Date().toISOString(),
    });
  });
}

// Plan-tier entitlement gate. Use as middleware on routes that should only be
// available to a subset of plans (e.g. /v1/teams, /v1/tunnels, /v1/byoc).
// Admin tokens always pass. Returns 402 with a hint to upgrade when the
// tenant's plan is not in the allowed set; pending paid plans get a 402 with
// `pending=true` instead of being silently denied.
//
// Usage:
//   const requireTeams = requirePlan(['teams','business','enterprise'], 'teams workspace');
//   r.post('/v1/teams', requireTeams, (req, res) => { ... });
export function requirePlan(allowedPlans, feature = 'this feature') {
  const allowed = new Set((allowedPlans || []).map(p => String(p).toLowerCase()));
  return function entitlementMiddleware(req, res, next) {
    if (req.is_admin) return next();
    const t = req.tenant_record;
    if (!t) {
      return res.status(401).json({
        error: 'authentication required',
        feature,
        hint: 'set Authorization: Bearer <api_key>',
      });
    }
    const plan = String(t.plan || 'free').toLowerCase();
    if (allowed.has(plan)) return next();
    // Pending upgrade — show as "payment pending" rather than "upgrade".
    if (t.pending_plan && allowed.has(String(t.pending_plan).toLowerCase())) {
      return res.status(402).json({
        error: 'plan upgrade pending payment',
        feature,
        current_plan: plan,
        pending_plan: t.pending_plan,
        hint: 'complete checkout to unlock',
      });
    }
    return res.status(402).json({
      error: 'plan upgrade required',
      feature,
      current_plan: plan,
      allowed_plans: Array.from(allowed),
      hint: `POST /v1/account/change-plan with one of: ${Array.from(allowed).join(', ')}`,
    });
  };
}

export function rateLimitStats() {
  const out = [];
  for (const [tid, b] of buckets) out.push({ tenant_id: tid, tokens: Math.floor(b.tokens), cap: b.cap });
  return out;
}
