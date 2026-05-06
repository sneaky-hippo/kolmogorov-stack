// Shared frontend helpers.
window.KS = (() => {
  const apiKey = () => localStorage.getItem('ks_api_key') || '';
  const setApiKey = (k) => { localStorage.setItem('ks_api_key', k); };

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const k = apiKey();
    if (k) headers['Authorization'] = `Bearer ${k}`;
    const res = await fetch(path, { ...opts, headers });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { _raw: text }; }
    if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body, status: res.status });
    return body;
  }

  function toast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(window.__toastT);
    window.__toastT = setTimeout(() => t.classList.remove('show'), 1400);
  }

  // Auto-mint a free demo key on first visit so the playground/dashboard
  // work immediately. No prompt(), no signup form unless the user wants one.
  async function autoMint() {
    if (apiKey()) return apiKey();
    const seed = localStorage.getItem('ks_browser_id') || (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    localStorage.setItem('ks_browser_id', seed);
    const r = await fetch('/v1/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `anon-${seed.slice(0,8)}@playground.kolmogorov.dev`, name: `playground-${seed.slice(0,6)}` }),
    }).then(r => r.ok ? r.json() : Promise.reject(r));
    setApiKey(r.api_key);
    return r.api_key;
  }

  // Drop-in replacement: returns a promise (callers should await), but
  // synchronously returns the key if already present.
  async function ensureKey() {
    return apiKey() || await autoMint();
  }

  function fmtJSON(v) { return JSON.stringify(v, null, 2); }
  function el(tag, attrs = {}, kids = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const kid of kids) e.append(kid?.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }

  // Render a discreet banner showing the key is auto-minted. User can rotate or paste their own.
  async function showKeyBanner(rootSelector = 'main.main') {
    const root = document.querySelector(rootSelector);
    if (!root || document.getElementById('ks-key-banner')) return;
    const k = await ensureKey();
    const banner = document.createElement('div');
    banner.id = 'ks-key-banner';
    banner.className = 'card';
    banner.style.cssText = 'margin-bottom:18px;padding:10px 14px;display:flex;align-items:center;gap:12px;font-size:12.5px;';
    banner.innerHTML = `<span class="pill good">DEMO KEY</span><span class="mono faint" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${k}">${k}</span><a href="/signup" style="color:var(--accent);text-decoration:none;">Get your own →</a>`;
    root.insertBefore(banner, root.firstChild);
  }

  return { api, toast, ensureKey, apiKey, setApiKey, autoMint, showKeyBanner, fmtJSON, el };
})();
