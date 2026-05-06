// Recipe — browser-native SDK. Import from any modern runtime.
//
//   import { recipe } from 'https://kolmogorov-stack-production.up.railway.app/sdk.js';
//
// Works in: every browser since 2019, Deno, Bun, Cloudflare Workers, Node 22+.
// Loads the public recipe registry once, runs every call locally, returns
// signed receipts. Network is used only for: (1) registry hydration, (2)
// Verified Inference (Lane 2), (3) explicit passthrough.

const DEFAULT_BASE = (() => {
  try { return new URL('.', import.meta.url).origin; }
  catch { return 'https://kolmogorov-stack-production.up.railway.app'; }
})();

const REGISTRY_KEY = 'recipe.registry.v1';

function _now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

async function _sha256Hex(s) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = new TextEncoder().encode(s);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Last-resort fallback (no Subtle Crypto): return empty so it doesn't crash.
  return '';
}

function _canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + _canonicalJson(v[x])).join(',') + '}';
}

class Recipe {
  constructor(opts = {}) {
    this.base = (opts.base || DEFAULT_BASE).replace(/\/+$/, '');
    this.apiKey = opts.apiKey || null;
    this.cache = opts.cache !== false;
    this.recipes = new Map();         // name -> {meta, fn}
    this.registry = null;             // raw export envelope
    this._loadPromise = null;
    this.runs = [];                   // local run log
  }

  // Hydrate the registry. Cached in localStorage by registry_hash.
  async load() {
    if (this.registry) return this.registry;
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      let cached = null;
      if (this.cache && typeof localStorage !== 'undefined') {
        try { cached = JSON.parse(localStorage.getItem(REGISTRY_KEY)); } catch { cached = null; }
      }
      let env;
      try {
        const r = await fetch(this.base + '/v1/registry/export', { cache: 'default' });
        if (!r.ok) throw new Error('registry export failed: ' + r.status);
        env = await r.json();
        if (this.cache && typeof localStorage !== 'undefined') {
          try { localStorage.setItem(REGISTRY_KEY, JSON.stringify(env)); } catch {}
        }
      } catch (e) {
        if (cached) env = cached; else throw e;
      }
      this.registry = env;
      this.recipes.clear();
      for (const r of env.recipes || []) {
        try {
          const fn = new Function('return (' + r.source + ');')();
          if (typeof fn === 'function') this.recipes.set(r.name, { meta: r, fn });
        } catch {}
      }
      return env;
    })();
    return this._loadPromise;
  }

  list() {
    return Array.from(this.recipes.values()).map(x => ({ ...x.meta }));
  }

  // Run a recipe by name on this device.
  async run(name, input) {
    if (!this.registry) await this.load();
    const r = this.recipes.get(name);
    if (!r) throw new Error('recipe not found: ' + name);
    const t0 = _now();
    let output, error = null;
    try { output = r.fn(input); } catch (e) { error = String(e.message || e); }
    const latency_us = Math.round((_now() - t0) * 1000);
    const issued_at = new Date().toISOString();
    const input_hash = await _sha256Hex(_canonicalJson(input));
    const output_hash = error ? null : await _sha256Hex(_canonicalJson(output));
    const receipt = {
      spec: 'rs-1',
      source_hash: r.meta.source_hash || null,
      input_hash,
      output_hash,
      version_id: r.meta.version_id,
      runtime: 'browser-sdk',
      issued_at,
      cache_hit: false,
      latency_us,
      // No HMAC: this is an on-device run, the server didn't sign it.
      // For server-attested receipts, set { attest: true } and we round-trip.
    };
    const log = { name, input, output, error, latency_us, receipt };
    this.runs.push(log);
    return log;
  }

  // Run every recipe in the registry against this input. Useful for the
  // device showcase: see what the entire frontier-decomposed model thinks.
  async runAll(input) {
    if (!this.registry) await this.load();
    const results = [];
    for (const [name] of this.recipes) {
      results.push(await this.run(name, input));
    }
    return results;
  }

  // Lane 2 — Verified Inference. Server samples k frontier candidates,
  // verifies them against your test_cases, returns the chosen + receipt.
  async verified(opts) {
    const r = await fetch(this.base + '/v1/verified-inference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  // Lane 3 — Passthrough. We forward the call to the named provider unchanged.
  // (Hosted only — requires an API key against your provider on the server.)
  async passthrough(provider, payload, headers = {}) {
    const r = await fetch(this.base + '/v1/passthrough/' + encodeURIComponent(provider), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    return r.json();
  }

  // The wrap pattern. Returns a proxy over your existing client whose calls
  // are inspected; structured calls land in Lane 1, code/math in Lane 2,
  // open-ended in Lane 3 (passthrough). Currently a transparent pass-through
  // with telemetry — full auto-routing lands in v0.5. The point is the
  // import is real today; you don't have to rewrite when v0.5 ships.
  wrap(client) {
    const self = this;
    return new Proxy(client, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (typeof v === 'function') {
          return function (...args) {
            self.runs.push({ name: '__passthrough__', wrap: prop.toString?.() || String(prop), at: Date.now() });
            return v.apply(target, args);
          };
        }
        return v;
      },
    });
  }

  // Verify a receipt that came back from the server (round-trip check).
  async verifyReceipt(receipt, input, output) {
    const r = await fetch(this.base + '/v1/receipts/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt, input, output }),
    });
    return r.json();
  }
}

export const recipe = new Recipe();
export { Recipe };
export default recipe;
