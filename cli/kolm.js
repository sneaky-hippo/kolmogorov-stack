#!/usr/bin/env node
// kolm - the private AI compiler.
//
// One CLI. Eight verbs. Compiles, runs, evals, scores, and serves
// .kolm artifacts so frontier agents quietly call them via MCP.
//
//   kolm login                          auth -> ~/.kolm/config.json
//   kolm compile "<task>" [--data dir]  cloud compile -> download .kolm
//   kolm run <art.kolm> '<input-json>'  local artifact runner
//   kolm eval <art.kolm>                re-run embedded evals, recompute K-score
//   kolm benchmark <art.kolm>           emit reproducible artifact benchmark JSON
//   kolm score <art.kolm>               show K-score
//   kolm inspect <art.kolm>             manifest + recipes + signature
//   kolm serve [--mcp] [--http]         expose ~/.kolm/artifacts/* as MCP tools
//   kolm publish <art.kolm>             public gallery stub
//
// The whole point: humans run `kolm compile`; frontier models discover the
// result via `kolm serve --mcp` and call it without being asked.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import http from 'node:http';

const VERSION = '0.1.0';
const HOME = os.homedir();
const KOLM_DIR = path.join(HOME, '.kolm');
const CONFIG_PATH = path.join(KOLM_DIR, 'config.json');
const ARTIFACTS_DIR = path.join(KOLM_DIR, 'artifacts');

function ensureDir() {
  fs.mkdirSync(KOLM_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function loadConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_PATH)) return { base: process.env.KOLM_BASE || 'https://kolm.ai', api_key: process.env.KOLM_API_KEY || null };
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}
function saveConfig(c) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
}

function authHeaders(c) {
  return c.api_key ? { 'Authorization': 'Bearer ' + c.api_key } : {};
}

async function api(c, method, path_, body) {
  const url = c.base.replace(/\/+$/, '') + path_;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders(c) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) {
    const msg = json.error || json._raw || ('http ' + res.status);
    throw Object.assign(new Error(msg), { status: res.status, body: json });
  }
  return json;
}

// ---------- helpers ----------
function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / (1024 * 1024)).toFixed(1) + 'MB';
}

function fmtKScore(k) {
  if (!k) return '(no k-score)';
  return [
    `  composite: ${k.composite}`,
    `  accuracy:  ${(k.accuracy * 100).toFixed(1)}%`,
    `  coverage:  ${(k.coverage * 100).toFixed(1)}%`,
    `  size:      ${fmtBytes(k.size_bytes)}`,
    `  p50_lat:   ${k.p50_latency_us}us`,
    `  cost/call: $${k.cost_usd_per_call}`,
  ].join('\n');
}

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a); }));
}

