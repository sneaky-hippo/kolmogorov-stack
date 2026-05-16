// Shared frontend helpers.
window.KS = (() => {
  // wave 100 P1-3: writes go to ks_api_key only (cuts XSS exfil surface 75%);
  // reads still scan READ_FALLBACK for users who logged in pre-migration.
  // setApiKey() drains LEGACY_KEYS on every save to migrate them.
  const WRITE_KEY = 'ks_api_key';
  const READ_FALLBACK = ['kolm_api_key', 'apiKey', 'recipeApiKey', 'ks_api_key'];
  const LEGACY_KEYS = ['kolm_api_key', 'apiKey', 'recipeApiKey'];

  function apiKey() {
    try {
      for (const name of READ_FALLBACK) {
        const value = localStorage.getItem(name);
        if (value) return value;
      }
    } catch (_) {}
    return '';
  }

  function setApiKey(key) {
    if (!key) return;
    try {
      localStorage.setItem(WRITE_KEY, key);
      LEGACY_KEYS.forEach(name => localStorage.removeItem(name));
    } catch (_) {}
  }

  function clearApiKey() {
    try {
      READ_FALLBACK.forEach(name => localStorage.removeItem(name));
    } catch (_) {}
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const key = apiKey();
    if (key) {
      headers.Authorization = `Bearer ${key}`;
      headers['X-API-Key'] = key;
    }
    const res = await fetch(path, {
      ...opts,
      headers,
      credentials: opts.credentials || 'include',
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = { _raw: text };
    }
    if (!res.ok) {
      throw Object.assign(new Error(body.error || res.statusText), { body, status: res.status });
    }
    return body;
  }

  function toast(message, ms = 1800) {
    const node = document.getElementById('toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(window.__ksToastT);
    window.__ksToastT = setTimeout(() => node.classList.remove('show'), ms);
  }

  async function autoMint() {
    if (apiKey()) return apiKey();
    let seed = '';
    try {
      seed = localStorage.getItem('ks_browser_id') || '';
      if (!seed) {
        seed = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
        localStorage.setItem('ks_browser_id', seed);
      }
    } catch (_) {
      seed = Math.random().toString(36).slice(2);
    }
    const res = await fetch('/v1/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        email: `anon-${seed.slice(0, 8)}@playground.kolm.ai`,
        name: `playground-${seed.slice(0, 6)}`,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.api_key) {
      throw new Error(body.error || 'signup failed');
    }
    setApiKey(body.api_key);
    return body.api_key;
  }

  async function ensureKey() {
    return apiKey() || await autoMint();
  }

  // hydrateSession: for cookie-authed users (OAuth flow), mirror the api_key
  // from /v1/account into localStorage so legacy code paths that gate on
  // localStorage immediately see the user as signed in. Returns the api_key
  // string when authed (cookie or localStorage), '' otherwise. Safe to call
  // multiple times; no-op when localStorage already has a key.
  async function hydrateSession() {
    if (apiKey()) return apiKey();
    try {
      const res = await fetch('/v1/account', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return '';
      const body = await res.json().catch(() => ({}));
      if (body && body.api_key) {
        setApiKey(body.api_key);
        return body.api_key;
      }
    } catch (_) {}
    return '';
  }

  function fmtJSON(value) {
    return JSON.stringify(value, null, 2);
  }

  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function el(tag, attrs = {}, kids = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') node[key] = value;
      else if (value !== false && value != null) node.setAttribute(key, value);
    }
    for (const kid of kids) {
      node.append(kid && kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  async function showKeyBanner(rootSelector = 'main.main') {
    const root = document.querySelector(rootSelector);
    if (!root || document.getElementById('ks-key-banner')) return;
    const key = await ensureKey();
    const banner = document.createElement('div');
    banner.id = 'ks-key-banner';
    banner.className = 'card';
    banner.style.cssText = 'margin-bottom:18px;padding:10px 14px;display:flex;align-items:center;gap:12px;font-size:12.5px;';

    const pill = document.createElement('span');
    pill.className = 'pill good';
    pill.textContent = 'DEMO KEY';

    const keyEl = document.createElement('span');
    keyEl.className = 'mono faint';
    keyEl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    keyEl.title = key;
    keyEl.textContent = key;

    const link = document.createElement('a');
    link.href = '/signup';
    link.style.cssText = 'color:var(--accent);text-decoration:none;';
    link.textContent = 'Get your own';

    banner.append(pill, keyEl, link);
    root.insertBefore(banner, root.firstChild);
  }

  return {
    api,
    toast,
    ensureKey,
    hydrateSession,
    apiKey,
    setApiKey,
    clearApiKey,
    autoMint,
    showKeyBanner,
    fmtJSON,
    el,
  };
})();
