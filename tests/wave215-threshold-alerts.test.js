// Wave 215: threshold alerts (100 / 500 / 1000 captured pairs).
//
// Behavior assertions (per Pablo W202-W210 correction - no page-text markers).
//
// W215 contract this test enforces:
//   1. THRESHOLDS exported as [100, 500, 1000] from src/notifications.js.
//   2. thresholdCrossedBy(prev, new) returns the highest crossed threshold
//      OR 0 when none. Single-pair increments at the boundary fire.
//   3. setThresholdState dedupes - a second call at the same threshold
//      stores the same row; the firing decision happens in the recordCapture
//      path (prev<crossed) so re-issuing the same call does not re-fire.
//   4. fireThresholdAlert with opt-out (default) returns {ok:false,
//      reason:'opted_out'} and does NOT touch push / email.
//   5. fireThresholdAlert with opt-in returns ok:true with push counters
//      even when zero subs are registered (empty arrays, not undefined).
//   6. addPushSubscription / listPushSubscriptions / removePushSubscription
//      round-trip cleanly per tenant.
//   7. vapidConfigured() returns false when VAPID_* env unset; sendWebPush
//      returns {ok:false, error:'vapid_not_configured'} in that case (NOT
//      a silent ok:true).
//   8. buildVapidHeader() produces an Authorization header containing both
//      `t=<jwt>` and `k=<public key>` when VAPID env IS set.
//   9. router.js imports the notifications module + wires threshold detection
//      into recordCapture (after publishCapture).
//  10. router.js sets x-kolm-distill-ready: true on capture handlers when
//      the namespace has crossed any threshold (sticky-once-set).
//  11. Six /v1/notifications/* routes exist, with the auth-required ones
//      guarded by authMiddleware and the public-config route ungated.
//  12. publicConfig() returns vapid_public_key, webpush_configured,
//      email_configured, thresholds.
//  13. public/settings.html exists, references the notifications routes
//      AND the WebPush subscribe flow.
//  14. public/sw.js has a push handler (showNotification) AND CACHE slug
//      bumped to wave215-threshold-alerts.
//  15. vercel.json rewrites /settings -> /settings.html.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROUTER_SRC = fs.readFileSync(path.join(ROOT, 'src/router.js'), 'utf8');
const NOTIF_SRC = fs.readFileSync(path.join(ROOT, 'src/notifications.js'), 'utf8');
const WEBPUSH_SRC = fs.readFileSync(path.join(ROOT, 'src/webpush.js'), 'utf8');
const SETTINGS_HTML = fs.readFileSync(path.join(ROOT, 'public/settings.html'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
const VERCEL_JSON = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');

// Generate one VAPID key pair we can reuse across env-dependent tests so we
// don't need OpenSSL on the test runner. P-256 raw 32-byte scalar + 65-byte
// uncompressed public key, both base64url-encoded.
function generateVapidPairForTest() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const b64urlToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4), 'base64');
  const bufToB64url = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const x = b64urlToBuf(pubJwk.x);
  const y = b64urlToBuf(pubJwk.y);
  const d = b64urlToBuf(privJwk.d);
  const pub65 = Buffer.concat([Buffer.from([0x04]), x, y]); // uncompressed X9.62
  return { vapidPublic: bufToB64url(pub65), vapidPrivate: bufToB64url(d) };
}

test('W215 #1 - THRESHOLDS = [100, 500, 1000]', async () => {
  const m = await import('../src/notifications.js');
  assert.deepEqual(m.THRESHOLDS, [100, 500, 1000]);
});

test('W215 #2 - thresholdCrossedBy boundary semantics', async () => {
  const { thresholdCrossedBy } = await import('../src/notifications.js');
  assert.equal(thresholdCrossedBy(99, 100), 100, '99->100 fires 100');
  assert.equal(thresholdCrossedBy(100, 101), 0, '100->101 does not re-fire');
  assert.equal(thresholdCrossedBy(499, 500), 500, '499->500 fires 500');
  assert.equal(thresholdCrossedBy(999, 1000), 1000, '999->1000 fires 1000');
  assert.equal(thresholdCrossedBy(50, 60), 0, 'mid-band does not fire');
  assert.equal(thresholdCrossedBy(1, 100), 100, 'large jump still fires nearest band');
  assert.equal(thresholdCrossedBy(0, 0), 0, 'no-op returns 0');
});