const HELP = {
  _root: `kolm v${VERSION} - compile private AI behavior into the smallest signed artifact that passes the tests.

USAGE
  kolm <command> [args...]
  kolm <command> --help            per-command help

COMMANDS
  login                            authenticate to a kolm cloud
  new <name> [--from <template>]   scaffold a spec.json you can compile
  compile "<task>" [opts]          cloud-compile a task into a .kolm artifact
  compile --spec <file|->           offline build from a JSON spec (any author, AI included)
  run <art.kolm> '<input>'         execute a .kolm against an input
  eval <art.kolm>                  re-run embedded evals, print K-score
  bench <art.kolm> [opts]          emit artifact benchmark JSON (alias: benchmark)
  score <art.kolm>                 print just the K-score
  inspect <art.kolm>               manifest + recipes + signature
  serve [--mcp] [--http] [--port]  expose ~/.kolm/artifacts/* as MCP tools
  publish <art.kolm>               push to public gallery (Sprint 4)
  capture --provider <p> --as <t>  configure a drop-in proxy for OpenAI/Anthropic
  capture status [--namespace <n>] pairs captured / pairs until distill
  labels [--namespace <n>] [--out] download the captured corpus as JSONL
  distill --namespace <n>          auto-distill the namespace into a local LoRA
  config [base|api_key] [value]    inspect or set config
  version                          print version (CLI + server contract)

ENVIRONMENT
  KOLM_BASE        cloud endpoint (default: https://kolm.ai)
  KOLM_API_KEY     bearer token (overrides ~/.kolm/config.json)
  KOLM_DEBUG       set any non-empty to print stack traces on errors
`,
  login: `kolm login - paste your API key from the cloud dashboard.

USAGE
  kolm login

The key is stored at ~/.kolm/config.json (mode 0600). Get a key at https://kolm.ai/signin.
`,
  compile: `kolm compile - build a .kolm artifact (cloud-synthesised or local spec).

USAGE
  kolm compile "<task>" [opts]                  cloud compile from a task description
  kolm compile --spec <file.json> [--out <p>]   offline build from a JSON spec
  kolm compile --spec - [--out <p>]             offline build from JSON on stdin

OPTIONS (cloud)
  --data <dir>                 corpus dir to ground the compile in (Recall)
  --base-model <name>          base model (default: qwen2.5-coder-7b-instruct-q4_0)
  --examples <file.jsonl>      seed examples for the verifier
  --out <dir|file.kolm>        where to drop the artifact (default ~/.kolm/artifacts)

OPTIONS (spec)
  --spec <file|->              JSON spec describing recipes + evals + optional pack/index
  --out <file.kolm|dir>        output path (.kolm) or directory; default ~/.kolm/artifacts

SPEC SHAPE (offline path — any human or AI agent can author this)
  {
    "job_id": "job_my_redactor_v1",
    "task":   "redact PII from free text",
    "recipes": [{ "id":"rcp_my", "name":"...", "source":"function generate(input,lib){...}" }],
    "pack":   { ... optional KOLMPACK ... },
    "index":  { ... optional KOLMIDX ... },
    "evals":  { "spec":"rs-1-evals", "n":3, "cases":[{"id":"...","input":...,"expected":...}] }
  }

The offline path signs the artifact with a per-user secret stored at
~/.kolm/config.json (auto-generated). Set RECIPE_RECEIPT_SECRET in env to share
signatures across teammates / CI.

EXAMPLES
  # cloud (need: kolm login)
  kolm compile "triage support tickets" --data ./tickets --examples ./labels.jsonl

  # offline — write a spec, compile, run locally
  kolm new my-classifier --from classifier
  kolm compile --spec my-classifier.spec.json --out my-classifier.kolm
  kolm run my-classifier.kolm '{"text":"refund my last invoice"}'

  # offline from stdin (AI-agent friendly)
  cat spec.json | kolm compile --spec - --out out.kolm
`,
  new: `kolm new - scaffold a spec.json you can compile into a .kolm.

USAGE
  kolm new <name> [--from <template>] [--out <file>]

TEMPLATES
  --from blank        empty stub: one no-op recipe + one eval, ready to edit
  --from redactor     identifier redactor (regex pack + tenant extras)
  --from extractor    structured-field extractor (regex rules pack)
  --from classifier   keyword-weighted classifier (categories pack)

The output is a JSON file at <name>.spec.json (or --out <file>) that you can
compile with: kolm compile --spec <name>.spec.json --out <name>.kolm
`,
  run: `kolm run - execute a .kolm artifact locally.

USAGE
  kolm run <artifact.kolm> '<input-json>' [--params <json|@file>]

The input is parsed as JSON when possible; otherwise passed as a bare string.
--params lets you pass tenant-runtime config to the recipes (extra patterns,
allowlists, vertical rules). Recipes read these via lib.params. Tenant params
are never persisted by the runtime and never re-signed into the artifact.

EXAMPLES
  kolm run redactor.kolm '{"text":"call 555-1212"}'
  kolm run redactor.kolm '{"text":"id 12-345"}' --params '{"extra_patterns":[{"name":"emp_id","regex":"\\\\b\\\\d{2}-\\\\d{3}\\\\b","replacement":"[ID]"}]}'
  kolm run redactor.kolm '{"text":"..."}' --params @hospital-rules.json
`,
  eval: `kolm eval - re-run a .kolm's embedded eval set and recompute K-score.

USAGE
  kolm eval <artifact.kolm>
`,
  benchmark: `kolm bench - reproducible artifact benchmark (alias: benchmark).

USAGE
  kolm bench <artifact.kolm> [opts]

OPTIONS
  --runs <n>                   runs per embedded eval case (default: 1)
  --input '<json|string>'      fallback input when the artifact has no evals
  --target <name>              target label for the report
  --device <name>              device label for the report
  --out <file>                 also write the JSON report to a file
  --json                       emit JSON to stdout (default; reserved for future formats)

The report follows the kolm-benchmark-1 spec. It includes k_score, evals.accuracy,
latency_us.p50/p95, privacy.runtime_egress_attempts, integrity.signature_valid.
The harness patches fetch / http / https / net / tls / dns at process boundary —
egress attempts are recorded and blocked.
`,
  score: `kolm score - print the K-score on an artifact's manifest.

USAGE
  kolm score <artifact.kolm>
`,
  inspect: `kolm inspect - dump manifest + recipes + signature.

USAGE
  kolm inspect <artifact.kolm>
`,
  serve: `kolm serve - expose ~/.kolm/artifacts/* as MCP tools so frontier agents call them.

USAGE
  kolm serve --mcp [--http] [--port <n>]

NOTES
  --mcp is required in Sprint 1; HTTP is the only optional transport.
`,
  publish: `kolm publish - push to the public gallery.

USAGE
  kolm publish <artifact.kolm>

NOTE: The public gallery ships in Sprint 4. Until then, this exits with status 1.
`,
  capture: `kolm capture - drop-in proxy for OpenAI / Anthropic that captures (input, output) pairs.

USAGE
  kolm capture --provider <openai|anthropic> --as <task-name> [--namespace <n>]
  kolm capture status [--namespace <n>]

The first form writes ~/.kolm/capture/<task>.json with the upstream URL and the
headers your app should send. Point OPENAI_BASE_URL or ANTHROPIC_API_URL at us
and your existing SDK calls Just Work — every round-trip is captured into the
namespace's corpus.

Pass your real OpenAI / Anthropic key in the x-upstream-api-key header on each
request. The kolm api key goes in Authorization: Bearer kolm_… as usual.

The status form prints how many pairs have been captured and how many are
needed before \`kolm distill\` is unlocked (default threshold: 1000 pairs).

EXAMPLE
  kolm capture --provider openai --as ticket-classifier --namespace tickets
  # … your app makes 1000 calls …
  kolm capture status --namespace tickets
  kolm distill --namespace tickets
`,
  labels: `kolm labels - download the captured corpus as JSONL or JSON.

USAGE
  kolm labels [--namespace <n>] [--out <file>] [--format jsonl|json]

DEFAULTS
  --namespace default
  --format    jsonl

EXAMPLE
  kolm labels --namespace tickets --out tickets-corpus.jsonl
`,
  distill: `kolm distill - auto-distill a captured namespace into a local LoRA via the REM Labs bridge.

USAGE
  kolm distill --namespace <n> [--base-model <name>] [--target <size>]

DEFAULTS
  --base-model qwen2.5-coder-7b-instruct
  --target     phi-3-mini

EXIT CODES
  0  job started; the .kolm artifact is delivered to ~/.kolm/artifacts/ when done.
  2  REM Labs bridge not configured on this kolm cloud (hosted-only feature).
  3  not enough captured pairs yet (default threshold: 1000).

If the bridge is unavailable, run \`kolm labels --namespace <n> --out corpus.jsonl\`
and train locally with the on-prem trainer (Wave 2).
`,
  config: `kolm config - inspect or set config keys.

USAGE
  kolm config                          print current config (key redacted)
  kolm config <base|api_key>           print one value
  kolm config <base|api_key> <value>   set one value
`,
  version: `kolm version - print CLI version and the server contract version.

USAGE
  kolm version
`,
};

