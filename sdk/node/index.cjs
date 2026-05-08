// CommonJS entry - same surface as index.mjs.
'use strict';

const DEFAULT_BASE = "https://kolm.ai";
const SDK_VERSION = "0.1.0";

class RecipeError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "RecipeError";
    this.status = status;
    this.body = body;
  }
}

class RecipeClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || (typeof process !== "undefined" && process.env && (process.env.KOLM_BASE_URL || process.env.RECIPE_BASE_URL)) || DEFAULT_BASE).replace(/\/$/, "");
    this.apiKey = opts.apiKey
      || (typeof process !== "undefined" && process.env && (process.env.KOLM_API_KEY || process.env.RECIPE_API_KEY || process.env.KOLMOGOROV_API_KEY));
    this.fetcher = opts.fetch || globalThis.fetch;
    this.timeoutMs = opts.timeoutMs == null ? 30000 : opts.timeoutMs;
    if (!this.fetcher) throw new Error("fetch is not available; pass opts.fetch or run on Node 18+ / a modern browser.");
  }

  async _req(method, path, body, init = {}) {
    const url = this.baseUrl + path;
    const headers = Object.assign({
      "Content-Type": "application/json",
      "User-Agent": `@kolmogorov/kolm-sdk/${SDK_VERSION}`,
    }, init.headers || {});
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetcher(url, Object.assign({
        method, headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      }, init));
    } finally { clearTimeout(timer); }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    if (!res.ok) {
      const msg = (json && typeof json === "object" && typeof json.error === "string")
        ? json.error : `HTTP ${res.status} ${res.statusText}`;
      throw new RecipeError(msg, res.status, json);
    }
    return json;
  }

  synthesize(req)               { return this._req("POST", "/v1/synthesize", req); }
  synthesizeBatch(items)        { return this._req("POST", "/v1/synthesize/batch", { items }); }
  verify(source, examples)      { return this._req("POST", "/v1/verify", { source, positives: examples }); }
  run(o) {
    const body = { input: o.input };
    if (o.recipe_id) body.concept_id = o.recipe_id;
    if (o.concept_id) body.concept_id = o.concept_id;
    if (o.version_id) body.version_id = o.version_id;
    return this._req("POST", "/v1/run", body);
  }

  list(opts = {}) {
    const p = new URLSearchParams();
    if (opts.tag) p.set("tag", opts.tag);
    if (opts.q) p.set("q", opts.q);
    if (opts.limit != null) p.set("limit", String(opts.limit));
    const qs = p.toString() ? `?${p}` : "";
    return this._req("GET", `/v1/recipes${qs}`);
  }
  get(id)             { return this._req("GET", `/v1/recipes/${encodeURIComponent(id)}`); }
  stats(id)           { return this._req("GET", `/v1/recipes/${encodeURIComponent(id)}/stats`); }
  search(query, k = 5){ return this._req("POST", "/v1/search", { query, k }); }
  compose(opts)       { return this._req("POST", "/v1/compose", opts); }

  labelCorpus(id, opts = {}) {
    let corpus;
    if (opts.rows) corpus = { type: "inline", rows: opts.rows };
    else if (opts.hf_dataset) corpus = { type: "huggingface", name: opts.hf_dataset };
    else if (opts.url) corpus = { type: "url", url: opts.url };
    else throw new RecipeError("provide rows, hf_dataset, or url", 400, null);
    return this._req("POST", `/v1/recipes/${encodeURIComponent(id)}/label-corpus`, {
      corpus, max_rows: opts.max_rows, output_format: opts.output_format,
    });
  }
  job(id)                      { return this._req("GET", `/v1/jobs/${encodeURIComponent(id)}`); }
  waitlistSpecialist(email, task) { return this._req("POST", "/v1/specialists/waitlist", { email, task }); }
  trainSpecialist(req)         { return this._req("POST", "/v1/specialists/train", req); }
  listSpecialists()            { return this._req("GET", "/v1/specialists"); }
  getSpecialist(id)            { return this._req("GET", `/v1/specialists/${encodeURIComponent(id)}`); }
  runSpecialist(id, input)     { return this._req("POST", `/v1/specialists/${encodeURIComponent(id)}/run`, { input }); }

  featured()                   { return this._req("GET", "/v1/public/featured"); }
  publicConcepts()             { return this._req("GET", "/v1/public/concepts"); }
  publicRun(o)                 { return this._req("POST", "/v1/public/run", o); }
  account()                    { return this._req("GET", "/v1/account"); }
  rotateKey()                  { return this._req("POST", "/v1/account/rotate-key"); }
  signup(email, name)          { return this._req("POST", "/v1/signup", { email, name }); }
  health()                     { return this._req("GET", "/health"); }
  bootstrapAnonymous(meta)     { return this._req("POST", "/v1/anon/bootstrap", { user_agent: (meta && meta.user_agent) || `@kolmogorov/kolm-sdk/${SDK_VERSION}`, hostname: (meta && meta.hostname) || null }); }
  claimAnonymous(anon_token, email, name) { return this._req("POST", "/v1/anon/claim", { anon_token, email, name }); }
}

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
const recipe = {
  isSpam:           (t) => _runByName("is-spam", t),
  classifyIntent:   (t) => _runByName("classify-intent", t),
  detectLanguage:   (t) => _runByName("classify-language", t),
  sentiment:        (t) => _runByName("sentiment", t),
  isQuestion:       (t) => _runByName("is-question", t),
  classifyToxicity: (t) => _runByName("classify-toxicity", t),
  extractEmails:    (t) => _runByName("extract-emails", t),
  classifyIssue:    (t) => _runByName("classify-issue-type", t),
};

class KolmClient extends RecipeClient {}

module.exports = KolmClient;
module.exports.default = KolmClient;
module.exports.KolmClient = KolmClient;
module.exports.RecipeClient = RecipeClient;
module.exports.RecipeError = RecipeError;
module.exports.recipe = recipe;
