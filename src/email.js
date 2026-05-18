// Transactional email via Resend HTTP API. No SDK dep — built-in fetch.
//
// Configuration:
//   RESEND_API_KEY          - re_... from https://resend.com/api-keys
//   EMAIL_FROM              - "kolm <hello@kolm.ai>"  (must be a verified
//                              sender on Resend; for the kolm.ai domain,
//                              add the DNS records Resend prints)
//   EMAIL_REPLY_TO          - optional, defaults to EMAIL_FROM
//
// If RESEND_API_KEY is unset, sendMail() returns { skipped: true } so the rest
// of the app never blocks on email — every email path is best-effort.

const RESEND_URL = 'https://api.resend.com/emails';

export function emailConfigured() {
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;
}

export async function sendMail({ to, subject, html, text, replyTo, tags }) {
  if (!emailConfigured()) return { skipped: true, reason: 'email_not_configured' };
  if (!to || !subject || (!html && !text)) {
    return { skipped: true, reason: 'missing fields' };
  }
  const body = {
    from: process.env.EMAIL_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    reply_to: replyTo || process.env.EMAIL_REPLY_TO || undefined,
  };
  if (html) body.html = html;
  if (text) body.text = text;
  if (tags) body.tags = tags;

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[email] resend error', res.status, json);
      return { ok: false, status: res.status, error: json.message || 'resend error' };
    }
    return { ok: true, id: json.id };
  } catch (err) {
    console.error('[email] send threw', err);
    return { ok: false, error: String(err.message || err) };
  }
}

export async function sendWelcome({ email, apiKey, plan, billingUrl }) {
  const planLabel = (plan || 'free').toString();
  const subject = `Your kolm API key${billingUrl ? ' (payment required)' : ''}`;
  const lines = [
    `Welcome to kolm.`,
    ``,
    `Your API key:`,
    `  ${apiKey}`,
    ``,
    `Save it. We don't store the raw key — only a hash. You can rotate any time from`,
    `  https://kolm.ai/account`,
    ``,
    `Plan: ${planLabel}`,
  ];
  if (billingUrl) {
    lines.push('', `Complete payment to activate your paid tier:`, `  ${billingUrl}`);
    lines.push('', `Until payment is confirmed, your account is on the Developer (free) tier.`);
  }
  lines.push('', `Docs: https://kolm.ai/docs`, `Quickstart: https://kolm.ai/quickstart`, '', `— kolm`);
  return sendMail({
    to: email,
    subject,
    text: lines.join('\n'),
    html: lines.map(l => l ? `<div>${escapeHtml(l)}</div>` : '<div>&nbsp;</div>').join(''),
    tags: [{ name: 'kind', value: 'welcome' }],
  });
}

export async function sendBillingActivated({ email, plan, quota }) {
  const subject = `Your kolm ${plan} tier is active`;
  const text = [
    `Payment confirmed. Your kolm ${plan} tier is now active.`,
    ``,
    `Monthly quota: ${quota.toLocaleString()} requests.`,
    ``,
    `Manage at https://kolm.ai/account.`,
    ``,
    `— kolm`,
  ].join('\n');
  return sendMail({ to: email, subject, text, tags: [{ name: 'kind', value: 'billing_activated' }] });
}

export async function sendBillingFailed({ email, plan }) {
  const subject = `Action needed: payment failed for your kolm ${plan} tier`;
  const text = [
    `Stripe was unable to charge your card for the ${plan} tier.`,
    ``,
    `Stripe will retry automatically over the next 7 days. To update your payment method`,
    `or cancel, manage your subscription at https://kolm.ai/account.`,
    ``,
    `Your account stays active during the retry window. If all retries fail your tenant`,
    `will downgrade to the Developer (free) tier.`,
    ``,
    `— kolm`,
  ].join('\n');
  return sendMail({ to: email, subject, text, tags: [{ name: 'kind', value: 'billing_failed' }] });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---------------------------------------------------------------------------
// Wave 253 sec#5 — setup-token flow.
//
// Background: pre-W253 the welcome email carried the raw API key in plaintext
// in the message body AND inside Resend's request log. A leak of EMAIL_FROM's
// Resend log (or an inbox compromise weeks after onboarding) would surrender
// every customer key. The setup token replaces that with:
//
//   1. Mint at signup time: tok = base64url({apiKeyId, exp}) + '.' + hmac(secret, payload)
//      The token NEVER carries the raw key, only the apiKeyId opaque handle.
//   2. Welcome email links to /setup?token=<tok>. The link expires in 30
//      minutes (configurable via KOLM_SETUP_TOKEN_TTL_SEC). After expiry the
//      user must request a fresh token via /forgot-key.
//   3. Browser POSTs the token to /v1/setup/reveal. The backend calls
//      verifySetupToken, then consumeRawKeyForReveal(apiKeyId) which is a
//      one-shot in-memory cache populated at signup. After one consume the
//      key is gone; refreshing the page shows a "key already revealed" error
//      and the user must rotate.
//
// The secret is KOLM_SETUP_SECRET. If the env var is unset we mint a process-
// local fallback in process.__kolm_setup_secret_fallback so dev still works.
// ---------------------------------------------------------------------------

import nodeCrypto from 'node:crypto';

const SETUP_TTL_SEC = Number(process.env.KOLM_SETUP_TOKEN_TTL_SEC || 1800);

function getSetupSecret() {
  if (process.env.KOLM_SETUP_SECRET) return String(process.env.KOLM_SETUP_SECRET);
  if (!process.__kolm_setup_secret_fallback) {
    process.__kolm_setup_secret_fallback = nodeCrypto.randomBytes(32).toString('hex');
  }
  return process.__kolm_setup_secret_fallback;
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

export function mintSetupToken(apiKeyId, opts = {}) {
  const exp = Date.now() + (opts.ttlSec || SETUP_TTL_SEC) * 1000;
  const payload = JSON.stringify({ apiKeyId: String(apiKeyId), exp });
  const head = b64urlEncode(payload);
  const sig = b64urlEncode(nodeCrypto.createHmac('sha256', getSetupSecret()).update(head).digest());
  return head + '.' + sig;
}

export function verifySetupToken(tok) {
  try {
    if (typeof tok !== 'string' || tok.indexOf('.') < 0) return null;
    const [head, sig] = tok.split('.', 2);
    if (!head || !sig) return null;
    const expected = b64urlEncode(nodeCrypto.createHmac('sha256', getSetupSecret()).update(head).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !nodeCrypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(b64urlDecode(head));
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// In-memory single-use cache: { apiKeyId -> { key, exp } }
const RAW_KEY_CACHE = new Map();

export function cacheRawKeyForReveal(apiKeyId, rawKey, opts = {}) {
  if (!apiKeyId || !rawKey) return;
  const exp = Date.now() + (opts.ttlSec || SETUP_TTL_SEC) * 1000;
  RAW_KEY_CACHE.set(String(apiKeyId), { key: String(rawKey), exp });
  // Lazy GC — sweep on every set so the map never grows unbounded.
  const now = Date.now();
  for (const [k, v] of RAW_KEY_CACHE) {
    if (v.exp < now) RAW_KEY_CACHE.delete(k);
  }
}

export function consumeRawKeyForReveal(apiKeyId) {
  if (!apiKeyId) return null;
  const id = String(apiKeyId);
  const entry = RAW_KEY_CACHE.get(id);
  if (!entry) return null;
  RAW_KEY_CACHE.delete(id);
  if (entry.exp < Date.now()) return null;
  return entry.key;
}