function usage(topic) {
  console.log(HELP[topic] || HELP._root);
}

function maybeHelp(topic, args) {
  if (args && (args.includes('--help') || args.includes('-h'))) {
    usage(topic);
    return true;
  }
  return false;
}

function firstRunBannerIfNeeded() {
  if (fs.existsSync(CONFIG_PATH)) return;
  if (process.env.KOLM_API_KEY) return;
  console.log('welcome to kolm. no config yet at ~/.kolm/config.json.');
  console.log('  get a key:  https://kolm.ai/signin');
  console.log('  then run:   kolm login');
  console.log('');
}

// ---------- commands ----------

const SPEC_TEMPLATES = {
  blank: (jobId) => ({
    job_id: jobId,
    task: 'describe what this artifact does in one sentence',
    base_model: 'none',
    recipes: [{
      id: 'rcp_main_v1',
      name: 'main recipe',
      source: [
        'function generate(input, lib) {',
        "  var text = (typeof input === 'string') ? input : (input && input.text) || '';",
        "  return { echoed: String(text) };",
        '}',
      ].join('\n'),
      tags: ['stub'],
      schema: { input: { text: 'string' }, output: { echoed: 'string' } },
    }],
    evals: {
      spec: 'rs-1-evals',
      n: 1,
      cases: [
        { id: 'echo', input: { text: 'hello' }, expected: { echoed: 'hello' } },
      ],
      coverage: 1.0,
    },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 50 },
  }),

  redactor: (jobId) => ({
    job_id: jobId,
    task: 'redact identifier patterns from free text — extend at run time via params.extra_patterns',
    base_model: 'none',
    recipes: [{
      id: 'rcp_redactor_v1',
      name: 'identifier redactor',
      source: [
        'function generate(input, lib) {',
        "  var text = (typeof input === 'string') ? input : (input && input.text) || '';",
        "  if (typeof text !== 'string') return { redacted: '', hits: [] };",
        '  var patterns = [];',
        "  var enabled = (lib.pack && lib.pack.enabled_builtins) || ['email','phone','url','ipv4','date'];",
        '  for (var i=0;i<enabled.length;i++){ var k=enabled[i]; if (lib.patterns[k]) patterns.push({name:k.toUpperCase(),regex:lib.patterns[k],replacement:"["+k.toUpperCase()+"]"}); }',
        '  var packPats = (lib.pack && lib.pack.default_patterns) || [];',
        "  for (var j=0;j<packPats.length;j++){ var p=packPats[j]; try { patterns.push({name:p.name,regex:new RegExp(p.regex,p.flags||'g'),replacement:p.replacement||('['+p.name+']')}); } catch(e){} }",
        '  var extras = (lib.params && lib.params.extra_patterns) || [];',
        "  for (var x=0;x<extras.length;x++){ var e=extras[x]; try { patterns.push({name:e.name,regex:new RegExp(e.regex,e.flags||'g'),replacement:e.replacement||('['+e.name+']')}); } catch(err){} }",
        '  var hits = {}, redacted = text;',
        '  for (var n=0;n<patterns.length;n++){ var pat=patterns[n], count=0; redacted = redacted.replace(pat.regex, function(){ count++; return pat.replacement; }); if (count>0) hits[pat.name]=(hits[pat.name]||0)+count; }',
        '  var hitList = []; for (var key in hits) hitList.push({name:key,count:hits[key]});',
        '  hitList.sort(function(a,b){ return a.name<b.name?-1:a.name>b.name?1:0; });',
        '  return { redacted: redacted, hits: hitList };',
        '}',
      ].join('\n'),
      tags: ['redaction', 'privacy', 'generic'],
      schema: { input: { text: 'string' }, output: { redacted: 'string', hits: 'array' } },
    }],
    pack: {
      spec: 'kolm-pack-1',
      description: 'starter identifier patterns — tenants extend via params.extra_patterns',
      enabled_builtins: ['email', 'phone', 'url', 'ipv4', 'date'],
      default_patterns: [
        { name: 'SSN_LIKE', regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b', replacement: '[SSN]' },
      ],
    },
    index: {
      spec: 'kolm-index-1',
      by_keyword: { redact: 'rcp_redactor_v1', privacy: 'rcp_redactor_v1' },
      by_recipe: { rcp_redactor_v1: ['redact', 'privacy'] },
    },
    evals: {
      spec: 'rs-1-evals',
      n: 2,
      cases: [
        { id: 'phone', input: { text: 'call 555-123-4567 today' }, expected: { redacted: 'call [PHONE] today', hits: [{ name: 'PHONE', count: 1 }] } },
        { id: 'ssn',   input: { text: 'ssn 123-45-6789' },         expected: { redacted: 'ssn [SSN]',          hits: [{ name: 'SSN_LIKE', count: 1 }] } },
      ],
      coverage: 1.0,
    },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 60 },
  }),

  extractor: (jobId) => ({
    job_id: jobId,
    task: 'extract structured fields from free text via artifact-bound + tenant-supplied regex rules',
    base_model: 'none',
    recipes: [{
      id: 'rcp_extractor_v1',
      name: 'structured field extractor',
      source: [
        'function generate(input, lib) {',
        "  var text = (typeof input === 'string') ? input : (input && input.text) || '';",
        "  if (typeof text !== 'string') return { fields: {}, raw: '' };",
        '  var rules = [];',
        '  var packRules = (lib.pack && lib.pack.default_rules) || [];',
        '  for (var i=0;i<packRules.length;i++) rules.push(packRules[i]);',
        '  var tenantRules = (lib.params && lib.params.extra_rules) || [];',
        '  for (var j=0;j<tenantRules.length;j++) rules.push(tenantRules[j]);',
        '  var fields = {};',
        '  for (var k=0;k<rules.length;k++){ var r=rules[k]; if (!r||!r.name||!r.regex) continue;',
        "    var re; try { re = new RegExp(r.regex, r.flags||''); } catch(err){ fields[r.name]=null; continue; }",
        '    var m = text.match(re); if (!m) { fields[r.name]=null; continue; }',
        "    var raw = (typeof r.group==='number'&&r.group>=0) ? (m[r.group]!=null?m[r.group]:null) : m[0];",
        '    if (raw==null) { fields[r.name]=null; continue; }',
        "    if (r.transform==='upper') raw=String(raw).toUpperCase();",
        "    else if (r.transform==='lower') raw=String(raw).toLowerCase();",
        "    else if (r.transform==='trim') raw=String(raw).trim();",
        "    else if (r.transform==='number') { var n=lib.parseFloatSafe(raw); raw=isNaN(n)?null:n; }",
        '    fields[r.name] = raw;',
        '  }',
        '  return { fields: fields, raw: text };',
        '}',
      ].join('\n'),
      tags: ['extraction', 'structured', 'generic'],
      schema: { input: { text: 'string' }, output: { fields: 'object', raw: 'string' } },
    }],
    pack: {
      spec: 'kolm-pack-1',
      description: 'starter extraction rules — tenants extend via params.extra_rules',
      default_rules: [
        { name: 'iso_date', regex: '\\b(\\d{4}-\\d{2}-\\d{2})\\b', group: 1 },
      ],
    },
    index: {
      spec: 'kolm-index-1',
      by_keyword: { extract: 'rcp_extractor_v1', parse: 'rcp_extractor_v1' },
      by_recipe: { rcp_extractor_v1: ['extract', 'parse'] },
    },
    evals: {
      spec: 'rs-1-evals',
      n: 1,
      cases: [
        { id: 'date', input: { text: 'invoice dated 2026-05-09' }, expected: { fields: { iso_date: '2026-05-09' }, raw: 'invoice dated 2026-05-09' } },
      ],
      coverage: 1.0,
    },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 70 },
  }),

  classifier: (jobId) => ({
    job_id: jobId,
    task: 'rule-based keyword classifier — score input against artifact-bound + tenant-supplied categories',
    base_model: 'none',
    recipes: [{
      id: 'rcp_classifier_v1',
      name: 'keyword classifier',
      source: [
        'function generate(input, lib) {',
        "  var text = (typeof input === 'string') ? input : (input && input.text) || '';",
        "  if (typeof text !== 'string') text = String(text);",
        '  var cats = [];',
        '  var packCats = (lib.pack && lib.pack.categories) || [];',
        '  for (var i=0;i<packCats.length;i++) cats.push(packCats[i]);',
        '  var tenantCats = (lib.params && lib.params.extra_categories) || [];',
        '  for (var j=0;j<tenantCats.length;j++) cats.push(tenantCats[j]);',
        '  var lower = text.toLowerCase();',
        '  var scores = {};',
        '  for (var k=0;k<cats.length;k++){ var c=cats[k]; if (!c||!c.name||!Array.isArray(c.keywords)) continue;',
        "    var weight = (typeof c.weight==='number'&&c.weight>0) ? c.weight : 1;",
        "    var score = 0; for (var n=0;n<c.keywords.length;n++){ var kw=String(c.keywords[n]||'').toLowerCase(); if (!kw) continue; var idx=0,hits=0; while ((idx=lower.indexOf(kw,idx))!==-1){ hits++; idx+=kw.length; } score += hits*weight; }",
        '    if (score>0) scores[c.name] = (scores[c.name]||0) + score;',
        '  }',
        '  var sortedNames = Object.keys(scores).sort(function(a,b){ if (scores[b]!==scores[a]) return scores[b]-scores[a]; return a<b?-1:1; });',
        "  var fallback = (lib.pack && lib.pack.fallback_label) || 'unclassified';",
        '  var top = sortedNames.length ? sortedNames[0] : fallback;',
        '  return { label: top, score: scores[top]||0, scores: scores };',
        '}',
      ].join('\n'),
      tags: ['classification', 'rules', 'generic'],
      schema: { input: { text: 'string' }, output: { label: 'string', score: 'number', scores: 'object' } },
    }],
    pack: {
      spec: 'kolm-pack-1',
      description: 'starter categories — tenants extend via params.extra_categories',
      fallback_label: 'general',
      categories: [
        { name: 'billing', keywords: ['refund', 'invoice', 'payment'] },
        { name: 'bug',     keywords: ['error', 'crash', 'broken'] },
      ],
    },
    index: {
      spec: 'kolm-index-1',
      by_keyword: { classify: 'rcp_classifier_v1', label: 'rcp_classifier_v1' },
      by_recipe: { rcp_classifier_v1: ['classify', 'label'] },
    },
    evals: {
      spec: 'rs-1-evals',
      n: 1,
      cases: [
        { id: 'billing', input: { text: 'I need a refund' }, expected: { label: 'billing', score: 1, scores: { billing: 1 } } },
      ],
      coverage: 1.0,
    },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 80 },
  }),
};

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'artifact';
}

