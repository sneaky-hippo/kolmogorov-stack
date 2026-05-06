// API key + tenant resolution. One key per tenant.
// Adds per-tenant token-bucket rate limiting and monthly quota enforcement.

import 'dotenv/config';
import crypto from 'node:crypto';
import { findOne, insert, all, update } from './store.js';

// Token bucket: tenant_id → { tokens, last, capacity, refillPerSec }
const buckets = new Map();
const DEFAULT_RATE = parseInt(process.env.RATE_LIMIT_PER_SEC || '20'); // req/s sustained
const DEFAULT_BURST = parseInt(process.env.RATE_LIMIT_BURST || '60');

export function provisionTenant(name, { quota = 10000, plan = 'free', kind = 'user', expires_at = null, email = null } = {}) {
  const existing = all('tenants').find(t => t.name === name);
  if (existing) return existing;
  const prefix = kind === 'anon' ? 'kao_' : 'ks_';
  const key = prefix + crypto.randomBytes(16).toString('hex');
  const t = {
    id: 'tenant_' + crypto.randomBytes(6).toString('hex'),
    name,
    api_key: key,
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
  return t;
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
  const anon = findOne('tenants', x => x.api_key === anonToken && x.kind === 'anon');
  if (!anon) return { ok: false, reason: 'anon token not found or already claimed' };
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, reason: 'valid email required' };
  }
  // Look for an existing real tenant with this email
  const existing = all('tenants').find(t => t.email === email && t.kind !== 'anon');
  if (existing) {
    // Reassign concepts from anon → existing
    update('concepts', c => c.tenant === anon.name, { tenant: existing.name });
    update('observations', o => o.tenant === anon.name, { tenant: existing.name });
    update('tenants', x => x.id === anon.id, { _deleted: true });
    return { ok: true, mode: 'merged', api_key: existing.api_key, tenant: existing };
  }
  // Otherwise upgrade in place
  const newKey = 'ks_' + crypto.randomBytes(16).toString('hex');
  const slug = (name || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'user';
  const uniq = `${slug}-${Date.now().toString(36).slice(-4)}`;
  update('tenants', x => x.id === anon.id, {
    api_key: newKey,
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

export function rotateTenantKey(tenant_id) {
  const newKey = 'ks_' + crypto.randomBytes(16).toString('hex');
  update('tenants', x => x.id === tenant_id, { api_key: newKey, key_rotated_at: new Date().toISOString() });
  return newKey;
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
  p === '/v1/specialists/waitlist' ||
  p === '/v1/anon/bootstrap' ||
  p === '/v1/anon/claim';

export function authMiddleware(req, res, next) {
  const p = req.path;
  // Non-API paths bypass auth entirely (page routes, static, 404 fallback handle them)
  if (!p.startsWith('/v1/')) return next();
  if (PUBLIC_API(p)) return next();
  const adminKey = process.env.ADMIN_KEY || 'ks_admin_change_me';
  const header = req.headers.authorization || '';
  const xApi = req.headers['x-api-key'] || '';
  const key = header.replace(/^Bearer\s+/i, '').trim() || xApi || req.query.api_key;

  if (key === adminKey) {
    req.tenant = process.env.DEFAULT_TENANT || 'demo';
    req.is_admin = true;
    return next();
  }

  if (!key) return res.status(401).json({ error: 'missing api key', hint: 'set Authorization: Bearer <key> or X-API-Key header' });
  const t = findOne('tenants', x => x.api_key === key && !x._deleted);
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
  next();
}

// Lightweight billing increment. Call from billable handlers.
export function chargeUsage(tenant_record, units = 1) {
  if (!tenant_record) return;
  update('tenants', x => x.id === tenant_record.id, {
    used: (tenant_record.used || 0) + units,
    last_used_at: new Date().toISOString(),
  });
}

export function rateLimitStats() {
  const out = [];
  for (const [tid, b] of buckets) out.push({ tenant_id: tid, tokens: Math.floor(b.tokens), cap: b.cap });
  return out;
}
