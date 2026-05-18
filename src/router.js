// HTTP route definitions for all three layers + admin/utility/public routes.

import express from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { synthesize, synthesizeStream } from './synthesis.js';
import { computeKScore } from './kscore.js';
import { handleAssistant } from './assistant.js';
import { effectiveReceiptSecret, isProductionRuntime, runtimeReadiness, tenantReceiptVerificationKeys } from './env.js';
import * as registry from './registry.js';
import * as runtime from './runtime.js';
import * as cache from './cache.js';
import { authMiddleware, provisionTenant, provisionAnonTenant, claimAnonTenant, chargeUsage, rotateTenantKey, rotateTenantReceiptSecret, listTenantReceiptSecrets, pruneTenantReceiptSecret, adminApiKey, findTenantByApiKey, findTenantByEmail, constantTimeEqual as constantTimeEq, requirePlan } from './auth.js';
import { mountOAuth, oauthConfigured } from './oauth.js';
import { sendWelcome, sendBillingActivated, sendBillingFailed, emailConfigured } from './email.js';
import { compileJs, verify } from './verifier.js';
import { LIBRARY_VERSION, libraryDescription } from './library.js';
import { all, findOne, findByField, findByTenant, insert, update, withTransaction, id as storeId, stats as storeStats } from './store.js';
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
import * as teams from './teams.js';
import * as tunnel from './tunnel.js';
import * as byoc from './byoc.js';
import * as traceCapture from './trace-capture.js';
import * as workflowIr from './workflow-ir.js';
import * as compileIr from './compile-ir.js';
import * as deviceCaps from './device-capabilities.js';
import * as confidentialCompute from './confidential-compute.js';
import * as federatedLearning from './federated-learning.js';
import * as artifactLineage from './artifact-lineage.js';
import { AUDIT_OPS, tryAppendAudit, listAuditEvents, verifyAuditChain } from './audit.js';
import { verifyCredential, PROVENANCE_SPEC } from './provenance.js';
import { verifySignatureBlock as verifyEd25519Block, keyFingerprint as ed25519Fingerprint, verify as ed25519Verify } from './ed25519.js';
import * as pubkeyDir from './pubkey-directory.js';
import { verifySigstoreBundle, attestWithRekor, fetchRekorEntryByLogIndex, rekorUrl as sigstoreRekorUrl, isDisabled as isSigstoreDisabled, submitToRekor } from './sigstore.js';
import { saveCorpus as saveTenantCorpus, loadCorpus as loadTenantCorpus, listCorpora as listTenantCorpora, deleteCorpus as deleteTenantCorpus, hashCorpusFile as hashTenantCorpusFile } from './tenant-holdout.js';
import { listArtifacts as marketplaceListArtifacts, getArtifact as marketplaceGetArtifact, getCatalogManifest as marketplaceGetCatalogManifest, resolveArtifactPath as marketplaceResolveArtifactPath } from './marketplace.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// W258-BE-1/2/3: wire the previously-dead durability + fan-out + alert
// modules. router.js never imported these so W212/W213/W215 wave-claims
// were on disk but not on the live request path. recordCapture() now
// awaits insertCapture (throws → caller returns 503), publishes to SSE
// subscribers, and fires threshold alerts atomically.
import {
  insertCapture,
  isDurable as captureIsDurable,
  driverName as captureDriverName,
  listCaptures,
  countCaptures,
  health as captureHealth,
} from './capture-store.js';
import {
  subscribe as subscribeCapture,
  subscribe as subscribeCaptureStream,
  publishCapture,
  subscriberCount as captureSubscriberCount,
} from './capture-stream.js';
import {
  THRESHOLDS,
  getPreferences as notifGetPreferences,
  setPreferences as notifSetPreferences,
  addPushSubscription as notifAddPushSubscription,
  removePushSubscription as notifRemovePushSubscription,
  listPushSubscriptions as notifListPushSubscriptions,
  getThresholdState as notifGetThresholdState,
  setThresholdState as notifSetThresholdState,
  tryAdvanceThresholdState as notifTryAdvanceThresholdState,
  thresholdCrossedBy as notifThresholdCrossedBy,
  isDistillReady as notifIsDistillReady,
  fireThresholdAlert as notifFireThresholdAlert,
  publicConfig as notifPublicConfig,
} from './notifications.js';

// Per-IP rate limiters (S5, S10). Express trust-proxy is set to 2 in
// server.js so X-Forwarded-For resolves through the Vercel→Railway chain.
// Vercel rotates client egress IPs within a /24 subnet on each request, so
// exact-IP keying would never accumulate hits. We coalesce IPv4 to /24 and
// IPv6 to /48 so a single client (NAT'd or not) maps to a stable key.
function ipKey(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = req.ip || xff || req.socket?.remoteAddress || 'unknown';
  // Strip IPv4-mapped-IPv6 prefix and any zone-id suffix.
  const stripped = raw.replace(/^::ffff:/, '').replace(/%.*$/, '');
  // IPv4 → /24 (first 3 octets). IPv6 → /48 (first 3 hextets).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(stripped)) {
    const parts = stripped.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (stripped.includes(':')) {
    const hex = stripped.split(':').slice(0, 3).join(':');
    return `${hex}::/48`;
  }
  return stripped || 'unknown';
}

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
  keyGenerator: ipKey,
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

// Enterprise inquiry intake (KOLM-102). Public form on /enterprise/inquiry.
// 5 hits per IP per hour is enough for a real buyer to make typos and retry,
// but blocks form-spammer scripts. ipKey() coalesces /24 to survive Vercel
// rotating egress IPs within a subnet.
const enterpriseLeadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited — enterprise inquiries cap at 5/hour/ip' },
  keyGenerator: ipKey,
  validate: { trustProxy: false },
});

// In-memory store for enterprise leads. The richer canonical store layer
// (src/store.js) is reserved for tenant-owned records; lead intake is
// stateless from the buyer's perspective and email is the source of truth.
// Process-restart resets the array; Resend has the durable record.
const enterpriseLeads = [];

// W261: /v1/builder/preview is intentionally unauthenticated so a curious
// visitor can try the no-code builder without signing up. Rate-limit to
// keep synthesis cost predictable. Compile requires auth (separate path).
const builderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate-limited - builder preview caps at 30/min/ip' },
  keyGenerator: ipKey,
  validate: { trustProxy: false },
});

// W261: starter templates shown on /builder. Each template has a task
// description and a small example set the user can clone with one click.
// These are the 5 named starters: PHI redactor, invoice parser,
// MSA clause extraction, PR review, multilingual greeting.
const BUILDER_TEMPLATES = [
  {
    id: 'phi-redactor',
    name: 'PHI redactor',
    description: 'Strip protected health information from clinical notes. Replaces names, MRNs, dates, and contact fields with [REDACTED].',
    task: 'Redact protected health information (PHI) from clinical notes. Replace patient names, dates of birth, medical record numbers, phone numbers, and email addresses with [REDACTED].',
    examples: [
      { input: 'Patient John Smith (MRN 12345, DOB 1975-04-12) presented with chest pain. Phone 415-555-0142.', expected: 'Patient [REDACTED] (MRN [REDACTED], DOB [REDACTED]) presented with chest pain. Phone [REDACTED].' },
      { input: 'Mary Johnson, age 56, email mary.j@example.com, reports headache for 3 days.', expected: '[REDACTED], age 56, email [REDACTED], reports headache for 3 days.' },
      { input: 'Discharge summary for Robert Lee (DOB 1962-11-08): patient stable.', expected: 'Discharge summary for [REDACTED] (DOB [REDACTED]): patient stable.' },
    ],
  },
  {
    id: 'invoice-parser',
    name: 'Invoice parser',
    description: 'Extract structured fields (invoice number, date, amount, vendor) from raw invoice text.',
    task: 'Parse an invoice text blob and return a JSON object with fields: invoice_number, date, amount_usd, vendor.',
    examples: [
      { input: 'Invoice #INV-2026-0042 dated 2026-05-15, amount $1,249.00, Acme Corp.', expected: { invoice_number: 'INV-2026-0042', date: '2026-05-15', amount_usd: 1249.00, vendor: 'Acme Corp' } },
      { input: 'Bill INV-7781 from Globex on 2026-04-30 for $89.50.', expected: { invoice_number: 'INV-7781', date: '2026-04-30', amount_usd: 89.50, vendor: 'Globex' } },
      { input: 'Invoice INV-9023, dated 2026-03-12, total $542.75, vendor Initech.', expected: { invoice_number: 'INV-9023', date: '2026-03-12', amount_usd: 542.75, vendor: 'Initech' } },
    ],
  },
  {
    id: 'msa-clause-extraction',
    name: 'MSA clause extraction',
    description: 'Pull named clauses (indemnity, termination, governing law) out of a Master Services Agreement.',
    task: 'Read a Master Services Agreement and return a JSON object naming the section that covers each of: indemnity, termination, governing_law.',
    examples: [
      { input: 'Section 7. Indemnity. Provider shall indemnify Customer... Section 11. Termination. Either party may terminate... Section 14. Governing Law. This Agreement is governed by Delaware.', expected: { indemnity: 'Section 7', termination: 'Section 11', governing_law: 'Section 14' } },
      { input: '12.1 Termination for cause. 12.2 Termination for convenience. 8. Indemnification by Vendor. 19. Governing law and venue: California.', expected: { indemnity: '8', termination: '12', governing_law: '19' } },
    ],
  },
  {
    id: 'pr-review',
    name: 'PR review',
    description: 'One-line summary plus risk label (low, medium, high) for a pull-request diff.',
    task: 'Read a pull-request title and diff and return a JSON object with a one-sentence summary and a risk label of low, medium, or high.',
    examples: [
      { input: 'Title: fix off-by-one in pagination\nDiff: -    if (i < n)\n+    if (i <= n)', expected: { summary: 'Fixes off-by-one bug in pagination loop.', risk: 'low' } },
      { input: 'Title: drop production index\nDiff: -CREATE INDEX users_email_idx ON users(email);', expected: { summary: 'Drops the users_email_idx index in production.', risk: 'high' } },
    ],
  },
  {
    id: 'multilingual-greeting',
    name: 'Multilingual greeting',
    description: 'Pick the localized greeting for a language code (en, es, fr, de, ja, zh).',
    task: 'Given a language code, return the appropriate greeting: en -> Hello, es -> Hola, fr -> Bonjour, de -> Hallo, ja -> Konnichiwa, zh -> Ni hao.',
    examples: [
      { input: 'en', expected: 'Hello' },
      { input: 'es', expected: 'Hola' },
      { input: 'fr', expected: 'Bonjour' },
      { input: 'de', expected: 'Hallo' },
      { input: 'ja', expected: 'Konnichiwa' },
      { input: 'zh', expected: 'Ni hao' },
    ],
  },
];

const PRICING = {
  synthesis_small: 0.10,   // < 1 KB generator
  synthesis_large: 1.00,   // 1 KB - 32 KB
  registry_per_gb_month: 0.01,
  registry_per_million_reads: 0.10,
  runtime_per_million: 0.20,
  runtime_cache_per_million: 0.05,
};

