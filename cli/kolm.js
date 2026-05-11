#!/usr/bin/env node
// kolm - the private AI compiler.
//
// One CLI. Verb-noun grammar. Compiles, runs, evals, scores, serves, evolves
// .kolm artifacts so frontier agents quietly call them via MCP and so local
// adapters get better every time they run.
//
// AUTHOR + SHIP
//   kolm init                           scaffold kolm.yaml + .kolm/ at cwd
//   kolm login                          auth -> ~/.kolm/config.json
//   kolm new <name> [--from tpl]        scaffold a spec.json
//   kolm compile "<task>" | --spec      cloud OR offline build -> .kolm
//
// VERIFY + RUN
//   kolm inspect <art.kolm>             manifest + recipes + signature
//   kolm run <art.kolm> '<input>'       execute against an input
//   kolm eval <art.kolm>                re-run evals, recompute K-score
//   kolm score <art.kolm>               print K-score only
//   kolm bench <art.kolm>               reproducible benchmark JSON
//
// SERVE + WIRE
//   kolm serve [--mcp] [--http]         expose ~/.kolm/artifacts as MCP tools
//   kolm install <harness> [--apply]    wire kolm into Claude Code/Cursor/Continue/Cline
//   kolm publish <art.kolm>             push to public gallery (Sprint 4)
//
// EVOLVE (skeleton LoRA -> living model)
//   kolm tune init                      create skeleton adapter (PEFT format)
//   kolm tune capture-on                start collecting (input,output) signals
//   kolm tune step [--airgap]           run one SFT epoch on captures
//   kolm tune eval [--rev vN]           score the new revision
//   kolm tune promote --rev vN          K-score gated; flip HEAD
//   kolm tune rollback                  restore prior head
//   kolm tune watch                     daemon: auto-step + auto-promote
//
// LOOKUP (airgapped local RAG)
//   kolm rag index <dir> [--name n]     build BM25 index over local files
//   kolm rag query <name> "<question>"  top-k passages (no network)
//   kolm rag attach <art> --index n     wire rag into a recipe's sandbox
//
// OBSERVE + DEBUG
//   kolm capture/labels/distill         (data-loop verbs)
//   kolm doctor                         sanity-check env
//   kolm logs [--since 24h]             tail ~/.kolm/logs/runs.jsonl
//
// The whole point: humans run `kolm compile`; frontier models discover the
// result via `kolm serve --mcp` and call it without being asked; the local
// model evolves on every run it learns from.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

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
  init [--name <slug>]             scaffold kolm.yaml + .kolm/ at cwd (project bootstrap)
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
  install <harness> [--apply]      wire kolm MCP into Claude Code / Cursor / Continue / Cline
  tune <sub>                       evolve a local adapter (init|capture-on|step|eval|promote|watch)
  rag <sub>                        airgapped local lookup (index|query|attach|list)
  doctor                           sanity-check env (config, cloud, docker, project)
  logs [--limit n] [--artifact x]  tail local run history (~/.kolm/logs/runs.jsonl)
  config [base|api_key] [value]    inspect or set config
  version                          print version (CLI + server contract)

ENVIRONMENT
  KOLM_BASE        cloud endpoint (default: https://kolm.ai)
  KOLM_API_KEY     bearer token (overrides ~/.kolm/config.json)
  KOLM_DEBUG       set any non-empty to print stack traces on errors
`,
  init: `kolm init - scaffold a kolm.yaml at the current directory.

USAGE
  kolm init [--name <slug>] [--force]

Writes:
  ./kolm.yaml                        project manifest (artifacts, mcp, bench, hooks, skills_dir)
  ./.kolm/                           local working dir (compiled artifacts, skills, receipts)
  ./.gitignore                       appends .kolm/ if a gitignore is present or this is a git repo

The project name defaults to a slugified version of the cwd folder name.
Refuses to overwrite an existing kolm.yaml unless --force is passed.

Once you have a kolm.yaml, frontier-agent harnesses (Claude Code, Cursor, Cline,
Continue) can auto-attach the project's .kolm artifacts via 'kolm serve --mcp'.

SCHEMA
  https://kolm.ai/docs/kolm-yaml-v0.1.json
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
  --deploy-hook <https-url>    POST {job_id,artifact_url,k_score,...} to this webhook
                               after a successful compile. Use for Vercel Deploy
                               Hooks, GitHub repository_dispatch, or any webhook.
                               Falls back to $KOLM_DEPLOY_HOOK_URL.

OPTIONS (spec)
  --spec <file|->              JSON spec describing recipes + evals + optional pack/index
  --out <file.kolm|dir>        output path (.kolm) or directory; default ~/.kolm/artifacts

SKILL.md sidecar
  By default, every successful compile also emits a SKILL.md next to the artifact
  (or under skills_dir if a kolm.yaml is found in a parent directory). The
  sidecar uses Claude Code's frontmatter format (name / description / allowed-tools
  / disable-model-invocation) so Claude Code, Cursor, Cline and Continue can
  index the skill without further config. Pass --no-skill to suppress.

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
  kolm bench <artifact.kolm> [opts]            artifact-local benchmark JSON
  kolm bench --reproduce <suite> [opts]         public-reproducer suite (Docker)

OPTIONS (artifact mode)
  --runs <n>                   runs per embedded eval case (default: 1)
  --input '<json|string>'      fallback input when the artifact has no evals
  --target <name>              target label for the report
  --device <name>              device label for the report
  --out <file>                 also write the JSON report to a file
  --json                       emit JSON to stdout (default; reserved for future formats)

The artifact-mode report follows the kolm-benchmark-1 spec. It includes k_score,
evals.accuracy, latency_us.p50/p95, privacy.runtime_egress_attempts,
integrity.signature_valid. The harness patches fetch / http / https / net / tls /
dns at process boundary — egress attempts are recorded and blocked.

OPTIONS (--reproduce mode)
  --reproduce <suite>          public reproducer; available: swebench-lite-n150
  --seed <n>                   seed (default: per-suite, e.g. 42)
  --n <n>                      sample size (default: per-suite, e.g. 150)
  --out <file>                 report path (default: ~/.kolm/bench/<suite>/report.json)
  --dry-run                    print the plan; do not pull or run docker
  --api-key <key>              override ANTHROPIC_API_KEY for the spawned container

Reproducer mode runs in a pinned Docker image so the evaluator and dataset
versions are byte-identical to the published numbers. You bring your own
ANTHROPIC_API_KEY; the harness mounts it into the container only. Methodology:
  https://kolm.ai/articles/how-we-benchmark

EXIT CODES (--reproduce mode)
  0  reproducer succeeded; report.json on disk.
  1  bad arguments (unknown suite, bad seed/n, etc.).
  2  prerequisite missing (no docker, no ANTHROPIC_API_KEY, image not yet published).
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
  distill: `kolm distill - auto-distill a captured namespace into a local LoRA via the kolm trainer bridge.

USAGE
  kolm distill --namespace <n> [--base-model <name>] [--target <size>]

DEFAULTS
  --base-model qwen2.5-coder-7b-instruct
  --target     phi-3-mini

EXIT CODES
  0  job started; the .kolm artifact is delivered to ~/.kolm/artifacts/ when done.
  2  trainer bridge not configured on this kolm cloud (hosted-only feature).
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
  install: `kolm install - wire the kolm MCP server into a frontier-agent harness.

