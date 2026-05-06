// @kolmogorov/recipe — ES module entry point.
// Show 4-8 examples once. Get a deterministic JS function that runs forever for free.

const DEFAULT_BASE = "https://kolmogorov-stack-production.up.railway.app";
const SDK_VERSION = "0.1.0";

export class RecipeError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "RecipeError";
    this.status = status;
    this.body = body;
  }
}

export class RecipeClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || (typeof process !== "undefined" && process.env && process.env.RECIPE_BASE_URL) || DEFAULT_BASE).replace(/\/$/, "");
    this.apiKey = opts.apiKey
      || (typeof process !== "undefined" && process.env && (process.env.RECIPE_API_KEY || process.env.KOLMOGOROV_API_KEY));
    this.fetcher = opts.fetch || globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    if (!this.fetcher) throw new Error("fetch is not available — pass opts.fetch or run on Node 18+ / a modern browser.");
  }

  async _req(method, path, body, init = {}) {
    const url = this.baseUrl + path;
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": `@kolmogorov/recipe/${SDK_VERSION}`,
      ...(init.headers || {}),
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetcher(url, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        ...init,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    if (!res.ok) {
      const msg = (json && typeof json === "object" && typeof json.error === "string")
        ? json.error
        : `HTTP ${res.status} ${res.statusText}`;
      throw new RecipeError(msg, res.status, json);
    }
    return json;
  }

  // ---------- core (Layer 1) ----------
  synthesize(req)               { return this._req("POST", "/v1/synthesize", req); }
  synthesizeBatch(items)        { return this._req("POST", "/v1/synthesize/batch", { items }); }
  verify(source, examples)      { return this._req("POST", "/v1/verify", { source, positives: examples }); }
  run({ recipe_id, concept_id, version_id, input }) {
    const body = { input };
    if (recipe_id) body.concept_id = recipe_id;
    if (concept_id) body.concept_id = concept_id;
    if (version_id) body.version_id = version_id;
    return this._req("POST", "/v1/run", body);
  }

  // ---------- registry ----------
  list({ tag, q, limit } = {}) {
    const p = new URLSearchParams();
    if (tag) p.set("tag", tag);
    if (q) p.set("q", q);
    if (limit != null) p.set("limit", String(limit));
    const qs = p.toString() ? `?${p}` : "";
    return this._req("GET", `/v1/recipes${qs}`);
  }
  get(recipe_id)              { return this._req("GET", `/v1/recipes/${encodeURIComponent(recipe_id)}`); }
  stats(recipe_id)            { return this._req("GET", `/v1/recipes/${encodeURIComponent(recipe_id)}/stats`); }
  search(query, k = 5)        { return this._req("POST", "/v1/search", { query, k }); }
  compose(opts)               { return this._req("POST", "/v1/compose", opts); }

  // ---------- forward-looking (Phases C/D/E) ----------
  labelCorpus(recipe_id, opts = {}) {
    let corpus;
    if (opts.rows) corpus = { type: "inline", rows: opts.rows };
    else if (opts.hf_dataset) corpus = { type: "huggingface", name: opts.hf_dataset };
    else if (opts.url) corpus = { type: "url", url: opts.url };
    else throw new RecipeError("provide rows, hf_dataset, or url", 400, null);
    return this._req("POST", `/v1/recipes/${encodeURIComponent(recipe_id)}/label-corpus`, {
      corpus, max_rows: opts.max_rows, output_format: opts.output_format,
    });
  }
  job(id)                                     { return this._req("GET", `/v1/jobs/${encodeURIComponent(id)}`); }
  waitlistSpecialist(email, task)             { return this._req("POST", "/v1/specialists/waitlist", { email, task }); }
  trainSpecialist(req)                        { return this._req("POST", "/v1/specialists/train", req); }
  listSpecialists()                           { return this._req("GET", "/v1/specialists"); }
  getSpecialist(id)                           { return this._req("GET", `/v1/specialists/${encodeURIComponent(id)}`); }
  runSpecialist(id, input)                    { return this._req("POST", `/v1/specialists/${encodeURIComponent(id)}/run`, { input }); }

  // ---------- public + account ----------
  featured()                                  { return this._req("GET", "/v1/public/featured"); }
  publicConcepts()                            { return this._req("GET", "/v1/public/concepts"); }
  publicRun({ concept_id, version_id, input }) {
    return this._req("POST", "/v1/public/run", { concept_id, version_id, input });
  }
  account()                                   { return this._req("GET", "/v1/account"); }
  rotateKey()                                 { return this._req("POST", "/v1/account/rotate-key"); }
  signup(email, name)                         { return this._req("POST", "/v1/signup", { email, name }); }
  health()                                    { return this._req("GET", "/health"); }

  // ---------- anonymous CLI auth (autonomous bootstrap for agents/robots) ----------
  // No email, no signup — agents call this on first run, store the kao_ token locally,
  // and have 30 days of full functionality before they have to claim or expire.
  bootstrapAnonymous(meta = {}) {
    return this._req("POST", "/v1/anon/bootstrap", {
      user_agent: meta.user_agent || `@kolmogorov/recipe/${SDK_VERSION}`,
      hostname: meta.hostname || null,
    });
  }
  // Convert an anonymous workspace to a real account. Body takes anon_token + email.
  // Returns {mode: 'merged'|'upgraded', api_key, tenant}.
  claimAnonymous(anon_token, email, name) {
    return this._req("POST", "/v1/anon/claim", { anon_token, email, name });
  }
}

// ---------- Convenience: drop-in replacements for repeat LLM-as-judge calls ----------
let _defaultClient = null;
function _client() {
  if (!_defaultClient) _defaultClient = new RecipeClient();
  return _defaultClient;
}

async function _runByName(name, input) {
  const c = _client();
  const { featured } = await c.featured();
  const found = featured.find(r => r.name === name);
  if (!found) throw new RecipeError(`recipe "${name}" not in public registry yet`, 404, null);
  const r = await c.run({ recipe_id: found.id, input });
  return r.output;
}

export const recipe = {
  isSpam:           (text) => _runByName("is-spam", text),
  classifyIntent:   (text) => _runByName("classify-intent", text),
  detectLanguage:   (text) => _runByName("classify-language", text),
  sentiment:        (text) => _runByName("sentiment", text),
  isQuestion:       (text) => _runByName("is-question", text),
  classifyToxicity: (text) => _runByName("classify-toxicity", text),
  extractEmails:    (text) => _runByName("extract-emails", text),
  classifyIssue:    (text) => _runByName("classify-issue-type", text),
};

export default RecipeClient;