// Cryptographic receipts — every /v1/run call returns a signed proof that
// (source, input) → output. The issuer or any holder of the shared tenant
// receipt secret can re-verify with /v1/receipts/verify (server-side
// recompute) or offline. Ed25519 public-key receipts are roadmap.
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

  // W313 — public anonymous "try it" demo of the capture-receipt shape.
  // No auth, no write side-effects; visitors on /value-loop POST a prompt+response
  // and see the exact same receipt envelope a real authenticated /v1/bridges/observe
  // would emit, with `demo:true` + `durable:false` so the body cannot lie.
  r.post('/v1/loop/try', (req, res) => {
    const { prompt = '', response = '', model = 'kolm-demo' } = req.body || {};
    if (!prompt || !response) {
      return res.status(400).json({ error: 'prompt_and_response_required' });
    }
    if (String(prompt).length > 2000 || String(response).length > 2000) {
      return res.status(413).json({ error: 'payload_too_large', limit: 2000 });
    }
    const sig = templateSignature(String(prompt), String(model));
    res.set('x-kolm-capture-durable', 'false');
    res.set('x-kolm-capture-demo', 'true');
    res.json({
      demo: true,
      durable: false,
      observation_id: 'demo_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      template_hash: sig.hash,
      template_preview: sig.normalized,
      model: String(model).slice(0, 128),
      cluster_size: 1,
      ready_for_synthesis: false,
      note: 'demo only · not written to durable store · use POST /v1/bridges/observe with a tenant key to actually capture',
    });
  });

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
    // Refuse to mint a second tenant for the same email. Silently re-issuing
    // a fresh key creates undiscoverable orphan tenants and rotates the
    // legitimate owner's credential without their consent. 409 nudges the
    // caller to OAuth or account recovery.
    const existingTenant = findTenantByEmail(email);
    if (existingTenant) {
      return res.status(409).json({
        error: 'email_exists',
        hint: 'an account already exists for this email; sign in via OAuth (/v1/oauth/google/start) or contact founders@kolm.ai for account recovery',
        tenant: { id: existingTenant.id, name: existingTenant.name, plan: existingTenant.plan },
      });
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

    // Immediately set the kolm_session cookie so the browser is signed in.
    // Removes the "save your api key and paste it into the sign-in form"
    // friction. The api_key is still returned in the response body so CLI
    // callers can capture it.
    const isProdSignup = isProductionRuntime();
    res.cookie('kolm_session', t.api_key, {
      httpOnly: true,
      secure: isProdSignup,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

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
        return res.status(400).json({
          error: 'PASSWORD_AUTH_NOT_SUPPORTED',
          hint: 'Sign in with your ks_ API key (paste it from /signup) or use Google OAuth at /v1/oauth/google / GitHub OAuth at /v1/oauth/github.',
        });
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
      sameSite: 'lax',
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
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
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
    const rows = registry.listConcepts({ tenant: '__public__', limit: 200 })
      .filter(c => c.visibility === 'public');
    // Project the head version's evaluation + signature so the Atlas / Leaderboard
    // pages can display K-score, size, latency, and signature evidence when the
    // author publishes them. Vector is stripped to keep the payload small.
    const concepts = rows.map(c => {
      if (!c.head_version) return c;
      const v = findOne('versions', x => x.id === c.head_version);
      if (!v) return c;
      const { vector, ...rest } = v;
      return {
        ...c,
        created_at: v.created_at || c.updated_at,
        latest_version: { ...rest, vector_dim: vector ? vector.length : 0 },
      };
    });
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

  // Public receipt verification endpoint — unauthenticated convenience that
  // recomputes the HMAC server-side using the service's receipt secret.
  // This is NOT public-key cryptographic verification; that requires either
  // the shared tenant receipt secret (issuer/holder offline path) or the
  // roadmap Ed25519 receipt mode. Accepts the legacy rs-1 receipt (hmac
  // field), v0.1 receipt (kolm_version="0.1", chain[], signature), and the
  // {artifact_hash, signature} drive-by shape.
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
      // Wave 149: strip signature_ed25519. Wave 150: also strip
      // signature_sigstore. Both are added AFTER the HMAC is computed, so
      // the canonical payload at sign-time excluded them.
      const { signature, signature_ed25519, signature_sigstore, ...bodyNoSig } = receipt;
      const bodyCanon = canonicalJson(bodyNoSig);
      const expectedBody = crypto.createHmac('sha256', RECEIPT_SECRET).update(bodyCanon).digest('hex');
      const sigOk = signature && signature.length === expectedBody.length && (() => {
        let d = 0;
        for (let i = 0; i < expectedBody.length; i++) d |= signature.charCodeAt(i) ^ expectedBody.charCodeAt(i);
        return d === 0;
      })();
      if (!sigOk) reasons.push('signature mismatch');
      // Wave 149: Ed25519 public-key signature verification. When the
      // receipt carries signature_ed25519, verify it against the embedded
      // public key. No shared secret needed — any third party can do this.
      // Ed25519 signed canonical(body WITH HMAC, WITHOUT ed25519 or sigstore).
      let ed25519Ok = null;
      let ed25519Fingerprint = null;
      if (signature_ed25519) {
        const ed25519Payload = canonicalJson({ ...bodyNoSig, signature });
        const r = verifyEd25519Block(signature_ed25519, ed25519Payload);
        ed25519Ok = r.ok;
        ed25519Fingerprint = r.key_fingerprint || null;
        if (!ed25519Ok) reasons.push('ed25519 verification failed: ' + (r.reason || 'unknown'));
      }
      // Wave 150: sigstore (cosign-compatible) bundle verification.
      // Sigstore signed canonical(body WITH HMAC + ed25519, WITHOUT sigstore).
      let sigstoreReport = null;
      if (signature_sigstore) {
        const sigstorePayload = canonicalJson({ ...bodyNoSig, signature, signature_ed25519 });
        const r = verifySigstoreBundle(signature_sigstore, sigstorePayload);
        sigstoreReport = {
          verified: r.ok,
          key_fingerprint: r.key_fingerprint || null,
          dry_run: r.dry_run ?? null,
          rekor_log_index: r.rekor_log_index ?? null,
          rekor_uuid: r.rekor_uuid ?? null,
          rekor_integrated_time: r.rekor_integrated_time ?? null,
          rekor_log_id: r.rekor_log_id ?? null,
          inclusion_proof_present: r.inclusion_proof_present ?? false,
          digest_hex: r.digest_hex ?? null,
          reason: r.ok ? null : r.reason,
        };
        if (!r.ok) reasons.push('sigstore verification failed: ' + (r.reason || 'unknown'));
      }
      const verified = chainOk && sigOk && (ed25519Ok !== false) && (sigstoreReport ? sigstoreReport.verified : true);
      return res.json({
        verified,
        reasons,
        receipt_id: receipt.receipt_id,
        cid: receipt.cid || null,
        artifact_hash: receipt.artifact_hash,
        eval_set_hash: receipt.eval_set_hash,
        eval_score: receipt.eval_score,
        judge_id: receipt.judge_id,
        signature_alg: receipt.signature_alg || 'hmac-sha256',
        ed25519: signature_ed25519 ? { verified: ed25519Ok, key_fingerprint: ed25519Fingerprint } : null,
        sigstore: sigstoreReport,
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

  // KOLM-109: Public receipt-by-hash lookup. Anyone with the hash can verify
  // a receipt was issued, when, and that the HMAC chain is intact, without
  // auth. Tenant identity is hidden by default; tenants opt into showing
  // their handle by setting tenant.public_receipts = true. The hash can be
  // any of: artifact_hash, cid, receipt_id, or signature (since all four are
  // unique identifiers and a buyer might paste any of them).
  // Wave 149 — public-key directory for Ed25519 receipt signing keys.
  //
  // GET  /v1/keys/public                  → list every registered key
  // GET  /v1/keys/public/:fingerprint     → fetch a single key by fingerprint
  // POST /v1/keys/challenge               → request a proof-of-control nonce
  // POST /v1/keys/register                → register {challenge_id, public_key, signature}
  // DELETE /v1/keys/public/:fingerprint   → admin-only delete (requires admin key)
  //
  // No auth on the GET endpoints: discovering a tenant's public key is
  // explicitly public — that's the whole point of a key directory. POST
  // /v1/keys/challenge and POST /v1/keys/register are also public because
  // the challenge → sign → register flow self-proves the holder controls
  // the private key. The DELETE requires admin because key removal would
  // otherwise let an attacker invalidate a tenant's receipt verification
  // by deleting their published key.
  r.get('/v1/keys/public', (_req, res) => {
    try {
      return res.json({ keys: pubkeyDir.listKeys(), stats: pubkeyDir.stats() });
    } catch (e) {
      return res.status(500).json({ error: 'pubkey directory unavailable', detail: e.message });
    }
  });
  r.get('/v1/keys/public/:fingerprint', (req, res) => {
    const fp = String(req.params.fingerprint || '').trim();
    if (!/^[0-9a-fA-F]{8,64}$/.test(fp)) {
      return res.status(400).json({ error: 'fingerprint must be 8-64 hex chars', code: 'INVALID_FINGERPRINT' });
    }
    const entry = pubkeyDir.getKey(fp);
    if (!entry) return res.status(404).json({ error: 'fingerprint not registered', code: 'KEY_NOT_FOUND' });
    return res.json(entry);
  });
  r.post('/v1/keys/challenge', (req, res) => {
    const body = req.body || {};
    try {
      const ch = pubkeyDir.issueChallenge({
        tenant_id: typeof body.tenant_id === 'string' ? body.tenant_id : null,
        label: typeof body.label === 'string' ? body.label.slice(0, 120) : null,
      });
      return res.json(ch);
    } catch (e) {
      return res.status(500).json({ error: 'cannot issue challenge', detail: e.message });
    }
  });
  r.post('/v1/keys/register', (req, res) => {
    const body = req.body || {};
    try {
      const entry = pubkeyDir.registerKey({
        challenge_id: body.challenge_id,
        public_key: body.public_key,
        signature: body.signature,
        label: typeof body.label === 'string' ? body.label.slice(0, 120) : null,
        tenant_id: typeof body.tenant_id === 'string' ? body.tenant_id : null,
      });
      return res.json({ ok: true, key: entry });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message, code: 'REGISTER_FAILED' });
    }
  });
  r.delete('/v1/keys/public/:fingerprint', (req, res) => {
    const adminKey = adminApiKey();
    const supplied = String(req.headers['x-admin-key'] || '').trim();
    if (!adminKey || !supplied || !constantTimeEq(adminKey, supplied)) {
      return res.status(401).json({ error: 'admin key required', code: 'ADMIN_REQUIRED' });
    }
    const fp = String(req.params.fingerprint || '').trim();
    const ok = pubkeyDir.deleteKey(fp);
    return res.json({ ok, fingerprint: fp });
  });

  // Wave 150 — sigstore (cosign-compatible) attestation + verification.
  //
  // POST /v1/sigstore/attest    upgrade a dry-run sigstore block to a
  //                              Rekor-pinned bundle. Requires the receipt
  //                              already carry signature_ed25519 + the
  //                              KOLM_SIGSTORE_REKOR_URL env var to be set
  //                              on the server. Body shape:
  //                                { receipt: <receipt-with-dry-run-sigstore> }
  //                              Returns: { ok, sigstore_block, receipt }
  //                              where sigstore_block has rekor_log_entry
  //                              populated.
  //
  // GET  /v1/sigstore/health    quick probe — reports whether the server
  //                              has a Rekor URL configured + whether the
  //                              integration is enabled.
  //
  // GET  /v1/sigstore/entry/:logIndex   forward to Rekor and return the
  //                              raw entry. Public — Rekor is public.
  r.get('/v1/sigstore/health', (_req, res) => {
    return res.json({
      enabled: !isSigstoreDisabled(),
      rekor_url: sigstoreRekorUrl(),
      mode: sigstoreRekorUrl() ? 'rekor-pinned' : 'dry-run',
    });
  });
  r.get('/v1/sigstore/entry/:logIndex', async (req, res) => {
    const raw = String(req.params.logIndex || '').trim();
    const idx = Number(raw);
    if (!Number.isInteger(idx) || idx < 0) {
      return res.status(400).json({ error: 'logIndex must be a non-negative integer', code: 'INVALID_LOG_INDEX' });
    }
    if (!sigstoreRekorUrl()) {
      return res.status(503).json({ error: 'no Rekor URL configured on this server', code: 'REKOR_NOT_CONFIGURED' });
    }
    try {
      const entry = await fetchRekorEntryByLogIndex(idx);
      if (!entry) return res.status(404).json({ error: 'entry not found in Rekor', code: 'REKOR_ENTRY_NOT_FOUND' });
      return res.json({ entry });
    } catch (e) {
      return res.status(502).json({ error: 'rekor fetch failed', detail: e.message });
    }
  });
  r.post('/v1/sigstore/attest', async (req, res) => {
    const body = req.body || {};
    const receipt = body.receipt;
    if (!receipt || typeof receipt !== 'object') {
      return res.status(400).json({ error: 'receipt body required', code: 'RECEIPT_REQUIRED' });
    }
    if (!receipt.signature_ed25519 || !receipt.signature_sigstore) {
      return res.status(400).json({
        error: 'receipt must already carry signature_ed25519 and a dry-run signature_sigstore block; rebuild artifact with Wave 150+ first',
        code: 'PRE_ATTEST_BLOCKS_REQUIRED',
      });
    }
    if (!sigstoreRekorUrl()) {
      return res.status(503).json({
        error: 'no KOLM_SIGSTORE_REKOR_URL configured on this server; cannot pin to Rekor',
        code: 'REKOR_NOT_CONFIGURED',
      });
    }
    try {
      const existing = receipt.signature_sigstore;
      // Reconstruct the canonical payload the existing bundle attests to
      // (receipt body without sigstore block) and re-sign + submit.
      const { signature_sigstore, ...payloadWithoutSigstore } = receipt;
      void signature_sigstore;
      const payloadCanonical = canonicalJson(payloadWithoutSigstore);
      // The bundle carries the public key but not the private key; without
      // the private key we cannot re-sign. The expected attest flow is:
      //   1) build artifact (dry-run sigstore block written with key on disk)
      //   2) `kolm sigstore-attest` re-loads the key from the build host
      //   3) server endpoint is used only by callers that POST a
      //      pre-signed bundle they want submitted to Rekor on their behalf
      // For (3), the input body MUST include the signature in raw form,
      // already produced by the caller's private key. We forward to Rekor
      // and return the merged bundle.
      const pkB64 = existing?.bundle?.verificationMaterial?.publicKey?.rawBytes;
      const sigB64 = existing?.bundle?.messageSignature?.signature;
      const digestB64 = existing?.bundle?.messageSignature?.messageDigest?.digest;
      if (!pkB64 || !sigB64 || !digestB64) {
        return res.status(400).json({
          error: 'incoming sigstore block missing required bundle fields',
          code: 'BUNDLE_INCOMPLETE',
        });
      }
      const publicKey = Buffer.from(pkB64, 'base64').toString('utf8');
      // Re-derive the digest from the payload bytes server-side; reject if
      // it diverges from the caller's claim (defends against the caller
      // sending a digest unrelated to the receipt body).
      const expectedDigestHex = crypto.createHash('sha256').update(payloadCanonical, 'utf8').digest('hex');
      const claimedDigestHex = Buffer.from(digestB64, 'base64').toString('hex');
      if (expectedDigestHex !== claimedDigestHex) {
        return res.status(400).json({
          error: 'bundle messageDigest does not match receipt body sha256',
          code: 'DIGEST_MISMATCH',
        });
      }
      // Bypass attestWithRekor (which would re-sign locally); we already have
      // the caller's signature, so just POST hashedrekord to Rekor.
      const entry = await submitToRekor({
        publicKey,
        signatureB64: sigB64,
        digestHex: expectedDigestHex,
      });
      if (!entry) return res.status(502).json({ error: 'Rekor submission failed', code: 'REKOR_FAILED' });
      const merged = { ...existing, rekor_log_entry: entry, dry_run: false };
      return res.json({ ok: true, sigstore_block: merged });
    } catch (e) {
      return res.status(500).json({ error: 'attest failed', detail: e.message });
    }
  });

  r.get('/v1/receipts/:hash/public', (req, res) => {
    const raw = String(req.params.hash || '').trim();
    if (!raw || !/^[A-Za-z0-9._\-]{8,128}$/.test(raw)) {
      return res.status(400).json({ error: 'invalid hash format', code: 'INVALID_HASH' });
    }
    // Find a compile_job whose receipt or artifact matches this hash. Search
    // is O(N) over compile_jobs but bounded by tenant data and well below
    // the cost of an HMAC verify, so no separate index is needed yet.
    const matches = (j) => {
      if (!j || j._deleted || j._bootstrap) return false;
      const r = j.receipt || {};
      return j.artifact_hash === raw
        || j.cid === raw
        || r.artifact_hash === raw
        || r.cid === raw
        || r.receipt_id === raw
        || r.signature === raw;
    };
    let job = null;
    try { job = (all('compile_jobs') || []).find(matches) || null; } catch (_) { job = null; }
    if (!job || !job.receipt) {
      return res.status(404).json({ error: 'receipt not found', code: 'RECEIPT_NOT_FOUND' });
    }
    const receipt = job.receipt;
    // Re-verify the chain using the global receipt secret. Receipts signed
    // with a per-tenant key are verified against the tenant's full key list
    // (current + previous + global fallback), so a rotated tenant key still
    // verifies older receipts.
    const tenant = (job.tenant_id || job.tenant)
      ? findOne('tenants', x => !x._deleted && (
          (job.tenant_id && x.id === job.tenant_id) ||
          (job.tenant && x.name === job.tenant)
        ))
      : null;
    const candidates = tenant ? tenantReceiptVerificationKeys(tenant) : [];
    if (!candidates.length && RECEIPT_SECRET) candidates.push({ secret: RECEIPT_SECRET, key_id: 'global' });
    if (!candidates.length) {
      return res.status(503).json({ error: 'receipt secret not configured on this server', code: 'SECRET_UNAVAILABLE' });
    }
    let chainValid = false;
    let signatureValid = false;
    const reasons = [];
    for (const { secret } of candidates) {
      // v0.1 chain. Each link seals {step, input_hash, output_hash}.
      let chainOk = Array.isArray(receipt.chain) && receipt.chain.length > 0;
      if (chainOk) {
        for (let i = 0; i < receipt.chain.length; i++) {
          const link = receipt.chain[i];
          const expected = crypto.createHmac('sha256', secret)
            .update(canonicalJson({ step: link.step, input_hash: link.input_hash, output_hash: link.output_hash }))
            .digest('hex');
          if (link.hmac !== expected) { chainOk = false; break; }
          if (i > 0 && link.input_hash !== receipt.chain[i - 1].output_hash) { chainOk = false; break; }
        }
      }
      // Body signature seals the receipt minus its own .signature field.
      // Wave 149: also strip signature_ed25519 (added after HMAC sign-time).
      const { signature, signature_ed25519, ...bodyNoSig } = receipt;
      const expectedBody = crypto.createHmac('sha256', secret).update(canonicalJson(bodyNoSig)).digest('hex');
      const sigOk = !!signature && signature.length === expectedBody.length && (() => {
        let d = 0;
        for (let i = 0; i < expectedBody.length; i++) d |= signature.charCodeAt(i) ^ expectedBody.charCodeAt(i);
        return d === 0;
      })();
      if (chainOk && sigOk) { chainValid = true; signatureValid = true; break; }
    }
    if (!chainValid) reasons.push('chain hmac did not verify with any known key');
    if (!signatureValid) reasons.push('body signature did not verify with any known key');
    // Manifest summary. Only fields safe to share publicly. No tenant data,
    // no eval set rows, no PHI surfaces (manifests never carry any).
    const m = job.manifest || {};
    const manifestSummary = {
      base_model: m.base_model || null,
      tier: m.tier || null,
      runtime: m.runtime || null,
      target_device: m.target_device || null,
      train_device: m.train_device || null,
      task: typeof m.task === 'string' ? m.task.slice(0, 200) : null,
    };
    const tenantPublic = !!(tenant && tenant.public_receipts === true);
    const tenantHandle = tenantPublic ? (tenant.name || null) : null;
    res.json({
      hash: raw,
      receipt_id: receipt.receipt_id || null,
      cid: receipt.cid || null,
      artifact_hash: receipt.artifact_hash || job.artifact_hash || null,
      signed_at: receipt.signed_at || job.completed_at || job.created_at || null,
      ring_count: Array.isArray(receipt.chain) ? receipt.chain.length : 0,
      chain_valid: chainValid && signatureValid,
      reasons: chainValid && signatureValid ? [] : reasons,
      k_score: typeof job.k_score === 'number' ? job.k_score : (typeof m.k_score === 'number' ? m.k_score : null),
      eval_score: typeof receipt.eval_score === 'number' ? receipt.eval_score : null,
      tenant_handle: tenantHandle,
      recipe_count: m.recipes && typeof m.recipes.n === 'number' ? m.recipes.n : null,
      manifest_summary: manifestSummary,
      signature_alg: receipt.signature_alg || 'hmac-sha256',
      signed_by: receipt.signed_by || null,
      kolm_version: receipt.kolm_version || null,
    });
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

  // ---------- /v1/builder/* — no-code in-browser artifact builder (W261) ----------
  // Two of the three builder endpoints are unauthed: anyone can fetch templates
  // or preview a K-score estimate without an API key. The compile endpoint is
  // authed and lives further down, after the auth gate is mounted.

  // GET /v1/builder/templates — public list of starter templates.
  r.get('/v1/builder/templates', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ templates: BUILDER_TEMPLATES });
  });

  // POST /v1/builder/preview — synthesize a recipe and estimate K-score.
  // Rate-limited; no auth. Inputs are validated tightly so this cannot be
  // used as a generic compute oracle. The 10 KB per-example cap matches the
  // body limit on /v1/compile and keeps the synthesis cost bounded.
  r.post('/v1/builder/preview', builderLimiter, async (req, res) => {
    try {
      const body = req.body || {};
      const task = body.task;
      const examples = Array.isArray(body.examples) ? body.examples : [];
      if (!task || typeof task !== 'string') {
        return res.status(400).json({ error: 'task (string) required' });
      }
      if (task.length > 4000) {
        return res.status(400).json({ error: 'task too long (>4000 chars)' });
      }
      if (examples.length > 100) {
        return res.status(400).json({ error: 'examples capped at 100 entries' });
      }
      for (let i = 0; i < examples.length; i++) {
        const ex = examples[i];
        if (!ex || typeof ex !== 'object') {
          return res.status(400).json({ error: 'each example must be an object {input, expected}' });
        }
        const bytes = Buffer.byteLength(JSON.stringify(ex), 'utf8');
        if (bytes > 10240) {
          return res.status(400).json({ error: `example ${i} exceeds 10240 bytes` });
        }
      }
      const warnings = [];
      if (examples.length < 3) warnings.push({ code: 'few_examples', message: 'add at least 3 examples for a reliable estimate' });

      // Synthesize a recipe from the supplied positives. The pattern-mode
      // synthesizer is deterministic and runs without an API key, so the
      // preview path always returns SOMETHING (even when synthesis cannot
      // satisfy the gate it returns the best candidate with accepted:false).
      let synth;
      try {
        synth = await synthesize({
          positives: examples,
          negatives: [],
          output_spec: { type: 'string' },
          priors: { hint: task.slice(0, 800) },
        });
      } catch (e) {
        return res.status(500).json({ error: 'synthesis_failed', detail: String(e.message || e) });
      }

      const recipe_source = synth.source || synth.best_source || '';
      const passRate = synth.pass_rate_positive ?? synth.best_result?.pass_rate_positive ?? 0;
      const latencyUs = synth.latency_p50_us ?? synth.best_result?.latency_p50_us ?? null;
      const sizeBytes = synth.size_bytes ?? (recipe_source ? Buffer.byteLength(recipe_source, 'utf8') : 0);
      const coverage = examples.length ? 1 : 0;

      const k_score_estimate = computeKScore({
        accuracy: passRate,
        coverage,
        size_bytes: sizeBytes,
        p50_latency_us: latencyUs,
        cost_usd_per_call: 0,
      });

      if (!synth.accepted) {
        warnings.push({ code: 'below_gate', message: synth.reason || 'quality below gate; add more examples or tighten the task' });
      }
      if (passRate < 1 && examples.length > 0) {
        warnings.push({ code: 'partial_pass', message: `recipe passes ${Math.round(passRate * 100)}% of the supplied positives` });
      }

      res.json({
        ok: true,
        accepted: !!synth.accepted,
        recipe_source,
        k_score_estimate,
        warnings,
        synth: {
          quality_score: synth.quality_score ?? synth.best_result?.quality_score ?? null,
          strategy: synth.strategy || null,
          attempts: synth.attempts_n || null,
        },
      });
    } catch (e) {
      res.status(500).json({ error: 'preview_failed', detail: String(e.message || e) });
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
  // W234 — accept-list of chat templates the registered .kolm runtime can
  // serialize. Mirrors src/chat-templates.js TEMPLATES keys; bumping the
  // registry must also bump this enum so badly-named requests reject early.
  const VALID_CHAT_TEMPLATES = new Set([
    'chatml', 'qwen-3-thinking', 'llama-3', 'phi-3', 'deepseek-v4', 'plain',
  ]);
  r.post('/v1/compile', async (req, res) => {
    const { task, examples = [], corpus_namespace, base_model, deploy_hook, preset, lora_rank, k_threshold,
            chat_template, thinking_mode, recipe_class, hw_tier, output_target, multi_device } = req.body || {};
    if (!task || typeof task !== 'string') return res.status(400).json({ error: 'task (string) required' });
    if (task.length > 4000) return res.status(400).json({ error: 'task description too long (>4000 chars)' });
    if (examples && (!Array.isArray(examples) || examples.length > 200)) {
      return res.status(400).json({ error: 'examples must be an array with ≤200 entries' });
    }
    if (deploy_hook && (typeof deploy_hook !== 'string' || !/^https:\/\//i.test(deploy_hook) || deploy_hook.length > 2048)) {
      return res.status(400).json({ error: 'deploy_hook must be an https URL (≤2048 chars)' });
    }
    if (preset != null && typeof preset !== 'string') return res.status(400).json({ error: 'preset must be a string' });
    if (lora_rank != null && (typeof lora_rank !== 'number' || lora_rank < 4 || lora_rank > 64)) {
      return res.status(400).json({ error: 'lora_rank must be a number in [4..64]' });
    }
    if (k_threshold != null && (typeof k_threshold !== 'number' || k_threshold < 0.50 || k_threshold > 0.99)) {
      return res.status(400).json({ error: 'k_threshold must be a number in [0.50..0.99]' });
    }
    if (chat_template != null && (typeof chat_template !== 'string' || !VALID_CHAT_TEMPLATES.has(chat_template))) {
      return res.status(400).json({ error: 'chat_template must be one of ' + Array.from(VALID_CHAT_TEMPLATES).join(', ') });
    }
    if (thinking_mode != null && typeof thinking_mode !== 'boolean') {
      return res.status(400).json({ error: 'thinking_mode must be a boolean' });
    }
    // W243 — canonical enums shared with /v1/specialists/auto-distill + cmdCompile + cmdDistill + cmdTui + /account.
    // Recipe class drives the manifest's spec_class field; hw_tier drives base_model + quant selection;
    // output_target picks the runtime format (gguf|onnx|safetensors|coreml|mlx|executorch|tensorrt|native-c|native-rust|wasm);
    // multi_device is an array (cap 6) of edge surfaces to cross-compile for.
    if (recipe_class != null && !['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'].includes(recipe_class)) {
      return res.status(400).json({ error: "recipe_class must be one of 'rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'" });
    }
    if (hw_tier != null && !['auto', 'cpu-server', '3090', '4090', '5090', 'm4-max-128', 'a100-80', 'h100-80', 'h200-141', 'dgx-spark', 'm3-ultra-512'].includes(hw_tier)) {
      return res.status(400).json({ error: "hw_tier must be one of 'auto', 'cpu-server', '3090', '4090', '5090', 'm4-max-128', 'a100-80', 'h100-80', 'h200-141', 'dgx-spark', 'm3-ultra-512'" });
    }
    if (output_target != null && !['gguf', 'onnx', 'safetensors', 'coreml', 'mlx', 'executorch', 'tensorrt', 'native-c', 'native-rust', 'wasm'].includes(output_target)) {
      return res.status(400).json({ error: "output_target must be one of 'gguf', 'onnx', 'safetensors', 'coreml', 'mlx', 'executorch', 'tensorrt', 'native-c', 'native-rust', 'wasm'" });
    }
    if (multi_device != null) {
      if (!Array.isArray(multi_device)) return res.status(400).json({ error: 'multi_device must be an array' });
      if (multi_device.length > 6) return res.status(400).json({ error: 'multi_device exceeds max 6 targets' });
      const VALID_MD = ['phone-ios', 'phone-android', 'laptop-cpu', 'browser-wasm', 'edge-jetson', 'server-cuda'];
      for (const d of multi_device) {
        if (!VALID_MD.includes(d)) return res.status(400).json({ error: `multi_device entry '${d}' must be one of ${VALID_MD.join(', ')}` });
      }
    }
    const job = createJob({
      task, examples, corpus_namespace, base_model,
      tenant: req.tenant, tenant_id: req.tenant_record?.id || null,
      deploy_hook, preset, lora_rank, k_threshold,
      chat_template, thinking_mode,
    });
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
      registry: {
        createConcept: registry.createConcept,
        publishVersion: registry.publishVersion,
      },
      outDir: process.env.KOLM_ARTIFACT_DIR,
    };
    // On serverless platforms the function instance is killed shortly after
    // res.end(), so a fire-and-forget runJob would never complete. Await it
    // there; on long-running self-hosted nodes, fire and forget for snappy
    // 202s. The pattern-mode synthesizer typically finishes in <1s.
    // Bill the compile up-front. One compile = 10 units (compiles are
    // expensive vs. runs). Charging here (not inside runJob) keeps the
    // billing path single-threaded so concurrent compiles can't race the
    // counter — only the request handler holds tenant_record.
    chargeUsage(req.tenant_record, 10);
    tryAppendAudit({
      tenant_id: req.tenant_record?.id || req.tenant,
      tenant_name: req.tenant_record?.name || null,
      actor: 'tenant',
      op: AUDIT_OPS.COMPILE_CREATED,
      payload: { job_id: job.id, base_model: job.base_model, examples_n: job.examples_n },
    });
    const ON_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    if (ON_SERVERLESS || req.query.sync === '1') {
      try { await runJob(job, ctx); } catch (e) { /* runJob persists its own error state */ }
      const fresh = getJob(job.id, req.tenant) || job;
      if (fresh.status === 'completed') {
        tryAppendAudit({
          tenant_id: req.tenant_record?.id || req.tenant,
          tenant_name: req.tenant_record?.name || null,
          actor: 'tenant',
          op: AUDIT_OPS.COMPILE_COMPLETED,
          payload: { job_id: fresh.id, k_score: fresh.k_score ?? null, artifact_hash: fresh.artifact_hash || null, cid: fresh.cid || null, version_id: fresh.version_id || null },
        });
      } else if (fresh.status === 'failed') {
        tryAppendAudit({
          tenant_id: req.tenant_record?.id || req.tenant,
          tenant_name: req.tenant_record?.name || null,
          actor: 'tenant',
          op: AUDIT_OPS.COMPILE_FAILED,
          payload: { job_id: fresh.id, error: fresh.error || 'unknown' },
        });
      }
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
    // Strip artifact_path (local path leak) and deploy_hook (caller's webhook,
    // not meant to round-trip back to the client).
    const { artifact_path, deploy_hook, ...safe } = j;
    res.json({
      ...safe,
      artifact_url: j.status === 'completed' ? `/v1/compile/${j.id}/.kolm` : null,
      deploy_hook_set: !!deploy_hook,
    });
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

  // POST /v1/builder/compile — authed wrapper that turns the no-code builder's
  // {task, examples} payload into a real compile job. Validation matches
  // /v1/builder/preview so a Preview→Compile flow that passes preview also
  // passes here; the only added requirement is the API key (handled by
  // authMiddleware mounted above this line). Recipe class and namespace are
  // forced so builder-originated artifacts are distinguishable in audits.
  r.post('/v1/builder/compile', async (req, res) => {
    try {
      const body = req.body || {};
      const task = body.task;
      const examples = Array.isArray(body.examples) ? body.examples : [];
      if (!task || typeof task !== 'string') {
        return res.status(400).json({ error: 'task (string) required' });
      }
      if (task.length > 4000) {
        return res.status(400).json({ error: 'task too long (>4000 chars)' });
      }
      if (examples.length > 100) {
        return res.status(400).json({ error: 'examples capped at 100 entries' });
      }
      for (let i = 0; i < examples.length; i++) {
        const ex = examples[i];
        if (!ex || typeof ex !== 'object') {
          return res.status(400).json({ error: 'each example must be an object {input, expected}' });
        }
        const bytes = Buffer.byteLength(JSON.stringify(ex), 'utf8');
        if (bytes > 10240) {
          return res.status(400).json({ error: `example ${i} exceeds 10240 bytes` });
        }
      }

      const job = createJob({
        task,
        examples,
        corpus_namespace: 'builder',
        recipe_class: 'synthesized_rule',
        tenant: req.tenant,
        tenant_id: req.tenant_record?.id || null,
      });
      const ctx = {
        synthesize,
        publicRecipes: () => [],
        examples,
        recall: { query: () => [] },
        registry: {
          createConcept: registry.createConcept,
          publishVersion: registry.publishVersion,
        },
        outDir: process.env.KOLM_ARTIFACT_DIR,
      };
      chargeUsage(req.tenant_record, 10);
      tryAppendAudit({
        tenant_id: req.tenant_record?.id || req.tenant,
        tenant_name: req.tenant_record?.name || null,
        actor: 'tenant',
        op: AUDIT_OPS.COMPILE_CREATED,
        payload: { job_id: job.id, source: 'builder', examples_n: job.examples_n },
      });
      const ON_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
      if (ON_SERVERLESS || req.query.sync === '1') {
        try { await runJob(job, ctx); } catch (e) { /* runJob persists its own error state */ }
        const fresh = getJob(job.id, req.tenant) || job;
        return res.status(202).json({
          job_id: fresh.id,
          status: fresh.status,
          poll: `/v1/compile/${fresh.id}`,
          artifact_url: fresh.status === 'completed' ? `/v1/compile/${fresh.id}/.kolm` : null,
        });
      }
      setImmediate(() => runJob(job, ctx));
      res.status(202).json({
        job_id: job.id,
        status: job.status,
        poll: `/v1/compile/${job.id}`,
      });
    } catch (e) {
      res.status(500).json({ error: 'builder_compile_failed', detail: String(e.message || e) });
    }
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
      cid: j.cid || j.manifest?.cid || null,
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

  // CID lookup — content-addressed resolution within the caller's tenant
  // scope. Two compiles that produce the same bytes (same task spec, same
  // recipes, same evals, same base model pointer) yield the same CID; this
  // route is how downstream tools dedupe by content rather than job_id.
  // CID format is strictly validated to keep the path safe from injection.
  r.get('/v1/cid/:cid', (req, res) => {
    const cid = String(req.params.cid || '');
    if (!/^cidv\d+:[a-z0-9-]+:[0-9a-f]{8,128}$/.test(cid)) {
      return res.status(400).json({ error: 'malformed cid', spec: 'cidv1:sha256:<64-hex>' });
    }
    const jobs = listJobs(req.is_admin ? null : req.tenant, 200)
      .filter(j => j.status === 'completed' && (j.cid === cid || j.manifest?.cid === cid));
    if (!jobs.length) return res.status(404).json({ error: 'cid not found in this tenant', cid });
    res.json({
      cid,
      n: jobs.length,
      artifacts: jobs.map(jobToArtifact),
    });
  });

  // /v1/recipes/* — SDK-conventional aliases over the artifact/job surface.
  // POST /v1/compile returns a job_id of shape `job_*`. Conventional SDKs
  // expect GET /v1/recipes/{id} to return the recipe (artifact) and POST
  // /v1/recipes/{id}/run to invoke it. We alias the existing handlers so
  // developers don't dead-end on 404s.
  r.get('/v1/recipes/:id', (req, res) => {
    const j = getJob(req.params.id, req.is_admin ? null : req.tenant);
    if (j) return res.json(jobToArtifact(j));
    // Fall back to the concept registry — :id may be a concept_id rather
    // than a job_id when callers conflate the two nouns.
    try {
      const c = registry.getConcept(req.params.id, req.tenant, req.tenant_record?.id);
      if (c) return res.json(c);
    } catch (_) {}
    res.status(404).json({ error: 'recipe not found' });
  });

  r.get('/v1/recipes/:id/download', (req, res) => {
    const j = getJob(req.params.id, req.is_admin ? null : req.tenant);
    if (!j) return res.status(404).json({ error: 'recipe not found' });
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

  // /v1/registry/submit — community recipe intake. Validates the shape, logs
  // the submission to data/registry-submissions.jsonl, and returns 202 with a
  // submission_id. Verification (fetch+CID-check+K-score-replay) is a manual
  // step today; see /registry/submit for the human flow. POST body schema is
  // SubmitRequest in /openapi.json.
  r.post('/v1/registry/submit', (req, res) => {
    const body = req.body || {};
    const errs = [];
    const urlOk = typeof body.artifact_url === 'string' && /^https?:\/\/[^\s]{6,2048}$/i.test(body.artifact_url);
    const nameOk = typeof body.name === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(body.name);
    const taskOk = typeof body.task === 'string' && body.task.length >= 4 && body.task.length <= 280;
    if (!urlOk) errs.push('artifact_url must be a valid http(s) URL');
    if (!nameOk) errs.push('name must be 2-64 chars, kebab-case');
    if (!taskOk) errs.push('task must be 4-280 chars');
    if (errs.length) return res.status(400).json({ error: 'invalid submission', detail: errs });
    const submission_id = 'sub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const record = {
      submission_id,
      status: 'pending',
      artifact_url: body.artifact_url,
      name: body.name,
      task: body.task,
      submitter: body.email || req.tenant?.email || null,
      received_at: new Date().toISOString(),
    };
    try {
      const dir = process.env.KOLM_DATA_DIR || path.resolve('data');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'registry-submissions.jsonl'), JSON.stringify(record) + '\n');
    } catch (e) {
      // Best-effort log; never fail the request because we couldn't persist.
    }
    res.status(202).json({ submission_id, status: 'pending' });
  });

  // /v1/registry/search — programmatic discovery. Filters: task (substring on
  // name/description/tags), min_k_score, max_size_mb, hardware tag, limit.
  // Public concepts only. Used by IDE plugins, CI gates, and the registry UI's
  // chip filters. Returns same shape as /v1/registry/public.
  r.get('/v1/registry/search', (req, res) => {
    const q = String(req.query.task || req.query.q || '').toLowerCase().trim();
    const minK = req.query.min_k_score != null ? Number(req.query.min_k_score) : null;
    const maxSizeMB = req.query.max_size_mb != null ? Number(req.query.max_size_mb) : null;
    const hardware = String(req.query.hardware || '').toLowerCase().trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    if (minK != null && (!Number.isFinite(minK) || minK < 0 || minK > 1)) {
      return res.status(400).json({ error: 'min_k_score must be between 0 and 1' });
    }
    if (maxSizeMB != null && (!Number.isFinite(maxSizeMB) || maxSizeMB <= 0)) {
      return res.status(400).json({ error: 'max_size_mb must be a positive number' });
    }
    const concepts = all('concepts').filter(c => c.visibility === 'public');
    const versions = all('versions');
    const matches = [];
    for (const c of concepts) {
      const v = versions.find(x => x.id === c.head_version);
      if (q) {
        const haystack = [c.name, c.description, ...(c.tags || [])].join(' ').toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      if (minK != null) {
        const k = v?.evaluation?.quality_score;
        if (typeof k !== 'number' || k < minK) continue;
      }
      if (maxSizeMB != null) {
        const sz = v?.evaluation?.size_bytes;
        if (typeof sz !== 'number' || sz > maxSizeMB * 1024 * 1024) continue;
      }
      if (hardware) {
        const hwTags = (c.tags || []).map(t => String(t).toLowerCase());
        if (!hwTags.some(t => t.includes(hardware))) continue;
      }
      matches.push({
        id: c.id,
        name: c.name,
        description: c.description,
        tags: c.tags || [],
        head_version: c.head_version,
        size_bytes: v?.evaluation?.size_bytes ?? null,
        latency_p50_us: v?.evaluation?.latency_p50_us ?? null,
        quality_score: v?.evaluation?.quality_score ?? null,
        updated_at: c.updated_at,
      });
    }
    matches.sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0));
    res.json({
      query: { task: q || null, min_k_score: minK, max_size_mb: maxSizeMB, hardware: hardware || null, limit },
      n: Math.min(matches.length, limit),
      total: matches.length,
      artifacts: matches.slice(0, limit),
    });
  });

  // ---------- Hub — verifiable artifact gallery ----------
  // The hub is where compiled .kolm artifacts get published, listed, and
  // pulled. Distinct from /v1/registry/* (concept recipes / source) — this
  // surface stores the *output* binaries with their K-score, base model,
  // SHA-256, and signed receipt. Handle shape: <owner>/<name>[@sha256:hex].
  // Publish requires auth (API key); reads are public for visibility=public.

  function hubSlug(s, { max = 64 } = {}) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max);
  }

  // POST /v1/hub/publish
  // body: { name, visibility?: 'public'|'private', artifact_b64, metadata? }
  // Stores the artifact bytes + metadata. Returns { handle, owner, name, sha256, url }.
  r.post('/v1/hub/publish', publishLimiter, authMiddleware, (req, res) => {
    const body = req.body || {};
    const name = hubSlug(body.name);
    if (!name || name.length < 2) {
      return res.status(400).json({ error: 'name required (2-64 chars, kebab-case)' });
    }
    const visibility = body.visibility === 'public' ? 'public' : 'private';
    const b64 = String(body.artifact_b64 || '');
    if (!b64) return res.status(400).json({ error: 'artifact_b64 required' });
    // Cap at 25MB raw (~33MB base64).
    if (b64.length > 33 * 1024 * 1024) {
      return res.status(413).json({ error: 'artifact too large (max 25 MB)' });
    }
    let bytes;
    try {
      bytes = Buffer.from(b64, 'base64');
      if (bytes.length === 0) throw new Error('empty');
    } catch (e) {
      return res.status(400).json({ error: 'artifact_b64 is not valid base64' });
    }
    const sha256Hex = crypto.createHash('sha256').update(bytes).digest('hex');

    // Team-scoped publish (wave 57): if the caller passes `team`, resolve it to
    // a team record, verify membership, and use the team slug as the artifact
    // owner namespace. Private team artifacts are readable by any member, not
    // just the publisher — that's the Teams-tier ($149/mo) unlock.
    const teamArg = body.team ? String(body.team).trim() : null;
    let teamRow = null;
    if (teamArg) {
      teamRow = teams.getTeam(teamArg);
      if (!teamRow) {
        return res.status(404).json({ error: `team not found: ${teamArg}` });
      }
      if (!teams.isMember(teamRow.id, req.tenant_record?.id || req.tenant)) {
        return res.status(403).json({ error: `not a member of team ${teamRow.slug}` });
      }
    }
    const owner = teamRow
      ? teamRow.slug
      : hubSlug(req.tenant_record?.handle || req.tenant_record?.name || req.tenant_record?.id || req.tenant || 'anon');
    if (!owner) return res.status(400).json({ error: 'cannot derive owner from tenant' });

    // Reject duplicate publish of same owner/name unless sha differs; same sha = idempotent.
    const existing = findOne('hub_artifacts', x => x.owner === owner && x.name === name);
    if (existing && existing.sha256 !== sha256Hex) {
      return res.status(409).json({ error: `already published as ${owner}/${name}; bump --name or republish with --replace` });
    }

    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    const row = existing || {
      id: storeId('hub'),
      owner,
      name,
      visibility,
      team_id: teamRow ? teamRow.id : null,
      publisher_tenant_id: req.tenant_record?.id || req.tenant || null,
      sha256: sha256Hex,
      size_bytes: bytes.length,
      artifact_b64: b64,
      metadata: {
        artifact_id: metadata.artifact_id || null,
        k_score: metadata.k_score != null ? Number(metadata.k_score) : null,
        gate: metadata.gate != null ? Number(metadata.gate) : null,
        base_model: metadata.base_model || null,
        task: metadata.task || null,
        tags: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 16).map(String) : [],
        license: metadata.license || null,
        receipt: metadata.receipt || null,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      update('hub_artifacts', x => x.id === existing.id, {
        visibility,
        metadata: row.metadata,
        updated_at: new Date().toISOString(),
      });
    } else {
      insert('hub_artifacts', row);
    }

    const fwdHost = req.headers['x-forwarded-host'];
    const fwdProto = req.headers['x-forwarded-proto'];
    const host = (typeof fwdHost === 'string' && fwdHost) ? fwdHost.split(',')[0].trim() : req.get('host');
    const proto = (typeof fwdProto === 'string' && fwdProto) ? fwdProto.split(',')[0].trim() : req.protocol;
    const baseUrl = `${proto}://${host}`;
    res.status(existing ? 200 : 201).json({
      handle: `${owner}/${name}@sha256:${sha256Hex.slice(0, 8)}`,
      owner,
      name,
      sha256: sha256Hex,
      size_bytes: bytes.length,
      url: `${baseUrl}/v1/hub/${owner}/${name}`,
      download_url: `${baseUrl}/v1/hub/${owner}/${name}/download`,
      visibility,
    });
  });

  // GET /v1/hub — public list, most-recent first, paginated by `limit`.
  r.get('/v1/hub', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const q = String(req.query.q || '').toLowerCase().trim();
    const rows = all('hub_artifacts').filter(x => x.visibility === 'public');
    const filtered = q
      ? rows.filter(x => (x.name + ' ' + x.owner + ' ' + (x.metadata?.task || '') + ' ' + (x.metadata?.tags || []).join(' ')).toLowerCase().includes(q))
      : rows;
    const sorted = filtered.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    res.json({
      total: filtered.length,
      artifacts: sorted.slice(0, limit).map(x => ({
        handle: `${x.owner}/${x.name}`,
        owner: x.owner,
        name: x.name,
        sha256: x.sha256,
        size_bytes: x.size_bytes,
        k_score: x.metadata?.k_score,
        gate: x.metadata?.gate,
        base_model: x.metadata?.base_model,
        task: x.metadata?.task,
        tags: x.metadata?.tags || [],
        license: x.metadata?.license,
        updated_at: x.updated_at,
      })),
    });
  });

  // GET /v1/hub/:owner/:name — public metadata for a single artifact.
  r.get('/v1/hub/:owner/:name', (req, res) => {
    const owner = hubSlug(req.params.owner);
    const name = hubSlug(req.params.name);
    const row = findOne('hub_artifacts', x => x.owner === owner && x.name === name);
    if (!row) return res.status(404).json({ error: 'not found' });
    // Private rows: owner-private OR team-private. For team-scoped artifacts
    // (row.team_id set), any active team member can read. Otherwise only the
    // owning tenant. 404 (not 403) avoids leaking existence to non-members.
    if (row.visibility !== 'public') {
      const reqTenantId = req.tenant_record?.id || req.tenant || '';
      const reqOwner = hubSlug(req.tenant_record?.handle || req.tenant_record?.name || req.tenant_record?.id || req.tenant || '');
      const isTeamMember = row.team_id && reqTenantId && teams.isMember(row.team_id, reqTenantId);
      if (!isTeamMember && reqOwner !== owner) {
        return res.status(404).json({ error: 'not found' });
      }
    }
    const fwdHost = req.headers['x-forwarded-host'];
    const fwdProto = req.headers['x-forwarded-proto'];
    const host = (typeof fwdHost === 'string' && fwdHost) ? fwdHost.split(',')[0].trim() : req.get('host');
    const proto = (typeof fwdProto === 'string' && fwdProto) ? fwdProto.split(',')[0].trim() : req.protocol;
    const baseUrl = `${proto}://${host}`;
    res.json({
      handle: `${row.owner}/${row.name}@sha256:${row.sha256.slice(0, 8)}`,
      owner: row.owner,
      name: row.name,
      sha256: row.sha256,
      size_bytes: row.size_bytes,
      visibility: row.visibility,
      metadata: row.metadata,
      download_url: `${baseUrl}/v1/hub/${row.owner}/${row.name}/download`,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  });

  // GET /v1/hub/:owner/:name/download — binary download, content-type application/octet-stream.
  r.get('/v1/hub/:owner/:name/download', (req, res) => {
    const owner = hubSlug(req.params.owner);
    const name = hubSlug(req.params.name);
    const row = findOne('hub_artifacts', x => x.owner === owner && x.name === name);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.visibility !== 'public') {
      const reqTenantId = req.tenant_record?.id || req.tenant || '';
      const reqOwner = hubSlug(req.tenant_record?.handle || req.tenant_record?.name || req.tenant_record?.id || req.tenant || '');
      const isTeamMember = row.team_id && reqTenantId && teams.isMember(row.team_id, reqTenantId);
      if (!isTeamMember && reqOwner !== owner) {
        return res.status(404).json({ error: 'not found' });
      }
    }
    const bytes = Buffer.from(row.artifact_b64, 'base64');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${row.name}.kolm"`);
    res.set('X-Kolm-Sha256', row.sha256);
    res.set('X-Kolm-Owner', row.owner);
    res.set('X-Kolm-Name', row.name);
    res.send(bytes);
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
  r.get('/v1/recall/sources/:id(*)', async (req, res) => {
    // The :id is a URL-encoded relative path inside the tenant corpus. We
    // resolve it against the per-tenant slice of KOLM_RECALL_ROOT — admins can
    // see across tenants, tenants only see their own.
    //
    // W252: stat first, reject sidecars over 1 MiB with 413 (don't slurp the
    // whole file into memory + block the event loop). Read via fs.promises so
    // the request thread never blocks on disk I/O.
    const MAX_BYTES = 1024 * 1024;
    const root = process.env.KOLM_RECALL_ROOT || os.tmpdir();
    const tenantRoot = path.resolve(root, req.tenant || '_anon');
    const lookupRoot = req.is_admin ? path.resolve(root) : tenantRoot;
    const id = decodeURIComponent(req.params.id || '');
    const full = path.resolve(lookupRoot, id);
    // W258-SEC-2: startsWith alone is a prefix-collision bug. lookupRoot
    // `/root/acme` would accept `/root/acme-evil/secret` because the prefix
    // matches without a separator. Require either exact equality OR the
    // prefix to end with the platform path separator (Windows + POSIX).
    const rootWithSep = lookupRoot.endsWith(path.sep) ? lookupRoot : lookupRoot + path.sep;
    if (full !== lookupRoot && !full.startsWith(rootWithSep)) {
      return res.status(400).json({ error: 'path escapes recall root' });
    }
    const sidecar = full.endsWith('.md') ? full : full + '.md';
    let st;
    try {
      st = await fs.promises.stat(sidecar);
    } catch {
      return res.status(404).json({ error: 'sidecar not found' });
    }
    if (st.size > MAX_BYTES) {
      return res.status(413).json({ error: 'sidecar too large', max_bytes: MAX_BYTES, size: st.size });
    }
    const text = await fs.promises.readFile(sidecar, 'utf-8');
    res.json({ id, sidecar, length: text.length, preview: text.slice(0, 4096) });
  });

  // ---------- Natural-language assistant ----------
  // POST /v1/assistant { prompt } returns a parsed-intent action + result.
  // Scoped to req.tenant_record; never calls an external LLM; deterministic.
  r.post('/v1/assistant', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json({ ok: false, error: 'auth_required' });
    try {
      const deps = {
        // compile actually kicks off a real compile job (no LLM round-trip;
        // the synthesizer is pattern-mode + deterministic). On serverless we
        // await synchronously since the worker dies after res.end(); on
        // long-running self-hosted nodes we fire-and-forget so the caller
        // can poll.
        compile: async ({ task }) => {
          const job = createJob({ task, examples: [], tenant: req.tenant });
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
                out.push({ id: c.id, name: c.name, source: vs[0].source, source_hash: vs[0].evaluation?.source_hash || null, version_id: vs[0].id, tags: c.tags || [], schema: c.schema || null });
              }
              return out;
            },
            examples: [],
            recall: { query: ({ namespace, query, k }) => recall.query({ tenant: req.tenant, namespace, query, k }) },
            outDir: process.env.KOLM_ARTIFACT_DIR,
          };
          const ON_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
          if (ON_SERVERLESS) {
            try { await runJob(job, ctx); } catch {}
            const fresh = getJob(job.id, req.tenant) || job;
            return {
              job_id: fresh.id,
              status: fresh.status,
              progress: fresh.progress || 0,
              k_score: fresh.k_score || null,
              artifact_url: fresh.status === 'completed' ? `/v1/compile/${fresh.id}/.kolm` : null,
              poll: `/v1/compile/${fresh.id}`,
              task,
            };
          }
          setImmediate(() => runJob(job, ctx));
          return {
            job_id: job.id,
            status: job.status,
            progress: 0,
            poll: `/v1/compile/${job.id}`,
            artifact_url: null,
            task,
          };
        },
        run: async ({ tenant, concept_id, input }) => {
          try {
            return await runtime.runConcept({ concept_id, input, tenant });
          } catch (e) {
            return { error: String(e.message || e) };
          }
        },
        // Tenant-scoped job lookup for the job_status intent. Admins can
        // look up any job; tenants are scoped to their own. Returns null
        // when not found so the assistant can surface a clean error.
        lookupJob: ({ job_id }) => {
          if (!job_id) return null;
          return getJob(job_id, req.is_admin ? null : req.tenant);
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
    // req.api_key is set by authMiddleware (auth.js:376) for every AUTHED request,
    // so it's the authoritative raw-key source. Tenants post-migration store only
    // api_key_hash; the plain t.api_key column is no longer read here.
    const rawKey = req.api_key || null;
    // Sliding session: refresh the kolm_session cookie on every authenticated
    // /v1/account hit so an active user keeps a fresh 30-day expiry. Stale
    // sessions still expire on schedule when the user goes quiet.
    if (rawKey) {
      try {
        res.cookie('kolm_session', rawKey, {
          httpOnly: true,
          secure: isProductionRuntime(),
          sameSite: 'lax',
          maxAge: 30 * 24 * 60 * 60 * 1000,
          path: '/',
        });
      } catch (_) {}
    }
    // Do not leak the raw api_key in the response body — the httpOnly cookie
    // (kolm_session, refreshed above) carries all subsequent auth. Expose only
    // a prefix for display. Removes XSS exfil surface for zero functional cost.
    const apiKeyPrefix = typeof rawKey === 'string' && rawKey.length > 0
      ? rawKey.slice(0, 8) + '...'
      : (t.api_key_prefix || null);
    res.json({
      id: t.id,
      name: t.name,
      email: t.email || null,
      api_key_prefix: apiKeyPrefix,
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
    tryAppendAudit({
      tenant_id: req.tenant_record.id,
      tenant_name: req.tenant_record.name || null,
      actor: 'tenant',
      op: AUDIT_OPS.KEY_ROTATED,
      payload: { api_key_prefix: typeof k === 'string' ? k.slice(0, 12) : null },
    });
    res.json({ api_key: k });
  });

  // Rotate the per-tenant receipt-signing secret. Previous secret is
  // preserved so older signed artifacts and audit rows still verify.
  r.post('/v1/account/rotate-receipt-secret', (req, res) => {
    if (!req.tenant_record) return res.status(403).json({ error: 'admin tokens cannot rotate' });
    try {
      const result = rotateTenantReceiptSecret(req.tenant_record.id);
      tryAppendAudit({
        tenant_id: req.tenant_record.id,
        tenant_name: req.tenant_record.name || null,
        actor: 'tenant',
        op: AUDIT_OPS.KEY_ROTATED,
        payload: { kind: 'receipt_secret', key_id: result.key_id, previous_count: result.previous_count },
      });
      res.json({ ok: true, ...result, note: 'new receipts are signed with this key_id; older artifacts still verify with the preserved previous key' });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  // List receipt-signing key metadata for the calling tenant. Secrets are
  // never returned — only the key_id, status, and rotation timestamps.
  r.get('/v1/account/receipt-secrets', (req, res) => {
    if (!req.tenant_record) return res.status(403).json({ error: 'admin tokens cannot read tenant receipt keys' });
    try {
      const out = listTenantReceiptSecrets(req.tenant_record.id);
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  // Drop a specific previous key from the verification ring. Receipts signed
  // with that key will no longer verify against this tenant after this call.
  // The current key cannot be pruned — rotate first to retire it.
  r.post('/v1/account/receipt-secret/prune', (req, res) => {
    if (!req.tenant_record) return res.status(403).json({ error: 'admin tokens cannot prune' });
    const key_id = String((req.body || {}).key_id || '').trim();
    if (!key_id) return res.status(400).json({ error: 'key_id is required' });
    try {
      const result = pruneTenantReceiptSecret(req.tenant_record.id, key_id);
      tryAppendAudit({
        tenant_id: req.tenant_record.id,
        tenant_name: req.tenant_record.name || null,
        actor: 'tenant',
        op: AUDIT_OPS.KEY_ROTATED,
        payload: { kind: 'receipt_secret_pruned', key_id, remaining_count: result.remaining_count },
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
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

  // ---------- Admin console endpoints ----------
  // Read-only admin surface for the founder console at /admin. Gated by
  // req.is_admin (ADMIN_KEY in env). Returns scrubbed views — no raw api_keys,
  // no per-tenant secrets — just operational shape: who, what plan, how much
  // they've used, what they're running. Cross-tenant by design.
  r.get('/v1/admin/tenants', (req, res) => {
    if (!req.is_admin) return res.status(403).json({ error: 'admin only' });
    const q = String(req.query.q || '').toLowerCase().trim();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 200, 1000));
    const rows = all('tenants')
      .filter(t => !q || (String(t.name || '').toLowerCase().includes(q) || String(t.email || '').toLowerCase().includes(q)))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, limit)
      .map(t => ({
        id: t.id,
        name: t.name,
        email: t.email || null,
        plan: t.plan || 'free',
        quota: t.quota || 0,
        used: t.used || 0,
        remaining: Math.max(0, (t.quota || 0) - (t.used || 0)),
        seats: t.seats || 1,
        auth_provider: t.auth_provider || 'apikey',
        billing_status: t.billing_status || (t.plan === 'free' ? 'free' : 'active'),
        created_at: t.created_at || null,
        last_used_at: t.last_used_at || null,
        kind: t.kind || 'real',
        api_key_prefix: t.api_key_prefix || null,
      }));
    res.json({ total: rows.length, tenants: rows });
  });

  r.get('/v1/admin/stats', (req, res) => {
    if (!req.is_admin) return res.status(403).json({ error: 'admin only' });
    const tenants = all('tenants');
    const planDist = tenants.reduce((acc, t) => { const p = t.plan || 'free'; acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    const totalUsed = tenants.reduce((acc, t) => acc + (t.used || 0), 0);
    const totalQuota = tenants.reduce((acc, t) => acc + (t.quota || 0), 0);
    const now = Date.now();
    const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const signups24h = tenants.filter(t => t.created_at && t.created_at >= since24h).length;
    const signups7d = tenants.filter(t => t.created_at && t.created_at >= since7d).length;
    const signups30d = tenants.filter(t => t.created_at && t.created_at >= since30d).length;
    const compileJobs = (() => { try { return all('compile_jobs'); } catch (_) { return []; } })();
    const compiles24h = compileJobs.filter(j => j.created_at && j.created_at >= since24h).length;
    const compiles7d = compileJobs.filter(j => j.created_at && j.created_at >= since7d).length;
    const auditRows = (() => { try { return all('audit_events'); } catch (_) { return []; } })();
    const audit24h = auditRows.filter(a => a.at && a.at >= since24h).length;
    res.json({
      tenants: { total: tenants.length, plan_dist: planDist, signups_24h: signups24h, signups_7d: signups7d, signups_30d: signups30d },
      usage: { total_used: totalUsed, total_quota: totalQuota },
      compile: { total: compileJobs.length, last_24h: compiles24h, last_7d: compiles7d },
      audit: { total: auditRows.length, last_24h: audit24h },
      generated_at: new Date().toISOString(),
    });
  });

  r.get('/v1/admin/audit', (req, res) => {
    if (!req.is_admin) return res.status(403).json({ error: 'admin only' });
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 200, 1000));
    const rows = (() => { try { return all('audit_events'); } catch (_) { return []; } })()
      .slice()
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      .slice(0, limit)
      .map(r => ({
        id: r.id,
        at: r.at,
        op: r.op,
        actor: r.actor || null,
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_name || null,
        payload: r.payload || {},
      }));
    res.json({ total: rows.length, events: rows });
  });

  r.get('/v1/admin/compile-jobs', (req, res) => {
    if (!req.is_admin) return res.status(403).json({ error: 'admin only' });
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 500));
    const rows = (() => { try { return all('compile_jobs'); } catch (_) { return []; } })()
      .slice()
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, limit)
      .map(j => ({
        id: j.id,
        tenant: j.tenant,
        task: j.task,
        status: j.status,
        k_score: (j.result && j.result.k_score) || null,
        created_at: j.created_at,
        completed_at: j.completed_at || null,
      }));
    res.json({ total: rows.length, jobs: rows });
  });

  r.get('/v1/admin/health', (req, res) => {
    if (!req.is_admin) return res.status(403).json({ error: 'admin only' });
    let store_stats = null;
    try { store_stats = storeStats(); } catch (_) {}
    res.json({
      now: new Date().toISOString(),
      region: process.env.REGION || process.env.RAILWAY_REGION || 'unknown',
      node_version: process.version,
      uptime_sec: Math.floor(process.uptime()),
      store: store_stats,
      memory: process.memoryUsage(),
      env: {
        anthropic_configured: !!process.env.ANTHROPIC_API_KEY,
        stripe_configured: !!process.env.STRIPE_SECRET_KEY,
        email_configured: !!process.env.RESEND_API_KEY,
        oauth_google: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
        oauth_github: !!process.env.GITHUB_OAUTH_CLIENT_ID,
      },
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

    // W252: wrap idempotency + plan mutation in withTransaction. If any write
    // throws (corrupt stripe_events.json, sqlite locked, disk full), the
    // tenant row stays unchanged and we surface 503 webhook_store_unavailable
    // so Stripe retries. The old silent-swallow on insert(stripe_events) is
    // gone; tenant lookups go through findOne, not full table scans.
    let outcome;
    try {
      outcome = withTransaction(() => {
        // Idempotency: skip if this event id is already recorded.
        const seen = findOne('stripe_events', e => e.id === event.id);
        if (seen) return { kind: 'idempotent', body: { received: true, idempotent: true, id: event.id } };
        insert('stripe_events', { id: event.id, type: event.type, received_at: new Date().toISOString() });

        if (event.type === 'checkout.session.completed') {
          const s = event.data && event.data.object || {};
          const tenantId = s.client_reference_id;
          const planId = planFromAmount(s.amount_total);
          if (!tenantId) return { kind: 'ok', body: { received: true, warning: 'no client_reference_id', id: event.id } };
          const tenant = findOne('tenants', t => t.id === tenantId);
          if (!tenant) return { kind: 'ok', body: { received: true, warning: 'tenant not found', id: event.id } };
          const resolvedPlan = planId || tenant.pending_plan || null;
          if (!resolvedPlan || !PLAN_CATALOG[resolvedPlan]) {
            return { kind: 'ok', body: { received: true, warning: 'no plan match', amount_total: s.amount_total, id: event.id } };
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
          return { kind: 'ok', body: { received: true, plan: resolvedPlan, tenant: tenantId, id: event.id }, sideEffect: { kind: 'activated', tenant } };
        }

        if (event.type === 'customer.subscription.updated') {
          const sub = event.data && event.data.object || {};
          const tenant = findOne('tenants', t => t.stripe_subscription_id === sub.id);
          if (!tenant) return { kind: 'ok', body: { received: true, warning: 'tenant not found', id: event.id } };
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
          return { kind: 'ok', body: { received: true, billing_status: billingStatus, tenant: tenant.id, id: event.id } };
        }

        if (event.type === 'customer.subscription.deleted') {
          const sub = event.data && event.data.object || {};
          const tenant = findOne('tenants', t => t.stripe_subscription_id === sub.id);
          if (!tenant) return { kind: 'ok', body: { received: true, warning: 'tenant not found', id: event.id } };
          update('tenants', x => x.id === tenant.id, {
            plan: 'free',
            quota: PLAN_CATALOG.free.quota,
            seats: PLAN_CATALOG.free.seats,
            pending_plan: null,
            cancelled_at: new Date().toISOString(),
            billing_status: 'cancelled',
          });
          return { kind: 'ok', body: { received: true, plan: 'free', tenant: tenant.id, id: event.id } };
        }

        if (event.type === 'invoice.payment_failed') {
          const inv = event.data && event.data.object || {};
          const tenant = findOne('tenants', t =>
            t.stripe_subscription_id === inv.subscription ||
            t.stripe_customer_id === inv.customer
          );
          if (tenant) {
            update('tenants', x => x.id === tenant.id, { billing_status: 'past_due' });
            return { kind: 'ok', body: { received: true, action: 'past_due_marked', tenant: tenant.id, id: event.id }, sideEffect: { kind: 'past_due', tenant } };
          }
          return { kind: 'ok', body: { received: true, action: 'noted', id: event.id } };
        }

        return { kind: 'ok', body: { received: true, type: event.type, action: 'ignored' } };
      });
    } catch (err) {
      return res.status(503).json({
        error: 'webhook_store_unavailable',
        detail: String(err && err.message || err),
      });
    }

    // Post-transaction side effects: emails are best-effort and must NOT
    // roll the transaction back if they fail.
    if (outcome && outcome.sideEffect) {
      const { kind, tenant } = outcome.sideEffect;
      if (kind === 'activated' && tenant.email && emailConfigured()) {
        const meta = PLAN_CATALOG[outcome.body.plan] || {};
        sendBillingActivated({ email: tenant.email, plan: outcome.body.plan, quota: meta.quota }).catch(() => {});
      }
      if (kind === 'past_due' && tenant.email && emailConfigured()) {
        sendBillingFailed({ email: tenant.email, plan: tenant.plan }).catch(() => {});
      }
    }
    return res.json(outcome.body);
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

  // Self-serve data export (/privacy promises this). Returns a JSON bundle
  // of the tenant's row plus every concept, compile job, observation, and
  // invocation we have on file for them. We strip secrets (api_key_hash,
  // stripe_customer_id keeps existing for portability, billing tokens drop).
  // Content-Disposition nudges browsers to save the file.
  r.get('/v1/account/export', (req, res) => {
    if (!req.tenant_record) return res.status(403).json({ error: 'admin tokens cannot export — use a tenant key' });
    const t = req.tenant_record;
    const matches = (row) => {
      if (!row) return false;
      return row.tenant === t.id
        || row.tenant === t.name
        || row.tenant_id === t.id
        || (t.email && row.tenant === t.email);
    };
    const concepts = all('concepts').filter(c => matches(c) && !c._deleted);
    const conceptIds = new Set(concepts.map(c => c.id));
    const versions = all('versions').filter(v => conceptIds.has(v.concept_id));
    const jobs = all('compile_jobs').filter(j => !j._bootstrap && !j._deleted && matches(j));
    const invocations = all('invocations').filter(i => matches(i));
    const observations = all('observations').filter(o => matches(o));
    // Strip secret material from the tenant row before serializing.
    const { api_key_hash, api_key, ...safeTenant } = t;
    const bundle = {
      spec: 'kolm-export-v1',
      exported_at: new Date().toISOString(),
      tenant: safeTenant,
      recipes: concepts,
      versions,
      jobs: jobs.map(({ artifact_path, deploy_hook, ...rest }) => rest),
      usage: invocations,
      observations,
      counts: {
        recipes: concepts.length,
        versions: versions.length,
        jobs: jobs.length,
        usage: invocations.length,
        observations: observations.length,
      },
    };
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="kolm-export-${t.id}-${today}.json"`);
    res.send(JSON.stringify(bundle, null, 2));
  });

  // Compliance package: a single bundle a privacy officer / auditor / regulator
  // can read end-to-end. Tenant metadata + signed receipts + audit log +
  // BAA-ready org details + control mapping snapshot. JSON only (no PHI ever
  // transits this endpoint — receipts are payload-free by design). Auditors
  // who want a literal ZIP can pipe `curl ... | jq -r .b64_zip | base64 -d`,
  // but the JSON shape is the canonical artifact.
  r.get('/v1/account/compliance-package', (req, res) => {
    if (!req.tenant_record) return res.status(403).json({ error: 'admin tokens cannot export — use a tenant key' });
    const t = req.tenant_record;
    const matches = (row) => {
      if (!row) return false;
      return row.tenant === t.id
        || row.tenant === t.name
        || row.tenant_id === t.id
        || (t.email && row.tenant === t.email);
    };
    const jobs = all('compile_jobs').filter(j => !j._bootstrap && !j._deleted && matches(j));
    const auditEvents = all('audit_log').filter(matches);
    const concepts = all('concepts').filter(c => matches(c) && !c._deleted);
    const receiptRecords = jobs
      .filter(j => j.receipt_sha || j.receipt_hmac || j.artifact_sha)
      .map(j => ({
        job_id: j.id,
        recipe: j.recipe || j.concept_id,
        artifact_sha: j.artifact_sha,
        receipt_sha: j.receipt_sha,
        receipt_hmac: j.receipt_hmac,
        k_score: j.k_score,
        phi_mode: !!j.phi_mode,
        created_at: j.created_at,
      }));
    const today = new Date().toISOString().slice(0, 10);
    const pkg = {
      spec: 'kolm-compliance-package-v1',
      generated_at: new Date().toISOString(),
      bundle_id: `cpkg-${t.id}-${today}`,
      tenant: {
        id: t.id,
        name: t.name,
        email: t.email,
        plan: t.plan,
        region: t.region || 'us-west2',
        created_at: t.created_at,
      },
      controls: {
        phi_redactor: 'enforced before any frontier-model call when phi_mode=true',
        k_score_gate_default: 0.85,
        k_score_gate_phi: 0.95,
        receipt_chain: 'HMAC-SHA256, 4 rings (compile, run, eval, audit)',
        encryption_at_rest: 'AES-256, customer-managed keys on request',
        encryption_in_transit: 'TLS 1.3',
        rbac: 'role-based access control, quarterly review',
        breach_notification_sla_business_days: 10,
        subprocessor_change_notice_days: 30,
        return_or_destroy_days: 30,
      },
      baa: {
        status: t.plan === 'business' || t.plan === 'enterprise' ? 'eligible' : 'available on Business or Enterprise plan',
        execution_path: 'mailto:founders@kolm.ai with org + signatory; 48-hour countersign target',
        phi_schedule: 'https://kolm.ai/baa#phi-schedule',
      },
      subprocessors: [
        { name: 'Vercel', purpose: 'CDN', phi: false },
        { name: 'Railway', purpose: 'control plane', phi: false },
        { name: 'Stripe', purpose: 'billing', phi: false },
        { name: 'Resend', purpose: 'transactional email', phi: false },
        { name: 'Cloudflare', purpose: 'DNS/DDoS', phi: false },
        { name: 'GitHub', purpose: 'source hosting', phi: false },
        { name: 'Frontier (Anthropic/OpenAI/Google)', purpose: 'compile-time teacher', phi: 'opt-in only, customer key' },
      ],
      compliance: {
        hipaa: { baa_available: true, security_rule_mapping: 'https://kolm.ai/security#hipaa-mapping' },
        soc2: { type1: 'scoping completed 2026-04', type2: 'in progress, target Q4 2026' },
        hitrust: { csf: 'scoping in progress, target r2 Q2 2027' },
        gdpr: { dpa_available: true, sccs: 'EU SCCs Module 2 by reference' },
      },
      counts: {
        recipes: concepts.length,
        compile_jobs: jobs.length,
        receipts_signed: receiptRecords.length,
        audit_events: auditEvents.length,
      },
      receipts: receiptRecords,
      audit_log: auditEvents.map(e => ({
        ts: e.ts || e.at,
        actor: e.actor,
        kind: e.kind,
        target: e.target,
      })),
      attestation: {
        statement: `This compliance package was generated from kolm production data for tenant ${t.id}. All receipt hashes are reproducible from the artifacts they reference. No PHI is included.`,
        contact: 'founders@kolm.ai',
        signed_at: new Date().toISOString(),
      },
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="kolm-compliance-${t.id}-${today}.json"`);
    res.send(JSON.stringify(pkg, null, 2));
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

  // Public artifact verification by CID. No auth required - the registry is
  // public-by-default. Returns manifest summary + signature status so an
  // auditor or buyer can verify the artifact's provenance without trusting us.
  // GET /v1/verify/cidv1:sha256:7a2c1f9b... -> { verified, cid, manifest, ... }
  r.get('/v1/verify/:cid', (req, res) => {
    const cid = String(req.params.cid || '').trim();
    if (!cid) return res.status(400).json({ error: 'cid required' });
    if (!/^cidv1:sha256:[0-9a-f]{8,64}$/i.test(cid) && !/^[0-9a-f]{8,64}$/i.test(cid)) {
      return res.status(400).json({ error: 'cid must be cidv1:sha256:hex or hex' });
    }
    const normalized = cid.startsWith('cidv1:') ? cid : ('cidv1:sha256:' + cid);
    const versions = all('versions');
    const concepts = all('concepts');
    const v = versions.find(x =>
      x?.cid === normalized ||
      x?.cid === cid ||
      x?.evaluation?.cid === normalized ||
      x?.evaluation?.cid === cid ||
      x?.id === cid
    );
    if (!v) {
      return res.status(404).json({
        verified: false,
        cid: normalized,
        reason: 'artifact not found in this registry instance',
      });
    }
    const c = concepts.find(x => x.id === v.concept_id || x.head_version === v.id);
    res.json({
      verified: true,
      cid: normalized,
      manifest: {
        name: c?.name || null,
        description: c?.description || null,
        tags: c?.tags || [],
        visibility: c?.visibility || 'private',
        base_model: v?.evaluation?.base_model || null,
        k_score: v?.evaluation?.quality_score ?? v?.evaluation?.k_score ?? null,
        size_bytes: v?.evaluation?.size_bytes ?? null,
        compliance_pack: v?.evaluation?.compliance_pack || null,
      },
      signed_by: v?.signed_by || 'kolm:registry',
      signed_at: v?.created_at || c?.updated_at || null,
      receipt_format: 'HMAC-SHA256 over (cid, input_sha, output_sha, ts)',
      audit: {
        registry: '/registry',
        spec: '/spec/rs-1',
        replay: 'kolm verify ' + normalized,
      },
    });
  });

  // Wave 165 (N+5) — tenant shadow corpus endpoints. The eval credibility
  // roadmap (Wave 144 Doc 2 §7) layered eval independence as:
  //   N+1.5/Q+2     tenant seeds.jsonl train/holdout split (shipped W150-151)
  //   N+3 / N+4     external + adversarial holdouts (shipped W164)
  //   N+5 (this)    tenant shadow corpus uploaded to tenant's own server
  //   N+6 (W160)    teacher-delta T axis (shipped)
  //   N+7 (W166)    third-party auditor attestation (pending)
  //
  // The distinguishing property of N+5: the corpus NEVER LEAVES THE TENANT'S
  // ENVIRONMENT. The .kolm artifact records only {tenant_id, corpus_id,
  // corpus_sha256, accuracy, ...} — never the rows themselves. A HIPAA-covered
  // payer, a banking BAA holder, or any regulated buyer with a contractual
  // data-residency clause can prove the recipe was scored against their
  // proprietary corpus without ever shipping the corpus.
  //
  // POST /v1/eval/tenant_holdout
  //   body: { corpus_id: string, rows: Array<{input, output} | {prompt, completion}>, replace?: boolean }
  //   returns: { tenant_id, corpus_id, corpus_sha256, normalized_hash, row_count, stored_at, bytes }
  // GET  /v1/eval/tenant_holdout                  → list this tenant's corpora
  // GET  /v1/eval/tenant_holdout/:corpus_id       → single corpus metadata
  // DELETE /v1/eval/tenant_holdout/:corpus_id     → delete a corpus
  //
  // All four are authed (mounted below authMiddleware) and per-tenant scoped:
  // a tenant can only read/write/delete corpora under its own tenant_id. The
  // tenant_id is derived from req.tenant_record.id (the authenticated tenant)
  // rather than accepted as a body field, so a forged tenant_id is impossible.
  r.post('/v1/eval/tenant_holdout', publishLimiter, (req, res) => {
    try {
      const tenantId = req.tenant_record?.id;
      if (!tenantId) return res.status(401).json({ error: 'no tenant context' });
      const { corpus_id, rows, replace } = req.body || {};
      if (!corpus_id) return res.status(400).json({ error: 'corpus_id (string) required' });
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'rows (non-empty array of {input,output} or {prompt,completion}) required' });
      }
      if (rows.length > 50000) {
        return res.status(413).json({ error: 'rows: max 50000 per upload; split into multiple corpora' });
      }
      const meta = saveTenantCorpus(tenantId, String(corpus_id), rows, { replace: replace === true });
      try {
        tryAppendAudit(AUDIT_OPS.EVAL_TENANT_HOLDOUT_SAVE || 'eval.tenant_holdout.save', {
          tenant_id: tenantId,
          corpus_id: meta.corpus_id,
          row_count: meta.row_count,
          bytes: meta.bytes,
          corpus_sha256: meta.corpus_sha256,
          normalized_hash: meta.normalized_hash,
          replace: replace === true,
        });
      } catch {}
      chargeUsage(req.tenant_record, Math.max(1, Math.ceil(meta.bytes / 10240)));
      res.json({
        tenant_id: meta.tenant_id,
        corpus_id: meta.corpus_id,
        corpus_sha256: meta.corpus_sha256,
        normalized_hash: meta.normalized_hash,
        row_count: meta.row_count,
        skipped: meta.skipped,
        stored_at: meta.stored_at,
        bytes: meta.bytes,
        residency_note: 'corpus retained on tenant infrastructure; bytes not included in artifact',
        next: 'pass --tenant-shadow-corpus ' + meta.tenant_id + ':' + meta.corpus_id + ' to `kolm compile` to bind tenant_shadow_corpus_provenance into the artifact.',
      });
    } catch (e) {
      const msg = String(e.message || e);
      const status = msg.includes('already exists') ? 409 : (msg.includes('must match') ? 400 : 500);
      res.status(status).json({ error: msg });
    }
  });

  r.get('/v1/eval/tenant_holdout', (req, res) => {
    try {
      const tenantId = req.tenant_record?.id;
      if (!tenantId) return res.status(401).json({ error: 'no tenant context' });
      const corpora = listTenantCorpora(tenantId);
      res.json({ tenant_id: tenantId, corpora, count: corpora.length });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.get('/v1/eval/tenant_holdout/:corpus_id', (req, res) => {
    try {
      const tenantId = req.tenant_record?.id;
      if (!tenantId) return res.status(401).json({ error: 'no tenant context' });
      const corpusId = String(req.params.corpus_id || '').trim();
      if (!corpusId) return res.status(400).json({ error: 'corpus_id required' });
      const loaded = loadTenantCorpus(tenantId, corpusId);
      res.json({
        tenant_id: loaded.tenant_id,
        corpus_id: loaded.corpus_id,
        corpus_sha256: loaded.corpus_sha256,
        normalized_hash: loaded.normalized_hash,
        row_count: loaded.row_count,
        skipped: loaded.skipped,
        bytes: loaded.stat.size,
        modified_at: loaded.stat.mtime.toISOString(),
        residency_note: 'corpus retained on tenant infrastructure; bytes not included in this response',
      });
    } catch (e) {
      const msg = String(e.message || e);
      const status = msg.includes('not found') ? 404 : (msg.includes('must match') ? 400 : 500);
      res.status(status).json({ error: msg });
    }
  });

  r.delete('/v1/eval/tenant_holdout/:corpus_id', (req, res) => {
    try {
      const tenantId = req.tenant_record?.id;
      if (!tenantId) return res.status(401).json({ error: 'no tenant context' });
      const corpusId = String(req.params.corpus_id || '').trim();
      if (!corpusId) return res.status(400).json({ error: 'corpus_id required' });
      const result = deleteTenantCorpus(tenantId, corpusId);
      if (!result.deleted) return res.status(404).json({ error: result.reason || 'not found' });
      try {
        tryAppendAudit(AUDIT_OPS.EVAL_TENANT_HOLDOUT_DELETE || 'eval.tenant_holdout.delete', {
          tenant_id: tenantId,
          corpus_id: corpusId,
        });
      } catch {}
      res.json({ deleted: true, tenant_id: tenantId, corpus_id: corpusId });
    } catch (e) {
      const msg = String(e.message || e);
      const status = msg.includes('must match') ? 400 : 500;
      res.status(status).json({ error: msg });
    }
  });

  // Verify a provenance credential (artifact-scoped or output-scoped).
  // Body: { credential: { spec: 'kolm-credential/0.1', ... } }
  // Returns: { valid: boolean, reason?: string, spec, type }
  //
  // This validates the HMAC signature using the server's receipt secret.
  // For a future Ed25519 swap, the public key would live at /.well-known/ and
  // verification would not need server auth. Today this endpoint is open.
  r.post('/v1/credential/verify', (req, res) => {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: 'credential (object) required' });
    const secret = effectiveReceiptSecret();
    if (!secret) return res.status(503).json({ error: 'signing secret unavailable on server' });
    const result = verifyCredential(credential, secret);
    res.json({
      ...result,
      spec: credential.spec || null,
      type: credential.type || null,
      expected_spec: PROVENANCE_SPEC,
    });
  });

  // Publish an edited generator (no synthesis required)
  r.post('/v1/publish', publishLimiter, (req, res) => {
    const { source, name, description, tags = [], visibility = 'private', positives = [], negatives = [], output_spec, team_id = null } = req.body || {};
    if (!source || !name) return res.status(400).json({ error: 'source and name are required' });
    if (team_id && !teams.isMember(team_id, req.tenant_record?.id)) {
      return res.status(403).json({ error: 'not a member of that team' });
    }
    try {
      const fn = compileJs(source);
      const evaluation = verify(fn, { positives, negatives });
      const concept = registry.createConcept({ name, description, tenant: req.tenant, schema: output_spec || null, tags, visibility, team_id });
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
    const concepts = registry.listConcepts({ tenant: req.tenant, tenantId: req.tenant_record?.id, tag: req.query.tag, limit: parseInt(req.query.limit) || 50 });
    res.json({ concepts });
  });

  r.get('/v1/concepts/:id', (req, res) => {
    const c = registry.getConcept(req.params.id, req.tenant, req.tenant_record?.id);
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
    const lineage = registry.lineageOf(req.params.id, req.tenant, req.tenant_record?.id);
    if (!lineage) return res.status(404).json({ error: 'not found' });
    res.json(lineage);
  });

  // Per-concept usage stats: invocation count, latency percentiles, cache hit rate.
  r.get('/v1/concepts/:id/stats', (req, res) => {
    const c = registry.getConcept(req.params.id, req.tenant, req.tenant_record?.id);
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
    const matches = registry.searchSimilar({ query, tenant: req.tenant, tenantId: req.tenant_record?.id, k, tag });
    res.json({ matches });
  });

  // ---------- Layer 3: Runtime ----------
  async function handleRun(req, res, overrides = {}) {
    const body = req.body || {};
    const concept_id = overrides.concept_id ?? body.concept_id;
    const version_id = overrides.version_id ?? body.version_id;
    const { input, use_cache = true, receipt: wantReceipt = true } = body;
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
  }

  r.post('/v1/run', (req, res) => handleRun(req, res));

  // SDK-conventional REST alias: POST /v1/recipes/:id/run mirrors /v1/run
  // with concept_id set from the URL param. Body's version_id (if provided)
  // still wins so callers can pin a specific revision.
  r.post('/v1/recipes/:id/run', (req, res) => handleRun(req, res, { concept_id: req.params.id }));

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
  // compiles_today/receipt_bearing_runs/k_score_median/artifacts_total/
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

    // Receipt-bearing runs: every successful invocation emits an HMAC
    // receipt bound to its run. This is the count of receipts that
    // _exist_, not the count that has been independently verified by a
    // caller — a dedicated receipts/verifications table is Sprint 2 work.
    // Exposed as receipt_bearing_runs (honest) and receipts_verified (legacy
    // alias, same value) for backward compatibility.
    const receiptBearingRuns = inv.filter(i => !i.error).length;

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
      receipt_bearing_runs: receiptBearingRuns,
      receipts_verified: receiptBearingRuns,
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

  // /v1/admin/tenants — defined above with rich q/limit/scrub. Keep diagnostics here.

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
    const concepts = registry.listConcepts({ tenant: req.tenant, tenantId: req.tenant_record?.id, tag: req.query.tag, limit: parseInt(req.query.limit) || 50 });
    res.json({ recipes: concepts.map(c => ({ ...c, recipe_id: c.id })) });
  });
  r.get('/v1/recipes/:id', (req, res) => {
    const c = registry.getConcept(req.params.id, req.tenant, req.tenant_record?.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ ...c, recipe_id: c.id });
  });
  r.get('/v1/recipes/:id/stats', (req, res) => {
    const c = registry.getConcept(req.params.id, req.tenant, req.tenant_record?.id);
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
    const c = registry.getConcept(req.params.id, req.tenant, req.tenant_record?.id);
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
    const c = registry.getConcept(req.params.id, req.tenant, req.tenant_record?.id);
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

  // ---------- Enterprise inquiry intake (KOLM-102) ----------
  // Public POST from /enterprise/inquiry. Validates 7 required fields, persists
  // to in-memory enterpriseLeads, and emails sales@kolm.ai via Resend (best
  // effort — sendMail() returns { skipped: true } when RESEND_API_KEY is unset).
  r.post('/v1/lead/enterprise', enterpriseLeadLimiter, async (req, res) => {
    const b = req.body || {};
    const FIELD_LIMITS = {
      company: 120,
      role: 80,
      employees: 20,
      vertical: 40,
      intended_use: 600,
      target_start: 60,
      email: 200,
      notes: 1000,
    };
    const REQUIRED = ['company', 'role', 'employees', 'vertical', 'intended_use', 'target_start', 'email'];

    const cleaned = {};
    for (const k of Object.keys(FIELD_LIMITS)) {
      const v = b[k];
      if (v === undefined || v === null) { cleaned[k] = ''; continue; }
      if (typeof v !== 'string') {
        return res.status(400).json({ error: `invalid_field`, detail: `${k} must be a string` });
      }
      cleaned[k] = v.trim();
      if (cleaned[k].length > FIELD_LIMITS[k]) {
        return res.status(400).json({ error: 'field_too_long', detail: `${k} exceeds ${FIELD_LIMITS[k]} chars` });
      }
    }
    for (const k of REQUIRED) {
      if (!cleaned[k]) {
        return res.status(400).json({ error: 'missing_field', detail: `${k} is required` });
      }
    }
    const ALLOWED_EMPLOYEES = new Set(['1-10', '11-50', '51-200', '201-1000', '1000+']);
    if (!ALLOWED_EMPLOYEES.has(cleaned.employees)) {
      return res.status(400).json({ error: 'invalid_employees', detail: 'must be one of 1-10, 11-50, 51-200, 201-1000, 1000+' });
    }
    const ALLOWED_VERTICALS = new Set(['Healthcare', 'Insurance', 'Finance', 'Legal', 'Defense', 'Edge', 'Other']);
    if (!ALLOWED_VERTICALS.has(cleaned.vertical)) {
      return res.status(400).json({ error: 'invalid_vertical', detail: 'must be Healthcare, Insurance, Finance, Legal, Defense, Edge, or Other' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned.email)) {
      return res.status(400).json({ error: 'invalid_email', detail: 'email shape is not valid' });
    }

    const id = 'lead_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
    const ip = ipKey(req);
    const ua = String(req.headers['user-agent'] || '').slice(0, 240);
    const ts = Date.now();
    const record = { id, ts, ...cleaned, ip, ua };
    enterpriseLeads.push(record);

    // Best-effort email to sales@kolm.ai. Never block the response on it.
    const subject = `Enterprise inquiry: ${cleaned.company} (${cleaned.vertical})`;
    const lines = [
      `New enterprise inquiry from ${cleaned.company}.`,
      ``,
      `Company:        ${cleaned.company}`,
      `Role:           ${cleaned.role}`,
      `Team size:      ${cleaned.employees}`,
      `Vertical:       ${cleaned.vertical}`,
      `Target start:   ${cleaned.target_start}`,
      `Email:          ${cleaned.email}`,
      ``,
      `Intended use:`,
      cleaned.intended_use,
      ``,
    ];
    if (cleaned.notes) {
      lines.push(`Notes:`, cleaned.notes, ``);
    }
    lines.push(`---`, `Lead id: ${id}`, `Submitted: ${new Date(ts).toISOString()}`, `IP key:    ${ip}`, `UA:        ${ua || '(none)'}`, ``, `Reply within one business day. Founder direct, no SDR.`);
    const text = lines.join('\n');

    let emailResult = { skipped: true, reason: 'unknown' };
    try {
      const { sendMail } = await import('./email.js');
      emailResult = await sendMail({
        to: process.env.SALES_EMAIL || 'sales@kolm.ai',
        subject,
        text,
        replyTo: cleaned.email,
        tags: [{ name: 'kind', value: 'enterprise_lead' }, { name: 'vertical', value: cleaned.vertical.toLowerCase() }],
      });
      if (emailResult.skipped) {
        // TODO: configure RESEND_API_KEY + EMAIL_FROM to actually deliver.
        // Until then, log the payload so a founder tailing logs sees the lead.
        console.log('[lead/enterprise] email skipped, payload follows:');
        console.log(text);
      } else if (!emailResult.ok) {
        console.error('[lead/enterprise] email send failed', emailResult);
      }
    } catch (err) {
      console.error('[lead/enterprise] email threw', err);
    }

    res.json({ ok: true, id, queued: true });
  });

  // Admin-only read of a single enterprise lead. Useful for ops triage and
  // for verifying the in-memory store after a submit during e2e checks.
  r.get('/v1/lead/enterprise/:id', (req, res) => {
    if (!req.is_admin) return res.status(403).json({ error: 'admin only' });
    const rec = enterpriseLeads.find(x => x.id === req.params.id);
    if (!rec) return res.status(404).json({ error: 'not found' });
    res.json(rec);
  });

  r.post('/v1/specialists/train', (req, res) => {
    const { name, recipe_id, corpus, base_model = 'Qwen/Qwen2.5-3B-Instruct', rank = 16 } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!recipe_id) return res.status(400).json({ error: 'recipe_id required (a synthesized recipe used for auto-labeling)' });
    const c = registry.getConcept(recipe_id, req.tenant, req.tenant_record?.id);
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
    const c = registry.getConcept(recipe_id, req.tenant, req.tenant_record?.id);
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

  // Tenant audit log. Reconstructs entries on the fly from the source tables
  // (`invocations`, `compile_jobs`, `observations`, `stripe_events`) so every
  // tenant operation that touches their data is queryable. The "durable
  // audit_events table" is still a target architecture (a single normalised
  // write path with HMAC-chained signatures); this implementation gives the
  // dashboard real entries from day one without that wiring.
  //
  // Probe-safe: when unauth'd, returns the same 200 envelope with entries=[]
  // rather than 401/503 so frontend probes don't fall over.
  r.get('/v1/audit/log', (req, res) => {
    const tenant = req.tenant_record;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const since = req.query.since ? Date.parse(req.query.since) : 0;
    if (!tenant) {
      return res.json({
        entries: [],
        total: 0,
        note: 'sign in (Bearer <api_key>) to see your audit entries; this endpoint reconstructs from invocations, compile_jobs, observations, and stripe_events scoped to your tenant.',
      });
    }
    // Audit scanner accepts any of the three durable tenant references — id,
    // name, or email. Legacy rows wrote `tenant: <name>`; recent writes also
    // carry `tenant_id`. Match on either so historical entries surface.
    const matchTenant = (row) => {
      if (!row) return false;
      const tid = row.tenant_id || row.tenant;
      if (tid && (tid === tenant.id || tid === tenant.name || tid === tenant.email)) return true;
      return row.tenant === tenant.id
        || row.tenant === tenant.name
        || (tenant.email && row.tenant === tenant.email);
    };
    const out = [];
    // 1. Invocations (kolm run <artifact> via local runner or hosted /v1/run)
    for (const i of all('invocations')) {
      if (!matchTenant(i)) continue;
      const t = Date.parse(i.ts || '');
      if (since && Number.isFinite(t) && t < since) continue;
      out.push({
        op: i.error ? 'run.error' : 'run',
        ts: i.ts,
        ms: i.ms ?? null,
        concept_id: i.concept_id || null,
        cache: i.cache || null,
        input_hash: i.input_hash || null,
        output_hash: i.output_hash || null,
        error: i.error || null,
      });
    }
    // 2. Compile jobs (kolm compile, /v1/compile)
    for (const j of all('compile_jobs')) {
      if (j._deleted || j._bootstrap) continue;
      if (!matchTenant(j)) continue;
      const t = Date.parse(j.created_at || '');
      if (since && Number.isFinite(t) && t < since) continue;
      out.push({
        op: 'compile.' + (j.status || 'started'),
        ts: j.created_at,
        job_id: j.id,
        task: j.task || null,
        base_model: j.base_model || null,
        k_score: j.k_score ?? null,
        artifact_url: j.artifact_url || null,
        signature: j.signature || null,
      });
    }
    // 3. Captures / observations (kolm capture proxy)
    for (const o of all('observations')) {
      if (!matchTenant(o)) continue;
      const t = Date.parse(o.ts || '');
      if (since && Number.isFinite(t) && t < since) continue;
      out.push({
        op: 'capture.' + (o.provider || o.model || 'inference'),
        ts: o.ts,
        namespace: o.namespace || 'default',
        model: o.model || null,
        template_hash: o.template_hash || null,
        latency_ms: o.latency_ms ?? null,
        discarded: !!o.discarded,
      });
    }
    // 4a. Durable audit_events rows (HMAC-chained, append-only). These are
    // authoritative — the reconstruction above is the legacy compatibility
    // bridge. Surface both for now so dashboards built against the old shape
    // keep working while the chained rows accumulate.
    try {
      const auditRows = listAuditEvents(tenant.id, { limit: 500, since: since ? new Date(since).toISOString() : null });
      for (const e of auditRows) {
        out.push({
          op: e.op,
          ts: e.at,
          chained: true,
          event_id: e.id,
          event_hash: e.event_hash,
          prev_hash: e.prev_hash,
          payload: e.payload || {},
        });
      }
    } catch { /* table may not exist yet — fine, fall through */ }
    // 4. Stripe events scoped by tenant (plan changes, key actions logged with tenant)
    for (const e of all('stripe_events')) {
      if (e.tenant && e.tenant !== tenant.id && e.tenant !== tenant.email) continue;
      if (!e.tenant && !req.is_admin) continue;
      const t = Date.parse(e.received_at || '');
      if (since && Number.isFinite(t) && t < since) continue;
      out.push({
        op: 'billing.' + String(e.type || 'event').replace(/[^a-z0-9_.]/gi, '_'),
        ts: e.received_at,
        event_id: e.id,
        type: e.type || null,
      });
    }
    out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    const format = String(req.query.format || 'json').toLowerCase();
    const entries = out.slice(0, limit);
    if (format === 'jsonl') {
      res.setHeader('content-type', 'application/x-ndjson');
      return res.send(entries.map(e => JSON.stringify(e)).join('\n'));
    }
    if (format === 'csv') {
      const cols = ['ts', 'op', 'concept_id', 'job_id', 'namespace', 'k_score', 'ms', 'latency_ms', 'cache', 'error'];
      const rows = [cols.join(',')];
      for (const e of entries) {
        rows.push(cols.map(c => {
          const v = e[c];
          if (v == null) return '';
          const s = String(v).replace(/"/g, '""');
          return /[",\n]/.test(s) ? `"${s}"` : s;
        }).join(','));
      }
      res.setHeader('content-type', 'text/csv');
      return res.send(rows.join('\n'));
    }
    res.json({
      entries,
      total: out.length,
      limit,
      note: 'Reconstructed from invocations + compile_jobs + observations + stripe_events, augmented with durable audit_events (HMAC-chained, append-only). Run `kolm audit verify` or GET /v1/audit/verify to validate the chain.',
    });
  });

  // Verify the HMAC chain over this tenant's audit_events rows. Returns
  // ok=true when every row hashes to its declared event_hash given the
  // previous row's hash, ok=false with the list of breaks otherwise.
  r.get('/v1/audit/verify', (req, res) => {
    const tenant = req.tenant_record;
    if (!tenant) return res.status(401).json({ error: 'sign in with Bearer <api_key> to verify your audit chain' });
    try {
      const result = verifyAuditChain(tenant.id);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
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
  // W258-BE-1: persists via insertCapture (durable contract). 503 on store
  // failure — same envelope as the capture proxy handlers.
  r.post('/v1/bridges/observe', async (req, res) => {
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
    try {
      await insertCapture(obs);
    } catch (e) {
      const ephemeral = e && e.code === 'CAPTURE_STORE_EPHEMERAL';
      res.set('x-kolm-capture-durable', 'false');
      return res.status(503).json({
        error: ephemeral ? 'capture_store_ephemeral' : 'capture_store_unavailable',
        message: String(e && e.message || e),
      });
    }
    res.set('x-kolm-capture-durable', String(captureIsDurable()));
    const cluster = findByTenant('observations', req.tenant).filter(o => o.template_hash === sig.hash);
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
    const obs = findByTenant('observations', req.tenant);
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
    const tenantObs = findByTenant('observations', req.tenant);
    const obsNs = (o) => o.corpus_namespace || o.namespace || 'default';
    let obs = tenantObs;
    if (ns) obs = obs.filter(o => obsNs(o) === ns);
    if (!includeDiscarded) obs = obs.filter(o => !o.discarded);
    obs.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const namespaces = [...new Set(tenantObs.map(obsNs))];
    const ready = namespaces.map(n => ({
      namespace: n,
      pairs: tenantObs.filter(o => obsNs(o) === n && !o.discarded).length,
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
    const obs = findByTenant('observations', req.tenant).filter(o => o.template_hash === hash);
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

  // ---------- W214: click-to-distill from captured corpus ----------
  // Preview (GET) is read-only: aggregate the durable capture-store by
  // template-hash and report which clusters are eligible.
  // Commit  (POST) picks recipe vs specialist by count (<1000 vs >=1000),
  // forwards to /v1/bridges/auto-synthesize (recipe) or KOLM_TRAINER_BRIDGE_URL
  // (specialist). Errors surface as 503 (capture-store) / 400 (not_enough/
  // no_cluster) / 503 (distill_bridge_not_configured) — never silent success.
  r.get('/v1/distill/from-captures/preview', authMiddleware, async (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const namespace = sanitizeNamespace(String(req.query?.namespace || 'default'));
    let captures;
    try {
      captures = await listCaptures(req.tenant, namespace, 5000);
    } catch (e) {
      const ephemeral = e && e.code === 'CAPTURE_STORE_EPHEMERAL';
      return res.status(503).json({
        error: ephemeral ? 'capture_store_ephemeral' : 'capture_store_unavailable',
        message: String(e && e.message || e),
      });
    }
    const clusters = new Map();
    for (const c of captures) {
      const k = c.template_hash || 'untagged';
      clusters.set(k, (clusters.get(k) || 0) + 1);
    }
    const top = [...clusters.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([template_hash, count]) => ({ template_hash, count }));
    const total = captures.length;
    res.json({
      namespace,
      total_captures: total,
      top_clusters: top,
      mode_hint: total >= 1000 ? 'specialist' : 'recipe',
      recipe_eligible: top.length > 0 && top[0].count >= 4,
      specialist_eligible: total >= 1000,
    });
  });
  r.post('/v1/distill/from-captures', authMiddleware, async (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const body = req.body || {};
    const namespace = sanitizeNamespace(String(body.namespace || 'default'));
    const minPairs = Math.max(4, Number(body.min_pairs) || 4);
    const forceMode = body.mode && ['recipe', 'specialist'].includes(String(body.mode)) ? String(body.mode) : null;
    let captures;
    try {
      captures = await listCaptures(req.tenant, namespace, 5000);
    } catch (e) {
      const ephemeral = e && e.code === 'CAPTURE_STORE_EPHEMERAL';
      return res.status(503).json({
        error: ephemeral ? 'capture_store_ephemeral' : 'capture_store_unavailable',
        message: String(e && e.message || e),
      });
    }
    if (captures.length < minPairs) {
      return res.status(400).json({
        error: 'not_enough_captures',
        message: `need at least ${minPairs} captures in namespace "${namespace}", have ${captures.length}`,
        namespace,
        count: captures.length,
        min_pairs: minPairs,
      });
    }
    const mode = forceMode || (captures.length >= 1000 ? 'specialist' : 'recipe');
    if (mode === 'recipe') {
      const clusters = new Map();
      for (const c of captures) {
        const k = c.template_hash || 'untagged';
        if (!clusters.has(k)) clusters.set(k, []);
        clusters.get(k).push(c);
      }
      const sorted = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);
      const bestArr = sorted.length ? sorted[0][1] : [];
      if (bestArr.length < 4) {
        return res.status(400).json({
          error: 'no_cluster',
          message: `largest template-hash cluster has only ${bestArr.length} captures; need at least 4 to synthesize a recipe`,
          namespace,
          mode: 'recipe',
          best_cluster_size: bestArr.length,
        });
      }
      const name = body.name || `auto-${namespace}-${Date.now().toString(36)}`;
      const positives = bestArr.slice(0, 8).map((c) => ({ input: c.variable_input || c.prompt, expected: c.response }));
      try {
        const synth = await synthesize({
          name,
          positives,
          description: `Auto-synthesized from ${bestArr.length} captures in namespace ${namespace}.`,
          tags: ['auto-from-captures', `ns:${namespace}`],
          tenant: req.tenant,
        });
        return res.status(synth.accepted ? 200 : 422).json({
          mode: 'recipe',
          namespace,
          job_id: synth.concept_id || synth.id || null,
          accepted: !!synth.accepted,
          synth,
          captures_promoted: synth.accepted ? bestArr.length : 0,
        });
      } catch (e) {
        return res.status(400).json({ error: 'synthesize_failed', message: String(e.message || e), namespace });
      }
    }
    // mode === 'specialist'
    const bridgeUrl = process.env.KOLM_TRAINER_BRIDGE_URL || '';
    if (!bridgeUrl) {
      return res.status(503).json({
        error: 'distill_bridge_not_configured',
        message: 'Or set mode=recipe to use the in-tree synthesizer, or set KOLM_TRAINER_BRIDGE_URL to a reachable trainer bridge endpoint.',
        namespace,
        count: captures.length,
      });
    }
    try {
      const res2 = await fetch(bridgeUrl.replace(/\/$/, '') + '/v1/distill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenant: req.tenant, namespace, captures_count: captures.length }),
      });
      const body2 = await res2.json().catch(() => ({}));
      return res.status(res2.ok ? 202 : (res2.status || 502)).json({
        mode: 'specialist',
        namespace,
        bridge_status: res2.status,
        job_id: body2.job_id || null,
        bridge: body2,
      });
    } catch (e) {
      return res.status(502).json({ error: 'distill_bridge_unreachable', message: String(e.message || e), namespace });
    }
  });

  // ===== W216: replay captured prompts against a compiled artifact ===========
  // Close-the-loop demo. Pull N rows from the durable W212 store, run each
  // through runtime.runVersion(use_cache:false), and emit a per-row diff
  // (upstream vs local) with jaccard k-score + latency-delta + cost-delta.

  function tokenizeForK(s) {
    const norm = String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const out = norm.split(/\s+/).filter(Boolean);
    return out;
  }
  function jaccardK(a, b) {
    const A = new Set(tokenizeForK(a));
    const B = new Set(tokenizeForK(b));
    if (A.size === 0 && B.size === 0) return 1;
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter += 1;
    const union = A.size + B.size - inter;
    return union === 0 ? 1 : inter / union;
  }

  // replayPlan picks the artifact + namespace + limit a replay should target.
  // Pulled out so /v1/replay and /v1/replay/preview share the same arithmetic.
  async function replayPlan({ tenant, body }) {
    const namespace = sanitizeNamespace(String(body.namespace || 'default'));
    const concept_id = body.concept_id ? String(body.concept_id) : null;
    const version_id = body.version_id ? String(body.version_id) : null;
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 25));
    if (!concept_id && !version_id) {
      return { error: { status: 400, body: { error: 'concept_id_or_version_id_required' } } };
    }
    let resolvedVersionId = version_id;
    if (!resolvedVersionId && concept_id) {
      const c = registry.getConcept(concept_id, tenant);
      if (!c) return { error: { status: 404, body: { error: 'artifact_not_found', concept_id } } };
      resolvedVersionId = c.head_version || null;
    }
    if (!resolvedVersionId) {
      return { error: { status: 404, body: { error: 'artifact_not_found' } } };
    }
    return { namespace, version_id: resolvedVersionId, limit };
  }

  r.get('/v1/replay/preview', authMiddleware, async (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const plan = await replayPlan({ tenant: req.tenant, body: {
      namespace: req.query.namespace,
      concept_id: req.query.concept_id,
      version_id: req.query.version_id,
      limit: req.query.limit,
    } });
    if (plan.error) return res.status(plan.error.status).json(plan.error.body);
    let count;
    try {
      count = await countCaptures(req.tenant, plan.namespace);
    } catch (e) {
      return res.status(503).json({
        error: 'capture_store_unavailable',
        message: String(e && e.message || e),
      });
    }
    res.json({
      ok: true,
      namespace: plan.namespace,
      version_id: plan.version_id,
      captures: count,
      will_replay: Math.min(plan.limit, count),
      limit: plan.limit,
    });
  });

  r.post('/v1/replay', authMiddleware, async (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const t0 = Date.now();
    const body = req.body || {};
    // Surface concept_id_or_version_id_required directly in the POST handler so
    // contract tests can assert it without crawling replayPlan.
    if (!body.concept_id && !body.version_id) {
      return res.status(400).json({ error: 'concept_id_or_version_id_required' });
    }
    const plan = await replayPlan({ tenant: req.tenant, body });
    if (plan.error) return res.status(plan.error.status).json(plan.error.body);
    const { namespace, version_id, limit } = plan;
    let rows;
    try {
      rows = await listCaptures(req.tenant, namespace, limit);
    } catch (e) {
      return res.status(503).json({
        error: 'capture_store_unavailable',
        message: String(e && e.message || e),
      });
    }
    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'no_captures', namespace });
    }
    const diffs = [];
    let succeeded = 0;
    let failed = 0;
    let kSum = 0;
    let kN = 0;
    let costTotal = 0;
    for (const row of rows) {
      const prompt = row.variable_input || row.prompt || '';
      const upstream_output = row.response || '';
      const upstream_lat = Number(row.latency_us) || 0;
      const upstream_cost = Math.round((Number(row.cost_usd) || 0) * 1e6);
      let local_output = '';
      let local_error = null;
      let local_lat = 0;
      let local_cost = 0;
      try {
        const r2 = await runtime.runVersion({ version_id, input: prompt, tenant: req.tenant, use_cache: false });
        local_output = r2.output || '';
        local_lat = Number(r2.latency_us) || 0;
        local_cost = Math.round((Number(r2.cost_usd) || 0) * 1e6);
        succeeded += 1;
      } catch (e) {
        local_error = String(e && e.message || e);
        failed += 1;
      }
      const k = local_error ? 0 : jaccardK(upstream_output, local_output);
      if (!local_error) { kSum += k; kN += 1; }
      costTotal += local_cost;
      diffs.push({
        capture_id: row.id,
        upstream_model: row.model || null,
        prompt_head: String(prompt).slice(0, 200),
        upstream_output: String(upstream_output).slice(0, 4000),
        local_output: String(local_output).slice(0, 4000),
        local_error,
        k_score: k,
        latency_us: { upstream: upstream_lat, local: local_lat, delta: local_lat - upstream_lat },
        cost_micro_usd: { upstream: upstream_cost, local: local_cost, delta: local_cost - upstream_cost },
      });
    }
    res.json({
      ok: true,
      namespace: namespace,
      version_id: version_id,
      replayed: rows.length,
      succeeded: succeeded,
      failed: failed,
      k_score_mean: kN ? kSum / kN : 0,
      cost_micro_usd_total: costTotal,
      elapsed_ms: Date.now() - t0,
      diffs,
    });
  });

  // POST /v1/nl/scaffold — networked drafter for `kolm nl --network`. The CLI
  // air-gap branch produces the same shape locally via scaffoldRecipeFromNl;
  // this endpoint exists so a tenant that opts in (--network or KOLM_AIRGAP=0)
  // can get an LLM-augmented scaffold without forking the CLI. The
  // x-kolm-nl-source response header tells the caller which branch served
  // (network = hosted LLM enrichment; airgap = deterministic fallback).
  r.post('/v1/nl/scaffold', async (req, res) => {
    const body = req.body || {};
    const text = String(body.text || body.prompt || '').trim();
    const classHint = body.class_hint || body.classHint || null;
    if (!text) return res.status(400).json({ error: 'text_required' });
    if (classHint && !['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'].includes(classHint)) {
      return res.status(400).json({ error: 'invalid_class_hint', allowed: ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'] });
    }
    const { scaffoldRecipeFromNl } = await import('./assistant.js');
    const scaffold = scaffoldRecipeFromNl({ text, classHint, airGap: true });
    // If a hosted teacher is configured we'd enrich here; the current deploy
    // serves the deterministic scaffold as the canonical answer so the route
    // is callable today. Header advertises which path actually ran.
    const source = 'airgap';
    res.setHeader('x-kolm-nl-source', source);
    res.json({ ...scaffold, network_status: source === 'network' ? 'wired' : 'air_gap', source });
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
    const c = registry.getConcept(req.params.id, req.tenant, req.tenant_record?.id);
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

  // W258-BE-1/2/3 (Pablo durability receipt fix, post-W212 wiring):
  // Throws on store failure so the caller can return 503 instead of the
  // historical silent swallow that returned 200 + capture-id for rows
  // that were never persisted. After a successful insert we (a) publish
  // to the SSE fan-out (W258-BE-2) so /v1/capture/stream pushes immediately
  // and the dashboard stops doing a 2 s poll-and-scan, and (b) check
  // threshold crossings (W258-BE-3) and fire alerts atomically.
  async function recordCapture({ tenant, provider, model, namespace, prompt, response, latency_us, status, cost_usd }) {
    if (!prompt || response === undefined || response === null) return null;
    const hash = promptHash(prompt + '|' + (model || ''));
    const ns = namespace || 'default';
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
      corpus_namespace: ns,
      status,
      created_at: new Date().toISOString(),
    };
    // insertCapture throws on disk-full / ephemeral-/tmp / driver failure.
    // We do NOT catch here — propagation is the whole point of the fix.
    await insertCapture(obs);
    obs.durable = captureIsDurable();
    // Fan-out to live tail subscribers (browser dashboard + `kolm tail captures`).
    try { publishCapture(obs); } catch (_) {}
    // Threshold alerts: count this tenant+namespace AFTER the insert; if we
    // crossed 100/500/1000 and won the dedupe CAS, fire push+email best-effort
    // off the response path so the proxy round-trip is not blocked.
    // The thresholdCrossedBy() helper from src/notifications.js is imported
    // here aliased as notifThresholdCrossedBy to avoid naming clashes.
    try {
      const count = await countCaptures(tenant, ns);
      const crossed = notifThresholdCrossedBy(count - 1, count);
      if (crossed && notifTryAdvanceThresholdState(tenant, ns, crossed)) {
        // Mirror the CAS into setThresholdState so the rest of the codebase
        // (verifier + /v1/notifications/state) reads the canonical pin.
        notifSetThresholdState(tenant, ns, crossed);
        obs.crossed_threshold = crossed;
        const baseUrl = process.env.PUBLIC_BASE
          || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://kolm.ai');
        notifFireThresholdAlert({ tenant, namespace: ns, count, threshold: crossed, baseUrl })
          .catch(() => {}); // best-effort; never propagate alert failure
      }
    } catch (_) {
      // Count / threshold-state failures must not break the capture path.
    }
    return obs;
  }

  // Shared helper: a capture handler that wraps recordCapture with the
  // common error-to-503 envelope + durability + distill-ready headers.
  // Returns true if the handler already sent a response (error path); the
  // caller continues only when this returns the obs object.
  async function recordCaptureWithReceipt(req, res, args) {
    try {
      const obs = await recordCapture(args);
      if (obs) {
        res.set('x-kolm-capture-id', obs.id);
        res.set('x-kolm-namespace', args.namespace || 'default');
        res.set('x-kolm-capture-durable', String(obs.durable !== false));
        if (notifIsDistillReady(args.tenant, args.namespace || 'default')) {
          res.set('x-kolm-distill-ready', 'true');
        }
        if (obs.crossed_threshold) {
          res.set('x-kolm-distill-threshold', String(obs.crossed_threshold));
        }
      } else {
        res.set('x-kolm-namespace', args.namespace || 'default');
      }
      return obs;
    } catch (e) {
      const ephemeral = e && (e.code === 'CAPTURE_STORE_EPHEMERAL');
      res.set('x-kolm-capture-durable', 'false');
      res.status(503).json({
        error: ephemeral ? 'capture_store_ephemeral' : 'capture_store_unavailable',
        message: String(e && e.message || e),
        hint: ephemeral
          ? 'Set KOLM_STORE_DRIVER=vercel_postgres (or KOLM_DATA_DIR to a persistent path) — /tmp is per-invocation on Vercel.'
          : 'The durable capture store is unavailable. Retry; if persistent, check /v1/capture/health.',
      });
      return null;
    }
  }

  // POST /v1/capture/log — server-to-server batch insert of (input, output)
  // pairs into the capture corpus. Mirrors what /v1/capture/anthropic and
  // /v1/capture/openai write when they observe a real upstream round-trip,
  // but lets pipelines and tests seed the corpus without proxying.
  r.post('/v1/capture/log', async (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const { namespace = 'default', items, provider = 'manual', model = '' } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items must be a non-empty array of {input, output}' });
    }
    if (items.length > 200) return res.status(400).json({ error: 'items must be ≤200 per request' });
    const cleanNs = sanitizeNamespace(namespace);
    const ids = [];
    const failures = [];
    let anyDurable = true;
    for (const it of items) {
      const input = typeof it === 'object' ? (it.input ?? it.prompt ?? '') : String(it);
      const output = typeof it === 'object' ? (it.output ?? it.response ?? '') : '';
      if (!input || output === undefined || output === null || output === '') continue;
      try {
        const obs = await recordCapture({
          tenant: req.tenant,
          provider: String(provider).slice(0, 32),
          model: String(model).slice(0, 128),
          namespace: cleanNs,
          prompt: input,
          response: output,
          latency_us: typeof it === 'object' ? (Number(it.latency_us) || 0) : 0,
          status: 200,
        });
        if (obs) {
          ids.push(obs.id);
          if (obs.durable === false) anyDurable = false;
        }
      } catch (e) {
        failures.push(String(e.message || e));
      }
    }
    // If we accepted N items but stored ZERO, the batch is a failure (503).
    // If some stored and some failed, return 207 with detail.
    if (ids.length === 0 && failures.length > 0) {
      res.set('x-kolm-capture-durable', 'false');
      return res.status(503).json({
        error: 'capture_store_unavailable',
        namespace: cleanNs,
        count: 0,
        failures: failures.slice(0, 5),
      });
    }
    res.set('x-kolm-namespace', cleanNs);
    res.set('x-kolm-capture-durable', String(anyDurable));
    if (notifIsDistillReady(req.tenant, cleanNs)) res.set('x-kolm-distill-ready', 'true');
    const status = failures.length > 0 ? 207 : 201;
    res.status(status).json({
      ok: failures.length === 0,
      namespace: cleanNs,
      count: ids.length,
      ids,
      ...(failures.length > 0 ? { failures: failures.slice(0, 5) } : {}),
    });
  });

  // GET /v1/capture/health — operator probe. Honest answer about whether
  // the next insertCapture call will persist beyond a single lambda. Used
  // by the /captures + /security pages and the `kolm doctor` flow.
  r.get('/v1/capture/health', async (req, res) => {
    try {
      const h = await captureHealth();
      res.json({
        ok: true,
        driver: captureDriverName(),
        durable: captureIsDurable(),
        subscriber_count: captureSubscriberCount(),
        thresholds: THRESHOLDS,
        ...h,
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: String(e.message || e) });
    }
  });

  // GET /v1/capture/stream — Server-Sent Events live tail of captures.
  // W258-BE-2: was a 2 s poll-and-scan against all('observations') — broken
  // for the Postgres driver and a lambda OOM bomb under fan-out. Now uses
  // the in-process publish/subscribe broker (src/capture-stream.js) wired
  // through recordCapture(). Subscriber map is keyed on tenant so
  // cross-tenant fan-out is structurally impossible.
  //
  // Payload shape is the CLI/UI contract (W258-BE-6): capture_id /
  // captured_at / namespace / model / provider / latency_us / status /
  // prompt_head / response_head / x_kolm_capture_durable. The raw store row
  // is shimmed here so the dashboard and `kolm tail captures` see the
  // same shape without one of them having to translate.
  r.get('/v1/capture/stream', authMiddleware, (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const namespaceFilter = req.query?.namespace ? sanitizeNamespace(String(req.query.namespace)) : null;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      // W258-BE-6: receipts on the SSE connect so `kolm tail captures` can
      // print whether the rows about to scroll are persisted and which driver.
      'X-Kolm-Capture-Driver': captureDriverName(),
      'X-Kolm-Capture-Durable': String(captureIsDurable()),
    });
    try { req.socket?.setTimeout?.(3600000); } catch {}
    res.write(`event: hello\ndata: ${JSON.stringify({ tenant: req.tenant, namespace: namespaceFilter, ts: new Date().toISOString(), driver: captureDriverName() })}\n\n`);

    // W213/W258: subscribeCaptureStream() and subscribeCapture(req.tenant, ...)
    // are dual aliases on broker.subscribe; the canonical call below uses
    // subscribeCapture(req.tenant, namespaceFilter, callback).
    const unsubscribe = subscribeCapture(req.tenant, namespaceFilter || '*', (obs) => {
      const event = {
        capture_id: obs.id,
        captured_at: obs.created_at,
        namespace: obs.corpus_namespace || 'default',
        model: obs.model || '',
        provider: obs.provider || null,
        latency_us: obs.latency_us || 0,
        status: obs.status,
        prompt_head: typeof obs.prompt === 'string' ? obs.prompt.slice(0, 200) : null,
        response_head: typeof obs.response === 'string' ? obs.response.slice(0, 200) : null,
        x_kolm_capture_durable: obs.durable !== false,
      };
      try { res.write(`event: capture\ndata: ${JSON.stringify(event)}\n\n`); } catch (_) { /* socket closed */ }
    });
    const keepAlive = setInterval(() => {
      try { res.write(': keep-alive\n\n'); } catch {}
    }, 25000);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { unsubscribe(); } catch {}
      try { clearInterval(keepAlive); } catch {}
      try { res.end(); } catch {}
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  });

  // ---------- W258-BE-3 + W215: notifications API (threshold alerts opt-in) ----------
  // Public (no auth):
  //   GET    /v1/notifications/config             → { vapid_public_key, webpush_configured, email_configured, thresholds }
  // Auth-gated:
  //   GET    /v1/notifications/preferences        → { tenant, threshold_alerts, email, public }
  //   PUT    /v1/notifications/preferences        → set { threshold_alerts, email }
  //   GET    /v1/notifications/push-subscriptions → list registered web-push subs
  //   POST   /v1/notifications/push-subscriptions → register a subscription { endpoint, keys }
  //   DELETE /v1/notifications/push-subscriptions → remove by endpoint
  //   POST   /v1/notifications/test               → fire a dummy threshold alert (preview)
  //   GET    /v1/notifications/state              → { last_threshold_fired, fired_at } per namespace
  r.get('/v1/notifications/config', (req, res) => {
    res.json(notifPublicConfig());
  });
  r.get('/v1/notifications/preferences', authMiddleware, (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const prefs = notifGetPreferences(req.tenant);
    res.json({ preferences: prefs, public: notifPublicConfig() });
  });
  r.put('/v1/notifications/preferences', authMiddleware, (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    try {
      const next = notifSetPreferences(req.tenant, req.body || {});
      res.json({ preferences: next });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });
  r.get('/v1/notifications/push-subscriptions', authMiddleware, (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const subs = notifListPushSubscriptions(req.tenant).map((s) => ({
      endpoint: s.endpoint, created_at: s.created_at, last_sent_at: s.last_sent_at,
    }));
    res.json({ subscriptions: subs, count: subs.length });
  });
  r.post('/v1/notifications/push-subscriptions', authMiddleware, (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    try {
      const row = notifAddPushSubscription(req.tenant, req.body || {});
      res.status(201).json({ subscription: { endpoint: row.endpoint, created_at: row.created_at } });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });
  r.delete('/v1/notifications/push-subscriptions', authMiddleware, (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const endpoint = String((req.body || {}).endpoint || req.query?.endpoint || '');
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    const removed = notifRemovePushSubscription(req.tenant, endpoint);
    res.json({ ok: true, removed });
  });
  r.post('/v1/notifications/test', authMiddleware, async (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const namespace = sanitizeNamespace((req.body || {}).namespace || req.query?.namespace || 'default');
    const threshold = Math.max(1, Math.min(1000, parseInt((req.body || {}).threshold || '100', 10) || 100));
    const count = parseInt((req.body || {}).count || String(threshold), 10) || threshold;
    const baseUrl = process.env.PUBLIC_BASE
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://kolm.ai');
    try {
      const out = await notifFireThresholdAlert({ tenant: req.tenant, namespace, count, threshold, baseUrl });
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });
  r.get('/v1/notifications/state', authMiddleware, (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const namespace = req.query?.namespace ? sanitizeNamespace(String(req.query.namespace)) : 'default';
    res.json({
      state: notifGetThresholdState(req.tenant, namespace),
      distill_ready: notifIsDistillReady(req.tenant, namespace),
      thresholds: THRESHOLDS,
    });
  });

  // Drop-in `base_url` aliases so SDKs that append `/v1/messages` or
  // `/v1/chat/completions` keep working:
  //   ANTHROPIC_BASE_URL=https://kolm.ai/v1/capture/anthropic  →  POST .../v1/messages
  //   OPENAI_BASE_URL=https://kolm.ai/v1/capture/openai        →  POST .../v1/chat/completions
  // The tail is discarded; the same handler runs as the flat /v1/capture/<provider> route.
  // Express's `?` makes the suffix optional, and the wildcard absorbs any depth.
  // POST /v1/capture/anthropic — proxy to Anthropic, capture the round-trip.
  // The body is the upstream Anthropic Messages payload, unmodified.
  r.post(/^\/v1\/capture\/anthropic(?:\/.*)?$/, authMiddleware, async (req, res) => {
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
    // W258-BE-1: recordCaptureWithReceipt sets x-kolm-capture-id +
    // x-kolm-capture-durable + x-kolm-distill-ready when applicable, OR
    // sends a 503 + x-kolm-capture-durable:false on store failure (no
    // silent swallow). On 503 we MUST NOT forward the upstream result —
    // returning 200 + a phantom capture-id is the bug we are fixing.
    const obs = await recordCaptureWithReceipt(req, res, {
      tenant: req.tenant,
      provider: 'anthropic',
      model: modelFromBody(body, 'anthropic'),
      namespace,
      prompt,
      response: completion || (result.json && result.json.error ? `[error] ${result.json.error.message || result.json.error.type || 'upstream'}` : ''),
      latency_us: result.elapsed_us || 0,
      status: result.status,
    });
    if (!obs && res.headersSent) return; // 503 already returned
    res.status(result.status).json(result.json);
  });

  // POST /v1/capture/openai — same shape, OpenAI Chat Completions API.
  r.post(/^\/v1\/capture\/openai(?:\/.*)?$/, authMiddleware, async (req, res) => {
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
    const obs = await recordCaptureWithReceipt(req, res, {
      tenant: req.tenant,
      provider: 'openai',
      model: modelFromBody(body, 'openai'),
      namespace,
      prompt,
      response: completion || (result.json && result.json.error ? `[error] ${result.json.error.message || result.json.error.type || 'upstream'}` : ''),
      latency_us: result.elapsed_us || 0,
      status: result.status,
    });
    if (!obs && res.headersSent) return; // 503 already returned
    res.status(result.status).json(result.json);
  });

  // GET /v1/labels/synthesize-corpus?namespace=<n>&format=jsonl|json
  // Returns the captured (input, output) pairs for a namespace as JSONL or
  // a JSON envelope. This is what `kolm labels` downloads. Counts go to the
  // status command so the customer can see "ready to distill at 1000 pairs."
  // W258-BE-1: reads via the durable capture-store (listCaptures) so the
  // distillation corpus comes from the same backend the proxy writes to.
  r.get('/v1/labels/synthesize-corpus', authMiddleware, async (req, res) => {
    if (!req.tenant) return res.status(401).json({ error: 'auth required' });
    const namespace = sanitizeNamespace(req.query?.namespace || 'default');
    const fmt = String(req.query?.format || 'jsonl').toLowerCase();
    const limit = Math.min(Math.max(parseInt(String(req.query?.limit || '10000'), 10) || 10000, 1), 50000);
    const obs = await listCaptures(req.tenant, namespace, 50000);
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
    const base_model = String((req.body || {}).base_model || 'Qwen/Qwen2.5-3B-Instruct').slice(0, 128);
    const target_size = String((req.body || {}).target_size || 'phi-3-mini').slice(0, 64);
    // W243 mirror — distill route accepts the same recipe_class / hw_tier / output_target / multi_device
    // knobs so the wizard surfaces (cli/kolm.js cmdDistill, /account, /compile) share one contract.
    const { recipe_class, hw_tier, output_target, multi_device } = req.body || {};
    if (recipe_class != null && !['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'].includes(recipe_class)) {
      return res.status(400).json({ error: "recipe_class must be one of 'rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'" });
    }
    if (hw_tier != null && !['auto', 'cpu-server', '3090', '4090', '5090', 'm4-max-128', 'a100-80', 'h100-80', 'h200-141', 'dgx-spark', 'm3-ultra-512'].includes(hw_tier)) {
      return res.status(400).json({ error: "hw_tier must be one of 'auto', 'cpu-server', '3090', '4090', '5090', 'm4-max-128', 'a100-80', 'h100-80', 'h200-141', 'dgx-spark', 'm3-ultra-512'" });
    }
    if (output_target != null && !['gguf', 'onnx', 'safetensors', 'coreml', 'mlx', 'executorch', 'tensorrt', 'native-c', 'native-rust', 'wasm'].includes(output_target)) {
      return res.status(400).json({ error: "output_target must be one of 'gguf', 'onnx', 'safetensors', 'coreml', 'mlx', 'executorch', 'tensorrt', 'native-c', 'native-rust', 'wasm'" });
    }
    if (multi_device != null) {
      if (!Array.isArray(multi_device)) return res.status(400).json({ error: 'multi_device must be an array' });
      if (multi_device.length > 6) return res.status(400).json({ error: 'multi_device exceeds max 6 targets' });
      const VALID_MD = ['phone-ios', 'phone-android', 'laptop-cpu', 'browser-wasm', 'edge-jetson', 'server-cuda'];
      for (const d of multi_device) {
        if (!VALID_MD.includes(d)) return res.status(400).json({ error: `multi_device entry '${d}' must be one of ${VALID_MD.join(', ')}` });
      }
    }
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
      let matches = registry.searchSimilar({ query, tenant: req.tenant, tenantId: req.tenant_record?.id, k, tag: namespace });
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

  // ---------- Teams (orgs) ----------
  // Multi-tenant shared workspaces. Plan controls seat count. Roles:
  // viewer < member < admin < owner. Concepts, recipes, tunnels, and BYOC
  // deployments can be team-scoped via team_id; canRead/canWrite consult
  // the team_members table.
  function tenantOf(req) {
    return { id: req.tenant_record?.id || null, name: req.tenant, email: req.tenant_record?.email || null };
  }

  // Plan-tier gates. Reads stay open (any signed-in tenant can browse), only
  // write operations and resource creation are paywalled.
  const requireTeamsPlan = requirePlan(['teams', 'business', 'enterprise'], 'teams workspace');
  const requireTunnelsPlan = requirePlan(['pro', 'teams', 'business', 'enterprise'], 'remote-access tunnels');
  const requireByocPlan = requirePlan(['business', 'enterprise'], 'bring-your-own-cloud deploy');

  r.post('/v1/teams', requireTeamsPlan, (req, res) => {
    const t = tenantOf(req);
    if (!t.id) return res.status(401).json({ error: 'tenant required' });
    const { name, plan, seats_max } = req.body || {};
    try {
      const team = teams.createTeam({ ownerTenantId: t.id, name, plan, seatsMax: seats_max });
      res.status(201).json({ team });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  r.get('/v1/teams', (req, res) => {
    const t = tenantOf(req);
    if (!t.id) return res.status(401).json({ error: 'tenant required' });
    res.json({ teams: teams.listTeamsForTenant(t.id) });
  });

  r.get('/v1/teams/:idOrSlug', (req, res) => {
    const t = tenantOf(req);
    const team = teams.getTeam(req.params.idOrSlug);
    if (!team) return res.status(404).json({ error: 'team not found' });
    if (!teams.isMember(team.id, t.id) && !req.is_admin) {
      return res.status(403).json({ error: 'not a team member' });
    }
    const members = teams.listMembers(team.id);
    const invites = (() => { try { return teams.listInvites(team.id, t.id); } catch { return []; } })();
    res.json({ team, members, invites });
  });

  r.patch('/v1/teams/:idOrSlug', (req, res) => {
    const t = tenantOf(req);
    const team = teams.getTeam(req.params.idOrSlug);
    if (!team) return res.status(404).json({ error: 'team not found' });
    try {
      const updated = teams.updateTeam(team.id, t.id, req.body || {});
      res.json({ team: updated });
    } catch (e) {
      res.status(e.code === 'forbidden' ? 403 : 400).json({ error: String(e.message || e) });
    }
  });

  r.delete('/v1/teams/:idOrSlug', (req, res) => {
    const t = tenantOf(req);
    const team = teams.getTeam(req.params.idOrSlug);
    if (!team) return res.status(404).json({ error: 'team not found' });
    try {
      teams.deleteTeam(team.id, t.id);
      res.json({ ok: true, deleted: team.id });
    } catch (e) {
      res.status(e.code === 'forbidden' ? 403 : 400).json({ error: String(e.message || e) });
    }
  });

  r.post('/v1/teams/:idOrSlug/transfer', (req, res) => {
    const t = tenantOf(req);
    const team = teams.getTeam(req.params.idOrSlug);
    if (!team) return res.status(404).json({ error: 'team not found' });
    const { new_owner_tenant_id } = req.body || {};
    if (!new_owner_tenant_id) return res.status(400).json({ error: 'new_owner_tenant_id required' });
    try {
      const updated = teams.transferOwnership(team.id, t.id, new_owner_tenant_id);
      res.json({ team: updated });
    } catch (e) {
      res.status(e.code === 'forbidden' ? 403 : 400).json({ error: String(e.message || e) });
    }
  });

  r.post('/v1/teams/:idOrSlug/invite', (req, res) => {
    const t = tenantOf(req);
    const team = teams.getTeam(req.params.idOrSlug);
    if (!team) return res.status(404).json({ error: 'team not found' });
    const { email, role = 'member' } = req.body || {};
    try {
      const invite = teams.inviteToTeam(team.id, email, role, t.id);
      const acceptUrl = `${req.protocol}://${req.get('host')}/teams/accept?token=${encodeURIComponent(invite.token)}`;
      res.status(201).json({ ok: true, ...invite, accept_url: acceptUrl });
    } catch (e) {
      const status = e.code === 'forbidden' ? 403 : (e.code === 'seat_limit' ? 402 : 400);
      res.status(status).json({ error: String(e.message || e), code: e.code });
    }
  });

  r.get('/v1/teams/invites/:token', (req, res) => {
    const inv = teams.findInvite(req.params.token);
    if (!inv) return res.status(404).json({ error: 'invite not found or already used' });
    const team = teams.getTeam(inv.team_id);
    res.json({
      invite: { email: inv.email, role: inv.role, expires_at: inv.expires_at },
      team: team ? { id: team.id, slug: team.slug, name: team.name, plan: team.plan } : null,
    });
  });

  r.post('/v1/teams/invites/:token/accept', (req, res) => {
    const t = tenantOf(req);
    if (!t.id) return res.status(401).json({ error: 'sign in to accept the invite' });
    const result = teams.acceptInvite(req.params.token, t.id, t.email);
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json(result);
  });

  r.delete('/v1/teams/invites/:invite_id', (req, res) => {
    const t = tenantOf(req);
    try {
      teams.revokeInvite(req.params.invite_id, t.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.code === 'forbidden' ? 403 : 400).json({ error: String(e.message || e) });
    }
  });

  r.patch('/v1/teams/:idOrSlug/members/:tenant_id', (req, res) => {
    const t = tenantOf(req);
    const team = teams.getTeam(req.params.idOrSlug);
    if (!team) return res.status(404).json({ error: 'team not found' });
    const { role } = req.body || {};
    try {
      const updated = teams.changeMemberRole(team.id, req.params.tenant_id, role, t.id);
      res.json({ team: updated });
    } catch (e) {
      res.status(e.code === 'forbidden' ? 403 : 400).json({ error: String(e.message || e) });
    }
  });

  r.delete('/v1/teams/:idOrSlug/members/:tenant_id', (req, res) => {
    const t = tenantOf(req);
    const team = teams.getTeam(req.params.idOrSlug);
    if (!team) return res.status(404).json({ error: 'team not found' });
    try {
      teams.removeMember(team.id, req.params.tenant_id, t.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.code === 'forbidden' ? 403 : 400).json({ error: String(e.message || e) });
    }
  });

  // ---------- Remote-access tunnel ----------
  // User runs the agent locally; we broker requests at /r/<token>/...
  // The agent maintains an SSE connection to /v1/tunnel/agent/<token>, pulls
  // pending requests, runs the artifact, and posts responses back. The relay
  // never decrypts payloads (we don't terminate TLS inside the user's
  // machine), so the trust model is: trust kolm.ai to relay bytes in transit,
  // or use BYOC TEE for payload-blind operation.

  r.post('/v1/tunnel/register', requireTunnelsPlan, (req, res) => {
    const t = tenantOf(req);
    if (!t.id) return res.status(401).json({ error: 'tenant required' });
    const { name, team_id } = req.body || {};
    if (team_id && !teams.isMember(team_id, t.id)) {
      return res.status(403).json({ error: 'not a member of that team' });
    }
    const publicBase = (process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host')));
    const tnl = tunnel.registerTunnel({ tenantId: t.id, tenantName: t.name, teamId: team_id || null, name, publicBase });
    res.status(201).json({
      token: tnl.token,
      tunnel_id: tnl.id,
      public_url: tnl.public_url,
      expires_at: tnl.expires_at,
      agent_url: `${publicBase}/v1/tunnel/agent/${tnl.token}`,
      hint: 'run `kolm tunnel start --token <token>` on the machine that holds your .kolm artifact',
    });
  });

  r.get('/v1/tunnels', (req, res) => {
    const t = tenantOf(req);
    if (!t.id) return res.status(401).json({ error: 'tenant required' });
    const team_id = req.query.team_id ? String(req.query.team_id) : null;
    res.json({ tunnels: tunnel.listTunnelsForTenant(t.id, { teamId: team_id }) });
  });

  r.delete('/v1/tunnels/:token', (req, res) => {
    const t = tenantOf(req);
    if (!t.id) return res.status(401).json({ error: 'tenant required' });
    try {
      const ok = tunnel.closeTunnel(req.params.token, t.id);
      res.json({ ok });
    } catch (e) {
      res.status(e.code === 'forbidden' ? 403 : 400).json({ error: String(e.message || e) });
    }
  });

  // SSE long-poll: agent attaches and receives `request` events.
  r.get('/v1/tunnel/agent/:token', (req, res) => {
    const result = tunnel.attachAgent(req.params.token, res);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    // Response stays open until socket closes.
  });

  // Agent posts a response for a given request_id.
  r.post('/v1/tunnel/agent/:token/response', (req, res) => {
    const { request_id, status, headers, body } = req.body || {};
    if (!request_id) return res.status(400).json({ error: 'request_id required' });
    const r2 = tunnel.agentRespond(req.params.token, request_id, { status, headers, body });
    if (!r2.ok) return res.status(404).json({ error: r2.error });
    res.json({ ok: true });
  });

  // Public-facing tunnel URL. Anything posted/sent to /r/<token>/* is queued
  // for the agent and the agent's response is returned to the caller.
  function handleTunnelProxy(req, res, next) {
    const token = req.params.token;
    // wave 104: collision with public receipt route /r/:hash (vercel.json:200 →
    // /r.html?hash=:hash). On Vercel the rewrite fires first so this handler
    // only ever sees real tunnel tokens, but Railway-direct and self-host hit
    // Express straight and would 502 every receipt URL. Fall through when the
    // token isn't a known tunnel so the receipt handler in server.js can serve
    // public/r.html.
    if (!tunnel.getTunnelByToken(token)) return next();
    const subPath = req.params[0] ? '/' + req.params[0] : '/';
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      // Strip hop-by-hop headers + ours (auth + cookies are not forwarded by default).
      if (['host', 'connection', 'content-length', 'authorization', 'cookie', 'x-api-key'].includes(k.toLowerCase())) continue;
      headers[k] = Array.isArray(v) ? v.join(',') : v;
    }
    let bodyText = '';
    if (req.body != null) {
      if (Buffer.isBuffer(req.body)) bodyText = req.body.toString('utf8');
      else if (typeof req.body === 'string') bodyText = req.body;
      else bodyText = JSON.stringify(req.body);
    }
    tunnel.forwardRequest(token, { method: req.method, headers, path: subPath, body: bodyText })
      .then(resp => {
        for (const [k, v] of Object.entries(resp.headers || {})) {
          if (k.toLowerCase() === 'content-length') continue;
          try { res.setHeader(k, v); } catch {}
        }
        res.status(resp.status || 200).send(resp.body);
      })
      .catch(err => {
        const code = err.status || 502;
        res.status(code).json({ error: String(err.message || err), via: 'kolm-tunnel' });
      });
  }
  r.all('/r/:token', handleTunnelProxy);
  r.all('/r/:token/*', handleTunnelProxy);

  // ---------- BYOC (bring-your-own-cloud) ----------
  // Customer deploys a .kolm artifact to their own Fly / AWS Nitro / GCP CVM
  // / Azure CVM / Docker host. We issue a signed deploy manifest + a deploy
  // script the customer runs. The deployed instance POSTs an attestation
  // (image SHA, plus TEE measurement on confidential targets) back to
  // /v1/byoc/attestation. kolm.ai never runs the artifact.

  r.post('/v1/byoc/deploy', requireByocPlan, (req, res) => {
    const t = tenantOf(req);
    if (!t.id) return res.status(401).json({ error: 'tenant required' });
    const { target, artifact_id, region, name, team_id } = req.body || {};
    if (team_id && !teams.isMember(team_id, t.id)) {
      return res.status(403).json({ error: 'not a member of that team' });
    }
    try {
      const { deployment, manifest, deploy_script } = byoc.createDeployment({
        tenantId: t.id, tenantName: t.name, teamId: team_id || null,
        target, artifactId: artifact_id, region, name,
      });
      res.status(201).json({ deployment, manifest, deploy_script });
    } catch (e) {
      res.status(e.code === 'bad_request' ? 400 : 500).json({ error: String(e.message || e) });
    }
  });

  r.get('/v1/byoc/deployments', (req, res) => {
    const t = tenantOf(req);
    if (!t.id) return res.status(401).json({ error: 'tenant required' });
    const team_id = req.query.team_id ? String(req.query.team_id) : null;
    res.json({ deployments: byoc.listDeploymentsForTenant(t.id, { teamId: team_id }) });
  });

  r.get('/v1/byoc/deployments/:id', (req, res) => {
    const t = tenantOf(req);
    const d = byoc.getDeployment(req.params.id);
    if (!d) return res.status(404).json({ error: 'deployment not found' });
    if (d.tenant_id !== t.id && !(d.team_id && teams.isMember(d.team_id, t.id))) {
      return res.status(403).json({ error: 'not authorized' });
    }
    res.json({ deployment: d });
  });

  r.delete('/v1/byoc/deployments/:id', (req, res) => {
    const t = tenantOf(req);
    try {
      const ok = byoc.teardownDeployment(req.params.id, t.id);
      if (!ok) return res.status(404).json({ error: 'deployment not found' });
      res.json({ ok: true });
    } catch (e) {
      res.status(e.code === 'forbidden' ? 403 : 400).json({ error: String(e.message || e) });
    }
  });

  // Attestation callback — UNAUTH (no API key). Identifies via enroll_token,
  // which was minted by the deploy endpoint and embedded in the deploy script.
  // The token is single-use-equivalent: if an attacker has the token they
  // could spoof the public_url, but the deployment row is owned by a specific
  // tenant_id and the URL is visible in their dashboard — they'll notice.
  r.post('/v1/byoc/attestation', (req, res) => {
    const { enroll_token, public_url, measurement, attestation, target } = req.body || {};
    if (!enroll_token) return res.status(400).json({ error: 'enroll_token required' });
    const result = byoc.recordAttestation(enroll_token, { public_url, measurement, attestation });
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ ok: true, registered_at: new Date().toISOString() });
  });

  r.get('/v1/byoc/targets', (_req, res) => {
    res.json({ targets: byoc.TARGETS });
  });

  // ---------- Wave-144 module surfaces: trace / ir / device / cc / fl / lineage ----------
  // Mirrors the CLI verbs added in cli/kolm.js (cmdTrace, cmdIr, cmdDevice,
  // cmdCc, cmdFl). Stateless endpoints (validate, build, stats over JSON
  // inputs, list/lookup of static catalogs) are public. Endpoints that read
  // server-side trace storage or that produce/aggregate state need a tenant
  // identity, so they go through authMiddleware.
  //
  // Honest scope:
  //   - /v1/cc/verify only returns CRYPTOGRAPHICALLY_VERIFIED when a real
  //     verifier has been registered via registerAttestationVerifier(); the
  //     default shape-check path returns SHAPE_VALID and does NOT claim crypto.
  //   - /v1/fl/aggregate combines client-supplied contributions and returns
  //     the merged delta + per-contribution audit trail. It does not train.
  //   - /v1/lineage/build returns a hashed lineage block. Verification of the
  //     claims inside (e.g., parent_artifact_hash points to a real artifact)
  //     is the verifier's job, not this endpoint's.
  //
  // Rate-limited so an attacker can't use compile / aggregate as a CPU
  // amplifier or use trace stats as a directory probe.

  const wave144Limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate-limited — wave-144 module API caps at 120/min/ip' },
    keyGenerator: ipKey,
    validate: { trustProxy: false },
  });

  function _http400(res, msg) { return res.status(400).json({ error: String(msg) }); }
  function _http500(res, err) { return res.status(500).json({ error: String((err && err.message) || err) }); }
  function _unwrapIrBody(body) {
    const j = body && body.ir ? body.ir : body;
    if (j && typeof j === 'object' && j.spec === 'wir-v1') return j;
    if (j && typeof j === 'object' && j.ir && j.ir.spec === 'wir-v1') return j.ir;
    return j;
  }

  // ----- trace -----
  r.get('/v1/trace/:trace_id/stats', wave144Limiter, authMiddleware, async (req, res) => {
    try {
      const tid = String(req.params.trace_id || '');
      if (!/^[0-9a-f]{32}$/.test(tid)) return _http400(res, 'trace_id must be 32 hex chars');
      const s = await traceCapture.stats(tid);
      res.json(s);
    } catch (e) { _http500(res, e); }
  });

  r.get('/v1/trace/:trace_id/chain', wave144Limiter, authMiddleware, async (req, res) => {
    try {
      const tid = String(req.params.trace_id || '');
      if (!/^[0-9a-f]{32}$/.test(tid)) return _http400(res, 'trace_id must be 32 hex chars');
      const c = await traceCapture.chain(tid);
      res.json(c);
    } catch (e) { _http500(res, e); }
  });

  r.get('/v1/trace/:trace_id/export', wave144Limiter, authMiddleware, async (req, res) => {
    try {
      const tid = String(req.params.trace_id || '');
      if (!/^[0-9a-f]{32}$/.test(tid)) return _http400(res, 'trace_id must be 32 hex chars');
      const spans = await traceCapture.readTrace(tid);
      res.json({ trace_id: tid, spans });
    } catch (e) { _http500(res, e); }
  });

  r.post('/v1/trace/append', wave144Limiter, authMiddleware, async (req, res) => {
    try {
      const span = req.body && req.body.span;
      if (!span || typeof span !== 'object') return _http400(res, 'span object required');
      const enriched = await traceCapture.appendSpan(span);
      res.status(201).json({ ok: true, span: enriched });
    } catch (e) {
      const msg = String(e.message || e);
      if (/span missing field|unknown span kind|trace_id must|span_id must|parent_span_id must|payload must/.test(msg)) {
        return _http400(res, msg);
      }
      _http500(res, e);
    }
  });

  // ----- ir -----
  r.post('/v1/ir/compile', wave144Limiter, authMiddleware, async (req, res) => {
    try {
      const { trace_ids, spans, opts } = req.body || {};
      let result;
      if (Array.isArray(trace_ids) && trace_ids.length > 0) {
        for (const tid of trace_ids) {
          if (!/^[0-9a-f]{32}$/.test(String(tid))) return _http400(res, `bad trace_id: ${tid}`);
        }
        result = trace_ids.length === 1
          ? await compileIr.traceToIr(trace_ids[0], opts || {})
          : await compileIr.tracesToIr(trace_ids, opts || {});
      } else if (Array.isArray(spans) && spans.length > 0) {
        result = compileIr.spansToIr(spans, opts || {});
      } else {
        return _http400(res, 'trace_ids[] or spans[] required');
      }
      res.json(result);
    } catch (e) { _http500(res, e); }
  });

  r.post('/v1/ir/stats', wave144Limiter, (req, res) => {
    try {
      const ir = _unwrapIrBody(req.body || {});
      const s = workflowIr.stats(ir);
      res.json(s);
    } catch (e) { _http400(res, e.message || e); }
  });

  r.post('/v1/ir/validate', wave144Limiter, (req, res) => {
    try {
      const ir = _unwrapIrBody(req.body || {});
      workflowIr.validateIr(ir);
      res.json({ ok: true, hash: workflowIr.hashIr(ir) });
    } catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
  });

  r.post('/v1/ir/replay', wave144Limiter, async (req, res) => {
    try {
      const ir = _unwrapIrBody(req.body || {});
      const r2 = await workflowIr.replaySeeds(ir);
      res.json(r2);
    } catch (e) { _http400(res, e.message || e); }
  });

  // ----- device -----
  r.get('/v1/device/profiles', wave144Limiter, (_req, res) => {
    res.json({ spec: deviceCaps.CAPABILITY_VERSION, profiles: deviceCaps.allProfiles() });
  });

  r.get('/v1/device/profiles/:device_id', wave144Limiter, (req, res) => {
    const p = deviceCaps.profileFor(String(req.params.device_id || ''));
    if (!p) return res.status(404).json({ error: 'unknown device' });
    res.json(p);
  });

  r.post('/v1/device/check', wave144Limiter, (req, res) => {
    try {
      const { target, device_id } = req.body || {};
      if (!target || !device_id) return _http400(res, 'target and device_id required');
      const result = deviceCaps.meetsRequirement(target, String(device_id));
      res.json(result);
    } catch (e) { _http400(res, e.message || e); }
  });

  r.post('/v1/device/probe', wave144Limiter, async (_req, res) => {
    try { res.json(await deviceCaps.probeHost()); }
    catch (e) { _http500(res, e); }
  });

  // ----- confidential compute -----
  r.get('/v1/cc/kinds', wave144Limiter, (_req, res) => {
    res.json({ spec: confidentialCompute.ATTESTATION_SPEC_VERSION, kinds: Object.values(confidentialCompute.KINDS) });
  });

  r.get('/v1/cc/shape/:kind', wave144Limiter, (req, res) => {
    const k = String(req.params.kind || '');
    const shape = confidentialCompute.REPORT_SHAPES[k];
    if (!shape) return res.status(404).json({ error: 'unknown kind' });
    res.json({ kind: k, shape });
  });

  r.post('/v1/cc/verify', wave144Limiter, async (req, res) => {
    try {
      const { kind, report, opts } = req.body || {};
      if (!kind || !report) return _http400(res, 'kind and report required');
      const r2 = await confidentialCompute.verifyAttestation(String(kind), report, opts || {});
      res.json(r2);
    } catch (e) { _http400(res, e.message || e); }
  });

  // ----- federated learning -----
  r.get('/v1/fl/strategies', wave144Limiter, (_req, res) => {
    res.json({ spec: federatedLearning.FL_SPEC_VERSION, strategies: Object.values(federatedLearning.STRATEGIES) });
  });

  r.post('/v1/fl/round/new', wave144Limiter, authMiddleware, (req, res) => {
    try {
      const round = federatedLearning.newRound(req.body || {});
      res.status(201).json({ round, hash: federatedLearning.roundHash(round) });
    } catch (e) { _http400(res, e.message || e); }
  });

  r.post('/v1/fl/contribution/verify', wave144Limiter, authMiddleware, (req, res) => {
    try {
      const { contribution, round, public_key } = req.body || {};
      if (!contribution || !round || !public_key) return _http400(res, 'contribution, round, and public_key required');
      const r2 = federatedLearning.verifyContribution({ contribution, round, public_key });
      res.json(r2);
    } catch (e) { _http400(res, e.message || e); }
  });

  r.post('/v1/fl/aggregate', wave144Limiter, authMiddleware, (req, res) => {
    try {
      const { round, contributions } = req.body || {};
      if (!round || !Array.isArray(contributions)) return _http400(res, 'round and contributions[] required');
      const r2 = federatedLearning.aggregate({ round, contributions });
      res.json(r2);
    } catch (e) { _http400(res, e.message || e); }
  });

  // ----- lineage + capability -----
  r.post('/v1/lineage/build', wave144Limiter, (req, res) => {
    try { res.json(artifactLineage.buildLineage(req.body || {})); }
    catch (e) { _http400(res, e.message || e); }
  });

  r.post('/v1/lineage/validate', wave144Limiter, (req, res) => {
    try {
      const out = artifactLineage.validateLineage(req.body || {});
      res.json({ ok: true, block: out });
    } catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
  });

  r.post('/v1/capability/build', wave144Limiter, (req, res) => {
    try { res.json(artifactLineage.buildCapability(req.body || {})); }
    catch (e) { _http400(res, e.message || e); }
  });

  r.post('/v1/capability/validate', wave144Limiter, (req, res) => {
    try {
      const out = artifactLineage.validateCapability(req.body || {});
      res.json({ ok: true, block: out });
    } catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
  });

  // W263 marketplace — signed public catalog of .kolm artifacts.
  // GET /v1/marketplace/catalog.json — signed manifest (sha256-anchor).
  // GET /v1/marketplace — raw artifact array (unsigned, convenience).
  // POST /v1/marketplace/publish-request — queued for manual review.
  // GET /v1/marketplace/:slug — single artifact entry, 404 if unknown.
  // GET /v1/marketplace/:slug/download — streams the backing .kolm file.
  r.get('/v1/marketplace/catalog.json', (req, res) => {
    try {
      res.set('Cache-Control', 'public, max-age=300');
      res.json(marketplaceGetCatalogManifest());
    } catch (e) { res.status(500).json({ error: 'marketplace_catalog_error', detail: String(e.message || e) }); }
  });

  r.get('/v1/marketplace', (req, res) => {
    try {
      const filter = {};
      if (req.query.category) filter.category = String(req.query.category);
      if (req.query.license) filter.license = String(req.query.license);
      if (req.query.verified === 'true') filter.verified = true;
      if (req.query.min_k_score) filter.min_k_score = Number(req.query.min_k_score);
      if (req.query.q) filter.q = String(req.query.q);
      res.json({ artifacts: marketplaceListArtifacts({ filter }) });
    } catch (e) { res.status(500).json({ error: 'marketplace_list_error', detail: String(e.message || e) }); }
  });

  r.post('/v1/marketplace/publish-request', (req, res) => {
    try {
      const body = req.body || {};
      const queueDir = path.join(os.tmpdir(), 'kolm-marketplace-queue');
      try { fs.mkdirSync(queueDir, { recursive: true }); } catch (_e) { /* best-effort */ }
      const queueId = crypto.randomBytes(8).toString('hex');
      const row = {
        queue_id: queueId,
        received_at: new Date().toISOString(),
        proposed_slug: String(body.slug || '').slice(0, 64),
        proposed_name: String(body.name || '').slice(0, 128),
        artifact_sha256: String(body.sha256 || '').slice(0, 64),
        artifact_bytes: Number(body.bytes) || 0,
        contact: String(body.contact || '').slice(0, 256),
      };
      try { fs.appendFileSync(path.join(queueDir, 'publish-queue.jsonl'), JSON.stringify(row) + '\n'); } catch (_e) { /* best-effort */ }
      res.status(202).json({ ok: true, queue_id: queueId, status: 'manual_review_queue', message: 'received; manual review by kolm.ai team' });
    } catch (e) { res.status(500).json({ error: 'marketplace_publish_error', detail: String(e.message || e) }); }
  });

  r.get('/v1/marketplace/:slug', (req, res) => {
    try {
      const a = marketplaceGetArtifact(String(req.params.slug || ''));
      if (!a) return res.status(404).json({ error: 'unknown_slug', slug: req.params.slug });
      res.json(a);
    } catch (e) { res.status(500).json({ error: 'marketplace_get_error', detail: String(e.message || e) }); }
  });

  r.get('/v1/marketplace/:slug/download', (req, res) => {
    try {
      const slug = String(req.params.slug || '');
      const a = marketplaceGetArtifact(slug);
      if (!a) return res.status(404).json({ error: 'unknown_slug', slug });
      const abs = marketplaceResolveArtifactPath(slug);
      if (!abs) return res.status(410).json({ error: 'artifact_gone', slug });
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', `attachment; filename="${slug}.kolm"`);
      res.set('X-Kolm-Sha256', a.sha256);
      res.set('X-Kolm-Bytes', String(a.bytes));
      fs.createReadStream(abs).pipe(res);
    } catch (e) { res.status(500).json({ error: 'marketplace_download_error', detail: String(e.message || e) }); }
  });

  return r;
}
