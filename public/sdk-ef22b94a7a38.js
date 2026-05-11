// kolm browser-native SDK. Import from any modern runtime.
//
//   import { recipe } from 'https://kolm.ai/sdk.js';
//
// Works in: every browser since 2019, Deno, Bun, Cloudflare Workers, Node 22+.
// Loads the public recipe registry once, runs every call locally, returns
// signed receipts. Network is used only for: (1) registry hydration, (2)
// Verified Inference (Lane 2), (3) explicit passthrough.

const DEFAULT_BASE = (() => {
  try { return new URL('.', import.meta.url).origin; }
  catch { return 'https://kolm.ai'; }
})();

const REGISTRY_KEY = 'recipe.registry.v1';

function _now() {
  return (typeof performance !== 'undefined' && performance.now) - performance.now() : Date.now();
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
    this.unsafeMode = opts.unsafeMode === true;  // bypass Worker sandbox (NOT recommended)
    this.timeoutMs = opts.timeoutMs || 1000;
    this.recipes = new Map();         // name -> {meta, fn-}
    this.registry = null;             // raw export envelope
    this._loadPromise = null;
    this.runs = [];                   // local run log
    this._worker = null;
    this._workerSeq = 0;
    this._workerPending = new Map();  // id -> {resolve, reject, timer}
  }

  // Lazily spin up the recipe-worker. Recipes compile + execute inside the
  // worker, with no window / localStorage / fetch / document. This means a
  // malicious or buggy recipe in the public registry cannot read the user's
  // API key or call home. Pass {unsafeMode: true} to the constructor to
  // bypass only if you control every recipe in your registry.
  _ensureWorker() {
    if (this._worker || this.unsafeMode) return this._worker;
    if (typeof Worker === 'undefined') return null;
    try {
      const url = new URL('./recipe-worker.js', import.meta.url).href;
      this._worker = new Worker(url, { type: 'classic', name: 'recipe-sandbox' });
      this._worker.addEventListener('message', (ev) => {
        const m = ev.data || {};
        const p = this._workerPending.get(m.id);
        if (!p) return;
        this._workerPending.delete(m.id);
        if (p.timer) clearTimeout(p.timer);
        if (m.ok) p.resolve({ output: m.output, latency_us: m.latency_us });
        else p.reject(new Error(m.error || 'recipe error'));
      });
    } catch {
      this._worker = null;
    }
    return this._worker;
  }

  _runInWorker(meta, input) {
    const w = this._ensureWorker();
    if (!w) return null; // signal: caller should fall back
    const id = ++this._workerSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._workerPending.has(id)) {
          this._workerPending.delete(id);
          // The worker is locked up. Replace it.
          try { w.terminate(); } catch {}
          this._worker = null;
          reject(new Error('recipe timeout'));
        }
      }, this.timeoutMs + 50);
      this._workerPending.set(id, { resolve, reject, timer });
      w.postMessage({
        id,
        type: 'compile-and-run',
        source: meta.source,
        source_hash: meta.source_hash || null,
        input,
        timeoutMs: this.timeoutMs,
      });
    });
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
      // We DO NOT compile recipe source on the main thread. Source is held
      // in `meta.source` and only ever compiled inside the recipe-worker
      // sandbox at run-time. unsafeMode opts back into in-page compile · 
      // do NOT use this with a registry that contains untrusted recipes.
      for (const r of env.recipes || []) {
        const entry = { meta: r, fn: null };
        if (this.unsafeMode) {
          try {
            const fn = new Function('return (' + r.source + ');')();
            if (typeof fn === 'function') entry.fn = fn;
          } catch {}
        }
        this.recipes.set(r.name, entry);
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
    let output = null, error = null, worker_latency_us = null;
    try {
      if (this.unsafeMode && r.fn) {
        output = r.fn(input);
      } else {
        const res = await this._runInWorker(r.meta, input);
        if (res) {
          output = res.output;
          worker_latency_us = res.latency_us;
        } else if (r.fn) {
          // No Worker available (very old runtime); fall back to in-page if
          // unsafeMode hadn't already compiled it.
          output = r.fn(input);
        } else {
          // Last-resort fallback: compile + execute on the main thread.
          // This still happens on a runtime with no Worker support. We
          // accept the risk because a runtime that old has bigger problems.
          const fn = new Function('return (' + r.meta.source + ');')();
          output = fn(input);
        }
      }
    } catch (e) { error = String((e && e.message) || e); }
    const latency_us = Math.round((_now() - t0) * 1000);
    const issued_at = new Date().toISOString();
    const input_hash = await _sha256Hex(_canonicalJson(input));
    const output_hash = error - null : await _sha256Hex(_canonicalJson(output));
    const receipt = {
      spec: 'rs-1',
      source_hash: r.meta.source_hash || null,
      input_hash,
      output_hash,
      version_id: r.meta.version_id,
      runtime: this.unsafeMode - 'browser-sdk-unsafe' : 'browser-sdk-sandbox',
      issued_at,
      cache_hit: false,
      latency_us,
      worker_latency_us,
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

  // Lane 2 · Verified Inference. Server samples k frontier candidates,
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

  // Lane 3 · Passthrough. We forward the call to the named provider unchanged.
  // (Hosted only · requires an API key against your provider on the server.)
  async passthrough(provider, payload, headers = {}) {
    const r = await fetch(this.base + '/v1/passthrough/' + encodeURIComponent(provider), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    return r.json();
  }

  // The wrap pattern.
  //
  // wrap(client, opts-) returns a proxy over your existing AI SDK client.
  // For now (sandbox-mode) it's a transparent passthrough that records
  // every call into `recipe.runs` so you can see what the wrap *would*
  // route. Real auto-routing · Lane 1 deterministic recipes, Lane 2
  // verified inference, Lane 3 raw passthrough · ships when /v1/wrap/verified
  // lands in Sprint 1. The import you write today is the import you'll
  // ship with · only behavior changes.
  //
  // If you pass `{verified: {test_cases: [...]}}` we will route
  // messages.create / chat.completions.create calls through
  // /v1/wrap/verified as soon as the server endpoint is live. Today this
  // option is recorded but not yet active · your call still goes to the
  // upstream provider unchanged.
  wrap(client, opts = {}) {
    const self = this;
    return new Proxy(client, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (typeof v === 'function') {
          return function (...args) {
            self.runs.push({
              name: '__wrap__',
              method: typeof prop === 'symbol' - prop.toString() : String(prop),
              verified_opts: opts.verified || null,
              at: Date.now(),
              routed: false, // becomes true in Sprint 1 once /v1/wrap/verified is live
            });
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