async function cmdNew(args) {
  if (maybeHelp('new', args)) return;
  const positional = args.find(a => !a.startsWith('--'));
  if (!positional) { console.error('error: kolm new <name> [--from blank|redactor|extractor|classifier]'); process.exit(1); }
  const name = slugify(positional);
  const fromIdx = args.indexOf('--from');
  const tmplName = (fromIdx >= 0 ? args[fromIdx + 1] : 'blank') || 'blank';
  const tmpl = SPEC_TEMPLATES[tmplName];
  if (!tmpl) { console.error(`error: unknown template "${tmplName}". choose: ${Object.keys(SPEC_TEMPLATES).join(', ')}`); process.exit(1); }
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : path.resolve(process.cwd(), `${name}.spec.json`);
  if (fs.existsSync(outPath)) { console.error(`error: ${outPath} already exists. pick a new name or --out <path>.`); process.exit(1); }
  const jobId = `job_${name.replace(/-/g, '_')}_v1`;
  const spec = tmpl(jobId);
  fs.writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');
  console.log(`wrote: ${outPath}`);
  console.log(`compile: kolm compile --spec ${path.relative(process.cwd(), outPath) || outPath} --out ${name}.kolm`);
  console.log(`then run:  kolm run ${name}.kolm '{"text":"..."}'`);
  console.log(`\nedit the spec to point recipes/pack/index/evals at your task.`);
  console.log(`docs: see /docs/AUTHORING.md for the full schema + sensitive-data caveats.`);
}