test('W215 #3 - setThresholdState idempotent storage', async () => {
  const { setThresholdState, getThresholdState, _resetThresholdState } = await import('../src/notifications.js');
  const t = 'tenant_w215_3_' + Date.now();
  const ns = 'ns_test';
  _resetThresholdState(t, ns);
  const s1 = setThresholdState(t, ns, 100);
  const s2 = setThresholdState(t, ns, 100);
  assert.equal(s1.last_threshold_fired, 100);
  assert.equal(s2.last_threshold_fired, 100);
  const after = getThresholdState(t, ns);
  assert.equal(after.last_threshold_fired, 100);
  _resetThresholdState(t, ns);
});

test('W215 #4 - fireThresholdAlert opt-out default is opted_out', async () => {
  const { fireThresholdAlert } = await import('../src/notifications.js');
  const t = 'tenant_w215_4_' + Date.now();
  const r = await fireThresholdAlert({ tenant: t, namespace: 'default', count: 100, threshold: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'opted_out');
});

test('W215 #5 - fireThresholdAlert opt-in returns push counters even with zero subs', async () => {
  const { fireThresholdAlert, setPreferences } = await import('../src/notifications.js');
  const t = 'tenant_w215_5_' + Date.now();
  setPreferences(t, { threshold_alerts: true });
  const r = await fireThresholdAlert({ tenant: t, namespace: 'default', count: 100, threshold: 100 });
  assert.equal(r.ok, true);
  assert.ok(r.push, 'push counters present');
  assert.equal(typeof r.push.sent, 'number');
  assert.equal(typeof r.push.failed, 'number');
  assert.ok(Array.isArray(r.push.results));
});

test('W215 #6 - push subscription CRUD round-trip', async () => {
  const m = await import('../src/notifications.js');
  const t = 'tenant_w215_6_' + Date.now();
  // W253 sec#3 added SSRF guard requiring an allowlisted push-service host.
  // FCM is in PUSH_HOSTS so the CRUD round-trip works without bypassing the guard.
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc-' + Date.now(), keys: { auth: 'k1', p256dh: 'k2' } };
  m.addPushSubscription(t, sub);
  const listed = m.listPushSubscriptions(t);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].endpoint, sub.endpoint);
  m.removePushSubscription(t, sub.endpoint);
  assert.equal(m.listPushSubscriptions(t).length, 0);
});

