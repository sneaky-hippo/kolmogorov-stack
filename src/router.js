// HTTP route definitions for all three layers + admin/utility/public routes.

import express from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { synthesize, synthesizeStream } from './synthesis.js';
import { handleAssistant } from './assistant.js';
import { effectiveReceiptSecret, isProductionRuntime, runtimeReadiness } from './env.js';
import * as registry from './registry.js';
import * as runtime from './runtime.js';
import * as cache from './cache.js';
import { authMiddleware, provisionTenant, provisionAnonTenant, claimAnonTenant, chargeUsage, rotateTenantKey, adminApiKey, findTenantByApiKey, findTenantByEmail, constantTimeEqual as constantTimeEq } from './auth.js';
import { mountOAuth, oauthConfigured } from './oauth.js';
import { sendWelcome, sendBillingActivated, sendBillingFailed, emailConfigured } from './email.js';
import { compileJs, verify } from './verifier.js';
import { LIBRARY_VERSION, libraryDescription } from './library.js';
import { all, findOne, insert, update, stats as storeStats } from './store.js';
import { verifiedInference } from './verified.js';
import { createJob, getJob, listJobs, runJob } from './compile.js';
import * as recall from './recall.js';
import { verifyStripeSignature, planFromAmount, appendCheckoutParams } from './stripe.js';
import {
  pickAnthropicUpstream,
  pickOpenAIUpstream,
  sanitizeNamespace,
  extractPromptForCapture,
  extractCompletionText,
  modelFromBody,
  forwardAnthropic,
  forwardOpenAI,
  promptHash,
} from './capture.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Per-IP rate limiters (S5, S10). Express trust-proxy must be set so the
// limiter can read X-Forwarded-For — Railway's edge sets it.
const signupLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,    // 24 hours
  max: parseInt(process.env.SIGNUP_LIMIT_PER_DAY || '40'), // shared-NAT friendly; defaults env-overridable.
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'rate_limited',
    detail: 'too many signups from this network in the last 24h',
    hint: 'behind a shared network or VPN? mail founders@kolm.ai for a direct invite',
    contact: 'founders@kolm.ai',
  },
  validate: { trustProxy: false },
});

const exportLimiter = rateLimit({
  windowMs: 60 * 1000,              // 1 minute
  max: 60,                          // 60 registry-exports per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited — registry export caps at 60/min/ip' },
  validate: { trustProxy: false },
});

const verifiedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,                          // 30 verified-inference calls per IP per minute (it's expensive)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited — verified inference caps at 30/min/ip' },
  validate: { trustProxy: false },
});

// Anonymous workspace bootstrap — bots can mint these without an email. Cap to
// prevent disk-DoS-by-tenant-row.
const anonLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many anon workspaces from this IP — try again tomorrow' },
  validate: { trustProxy: false },
});

const waitlistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited — waitlist caps at 10/hr/ip' },
  validate: { trustProxy: false },
});

const signinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited — sign-in caps at 30/5min/ip' },
  validate: { trustProxy: false },
});

const publishLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited — publish/verify caps at 20/min/ip' },
  validate: { trustProxy: false },
});

const PRICING = {
  synthesis_small: 0.10,   // < 1 KB generator
  synthesis_large: 1.00,   // 1 KB - 32 KB
  registry_per_gb_month: 0.01,
  registry_per_million_reads: 0.10,
  runtime_per_million: 0.20,
  runtime_cache_per_million: 0.05,
};

// Cryptographic receipts — every /v1/run call returns a signed proof that
// (source, input) → output. Anyone can re-verify with /v1/receipts/verify.
// This is the attestation layer that distinguishes signed artifacts from a raw LLM call.
const RECEIPT_VERSION = 'rs-1';
// Production logs a stern warning if the secret isn't set (and refuses to
// issue or verify receipts), but still boots so static pages stay reachable.
// Dev uses a known fallback for local hacking / smoke tests.
const RECEIPT_SECRET = (() => {
  const s = effectiveReceiptSecret();
  if (s) return s;
  if (isProductionRuntime()) {
    console.error('[router] WARNING: RECIPE_RECEIPT_SECRET not set — receipt endpoints will 503. Set it on Railway env.');
    return null;
  }
  return null;
})();

function sha256(s) {
  return crypto.createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');
}