async function cmdLogin(args) {
  if (maybeHelp('login', args)) return;
  const c = loadConfig();
  console.log('kolm login - paste your API key from the cloud dashboard.');
  console.log(`Cloud: ${c.base}`);
  const key = (await prompt('API key (ks_...): ')).trim();
  if (!key.startsWith('ks_')) {
    console.error('error: API key must start with "ks_"');
    process.exit(1);
  }
  c.api_key = key;
  saveConfig(c);
  // sanity-check
  try {
    const a = await api(c, 'GET', '/v1/account');
    console.log(`logged in. tenant=${a.id || 'admin'} plan=${a.plan || '-'}`);
  } catch (e) {
    console.error('saved config but health check failed:', e.message);
  }
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

async function cmdCompile(args) {
  if (maybeHelp('compile', args)) return;
  firstRunBannerIfNeeded();

  // ---- Spec-driven local compile path: anyone (or any AI agent) can author a
  // .kolm by writing JSON. No cloud, no account. The artifact is signed with
  // a per-user secret stored at ~/.kolm/config.json (auto-generated on first
  // run); set RECIPE_RECEIPT_SECRET in env to share signatures across teams.
  const specIdx = args.indexOf('--spec');
  if (specIdx >= 0) {
    const specArg = args[specIdx + 1];
    if (!specArg) { console.error('error: --spec needs a path or "-" for stdin'); process.exit(1); }
    let raw;
    try {
      if (specArg === '-' || specArg === '/dev/stdin') {
        raw = await readStdin();
      } else {
        raw = fs.readFileSync(specArg, 'utf8');
      }
    } catch (e) {
      console.error(`error: cannot read spec from ${specArg}: ${e.message}`); process.exit(1);
    }
    let spec;
    try { spec = JSON.parse(raw); }
    catch (e) { console.error(`error: spec is not valid JSON: ${e.message}`); process.exit(1); }
    const outIdxL = args.indexOf('--out');
    const outArg = outIdxL >= 0 ? args[outIdxL + 1] : null;
    const outDirL = outArg && outArg.endsWith('.kolm') ? path.dirname(outArg) : (outArg || ARTIFACTS_DIR);
    const outPath = outArg && outArg.endsWith('.kolm') ? path.resolve(outArg) : null;
    fs.mkdirSync(outDirL, { recursive: true });
    const { compileSpec } = await import('../src/spec-compile.js');
    try {
      const r = await compileSpec(spec, { outDir: outDirL, outPath });
      console.log(`built: ${r.outPath}`);
      console.log(`bytes: ${r.bytes}`);
      console.log(`sha256: ${r.sha256}`);
      if (r.k_score) console.log(`k_score: ${r.k_score.composite}`);
      console.log(`\ntry it:  kolm run ${path.basename(r.outPath)} '<input-json>'`);
      console.log(`serve:   kolm serve --mcp     # frontier agents discover it`);
      return;
    } catch (e) {
      const code = e.code ? `[${e.code}] ` : '';
      console.error(`compile failed: ${code}${e.message}`);
      if (process.env.KOLM_DEBUG) console.error(e.stack);
      process.exit(1);
    }
  }

  // ---- Cloud-compile path (existing): synthesize from task + corpus + examples.
  const c = loadConfig();
  if (!c.api_key) { console.error('not logged in. run: kolm login\n(or use --spec <file.json> for offline spec-driven compile)'); process.exit(1); }

  const task = args.find(a => !a.startsWith('--'));
  const dataIdx = args.indexOf('--data');
  const baseIdx = args.indexOf('--base-model');
  const exIdx = args.indexOf('--examples');
  const outIdx = args.indexOf('--out');

  const dataDir = dataIdx >= 0 ? args[dataIdx + 1] : null;
  const baseModel = baseIdx >= 0 ? args[baseIdx + 1] : null;
  const examplesPath = exIdx >= 0 ? args[exIdx + 1] : null;
  const outDir = outIdx >= 0 ? args[outIdx + 1] : ARTIFACTS_DIR;

  if (!task) { console.error('error: compile needs a task. e.g. kolm compile "triage support tickets"\n(or kolm compile --spec <file.json> for offline spec-driven compile)'); process.exit(1); }

  // Optional: if --data given, ingest first.
  let corpus_namespace = null;
  if (dataDir) {
    const ns = path.basename(path.resolve(dataDir));
    corpus_namespace = ns;
    console.log(`ingesting ${dataDir} into namespace "${ns}"`);
    try {
      const r = await api(c, 'POST', '/v1/embed', {
        namespace: ns,
        paths: [path.resolve(dataDir)],
      });
      const t = r.tokenized;
      console.log(`  added ${t.added}, skipped ${t.skipped}, ${r.embedded ? 'embedded' : 'NOT embedded (qmd absent; sidecars written)'}`);
    } catch (e) {
      console.error('  ingest failed (continuing without corpus):', e.message);
      corpus_namespace = null;
    }
  }

  let examples = [];
  if (examplesPath) {
    const lines = fs.readFileSync(examplesPath, 'utf-8').split(/\r?\n/).filter(Boolean);
    for (const ln of lines) {
      try { examples.push(JSON.parse(ln)); } catch { console.warn('  skipping malformed line:', ln); }
    }
    console.log(`loaded ${examples.length} examples from ${examplesPath}`);
  }

  console.log(`POST /v1/compile`);
  const job = await api(c, 'POST', '/v1/compile', {
    task,
    examples,
    corpus_namespace,
    base_model: baseModel,
  });
  console.log(`  job_id=${job.job_id} status=${job.status}`);

  // Poll
  let state;
  process.stdout.write('  ');
  for (let i = 0; i < 60; i++) {
    state = await api(c, 'GET', '/v1/compile/' + job.job_id);
    process.stdout.write(`[${state.progress}%] ${state.status} `);
    if (state.status === 'completed' || state.status === 'failed') break;
    await new Promise(r => setTimeout(r, 1000));
  }
  process.stdout.write('\n');
  if (state.status !== 'completed') {
    console.error('compile failed:', state.error || JSON.stringify(state, null, 2));
    process.exit(1);
  }

  // Download
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${state.id}.kolm`);
  const url = c.base.replace(/\/+$/, '') + state.artifact_url;
  const res = await fetch(url, { headers: authHeaders(c) });
  if (!res.ok) { console.error('download failed:', res.status); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  console.log(`wrote ${outPath} (${fmtBytes(buf.length)})`);
  console.log('K-score:');
  console.log(fmtKScore(state.k_score));
  console.log(`\nrun:    kolm run ${path.basename(outPath)} '<input-json>'`);
  console.log(`serve:  kolm serve --mcp     # frontier agents will see this skill`);
}

async function withRunner(fn) {
  const m = await import('../src/artifact-runner.js');
  return fn(m);
}

async function withBenchmark(fn) {
  const m = await import('../src/benchmark.js');
  return fn(m);
}

function resolveArtifact(p) {
  if (!p) return null;
  if (fs.existsSync(p)) return path.resolve(p);
  // Try ~/.kolm/artifacts/<arg>
  const cand = path.join(ARTIFACTS_DIR, p);
  if (fs.existsSync(cand)) return cand;
  const candKolm = cand.endsWith('.kolm') ? cand : cand + '.kolm';
  if (fs.existsSync(candKolm)) return candKolm;
  return null;
}

async function cmdRun(args) {
  if (maybeHelp('run', args)) return;
  // pull --params <json|@file> off args before resolving positional argv
  let paramsArg = null;
  const cleaned = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--params' && i + 1 < args.length) { paramsArg = args[i + 1]; i++; }
    else cleaned.push(args[i]);
  }
  const ap = resolveArtifact(cleaned[0]);
  if (!ap) { console.error('error: artifact not found:', cleaned[0]); process.exit(1); }
  const inputRaw = cleaned[1];
  let input = null;
  if (inputRaw) {
    try { input = JSON.parse(inputRaw); }
    catch { input = inputRaw; }
  }
  let params = null;
  if (paramsArg) {
    const raw = paramsArg.startsWith('@') ? fs.readFileSync(paramsArg.slice(1), 'utf8') : paramsArg;
    try { params = JSON.parse(raw); }
    catch (e) { console.error('error: --params must be JSON or @file.json:', e.message); process.exit(2); }
  }
  await withRunner(async ({ runArtifact }) => {
    try {
      const r = await runArtifact(ap, input, { params });
      console.log(JSON.stringify({ output: r.output, recipe: r.recipe_name || r.recipe_id, latency_us: r.latency_us, k_score: r.k_score, receipt: r.receipt, audit: r.audit }, null, 2));
    } catch (e) {
      const code = e.code || 'KOLM_E_RUN_FAILED';
      console.error(JSON.stringify({ error: e.message, code, tried: e.tried || null }, null, 2));
      process.exit(3);
    }
  });
}

