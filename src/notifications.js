// Wave 215 - threshold alerts for the capture loop.
//
// When a namespace crosses 100 / 500 / 1000 captured pairs, fire:
//   1. an x-kolm-distill-ready: true response header on subsequent capture
//      responses (so SDKs / proxies can flag the namespace immediately),
//   2. a WebPush message to every push subscription registered for the
//      tenant (best-effort; failed subs are removed),
//   3. a transactional email via src/email.js (best-effort; skipped when
//      RESEND_API_KEY is unset).
//
// State is keyed (tenant, namespace) -> last_threshold_fired so each
// threshold fires at most once per namespace per kolm install. Reset the
// per-namespace state row to re-fire (used by tests + the dashboard
// "test alert" button).
//
// Opt-in: a tenant must call setPreferences({ threshold_alerts: true })
// before any threshold fires. Default-off keeps existing tenants quiet.

import { all, insert, update, remove, findOne, find } from './store.js';
import { sendMail, emailConfigured } from './email.js';
import { sendWebPush, vapidConfigured, vapidPublicKey } from './webpush.js';

export const THRESHOLDS = [100, 500, 1000];

const PREFS_TABLE = 'notification_preferences';
const STATE_TABLE = 'notification_state';
const PUSH_TABLE = 'push_subscriptions';

export function getPreferences(tenant) {
  if (!tenant) throw new Error('tenant required');
  const row = findOne(PREFS_TABLE, (r) => r.tenant === tenant);
  return row || {
    tenant,
    threshold_alerts: false,
    email: null,
    updated_at: null,
  };
}

export function setPreferences(tenant, patch) {
  if (!tenant) throw new Error('tenant required');
  const existing = findOne(PREFS_TABLE, (r) => r.tenant === tenant);
  const next = {
    tenant,
    threshold_alerts: !!patch.threshold_alerts,
    email: typeof patch.email === 'string' ? patch.email.slice(0, 254) : (existing?.email || null),
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    update(PREFS_TABLE, (r) => r.tenant === tenant, next);
  } else {
    insert(PREFS_TABLE, next);
  }
  return next;
}

export function listPushSubscriptions(tenant) {
  return find(PUSH_TABLE, (r) => r.tenant === tenant);
}

// W253 sec#3: SSRF mitigation for /v1/notifications/push-subscriptions.
// Without this, any signed-up tenant could register an `endpoint` pointing at
// 169.254.169.254 (cloud metadata) or localhost:6379 and trigger the server to
// POST VAPID-authenticated requests there. WebPush services run on a small,
// well-known set of hostnames — allowlist them and refuse anything else.
const PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);
const PUSH_HOST_SUFFIXES = [
  '.notify.windows.com',
  '.push.apple.com',
  '.push.services.mozilla.com',
  '.googleapis.com',
];
function assertSafePushEndpoint(endpoint) {
  let u;
  try { u = new URL(endpoint); }
  catch (_) { throw new Error('subscription.endpoint must be a valid URL'); }
  if (u.protocol !== 'https:') {
    throw new Error('subscription.endpoint must be https://');
  }
  const host = u.hostname.toLowerCase();
  // Reject IPs (including v4-mapped v6, link-local, loopback, private).
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith('[') || host === 'localhost') {
    throw new Error('subscription.endpoint hostname must be a public push service');
  }
  if (PUSH_HOSTS.has(host)) return endpoint;
  if (PUSH_HOST_SUFFIXES.some((sfx) => host.endsWith(sfx))) return endpoint;
  throw new Error(`subscription.endpoint host ${host} is not an allowed push service`);
}

export function addPushSubscription(tenant, subscription) {
  if (!tenant) throw new Error('tenant required');
  if (!subscription || !subscription.endpoint) throw new Error('subscription.endpoint required');
  const endpoint = assertSafePushEndpoint(String(subscription.endpoint));
  const existing = findOne(PUSH_TABLE, (r) => r.tenant === tenant && r.endpoint === endpoint);
  const row = {
    tenant,
    endpoint,
    keys: subscription.keys || {},
    created_at: existing?.created_at || new Date().toISOString(),
    last_sent_at: existing?.last_sent_at || null,
  };
  if (existing) {
    update(PUSH_TABLE, (r) => r.tenant === tenant && r.endpoint === endpoint, row);
  } else {
    insert(PUSH_TABLE, row);
  }
  return row;
}

export function removePushSubscription(tenant, endpoint) {
  return remove(PUSH_TABLE, (r) => r.tenant === tenant && r.endpoint === endpoint);
}

export function getThresholdState(tenant, namespace) {
  return findOne(STATE_TABLE, (r) => r.tenant === tenant && r.namespace === namespace) || {
    tenant,
    namespace,
    last_threshold_fired: 0,
    fired_at: null,
  };
}

export function setThresholdState(tenant, namespace, threshold) {
  const existing = findOne(STATE_TABLE, (r) => r.tenant === tenant && r.namespace === namespace);
  const row = {
    tenant,
    namespace,
    last_threshold_fired: threshold,
    fired_at: new Date().toISOString(),
  };
  if (existing) {
    update(STATE_TABLE, (r) => r.tenant === tenant && r.namespace === namespace, row);
  } else {
    insert(STATE_TABLE, row);
  }
  return row;
}