USAGE
  kolm install <claude-code|cursor|continue|cline> [--apply]

By default the snippet is only printed. Pass --apply to merge it into the
harness's config file. The snippet runs \`kolm serve --mcp\` from the project
root, so artifacts declared under kolm.yaml's artifacts[] are auto-served.

HARNESSES
  claude-code    merges into ~/.claude/settings.json (mcpServers map)
  cursor         writes ./.cursor/mcp.json
  continue       appends to ~/.continue/config.yaml
  cline          writes ./.clinerules/kolm.md (instructional rule)

EXAMPLES
  kolm install claude-code               # preview
  kolm install claude-code --apply       # write
  kolm install cursor --apply
`,
  doctor: `kolm doctor - sanity-check the environment.

USAGE
  kolm doctor

CHECKS
  config file, api key, cloud reachability, receipt secret, node >= 18,
  docker (optional, for kolm bench --reproduce), ANTHROPIC_API_KEY (optional),
  project config (kolm.yaml), project + global artifact counts.

EXIT CODES
  0    no blockers (warnings allowed)
  1    one or more required checks failed
`,
  logs: `kolm logs - tail the local run-history log.

USAGE
  kolm logs [--limit n] [--artifact <name|path>] [--since 7d|24h|10m] [--json]

Each row records: timestamp, command (run|bench|mcp), artifact, recipe, latency,
K-score composite, success. The log is append-only at ~/.kolm/logs/runs.jsonl;
no cloud egress, no PII in the body.

EXAMPLES
  kolm logs --limit 20
  kolm logs --artifact redactor.kolm --since 24h
  kolm logs --json | jq '.[] | select(.k_composite < 0.85)'
`,

  tune: `kolm tune - evolve an artifact's local adapter from a skeleton LoRA into a living model.

USAGE
  kolm tune init       --artifact <art.kolm> --base <model_path_or_id> [--rank 8] [--alpha 16]
  kolm tune capture-on --artifact <art.kolm>
  kolm tune capture-off --artifact <art.kolm>
  kolm tune step       --artifact <art.kolm> [--epochs 1] [--airgap] [--batch-size 4] [--lr 2e-4]
  kolm tune eval       --artifact <art.kolm> [--rev vN]
  kolm tune promote    --artifact <art.kolm> --rev vN [--force]
  kolm tune rollback   --artifact <art.kolm>
  kolm tune watch      --artifact <art.kolm> [--interval 30000]
  kolm tune status     --artifact <art.kolm>

PIPELINE
  init       -> v0 skeleton (PEFT config, zero weights). Required first step.
  capture-on -> every \`kolm run\` writes (input, output) to captures.jsonl.
  step       -> SFT on captures (Python: torch + peft + transformers). Writes vN+1.
  eval       -> recompute K-score for the candidate.
  promote    -> if K-score(vN) ≥ gate (default 0.85) AND ≥ current head, flip HEAD.
  rollback   -> restore the prior HEAD revision from head.prev.
  watch      -> daemon: when captures grow past threshold, auto-step → eval → promote.

AIRGAP
  --airgap sets TRANSFORMERS_OFFLINE=1, HF_DATASETS_OFFLINE=1, HF_HUB_OFFLINE=1
  and refuses any base_model that is not a local path. Use after you've pre-staged
  the weights on the box.

DEPENDENCIES (only for \`tune step\`, not for the rest)
  pip install 'torch>=2.2' 'transformers>=4.42' 'peft>=0.11' 'datasets>=2.18' 'accelerate>=0.30' 'trl>=0.9'
`,

  rag: `kolm rag - airgapped local retrieval (BM25, no embedder, no network).

USAGE
  kolm rag index <dir> [--name <slug>] [--ext txt,md,json] [--max-bytes 4194304]
  kolm rag query <name> "<question>" [--top-k 5] [--json]
  kolm rag attach <art.kolm> --index <name>
  kolm rag list

PURPOSE
  Make local knowledge queryable from inside a kolm recipe sandbox without
  any network access. The runtime exposes \`lib.rag.query(q, k)\` to recipes
  that have been attached.

EXAMPLES
  kolm rag index ./docs --name internal-docs
  kolm rag query internal-docs "how does the K-score gate work" --top-k 3
  kolm rag attach ./artifacts/help-bot.kolm --index internal-docs

  # inside a recipe:
  #   function generate(input, lib) {
  #     var hits = lib.rag ? lib.rag.query(input.q, 3).matches : [];
  #     ...
  #   }
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

// Pretty-print hook results to stderr (quiet by default; verbose with KOLM_DEBUG).
// Each line shows: event, exit code, and either a short stdout preview or the
// stderr tail. Hooks are opt-in, so this is silent for projects without them.
function printHookResult(r) {
  if (!r || !r.results || r.results.length === 0) return;
  for (const h of r.results) {
    const tag = h.exitCode === 0 ? 'hook' : (h.exitCode === 2 ? 'hook BLOCK' : 'hook WARN');
    const tail = (h.stderr || h.stdout || '').trim().split(/\r?\n/).pop() || '';
    process.stderr.write(`${tag} [exit=${h.exitCode}] ${h.command}${tail ? '  | ' + tail.slice(0, 200) : ''}\n`);
  }
}

// Walk up from startDir looking for a kolm.yaml. Returns { root, name, skills_dir }
// or null. Hand-parses two fields so we don't need a yaml dep.
function findProjectKolmYaml(startDir) {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 12; depth++) {
    const p = path.join(dir, 'kolm.yaml');
    if (fs.existsSync(p)) {
      try {
        const text = fs.readFileSync(p, 'utf8');
        const nameMatch = text.match(/^name:\s*(\S+)/m);
        const skillsMatch = text.match(/^skills_dir:\s*(\S+)/m);
        return {
          root: dir,
          name: nameMatch ? nameMatch[1].replace(/^["']|["']$/g, '') : path.basename(dir),
          skills_dir: skillsMatch ? skillsMatch[1].replace(/^["']|["']$/g, '') : './.kolm/skills',
        };
      } catch { return null; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// SKILL.md sidecar for an emitted .kolm artifact. Mirrors Claude Code's
// SKILL.md frontmatter (name, description, allowed-tools, disable-model-invocation)
// so harnesses (Claude Code, Cursor, Cline, Continue) can auto-index the skill.
// Writes to <projectRoot>/<skills_dir>/<name>.md when a kolm.yaml is present,
// else next to the artifact.
function writeSkillSidecar({ artifactPath, description, kScore }) {
  const artifactName = path.basename(artifactPath, '.kolm');
  const proj = findProjectKolmYaml(path.dirname(artifactPath));
  let skillsDir;
  let mcpToolName;
  if (proj) {
    const sd = proj.skills_dir.replace(/^\.\//, '');
    skillsDir = path.resolve(proj.root, sd);
    mcpToolName = `mcp__${proj.name}__${artifactName}`;
  } else {
    skillsDir = path.dirname(artifactPath);
    mcpToolName = `mcp__kolm__${artifactName}`;
  }
  fs.mkdirSync(skillsDir, { recursive: true });
  const outPath = path.join(skillsDir, `${artifactName}.md`);
  const desc = String(description || `Artifact ${artifactName}.`).replace(/\n+/g, ' ').slice(0, 500);
  const kLine = (kScore && typeof kScore.composite === 'number')
    ? `K-score: ${kScore.composite.toFixed(3)} (composite). `
    : '';
  const body = [
    '---',
    `name: ${artifactName}`,
    `description: ${desc}`,
    `allowed-tools: []`,
    `disable-model-invocation: false`,
    '---',
    '',
    `# ${artifactName}`,
    '',
    desc,
    '',
    '## How to invoke',
    '',
    `Frontier agents call this skill via MCP after \`kolm serve --mcp\`:`,
    '',
    `- Tool name: \`${mcpToolName}\``,
    `- Backing artifact: \`${path.relative(proj ? proj.root : path.dirname(artifactPath), artifactPath).replace(/\\/g, '/')}\``,
    '- Transport: stdio (zero-port; no network exposure)',
    '',
    '## Guarantees',
    '',
    `${kLine}Runtime egress is patched at the process boundary — the artifact cannot reach the network during execution. The .kolm bundle is signed; signatures are verified before each call.`,
    '',
  ].join('\n');
  fs.writeFileSync(outPath, body);
  return outPath;
}

