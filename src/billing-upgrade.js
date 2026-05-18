// src/billing-upgrade.js
//
// W363 — real billing upgrade flow. Every tenant always gets a working URL.
//
// Fallback chain (first match wins):
//   1. existing Stripe Payment Link (STRIPE_PAYMENT_LINK_<PLAN>) via the
//      router's billingLinkFor callback
//   2. Stripe Checkout Session created on the fly via plain fetch when
//      KOLM_STRIPE_KEY + KOLM_STRIPE_PRICE_<PLAN> are set (no SDK; just
//      a POST to https://api.stripe.com/v1/checkout/sessions)
//   3. KOLM_BILLING_URL — self-hosted billing portal; the plan id is
//      appended as ?plan=<plan>
//   4. Default: https://kolm.ai/pricing#contact. We also append the
//      upgrade request to ~/.kolm/upgrade-requests.jsonl so founders can
//      fulfill it manually. The tenant gets a real URL; they never see
//      "not yet wired".
//
// Pure ESM. ZERO new npm deps — fetch is global on Node >= 18.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STRIPE_PRICE_ENVS = {
  starter:    'KOLM_STRIPE_PRICE_STARTER',
  pro:        'KOLM_STRIPE_PRICE_PRO',
  teams:      'KOLM_STRIPE_PRICE_TEAMS',
  business:   'KOLM_STRIPE_PRICE_BUSINESS',
  enterprise: 'KOLM_STRIPE_PRICE_ENT',
};

export function upgradeRequestsFile() {
  return process.env.KOLM_UPGRADE_REQUESTS_FILE
    || path.join(process.env.KOLM_DATA_DIR || path.join(os.homedir(), '.kolm'), 'upgrade-requests.jsonl');
}

function logUpgradeRequest(entry) {
  try {
    const file = upgradeRequestsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {
    // Filesystem failures are non-fatal — the user still gets a working URL.
  }
}

// Stripe REST: POST https://api.stripe.com/v1/checkout/sessions with
// Bearer auth and form-urlencoded body. No SDK.
async function createStripeCheckoutSession({ priceId, customerEmail, tenantId, successUrl, cancelUrl, apiKey, baseUrl }) {
  const base = (baseUrl || 'https://api.stripe.com').replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', priceId);
  params.set('line_items[0][quantity]', '1');
  params.set('success_url', successUrl);
  params.set('cancel_url', cancelUrl);
  if (customerEmail) params.set('customer_email', customerEmail);
  if (tenantId) {
    params.set('client_reference_id', tenantId);
    params.set('metadata[tenant_id]', tenantId);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const resp = await fetch(base + '/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: ctl.signal,
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || !body || !body.url) {
      const msg = body?.error?.message || `stripe_http_${resp.status}`;
      throw new Error(msg);
    }
    return body.url;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveUpgradeUrl({ plan, tenantId, email, existingLinkFn } = {}) {
  const planId = String(plan || '').toLowerCase();
  const publicBase = (process.env.PUBLIC_BASE || 'https://kolm.ai').replace(/\/+$/, '');

  // Path 1: existing Stripe Payment Link (operator pre-configured).
  if (typeof existingLinkFn === 'function') {
    try {
      const url = existingLinkFn();
      if (url) return { checkout_url: url, source: 'stripe_payment_link' };
    } catch (_) {}
  }

  // Path 2: Stripe Checkout Session via plain fetch.
  const stripeKey = process.env.KOLM_STRIPE_KEY || process.env.STRIPE_SECRET_KEY || '';
  const priceEnvName = STRIPE_PRICE_ENVS[planId];
  const priceId = priceEnvName ? (process.env[priceEnvName] || '') : '';
  if (stripeKey && priceId) {
    try {
      const url = await createStripeCheckoutSession({
        priceId,
        customerEmail: email || undefined,
        tenantId: tenantId || undefined,
        successUrl: `${publicBase}/account?upgrade=success&plan=${encodeURIComponent(planId)}`,
        cancelUrl:  `${publicBase}/pricing?upgrade=cancelled&plan=${encodeURIComponent(planId)}`,
        apiKey: stripeKey,
        baseUrl: process.env.KOLM_STRIPE_BASE_URL || undefined,
      });
      return { checkout_url: url, source: 'stripe_checkout_api' };
    } catch (_) {
      // Fall through to next path on Stripe failure.
    }
  }

  // Path 3: self-hosted billing URL.
  const selfHosted = process.env.KOLM_BILLING_URL || '';
  if (selfHosted) {
    const sep = selfHosted.includes('?') ? '&' : '?';
    const url = `${selfHosted}${sep}plan=${encodeURIComponent(planId)}${tenantId ? `&tenant=${encodeURIComponent(tenantId)}` : ''}`;
    return { checkout_url: url, source: 'self_hosted' };
  }

  // Path 4: default fallback — log the request and return the public pricing
  // contact URL. The tenant always gets a working link.
  logUpgradeRequest({
    at: new Date().toISOString(),
    plan: planId,
    tenant_id: tenantId || null,
    email: email || null,
    source: 'manual_fallback',
  });
  return {
    checkout_url: `${publicBase}/pricing#contact`,
    source: 'manual_fallback',
    plan_change_pending: true,
  };
}

export default { resolveUpgradeUrl, upgradeRequestsFile };