async function cmdEval(args) {
  if (maybeHelp('eval', args)) return;
  const ap = resolveArtifact(args[0]);
  if (!ap) { console.error('error: artifact not found:', args[0]); process.exit(1); }
  await withRunner(async ({ evalArtifact }) => {
    const r = await evalArtifact(ap);
    console.log(JSON.stringify(r, null, 2));
  });
}

async function cmdBenchmark(args) {
  if (maybeHelp('benchmark', args)) return;
  const ap = resolveArtifact(args[0]);
  if (!ap) { console.error('error: artifact not found:', args[0]); process.exit(1); }

  const value = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const inputRaw = value('--input');
  let input;
  if (inputRaw !== undefined) {
    try { input = JSON.parse(inputRaw); }
    catch { input = inputRaw; }
  }

  await withBenchmark(async ({ benchmarkArtifact }) => {
    const report = await benchmarkArtifact(ap, {
      runs: value('--runs'),
      input,
      target: value('--target'),
      device: value('--device'),
      outPath: value('--out'),
    });
    console.log(JSON.stringify(report, null, 2));
  });
}

async function cmdScore(args) {
  if (maybeHelp('score', args)) return;
  const ap = resolveArtifact(args[0]);
  if (!ap) { console.error('error: artifact not found:', args[0]); process.exit(1); }
  await withRunner(async ({ inspectArtifact }) => {
    const m = inspectArtifact(ap);
    console.log(`task: ${m.task}`);
    console.log(fmtKScore(m.k_score));
  });
}

async function cmdInspect(args) {
  if (maybeHelp('inspect', args)) return;
  const ap = resolveArtifact(args[0]);
  if (!ap) { console.error('error: artifact not found:', args[0]); process.exit(1); }
  await withRunner(async ({ inspectArtifact }) => {
    const m = inspectArtifact(ap);
    console.log(JSON.stringify(m, null, 2));
  });
}