function canonicalJson(v) {
  // Stable JSON: keys sorted at every depth — required so identical inputs hash identically.
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

function buildReceipt({ source_hash, input, output, version_id, latency_us, cache_hit }) {
  const input_hash = sha256(canonicalJson(input));
  const output_hash = sha256(canonicalJson(output));
  const issued_at = new Date().toISOString();
  const payload = {
    spec: RECEIPT_VERSION,
    source_hash: source_hash || null,
    input_hash,
    output_hash,
    version_id,
    runtime_version: LIBRARY_VERSION,
    issued_at,
    cache_hit: !!cache_hit,
    latency_us: latency_us || 0,
  };
  if (!RECEIPT_SECRET) return { ...payload, hmac: null, _error: 'receipt secret unavailable' };
  const canonical = canonicalJson(payload);
  const hmac = crypto.createHmac('sha256', RECEIPT_SECRET).update(canonical).digest('hex');
  return { ...payload, hmac };
}

function verifyReceipt(receipt) {
  if (!RECEIPT_SECRET) return { valid: false, reason: 'receipt secret unavailable on this server' };
  if (!receipt || typeof receipt !== 'object') return { valid: false, reason: 'no receipt' };
  if (receipt.spec !== RECEIPT_VERSION) return { valid: false, reason: 'unknown spec ' + receipt.spec };
  const { hmac, ...payload } = receipt;
  if (!hmac) return { valid: false, reason: 'no hmac' };
  const expected = crypto.createHmac('sha256', RECEIPT_SECRET).update(canonicalJson(payload)).digest('hex');
  // Constant-time compare.
  if (hmac.length !== expected.length) return { valid: false, reason: 'hmac mismatch' };
  let diff = 0;
  for (let i = 0; i < hmac.length; i++) diff |= hmac.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? { valid: true } : { valid: false, reason: 'hmac mismatch' };
}

export function buildRouter() {
  const r = express.Router();

  // CORS — allow SDKs from any origin to hit the API
  r.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Security headers
  r.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Frame-Options', 'DENY');
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // Public /health — no provider-key leakage. Authenticated callers can
  // hit /v1/health for the full snapshot including backend availability.
  r.get('/health', (req, res) => res.json({
    status: 'ok',
    version: '0.2.0',
    library_version: LIBRARY_VERSION,
    region: process.env.RAILWAY_REGION || process.env.REGION || 'local',
    uptime_s: Math.round(process.uptime()),
    stats: storeStats(),
  }));

  // Deploy readiness: public, low-detail, and suitable for platform health
  // gates. /health stays green for static uptime; /ready fails when critical
  // production-only configuration is missing.
  r.get('/ready', (_req, res) => {
    const ready = runtimeReadiness();
    res.status(ready.status === 'ready' ? 200 : 503).json({
      status: ready.status,
      production_like: ready.production_like,
      checks: ready.checks.map(({ name, ok, required, public: label }) => ({
        name,
        ok,
        required,
        label,
      })),
    });
  });

  r.get('/v1/pricing', (_req, res) => res.json({ currency: 'USD', units: PRICING }));

  // ---------- Plan catalog ----------
  // Single source of truth for self-serve signup + plan-change. Mirrors
  // /pricing exactly. STRIPE_PAYMENT_LINK_<PLAN> env vars wire each paid
  // plan to a Stripe Payment Link (operator-supplied; absent => billing_url
  // is null and the tenant is provisioned with a 30-day trial banner).
  const PLAN_CATALOG = {
    free:       { id: 'free',       label: 'Developer',  price_usd_month: 0,    quota: 10000,    seats: 1,   billing_env: null,                          stripe_link_env: null },
    starter:    { id: 'starter',    label: 'Starter',    price_usd_month: 9,    quota: 50000,    seats: 1,   billing_env: 'STRIPE_PAYMENT_LINK_STARTER', stripe_link_env: 'STRIPE_PAYMENT_LINK_STARTER' },
    pro:        { id: 'pro',        label: 'Pro',        price_usd_month: 49,   quota: 200000,   seats: 1,   billing_env: 'STRIPE_PAYMENT_LINK_PRO',     stripe_link_env: 'STRIPE_PAYMENT_LINK_PRO' },
    teams:      { id: 'teams',      label: 'Teams',      price_usd_month: 149,  quota: 1000000,  seats: 5,   billing_env: 'STRIPE_PAYMENT_LINK_TEAMS',     stripe_link_env: 'STRIPE_PAYMENT_LINK_TEAMS' },
    business:   { id: 'business',   label: 'Business',   price_usd_month: 1499, quota: 5000000,  seats: 25,  billing_env: 'STRIPE_PAYMENT_LINK_BUSINESS', stripe_link_env: 'STRIPE_PAYMENT_LINK_BUSINESS' },
    enterprise: { id: 'enterprise', label: 'Enterprise', price_usd_month: 2999, quota: 10000000, seats: 25,  billing_env: 'STRIPE_PAYMENT_LINK_ENT',       stripe_link_env: 'STRIPE_PAYMENT_LINK_ENT' },
  };
  const PLAN_IDS = new Set(Object.keys(PLAN_CATALOG));

  function billingLinkFor(planId, opts = {}) {
    const env = PLAN_CATALOG[planId]?.stripe_link_env;
    if (!env) return null;
    const url = process.env[env];
    if (!url || !/^https?:\/\//.test(url)) return null;
    return appendCheckoutParams(url, opts);
  }

  r.get('/v1/plans', (_req, res) => {
    const plans = Object.values(PLAN_CATALOG).map(p => ({
      id: p.id,
      label: p.label,
      price_usd_month: p.price_usd_month,
      quota: p.quota,
      seats: p.seats,
      self_serve: true,
      billing_link_configured: !!billingLinkFor(p.id),
    }));
    res.json({ plans });
  });

  // ---------- OAuth (Google + GitHub) ----------
  // Each provider is a no-op until its CLIENT_ID/CLIENT_SECRET pair is
  // configured. /v1/oauth/providers reports which are live.
  mountOAuth(r);

  // ---------- Anonymous CLI auth (robots / agents) ----------
  // Bootstrap: returns an anon_token that the CLI stores locally. 30-day TTL.
  // No email, no signup. Designed for agents that need to start working in <1 second.
  r.post('/v1/anon/bootstrap', anonLimiter, (req, res) => {
    const { user_agent, hostname } = req.body || {};
    const t = provisionAnonTenant({ ttl_days: 30, quota: 1000 });
    res.json({
      anon_token: t.api_key,
      tenant_id: t.id,
      kind: 'anon',
      expires_at: t.expires_at,
      quota: t.quota,
      message: 'anonymous workspace ready. expires in 30 days. run `kolm claim --email you@co.com` to keep your work permanently.',
      hint: { user_agent: user_agent || null, hostname: hostname || null },
    });
  });

  // Claim: convert an anonymous workspace into a permanent account.
  // - if email matches an existing real tenant: merge the anon's recipes into it, return existing key
  // - else: upgrade the anon tenant in-place to a real tenant, rotate to ks_*, return new key
  r.post('/v1/anon/claim', (req, res) => {
    const { anon_token, email, name } = req.body || {};
    if (!anon_token || !anon_token.startsWith('kao_')) return res.status(400).json({ error: 'anon_token required (starts with kao_)' });
    const result = claimAnonTenant(anon_token, { email, name });
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json({
      mode: result.mode,
      api_key: result.api_key,
      tenant: { id: result.tenant.id, name: result.tenant.name, plan: result.tenant.plan, quota: result.tenant.quota },
      message: result.mode === 'merged'
        ? 'merged your anonymous recipes into your existing account.'
        : 'upgraded. save this key. you can rotate it from /v1/account/rotate-key.',
    });
  });

  // ---------- Public signup ----------
  // Rate-limited (S5): 10 signups per IP per 24h. INVITE_ONLY=true hard-disables
  // public signup entirely (CLI bootstrap and admin issue still work).
  r.post('/v1/signup', signupLimiter, (req, res) => {
    if (process.env.INVITE_ONLY === 'true') {
      return res.status(403).json({ error: 'public signup disabled — invite required' });
    }
    const { email, name, plan: rawPlan } = req.body || {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'valid email required' });
    }
    // Plan-aware self-serve signup. Free is provisioned immediately. For paid
    // plans, we provision the tenant on the FREE quota and record a
    // `pending_plan` flag; the Stripe webhook flips the plan to the requested
    // tier on `checkout.session.completed`. This means nobody gets paid
    // features without paying.
    const planLower = (rawPlan || 'free').toString().toLowerCase();
    const requestedPlan = PLAN_IDS.has(planLower) ? planLower : 'free';
    const requestedMeta = PLAN_CATALOG[requestedPlan];
    const isPaid = requestedMeta.price_usd_month > 0;
    const slug = (name || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'user';
    const uniq = `${slug}-${Date.now().toString(36).slice(-4)}`;

    // Always provision on free quota; webhook upgrades after payment.
    const provisionedPlan = isPaid ? 'free' : requestedPlan;
    const provisionedMeta = PLAN_CATALOG[provisionedPlan];
    const t = provisionTenant(uniq, { quota: provisionedMeta.quota, plan: provisionedPlan, email });

    let billingUrl = null;
    if (isPaid) {
      billingUrl = billingLinkFor(requestedPlan, { tenantId: t.id, email });
      try { update('tenants', x => x.id === t.id, { pending_plan: requestedPlan, billing_status: 'pending' }); } catch (_) {}
    }
    // Best-effort welcome email — never blocks signup.
    if (emailConfigured()) {
      sendWelcome({ email, apiKey: t.api_key, plan: provisionedPlan, billingUrl }).catch(() => {});
    }

    res.status(201).json({
      tenant: {
        id: t.id,
        name: t.name,
        plan: provisionedPlan,
        quota: provisionedMeta.quota,
        seats: provisionedMeta.seats,
        pending_plan: isPaid ? requestedPlan : null,
      },
      api_key: t.api_key,
      billing_url: billingUrl,
      billing_required: isPaid,
      message: !isPaid
        ? 'Save this key. You can rotate it from /v1/account/rotate-key or upgrade with /v1/account/change-plan.'
        : (billingUrl
            ? `Save this key. Complete payment at ${billingUrl} to activate your ${requestedMeta.label} tier. Until payment is confirmed your account is on the Developer (free) tier.`
            : `Save this key. Billing for the ${requestedMeta.label} tier is not yet enabled by the operator; your account is on the Developer (free) tier.`),
    });
  });

  // ---------- Signin / Signout aliases (RS-1 contract) ----------
  // /v1/signin and /v1/signout mirror /v1/session/login and /v1/session/logout
  // for the homepage contract. POST {api_key} returns the same shape and sets
  // the same kolm_session cookie. /v1/signout returns 204 to be friendly to
  // CLI tools that ignore body.
  r.post('/v1/signin', signinLimiter, (req, res) => {
    const { api_key, email, password } = req.body || {};
    // Email/password is reserved for the future; today only api_key works.
    if (!api_key || typeof api_key !== 'string') {
      if (email || password) {
        return res.status(501).json({ error: 'email/password signin not implemented', hint: 'pass api_key in the body' });
      }
      return res.status(400).json({ error: 'api_key required' });
    }
    const t = findTenantByApiKey(api_key);
    const adminKey = adminApiKey();
    const isAdmin = !!adminKey && constantTimeEq(api_key, adminKey);
    if (!t && !isAdmin) return res.status(401).json({ error: 'invalid api key' });
    const isProd = isProductionRuntime();
    res.cookie('kolm_session', api_key, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });
    res.json({
      ok: true,
      api_key,
      tenant: t ? { id: t.id, name: t.name, plan: t.plan } : { admin: true },
    });
  });

  r.post('/v1/signout', (req, res) => {
    res.clearCookie('kolm_session', { path: '/' });
    res.status(204).end();
  });

  // ---------- Session cookie (S7) ----------
  // POST a key here to set an httpOnly `kolm_session` cookie. Browsers can
  // then call /v1/* without exposing the key to JavaScript. The legacy
  // localStorage path still works, but new pages should call /v1/session/login
  // and rely on the cookie.
  r.post('/v1/session/login', signinLimiter, (req, res) => {
    const { api_key } = req.body || {};
    if (!api_key || typeof api_key !== 'string') {
      return res.status(400).json({ error: 'api_key required' });
    }
    const t = findTenantByApiKey(api_key);
    const adminKey = adminApiKey();
    const isAdmin = !!adminKey && constantTimeEq(api_key, adminKey);
    if (!t && !isAdmin) return res.status(401).json({ error: 'invalid api key' });
    const isProd = isProductionRuntime();
    res.cookie('kolm_session', api_key, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      path: '/',
    });
    res.json({ ok: true, tenant: t ? { id: t.id, name: t.name, plan: t.plan } : { admin: true } });
  });

  r.post('/v1/session/logout', (req, res) => {
    res.clearCookie('kolm_session', { path: '/' });
    res.json({ ok: true });
  });

  // ---------- Public registry browsing — no auth needed for visibility=public ----------
  r.get('/v1/public/concepts', (_req, res) => {
    const concepts = registry.listConcepts({ tenant: '__public__', limit: 200 })
      .filter(c => c.visibility === 'public');
    res.json({ concepts });
  });

  r.get('/v1/public/concepts/:id', (req, res) => {
    const c = registry.getConcept(req.params.id, '__public__');
    if (!c || c.visibility !== 'public') return res.status(404).json({ error: 'not found' });
    res.json(c);
  });

  // Public read-only run for any public concept (lets unauth visitors try the runtime)
  r.post('/v1/public/run', async (req, res) => {
    const { concept_id, version_id, input, receipt: wantReceipt = true } = req.body || {};
    try {
      let target = null;
      if (version_id) {
        const v = findOne('versions', x => x.id === version_id);
        if (!v) return res.status(404).json({ error: 'version not found' });
        const c = findOne('concepts', x => x.id === v.concept_id);
        if (!c || c.visibility !== 'public') return res.status(403).json({ error: 'not public' });
        target = { version_id };
      } else if (concept_id) {
        const c = findOne('concepts', x => x.id === concept_id);
        if (!c || c.visibility !== 'public') return res.status(403).json({ error: 'not public' });
        target = { concept_id };
      } else return res.status(400).json({ error: 'concept_id or version_id required' });
      const r2 = target.version_id
        ? await runtime.runVersion({ version_id: target.version_id, input, tenant: '__public__' })
        : await runtime.runConcept({ concept_id: target.concept_id, input, tenant: '__public__' });
      if (wantReceipt) {
        r2.receipt = buildReceipt({
          source_hash: r2.source_hash,
          input,
          output: r2.output,
          version_id: r2.version_id,
          latency_us: r2.latency_us,
          cache_hit: r2.cache,
        });
      }
      res.json(r2);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  // Public receipt verification — anyone can verify any receipt, no auth.
  // The whole point of receipts is offline, third-party-verifiable proof.
  // Accepts both the legacy v0 receipt (rs-1 spec, hmac field) and the new
  // v0.1 receipt (kolm_version="0.1", chain[], signature). Also accepts
  // {artifact_hash, signature} drive-by shape used by lightweight callers.
  r.post('/v1/receipts/verify', (req, res) => {
    if (!RECEIPT_SECRET) return res.status(503).json({ error: 'receipt secret not configured on this server' });
    const { receipt, input, output, artifact_hash: bodyArtifactHash, signature: bodySignature } = req.body || {};
    const reasons = [];

    // Drive-by: caller supplied just artifact_hash + signature without a
    // full receipt envelope. Verify the signature is a hex HMAC binding the
    // artifact_hash under our secret. This is the shape the homepage demo
    // posts and the contract requires.
    if (!receipt && bodyArtifactHash && bodySignature) {
      const expected = crypto.createHmac('sha256', RECEIPT_SECRET)
        .update(canonicalJson({ artifact_hash: bodyArtifactHash }))
        .digest('hex');
      const match = bodySignature.length === expected.length && (() => {
        let d = 0;
        for (let i = 0; i < expected.length; i++) d |= bodySignature.charCodeAt(i) ^ expected.charCodeAt(i);
        return d === 0;
      })();
      if (!match) reasons.push('signature mismatch');
      return res.json({ verified: match, reasons, mode: 'drive-by' });
    }

    if (!receipt || typeof receipt !== 'object') {
      reasons.push('no receipt');
      return res.json({ verified: false, reasons });
    }

    // v0.1 receipt — chain + signature over canonicalised body.
    if (receipt.kolm_version === '0.1') {
      // Verify chain links: each step's HMAC must seal {step, input_hash, output_hash}.
      let chainOk = Array.isArray(receipt.chain) && receipt.chain.length > 0;
      if (chainOk) {
        for (let i = 0; i < receipt.chain.length; i++) {
          const link = receipt.chain[i];
          const expected = crypto.createHmac('sha256', RECEIPT_SECRET)
            .update(canonicalJson({ step: link.step, input_hash: link.input_hash, output_hash: link.output_hash }))
            .digest('hex');
          if (link.hmac !== expected) { reasons.push('chain[' + i + '] hmac mismatch'); chainOk = false; break; }
          if (i > 0 && link.input_hash !== receipt.chain[i - 1].output_hash) {
            reasons.push('chain[' + i + '] not anchored to chain[' + (i - 1) + ']');
            chainOk = false; break;
          }
        }
      } else {
        reasons.push('chain missing');
      }
      // Verify body signature.
      const { signature, ...bodyNoSig } = receipt;
      const bodyCanon = canonicalJson(bodyNoSig);
      const expectedBody = crypto.createHmac('sha256', RECEIPT_SECRET).update(bodyCanon).digest('hex');
      const sigOk = signature && signature.length === expectedBody.length && (() => {
        let d = 0;
        for (let i = 0; i < expectedBody.length; i++) d |= signature.charCodeAt(i) ^ expectedBody.charCodeAt(i);
        return d === 0;
      })();
      if (!sigOk) reasons.push('signature mismatch');
      const verified = chainOk && sigOk;
      return res.json({
        verified,
        reasons,
        receipt_id: receipt.receipt_id,
        artifact_hash: receipt.artifact_hash,
        eval_set_hash: receipt.eval_set_hash,
        eval_score: receipt.eval_score,
        judge_id: receipt.judge_id,
      });
    }

    // Legacy v0 receipt (rs-1, hmac).
    const v = verifyReceipt(receipt);
    if (!v.valid) {
      return res.json({ verified: false, valid: false, reason: v.reason, reasons: [v.reason] });
    }
    const checks = { signature: true };
    if (input !== undefined) checks.input_match = sha256(canonicalJson(input)) === receipt.input_hash;
    if (output !== undefined) checks.output_match = sha256(canonicalJson(output)) === receipt.output_hash;
    const allOk = Object.values(checks).every(Boolean);
    res.json({ verified: allOk, valid: allOk, checks, receipt, reasons: allOk ? [] : ['input/output mismatch'] });
  });

  // Public RS-1 spec document — open standard, no auth required.
  r.get('/v1/spec', (_req, res) => {
    res.json({
      spec: RECEIPT_VERSION,
      name: 'RS-1 Behavior Spec',
      version: '1.0.0-draft',
      title: 'RS-1: A portable, attestable contract for AI behavior',
      description: 'An open standard for declaring AI behaviors as deterministic, signed, executable specifications. ' +
        'A behavior spec is examples in, behavior out — and every execution carries a cryptographic receipt that proves which code ran on which input.',
      license: 'MIT',
      reference_implementation: 'https://kolm.ai',
      sections: {
        recipe: {
          id: 'string (cpt_…)',
          name: 'string',
          version: 'semver',
          source_hash: 'sha256 (16 hex chars) of the executable source',
          source: 'string (executable JS or WASM:base64)',
          schema: { input: 'JSON Schema (optional)', output: 'JSON Schema (optional)' },
          examples: [{ input: 'any', expected: 'any' }],
          evaluation: {
            quality_score: 'number 0..1',
            pass_rate_positive: 'number 0..1',
            reject_rate_negative: 'number 0..1',
            latency_p50_us: 'integer',
          },
        },
        receipt: {
          spec: RECEIPT_VERSION,
          source_hash: 'sha256-16',
          input_hash: 'sha256-64 of canonical JSON of input',
          output_hash: 'sha256-64 of canonical JSON of output',
          version_id: 'string (ver_…)',
          runtime_version: 'semver of the runtime that produced this output',
          issued_at: 'ISO 8601 timestamp',
          hmac: 'HMAC-SHA256 over canonical-JSON payload, hex',
        },
        canonical_json: 'Keys sorted lexicographically at every depth. Numbers, strings, booleans, null, arrays, objects only. No NaN/Infinity. No trailing whitespace.',
      },
      conformance: {
        endpoints_required: ['POST /v1/synthesize', 'POST /v1/run', 'POST /v1/receipts/verify', 'GET /v1/spec'],
        determinism: 'For a given (source_hash, input_hash), output_hash MUST match across runtimes.',
        verifiability: 'Receipts MUST be re-verifiable using only the public canonical-JSON algorithm and the issuing runtime\'s public key (or shared HMAC for symmetric mode).',
      },
      compatibility: {
        eu_ai_act_2026: 'Receipts provide auditable behavior logs required under Articles 12 and 50.',
        soc2: 'Receipts can serve as evidence for change-management controls when stored alongside source.',
      },
      authors: ['Kolmogorov Stack contributors'],
    });
  });

  // Public registry export — the registry IS the model, downloaded not called.
  // A device with this bundle can run every public recipe locally, offline,
  // forever, for free. Returns a portable JSON envelope of all public recipes
  // with their executable source. This is the on-device runtime payload.
  r.get('/v1/registry/export', exportLimiter, (_req, res) => {
    const concepts = all('concepts').filter(c => c.visibility === 'public');
    const versions = all('versions');
    const recipes = [];
    for (const c of concepts) {
      const vs = versions.filter(v => v.concept_id === c.id).sort((a, b) =>
        new Date(b.created_at || 0) - new Date(a.created_at || 0));
      if (!vs.length) continue;
      const v = vs[0];
      if (!v.source) continue;
      recipes.push({
        id: c.id,
        name: c.name,
        description: c.description || c.name,
        tags: c.tags || [],
        schema: c.schema || null,
        source: v.source,
        source_hash: v.evaluation?.source_hash || null,
        version_id: v.id,
        pass_rate_positive: v.evaluation?.pass_rate_positive ?? null,
        latency_p50_us: v.evaluation?.latency_p50_us ?? null,
        size_bytes: v.evaluation?.size_bytes ?? (v.source ? v.source.length : null),
      });
    }
    const exported_at = new Date().toISOString();
    const registry_hash = sha256(canonicalJson({ recipes, exported_at: '' })).slice(0, 16);
    const total_bytes = recipes.reduce((s, r) => s + (r.size_bytes || 0), 0);
    res.set('Cache-Control', 'public, max-age=120');
    res.json({
      spec: RECEIPT_VERSION,
      exported_at,
      runtime_version: LIBRARY_VERSION,
      registry_hash,
      recipes_n: recipes.length,
      total_bytes,
      recipes,
    });
  });

  // The wrap surface — what `recipe.wrap(client).messages.create({...})` calls.
  //
  // Same generator-verifier asymmetry as /v1/verified-inference, but shaped
  // around the user's existing messages.create payload. The user's request
  // looks identical to a normal Anthropic call; we add `verified` and
  // optional `corpus_namespace` keys, run k samples, score them against
  // the test cases (or recipe-as-judge), and return the winner shaped as
  // a messages.create response — so the wrap is a drop-in.
  //
  // If `corpus_namespace` is set, we ask the tenant's Recall index for the
  // top-k chunks for the most-recent user message and prepend them as a
  // system context block. This is the "ground every Distill call in the
  // user's corpus" promise from the plan.
  r.post('/v1/wrap/verified', verifiedLimiter, authMiddleware, async (req, res) => {
    try {
      const { messages, system, model, max_tokens, temperature, verified, corpus_namespace } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array required' });
      }
      if (!verified || typeof verified !== 'object') {
        return res.status(400).json({ error: 'verified opts required: { k, test_cases } or { judge_recipe_id, expected }' });
      }
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'wrap/verified requires ANTHROPIC_API_KEY on the server' });
      }

      const k = Math.min(verified.k || 4, 64);

      // Pull the textual user prompt from the messages array (last user turn).
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const userText = !lastUser ? '' : (typeof lastUser.content === 'string'
        ? lastUser.content
        : (lastUser.content || []).map(c => c.text || '').join('\n'));

      // Optional Recall grounding — fetch top-k chunks and prepend.
      let groundedSystem = system || '';
      let recall_chunks = [];
      if (corpus_namespace) {
        try {
          recall_chunks = await recall.query({ tenant: req.tenant, namespace: corpus_namespace, query: userText, k: 8 });
        } catch (e) { /* graceful degrade */ }
        if (recall_chunks.length) {
          const ctx = recall_chunks.map((c, i) => `[${i + 1}] ${c.path || 'chunk'}\n${c.snippet || ''}`).join('\n\n');
          groundedSystem = (groundedSystem ? groundedSystem + '\n\n' : '')
            + '## Context from your corpus\n' + ctx
            + '\n\nUse the above context where relevant. Cite by number.';
        }
      }

      // Test-cases mode — the headline shape.
      if (Array.isArray(verified.test_cases) && verified.test_cases.length) {
        const result = await verifiedInference({
          prompt: userText,
          system: groundedSystem || undefined,
          test_cases: verified.test_cases,
          k,
          model,
          temperature,
        });
        // Shape it like messages.create — a single content block with the chosen source.
        return res.json({
          id: 'wrap_' + crypto.randomBytes(6).toString('hex'),
          model: result.receipt.model,
          role: 'assistant',
          stop_reason: result.verified ? 'end_turn' : 'verifier_unsatisfied',
          content: [{ type: 'text', text: result.chosen?.source || '' }],
          // wrap-specific extras kept under `_kolm` so a naive consumer
          // sees the standard shape and a curious one finds the receipt.
          _kolm: {
            verified: result.verified,
            chosen: result.chosen,
            candidates: result.candidates,
            cost_usd: result.cost_usd,
            elapsed_ms: result.elapsed_ms,
            recall_chunks: recall_chunks.length,
            receipt: result.receipt,
          },
        });
      }

      // Recipe-as-judge mode — accept candidates that the verifier recipe approves.
      if (verified.judge_recipe_id || verified.judge_version_id) {
        const out = await import('./verified.js').then(m => m.recipeAsJudge({
          prompt: userText,
          system: groundedSystem || undefined,
          verifier_concept_id: verified.judge_recipe_id,
          verifier_version_id: verified.judge_version_id,
          expected: verified.expected,
          k, model, temperature,
          tenant: req.tenant,
        }));
        return res.json({
          id: 'wrap_' + crypto.randomBytes(6).toString('hex'),
          model: model || process.env.ANTHROPIC_MODEL || 'claude-opus-4-7',
          role: 'assistant',
          stop_reason: out.verified ? 'end_turn' : 'verifier_unsatisfied',
          content: [{ type: 'text', text: out.chosen?.text || '' }],
          _kolm: {
            verified: out.verified,
            candidates_passed: out.candidates_passed,
            candidates_n: out.candidates_n,
            recall_chunks: recall_chunks.length,
            receipt: out.receipt,
          },
        });
      }

      return res.status(400).json({ error: 'verified must include test_cases OR judge_recipe_id/judge_version_id+expected' });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  // Verified-inference endpoint — Generator-Verifier asymmetry made shippable.
  // Sample k candidates from a frontier model, run each through a deterministic
  // Recipe verifier (test cases), pick the first that passes. Returns a receipt.
  // P(correct) >= 1 - (1 - p*v)^k. For p=0.91 v=1 k=8: 99.9999%.
  // Uses the server's ANTHROPIC_API_KEY, so a tenant API key is required.
  r.post('/v1/verified-inference', verifiedLimiter, authMiddleware, async (req, res) => {
    try {
      const { prompt, signature, test_cases, k = 8, model, temperature, system } = req.body || {};
      if (!Array.isArray(test_cases) || test_cases.length === 0) {
        return res.status(400).json({ error: 'test_cases array required: each {input, expected}' });
      }
      if (k > 64) return res.status(400).json({ error: 'k capped at 64 for the public endpoint' });
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'verified-inference requires ANTHROPIC_API_KEY on the server' });
      }
      const result = await verifiedInference({ prompt, signature, test_cases, k, model, temperature, system });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  r.use(authMiddleware);

  // Authenticated /v1/health — full snapshot including provider availability
  // and feature flags. Admin-only because the booleans are useful signal for
  // staff debugging but unnecessary surface for tenants. Public /health
  // (above the authMiddleware) is the lightweight no-leak version.
  r.get('/v1/health', (req, res) => {
    if (!req.is_admin) {
      return res.status(403).json({ error: 'admin only', hint: 'public /health is open; /v1/health is staff-only' });
    }
    res.json({
      status: 'ok',
      version: '0.2.0',
      library_version: LIBRARY_VERSION,
      region: process.env.RAILWAY_REGION || process.env.REGION || 'local',
      uptime_s: Math.round(process.uptime()),
      stats: storeStats(),
      feature_flags: {
        has_anthropic_key: !!process.env.ANTHROPIC_API_KEY,
        receipt_secret_configured: !!process.env.RECIPE_RECEIPT_SECRET,
        invite_only: process.env.INVITE_ONLY === 'true',
        recall_root_set: !!process.env.KOLM_RECALL_ROOT,
        artifact_dir_set: !!process.env.KOLM_ARTIFACT_DIR,
        sync_compile_only: !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
      },
      readiness: runtimeReadiness(),
      tenant: { admin: true },
    });
  });

  // ---------- Compile (kolm) ----------
  // POST /v1/compile          → start a compile job, returns { job_id }
  // GET  /v1/compile/:id      → status snapshot
  // GET  /v1/compile/:id/.kolm → download the artifact
  // GET  /v1/compile           → list this tenant's jobs
  r.post('/v1/compile', async (req, res) => {
    const { task, examples = [], corpus_namespace, base_model } = req.body || {};
    if (!task || typeof task !== 'string') return res.status(400).json({ error: 'task (string) required' });
    if (task.length > 4000) return res.status(400).json({ error: 'task description too long (>4000 chars)' });
    if (examples && (!Array.isArray(examples) || examples.length > 200)) {
      return res.status(400).json({ error: 'examples must be an array with ≤200 entries' });
    }
    const job = createJob({ task, examples, corpus_namespace, base_model, tenant: req.tenant });
    const ctx = {
      synthesize,
      publicRecipes: () => {
        const concepts = all('concepts').filter(c => c.visibility === 'public');
        const versions = all('versions');
        const out = [];
        for (const c of concepts) {
          const vs = versions.filter(v => v.concept_id === c.id).sort((a, b) =>
            new Date(b.created_at || 0) - new Date(a.created_at || 0));
          if (!vs.length || !vs[0].source) continue;
          out.push({
            id: c.id, name: c.name,
            source: vs[0].source,
            source_hash: vs[0].evaluation?.source_hash || null,
            version_id: vs[0].id,
            tags: c.tags || [],
            schema: c.schema || null,
          });
        }
        return out;
      },
      examples,
      recall: {
        query: ({ namespace, query, k }) => recall.query({ tenant: req.tenant, namespace, query, k }),
      },
      outDir: process.env.KOLM_ARTIFACT_DIR,
    };
    // On serverless platforms the function instance is killed shortly after
    // res.end(), so a fire-and-forget runJob would never complete. Await it
    // there; on long-running self-hosted nodes, fire and forget for snappy
    // 202s. The pattern-mode synthesizer typically finishes in <1s.
    const ON_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    if (ON_SERVERLESS || req.query.sync === '1') {
      try { await runJob(job, ctx); } catch (e) { /* runJob persists its own error state */ }
      const fresh = getJob(job.id, req.tenant) || job;
      return res.status(202).json({ job_id: fresh.id, status: fresh.status, poll: `/v1/compile/${fresh.id}` });
    }
    setImmediate(() => runJob(job, ctx));
    res.status(202).json({ job_id: job.id, status: job.status, poll: `/v1/compile/${job.id}` });
  });

  r.get('/v1/compile', (req, res) => {
    res.json({ jobs: listJobs(req.tenant, 50) });
  });

  r.get('/v1/compile/:id', (req, res) => {
    const j = getJob(req.params.id, req.is_admin ? null : req.tenant);
    if (!j) return res.status(404).json({ error: 'job not found' });
    const { artifact_path, ...safe } = j;  // never leak local path
    res.json({ ...safe, artifact_url: j.status === 'completed' ? `/v1/compile/${j.id}/.kolm` : null });
  });

  r.get('/v1/compile/:id/.kolm', (req, res) => {
    const j = getJob(req.params.id, req.is_admin ? null : req.tenant);
    if (!j) return res.status(404).json({ error: 'job not found' });
    if (j.status !== 'completed') return res.status(409).json({ error: 'artifact not ready', status: j.status, progress: j.progress });
    if (!j.artifact_path || !fs.existsSync(j.artifact_path)) return res.status(410).json({ error: 'artifact expired or missing' });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${j.id}.kolm"`);
    fs.createReadStream(j.artifact_path).pipe(res);
  });

  // ---------- /v1/artifacts* — RS-1 contract aliases over compile jobs ----------
  // Every completed compile job IS an artifact. This surface gives callers
  // an artifact-noun view that doesn't leak the job machinery.
  function jobToArtifact(j) {
    return {
      id: j.id,
      name: (j.task || '').slice(0, 200) || j.id,
      tier: j.manifest?.tier || 'recipe',
      status: j.status,
      created_at: j.created_at,
      completed_at: j.completed_at || null,
      bytes: j.artifact_bytes || null,
      base_model: j.base_model || j.manifest?.base_model || null,
      artifact_hash: j.artifact_hash || null,
      eval_set_hash: j.eval_set_hash || null,
      eval_score: j.manifest?.eval_score ?? null,
      judge_id: j.manifest?.judge_id || null,
      k_score: j.k_score || null,
      manifest: j.manifest || null,
      receipt: j.receipt || null,
      download_url: j.status === 'completed' ? `/v1/artifacts/${j.id}/download` : null,
    };
  }

  r.get('/v1/artifacts', (req, res) => {
    const jobs = listJobs(req.tenant, 50).filter(j => j.status === 'completed');
    res.json({ artifacts: jobs.map(jobToArtifact), n: jobs.length });
  });

  r.get('/v1/artifacts/:id', (req, res) => {
    const j = getJob(req.params.id, req.is_admin ? null : req.tenant);
    if (!j) return res.status(404).json({ error: 'artifact not found' });
    res.json(jobToArtifact(j));
  });

  r.get('/v1/artifacts/:id/download', (req, res) => {
    const j = getJob(req.params.id, req.is_admin ? null : req.tenant);
    if (!j) return res.status(404).json({ error: 'artifact not found' });
    if (j.status !== 'completed') return res.status(409).json({ error: 'artifact not ready', status: j.status });
    if (!j.artifact_path || !fs.existsSync(j.artifact_path)) return res.status(410).json({ error: 'artifact expired or missing' });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${j.id}.kolm"`);
    fs.createReadStream(j.artifact_path).pipe(res);
  });

  // /v1/registry/public — RS-1 contract alias over public concepts. Non-paginated;
  // returns up to 200 of the most recent public concepts. The richer export
  // (with bundled source) lives at /v1/registry/export above.
  r.get('/v1/registry/public', (_req, res) => {
    const concepts = all('concepts').filter(c => c.visibility === 'public');
    const versions = all('versions');
    const out = concepts.slice(-200).reverse().map(c => {
      const v = versions.find(x => x.id === c.head_version);
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        tags: c.tags || [],
        head_version: c.head_version,
        size_bytes: v?.evaluation?.size_bytes ?? null,
        latency_p50_us: v?.evaluation?.latency_p50_us ?? null,
        quality_score: v?.evaluation?.quality_score ?? null,
        updated_at: c.updated_at,
      };
    });
    res.json({ artifacts: out, n: out.length });
  });

  // ---------- Recall ----------
  // Hybrid query against the tenant's qmd-indexed corpus. Returns top-k chunks.
  // The compile orchestrator calls the same surface internally; this is the
  // public route for à la carte usage and for the kolm CLI's `kolm recall`.
  r.post('/v1/recall', async (req, res) => {
    const { namespace, query, k } = req.body || {};
    if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query (string) required' });
    if (k !== undefined && (typeof k !== 'number' || k < 1 || k > 100)) {
      return res.status(400).json({ error: 'k must be a number between 1 and 100' });
    }
    try {
      const chunks = await recall.query({ tenant: req.tenant, namespace, query, k: k || 12 });
      res.json({ namespace: namespace || 'default', n: chunks.length, chunks });
    } catch (e) {
      res.status(500).json({ error: 'recall failed', detail: String(e.message || e) });
    }
  });

  // Tokenize-and-ingest a path (or array of paths). The path must live on the
  // server; for now we support self-host where the kolm cloud runs alongside
  // a tenant's mounted corpus directory. For the SaaS path we'll add an
  // upload endpoint in Sprint 2.
  r.post('/v1/embed', async (req, res) => {
    const { namespace, paths, force } = req.body || {};
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths (non-empty array) required' });
    }
    if (paths.length > 64) {
      return res.status(400).json({ error: 'paths too long — max 64 per request' });
    }
    // Constrain to per-tenant root under KOLM_RECALL_ROOT. Admins can ingest
    // anywhere on the box; tenants only see their own slice.
    const recallRoot = process.env.KOLM_RECALL_ROOT || os.tmpdir();
    const tenantRoot = path.resolve(recallRoot, req.tenant || '_anon');
    for (const p of paths) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) {
        return res.status(400).json({ error: 'paths must be absolute strings' });
      }
      const resolved = path.resolve(p);
      if (!req.is_admin && !resolved.startsWith(tenantRoot + path.sep) && resolved !== tenantRoot) {
        return res.status(403).json({ error: 'path outside tenant recall root', tenant_root: tenantRoot });
      }
      if (!fs.existsSync(p)) {
        return res.status(400).json({ error: 'path not found: ' + p });
      }
    }
    try {
      const result = await recall.ingest({ tenant: req.tenant, namespace, paths, force: !!force });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'ingest failed', detail: String(e.message || e) });
    }
  });

  // Health check for the recall substrate.
  r.get('/v1/recall/status', async (req, res) => {
    const namespace = req.query.namespace ? String(req.query.namespace) : null;
    try {
      const av = await recall.isAvailable();
      const st = namespace ? await recall.status({ tenant: req.tenant, namespace }) : null;
      res.json({ available: av, namespace: namespace || null, status: st });
    } catch (e) {
      res.status(500).json({ error: 'recall status failed', detail: String(e.message || e) });
    }
  });

  // Single-source debug view. Confirms a sidecar exists and returns its
  // frontmatter + first 4KB of body so a UI can preview what qmd indexed.
  r.get('/v1/recall/sources/:id(*)', (req, res) => {
    // The :id is a URL-encoded relative path inside the tenant corpus. We
    // resolve it against the per-tenant slice of KOLM_RECALL_ROOT — admins can
    // see across tenants, tenants only see their own.
    const root = process.env.KOLM_RECALL_ROOT || os.tmpdir();
    const tenantRoot = path.resolve(root, req.tenant || '_anon');
    const lookupRoot = req.is_admin ? path.resolve(root) : tenantRoot;
    const id = decodeURIComponent(req.params.id || '');
    const full = path.resolve(lookupRoot, id);
    if (!full.startsWith(lookupRoot)) {
      return res.status(400).json({ error: 'path escapes recall root' });
    }
    const sidecar = full.endsWith('.md') ? full : full + '.md';
    if (!fs.existsSync(sidecar)) return res.status(404).json({ error: 'sidecar not found' });
    const text = fs.readFileSync(sidecar, 'utf-8');
    res.json({ id, sidecar, length: text.length, preview: text.slice(0, 4096) });
  });

  // ---------- Natural-language assistant ----------
  // POST /v1/assistant { prompt } returns a parsed-intent action + result.
  // Scoped to req.tenant_record; never calls an external LLM; deterministic.
  r.post('/v1/assistant', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json({ ok: false, error: 'auth_required' });
    try {
      const deps = {
        // compile is "tell me how", not auto-do — the assistant returns the
        // exact CLI / curl the user can run. Real compile flows through
        // /v1/synthesize where positives/negatives can be curated.
        synthesize: async ({ task }) => ({
          guidance: 'open /compile with this task pre-filled, or POST /v1/synthesize',
          curl: `curl -s -X POST ${process.env.PUBLIC_URL || 'https://kolm.ai'}/v1/synthesize \\\n  -H "authorization: Bearer $KOLM_KEY" \\\n  -H "content-type: application/json" \\\n  -d '{"name":"my-recipe","positives":[{"input":"x","expected":"y"}]}'`,
          compile_link: '/compile?task=' + encodeURIComponent(String(task || '').slice(0, 200)),
          task,
        }),
        run: async ({ tenant, concept_id, input }) => {
          try {
            return await runtime.runConcept({ concept_id, input, tenant });
          } catch (e) {
            return { error: String(e.message || e) };
          }
        },
        changePlan: async ({ tenant, target }) => {
          const meta = PLAN_CATALOG[target];
          if (!meta) return { error: 'invalid_plan' };
          if (meta.price_usd_month === 0) {
            update('tenants', x => x.id === tenant.id, { plan: 'free', quota: PLAN_CATALOG.free.quota, pending_plan: null });
            return { ok: true, plan: 'free' };
          }
          const url = billingLinkFor(target, { tenantId: tenant.id, email: tenant.email });
          if (!url) return { error: 'billing_not_configured' };
          update('tenants', x => x.id === tenant.id, { pending_plan: target });
          return { ok: true, plan: tenant.plan, pending_plan: target, billing_url: url, billing_required: true };
        },
      };
      const out = await handleAssistant(req, res, deps);
      res.json(out);
    } catch (e) {
      console.error('[assistant]', e && e.message);
      res.status(500).json({ ok: false, error: 'assistant_failed', message: String(e && e.message || e) });
    }
  });

  // ---------- Account ----------
  r.get('/v1/account', (req, res) => {
    if (!req.tenant_record) return res.json({ admin: !!req.is_admin, tenant: req.tenant });
    const t = req.tenant_record;
    res.json({
      id: t.id,
      name: t.name,
      email: t.email || null,
      plan: t.plan,
      quota: t.quota,
      used: t.used,
      seats: t.seats || 1,
      remaining: Math.max(0, t.quota - (t.used || 0)),
      created_at: t.created_at,
      last_used_at: t.last_used_at,
      pending_plan: t.pending_plan || null,
      billing_status: t.billing_status || (t.plan === 'free' ? 'free' : 'active'),
      stripe_customer_id: t.stripe_customer_id || null,
      stripe_subscription_id: t.stripe_subscription_id || null,
      paid_at: t.paid_at || null,
      cancelled_at: t.cancelled_at || null,
      current_period_end: t.current_period_end || null,
      auth_provider: t.auth_provider || 'apikey',
      oauth_providers: { google: oauthConfigured('google'), github: oauthConfigured('github') },
    });
  });

  r.post('/v1/account/rotate-key', (req, res) => {
    if (!req.tenant_record) return res.status(403).json({ error: 'admin tokens cannot rotate' });
    const k = rotateTenantKey(req.tenant_record.id);
    res.json({ api_key: k });
  });

  // Self-serve plan changes. Free is applied instantly (this is also the
  // downgrade / cancel path). Paid plans return a Stripe Payment Link with
  // `client_reference_id=<tenant_id>`; the plan is flipped only when the
  // webhook receives `checkout.session.completed`. This guarantees the
  // tenant cannot get paid features without paying.
  r.post('/v1/account/change-plan', (req, res) => {
    if (!req.tenant_record) return res.status(403).json({ error: 'admin tokens cannot change plan' });
    const target = String((req.body || {}).plan || '').toLowerCase();
    if (!PLAN_IDS.has(target)) return res.status(400).json({ error: 'invalid plan', allowed: Array.from(PLAN_IDS) });
    const meta = PLAN_CATALOG[target];
    const isUpgrade = meta.price_usd_month > 0;

    if (!isUpgrade) {
      update('tenants', x => x.id === req.tenant_record.id, {
        plan: 'free',
        quota: PLAN_CATALOG.free.quota,
        pending_plan: null,
        trial_ends_at: null,
      });
      return res.json({
        ok: true,
        plan: 'free',
        quota: PLAN_CATALOG.free.quota,
        seats: PLAN_CATALOG.free.seats,
        billing_url: null,
        billing_required: false,
        message: 'Plan changed to Developer (free).',
      });
    }

    const billingUrl = billingLinkFor(target, {
      tenantId: req.tenant_record.id,
      email: req.tenant_record.email,
    });
    if (!billingUrl) {
      return res.status(503).json({
        ok: false,
        plan: req.tenant_record.plan,
        billing_required: true,
        billing_url: null,
        error: 'billing_not_configured',
        message: `Billing for the ${meta.label} tier is not yet enabled. Contact the operator at hello@kolm.ai.`,
      });
    }

    update('tenants', x => x.id === req.tenant_record.id, {
      pending_plan: target,
    });

    res.json({
      ok: true,
      plan: req.tenant_record.plan,
      pending_plan: target,
      billing_url: billingUrl,
      billing_required: true,
      message: `Complete payment at ${billingUrl} to activate the ${meta.label} tier.`,
    });
  });

  // ---------- Stripe webhook ----------
  // Receives Stripe webhook events. Verifies signature with
  // STRIPE_WEBHOOK_SECRET, decodes the event, and flips tenant plans on
  // `checkout.session.completed` (upgrade) or `customer.subscription.deleted`
  // (downgrade to free). Idempotent: each Stripe event id is recorded once.
  //
  // The route is mounted with `express.raw({ type: '*/*' })` ahead of
  // `express.json()` in server.js — req.body must be a Buffer for signature
  // verification to work (canonical JSON reordering breaks the HMAC).
  r.post('/v1/stripe/webhook', (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(503).type('text/plain').send('webhook secret not configured');

    const sigHeader = req.header('stripe-signature') || '';
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : (typeof req.body === 'string' ? req.body : '');
    if (!rawBody) return res.status(400).type('text/plain').send('empty body');

    const verified = verifyStripeSignature(rawBody, sigHeader, secret);
    if (!verified.ok) {
      return res.status(400).type('text/plain').send(`Webhook Error: ${verified.reason}`);
    }

    let event;
    try { event = JSON.parse(rawBody); }
    catch (_) { return res.status(400).type('text/plain').send('invalid JSON'); }
    if (!event || typeof event !== 'object' || !event.id || !event.type) {
      return res.status(400).type('text/plain').send('malformed event');
    }

    // Idempotency: skip if we've already processed this event id.
    try {
      const seen = all('stripe_events').some(e => e.id === event.id);
      if (seen) return res.json({ received: true, idempotent: true, id: event.id });
      insert('stripe_events', { id: event.id, type: event.type, received_at: new Date().toISOString() });
    } catch (_) {}

    if (event.type === 'checkout.session.completed') {
      const s = event.data && event.data.object || {};
      const tenantId = s.client_reference_id;
      const planId = planFromAmount(s.amount_total);
      if (!tenantId) {
        return res.json({ received: true, warning: 'no client_reference_id', id: event.id });
      }
      const tenant = all('tenants').find(t => t.id === tenantId);
      if (!tenant) {
        return res.json({ received: true, warning: 'tenant not found', id: event.id });
      }
      const resolvedPlan = planId || tenant.pending_plan || null;
      if (!resolvedPlan || !PLAN_CATALOG[resolvedPlan]) {
        return res.json({ received: true, warning: 'no plan match', amount_total: s.amount_total, id: event.id });
      }
      const meta = PLAN_CATALOG[resolvedPlan];
      update('tenants', x => x.id === tenantId, {
        plan: resolvedPlan,
        quota: meta.quota,
        seats: meta.seats,
        pending_plan: null,
        stripe_customer_id: s.customer || null,
        stripe_subscription_id: s.subscription || null,
        paid_at: new Date().toISOString(),
        cancelled_at: null,
        billing_status: 'active',
      });
      // Best-effort welcome / activation email — never blocks the webhook.
      if (tenant.email && emailConfigured()) {
        sendBillingActivated({ email: tenant.email, plan: resolvedPlan, quota: meta.quota }).catch(() => {});
      }
      return res.json({ received: true, plan: resolvedPlan, tenant: tenantId, id: event.id });
    }

    if (event.type === 'customer.subscription.updated') {
      const sub = event.data && event.data.object || {};
      const tenant = all('tenants').find(t => t.stripe_subscription_id === sub.id);
      if (!tenant) return res.json({ received: true, warning: 'tenant not found', id: event.id });
      const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
      const stripeStatus = String(sub.status || 'active');
      const billingStatus = stripeStatus === 'past_due' ? 'past_due'
        : stripeStatus === 'unpaid' ? 'past_due'
        : stripeStatus === 'canceled' ? 'cancelled'
        : 'active';
      update('tenants', x => x.id === tenant.id, {
        billing_status: billingStatus,
        current_period_end: periodEnd,
        cancel_at_period_end: !!sub.cancel_at_period_end,
      });
      return res.json({ received: true, billing_status: billingStatus, tenant: tenant.id, id: event.id });
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data && event.data.object || {};
      const tenant = all('tenants').find(t => t.stripe_subscription_id === sub.id);
      if (!tenant) return res.json({ received: true, warning: 'tenant not found', id: event.id });
      update('tenants', x => x.id === tenant.id, {
        plan: 'free',
        quota: PLAN_CATALOG.free.quota,
        seats: PLAN_CATALOG.free.seats,
        pending_plan: null,
        cancelled_at: new Date().toISOString(),
        billing_status: 'cancelled',
      });
      return res.json({ received: true, plan: 'free', tenant: tenant.id, id: event.id });
    }

    if (event.type === 'invoice.payment_failed') {
      // Stripe handles retries via dunning. We mark the tenant past_due so the
      // dashboard can surface a warning and email them a heads-up.
      const inv = event.data && event.data.object || {};
      const tenant = all('tenants').find(t =>
        t.stripe_subscription_id === inv.subscription ||
        t.stripe_customer_id === inv.customer
      );
      if (tenant) {
        update('tenants', x => x.id === tenant.id, { billing_status: 'past_due' });
        if (tenant.email && emailConfigured()) {
          sendBillingFailed({ email: tenant.email, plan: tenant.plan }).catch(() => {});
        }
        return res.json({ received: true, action: 'past_due_marked', tenant: tenant.id, id: event.id });
      }
      return res.json({ received: true, action: 'noted', id: event.id });
    }

    return res.json({ received: true, type: event.type, action: 'ignored' });
  });

  // Self-serve cancel / downgrade-to-free. Any paid tenant can drop to the
  // free tier without contacting anyone.
  r.post('/v1/account/cancel', async (req, res) => {
    if (!req.tenant_record) return res.status(403).json({ error: 'admin tokens cannot cancel' });
    const t = req.tenant_record;
    let stripe_cancelled = false;
    if (t.stripe_subscription_id && process.env.STRIPE_SECRET_KEY) {
      try {
        const r = await fetch(`https://api.stripe.com/v1/subscriptions/${t.stripe_subscription_id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
        });
        stripe_cancelled = r.ok;
      } catch (err) {
        console.error('[cancel] stripe sub cancel failed', err && err.message);
      }
    }
    update('tenants', x => x.id === t.id, {
      plan: 'free',
      quota: PLAN_CATALOG.free.quota,
      trial_ends_at: null,
      cancelled_at: new Date().toISOString(),
      stripe_subscription_id: null,
      pending_plan: null,
    });
    res.json({
      ok: true,
      plan: 'free',
      stripe_cancelled,
      message: 'Subscription cancelled. Your tenant is now on the Developer (free) plan; existing artifacts and registry data are untouched.',
    });
  });

  // Self-serve account delete. Soft-delete the tenant; receipts and artifacts
  // already shipped to users keep verifying since the cloud signing key is
  // unchanged. The tenant can no longer authenticate. If they had an active
  // Stripe subscription we ask Stripe to cancel it so they aren't charged
  // again — best-effort, never blocks deletion.
  r.post('/v1/account/delete', async (req, res) => {
    if (!req.tenant_record) return res.status(403).json({ error: 'admin tokens cannot delete' });
    const t = req.tenant_record;
    if (t.stripe_subscription_id && process.env.STRIPE_SECRET_KEY) {
      try {
        await fetch(`https://api.stripe.com/v1/subscriptions/${t.stripe_subscription_id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
        });
      } catch (err) {
        console.error('[delete] stripe sub cancel failed', err && err.message);
      }
    }
    update('tenants', x => x.id === t.id, {
      _deleted: true,
      deleted_at: new Date().toISOString(),
      billing_status: 'cancelled',
      pending_plan: null,
    });
    res.clearCookie('kolm_session', { path: '/' });
    res.json({ ok: true, message: 'Account deleted. Receipts already issued remain verifiable.' });
  });

  // ---------- Layer 1: Synthesis ----------
  r.post('/v1/synthesize', async (req, res) => {
    const { positives, negatives = [], output_spec, priors = {}, name, description, tags = [], visibility = 'private', publish = true } = req.body || {};
    if (!Array.isArray(positives) || positives.length === 0) {
      return res.status(400).json({ error: 'positives is required (non-empty array)' });
    }
    try {
      const result = await synthesize({ positives, negatives, output_spec, priors });
      let concept_id = null, version_id = null;
      if (result.accepted && publish) {
        const concept = registry.createConcept({
          name: name || 'unnamed-' + Date.now(),
          description,
          tenant: req.tenant,
          schema: output_spec || null,
          tags,
          visibility,
        });
        const version = registry.publishVersion({
          concept_id: concept.id,
          source: result.source,
          evaluation: {
            quality_score: result.quality_score,
            pass_rate_positive: result.pass_rate_positive,
            reject_rate_negative: result.reject_rate_negative,
            latency_p50_us: result.latency_p50_us,
            size_bytes: result.size_bytes,
            source_hash: result.source_hash,
            strategy: result.strategy,
            trace: result.test_trace,
          },
          lineage: { synthesized_from_n: positives.length + negatives.length, attempts_n: result.attempts_n },
        });
        concept_id = concept.id;
        version_id = version.id;
        chargeUsage(req.tenant_record, result.size_bytes < 1024 ? 1 : 10);
      }
      res.json({ ...result, concept_id, version_id });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // SSE: live synthesis events (candidate generated, verified, accepted, etc.)
  r.post('/v1/synthesize/stream', async (req, res) => {
    const { positives, negatives = [], output_spec, priors = {}, name, description, tags = [], visibility = 'private', publish = true } = req.body || {};
    if (!Array.isArray(positives) || positives.length === 0) {
      return res.status(400).json({ error: 'positives is required (non-empty array)' });
    }
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let final = null;
    try {
      send('start', { name: name || null, positives_n: positives.length, negatives_n: negatives.length });
      final = await synthesizeStream({ positives, negatives, output_spec, priors }, send);
      let concept_id = null, version_id = null;
      if (final.accepted && publish) {
        const concept = registry.createConcept({
          name: name || 'unnamed-' + Date.now(),
          description, tenant: req.tenant, schema: output_spec || null, tags, visibility,
        });
        const version = registry.publishVersion({
          concept_id: concept.id,
          source: final.source,
          evaluation: {
            quality_score: final.quality_score,
            pass_rate_positive: final.pass_rate_positive,
            reject_rate_negative: final.reject_rate_negative,
            latency_p50_us: final.latency_p50_us,
            size_bytes: final.size_bytes,
            source_hash: final.source_hash,
            strategy: final.strategy,
            trace: final.test_trace,
          },
          lineage: { synthesized_from_n: positives.length + negatives.length, attempts_n: final.attempts_n },
        });
        concept_id = concept.id;
        version_id = version.id;
        chargeUsage(req.tenant_record, final.size_bytes < 1024 ? 1 : 10);
        send('published', { concept_id, version_id, quality_score: final.quality_score });
      }
      send('done', { ...final, concept_id, version_id });
    } catch (e) {
      send('error', { error: String(e.message || e) });
    } finally {
      res.end();
    }
  });

  // Batch synthesis: multiple concepts in one round-trip. Sequential, since
  // synthesis is CPU-bound — but billed once via shared overhead.
  r.post('/v1/synthesize/batch', async (req, res) => {
    const { items, publish = true, visibility = 'private' } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items[] required (each: {name, positives, output_spec, ...})' });
    }
    if (items.length > 25) {
      return res.status(400).json({ error: 'max 25 items per batch' });
    }
    const results = [];
    for (const item of items) {
      const t0 = Date.now();
      try {
        const r2 = await synthesize({ positives: item.positives || [], negatives: item.negatives || [], output_spec: item.output_spec, priors: item.priors || {} });
        let concept_id = null, version_id = null;
        if (r2.accepted && publish) {
          const concept = registry.createConcept({
            name: item.name || ('batch-' + Date.now()),
            description: item.description, tenant: req.tenant,
            schema: item.output_spec || null, tags: item.tags || [], visibility,
          });
          const version = registry.publishVersion({
            concept_id: concept.id, source: r2.source,
            evaluation: { quality_score: r2.quality_score, pass_rate_positive: r2.pass_rate_positive, reject_rate_negative: r2.reject_rate_negative, latency_p50_us: r2.latency_p50_us, size_bytes: r2.size_bytes, source_hash: r2.source_hash, strategy: r2.strategy, trace: r2.test_trace },
            lineage: { synthesized_from_n: (item.positives?.length || 0) + (item.negatives?.length || 0), attempts_n: r2.attempts_n },
          });
          concept_id = concept.id; version_id = version.id;
          chargeUsage(req.tenant_record, r2.size_bytes < 1024 ? 1 : 10);
        }
        results.push({ name: item.name, accepted: r2.accepted, concept_id, version_id, quality_score: r2.quality_score, strategy: r2.strategy, duration_ms: Date.now() - t0 });
      } catch (e) {
        results.push({ name: item.name, accepted: false, error: String(e.message || e), duration_ms: Date.now() - t0 });
      }
    }
    res.json({ results, total: results.length, accepted: results.filter(r => r.accepted).length });
  });

  r.post('/v1/verify', publishLimiter, (req, res) => {
    const { source, positives = [], negatives = [] } = req.body || {};
    if (!source) return res.status(400).json({ error: 'source is required' });
    try {
      const fn = compileJs(source);
      const result = verify(fn, { positives, negatives });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  // Publish an edited generator (no synthesis required)
  r.post('/v1/publish', publishLimiter, (req, res) => {
    const { source, name, description, tags = [], visibility = 'private', positives = [], negatives = [], output_spec } = req.body || {};
    if (!source || !name) return res.status(400).json({ error: 'source and name are required' });
    try {
      const fn = compileJs(source);
      const evaluation = verify(fn, { positives, negatives });
      const concept = registry.createConcept({ name, description, tenant: req.tenant, schema: output_spec || null, tags, visibility });
      const version = registry.publishVersion({
        concept_id: concept.id,
        source,
        evaluation: { ...evaluation, strategy: 'manual' },
        lineage: { manual: true, synthesized_from_n: positives.length + negatives.length },
      });
      chargeUsage(req.tenant_record, 1);
      res.json({ concept_id: concept.id, version_id: version.id, evaluation });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  // ---------- Layer 2: Registry ----------
  r.get('/v1/concepts', (req, res) => {
    const concepts = registry.listConcepts({ tenant: req.tenant, tag: req.query.tag, limit: parseInt(req.query.limit) || 50 });
    res.json({ concepts });
  });

  r.get('/v1/concepts/:id', (req, res) => {
    const c = registry.getConcept(req.params.id, req.tenant);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  });

  r.delete('/v1/concepts/:id', (req, res) => {
    try {
      const n = registry.deleteConcept(req.params.id, req.tenant);
      res.json({ deleted: n });
    } catch (e) { res.status(403).json({ error: String(e.message || e) }); }
  });

  r.get('/v1/concepts/:id/lineage', (req, res) => {
    const lineage = registry.lineageOf(req.params.id, req.tenant);
    if (!lineage) return res.status(404).json({ error: 'not found' });
    res.json(lineage);
  });

  // Per-concept usage stats: invocation count, latency percentiles, cache hit rate.
  r.get('/v1/concepts/:id/stats', (req, res) => {
    const c = registry.getConcept(req.params.id, req.tenant);
    if (!c) return res.status(404).json({ error: 'not found' });
    const inv = all('invocations').filter(i => i.concept_id === c.id && (req.is_admin || i.tenant === req.tenant));
    const lats = inv.map(x => x.latency_us || 0).filter(x => x > 0).sort((a, b) => a - b);
    const pct = (p) => lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * p))] : 0;
    const cacheHits = inv.filter(x => x.cache_hit).length;
    const errors = inv.filter(x => x.error).length;
    const last = inv.length ? inv[inv.length - 1].ts : null;
    res.json({
      concept_id: c.id,
      name: c.name,
      invocations: inv.length,
      cache_hit_rate: inv.length ? cacheHits / inv.length : 0,
      error_rate: inv.length ? errors / inv.length : 0,
      latency_us: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), avg: lats.length ? Math.round(lats.reduce((s, x) => s + x, 0) / lats.length) : 0 },
      last_invoked_at: last,
      versions: (c.versions || []).length,
    });
  });

  r.post('/v1/search', (req, res) => {
    const { query, k = 10, tag } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query is required' });
    const matches = registry.searchSimilar({ query, tenant: req.tenant, k, tag });
    res.json({ matches });
  });

  // ---------- Layer 3: Runtime ----------
  r.post('/v1/run', async (req, res) => {
    const { concept_id, version_id, input, use_cache = true, receipt: wantReceipt = true } = req.body || {};
    try {
      let result;
      if (version_id) result = await runtime.runVersion({ version_id, input, tenant: req.tenant, use_cache });
      else if (concept_id) result = await runtime.runConcept({ concept_id, input, tenant: req.tenant });
      else return res.status(400).json({ error: 'concept_id or version_id required' });
      chargeUsage(req.tenant_record, result.cache ? 0 : 1); // cache hits are cheap
      // Sign the run. Clients can opt out with `receipt: false` to save the small overhead.
      if (wantReceipt) {
        result.receipt = buildReceipt({
          source_hash: result.source_hash,
          input,
          output: result.output,
          version_id: result.version_id,
          latency_us: result.latency_us,
          cache_hit: result.cache,
        });
      }
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  r.post('/v1/compose', async (req, res) => {
    const { query, input, k = 5, strategy = 'attention', tag } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query is required' });
    try {
      const result = await runtime.composeRun({ query, input, tenant: req.tenant, k, strategy, tag });
      const billable = (result.dispatched || []).filter(d => !d.cache && !d.error).length;
      chargeUsage(req.tenant_record, billable);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  // ---------- Telemetry / admin ----------
  // Returns the v5 (kolm) summary AND the legacy invocations snapshot the
  // existing dashboard.html consumes. Dashboard keeps reading
  // total_invocations/p50_us/cache; new surfaces (status, hero) read
  // compiles_today/receipts_verified/k_score_median/artifacts_total/
  // active_tenants_24h.
  r.get('/v1/telemetry', (req, res) => {
    const inv = all('invocations').filter(i => !req.tenant_record || i.tenant === req.tenant);
    const recent = inv.slice(-200).reverse();
    const lats = inv.map(x => x.latency_us || 0).filter(x => x > 0).sort((a, b) => a - b);
    const totalLat = inv.reduce((s, x) => s + (x.latency_us || 0), 0);
    const cacheHits = inv.filter(x => x.cache_hit).length;
    const pct = (p) => lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * p))] : 0;
    // last 60 invocations as sparkline
    const spark = inv.slice(-60).map(x => x.latency_us || 0);

    // ---- v5 (kolm) summary ----
    const dayMs = 24 * 60 * 60 * 1000;
    const startOfTodayUtc = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); })();
    const since24h = Date.now() - dayMs;

    const jobs = all('compile_jobs').filter(j => !j._deleted);
    const tenantScopedJobs = req.tenant_record
      ? jobs.filter(j => j.tenant === req.tenant)
      : jobs; // admin sees the global view
    const compilesToday = tenantScopedJobs.filter(j => {
      const t = Date.parse(j.created_at || '');
      return Number.isFinite(t) && t >= startOfTodayUtc;
    }).length;
    const artifactsTotal = tenantScopedJobs.filter(j => j.status === 'completed').length;

    const kScores = tenantScopedJobs
      .slice(-100)
      .map(j => (j.k_score && typeof j.k_score.composite === 'number') ? j.k_score.composite : null)
      .filter(v => typeof v === 'number');
    const median = (xs) => {
      if (!xs.length) return null;
      const sorted = [...xs].sort((a, b) => a - b);
      const m = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    };
    const kScoreMedian = median(kScores);

    // Receipts verified: every invocation in the v5 model gets a receipt
    // bound to its run, so cache_miss inv count is the lower bound. Until
    // we add a dedicated receipts table (Sprint 2), use the receipt-bearing
    // invocation count as the closest proxy.
    const receiptsVerified = inv.filter(i => !i.error).length;

    // Active tenants in last 24h: distinct tenants that ran a job or an
    // invocation. Admins see global; tenants see "1 if active else 0".
    const tenantsTouching24h = new Set();
    for (const i of all('invocations')) {
      const t = Date.parse(i.ts || '');
      if (Number.isFinite(t) && t >= since24h && i.tenant) tenantsTouching24h.add(i.tenant);
    }
    for (const j of jobs) {
      const t = Date.parse(j.created_at || '');
      if (Number.isFinite(t) && t >= since24h && j.tenant) tenantsTouching24h.add(j.tenant);
    }
    const activeTenants24h = req.tenant_record
      ? (tenantsTouching24h.has(req.tenant) ? 1 : 0)
      : tenantsTouching24h.size;

    res.json({
      // ---- v5 (kolm) summary ----
      compiles_today: compilesToday,
      receipts_verified: receiptsVerified,
      k_score_median: kScoreMedian,
      artifacts_total: artifactsTotal,
      active_tenants_24h: activeTenants24h,
      // ---- legacy fields the dashboard.html consumes ----
      total_invocations: inv.length,
      avg_latency_us: inv.length ? Math.round(totalLat / inv.length) : 0,
      p50_us: pct(0.5),
      p95_us: pct(0.95),
      p99_us: pct(0.99),
      cache_hit_rate: inv.length ? cacheHits / inv.length : 0,
      cache: cache.cacheStats(),
      compiled_cache_size: runtime.compiledCacheSize(),
      sparkline: spark,
      recent,
    });
  });

  r.get('/v1/library', (_req, res) => {
    res.json({ version: LIBRARY_VERSION, description: libraryDescription() });
  });

  r.post('/v1/admin/tenant', (req, res) => {
    if (!req.is_admin) return res.status(403).json({ error: 'admin only' });
    const { name, quota } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const t = provisionTenant(name, { quota: quota || 10000 });
    res.json(t);
  });

  r.get('/v1/admin/tenants', (req, res) => {
    if (!req.is_admin) return res.status(403).json({ error: 'admin only' });
    res.json({ tenants: all('tenants') });
  });

  r.get('/v1/admin/diagnostics', async (req, res) => {
    if (!req.is_admin) return res.status(403).json({ error: 'admin only' });
    const fs = await import('node:fs');
    const dataDir = process.env.KOLM_DATA_DIR || '';
    const artifactDir = process.env.KOLM_ARTIFACT_DIR || '';
    const checkDir = (dir) => {
      if (!dir) return { dir, ok: false, reason: 'unset' };
      try {
        const stat = fs.statSync(dir);
        if (!stat.isDirectory()) return { dir, ok: false, reason: 'not_a_directory' };
        try {
          fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
          return { dir, ok: true, mode: stat.mode.toString(8), uid: stat.uid, gid: stat.gid };
        } catch (e) {
          return { dir, ok: false, reason: 'access_denied', code: e.code, mode: stat.mode.toString(8) };
        }
      } catch (e) {
        return { dir, ok: false, reason: 'stat_failed', code: e.code, message: e.message };
      }
    };
    let mkdirResult = null;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.mkdirSync(artifactDir, { recursive: true });
      mkdirResult = { ok: true };
    } catch (e) {
      mkdirResult = { ok: false, code: e.code, message: e.message };
    }
    res.json({
      env: {
        NODE_ENV: process.env.NODE_ENV,
        KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
        KOLM_ARTIFACT_DIR: process.env.KOLM_ARTIFACT_DIR,
        KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
        KOLM_ALLOW_JSON_STORE: process.env.KOLM_ALLOW_JSON_STORE,
        KOLM_ALLOW_JSON_STORE_strict_true: process.env.KOLM_ALLOW_JSON_STORE === 'true',
        RECIPE_RECEIPT_SECRET_len: (process.env.RECIPE_RECEIPT_SECRET || '').length,
        RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
      },
      cwd: process.cwd(),
      data_dir: checkDir(dataDir),
      artifact_dir: checkDir(artifactDir),
      mkdir_result: mkdirResult,
    });
  });

  // ---------- Recipe aliases ----------
  // Forward-looking branding: "recipe" terminology mirrors "concept" endpoints.
  // Both names route to the same handlers — full backward compatibility preserved.
  r.get('/v1/recipes', (req, res) => {
    const concepts = registry.listConcepts({ tenant: req.tenant, tag: req.query.tag, limit: parseInt(req.query.limit) || 50 });
    res.json({ recipes: concepts.map(c => ({ ...c, recipe_id: c.id })) });
  });
  r.get('/v1/recipes/:id', (req, res) => {
    const c = registry.getConcept(req.params.id, req.tenant);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ ...c, recipe_id: c.id });
  });
  r.get('/v1/recipes/:id/stats', (req, res) => {
    const c = registry.getConcept(req.params.id, req.tenant);
    if (!c) return res.status(404).json({ error: 'not found' });
    const inv = all('invocations').filter(i => i.concept_id === c.id && (req.is_admin || i.tenant === req.tenant));
    const lats = inv.map(x => x.latency_us || 0).filter(x => x > 0).sort((a, b) => a - b);
    const pct = (p) => lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * p))] : 0;
    res.json({
      recipe_id: c.id, name: c.name, invocations: inv.length,
      cache_hit_rate: inv.length ? inv.filter(x => x.cache_hit).length / inv.length : 0,
      latency_us: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
    });
  });

  // ---------- Auto-labeling (Phase C — Day 30-60 in roadmap) ----------
  // Run a recipe across a corpus of inputs and return labeled rows. Inline
  // mode runs synchronously (max 500 rows). HuggingFace and URL modes return
  // a queued job — actual fetcher lands in v0.3 once we have a Postgres queue.
  async function runRecipeOverRows(c, rows, tenant) {
    const out = [];
    let errors = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const input = typeof row === 'string' ? row : (row.input ?? row.text ?? row);
      try {
        const r2 = await runtime.runConcept({ concept_id: c.id, input, tenant });
        out.push({ idx: i, input, label: r2.output, latency_us: r2.latency_us, cache: r2.cache });
      } catch (e) {
        errors++;
        out.push({ idx: i, input, error: String(e.message || e) });
      }
    }
    return { rows: out, errors };
  }

  // Inline labeler — synchronous up to 500 rows
  r.post('/v1/recipes/:id/label-corpus', async (req, res) => {
    const c = registry.getConcept(req.params.id, req.tenant);
    if (!c) return res.status(404).json({ error: 'recipe not found' });
    const { corpus = {}, max_rows = 100, output_format = 'json' } = req.body || {};
    const startedAt = Date.now();

    if (corpus.type === 'inline') {
      const rows = Array.isArray(corpus.rows) ? corpus.rows.slice(0, Math.min(max_rows, 500)) : [];
      if (rows.length === 0) return res.status(400).json({ error: 'corpus.rows must be a non-empty array (max 500 in sync mode)' });
      const { rows: labeled, errors } = await runRecipeOverRows(c, rows, req.tenant);
      chargeUsage(req.tenant_record, Math.ceil(rows.length / 10)); // 10 rows = 1 unit
      const job_id = 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      insert('corpus_jobs', {
        id: job_id, recipe_id: c.id, tenant: req.tenant, status: 'completed',
        rows_labeled: labeled.length, errors, duration_ms: Date.now() - startedAt,
        corpus_type: 'inline', created_at: new Date().toISOString(),
      });
      if (output_format === 'csv') {
        res.set('Content-Type', 'text/csv');
        const csv = ['idx,input,label,latency_us', ...labeled.map(r => `${r.idx},"${String(r.input).replace(/"/g, '""')}","${String(r.label ?? r.error ?? '').replace(/"/g, '""')}",${r.latency_us ?? 0}`)].join('\n');
        return res.send(csv);
      }
      return res.json({ job_id, status: 'completed', recipe_id: c.id, rows_labeled: labeled.length, errors, duration_ms: Date.now() - startedAt, sample: labeled.slice(0, 10), all: labeled });
    }

    if (corpus.type === 'huggingface' || corpus.type === 'url') {
      const job_id = 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      insert('corpus_jobs', {
        id: job_id, recipe_id: c.id, tenant: req.tenant, status: 'queued',
        corpus_type: corpus.type, corpus_ref: corpus.name || corpus.url, max_rows,
        created_at: new Date().toISOString(),
      });
      return res.status(202).json({
        job_id, status: 'queued', recipe_id: c.id,
        message: `Queued — ${corpus.type} fetcher lands when we wire the corpus pipeline (Day 30-60). Poll /v1/jobs/${job_id} to check.`,
        est_rows: max_rows,
      });
    }

    return res.status(400).json({ error: 'corpus.type must be "inline", "huggingface", or "url"' });
  });

  // SSE stream variant: emits progress as rows are labeled.
  r.post('/v1/recipes/:id/label-corpus/stream', async (req, res) => {
    const c = registry.getConcept(req.params.id, req.tenant);
    if (!c) return res.status(404).json({ error: 'recipe not found' });
    const { corpus = {}, max_rows = 200 } = req.body || {};
    if (corpus.type !== 'inline') return res.status(400).json({ error: 'streaming labeler only supports corpus.type=inline (for now)' });
    const rows = Array.isArray(corpus.rows) ? corpus.rows.slice(0, Math.min(max_rows, 500)) : [];
    if (rows.length === 0) return res.status(400).json({ error: 'corpus.rows must be a non-empty array' });

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const startedAt = Date.now();
    send('start', { recipe_id: c.id, total: rows.length });
    let errors = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const input = typeof row === 'string' ? row : (row.input ?? row.text ?? row);
      try {
        const r2 = await runtime.runConcept({ concept_id: c.id, input, tenant: req.tenant });
        send('row', { idx: i, input, label: r2.output, latency_us: r2.latency_us, cache: r2.cache });
      } catch (e) {
        errors++;
        send('row', { idx: i, input, error: String(e.message || e) });
      }
    }
    chargeUsage(req.tenant_record, Math.ceil(rows.length / 10));
    send('done', { rows_labeled: rows.length - errors, errors, duration_ms: Date.now() - startedAt });
    res.end();
  });

  // Job status (used by HF / URL queued jobs)
  r.get('/v1/jobs/:id', (req, res) => {
    const job = findOne('corpus_jobs', x => x.id === req.params.id) || findOne('specialists', x => x.id === req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    if (job.tenant && job.tenant !== req.tenant && !req.is_admin) return res.status(403).json({ error: 'not your job' });
    res.json(job);
  });

  // ---------- Specialists (Phase D — Day 60-120 in roadmap) ----------
  // Public waitlist endpoint — gathers email + task interest before the product launches.
  r.post('/v1/specialists/waitlist', waitlistLimiter, (req, res) => {
    const { email, task } = req.body || {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });
    if (!task || String(task).length < 3) return res.status(400).json({ error: 'task description required (3+ chars)' });
    const existing = findOne('waitlist', x => x.email === email);
    const position = (all('waitlist').length || 0) + 1;
    if (existing) {
      // Update task without changing position
      update('waitlist', x => x.id === existing.id, { task: String(task).slice(0, 500), updated_at: new Date().toISOString() });
      return res.json({ position: existing.position, message: 'already reserved — task updated', email });
    }
    const entry = {
      id: 'wl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      email, task: String(task).slice(0, 500), position,
      created_at: new Date().toISOString(),
    };
    insert('waitlist', entry);
    res.json({ position, message: 'reserved — first 50 teams get a Specialist trained on us', email });
  });

  r.post('/v1/specialists/train', (req, res) => {
    const { name, recipe_id, corpus, base_model = 'Qwen/Qwen3-1.5B', rank = 16 } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!recipe_id) return res.status(400).json({ error: 'recipe_id required (a synthesized recipe used for auto-labeling)' });
    const c = registry.getConcept(recipe_id, req.tenant);
    if (!c) return res.status(404).json({ error: 'recipe not found' });
    const id = 'spc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const spec = {
      id, name, recipe_id, base_model, rank,
      tenant: req.tenant,
      corpus: corpus || { type: 'inline', rows: [] },
      status: 'queued',
      est_minutes: 47,
      created_at: new Date().toISOString(),
      pipeline: 'kolm trainer bridge - hosted LoRA training, Wave 2',
    };
    insert('specialists', spec);
    res.status(202).json({ specialist_id: id, status: 'queued', est_minutes: 47, name, recipe_id, base_model, rank, pipeline: spec.pipeline });
  });

  r.get('/v1/specialists', (req, res) => {
    const specs = all('specialists').filter(s => req.is_admin || s.tenant === req.tenant);
    res.json({ specialists: specs.map(({ corpus, ...rest }) => rest) });
  });

  r.get('/v1/specialists/:id', (req, res) => {
    const spec = findOne('specialists', x => x.id === req.params.id);
    if (!spec) return res.status(404).json({ error: 'not found' });
    if (spec.tenant !== req.tenant && !req.is_admin) return res.status(403).json({ error: 'not your specialist' });
    res.json(spec);
  });

  r.get('/v1/specialists/:id/weights', (req, res) => {
    const spec = findOne('specialists', x => x.id === req.params.id);
    if (!spec) return res.status(404).json({ error: 'not found' });
    if (spec.tenant !== req.tenant && !req.is_admin) return res.status(403).json({ error: 'not your specialist' });
    if (spec.status !== 'completed') {
      return res.status(503).json({ error: 'training not complete', status: spec.status, message: 'Specialists training pipeline ships Day 60-120. Recipe is the labeler today; weights export becomes live with the LoRA pipeline.' });
    }
    res.json({ weights_url: spec.weights_url, sha256: spec.weights_sha256, base_model: spec.base_model, rank: spec.rank });
  });

  r.post('/v1/specialists/:id/run', async (req, res) => {
    const spec = findOne('specialists', x => x.id === req.params.id);
    if (!spec) return res.status(404).json({ error: 'not found' });
    if (spec.tenant !== req.tenant && !req.is_admin) return res.status(403).json({ error: 'not your specialist' });
    // Until the LoRA pipeline ships, the Specialist falls back to its source recipe so
    // every API call still produces a real answer (just from JS, not the model).
    try {
      const r2 = await runtime.runConcept({ concept_id: spec.recipe_id, input: req.body?.input, tenant: req.tenant });
      chargeUsage(req.tenant_record, r2.cache ? 0 : 1);
      res.json({ output: r2.output, latency_ms: Math.round((r2.latency_us || 0) / 1000) || 1, model: `${spec.base_model}+lora (preview: routing through source recipe)`, source: 'recipe-fallback' });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  // ---------- Public registry submissions (Phase E — Day 120-180) ----------
  r.post('/v1/public/submit', (req, res) => {
    const { recipe_id, blurb = '', contact = '' } = req.body || {};
    if (!recipe_id) return res.status(400).json({ error: 'recipe_id required' });
    const c = registry.getConcept(recipe_id, req.tenant);
    if (!c) return res.status(404).json({ error: 'recipe not found' });
    if (c.tenant !== req.tenant && !req.is_admin) return res.status(403).json({ error: 'not your recipe' });
    const sub = {
      id: 'sub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      recipe_id, name: c.name, tenant: req.tenant,
      blurb: String(blurb).slice(0, 500), contact: String(contact).slice(0, 200),
      status: 'pending_review',
      created_at: new Date().toISOString(),
    };
    insert('submissions', sub);
    res.json({ submission_id: sub.id, status: sub.status, message: 'submitted — public review on Day 120-180 schedule' });
  });

  // Tenant audit log. Beta — opt-in via POST /v1/account/audit-log {enabled:true}.
  // Until the durable per-tenant log lands in Wave 2, return 503 with a clear
  // error so /audit-log.html shows the static disclosure card. Probe-safe:
  // never returns 404 (which would 404 the whole `/v1/audit/log` path under a
  // CDN-misconfigured deploy) — returns 503 with a structured body instead.
  r.get('/v1/audit/log', (_req, res) => {
    res.status(503).json({
      error: 'audit_log_beta',
      message: 'Per-tenant durable audit log ships in Wave 2 (Days 22-60). Opt in via POST /v1/account/audit-log {"enabled":true} once available.',
      entries: [],
    });
  });

  r.get('/v1/public/featured', (_req, res) => {
    // Hand-pick the most useful public recipes for the home registry view.
    const featured_names = ['classify-issue-type','is-spam','extract-emails','classify-toxicity','extract-prices','classify-intent','sentiment','detect-pii','classify-language','is-question'];
    const all_concepts = all('concepts');
    const featured = featured_names
      .map(n => all_concepts.find(c => c.name === n && c.visibility === 'public'))
      .filter(Boolean)
      .map(c => ({ id: c.id, name: c.name, description: c.description, tags: c.tags, head_version: c.head_version }));
    res.json({ featured });
  });

  // Admin: list waitlist + submissions for triage
  r.get('/v1/admin/waitlist', (req, res) => {
    if (!req.is_admin) return res.status(403).json({ error: 'admin only' });
    res.json({ waitlist: all('waitlist'), total: all('waitlist').length });
  });
  r.get('/v1/admin/submissions', (req, res) => {
    if (!req.is_admin) return res.status(403).json({ error: 'admin only' });
    res.json({ submissions: all('submissions'), total: all('submissions').length });
  });

  // ---------- Phase F: Compounding bridges ----------
  // Three pillars compound: Memory remembers → Skills (Recipes) repeat → Specialists become.
  // These endpoints wire the bridges so a Recipe pattern auto-grows into a Specialist,
  // and an agent's repeated LLM calls auto-collapse into Recipes.

  // Stable signature for prompt templates. Real prompts are interpolated by the time
  // we see them, so we use the leading "instruction" portion (up to the first
  // sentence-ending mark or newline) as the template signature — that's where the
  // pattern lives ("Is this spam?", "Classify this:", etc.) — and treat the rest as
  // variable input.
  function templateSignature(prompt = '', model = '') {
    const raw = String(prompt).replace(/\s+/g, ' ').trim();
    const m = raw.match(/^(.{8,200}?[\?\.!:\n])(.*)$/);
    const head = m ? m[1].trim() : raw.slice(0, 80);
    const variable = m ? m[2].trim() : '';
    const normalized = head
      .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"<S>"')
      .replace(/\b\d+(?:\.\d+)?\b/g, '<N>');
    const h = crypto.createHash('sha1').update(model + ' ' + normalized).digest('hex').slice(0, 16);
    return { hash: h, normalized: normalized.slice(0, 240), variable: variable.slice(0, 240) };
  }

  // POST /v1/bridges/observe — agents log a (model, prompt, response) tuple.
  // After ≥4 calls with the same template signature we surface a synthesis suggestion.
  r.post('/v1/bridges/observe', (req, res) => {
    const { model = '', prompt = '', response, latency_ms, cost_usd } = req.body || {};
    if (!prompt || response === undefined) {
      return res.status(400).json({ error: 'prompt and response are required' });
    }
    const sig = templateSignature(prompt, model);
    const obs = {
      id: 'obs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      tenant: req.tenant,
      template_hash: sig.hash,
      template_preview: sig.normalized,
      model: String(model).slice(0, 128),
      prompt: String(prompt).slice(0, 4000),
      variable_input: sig.variable,
      response,
      latency_ms: Number(latency_ms) || 0,
      cost_usd: Number(cost_usd) || 0,
      created_at: new Date().toISOString(),
    };
    insert('observations', obs);
    const cluster = all('observations').filter(o => o.tenant === req.tenant && o.template_hash === sig.hash);
    res.json({
      observation_id: obs.id,
      template_hash: sig.hash,
      cluster_size: cluster.length,
      ready_for_synthesis: cluster.length >= 4,
      suggestion: cluster.length >= 4
        ? { template_hash: sig.hash, count: cluster.length, est_savings_per_month_usd: Math.round(cluster.length * (obs.cost_usd || 0.001) * 30 * 100) / 100 }
        : null,
    });
  });

  // GET /v1/bridges/suggestions — recipe-synthesis suggestions clustered from observations.
  r.get('/v1/bridges/suggestions', (req, res) => {
    const obs = all('observations').filter(o => o.tenant === req.tenant);
    const groups = new Map();
    for (const o of obs) {
      const g = groups.get(o.template_hash) || { template_hash: o.template_hash, template_preview: o.template_preview, model: o.model, count: 0, total_cost_usd: 0, total_latency_ms: 0, examples: [] };
      g.count++;
      g.total_cost_usd += o.cost_usd || 0;
      g.total_latency_ms += o.latency_ms || 0;
      if (g.examples.length < 8) g.examples.push({ input: o.variable_input || o.prompt, expected: o.response });
      groups.set(o.template_hash, g);
    }
    const suggestions = [...groups.values()]
      .filter(g => g.count >= 4)
      .map(g => ({
        ...g,
        avg_latency_ms: Math.round(g.total_latency_ms / g.count),
        est_savings_per_month_usd: Math.round(g.total_cost_usd * 30 / Math.max(1, g.count) * g.count * 30 * 100) / 100,
        synthesize_url: `/v1/bridges/auto-synthesize?template_hash=${encodeURIComponent(g.template_hash)}`,
      }))
      .sort((a, b) => b.count - a.count);
    res.json({ suggestions, total: suggestions.length });
  });

  // GET /v1/bridges/observations — flat list of recent captures for the /captures inbox.
  // Filters: ?namespace=<ns> (optional), ?limit=<n> (default 50, max 200), ?include_discarded=1.
  r.get('/v1/bridges/observations', (req, res) => {
    const ns = req.query?.namespace ? String(req.query.namespace) : null;
    const lim = Math.min(200, Math.max(1, parseInt(req.query?.limit, 10) || 50));
    const includeDiscarded = req.query?.include_discarded === '1';
    let obs = all('observations').filter(o => o.tenant === req.tenant);
    if (ns) obs = obs.filter(o => (o.namespace || 'default') === ns);
    if (!includeDiscarded) obs = obs.filter(o => !o.discarded);
    obs.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const namespaces = [...new Set(all('observations').filter(o => o.tenant === req.tenant).map(o => o.namespace || 'default'))];
    const ready = namespaces.map(n => ({
      namespace: n,
      pairs: all('observations').filter(o => o.tenant === req.tenant && (o.namespace || 'default') === n && !o.discarded).length,
    })).filter(x => x.pairs >= 1000);
    res.json({
      total: obs.length,
      namespaces,
      ready_to_distill: ready,
      observations: obs.slice(0, lim).map(o => ({
        id: o.id,
        namespace: o.namespace || 'default',
        model: o.model || '',
        input_excerpt: String(o.prompt || o.template_preview || '').slice(0, 240),
        output_excerpt: typeof o.response === 'string' ? o.response.slice(0, 240) : JSON.stringify(o.response || '').slice(0, 240),
        latency_ms: o.latency_ms || (o.latency_us ? Math.round(o.latency_us / 1000) : 0),
        created_at: o.created_at || null,
        discarded: !!o.discarded,
        kept: !!o.kept,
        promoted_recipe_id: o.promoted_recipe_id || null,
      })),
    });
  });

  // POST /v1/bridges/observations/:id — soft-update an observation (keep/discard).
  // Body: { discarded: true } | { kept: true } | { discarded: false }. Tenant-scoped.
  r.post('/v1/bridges/observations/:id', (req, res) => {
    const id = req.params.id;
    const obs = all('observations').find(o => o.id === id && o.tenant === req.tenant);
    if (!obs) return res.status(404).json({ error: 'observation_not_found' });
    const patch = {};
    if (typeof req.body?.discarded === 'boolean') patch.discarded = req.body.discarded;
    if (typeof req.body?.kept === 'boolean') patch.kept = req.body.kept;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });
    update('observations', o => o.id === id && o.tenant === req.tenant, patch);
    res.json({ id, ...patch });
  });

  // POST /v1/bridges/auto-synthesize — turn an observation cluster into a recipe.
  r.post('/v1/bridges/auto-synthesize', async (req, res) => {
    const hash = req.body?.template_hash || req.query?.template_hash;
    const name = req.body?.name || `auto-${String(hash || '').slice(0, 8)}`;
    if (!hash) return res.status(400).json({ error: 'template_hash required' });
    const obs = all('observations').filter(o => o.tenant === req.tenant && o.template_hash === hash);
    if (obs.length < 4) return res.status(400).json({ error: 'not enough observations (need 4+)' });
    // Prefer the extracted variable portion as the example input. Fall back to the
    // full prompt only if the variable wasn't isolated.
    const positives = obs.slice(0, 8).map(o => ({ input: o.variable_input || o.prompt, expected: o.response }));
    try {
      const synthResult = await synthesize({
        name,
        positives,
        description: `Auto-synthesized from ${obs.length} observed calls to ${obs[0].model || 'an LLM'}.`,
        tags: ['auto-bridge'],
        tenant: req.tenant,
      });
      // Mark every observation as belonging to this recipe so /lineage can trace it.
      if (synthResult.accepted) {
        update('observations', o => o.tenant === req.tenant && o.template_hash === hash, { promoted_recipe_id: synthResult.concept_id });
      }
      res.json({ ...synthResult, observations_promoted: synthResult.accepted ? obs.length : 0 });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  // GET /v1/bridges/specialist-candidates — recipes whose call volume justifies a Specialist.
  r.get('/v1/bridges/specialist-candidates', (req, res) => {
    const concepts = all('concepts').filter(c => c.tenant === req.tenant || req.is_admin);
    const invocations = all('invocations');
    const candidates = concepts
      .map(c => {
        const n = invocations.filter(i => i.concept_id === c.id).length;
        return { recipe_id: c.id, name: c.name, invocations: n, threshold: 1000, ready: n >= 1000 };
      })
      .filter(c => c.invocations >= 100)
      .sort((a, b) => b.invocations - a.invocations);
    res.json({ candidates, threshold: 1000, total: candidates.length });
  });

  // GET /v1/recipes/:id/lineage — full Memory ↔ Recipe ↔ Specialist trace.
  r.get('/v1/recipes/:id/lineage', (req, res) => {
    const c = registry.getConcept(req.params.id, req.tenant);
    if (!c) return res.status(404).json({ error: 'recipe not found' });
    const observations = all('observations').filter(o => o.promoted_recipe_id === c.id);
    const specialists = all('specialists').filter(s => s.recipe_id === c.id);
    const invocations = all('invocations').filter(i => i.concept_id === c.id);
    const corpus_jobs = all('corpus_jobs').filter(j => j.recipe_id === c.id);
    res.json({
      recipe: { id: c.id, name: c.name, head_version: c.head_version, tenant: c.tenant },
      lineage: {
        observations: observations.length,
        observation_models: [...new Set(observations.map(o => o.model).filter(Boolean))],
        invocations: invocations.length,
        cache_hits: invocations.filter(i => i.cache).length,
        corpus_jobs: corpus_jobs.length,
        rows_labeled: corpus_jobs.reduce((s, j) => s + (j.rows_labeled || 0), 0),
        specialists: specialists.map(s => ({ id: s.id, status: s.status, base_model: s.base_model })),
      },
      compounds_to: specialists.length > 0 ? `Specialist (${specialists[0].id})` : (invocations.length >= 1000 ? 'eligible for Specialist training' : 'still maturing'),
    });
  });

  // ---------- Capture-and-distill (rent-vs-buy) ----------
  // Drop-in proxy endpoints for Anthropic / OpenAI that record the (input,
  // output, latency_us, model, namespace) tuple on every call. The customer
  // points OPENAI_BASE_URL or ANTHROPIC_API_URL at us; their own provider
  // key arrives in `x-upstream-api-key`. We strip it on the way through and
  // never persist it. The capture rolls into the same `observations` table
  // that /v1/bridges/observe writes to, so /v1/bridges/auto-synthesize and
  // /v1/specialists/auto-distill can promote captures to recipes / LoRAs.

  function recordCapture({ tenant, provider, model, namespace, prompt, response, latency_us, status, cost_usd }) {
    if (!prompt || response === undefined || response === null) return null;
    const hash = promptHash(prompt + '|' + (model || ''));
    const obs = {
      id: 'cap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      tenant,
      template_hash: hash,
      template_preview: String(prompt).slice(0, 200),
      model: String(model || '').slice(0, 128),
      prompt: String(prompt).slice(0, 8000),
      variable_input: null,
      response: typeof response === 'string' ? response.slice(0, 16000) : response,
      latency_ms: Math.round((latency_us || 0) / 1000),
      latency_us: latency_us || 0,
      cost_usd: cost_usd || 0,
      provider,
      corpus_namespace: namespace,
      status,
      created_at: new Date().toISOString(),
    };
    try { insert('observations', obs); } catch (_) {}
    return obs;
  }

  // POST /v1/capture/anthropic — proxy to Anthropic, capture the round-trip.
  // The body is the upstream Anthropic Messages payload, unmodified.
  r.post('/v1/capture/anthropic', authMiddleware, async (req, res) => {
    if (!req.tenant_record && !req.tenant) return res.status(401).json({ error: 'auth required' });
    const upstreamKey = req.header('x-upstream-api-key') || req.header('x-anthropic-api-key') || '';
    const namespace = sanitizeNamespace(req.header('x-kolm-namespace') || req.query?.namespace || 'default');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: { type: 'invalid_request', message: 'messages array required' } });
    }
    const url = pickAnthropicUpstream();
    const anthropicVersion = req.header('anthropic-version') || '2023-06-01';
    let result;
    try {
      result = await forwardAnthropic({ url, body, upstreamKey, anthropicVersion });
    } catch (e) {
      return res.status(502).json({ error: { type: 'upstream_error', message: String(e.message || e) } });
    }
    const prompt = extractPromptForCapture(body, 'anthropic');
    const completion = result.status >= 200 && result.status < 300
      ? extractCompletionText(result.json, 'anthropic')
      : '';
    const obs = recordCapture({
      tenant: req.tenant,
      provider: 'anthropic',
      model: modelFromBody(body, 'anthropic'),
      namespace,
      prompt,
      response: completion || (result.json && result.json.error ? `[error] ${result.json.error.message || result.json.error.type || 'upstream'}` : ''),
      latency_us: result.elapsed_us || 0,
      status: result.status,
    });
    res.set('x-kolm-capture-id', obs ? obs.id : '');
    res.set('x-kolm-namespace', namespace);
    res.status(result.status).json(result.json);
  });

  // POST /v1/capture/openai — same shape, OpenAI Chat Completions API.
  r.post('/v1/capture/openai', authMiddleware, async (req, res) => {
    if (!req.tenant_record && !req.tenant) return res.status(401).json({ error: 'auth required' });
    // The kolm api key is in Authorization (auth middleware already consumed it).
    // The customer's real OpenAI key MUST come in x-upstream-api-key — we never
    // fall back to Authorization here, since that would forward our own key.
    const upstreamKey = req.header('x-upstream-api-key') || '';
    const namespace = sanitizeNamespace(req.header('x-kolm-namespace') || req.query?.namespace || 'default');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: { type: 'invalid_request', message: 'messages array required' } });
    }
    const url = pickOpenAIUpstream();
    let result;
    try {
      result = await forwardOpenAI({ url, body, upstreamKey });
    } catch (e) {
      return res.status(502).json({ error: { type: 'upstream_error', message: String(e.message || e) } });
    }
    const prompt = extractPromptForCapture(body, 'openai');
    const completion = result.status >= 200 && result.status < 300
      ? extractCompletionText(result.json, 'openai')
      : '';
    const obs = recordCapture({
      tenant: req.tenant,
      provider: 'openai',
      model: modelFromBody(body, 'openai'),
      namespace,
      prompt,
      response: completion || (result.json && result.json.error ? `[error] ${result.json.error.message || result.json.error.type || 'upstream'}` : ''),
      latency_us: result.elapsed_us || 0,
      status: result.status,
    });
    res.set('x-kolm-capture-id', obs ? obs.id : '');
    res.set('x-kolm-namespace', namespace);
    res.status(result.status).json(result.json);
  });

  // GET /v1/labels/synthesize-corpus?namespace=<n>&format=jsonl|json
  // Returns the captured (input, output) pairs for a namespace as JSONL or
  // a JSON envelope. This is what `kolm labels` downloads. Counts go to the
  // status command so the customer can see "ready to distill at 1000 pairs."
  r.get('/v1/labels/synthesize-corpus', authMiddleware, (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const namespace = sanitizeNamespace(req.query?.namespace || 'default');
    const fmt = String(req.query?.format || 'jsonl').toLowerCase();
    const limit = Math.min(Math.max(parseInt(String(req.query?.limit || '10000'), 10) || 10000, 1), 50000);
    const obs = all('observations').filter(o =>
      o.tenant === req.tenant && (o.corpus_namespace === namespace || (namespace === 'default' && !o.corpus_namespace))
    );
    const pairs = obs.slice(0, limit).map(o => ({
      input: o.prompt,
      output: o.response,
      model: o.model,
      provider: o.provider || null,
      latency_us: o.latency_us || (o.latency_ms || 0) * 1000,
      created_at: o.created_at,
    }));
    if (req.query?.count_only === '1' || req.query?.count_only === 'true') {
      return res.json({
        namespace,
        count: obs.length,
        ready_to_distill: obs.length >= 1000,
        threshold: 1000,
      });
    }
    if (fmt === 'jsonl' || fmt === 'ndjson') {
      const lines = pairs.map(p => JSON.stringify(p)).join('\n') + (pairs.length > 0 ? '\n' : '');
      res.set('content-type', 'application/x-ndjson');
      res.set('x-kolm-namespace', namespace);
      res.set('x-kolm-count', String(obs.length));
      return res.send(lines);
    }
    res.json({
      namespace,
      count: obs.length,
      returned: pairs.length,
      ready_to_distill: obs.length >= 1000,
      threshold: 1000,
      pairs,
    });
  });

  // POST /v1/specialists/auto-distill — kicks off LoRA training on the
  // namespace's captured corpus via the kolm trainer bridge.
  // {namespace, base_model, target_size} → {job_id, status_url}. Stubbed
  // until KOLM_TRAINER_BRIDGE_URL is configured; returns 503 with a clear
  // operator hint so the gap is visible (not silently no-op).
  r.post('/v1/specialists/auto-distill', authMiddleware, async (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const namespace = sanitizeNamespace((req.body || {}).namespace || req.query?.namespace || 'default');
    const base_model = String((req.body || {}).base_model || 'qwen2.5-coder-7b-instruct').slice(0, 128);
    const target_size = String((req.body || {}).target_size || 'phi-3-mini').slice(0, 64);
    const obs = all('observations').filter(o =>
      o.tenant === req.tenant && (o.corpus_namespace === namespace || (namespace === 'default' && !o.corpus_namespace))
    );
    if (obs.length < 1000) {
      return res.status(400).json({
        error: 'not enough captures',
        namespace,
        count: obs.length,
        threshold: 1000,
        message: `Capture ${1000 - obs.length} more pairs before distill is unlocked.`,
      });
    }
    const bridge = process.env.KOLM_TRAINER_BRIDGE_URL || process.env.REM_LABS_BRIDGE_URL;
    if (!bridge) {
      return res.status(503).json({
        ok: false,
        error: 'distill_bridge_not_configured',
        message: 'KOLM_TRAINER_BRIDGE_URL is not set on this server. Auto-distill is a hosted-cloud feature; on-prem trainer ships in Wave 2.',
        namespace,
        count: obs.length,
        next_steps: 'Email hello@kolm.ai to request access, or run `kolm labels --namespace <n> --out corpus.jsonl` and train locally.',
      });
    }
    const bridgeToken = process.env.KOLM_TRAINER_BRIDGE_TOKEN || process.env.REM_LABS_BRIDGE_TOKEN || '';
    // Bridge configured — POST to it and return the job id.
    try {
      const jobRes = await fetch(bridge.replace(/\/+$/, '') + '/distill', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${bridgeToken}` },
        body: JSON.stringify({
          tenant: req.tenant,
          namespace,
          base_model,
          target_size,
          pair_count: obs.length,
          callback_url: `${process.env.PUBLIC_BASE || 'https://kolm.ai'}/v1/specialists/auto-distill/callback`,
        }),
      });
      const text = await jobRes.text();
      let body;
      try { body = JSON.parse(text); } catch (_) { body = { _raw: text }; }
      if (!jobRes.ok) return res.status(502).json({ error: 'bridge_error', upstream_status: jobRes.status, upstream_body: body });
      return res.json({
        ok: true,
        job_id: body.job_id || null,
        status_url: body.status_url || null,
        namespace,
        base_model,
        target_size,
        pair_count: obs.length,
      });
    } catch (e) {
      return res.status(502).json({ error: 'bridge_unreachable', message: String(e.message || e) });
    }
  });

  // POST /v1/memory/recall — REM Memory ↔ Skills bridge.
  // Given a query, find recipes tagged with that namespace, run them, and return the merged result.
  r.post('/v1/memory/recall', async (req, res) => {
    const { query, namespace, input, k = 3 } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query is required' });
    try {
      // Search the registry with optional namespace filter.
      let matches = registry.searchSimilar({ query, tenant: req.tenant, k, tag: namespace });
      const results = [];
      for (const m of matches.slice(0, k)) {
        try {
          const out = await runtime.runConcept({ concept_id: m.concept_id, input: input ?? query, tenant: req.tenant });
          results.push({ recipe: m.name, recipe_id: m.concept_id, output: out.output, latency_us: out.latency_us, score: m.score });
        } catch (e) {
          results.push({ recipe: m.name, recipe_id: m.concept_id, error: String(e.message || e), score: m.score });
        }
      }
      res.json({ query, namespace: namespace || null, k: matches.length, results });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  return r;
}
