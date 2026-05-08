#!/usr/bin/env node
// One-shot Stripe provisioner for kolm. Creates fresh Products, Prices,
// Payment Links, and a webhook endpoint under the calling Stripe account.
// Idempotent on metadata `kolm_tier` — re-running the script reuses the
// existing Product/Price/Link rather than creating duplicates.
//
// Usage:
//   STRIPE_SECRET_KEY=sk_live_... \
//   KOLM_DOMAIN=https://kolm.ai \
//     node scripts/stripe-provision.mjs > provision.json

import fs from 'node:fs';

const SECRET = process.env.STRIPE_SECRET_KEY;
const DOMAIN = process.env.KOLM_DOMAIN || 'https://kolm.ai';
if (!SECRET) { console.error('STRIPE_SECRET_KEY required'); process.exit(2); }

const TIERS = [
  { id: 'starter',    label: 'Starter',    cents:    900 },
  { id: 'pro',        label: 'Pro',        cents:   4900 },
  { id: 'teams',      label: 'Teams',      cents:  14900 },
  { id: 'business',   label: 'Business',   cents: 149900 },
  { id: 'enterprise', label: 'Enterprise', cents: 299900 },
];

async function stripe(method, path, body) {
  const params = body
    ? Object.entries(body).map(([k, v]) => {
        if (typeof v === 'object' && v !== null) {
          return Object.entries(v).map(([k2, v2]) => `${encodeURIComponent(k)}[${encodeURIComponent(k2)}]=${encodeURIComponent(v2)}`).join('&');
        }
        return `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
      }).join('&')
    : null;
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function search(resource, query) {
  const res = await stripe('GET', `/${resource}/search?query=${encodeURIComponent(query)}`);
  return res.data || [];
}

async function ensureProduct(tier) {
  const found = await search('products', `metadata['kolm_tier']:'${tier.id}'`);
  if (found.length) return found[0];
  return stripe('POST', '/products', {
    name: `kolm ${tier.label}`,
    description: `kolm ${tier.label} tier — monthly recurring`,
    'metadata[kolm_tier]': tier.id,
  });
}

async function ensurePrice(product, tier) {
  const found = await search('prices', `product:'${product.id}' AND active:'true' AND metadata['kolm_tier']:'${tier.id}'`);
  if (found.length) {
    const match = found.find(p => p.unit_amount === tier.cents && p.recurring && p.recurring.interval === 'month');
    if (match) return match;
  }
  return stripe('POST', '/prices', {
    product: product.id,
    unit_amount: tier.cents,
    currency: 'usd',
    'recurring[interval]': 'month',
    'metadata[kolm_tier]': tier.id,
  });
}

async function ensurePaymentLink(price, tier) {
  // No search endpoint for payment_links; list and filter by metadata.
  const list = await stripe('GET', '/payment_links?limit=100&active=true');
  const existing = (list.data || []).find(pl =>
    pl.metadata && pl.metadata.kolm_tier === tier.id
  );
  if (existing) return existing;
  return stripe('POST', '/payment_links', {
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': 1,
    allow_promotion_codes: 'true',
    'metadata[kolm_tier]': tier.id,
    'after_completion[type]': 'redirect',
    'after_completion[redirect][url]': `${DOMAIN}/account?paid=${tier.id}`,
  });
}

async function ensureWebhook() {
  const url = `${DOMAIN}/v1/stripe/webhook`;
  const list = await stripe('GET', '/webhook_endpoints?limit=100');
  const existing = (list.data || []).find(w => w.url === url);
  if (existing) return { endpoint: existing, secret: null, reused: true };
  const created = await stripe('POST', '/webhook_endpoints', {
    url,
    'enabled_events[0]': 'checkout.session.completed',
    'enabled_events[1]': 'customer.subscription.deleted',
    'enabled_events[2]': 'invoice.payment_failed',
    description: 'kolm.ai plan flips on payment',
  });
  return { endpoint: created, secret: created.secret, reused: false };
}

async function main() {
  const out = { tiers: {}, webhook: null };
  for (const tier of TIERS) {
    const product = await ensureProduct(tier);
    const price = await ensurePrice(product, tier);
    const link = await ensurePaymentLink(price, tier);
    out.tiers[tier.id] = {
      product_id: product.id,
      price_id: price.id,
      payment_link_id: link.id,
      payment_link_url: link.url,
      cents: tier.cents,
    };
    console.error(`OK  ${tier.id.padEnd(10)} -> ${link.url}`);
  }
  const wh = await ensureWebhook();
  out.webhook = {
    id: wh.endpoint.id,
    url: wh.endpoint.url,
    secret: wh.secret,           // null if reused (Stripe only reveals on create)
    reused: wh.reused,
  };
  console.error(`OK  webhook   -> ${wh.endpoint.url} (reused=${wh.reused})`);
  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