async function cmdServe(args) {
  if (maybeHelp('serve', args)) return;
  const useMcp = args.includes('--mcp');
  const useHttp = args.includes('--http');
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8765;

  if (!useMcp) {
    console.error('error: only --mcp transport is implemented in Sprint 1. use: kolm serve --mcp');
    process.exit(1);
  }
  const { startMcpServer } = await import('../services/mcp/server.js');
  await startMcpServer({ artifactsDir: ARTIFACTS_DIR, http: useHttp, port });
}

function cmdPublish(args) {
  if (maybeHelp('publish', args)) return;
  console.error('kolm publish: the public gallery ships in Sprint 4.');
  console.error('  artifact:  ' + (args[0] || '(specify path)'));
  console.error('  meanwhile: share the .kolm file directly, or push to your own registry.');
  process.exit(1);
}

function cmdConfig(args) {
  if (maybeHelp('config', args)) return;
  const c = loadConfig();
  if (args.length === 0) {
    console.log(JSON.stringify({ base: c.base, api_key: c.api_key ? c.api_key.slice(0, 6) + '...(set)' : null }, null, 2));
    return;
  }
  const [k, v] = args;
  if (!['base', 'api_key'].includes(k)) {
    console.error('config keys: base, api_key');
    process.exit(1);
  }
  if (v === undefined) {
    console.log(c[k] || null);
    return;
  }
  c[k] = v;
  saveConfig(c);
  console.log('saved');
}

// kolm capture --provider <openai|anthropic> --as <task> --namespace <n>
//   Writes ~/.kolm/capture/<task>.json with the upstream URL + headers the
//   customer should use. Customer points OPENAI_BASE_URL or ANTHROPIC_API_URL
//   at us; we proxy the call and record the (input, output) tuple.
//
// kolm capture status [--namespace <n>]
//   Calls /v1/labels/synthesize-corpus?count_only=1 and prints
//   "<count> pairs captured (<remaining> until distill)."
async function cmdCapture(args) {
  if (maybeHelp('capture', args)) return;
  const sub = args[0];
  if (sub === 'status') {
    const c = loadConfig();
    if (!c.api_key) { console.error('not logged in. run: kolm login'); process.exit(1); }
    const ns = pickFlag(args, '--namespace') || pickFlag(args, '-n') || 'default';
    const j = await api(c, 'GET', `/v1/labels/synthesize-corpus?namespace=${encodeURIComponent(ns)}&count_only=1`);
    const remaining = Math.max(0, (j.threshold || 1000) - (j.count || 0));
    console.log(`namespace ${j.namespace}: ${j.count} pair${j.count === 1 ? '' : 's'} captured`);
    console.log(`distill threshold: ${j.threshold}`);
    if (j.ready_to_distill) console.log('  ✓ ready to distill — run: kolm distill --namespace ' + j.namespace);
    else console.log(`  ${remaining} more pair${remaining === 1 ? '' : 's'} until distill is unlocked`);
    return;
  }
  // Default subcommand: write capture config.
  const provider = (pickFlag(args, '--provider') || pickFlag(args, '-p') || '').toLowerCase();
  const taskName = pickFlag(args, '--as') || args.find(a => !a.startsWith('-') && !['capture', 'status'].includes(a));
  const namespace = pickFlag(args, '--namespace') || pickFlag(args, '-n') || taskName || 'default';
  if (!provider || !['openai', 'anthropic'].includes(provider)) {
    console.error('error: --provider <openai|anthropic> required');
    console.error('usage: kolm capture --provider <openai|anthropic> --as <task-name> [--namespace <n>]');
    process.exit(1);
  }
  if (!taskName) {
    console.error('error: --as <task-name> required');
    process.exit(1);
  }
  const c = loadConfig();
  if (!c.api_key) {
    console.error('not logged in. run: kolm login');
    process.exit(1);
  }
  const captureDir = path.join(KOLM_DIR, 'capture');
  fs.mkdirSync(captureDir, { recursive: true });
  const base = (c.base || 'https://kolm.ai').replace(/\/+$/, '');
  const baseUrl = `${base}/v1/capture/${provider}`;
  const cfg = {
    provider,
    task: taskName,
    namespace,
    base_url: baseUrl,
    kolm_api_key: c.api_key,
    upstream_key_env: provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY',
    created_at: new Date().toISOString(),
  };
  const cfgPath = path.join(captureDir, `${taskName}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  fs.chmodSync(cfgPath, 0o600);
  console.log(`saved capture config: ${cfgPath}`);
  console.log('');
  console.log('to start capturing, set in your app:');
  if (provider === 'openai') {
    console.log(`  export OPENAI_BASE_URL="${baseUrl}"`);
    console.log(`  # then per request:`);
    console.log(`  #   Authorization: Bearer ${c.api_key.slice(0, 8)}...    (your kolm key)`);
    console.log(`  #   x-upstream-api-key: sk-...                           (your real OpenAI key)`);
  } else {
    console.log(`  export ANTHROPIC_BASE_URL="${baseUrl}"     # SDKs >=0.18`);
    console.log(`  export ANTHROPIC_API_URL="${baseUrl}"      # older SDKs`);
    console.log(`  # then per request:`);
    console.log(`  #   Authorization: Bearer ${c.api_key.slice(0, 8)}...    (your kolm key)`);
    console.log(`  #   x-upstream-api-key: sk-ant-...                       (your real Anthropic key)`);
  }
  console.log(`  #   x-kolm-namespace: ${namespace}`);
  console.log('');
  console.log('check capture progress: kolm capture status --namespace ' + namespace);
}