// W253: atomic check-and-set used by recordCapture to dedupe threshold
// alerts. Returns true if this caller actually advanced the threshold (in
// which case the caller should fire alerts), false if a concurrent capture
// already advanced past `threshold` (in which case alerts were/will be
// fired by that caller). The check + write are collapsed into one
// synchronous block so two same-process await-chains cannot both pass the
// gate. Multi-process deploys still need a DB-level unique constraint;
// vercel_postgres should add a UNIQUE(tenant, namespace, threshold) index
// on the threshold_state table.
export function tryAdvanceThresholdState(tenant, namespace, threshold) {
  const existing = findOne(STATE_TABLE, (r) => r.tenant === tenant && r.namespace === namespace);
  if (existing && existing.last_threshold_fired >= threshold) return false;
  const row = {
    tenant,
    namespace,
    last_threshold_fired: threshold,
    fired_at: new Date().toISOString(),
  };
  if (existing) {
    update(STATE_TABLE, (r) => r.tenant === tenant && r.namespace === namespace, row);
  } else {
    insert(STATE_TABLE, row);
  }
  return true;
}

export function _resetThresholdState(tenant, namespace) {
  return remove(STATE_TABLE, (r) => r.tenant === tenant && r.namespace === namespace);
}

// nextThreshold(count) -> the threshold this row crosses, or 0 if none.
// Crossing means: count >= T AND prior count < T. Caller passes the count
// AFTER the capture insert.
export function thresholdCrossedBy(prevCount, newCount) {
  for (const t of THRESHOLDS) {
    if (prevCount < t && newCount >= t) return t;
  }
  return 0;
}

// True when the namespace has crossed any threshold (used to set the
// x-kolm-distill-ready response header).
export function isDistillReady(tenant, namespace) {
  const st = getThresholdState(tenant, namespace);
  return st.last_threshold_fired > 0;
}

// Fire alerts for a (tenant, namespace) crossing.
// Caller is expected to dedupe via setThresholdState BEFORE invoking. We
// don't dedupe here so tests can fire alerts at will without bumping state.
export async function fireThresholdAlert({ tenant, namespace, count, threshold, baseUrl }) {
  const prefs = getPreferences(tenant);
  if (!prefs.threshold_alerts) {
    return { ok: false, reason: 'opted_out', tenant, namespace, threshold };
  }
  const subs = listPushSubscriptions(tenant);
  const url = (baseUrl || process.env.PUBLIC_BASE || 'https://kolm.ai') + '/captures?namespace=' + encodeURIComponent(namespace);
  const title = `kolm: namespace "${namespace}" hit ${threshold} captures`;
  const body = threshold >= 1000
    ? `1,000+ captures - Specialist LoRA distill is now ready. Open /captures to promote.`
    : `${count} captures - recipe distill is now ready. Open /captures to preview.`;
  const payload = JSON.stringify({ title, body, url, tenant, namespace, threshold, count });

  const pushResults = [];
  for (const sub of subs) {
    try {
      const r = await sendWebPush(sub, payload);
      pushResults.push({ endpoint: sub.endpoint, ok: r.ok, status: r.status });
      if (r.ok) {
        update(PUSH_TABLE, (x) => x.tenant === tenant && x.endpoint === sub.endpoint, { ...sub, last_sent_at: new Date().toISOString() });
      }
      // 404 / 410 means the subscription is dead - drop it.
      if (r.status === 404 || r.status === 410) {
        removePushSubscription(tenant, sub.endpoint);
      }
    } catch (e) {
      pushResults.push({ endpoint: sub.endpoint, ok: false, error: String(e.message || e) });
    }
  }

  let emailResult = { skipped: true, reason: 'no_recipient' };
  if (prefs.email && emailConfigured()) {
    emailResult = await sendMail({
      to: prefs.email,
      subject: title,
      text: `${body}\n\n${url}\n\nManage notifications: ${url.replace('/captures', '/settings')}`,
      html: `<p>${body}</p><p><a href="${url}">Open /captures</a></p><p style="color:#888;font-size:12px">Manage notifications: <a href="${url.replace('/captures', '/settings')}">/settings</a></p>`,
      tags: [{ name: 'kolm_event', value: 'threshold_alert' }, { name: 'threshold', value: String(threshold) }],
    });
  }

  return {
    ok: true,
    tenant,
    namespace,
    threshold,
    count,
    push: { sent: pushResults.filter((r) => r.ok).length, failed: pushResults.filter((r) => !r.ok).length, results: pushResults },
    email: emailResult,
  };
}

// Public surface for /v1/notifications/preferences GET so the dashboard can
// show "WebPush configured: yes/no" + the VAPID public key the browser
// PushManager.subscribe() call needs.
export function publicConfig() {
  return {
    vapid_public_key: vapidPublicKey(),
    webpush_configured: vapidConfigured(),
    email_configured: emailConfigured(),
    thresholds: THRESHOLDS.slice(),
  };
}
