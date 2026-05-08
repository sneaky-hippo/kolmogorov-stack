// OAuth (Google + GitHub) without the SDK dependency. Each provider has the
// same shape: redirect to provider with state cookie, receive code on callback,
// exchange code for access_token, fetch /userinfo, find-or-create the tenant,
// drop a kolm_session cookie, redirect back to the originally requested page.
//
// Configuration (set on Railway):
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
//   GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET
//   OAUTH_REDIRECT_BASE = https://kolm.ai
//
// Provider redirect URIs to configure in Google/GitHub developer consoles:
//   https://kolm.ai/v1/oauth/google/callback
//   https://kolm.ai/v1/oauth/github/callback

import crypto from 'node:crypto';
import { findOrCreateTenantByEmail } from './auth.js';
import { isProductionRuntime } from './env.js';

const STATE_COOKIE = 'kolm_oauth_state';
const RETURN_COOKIE = 'kolm_oauth_return';

function baseUrl() {
  return process.env.OAUTH_REDIRECT_BASE || 'https://kolm.ai';
}

function safeReturn(req) {
  const r = (req.query && req.query.redirect) || '/dashboard';
  if (typeof r !== 'string') return '/dashboard';
  if (!r.startsWith('/') || r.startsWith('//')) return '/dashboard';
  return r;
}

function setCookie(res, name, value, maxAgeMs) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: isProductionRuntime(),
    sameSite: 'lax',
    maxAge: maxAgeMs,
    path: '/',
  });
}

function clearCookie(res, name) {
  res.clearCookie(name, { path: '/' });
}

function setSessionCookie(res, apiKey) {
  res.cookie('kolm_session', apiKey, {
    httpOnly: true,
    secure: isProductionRuntime(),
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scope: 'openid email profile',
    clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
    extractEmail: (u) => u.email,
    extractName: (u) => u.name || (u.email && u.email.split('@')[0]),
  },
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    emailUrl: 'https://api.github.com/user/emails',
    scope: 'read:user user:email',
    clientIdEnv: 'GITHUB_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GITHUB_OAUTH_CLIENT_SECRET',
    extractEmail: (u) => u.email,
    extractName: (u) => u.name || u.login,
  },
};

export function oauthConfigured(providerName) {
  const p = PROVIDERS[providerName];
  if (!p) return false;
  return !!(process.env[p.clientIdEnv] && process.env[p.clientSecretEnv]);
}

export function mountOAuth(router) {
  router.get('/v1/oauth/:provider/start', (req, res) => {
    const name = req.params.provider;
    const p = PROVIDERS[name];
    if (!p) return res.status(404).json({ error: 'unknown provider' });
    if (!oauthConfigured(name)) {
      return res.status(503).json({ error: 'oauth_not_configured', provider: name, hint: `set ${p.clientIdEnv} and ${p.clientSecretEnv} on the server` });
    }
    const state = crypto.randomBytes(24).toString('hex');
    const ret = safeReturn(req);
    setCookie(res, STATE_COOKIE, state, 10 * 60 * 1000);
    setCookie(res, RETURN_COOKIE, ret, 10 * 60 * 1000);
    const u = new URL(p.authUrl);
    u.searchParams.set('client_id', process.env[p.clientIdEnv]);
    u.searchParams.set('redirect_uri', `${baseUrl()}/v1/oauth/${name}/callback`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', p.scope);
    u.searchParams.set('state', state);
    if (name === 'google') {
      u.searchParams.set('access_type', 'online');
      u.searchParams.set('prompt', 'select_account');
    }
    res.redirect(302, u.toString());
  });

  router.get('/v1/oauth/:provider/callback', async (req, res) => {
    const name = req.params.provider;
    const p = PROVIDERS[name];
    if (!p) return res.status(404).type('text/plain').send('unknown provider');
    if (!oauthConfigured(name)) return res.status(503).type('text/plain').send('oauth not configured');

    const { code, state, error: providerError } = req.query || {};
    const cookieState = req.cookies && req.cookies[STATE_COOKIE];
    const ret = (req.cookies && req.cookies[RETURN_COOKIE]) || '/dashboard';
    clearCookie(res, STATE_COOKIE);
    clearCookie(res, RETURN_COOKIE);

    if (providerError) {
      return res.redirect(302, `/signup?oauth_error=${encodeURIComponent(String(providerError))}`);
    }
    if (!code || !state || !cookieState || state !== cookieState) {
      return res.redirect(302, '/signup?oauth_error=state_mismatch');
    }

    try {
      const tokenBody = new URLSearchParams({
        client_id: process.env[p.clientIdEnv],
        client_secret: process.env[p.clientSecretEnv],
        code: String(code),
        redirect_uri: `${baseUrl()}/v1/oauth/${name}/callback`,
        grant_type: 'authorization_code',
      });
      const tokenRes = await fetch(p.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: tokenBody.toString(),
      });
      const tokenJson = await tokenRes.json().catch(() => ({}));
      const accessToken = tokenJson.access_token;
      if (!accessToken) {
        return res.redirect(302, `/signup?oauth_error=token_exchange_failed`);
      }

      const userRes = await fetch(p.userUrl, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'kolm-oauth' },
      });
      const userJson = await userRes.json().catch(() => ({}));
      let email = p.extractEmail(userJson);
      const displayName = p.extractName(userJson);

      // GitHub may not expose primary email on /user — fall back to /user/emails.
      if (!email && p.emailUrl) {
        const emailRes = await fetch(p.emailUrl, {
          headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'kolm-oauth' },
        });
        const emails = await emailRes.json().catch(() => []);
        const primary = Array.isArray(emails) ? emails.find(e => e.primary && e.verified) : null;
        email = primary && primary.email;
      }

      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.redirect(302, `/signup?oauth_error=no_email_returned`);
      }

      const { tenant, api_key, created } = findOrCreateTenantByEmail({
        email,
        name: displayName,
        provider: name,
        provider_id: String(userJson.id || userJson.sub || ''),
      });

      setSessionCookie(res, api_key);
      const sep = ret.includes('?') ? '&' : '?';
      const flag = created ? 'oauth=signup' : 'oauth=signin';
      return res.redirect(302, `${ret}${sep}${flag}`);
    } catch (err) {
      return res.redirect(302, `/signup?oauth_error=${encodeURIComponent(String(err && err.message || err))}`);
    }
  });

  router.get('/v1/oauth/providers', (_req, res) => {
    res.json({
      google: oauthConfigured('google'),
      github: oauthConfigured('github'),
    });
  });
}