// kolm labels [--namespace <n>] [--out <file.jsonl>] [--format jsonl|json]
//   Downloads the captured corpus as JSONL (or JSON envelope).
async function cmdLabels(args) {
  if (maybeHelp('labels', args)) return;
  const c = loadConfig();
  if (!c.api_key) { console.error('not logged in. run: kolm login'); process.exit(1); }
  const ns = pickFlag(args, '--namespace') || pickFlag(args, '-n') || 'default';
  const fmt = (pickFlag(args, '--format') || 'jsonl').toLowerCase();
  const out = pickFlag(args, '--out');
  const url = c.base.replace(/\/+$/, '') + `/v1/labels/synthesize-corpus?namespace=${encodeURIComponent(ns)}&format=${encodeURIComponent(fmt)}`;
  const res = await fetch(url, { headers: authHeaders(c) });
  if (!res.ok) {
    const t = await res.text();
    console.error(`error: http ${res.status} ${t.slice(0, 400)}`);
    process.exit(1);
  }
  const text = await res.text();
  if (out) {
    fs.writeFileSync(out, text);
    const count = res.headers.get('x-kolm-count') || '?';
    console.log(`wrote ${count} pair${count === '1' ? '' : 's'} to ${out}`);
  } else {
    process.stdout.write(text);
  }
}

// kolm distill --namespace <n> [--base-model <m>] [--target <size>]
//   Triggers auto-distill via the REM Labs bridge. Returns 503 with a clear
//   operator hint until the server has REM_LABS_BRIDGE_URL configured.
async function cmdDistill(args) {
  if (maybeHelp('distill', args)) return;
  const c = loadConfig();
  if (!c.api_key) { console.error('not logged in. run: kolm login'); process.exit(1); }
  const ns = pickFlag(args, '--namespace') || pickFlag(args, '-n') || 'default';
  const base_model = pickFlag(args, '--base-model') || 'qwen2.5-coder-7b-instruct';
  const target_size = pickFlag(args, '--target') || pickFlag(args, '--target-size') || 'phi-3-mini';
  const url = c.base.replace(/\/+$/, '') + '/v1/specialists/auto-distill';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(c) },
    body: JSON.stringify({ namespace: ns, base_model, target_size }),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { _raw: text }; }
  if (!res.ok) {
    if (res.status === 503 && j.error === 'distill_bridge_not_configured') {
      console.error('distill is not yet enabled on this kolm cloud.');
      console.error('  ' + (j.message || ''));
      if (j.next_steps) console.error('  next: ' + j.next_steps);
      process.exit(2);
    }
    if (res.status === 400 && (j.error || '').startsWith('not enough')) {
      console.error(`namespace ${j.namespace}: ${j.count}/${j.threshold} pairs captured`);
      console.error(`  ${j.message || 'capture more before distill'}`);
      process.exit(3);
    }
    console.error(`error: http ${res.status} ${text.slice(0, 400)}`);
    process.exit(1);
  }
  console.log('distill job started.');
  console.log('  job_id:    ' + (j.job_id || '?'));
  console.log('  namespace: ' + j.namespace);
  console.log('  base:      ' + j.base_model);
  console.log('  target:    ' + j.target_size);
  console.log('  pairs:     ' + j.pair_count);
  if (j.status_url) console.log('  status:    ' + j.status_url);
}

function pickFlag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('-')) return '';
  return v;
}

async function cmdVersion(args) {
  if (maybeHelp('version', args)) return;
  const c = loadConfig();
  console.log('kolm cli   v' + VERSION);
  console.log('spec       rs-1');
  try {
    const url = c.base.replace(/\/+$/, '') + '/health';
    const res = await fetch(url, { headers: authHeaders(c) });
    if (res.ok) {
      const j = await res.json();
      const v = j.version || '?';
      const lib = j.library_version ? ' lib=' + j.library_version : '';
      const region = j.region ? ' region=' + j.region : '';
      console.log('kolm cloud v' + v + '  (' + c.base + lib + region + ')');
    } else {
      console.log('kolm cloud ?  (' + c.base + ', http ' + res.status + ')');
    }
  } catch (e) {
    console.log('kolm cloud ?  (' + c.base + ', unreachable)');
  }
}

// ---------- dispatch ----------
// If the user previously compiled an artifact via `kolm compile --spec` we
// auto-saved a per-user `local_receipt_secret` to ~/.kolm/config.json so the
// receipt signs deterministically. Pull it back into env here so subsequent
// `kolm inspect/run/eval/bench` calls verify the signatures we issued.
function ensureLocalReceiptSecretInEnv() {
  if (process.env.RECIPE_RECEIPT_SECRET || process.env.KOLM_ARTIFACT_SECRET) return;
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg && typeof cfg.local_receipt_secret === 'string' && cfg.local_receipt_secret.length > 0) {
      process.env.RECIPE_RECEIPT_SECRET = cfg.local_receipt_secret;
    }
  } catch {}
}

async function main() {
  ensureLocalReceiptSecretInEnv();
  const [, , cmd, ...rest] = process.argv;
  try {
    switch (cmd) {
      case 'login':    await cmdLogin(rest); break;
      case 'new':      await cmdNew(rest); break;
      case 'compile':  await cmdCompile(rest); break;
      case 'run':      await cmdRun(rest); break;
      case 'eval':     await cmdEval(rest); break;
      case 'benchmark':
      case 'bench':    await cmdBenchmark(rest); break;
      case 'score':    await cmdScore(rest); break;
      case 'inspect':  await cmdInspect(rest); break;
      case 'serve':    await cmdServe(rest); break;
      case 'publish':  cmdPublish(rest); break;
      case 'capture':  await cmdCapture(rest); break;
      case 'labels':   await cmdLabels(rest); break;
      case 'distill':  await cmdDistill(rest); break;
      case 'config':   cmdConfig(rest); break;
      case 'version':
      case '--version':
      case '-v':       await cmdVersion(rest); break;
      case 'help':
      case '--help':
      case '-h':
      case undefined:  usage(rest && rest[0]); break;
      default:         console.error('unknown command:', cmd); usage(); process.exit(1);
    }
  } catch (e) {
    console.error('error:', e.message);
    if (process.env.KOLM_DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

main();