// kolm.yaml writer. Hand-rolls a minimal YAML so we don't pull a yaml dep
// for one file. The schema lives at /docs/kolm-yaml-v0.1.json; this emitter
// must round-trip against it. If you change the shape, update both.
function emitKolmYaml({ name, description, version }) {
  const safeDesc = (description || '').replace(/"/g, '\\"');
  return [
    `kolm_yaml_version: "0.1"`,
    `name: ${name}`,
    `version: ${version}`,
    `description: "${safeDesc}"`,
    ``,
    `# .kolm artifacts this project owns. Each becomes one MCP tool.`,
    `# The name field becomes the MCP tool name (mcp__${name}__<artifact-name>).`,
    `# Use a glob for path to pick up everything under a directory.`,
    `artifacts:`,
    `  - path: ./.kolm/artifacts/*.kolm`,
    `    name: ${name}`,
    `    description: "Auto-discovered .kolm artifacts under ./.kolm/artifacts/"`,
    `    # paths: ["src/**/*.ts"]       # auto-attach when editing these files`,
    `    # allowed-tools: []             # MCP tools the sub-agent may call (default none)`,
    `    # k_min: 0.85                   # refuse to serve below this K-score`,
    ``,
    `# MCP transport for 'kolm serve --mcp'. Default stdio (zero-port).`,
    `mcp:`,
    `  transport: stdio`,
    `  host: 127.0.0.1`,
    `  # port: 7800                       # only used by http / sse transports`,
    ``,
    `# Where 'kolm compile' writes SKILL.md sidecars. Indexed by Claude Code,`,
    `# Cursor (.cursor/rules), Cline (.clinerules) and Continue (~/.continue).`,
    `skills_dir: ./.kolm/skills`,
    ``,
    `# Optional: reproducer benchmark wiring for 'kolm bench --reproduce'.`,
    `# bench:`,
    `#   suite: swebench-lite-n150`,
    `#   n: 150`,
    `#   model: claude-opus-4-7-20251225`,
    ``,
    `# Optional: compile/run/bench hooks. Each script reads a JSON event on stdin`,
    `# and exits 0 to allow or 2 to block. See /docs/HOOKS.md.`,
    `# hooks:`,
    `#   PreCompile:  ["./scripts/lint-spec.sh"]`,
    `#   PostCompile: ["./scripts/emit-skill.sh"]`,
    `#   PreRun:      []`,
    `#   PostRun:     []`,
    `#   PreBench:    []`,
    `#   PostBench:   []`,
    ``,
  ].join('\n');
}

async function cmdInit(args) {
  if (maybeHelp('init', args)) return;
  const cwd = process.cwd();
  const yamlPath = path.join(cwd, 'kolm.yaml');
  const force = args.includes('--force');
  if (fs.existsSync(yamlPath) && !force) {
    console.error(`error: ${yamlPath} already exists. pass --force to overwrite.`);
    process.exit(1);
  }
  const nameIdx = args.indexOf('--name');
  const cwdSlug = slugify(path.basename(cwd));
  const projectName = nameIdx >= 0 ? slugify(args[nameIdx + 1] || '') : cwdSlug;
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(projectName)) {
    console.error(`error: name "${projectName}" must match ^[a-z0-9][a-z0-9-_]*$ (lowercase, no leading dash).`);
    process.exit(1);
  }
  const descIdx = args.indexOf('--description');
  const description = descIdx >= 0 ? (args[descIdx + 1] || '') : `Private AI compiler project: ${projectName}.`;

  // Write kolm.yaml
  const yaml = emitKolmYaml({ name: projectName, description, version: '0.1.0' });
  fs.writeFileSync(yamlPath, yaml);
  console.log(`wrote: ${path.relative(cwd, yamlPath) || 'kolm.yaml'}`);

  // Local .kolm working dir (artifacts + skills).
  const dotKolm = path.join(cwd, '.kolm');
  const dotKolmArtifacts = path.join(dotKolm, 'artifacts');
  const dotKolmSkills = path.join(dotKolm, 'skills');
  fs.mkdirSync(dotKolmArtifacts, { recursive: true });
  fs.mkdirSync(dotKolmSkills, { recursive: true });
  console.log(`mkdir: .kolm/artifacts/  .kolm/skills/`);

  // .gitignore — append if either a .gitignore or a .git/ exists. Don't create
  // a gitignore in non-git directories; that would be presumptuous.
  const gitIgnorePath = path.join(cwd, '.gitignore');
  const isGit = fs.existsSync(path.join(cwd, '.git'));
  const hasGitIgnore = fs.existsSync(gitIgnorePath);
  if (hasGitIgnore || isGit) {
    const existing = hasGitIgnore ? fs.readFileSync(gitIgnorePath, 'utf8') : '';
    const lines = existing.split(/\r?\n/);
    const have = (s) => lines.some(l => l.trim() === s);
    const toAdd = [];
    if (!have('.kolm/')) toAdd.push('.kolm/');
    // Don't ignore kolm.yaml — it's project source, belongs in VCS.
    if (toAdd.length) {
      const sep = existing && !existing.endsWith('\n') ? '\n' : '';
      const block = `${sep}# kolm local artifacts + skills (regenerated from kolm.yaml)\n${toAdd.join('\n')}\n`;
      fs.appendFileSync(gitIgnorePath, block);
      console.log(`updated: .gitignore (+ ${toAdd.join(', ')})`);
    }
  }

  console.log('');
  console.log('next:');
  console.log('  kolm new my-skill --from classifier      # scaffold a spec');
  console.log('  kolm compile --spec my-skill.spec.json   # build a .kolm into .kolm/artifacts/');
  console.log('  kolm serve --mcp                         # expose project artifacts via MCP');
  console.log('');
  console.log('schema: https://kolm.ai/docs/kolm-yaml-v0.1.json');
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
    const { dispatch } = await import('../src/hooks.js');
    const preOk = await dispatch('PreCompile', { command: 'compile', cwd: process.cwd(), spec_job_id: spec.job_id, spec_task: spec.task }, { onResult: printHookResult });
    if (!preOk) { console.error('PreCompile hook blocked compile (exit 2)'); process.exit(2); }
    const { compileSpec } = await import('../src/spec-compile.js');
    try {
      const r = await compileSpec(spec, { outDir: outDirL, outPath });
      console.log(`built: ${r.outPath}`);
      console.log(`bytes: ${r.bytes}`);
      console.log(`sha256: ${r.sha256}`);
      if (r.k_score) console.log(`k_score: ${r.k_score.composite}`);
      if (!args.includes('--no-skill')) {
        try {
          const skillPath = writeSkillSidecar({
            artifactPath: r.outPath,
            description: spec.task || `Spec-compiled artifact ${path.basename(r.outPath, '.kolm')}.`,
            kScore: r.k_score,
          });
          console.log(`skill: ${skillPath}`);
        } catch (e) {
          if (process.env.KOLM_DEBUG) console.error('skill emit failed:', e.message);
        }
      }
      await dispatch('PostCompile', { command: 'compile', cwd: process.cwd(), artifact: r.outPath, sha256: r.sha256, bytes: r.bytes, k_score: r.k_score }, { onResult: printHookResult });
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
  const { dispatch: dispatchCloud } = await import('../src/hooks.js');
  const preCloudTask = args.find(a => !a.startsWith('--'));
  const preCloudOk = await dispatchCloud('PreCompile', { command: 'compile', cwd: process.cwd(), task: preCloudTask, cloud: true }, { onResult: printHookResult });
  if (!preCloudOk) { console.error('PreCompile hook blocked compile (exit 2)'); process.exit(2); }

  const task = args.find(a => !a.startsWith('--'));
  const dataIdx = args.indexOf('--data');
  const baseIdx = args.indexOf('--base-model');
  const exIdx = args.indexOf('--examples');
  const outIdx = args.indexOf('--out');
  const hookIdx = args.indexOf('--deploy-hook');

  const dataDir = dataIdx >= 0 ? args[dataIdx + 1] : null;
  const baseModel = baseIdx >= 0 ? args[baseIdx + 1] : null;
  const examplesPath = exIdx >= 0 ? args[exIdx + 1] : null;
  const outDir = outIdx >= 0 ? args[outIdx + 1] : ARTIFACTS_DIR;
  // --deploy-hook https://… > $KOLM_DEPLOY_HOOK_URL env. Fires after a
  // successful compile so downstream automation (Vercel Deploy Hook,
  // GitHub repository_dispatch, generic webhook) can publish the artifact.
  const deployHook = hookIdx >= 0 ? args[hookIdx + 1] : (process.env.KOLM_DEPLOY_HOOK_URL || null);

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
  const compileBody = {
    task,
    examples,
    corpus_namespace,
    base_model: baseModel,
  };
  if (deployHook && /^https:\/\//i.test(deployHook)) {
    compileBody.deploy_hook = deployHook;
    console.log(`  deploy_hook=${deployHook.replace(/(\/[^\/]{6})[^\/]+(\/[^\/]+)$/, '$1…$2')}`);
  }
  const job = await api(c, 'POST', '/v1/compile', compileBody);
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
  if (!args.includes('--no-skill')) {
    try {
      const skillPath = writeSkillSidecar({
        artifactPath: outPath,
        description: task,
        kScore: state.k_score,
      });
      console.log(`skill: ${skillPath}`);
    } catch (e) {
      if (process.env.KOLM_DEBUG) console.error('skill emit failed:', e.message);
    }
  }
  await dispatchCloud('PostCompile', { command: 'compile', cwd: process.cwd(), artifact: outPath, k_score: state.k_score, bytes: buf.length, cloud: true }, { onResult: printHookResult });
  if (state.deploy_hook_set) {
    if (state.deploy_status === 'sent') {
      console.log(`deploy: webhook sent ok (${state.deploy_response_code || '200'})`);
    } else if (state.deploy_status === 'pending') {
      console.log(`deploy: webhook pending — re-poll job for outcome`);
    } else if (state.deploy_status === 'failed') {
      console.log(`deploy: webhook FAILED${state.deploy_response_code ? ' (' + state.deploy_response_code + ')' : ''}`);
    }
  }
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
  const { dispatch: dispatchRun } = await import('../src/hooks.js');
  const preRunOk = await dispatchRun('PreRun', { command: 'run', cwd: process.cwd(), artifact: ap, input }, { onResult: printHookResult });
  if (!preRunOk) { console.error('PreRun hook blocked run (exit 2)'); process.exit(2); }
  await withRunner(async ({ runArtifact }) => {
    try {
      const r = await runArtifact(ap, input, { params });
      console.log(JSON.stringify({ output: r.output, recipe: r.recipe_name || r.recipe_id, latency_us: r.latency_us, k_score: r.k_score, receipt: r.receipt, audit: r.audit }, null, 2));
      appendRunLog({ command: 'run', artifact: ap, recipe_id: r.recipe_id, recipe_name: r.recipe_name, latency_us: r.latency_us, k_composite: r.k_score?.composite, ok: r.audit?.ok !== false });
      try {
        const { appendCapture } = await import('../src/tune.js');
        appendCapture(ap, { input, output: r.output, recipe: r.recipe_name || r.recipe_id, latency_us: r.latency_us });
      } catch {}
      await dispatchRun('PostRun', { command: 'run', cwd: process.cwd(), artifact: ap, latency_us: r.latency_us, k_score: r.k_score, recipe: r.recipe_name || r.recipe_id }, { onResult: printHookResult });
    } catch (e) {
      const code = e.code || 'KOLM_E_RUN_FAILED';
      appendRunLog({ command: 'run', artifact: ap, ok: false, error: e.message, error_code: code });
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
  // `kolm bench --reproduce <suite>` is the public-reproducer path documented at
  // /articles/how-we-benchmark. It runs in a pinned Docker image so the harness
  // and evaluator versions are identical to the published numbers.
  if (args.includes('--reproduce')) {
    return cmdBenchReproduce(args);
  }
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

  const { dispatch: dispatchBench } = await import('../src/hooks.js');
  const preBenchOk = await dispatchBench('PreBench', { command: 'bench', cwd: process.cwd(), artifact: ap, runs: Number(value('--runs') || 0) || undefined }, { onResult: printHookResult });
  if (!preBenchOk) { console.error('PreBench hook blocked bench (exit 2)'); process.exit(2); }
  await withBenchmark(async ({ benchmarkArtifact }) => {
    const report = await benchmarkArtifact(ap, {
      runs: value('--runs'),
      input,
      target: value('--target'),
      device: value('--device'),
      outPath: value('--out'),
    });
    console.log(JSON.stringify(report, null, 2));
    const k = report.k_score?.composite ?? report.summary?.k_score ?? null;
    const lat = report.latency_us?.p50 ?? null;
    appendRunLog({ command: 'bench', artifact: ap, runs: report.runs ?? null, k_composite: k, latency_us: lat, ok: true });
    await dispatchBench('PostBench', { command: 'bench', cwd: process.cwd(), artifact: ap, runs: report.runs, summary: report.summary || null }, { onResult: printHookResult });
  });
}

// `kolm bench --reproduce <suite> [--seed N] [--n N] [--out path] [--dry-run]`
// runs the published reproducer in a pinned Docker image. Suites:
//   swebench-lite-n150  -- the +10.67pp Opus-4.7 lift, swebench 4.1.0 evaluator
//
// Honesty pattern: the CLI verb is real, but the heavy harness is gated behind
// the operator-published Docker image. If docker / ANTHROPIC_API_KEY / the image
// are not available, exit 2 with a clear operator hint rather than silently
// no-op'ing. This mirrors /v1/specialists/auto-distill's 503 behaviour.
const REPRODUCE_SUITES = {
  'swebench-lite-n150': {
    image:        'kolmogorov/swebench-reproducer:1.0.0',
    default_n:    150,
    default_seed: 42,
    headline:     '+10.67pp lift, 95% CI [+4.67, +16.67], p<0.05 (Opus-4.7, swebench 4.1.0)',
    requires:     ['docker', 'ANTHROPIC_API_KEY'],
    est_minutes:  90,
    est_dollars:  30,
  },
};

async function cmdBenchReproduce(args) {
  // Use process.exitCode + return rather than process.exit() so buffered
  // stderr drains before the process tears down. process.exit() in pipe
  // contexts (CI captures via $(...)) can truncate the last few writes.
  const idx = args.indexOf('--reproduce');
  const suite = idx >= 0 ? args[idx + 1] : undefined;
  if (!suite || suite.startsWith('-')) {
    console.error('error: --reproduce requires a suite name');
    console.error('available suites:');
    for (const [name, s] of Object.entries(REPRODUCE_SUITES)) {
      console.error(`  ${name}    ${s.headline}`);
    }
    process.exitCode = 1; return;
  }
  const cfg = REPRODUCE_SUITES[suite];
  if (!cfg) {
    console.error('error: unknown suite:', suite);
    console.error('available suites: ' + Object.keys(REPRODUCE_SUITES).join(', '));
    process.exitCode = 1; return;
  }
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const seed = Number(value('--seed') || cfg.default_seed);
  const n = Number(value('--n') || cfg.default_n);
  const outPath = value('--out') || path.join(KOLM_DIR, 'bench', suite, 'report.json');
  const dryRun = args.includes('--dry-run');
  if (!Number.isInteger(seed) || seed < 0) {
    console.error('error: --seed must be a non-negative integer');
    process.exitCode = 1; return;
  }
  if (!Number.isInteger(n) || n < 1 || n > 300) {
    console.error('error: --n must be an integer in [1, 300]');
    process.exitCode = 1; return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || value('--api-key');
  const dockerOk = (() => {
    if (dryRun) return true;
    const r = spawnSync('docker', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  })();

  // Plan-print: always shown so the operator knows what would happen.
  const plan = {
    suite,
    image: cfg.image,
    seed, n,
    out: outPath,
    headline: cfg.headline,
    estimated_minutes: Math.round(cfg.est_minutes * (n / cfg.default_n)),
    estimated_dollars: Math.round(cfg.est_dollars * (n / cfg.default_n) * 100) / 100,
    methodology: 'https://kolm.ai/articles/how-we-benchmark',
  };

  if (dryRun) {
    console.log(JSON.stringify({ ...plan, mode: 'dry-run', would_run: true }, null, 2));
    console.log('');
    console.log('# this is what the real run would do (skipped because --dry-run)');
    console.log(`docker run --rm \\`);
    console.log(`  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \\`);
    console.log(`  -e KOLM_REPRODUCE_SEED=${seed} \\`);
    console.log(`  -e KOLM_REPRODUCE_N=${n} \\`);
    console.log(`  -v "$HOME/.kolm/bench/${suite}:/out" \\`);
    console.log(`  ${cfg.image}`);
    return;
  }

  // Real run: enforce prerequisites first, fail with operator hints, never silent.
  if (!apiKey) {
    console.error('error: ANTHROPIC_API_KEY not set in environment');
    console.error('');
    console.error('the reproducer brings your own key. set it and retry:');
    console.error('  export ANTHROPIC_API_KEY=sk-ant-...');
    console.error(`  kolm bench --reproduce ${suite} --seed ${seed} --n ${n}`);
    console.error('');
    console.error(`estimated: ${plan.estimated_minutes} min, $${plan.estimated_dollars} in Opus-4.7 spend`);
    process.exitCode = 2; return;
  }
  if (!dockerOk) {
    console.error('error: docker not available on PATH');
    console.error('');
    console.error('the reproducer runs in a pinned image so the harness + evaluator versions');
    console.error('are byte-identical to the published numbers. install docker and retry:');
    console.error('  https://docs.docker.com/get-docker/');
    process.exitCode = 2; return;
  }

  // Image-pull / inspect. If the image is not yet published to the registry,
  // we exit 2 with an operator hint -- same shape as auto-distill 503.
  console.log(`# pulling ${cfg.image} (one-time, ~600MB)`);
  const pull = spawnSync('docker', ['pull', cfg.image], { stdio: 'inherit' });
  if (pull.status !== 0) {
    console.error('');
    console.error('error: docker pull failed for ' + cfg.image);
    console.error('');
    console.error('this image is published as part of the v7.0 launch. if you are seeing this');
    console.error('before the public launch, the image is not yet in the registry. interim:');
    console.error('  - watch https://github.com/kolmogorov/kolm-bench-reproducer/releases');
    console.error('  - or build locally from kolmogorov-stack/bench/:');
    console.error('      git clone https://github.com/kolmogorov/kolmogorov-stack && cd kolmogorov-stack/bench');
    console.error('      docker build -t ' + cfg.image + ' .');
    console.error('  - or run the n=5 smoke locally without docker: kolm bench --reproduce ' + suite + ' --dry-run');
    process.exitCode = 2; return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  console.log('');
  console.log(`# running ${cfg.image} on suite=${suite} seed=${seed} n=${n}`);
  console.log(`# expect ~${plan.estimated_minutes} min and ~$${plan.estimated_dollars} in Opus-4.7 spend`);
  console.log('');
  const run = spawnSync('docker', [
    'run', '--rm',
    '-e', 'ANTHROPIC_API_KEY=' + apiKey,
    '-e', 'KOLM_REPRODUCE_SEED=' + seed,
    '-e', 'KOLM_REPRODUCE_N=' + n,
    '-v', path.dirname(outPath) + ':/out',
    cfg.image,
  ], { stdio: 'inherit' });
  if (run.status !== 0) {
    console.error('error: reproducer exited with code ' + run.status);
    process.exitCode = run.status || 1; return;
  }
  console.log('');
  console.log(`✓ report written to ${outPath}`);
  console.log(`  diff against published log: https://kolm.ai/bench/${suite}/report.json`);
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
  await startMcpServer({ artifactsDir: ARTIFACTS_DIR, http: useHttp, port, projectCwd: process.cwd() });
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
//   Triggers auto-distill via the kolm trainer bridge. Returns 503 with a clear
//   operator hint until the server has KOLM_TRAINER_BRIDGE_URL configured.
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

// kolm install <harness> [--apply]
//   Print the MCP wiring snippet for the given harness. Default is print-only;
//   --apply writes/merges into the harness's config file. Supported harnesses:
//     claude-code   ~/.claude/settings.json     (mcpServers map)
//     cursor        ./.cursor/mcp.json          (mcpServers map)
//     continue      ~/.continue/config.yaml     (mcpServers list)
//     cline         ./.clinerules/kolm.md       (instructional rule pointing at SKILL.md)
//   When in project mode (kolm.yaml present), the snippet runs `kolm serve --mcp`
//   from the project root so artifacts[] resolves correctly.
const HARNESS_SNIPPETS = {
  'claude-code': {
    target: () => path.join(HOME, '.claude', 'settings.json'),
    kind: 'json-mcpServers',
    label: 'Claude Code',
  },
  'cursor': {
    target: () => path.join(process.cwd(), '.cursor', 'mcp.json'),
    kind: 'json-mcpServers',
    label: 'Cursor',
  },
  'continue': {
    target: () => path.join(HOME, '.continue', 'config.yaml'),
    kind: 'continue-yaml',
    label: 'Continue',
  },
  'cline': {
    target: () => path.join(process.cwd(), '.clinerules', 'kolm.md'),
    kind: 'cline-md',
    label: 'Cline',
  },
};

async function cmdInstall(args) {
  if (maybeHelp('install', args)) return;
  const harness = args.find(a => !a.startsWith('--'));
  if (!harness || !HARNESS_SNIPPETS[harness]) {
    console.error('error: pick a harness:  kolm install <claude-code|cursor|continue|cline> [--apply]');
    console.error('');
    console.error('available:');
    for (const [k, v] of Object.entries(HARNESS_SNIPPETS)) {
      console.error(`  ${k.padEnd(12)} -> ${v.target()}  (${v.label})`);
    }
    process.exit(1);
  }
  const apply = args.includes('--apply');
  const harnessCfg = HARNESS_SNIPPETS[harness];
  const target = harnessCfg.target();
  const proj = (await import('../src/project.js')).findProjectConfig(process.cwd());
  const projectRoot = proj?.root || process.cwd();
  const projectName = proj?.config?.name || null;

  const snippet = renderHarnessSnippet(harnessCfg.kind, { projectRoot, projectName });

  if (!apply) {
    console.log(`# kolm install ${harness} — preview (pass --apply to write to ${target})`);
    console.log('');
    console.log(snippet.preview);
    console.log('');
    console.log(`target: ${target}`);
    console.log(`apply:  kolm install ${harness} --apply`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let final;
  if (snippet.kind === 'json-mcpServers') {
    let existing = {};
    if (fs.existsSync(target)) {
      try { existing = JSON.parse(fs.readFileSync(target, 'utf8')) || {}; } catch { existing = {}; }
    }
    existing.mcpServers = existing.mcpServers || {};
    existing.mcpServers.kolm = snippet.value;
    final = JSON.stringify(existing, null, 2) + '\n';
  } else if (snippet.kind === 'continue-yaml') {
    let existing = '';
    if (fs.existsSync(target)) existing = fs.readFileSync(target, 'utf8');
    if (existing.includes('name: kolm')) {
      console.error(`note: ${target} already contains a 'kolm' mcpServers entry; leaving file untouched.`);
      return;
    }
    final = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + snippet.value + '\n';
  } else if (snippet.kind === 'cline-md') {
    final = snippet.value;
  }
  fs.writeFileSync(target, final);
  console.log(`wrote: ${target}`);
  console.log('');
  console.log('next:');
  console.log(`  ${harness === 'claude-code' ? 'restart Claude Code (or run /mcp)' : harness === 'cursor' ? 'reload Cursor MCP (Cmd+Shift+P → "MCP: Reload")' : harness === 'continue' ? 'restart Continue extension' : 'open Cline and check skills index'}`);
}

function renderHarnessSnippet(kind, { projectRoot, projectName }) {
  const cmd = {
    command: 'kolm',
    args: ['serve', '--mcp'],
    cwd: projectRoot,
    env: {},
  };
  if (kind === 'json-mcpServers') {
    const value = { command: cmd.command, args: cmd.args };
    if (projectName) value.cwd = projectRoot;
    return { kind, value, preview: JSON.stringify({ mcpServers: { kolm: value } }, null, 2) };
  }
  if (kind === 'continue-yaml') {
    const block = [
      '# kolm MCP server — added by `kolm install continue --apply`',
      'mcpServers:',
      '  - name: kolm',
      '    command: kolm',
      '    args: [serve, --mcp]',
      projectName ? `    cwd: ${projectRoot}` : '',
    ].filter(Boolean).join('\n');
    return { kind, value: block, preview: block };
  }
  if (kind === 'cline-md') {
    const body = [
      '# kolm skills (auto-indexed)',
      '',
      'This project compiles AI behavior into `.kolm` artifacts under `./.kolm/artifacts/`.',
      'When working in this repo, prefer calling those skills over re-implementing.',
      '',
      '- Discover skills under `./.kolm/skills/*.md` (Claude Code SKILL.md format).',
      '- Each `.kolm` is signed and runs locally (zero network egress).',
      '- For MCP wiring, run `kolm serve --mcp` and configure your MCP client.',
      '',
      `> generated by \`kolm install cline\` at ${new Date().toISOString()}`,
      '',
    ].join('\n');
    return { kind, value: body, preview: body };
  }
  return { kind, value: '', preview: '' };
}

// kolm doctor — diagnostic. Surfaces missing env vars, broken tools, project
// config issues, K-score gate status. Exits 0 on clean, 1 if any issue is
// "missing" (red), 0 if only "warn" (yellow) issues are present.
async function cmdDoctor(args) {
  if (maybeHelp('doctor', args)) return;
  const checks = [];
  const c = loadConfig();
  // Config + auth
  checks.push({ name: 'config file', status: fs.existsSync(CONFIG_PATH) ? 'ok' : 'warn', detail: CONFIG_PATH });
  checks.push({ name: 'api key', status: c.api_key ? 'ok' : 'warn', detail: c.api_key ? c.api_key.slice(0, 8) + '...' : 'not set (run: kolm login or set KOLM_API_KEY)' });
  // Cloud reachable
  try {
    const r = await fetch((c.base || 'https://kolm.ai').replace(/\/+$/, '') + '/health', { headers: authHeaders(c) });
    checks.push({ name: 'cloud reachable', status: r.ok ? 'ok' : 'warn', detail: `${c.base} -> ${r.status}` });
  } catch (e) {
    checks.push({ name: 'cloud reachable', status: 'warn', detail: `${c.base} -> ${e.message}` });
  }
  // Local receipt secret
  checks.push({ name: 'receipt secret', status: process.env.RECIPE_RECEIPT_SECRET ? 'ok' : 'warn', detail: process.env.RECIPE_RECEIPT_SECRET ? '(env or config)' : 'not set; offline compile will fall back to a per-user random secret' });
  // Node version
  const nodeMaj = Number((process.versions.node || '0').split('.')[0]);
  checks.push({ name: 'node version', status: nodeMaj >= 18 ? 'ok' : 'missing', detail: 'v' + process.versions.node });
  // Optional: docker (for bench --reproduce)
  const docker = spawnSync('docker', ['--version'], { stdio: 'pipe' });
  checks.push({ name: 'docker (optional)', status: docker.status === 0 ? 'ok' : 'warn', detail: docker.status === 0 ? docker.stdout.toString().trim() : 'not on PATH (needed for: kolm bench --reproduce)' });
  // Optional: ANTHROPIC_API_KEY (for cloud compile + bench reproducer)
  checks.push({ name: 'ANTHROPIC_API_KEY (optional)', status: process.env.ANTHROPIC_API_KEY ? 'ok' : 'warn', detail: process.env.ANTHROPIC_API_KEY ? 'set' : 'not set (needed for: kolm bench --reproduce)' });
  // Project config
  const proj = (await import('../src/project.js')).findProjectConfig(process.cwd());
  if (proj) {
    checks.push({ name: 'project config', status: 'ok', detail: `${proj.config.name} (${path.relative(process.cwd(), proj.path) || 'kolm.yaml'})` });
    const localArtifactsDir = path.join(proj.root, '.kolm', 'artifacts');
    const localCount = fs.existsSync(localArtifactsDir) ? fs.readdirSync(localArtifactsDir).filter(f => f.endsWith('.kolm')).length : 0;
    checks.push({ name: 'project artifacts', status: localCount > 0 ? 'ok' : 'warn', detail: `${localCount} .kolm in ./.kolm/artifacts/` });
  } else {
    checks.push({ name: 'project config', status: 'warn', detail: 'no kolm.yaml in cwd or parents — run: kolm init' });
  }
  // Global artifacts
  const globalCount = fs.existsSync(ARTIFACTS_DIR) ? fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('.kolm')).length : 0;
  checks.push({ name: 'global artifacts', status: 'ok', detail: `${globalCount} .kolm in ${ARTIFACTS_DIR}` });

  // Render
  const STATUS = { ok: '✓', warn: '!', missing: '✗' };
  let red = 0, yellow = 0;
  for (const ch of checks) {
    if (ch.status === 'missing') red++;
    else if (ch.status === 'warn') yellow++;
    process.stdout.write(`${STATUS[ch.status] || '?'}  ${ch.name.padEnd(28)}  ${ch.detail || ''}\n`);
  }
  process.stdout.write('\n');
  if (red > 0) {
    process.stdout.write(`${red} blocker${red === 1 ? '' : 's'}, ${yellow} warning${yellow === 1 ? '' : 's'}. fix the ✗ rows above and re-run.\n`);
    process.exit(1);
  }
  process.stdout.write(`all required checks pass (${yellow} warning${yellow === 1 ? '' : 's'}).\n`);
}

// kolm logs — tail the local run-history log. Each kolm run / kolm bench / mcp
// tools/call appends a JSON line to ~/.kolm/logs/runs.jsonl. The format is
// stable: {ts, command, artifact, recipe_id, latency_us, k_composite, ok}.
async function cmdLogs(args) {
  if (maybeHelp('logs', args)) return;
  const logPath = path.join(KOLM_DIR, 'logs', 'runs.jsonl');
  if (!fs.existsSync(logPath)) {
    console.log('# no runs yet — log file does not exist yet:');
    console.log('  ' + logPath);
    console.log('');
    console.log('runs are appended every time you call: kolm run, kolm bench, or an MCP tools/call.');
    return;
  }
  const limit = Number(pickFlag(args, '--limit') || pickFlag(args, '-n') || 50);
  const artifactFilter = pickFlag(args, '--artifact') || null;
  const sinceArg = pickFlag(args, '--since') || null;
  const sinceMs = sinceArg ? parseSince(sinceArg) : 0;
  const json = args.includes('--json');

  const text = fs.readFileSync(logPath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (artifactFilter && !(r.artifact || '').includes(artifactFilter)) continue;
      if (sinceMs && new Date(r.ts).getTime() < sinceMs) continue;
      rows.push(r);
    } catch {}
  }
  const tail = rows.slice(-limit);
  if (json) {
    for (const r of tail) process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (tail.length === 0) {
    console.log('# no runs match those filters.');
    return;
  }
  for (const r of tail) {
    const k = (r.k_composite != null) ? r.k_composite.toFixed(3) : '?';
    const lat = (r.latency_us != null) ? r.latency_us + 'us' : '?';
    const ok = r.ok === false ? 'FAIL' : 'ok';
    console.log(`${r.ts}  ${r.command.padEnd(7)} ${ok.padEnd(4)} k=${k.padEnd(5)} lat=${lat.padEnd(8)} ${path.basename(r.artifact || '')}`);
  }
}

function parseSince(s) {
  const m = String(s).match(/^(\d+)([smhd])$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const mul = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]] || 0;
  return Date.now() - n * mul;
}

// Tiny helper called from run/bench/MCP-call paths. Best-effort: a failed
// append never blocks the call. Caller passes the fields it has.
export function appendRunLog(entry) {
  try {
    const dir = path.join(KOLM_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const row = { ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(path.join(dir, 'runs.jsonl'), JSON.stringify(row) + '\n');
  } catch {}
}

// ---------- kolm tune (skeleton LoRA -> evolving adapter) ----------
async function cmdTune(args) {
  if (maybeHelp('tune', args)) return;
  const sub = args[0];
  if (!sub) { usage('tune'); process.exit(1); }
  const tune = await import('../src/tune.js');
  const artifactFlag = pickFlag(args, '--artifact') || pickFlag(args, '-a');
  const requireArtifact = () => {
    if (!artifactFlag) { console.error('--artifact <path.kolm> required'); process.exit(1); }
    const p = path.isAbsolute(artifactFlag) ? artifactFlag :
              (fs.existsSync(artifactFlag) ? path.resolve(artifactFlag) : path.join(ARTIFACTS_DIR, artifactFlag));
    if (!fs.existsSync(p)) { console.error('no such artifact: ' + p); process.exit(1); }
    return p;
  };
  switch (sub) {
    case 'init': {
      const ap = requireArtifact();
      const base = pickFlag(args, '--base') || pickFlag(args, '--base-model');
      if (!base) { console.error('--base <model_path_or_id> required'); process.exit(1); }
      const rank = Number(pickFlag(args, '--rank') || 8);
      const alpha = Number(pickFlag(args, '--alpha') || 16);
      const dropout = Number(pickFlag(args, '--dropout') || 0.05);
      const r = tune.initAdapter({ artifactPath: ap, baseModel: base, rank, alpha, dropout });
      if (r.existed) console.log('already initialized at ' + r.tuneDir + ' (HEAD=' + r.revision + ')');
      else {
        console.log('ok  scaffolded skeleton adapter');
        console.log('    dir:    ' + r.tuneDir);
        console.log('    head:   v0 (skeleton, zero-init)');
        console.log('    base:   ' + base);
        console.log('    next:   kolm tune capture-on --artifact ' + path.basename(ap));
      }
      return;
    }
    case 'capture-on':
    case 'capture-off': {
      const ap = requireArtifact();
      const on = sub === 'capture-on';
      const cfg = tune.setCaptureFlag(ap, on);
      console.log('captures ' + (on ? 'ON' : 'OFF') + '  artifact=' + cfg.artifact);
      if (on) console.log('every kolm run will append a (input,output) row to captures.jsonl');
      return;
    }
    case 'step': {
      const ap = requireArtifact();
      const airgap = args.includes('--airgap');
      const epochs = Number(pickFlag(args, '--epochs') || 1);
      const batchSize = Number(pickFlag(args, '--batch-size') || 4);
      const lr = Number(pickFlag(args, '--lr') || 2e-4);
      console.log('starting tune step (epochs=' + epochs + (airgap ? ', AIRGAP' : '') + ')…');
      try {
        const r = tune.runTuneStep({ artifactPath: ap, epochs, airgap, batchSize, lr });
        console.log('ok  ' + r.revision + '  ' + JSON.stringify(r.stats));
        console.log('    next: kolm tune eval --artifact ' + path.basename(ap) + ' --rev ' + r.revision);
      } catch (e) {
        console.error('tune step failed: ' + e.message);
        process.exit(1);
      }
      return;
    }
    case 'eval': {
      const ap = requireArtifact();
      const rev = pickFlag(args, '--rev') || tune.headRevision(ap);
      if (!rev) { console.error('no revisions yet'); process.exit(1); }
      const e = await tune.evalRevision({ artifactPath: ap, revision: rev });
      console.log('revision ' + rev);
      console.log('  pass:     ' + e.pass + '/' + e.total + '  (' + (e.accuracy * 100).toFixed(1) + '% acc)');
      if (e.p50_latency_us != null) console.log('  p50:      ' + e.p50_latency_us + 'us');
      console.log('  K-score:  ' + e.k_score.composite + '  (gate=0.85)');
      console.log('  ships:    ' + (e.k_score.ships ? 'YES' : 'NO'));
      return;
    }
    case 'promote': {
      const ap = requireArtifact();
      const rev = pickFlag(args, '--rev');
      if (!rev) { console.error('--rev vN required'); process.exit(1); }
      const force = args.includes('--force');
      try {
        const r = await tune.promoteRevision({ artifactPath: ap, revision: rev, force });
        console.log('ok  promoted ' + r.promoted + '  (prev=' + (r.previous || 'none') + ')');
        console.log('    K-score: ' + r.k_score.composite);
      } catch (e) {
        console.error(e.message);
        process.exit(e.code === 'K_GATE' ? 2 : 1);
      }
      return;
    }
    case 'rollback': {
      const ap = requireArtifact();
      const r = tune.rollbackHead(ap);
      console.log('ok  rolled back to ' + r.rolled_back_to + ' (was ' + r.was + ')');
      return;
    }
    case 'status': {
      const ap = requireArtifact();
      const s = tune.summary(ap);
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    case 'watch': {
      const ap = requireArtifact();
      const interval = Number(pickFlag(args, '--interval') || 30000);
      console.log('watching ' + path.basename(ap) + ' (interval=' + interval + 'ms). ^C to stop.');
      await tune.watchAndEvolve({ artifactPath: ap, interval });
      return;
    }
    default:
      console.error('unknown tune subcommand: ' + sub);
      usage('tune');
      process.exit(1);
  }
}

// ---------- kolm rag (airgapped local retrieval) ----------
async function cmdRag(args) {
  if (maybeHelp('rag', args)) return;
  const sub = args[0];
  if (!sub) { usage('rag'); process.exit(1); }
  const rag = await import('../src/rag.js');
  switch (sub) {
    case 'index': {
      const dir = args[1];
      if (!dir) { console.error('rag index <dir> required'); process.exit(1); }
      const name = pickFlag(args, '--name');
      const exts = (pickFlag(args, '--ext') || 'txt,md,json,html').split(',').map(s => s.trim()).filter(Boolean);
      const maxBytes = Number(pickFlag(args, '--max-bytes') || (4 * 1024 * 1024));
      const m = rag.indexDir({ dir, name, exts, maxBytes });
      console.log('ok  indexed ' + m.n_docs + ' doc' + (m.n_docs === 1 ? '' : 's'));
      console.log('    name:    ' + m.name);
      console.log('    root:    ' + m.root);
      console.log('    avgdl:   ' + Math.round(m.avgdl) + ' tokens/doc');
      console.log('    size:    ' + (m.size_bytes / 1024).toFixed(1) + ' KB');
      console.log('    sha256:  ' + m.sha256.slice(0, 16) + '…');
      console.log('    next:    kolm rag query ' + m.name + ' "<question>"');
      return;
    }
    case 'query': {
      const name = args[1];
      const q = args[2];
      if (!name || !q) { console.error('rag query <name> "<question>" required'); process.exit(1); }
      const topK = Number(pickFlag(args, '--top-k') || 5);
      const r = rag.queryIndex({ name, q, topK });
      if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log('# query: ' + q);
      console.log('# index: ' + name + ' (' + r.n_docs + ' docs)');
      console.log('# tokens: ' + r.query_tokens.join(' '));
      if (!r.matches.length) { console.log('(no matches)'); return; }
      r.matches.forEach((m, i) => {
        console.log('\n[' + (i + 1) + '] score=' + m.score + '  ' + m.path);
        console.log('    ' + m.excerpt);
      });
      return;
    }
    case 'attach': {
      const ap = args[1];
      if (!ap) { console.error('rag attach <artifact.kolm> --index <name>'); process.exit(1); }
      const indexName = pickFlag(args, '--index');
      if (!indexName) { console.error('--index <name> required'); process.exit(1); }
      const apResolved = path.isAbsolute(ap) ? ap : (fs.existsSync(ap) ? path.resolve(ap) : path.join(ARTIFACTS_DIR, ap));
      const r = rag.attachIndexToArtifact({ artifactPath: apResolved, indexName });
      console.log('ok  attached ' + r.index + ' to ' + r.artifact);
      console.log('    sidecar: ' + r.sidecar);
      return;
    }
    case 'list': {
      const idxs = rag.listIndexes();
      if (!idxs.length) { console.log('(no indexes — try: kolm rag index <dir>)'); return; }
      for (const m of idxs) {
        console.log(m.name.padEnd(24) + '  ' + m.n_docs + ' docs  ' + (m.size_bytes / 1024).toFixed(1) + 'KB  ' + m.root);
      }
      return;
    }
    default:
      console.error('unknown rag subcommand: ' + sub);
      usage('rag');
      process.exit(1);
  }
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
      case 'init':     await cmdInit(rest); break;
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
      case 'install':  await cmdInstall(rest); break;
      case 'tune':     await cmdTune(rest); break;
      case 'rag':      await cmdRag(rest); break;
      case 'doctor':   await cmdDoctor(rest); break;
      case 'logs':     await cmdLogs(rest); break;
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
