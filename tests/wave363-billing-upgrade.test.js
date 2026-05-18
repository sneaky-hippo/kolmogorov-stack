// Wave 363 — billing upgrade resolves a real URL on every path.
//
// Closes the W199-W363 gap where the upgrade case in src/assistant.js returned
// "not yet wired in. Mail founders@kolm.ai". The new resolveUpgradeUrl chain:
//   1. existing Stripe Payment Link (operator-pre-configured)
//   2. Stripe Checkout Session via plain fetch (KOLM_STRIPE_KEY + price env)
//   3. self-hosted KOLM_BILLING_URL with ?plan=... appended
//   4. default kolm.ai/pricing#contact + ~/.kolm/upgrade-requests.jsonl log
//
// Behavior tests:
//   1. Path 1 — existingLinkFn returns a URL: that URL wins.
//   2. Path 2 — KOLM_STRIPE_KEY + KOLM_STRIPE_PRICE_PRO set + Stripe mock
//      returns a 200 with {url}: that URL wins.
//   3. Path 3 — KOLM_BILLING_URL set: that URL + ?plan=<plan>.
//   4. Path 4 — nothing set: returns kolm.ai/pricing#contact + appends one
//      JSONL row to upgrade-requests.jsonl.
//   5. upgradeRequestsFile() honors KOLM_UPGRADE_REQUESTS_FILE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODULE_PATH = path.join(ROOT, 'src/billing-upgrade.js');

function freshImport() {
  return import(pathToFileURL(MODULE_PATH).href + '?t=' + Date.now());
}

function withCleanEnv(extra = {}) {
  const SAVED = {};
  const TARGETS = [
    'KOLM_STRIPE_KEY', 'STRIPE_SECRET_KEY', 'KOLM_STRIPE_BASE_URL',
    'KOLM_STRIPE_PRICE_STARTER', 'KOLM_STRIPE_PRICE_PRO', 'KOLM_STRIPE_PRICE_TEAMS',
    'KOLM_STRIPE_PRICE_BUSINESS', 'KOLM_STRIPE_PRICE_ENT',
    'KOLM_BILLING_URL', 'KOLM_UPGRADE_REQUESTS_FILE', 'KOLM_DATA_DIR',
    'PUBLIC_BASE',
  ];
  for (const k of TARGETS) {
    if (k in process.env) { SAVED[k] = process.env[k]; delete process.env[k]; }
  }
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  return () => {
    for (const k of TARGETS) delete process.env[k];
    for (const [k, v] of Object.entries(SAVED)) process.env[k] = v;
  };
}

function startMockStripe({ url, status = 200, body = null }) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      const resp = body || { id: 'cs_mock', url };
      res.end(JSON.stringify(resp));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('W363 #1 — existing Stripe Payment Link wins', async () => {
  const restore = withCleanEnv();
  try {
    const { resolveUpgradeUrl } = await freshImport();
    const r = await resolveUpgradeUrl({
      plan: 'pro',
      tenantId: 't_1',
      email: 'a@b.c',
      existingLinkFn: () => 'https://buy.stripe.com/test_link',
    });
    assert.equal(r.checkout_url, 'https://buy.stripe.com/test_link');
    assert.equal(r.source, 'stripe_payment_link');
  } finally { restore(); }
});

test('W363 #2 — Stripe Checkout Session via plain fetch', async () => {
  const mock = await startMockStripe({ url: 'https://checkout.stripe.com/c/pay/mock' });
  const restore = withCleanEnv({
    KOLM_STRIPE_KEY: 'sk_test_mock',
    KOLM_STRIPE_PRICE_PRO: 'price_mock_pro',
    KOLM_STRIPE_BASE_URL: mock.base,
  });
  try {
    const { resolveUpgradeUrl } = await freshImport();
    const r = await resolveUpgradeUrl({ plan: 'pro', tenantId: 't_42', email: 'who@there.com' });
    assert.equal(r.source, 'stripe_checkout_api');
    assert.equal(r.checkout_url, 'https://checkout.stripe.com/c/pay/mock');
  } finally { restore(); await mock.close(); }
});

test('W363 #3 — KOLM_BILLING_URL self-hosted fallback appends ?plan=', async () => {
  const restore = withCleanEnv({ KOLM_BILLING_URL: 'https://billing.example.com/portal' });
  try {
    const { resolveUpgradeUrl } = await freshImport();
    const r = await resolveUpgradeUrl({ plan: 'teams', tenantId: 't_77' });
    assert.equal(r.source, 'self_hosted');
    assert.match(r.checkout_url, /^https:\/\/billing\.example\.com\/portal\?plan=teams/);
    assert.match(r.checkout_url, /tenant=t_77/);
  } finally { restore(); }
});

test('W363 #4 — nothing configured → kolm.ai pricing fallback + jsonl log row', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w363-'));
  const logFile = path.join(tmp, 'upgrade-requests.jsonl');
  const restore = withCleanEnv({
    KOLM_UPGRADE_REQUESTS_FILE: logFile,
    PUBLIC_BASE: 'https://kolm.ai',
  });
  try {
    const { resolveUpgradeUrl } = await freshImport();
    const r = await resolveUpgradeUrl({ plan: 'enterprise', tenantId: 't_z', email: 'cto@biz.com' });
    assert.equal(r.source, 'manual_fallback');
    assert.equal(r.checkout_url, 'https://kolm.ai/pricing#contact');
    assert.equal(r.plan_change_pending, true);
    const raw = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(raw.length, 1);
    const row = JSON.parse(raw[0]);
    assert.equal(row.plan, 'enterprise');
    assert.equal(row.tenant_id, 't_z');
    assert.equal(row.email, 'cto@biz.com');
    assert.equal(row.source, 'manual_fallback');
    assert.ok(row.at);
  } finally {
    restore();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W363 #5 — upgradeRequestsFile() honors env override + falls back to ~/.kolm/upgrade-requests.jsonl', async () => {
  const restore = withCleanEnv({ KOLM_UPGRADE_REQUESTS_FILE: '/tmp/override.jsonl' });
  try {
    const { upgradeRequestsFile } = await freshImport();
    assert.equal(upgradeRequestsFile(), '/tmp/override.jsonl');
  } finally { restore(); }
  // Without env, fallback to ~/.kolm/upgrade-requests.jsonl (or KOLM_DATA_DIR).
  const restore2 = withCleanEnv({ KOLM_DATA_DIR: '/tmp/foo-data' });
  try {
    const { upgradeRequestsFile } = await freshImport();
    assert.equal(upgradeRequestsFile(), path.join('/tmp/foo-data', 'upgrade-requests.jsonl'));
  } finally { restore2(); }
});
