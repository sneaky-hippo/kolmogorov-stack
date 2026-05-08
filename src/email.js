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