test('W215 #7 - sendWebPush returns vapid_not_configured when env unset', async () => {
  const prevPub = process.env.VAPID_PUBLIC_KEY;
  const prevPriv = process.env.VAPID_PRIVATE_KEY;
  const prevSub = process.env.VAPID_SUBJECT;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  try {
    const { sendWebPush, vapidConfigured } = await import('../src/webpush.js');
    assert.equal(vapidConfigured(), false);
    const r = await sendWebPush({ endpoint: 'https://example.com/x' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'vapid_not_configured');
  } finally {
    if (prevPub !== undefined) process.env.VAPID_PUBLIC_KEY = prevPub;
    if (prevPriv !== undefined) process.env.VAPID_PRIVATE_KEY = prevPriv;
    if (prevSub !== undefined) process.env.VAPID_SUBJECT = prevSub;
  }
});

test('W215 #8 - buildVapidHeader produces Authorization with t= and k= when configured', async () => {
  const pair = generateVapidPairForTest();
  const prevPub = process.env.VAPID_PUBLIC_KEY;
  const prevPriv = process.env.VAPID_PRIVATE_KEY;
  const prevSub = process.env.VAPID_SUBJECT;
  process.env.VAPID_PUBLIC_KEY = pair.vapidPublic;
  process.env.VAPID_PRIVATE_KEY = pair.vapidPrivate;
  process.env.VAPID_SUBJECT = 'mailto:test@kolm.ai';
  try {
    const { buildVapidHeader, vapidConfigured } = await import('../src/webpush.js');
    assert.equal(vapidConfigured(), true);
    const h = buildVapidHeader('https://fcm.googleapis.com/fcm/send/abc');
    assert.ok(h.Authorization, 'Authorization header present');
    assert.match(h.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/, 'vapid t=JWT, k=key format');
  } finally {
    if (prevPub !== undefined) process.env.VAPID_PUBLIC_KEY = prevPub; else delete process.env.VAPID_PUBLIC_KEY;
    if (prevPriv !== undefined) process.env.VAPID_PRIVATE_KEY = prevPriv; else delete process.env.VAPID_PRIVATE_KEY;
    if (prevSub !== undefined) process.env.VAPID_SUBJECT = prevSub; else delete process.env.VAPID_SUBJECT;
  }
});

test('W215 #9 - router.js imports notifications module and wires threshold check into recordCapture', () => {
  assert.match(ROUTER_SRC, /from\s+['"]\.\/notifications\.js['"]/, 'notifications import');
  assert.match(ROUTER_SRC, /thresholdCrossedBy/, 'thresholdCrossedBy referenced');
  assert.match(ROUTER_SRC, /fireThresholdAlert/, 'fireThresholdAlert referenced');
  assert.match(ROUTER_SRC, /setThresholdState/, 'setThresholdState referenced');
  // crossing check happens inside the recordCapture handler (after publishCapture).
  const recIdx = ROUTER_SRC.indexOf('async function recordCapture');
  assert.ok(recIdx > 0, 'recordCapture defined');
  const recBody = ROUTER_SRC.slice(recIdx, recIdx + 6000);
  assert.match(recBody, /thresholdCrossedBy/, 'threshold check inside recordCapture');
  assert.match(recBody, /publishCapture/, 'publishCapture invoked alongside threshold check');
});

test('W215 #10 - capture handlers set x-kolm-distill-ready on threshold cross', () => {
  // Both anthropic + openai handlers exist and BOTH set the distill-ready header.
  assert.ok(ROUTER_SRC.includes("r.post(/^\\/v1\\/capture\\/anthropic"), 'anthropic capture handler present');
  assert.ok(ROUTER_SRC.includes("r.post(/^\\/v1\\/capture\\/openai"), 'openai capture handler present');
  // x-kolm-distill-ready header appears (set in capture handlers AND batch log).
  assert.match(ROUTER_SRC, /x-kolm-distill-ready/, 'x-kolm-distill-ready header set');
  assert.match(ROUTER_SRC, /isDistillReady/, 'isDistillReady consulted for sticky header');
  assert.match(ROUTER_SRC, /x-kolm-distill-threshold/, 'x-kolm-distill-threshold emitted on the crossing capture');
  // Distill-ready logic appears in at least 3 places (anthropic + openai + batch /v1/capture/log).
  const occurrences = (ROUTER_SRC.match(/x-kolm-distill-ready/g) || []).length;
  assert.ok(occurrences >= 3, `expected x-kolm-distill-ready in >=3 sites, found ${occurrences}`);
});

test('W215 #11 - six /v1/notifications/* routes with correct auth gating', () => {
  // Public config route - ungated.
  assert.match(ROUTER_SRC, /r\.get\(['"]\/v1\/notifications\/config['"]\s*,\s*\(req,\s*res\)\s*=>/);
  // Auth-gated routes.
  const authRoutes = [
    ['get', '/v1/notifications/preferences'],
    ['put', '/v1/notifications/preferences'],
    ['get', '/v1/notifications/push-subscriptions'],
    ['post', '/v1/notifications/push-subscriptions'],
    ['delete', '/v1/notifications/push-subscriptions'],
    ['post', '/v1/notifications/test'],
  ];
  for (const [verb, p] of authRoutes) {
    const re = new RegExp(`r\\.${verb}\\(['"]${p.replace(/\//g, '\\/')}['"]\\s*,\\s*authMiddleware`);
    assert.match(ROUTER_SRC, re, `${verb.toUpperCase()} ${p} must be authMiddleware-gated`);
  }
});

test('W215 #12 - publicConfig() shape', async () => {
  const { publicConfig } = await import('../src/notifications.js');
  const c = publicConfig();
  assert.ok('vapid_public_key' in c, 'has vapid_public_key field (null when unset)');
  assert.ok('webpush_configured' in c);
  assert.ok('email_configured' in c);
  assert.deepEqual(c.thresholds, [100, 500, 1000]);
});

test('W215 #13 - public/settings.html notifications surface', () => {
  // References notification routes via fetch + has subscribe button.
  assert.match(SETTINGS_HTML, /\/v1\/notifications\/config/);
  assert.match(SETTINGS_HTML, /\/v1\/notifications\/preferences/);
  assert.match(SETTINGS_HTML, /\/v1\/notifications\/push-subscriptions/);
  assert.match(SETTINGS_HTML, /\/v1\/notifications\/test/);
  assert.match(SETTINGS_HTML, /pushManager\.subscribe/);
  assert.match(SETTINGS_HTML, /applicationServerKey/);
  // Opt-in toggle present.
  assert.match(SETTINGS_HTML, /id="prefs-threshold-alerts"/);
});

test('W215 #14 - sw.js push handler + CACHE bump', () => {
  assert.match(SW_JS, /addEventListener\(['"]push['"]/, 'push event handler registered');
  assert.match(SW_JS, /showNotification/, 'showNotification invoked');
  assert.match(SW_JS, /notificationclick/, 'click handler routes to /captures');
  // CACHE slug bumped to wave215.
  const m = SW_JS.match(/const\s+CACHE\s*=\s*'kolm-v7-2026-05-\d+-wave(\d+)/);
  assert.ok(m, 'CACHE slug present');
  assert.ok(parseInt(m[1], 10) >= 215, 'CACHE wave >= 215');
});

test('W215 #15 - vercel.json rewrites /settings', () => {
  const parsed = JSON.parse(VERCEL_JSON);
  const r = (parsed.rewrites || []).find((x) => x.source === '/settings');
  assert.ok(r, '/settings rewrite present');
  assert.equal(r.destination, '/settings.html');
});

test('W215 #16 - rawPrivateToPkcs8 emits prime256v1 OID (1.2.840.10045.3.1.7)', () => {
  // The PKCS#8 envelope must use the prime256v1 OID. The historical
  // commentary remnant about secp384 is gone from the source.
  assert.ok(WEBPUSH_SRC.indexOf('secp384') === -1, 'no stray secp384 commentary');
  // prime256v1 OID encoded bytes appear at least once.
  assert.match(WEBPUSH_SRC, /0x2a,\s*0x86,\s*0x48,\s*0xce,\s*0x3d,\s*0x03,\s*0x01,\s*0x07/);
});

test('W215 #17 - notifications module exports the full surface', async () => {
  const m = await import('../src/notifications.js');
  const expected = [
    'THRESHOLDS', 'getPreferences', 'setPreferences',
    'listPushSubscriptions', 'addPushSubscription', 'removePushSubscription',
    'getThresholdState', 'setThresholdState', '_resetThresholdState',
    'thresholdCrossedBy', 'isDistillReady', 'fireThresholdAlert', 'publicConfig',
  ];
  for (const name of expected) {
    assert.ok(name in m, `notifications.js must export ${name}`);
  }
});

test('W215 #18 - email path skipped when prefs.email unset', async () => {
  const { fireThresholdAlert, setPreferences } = await import('../src/notifications.js');
  const t = 'tenant_w215_18_' + Date.now();
  setPreferences(t, { threshold_alerts: true, email: '' });
  const r = await fireThresholdAlert({ tenant: t, namespace: 'default', count: 500, threshold: 500 });
  assert.equal(r.ok, true);
  assert.equal(r.email.skipped, true);
  assert.equal(r.email.reason, 'no_recipient');
});

test('W215 #19 - isDistillReady reflects fired state', async () => {
  const { isDistillReady, setThresholdState, _resetThresholdState } = await import('../src/notifications.js');
  const t = 'tenant_w215_19_' + Date.now();
  const ns = 'ns';
  _resetThresholdState(t, ns);
  assert.equal(isDistillReady(t, ns), false);
  setThresholdState(t, ns, 100);
  assert.equal(isDistillReady(t, ns), true);
  _resetThresholdState(t, ns);
  assert.equal(isDistillReady(t, ns), false);
});

test('W215 #20 - notifications.js wires email send through src/email.js', () => {
  assert.match(NOTIF_SRC, /from\s+['"]\.\/email\.js['"]/);
  assert.match(NOTIF_SRC, /sendMail\(/);
  // And WebPush is wired through webpush.js (not via npm web-push).
  assert.match(NOTIF_SRC, /from\s+['"]\.\/webpush\.js['"]/);
  assert.match(NOTIF_SRC, /sendWebPush\(/);
});
