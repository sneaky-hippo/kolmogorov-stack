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
//   kolm eval <art.kolm>                re-run evals, recompute this artifact's K-score
//   kolm score <art.kolm>               print this artifact's K-score only (per-artifact, not per-model)
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
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const VERSION = '0.2.3';
const HOME = os.homedir();
const KOLM_DIR = path.join(HOME, '.kolm');
const CONFIG_PATH = path.join(KOLM_DIR, 'config.json');
const ARTIFACTS_DIR = path.join(KOLM_DIR, 'artifacts');

// Canonical exit codes. Use these instead of bare process.exit(1).
//   OK              - success
//   BAD_ARGS        - unknown command / unknown flag / missing required arg / "usage:" errors
//   GATE_FAIL       - artifact built but K-score below gate (CI-actionable)
//   MISSING_PREREQ  - environment-level miss (no docker, no api key, not logged in)
//   EXECUTION       - the command ran but failed at runtime (run/eval/distill threw)
//   NOT_FOUND       - file/artifact/resource not present on disk or server
const EXIT = {
  OK: 0,
  BAD_ARGS: 1,
  GATE_FAIL: 2,
  MISSING_PREREQ: 3,
  EXECUTION: 4,
  NOT_FOUND: 5,
};

// Error-context wrapper. Wraps a cmd* invocation so any thrown error gets
// prefixed with `[kolm <verb>]` and an optional hint line for common patterns.
// The wrapper does NOT swallow exit codes: if the thrown error carries an
// `.exitCode` matching an EXIT.* constant, the top-level catch in main()
// honors it. If a cmd* function calls process.exit() directly, the wrapper
// never sees it (by design — those paths print their own context already).
//
// Hints fire on:
//   ENOENT + path that looks like a .kolm artifact -> suggest `kolm inspect`
//   HTTP 401 / "auth_required" -> suggest `kolm login`
//   "not signed in" message  -> suggest `kolm login`
function errorHint(verb, err) {
    const msg = String(err && err.message || '');
    const code = err && err.code;
    // HTTP 401 from api() throws set .status = 401.
    if (err && err.status === 401) {
        return 'hint: not signed in. run `kolm login` or set KOLM_API_KEY.';
    }
    if (/auth_required|not signed in|unauthori[sz]ed/i.test(msg)) {
        return 'hint: run `kolm login` to authenticate.';
    }
    if (code === 'ENOENT' && /\.kolm\b/.test(msg)) {
        return 'hint: list available artifacts with `kolm logs` or check ~/.kolm/artifacts/.';
    }
    if (/artifact not found/i.test(msg)) {
        return 'hint: try `kolm inspect <id>` or list artifacts under ~/.kolm/artifacts/.';
    }
    return null;
}

async function withErrorContext(verb, fn) {
    try {
        return await fn();
    } catch (e) {
        const original = e && e.message ? e.message : String(e);
        const wrapped = `[kolm ${verb}] ${original}`;
        const hint = errorHint(verb, e);
        const out = new Error(hint ? `${wrapped}\n${hint}` : wrapped);
        // Preserve original error metadata so the global catch + KOLM_DEBUG keep working.
        if (e && e.stack) out.stack = e.stack;
        if (e && e.status != null) out.status = e.status;
        if (e && e.code != null) out.code = e.code;
        if (e && e.body != null) out.body = e.body;
        // Preserve / default exitCode so main() can honor EXIT.* semantics.
        if (e && Number.isInteger(e.exitCode)) out.exitCode = e.exitCode;
        throw out;
    }
}

function ensureDir() {
  fs.mkdirSync(KOLM_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function loadConfig() {
  ensureDir();
  let c;
  if (!fs.existsSync(CONFIG_PATH)) {
    c = {};
  } else {
    try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { c = {}; }
  }
  // Env vars override on every load so KOLM_BASE / KOLM_API_KEY work even when
  // a stale config file is on disk (the docs in HELP._root promise this).
  if (process.env.KOLM_BASE) c.base = process.env.KOLM_BASE;
  if (process.env.KOLM_API_KEY) c.api_key = process.env.KOLM_API_KEY;
  if (!c.base) c.base = 'https://kolm.ai';
  if (!('api_key' in c)) c.api_key = null;
  return c;
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
// NO_COLOR-aware ANSI helper. Respects the cross-language NO_COLOR convention
// (https://no-color.org), TERM=dumb, and non-tty stdout (pipes, CI, file
// capture). Existing hand-coded \x1b[ escapes elsewhere in the file are left
// alone — call sites that want gated color use color('1;32', 'PASS').
const SUPPORTS_COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
function color(code, s) { return SUPPORTS_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s; }

function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / (1024 * 1024)).toFixed(1) + 'MB';
}

// K-score is per-artifact (not per-model): each .kolm gets its own score from
// its own frozen eval set. The header always names the file so buyers can't
// confuse this with a leaderboard for the base model underneath.
//
// fmtKScoreLine returns the single header line shared across compile / verify
// / score / eval / diff / improve. The format is fixed so different verbs feel
// like one product: "K-score for <file>: <composite> (gate >= 0.85 - pass|fail)".
function kGate() {
  const env = Number(process.env.KOLM_K_GATE);
  if (Number.isFinite(env) && env >= 0 && env <= 1) return env;
  return 0.85;
}
function fmtKScoreLine(k, artifactName) {
  if (!k) return '(no k-score on this artifact)';
  const composite = typeof k.composite === 'number' ? k.composite.toFixed(3) : k.composite;
  const gate = kGate();
  const gateLbl = gate.toFixed(2);
  const ships = (typeof k.composite === 'number') ? (k.composite >= gate ? 'pass' : 'fail') : null;
  return artifactName
    ? `K-score for ${artifactName}: ${composite}${ships ? `  (gate >= ${gateLbl} - ${ships})` : ''}`
    : `K-score (for this artifact, not the base model): ${composite}${ships ? `  (gate >= ${gateLbl} - ${ships})` : ''}`;
}

function fmtKScore(k, artifactName) {
  if (!k) return '(no k-score on this artifact)';
  return [
    fmtKScoreLine(k, artifactName),
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
  signup --email <addr>            provision a tenant + API key from the CLI
  login [--key ks_...]             save an API key to ~/.kolm/config.json
  whoami                           echo current tenant + plan + base
  new <name> [--from <template>]   scaffold a spec.json you can compile
  build <name> [--from <tpl>]      one-shot: new + seeds + compile + verify (the fastest path)
  compile "<task>" [opts]          cloud-compile a task into a .kolm artifact
  compile --spec <file|->           offline build from a JSON spec (any author, AI included)
  train --spec <file>              alias for compile from a spec (training entry point)
  train --namespace <n>            alias for distill (after capture)
  seeds <sub>                      local-first training-data helpers (new|generate|list|bootstrap)
  anonymize <file.jsonl> [opts]    shortcut for 'seeds generate --strategy redact-pii-templated'
  run <art.kolm> '<input>'         execute a .kolm against an input
  eval <art.kolm>                  re-run embedded evals, print this artifact's K-score
  bench <art.kolm> [opts]          emit artifact benchmark JSON (alias: benchmark)
  score <art.kolm>                 print this artifact's K-score (per-artifact, not per-model)
  list                             show every local .kolm artifact (alias: ls)
  inspect <art.kolm>               manifest + recipes + signature
  diff <a.kolm> <b.kolm>           compare two artifact manifests (cid, K, recipe, etc.)
  export <art.kolm> [opts]         convert a .kolm to GGUF / MLX / ONNX / CoreML / TensorRT (--preview = forecast JSON, no toolchain)
  verify <art.kolm> [--binder out.html]  full verification + optional printable compliance binder
  improve <art-id> [--epsilon n]   re-distill from low-confidence captures; swap only on K improvement
  instant "<task>" [--n 64]        synthesise a recipe from a one-line task (requires teacher)
  models <sub>                     local model registry (list|info|recommend|pin|devices)
  gpu <sub>                        accelerator probe (detect|doctor|setup|stress)
  serve [--mcp] [--http] [--port]  expose ~/.kolm/artifacts/* as MCP tools
  publish <art.kolm> [--public]    push a .kolm to the verifiable hub (handle: <owner>/<name>)
  pull <owner>/<name>[@sha:...]    download a published artifact (SHA-256 pin verified if given)
  hub list|show                    browse the public artifact gallery (alias: kolm hub)
  capture --provider <p> --as <t>  configure a drop-in proxy for OpenAI/Anthropic
  capture status [--namespace <n>] pairs captured / pairs until distill
  labels [--namespace <n>] [--out] download the captured corpus as JSONL
  distill --namespace <n>          auto-distill the namespace into a local LoRA
  install <harness> [--apply]      wire kolm MCP into Claude Code / Cursor / Continue / Cline
  tune <sub>                       evolve a local adapter (init|capture-on|step|eval|promote|watch)
  rag <sub>                        airgapped local lookup (index|query|attach|list)
  team <sub>                       multi-tenant workspaces (create|list|show|invite|accept|members|role|remove)
  tunnel <sub>                     remote access to a self-hosted .kolm (new|list|start|close)
  cloud <sub>                      real GPU train + BYOC deploy (train|targets|deploy|list|show|destroy)
  airgap <sub>                     hard-offline mode (status|enable|disable|verify)
  compute <sub>                    where training runs (list|detect|pick|use|info|test|status)
  doctor                           sanity-check env (config, cloud, docker, project)
  logs [--limit n] [--artifact x]  tail local run history (~/.kolm/logs/runs.jsonl)
  ask "<question>"                 natural-language gateway: status, builds, install, compile, upgrade
  chat                             interactive natural-language session (airgap-safe)
  config [base|api_key] [value]    inspect or set config
  completion <bash|zsh|fish>       emit a shell completion script for the requested shell
  upgrade                          check for a newer kolm release (does not install)
  update                           self-install the latest kolm from github (one-shot, no reinstall)
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
  ask: `kolm ask - ask in plain English. Routes through the deterministic
natural-language assistant (no LLM round-trip). Useful when you don't remember
the exact verb-noun grammar.

USAGE
  kolm ask "<your question>"
  kolm "<your question>"             (also works — auto-detected)

EXAMPLES
  kolm ask "what's my status"
  kolm ask "show my builds"
  kolm ask "compile a recipe that redacts secrets"
  kolm ask "install claude-code"
  kolm ask "how much have i used this month"
  kolm ask "upgrade to pro"

The server-side intent parser is deterministic and rule-based (never an LLM,
never your data leaving) and returns a narration + concrete next steps.
`,
  chat: `kolm chat - interactive natural-language session that EXECUTES commands.

USAGE
  kolm chat [--airgap] [--once "<prompt>"] [--yes] [--json]

DESCRIPTION
  Open an interactive natural-language session with kolm. When you ask it
  to DO something ("make a redactor for medical notes", "anonymize my
  customer data", "upgrade kolm"), chat now runs the matching kolm
  subcommand for you. Informational asks ("show my key", "what artifacts
  do I have") keep the existing narration-only behavior.

  Before running a destructive or expensive command chat prints the exact
  argv it is about to execute and asks for confirmation. Default is yes.
  Pass --yes to auto-confirm, or set KOLM_CHAT_AUTO=1. In --once mode chat
  auto-confirms (non-interactive shells cannot read a prompt).

  Airgap mode (--airgap or KOLM_AIRGAP=1) keeps chat narration-only and
  never shells out, so it stays deterministic on an air-gapped machine.

FLAGS
  --airgap, --offline       narration-only, no shell-out, no cloud calls
  --once "<prompt>"         non-interactive single-prompt mode (auto-confirms)
  --yes, -y                 skip the [Y/n] confirmation prompt before actions
  --json                    machine-readable JSON output (with --once)

SLASH COMMANDS (interactive mode)
  /help                     show this menu
  /exit, /quit              leave the session
  /clear                    clear the screen
  /airgap                   toggle airgap mode mid-session
  /yes                      toggle auto-confirm mid-session

ENVIRONMENT
  KOLM_AIRGAP=1             same as --airgap, useful for air-gapped CI
  KOLM_CHAT_AUTO=1          same as --yes, useful for unattended scripts
  KOLM_BASE=https://...     override the assistant endpoint

EXAMPLES
  kolm chat                                       start an interactive session
  kolm chat --once "make a redactor for medical notes" --yes
  kolm chat --once "anonymize my customer data"   prompts then runs kolm seeds generate
  kolm chat --once "upgrade kolm" --yes           runs kolm upgrade for you
  kolm chat --once "show my key"                  narrates (informational, no shell-out)
  kolm chat --airgap                              force offline, narration-only

NOTES
  Actionable intents (new, compile, run, seeds generate, upgrade, doctor)
  dispatch to the matching cmd* function with rebuilt argv. Informational
  intents (status, usage, list, whoami, help) keep their narration. In
  --airgap mode every intent is narration-only.
`,
  login: `kolm login - save an API key to ~/.kolm/config.json.

USAGE
  kolm login                       interactive paste prompt
  kolm login --key ks_...          non-interactive (CI, scripts, mobile copy-paste)
  echo ks_... | kolm login         non-interactive via stdin

The key is stored at ~/.kolm/config.json (mode 0600). Get a key at https://kolm.ai/signup
or run \`kolm signup --email you@example.com\` to provision one without the web flow.
`,
  signup: `kolm signup - provision a new tenant + API key from the CLI.

USAGE
  kolm signup --email you@example.com
  kolm signup --email you@example.com --name "Your Name" --plan free

OPTIONS
  --email, -e <addr>     required when stdin is not a TTY
  --name, -n  <text>     optional display name
  --plan      <id>       free | starter | pro | teams | enterprise (default: free)

On success: the api_key is saved to ~/.kolm/config.json (mode 0600) and printed
truncated. Paid plans also return a Stripe billing URL you can open in a browser.
`,
  whoami: `kolm whoami - echo the current tenant + plan + cloud base.

USAGE
  kolm whoami [--json]

Hits GET /v1/account with the saved API key and prints the tenant id, plan,
quota, seats, and the kolm cloud base URL. With --json, emits the raw account
envelope so scripts can parse it.

Exit codes:
  0   logged in, account fetched
  1   not logged in (no api_key in ~/.kolm/config.json or KOLM_API_KEY env)
  2   logged in but cloud rejected the key (rotated, revoked, or wrong base)
`,
  train: `kolm train - build a .kolm artifact from a spec or distill a captured namespace.

USAGE
  kolm train --spec <file.json> [--out <path>]   offline build from a JSON spec
  kolm train --namespace <n> [--base-model <m>]  distill the captured namespace

OPTIONS (--spec mode)
  --spec <file>                JSON spec written by you or 'kolm new'
  --out <dir|file.kolm>        where to drop the artifact (default ~/.kolm/artifacts)
  --base-model <name>          base model name embedded in the manifest

OPTIONS (--namespace mode)
  --namespace, -n <n>          the namespace captured via 'kolm capture'
  --base-model <name>          base model (default: Qwen/Qwen2.5-3B-Instruct)
  --target, --target-size <s>  target artifact size (default: phi-3-mini)

The two modes are aliases for 'kolm compile --spec' and 'kolm distill --namespace'.
The verb 'train' exists because that's what most buyers expect to type. The actual
job is the same.

EXAMPLES
  kolm train --spec phi-redactor.spec.json
  kolm train --namespace claims-router --base-model Qwen/Qwen2.5-7B-Instruct
`,
  compile: `kolm compile - build a .kolm artifact (cloud-synthesised or local spec).

USAGE
  kolm compile "<task>" [opts]                  cloud compile from a task description
  kolm compile --spec <file.json> [--out <p>]   offline build from a JSON spec
  kolm compile --spec - [--out <p>]             offline build from JSON on stdin

OPTIONS (cloud)
  --data <dir>                 corpus dir to ground the compile in (Recall)
  --base-model <name>          base model (default: Qwen/Qwen2.5-3B-Instruct)
  --examples <file.jsonl>      seed examples for the verifier
  --out <dir|file.kolm>        where to drop the artifact (default ~/.kolm/artifacts)
  --deploy-hook <https-url>    POST {job_id,artifact_url,k_score,...} to this webhook
                               after a successful compile. Use for Vercel Deploy
                               Hooks, GitHub repository_dispatch, or any webhook.
                               Falls back to $KOLM_DEPLOY_HOOK_URL.

OPTIONS (spec)
  --spec <file|->              JSON spec describing recipes + evals + optional pack/index
  --out <file.kolm|dir>        output path (.kolm) or directory; default ~/.kolm/artifacts
  --examples <file.jsonl>      merge external eval rows into spec.evals.cases
  --gate <n>                   K-score gate override (default 0.85). Use --gate 0.75 to
                               accept lower-scoring artifacts; --gate 0.95 for stricter.
                               Compile still emits the artifact; the gate verdict line
                               (pass|fail) reflects this threshold. EXIT CODES: 0 = pass,
                               2 = gate fail (artifact on disk, do not promote in CI).

RECIPE SOURCE - two ways to author
  Inline:    "recipes": [{ "source": "function generate(input, lib) {...}" }]
  Sidecar:   "recipes": [{ "source_file": "./recipe.js" }]
  source_file is resolved relative to the spec file. Use it to author JS in a
  real editor with linting/highlighting instead of escaping a one-line string
  inside JSON. If both fields exist on the same recipe, "source" wins.

FORBIDDEN IDENTIFIERS (sandbox guard, scanned in recipes[].source)
  process, require, module, global, globalThis, __dirname, __filename,
  import(, Function(, eval(, constructor, prototype, ArrayBuffer,
  SharedArrayBuffer, Atomics, Reflect, Proxy, WeakRef, FinalizationRegistry,
  setTimeout, setInterval, setImmediate, queueMicrotask
  These tokens are blocked because they enable sandbox escape from node:vm.
  Recipes operate on the frozen \`lib\` argument only - no Node, no DOM, no
  network. Workarounds:
    - Object.prototype.hasOwnProperty.call(x,k)  -> use \`k in x\` or Object.hasOwn(x, k)
    - process.env.X                              -> not available; pass via lib.params
    - require('node:crypto')                     -> use lib.hash (sha-256 helper)

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
  kolm new <name> [--from <template>] [--out <file>] [--force] [--yes]

TEMPLATES
  --from summarizer   deterministic sentence-pick summarizer (no LLM, ships working)
  --from redactor     identifier redactor (regex pack + tenant extras)
  --from extractor    structured-field extractor (regex rules pack)
  --from classifier   keyword-weighted classifier (categories pack)
  --from blank        STUB - echoes input back unchanged; replace recipes[0].source before shipping

FLAGS
  --out <file>        write to this exact path. Errors if the file exists (no auto-bump).
  --force             overwrite the output path silently (works with --out or the default).
  --yes, -y           in interactive shells, skip the "use blank?" confirmation prompt.
                      Also honors KOLM_AUTO_YES=1 in the environment.

If --from is omitted and the name hints at a task (summari*, redact*, classif*,
extract*) kolm picks a matching template. Otherwise the blank stub is used; a
warning is printed when the blank stub is selected and (in a TTY) you'll be
asked to confirm so you don't accidentally ship an echo.

If <name>.spec.json already exists and --out wasn't passed, kolm auto-bumps to
<name>-2.spec.json, <name>-3.spec.json, ... up to <name>-10.spec.json and prints
a note. Pass --force to overwrite, or --out <path> to choose explicitly.

The output is a JSON file at <name>.spec.json that you can compile with:
  kolm compile --spec <name>.spec.json --out <name>.kolm
`,
  build: `kolm build - one-shot wrapper: scaffold + seed + compile + verify.

USAGE
  kolm build <name> [--from <template>] [--examples <file>] [--out <file>]

Compresses the four-step new -> seeds new -> compile -> verify chain into one
command. Use this for a first run on a new task. After it prints the K-score
and failing-case breakdown, edit recipes[0].source in <name>.spec.json or your
expected outputs in seeds.jsonl, and rerun kolm compile.

TEMPLATES
  --from summarizer | redactor | classifier | extractor | blank
  (auto-picked from <name> if you skip --from)

FLAGS
  --examples <file>  JSONL of {"input":..., "expected":...} or {"input":..., "output":...}
                     rows. If omitted, kolm scaffolds seeds.jsonl from the template.
  --out <file>       artifact path (default: <name>.kolm)
  --force            overwrite existing spec at <name>.spec.json
  --yes, -y          skip the "use blank?" confirmation prompt

EXAMPLE
  kolm build my-redactor --from redactor
  kolm build triage --from classifier --examples my-tickets.jsonl
`,
  run: `kolm run - execute a .kolm artifact locally.

USAGE
  kolm run <artifact.kolm> --input <file|->                read input from file or stdin (recommended)
  kolm run <artifact.kolm> '<input-json>' [--params ...]   pass input inline as JSON
  cat input.json | kolm run <artifact.kolm>                stdin auto-detected when no positional input

WINDOWS QUOTING NOTE
  Windows cmd.exe does NOT honor single quotes, and PowerShell expands $ inside
  double-quoted JSON. The portable form is --input @sample.json (or piped stdin):
    PS> echo {"text":"hi"} > in.json
    PS> kolm run x.kolm --input in.json
  Or use bash/zsh/git-bash where 'single-quoted JSON' works as written.

The input is parsed as JSON when possible; otherwise passed as a bare string.
--input lets you skip shell-quoting pain on Windows cmd — pass a file path or
'-' for stdin instead. --params lets you
pass tenant-runtime config to the recipes (extra patterns, allowlists, vertical
rules). Recipes read these via lib.params. Tenant params are never persisted by
the runtime and never re-signed into the artifact.

Default output is the recipe's output only (pretty JSON, or string), with a
one-line footer on stderr: 'recipe: <id>  ·  <latency>'. Pipes cleanly:
  kolm run x.kolm 'foo' | jq .
Pass --json for the full doc (output + recipe + latency_us + k_score + receipt
+ audit) as a single parseable JSON document — used by CI and agents that need
everything.

EXAMPLES
  kolm run redactor.kolm '{"text":"call 555-1212"}'
  kolm run redactor.kolm --input @sample.json
  cat sample.json | kolm run redactor.kolm
  kolm run redactor.kolm '{"text":"call 555-1212"}' --json
  kolm run redactor.kolm '{"text":"id 12-345"}' --params '{"extra_patterns":[{"name":"emp_id","regex":"\\\\b\\\\d{2}-\\\\d{3}\\\\b","replacement":"[ID]"}]}'
  kolm run redactor.kolm '{"text":"..."}' --params @hospital-rules.json
`,
  eval: `kolm eval - re-run a .kolm's embedded eval set and show per-case results.

K-score is per-artifact: each .kolm has its own eval set and its own number.
This command re-runs THIS artifact's evals and prints THIS artifact's pass/fail
breakdown plus what each failing case got vs what was expected.

USAGE
  kolm eval <artifact.kolm> [--examples <file>] [--trace] [--json]

FLAGS
  --examples <file>  eval against a fresh JSONL of {"input":..., "expected":...}
                     rows (also accepts "output" in place of "expected"). Use
                     this to A/B an artifact against real holdout data without
                     recompiling — the embedded eval set is bypassed.
  --trace            show every failing case (default: first 5)
  --json             emit the full machine-readable doc (used by CI / agents)

EXAMPLE
  kolm eval my-redactor.kolm
  kolm eval my-redactor.kolm --examples holdout.jsonl
  kolm eval my-redactor.kolm --trace
  kolm eval my-redactor.kolm --json > eval-report.json
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
  score: `kolm score - print this artifact's K-score (per-artifact, not per-model).

USAGE
  kolm score <artifact.kolm>
`,
  list: `kolm list - show every local .kolm artifact (alias: kolm ls).

USAGE
  kolm list [--json]

SCANS
  ~/.kolm/artifacts/     global, where 'kolm compile' writes by default
  ./.kolm/artifacts/     project-scoped (when a kolm.yaml sits at cwd)
  ./                     current dir, picks up 'kolm build' outputs

The default output is a table: name, K-score, size, age, source.
--json emits a machine-readable array (script-friendly).
`,
  inspect: `kolm inspect - show what a .kolm artifact is, in plain text.

USAGE
  kolm inspect <artifact.kolm>          human-readable summary (task, K-score, build time, signature)
  kolm inspect <artifact.kolm> --json   full manifest dump (CI / agent shape)

Text mode is the default. --json keeps the old behaviour for scripts that
parse the full manifest (recipe names, pack/index keys, signature mode, etc.).
`,
  export: `kolm export - convert a .kolm into a target-runtime artifact (gguf, mlx, onnx, coreml, tensorrt).

USAGE
  kolm export <artifact.kolm> --backend <name> [opts]              full export (toolchain required)
  kolm export <artifact.kolm> --preview --device <name> --quant <q>  forecast JSON only (no toolchain)

BACKENDS
  gguf       llama.cpp / Ollama / LM Studio (ARM, x86, Vulkan, CUDA via llama.cpp)
  mlx        Apple Silicon (mlx_lm; M1/M2/M3 family)
  onnx       Windows / generic edge / Android via ONNX Runtime Mobile
  coreml     iPhone / iPad / Mac (Neural Engine)
  tensorrt   NVIDIA serving (Ampere or newer recommended)

OPTIONS (export)
  --backend <name>             one of the backends above (required)
  --out <dir>                  output directory (default ./exports)
  --quant <q4_k_m|q5_k_m|q8_0|f16|int4|int8|fp16>   quantization tier (backend-specific)
  --base-model <hf-id>         override the manifest's base model id
  --opset <n>                  onnx opset version
  --quantize / --q4            mlx q4 quantize flag

OPTIONS (preview)
  --preview                    do not run the toolchain; emit forecast JSON to stdout
  --device <name>              target device label (see /device-transfer for the picker)
                                supported keys: pi5-4, pi5-8, jetson-orin-nano, jetson-agx-32,
                                jetson-agx-64, steam-deck, m3-pro, m3-max, snapdragon-x-elite,
                                rtx-4090, iphone-15-pro, pixel-8
  --quant <q>                  one of: fp16 | int8 | int4 (default int4) | int3
  --base <key>                 source base key. supported: llama-3.1-8b, llama-3.2-3b,
                                llama-3.2-1b, phi-3-mini, mistral-7b. defaults to inferred
                                from the .kolm manifest, or to llama-3.2-3b if no artifact is
                                provided.
  --json                       emit JSON (default when --preview is set)

PREVIEW OUTPUT
  {
    "device":                "M3 Pro MacBook Pro (18GB)",
    "quant":                 "int4",
    "size_mb":               1741,
    "estimated_latency_ms":  33.3,
    "tok_per_s":             30,
    "k_loss":                -0.02,
    "k_score_est":           0.910,
    "fits":                  true,
    "backend":               "mlx"
  }

The preview path runs in pure JS using the same lookup table as /device-transfer
on the web. It does NOT touch python / llama.cpp / mlx_lm / optimum / trtllm. If
the artifact path resolves on disk, the manifest is consulted for an inferred
base; otherwise the --base flag (or default) is used.

EXAMPLES
  kolm export job_xy.kolm --backend gguf --quant q4_k_m --out ./out
  kolm export your-artifact.kolm --backend mlx --quantize
  kolm export job_xy.kolm --preview --device m3-pro --quant int4
  kolm export --preview --device pi5-4 --quant int4 --base llama-3.2-3b
`,
  verify: `kolm verify - run every offline check kolm makes about an artifact
and (optionally) emit a printable HTML compliance binder a security reviewer
signs off on before a deploy.

USAGE
  kolm verify <artifact.kolm> [--binder out.html] [--json]

WHAT GETS CHECKED
  * manifest signature (legacy HMAC over manifest.json)
  * content identifier round-trip (recompute CID from manifest.hashes)
  * 5-step HMAC audit chain (task -> seeds -> recipes -> evals -> package)
  * receipt body signature (binds artifact_hash + eval_set_hash + chain)
  * provenance credential (kolm-credential/0.1)
  * K-score gate (composite >= 0.85 by default)
  * eval coverage (case count + judge id)

OUTPUT
  Plain mode prints one line per check + verdict. --json emits a machine-readable
  block for CI / SBOM tooling. --binder writes the full HTML report to the path
  you give it; open it in any browser, print or "Save as PDF" for the auditor.

EXIT CODES
  0  every check passed (warnings are still 0)
  4  one or more checks failed
  5  artifact not found
`,
  serve: `kolm serve - expose .kolm artifacts as MCP tools or as an HTTP server.

USAGE
  kolm serve --mcp [--port <n>]                     # frontier-agent transport
  kolm serve --http <art.kolm> [--port <n>] [--host H]  # OpenAI-compatible HTTP

WHAT EACH MODE GIVES YOU
  --mcp   : Every artifact in ~/.kolm/artifacts/ becomes a tool that
            Claude Code / Cursor / Continue can call. Microsecond pattern-match
            execution. No GPU needed.
  --http  : One generative artifact gets served via vLLM (preferred) or
            transformers as an OpenAI-compatible /v1/chat/completions endpoint.
            Speculative decoding via the artifact's declared draft model.
            FP8 KV cache on Hopper/Blackwell. AWQ/GPTQ weights work when the
            artifact's base model is already quantized.

EXAMPLES
  kolm serve --mcp                                  # what Claude Code sees
  kolm serve --http job_foo.kolm --port 8765        # local OpenAI server
  KOLM_FORCE_TRANSFORMERS=1 kolm serve --http foo.kolm  # skip vLLM, use HF only

ENV
  KOLM_MAX_MODEL_LEN              vLLM max_model_len (default 8192)
  KOLM_NUM_SPECULATIVE_TOKENS     vLLM speculative tokens (default 5)
  KOLM_FORCE_TRANSFORMERS=1       prefer transformers.generate() over vLLM
  KOLM_LORA_DIR                   where to extract LoRA packs (default ~/.kolm/lora)
`,
  publish: `kolm publish - upload a .kolm artifact to the hub.

USAGE
  kolm publish <artifact.kolm> [--name <name>] [--public|--private]

The hub is a verifiable artifact gallery: every published .kolm has a SHA-256
fingerprint, a K-score, and a handle of the form <owner>/<name>. Default
visibility is private (only you can see it); --public makes it discoverable.

REQUIRES
  signed in (kolm signup or kolm login)

EXAMPLE
  kolm publish phi-redactor.kolm --public
  # ok  published
  # handle:    rodney/phi-redactor@sha256:7c0a3f9e
  # url:       https://kolm.ai/v1/hub/rodney/phi-redactor

  # someone else, anywhere:
  kolm pull rodney/phi-redactor
`,
  pull: `kolm pull - download a .kolm artifact from the hub by handle.

USAGE
  kolm pull <owner>/<name>[@sha256:<hex>] [--out <path>]

SHA-256 pin (the @sha256: suffix) is optional but recommended for CI: if the
hub-stored bytes ever drift from the pinned digest, the pull fails with exit
code 5 instead of writing a tampered artifact.

EXAMPLE
  kolm pull rodney/phi-redactor
  kolm pull rodney/phi-redactor@sha256:7c0a3f9e --out ./fresh.kolm
`,
  hub: `kolm hub - browse the public artifact gallery.

USAGE
  kolm hub list [--q <search>] [--limit 50] [--json]
  kolm hub show <owner>/<name> [--json]

EXAMPLE
  kolm hub list                          # most-recent 50 public artifacts
  kolm hub list --q redactor             # search by name / task / tags
  kolm hub show rodney/phi-redactor      # full metadata for one artifact
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
  --base-model Qwen/Qwen2.5-3B-Instruct
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

  completion: `kolm completion - emit a shell completion script.

USAGE
  kolm completion <bash|zsh|fish>

EXAMPLES
  Bash:  kolm completion bash >> ~/.bashrc
  Zsh:   kolm completion zsh > ~/.zsh/completions/_kolm
  Fish:  kolm completion fish > ~/.config/fish/completions/kolm.fish

The script wires up tab completion for every top-level verb (kolm <TAB>) and
second-level subcommands for compute, airgap, team, tunnel, cloud, tune, rag,
capture, install, completion, models, gpu, and seeds.

After installing, restart your shell or source the file.
`,
  upgrade: `kolm upgrade - check for a newer kolm release.

USAGE
  kolm upgrade [--json]

FLAGS
  --json                emit { current, latest, status } as JSON

EXAMPLES
  kolm upgrade                     # human-readable check
  kolm upgrade --json | jq .status # script-friendly

Reads the current version from package.json. Fetches the latest version from
the canonical install source (github.com/sneaky-hippo/kolmogorov-stack main
branch package.json) with a 5s timeout. If a newer version is available, it
prints the upgrade command. It does NOT auto-upgrade (too many footguns).

The canonical install is "npm i -g github:sneaky-hippo/kolmogorov-stack", NOT
the unrelated "kolm" package on the public npm registry.

Status values: current, outdated, unknown (network or github unavailable).
`,
  update: `kolm update - self-install the latest kolm from the canonical github source.

USAGE
  kolm update [--dry-run] [--json]

FLAGS
  --dry-run             print the command that would run, do not install
  --json                emit { source, before, after, status } as JSON

EXAMPLES
  kolm update                      # install latest from github
  kolm update --dry-run            # preview only
  kolm update --json | jq .status  # script-friendly

Runs \`npm i -g github:sneaky-hippo/kolmogorov-stack\` against the npm on PATH,
streaming its output. On windows we shell through \`cmd /c\` so npm.cmd resolves.
Exits non-zero if npm fails (usually a perms issue - try sudo or admin shell).

Distinction: kolm upgrade only checks for a newer release. kolm update actually
installs it. The github source bypasses the npm registry (the bare \`kolm\` name
on npm is squatted), which is also the install path documented in README.md.
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
  seeds: `kolm seeds - honest, local-first training-data helpers.

USAGE
  kolm seeds new <name>                                 scaffold a seeds.jsonl with starter rows
  kolm seeds validate <file>                            shape + parseability check before compile
  kolm seeds generate --from <file> --count <N> [opts]  rule-based mutate seeds into N rows
  kolm seeds list                                       list files under ~/.kolm/seeds with counts
  kolm seeds bootstrap --task <name>                    install a public-domain starter dataset

NEW
  Templates: phi-redactor, ticket-classifier, invoice-extractor, generic
  Writes to ./seeds.jsonl in the current directory (refuses to overwrite).

GENERATE
  --from <file>            jsonl input. each row is {"input": "...", "output": "...", ...}
  --count, -n <N>          target row count (>= number of input seeds)
  --strategy <name>        templated (default) | redact-pii-templated | classify-mutate
                           | extract-permute | local-llm
  --seed-rng <int>         PRNG seed for reproducible output (default: 1)
  --out <path>             output jsonl path (default: ~/.kolm/seeds/expanded-<ts>.jsonl)
  --local-llm-url <url>    only used with --strategy local-llm. must be localhost (127.0.0.1, ::1).
                           default: http://localhost:11434 (ollama)
  --local-llm-model <name> model name for local-llm strategy
  --yes, -y                skip the local-llm confirmation prompt (CI usage)
  --json                   emit a single-line summary JSON instead of human text

Every generated row carries provenance:
  {"input": "...", "output": "...", "source": "templated|seed|public|local-llm", "from_seed": N}

The train loop later reports K-score broken out by source so a templated row is never
counted as ground truth. We never call a third-party API. local-llm strategy only
hits localhost (validated) and is opt-in.

BOOTSTRAP
  --task <name>            phi-redactor (shipped) | email-classifier (coming) | invoice-fields (coming)
  --out <path>             where to copy the dataset (default: ~/.kolm/seeds/<task>.jsonl)

Bootstrap datasets are PUBLIC seed data shipped with kolm, not synthetic K-score.
Use to start the train loop, then add your own real examples for a higher K-score.

LIST
  --json                   one-line JSON per file (name, rows, source-mix)

VALIDATE
  Reports row count, detected shape ({input,output} or {input,expected}), and any parse
  errors with line numbers. Catches the CSV-as-JSONL trap before you hit it at compile.

EXAMPLES
  kolm seeds new phi-redactor
  kolm seeds validate ./seeds.jsonl
  kolm seeds generate --from seeds.jsonl --count 200 --strategy redact-pii-templated --seed-rng 42
  kolm seeds bootstrap --task phi-redactor
  kolm seeds list

HONESTY
  We never hallucinate data from thin air. Every strategy requires seeds as input
  (except bootstrap which ships public-domain data). Provenance is recorded on every
  row. Determinism: same --from + --strategy + --seed-rng -> identical bytes.
`,
  anonymize: `kolm anonymize - rule-based PII redaction. Default is 1:1 (N rows in -> N rows out).

USAGE
  kolm anonymize <file.jsonl> [--expand <N>] [--out <path>] [--seed-rng <int>] [--json]

Reads a jsonl of rows (each row at minimum has "input" / "output" fields), permutes
PII (names, emails, MRNs, SSNs, phones, dates, addresses) in each row, and writes
the result to <basename>-anonymized.jsonl by default.

MODES
  default (no flag)        1:1 redaction. N input rows -> N output rows, PII permuted.
                           This is what the verb name suggests; no row expansion.
  --expand <N>             opt in to row-mutation mode. Outputs N rows (>= input count)
                           by mutating the input rows with the redact-pii-templated
                           strategy. Useful when you also need synthetic variations
                           for training-data expansion in one verb call.

DEFAULTS
  --seed-rng    1                       (deterministic; same input + seed -> same bytes)
  --out         <basename>-anonymized.jsonl in the current directory

Every row in the output is tagged source="redacted" (1:1 mode) or "templated" (expand
mode) with a from_seed pointer into the original file. No data is sent over the
network. No LLM is consulted.

For more control (other strategies, different output dir, local-llm mode) call
\`kolm seeds generate\` directly.

CSV INPUTS
  Not supported. Convert to JSONL first (one JSON object per line). kolm anonymize
  will tell you the exact awk one-liner if you pass a .csv file.

EXAMPLES
  kolm anonymize support-tickets.jsonl                      # 1:1, default
  kolm anonymize phi-rows.jsonl --expand 200 --seed-rng 42  # expand mode, 200 rows out
  kolm anonymize raw.jsonl --out clean.jsonl                # 1:1, custom output path
`,
  models: `kolm models - inspect the local model registry (license + size + recommendation).

USAGE
  kolm models list [--family <f>] [--tier <t>] [--license <l>] [--permissive] [--max-vram <gb>] [--json]
  kolm models info <model-id> [--json]
  kolm models recommend --device <key> [--task <t>] [--json]
  kolm models pin <model-id>
  kolm models devices [--json]

LIST FILTERS
  --family       qwen | llama | phi | mistral
  --tier         small | medium | large
  --license      apache-2.0 | mit | llama-3 | research
  --permissive   only Apache/MIT/BSD-style (commercial-friendly)
  --max-vram     max VRAM in GB at 4-bit (e.g. 8)

EXAMPLES
  kolm models list --permissive --max-vram 8
  kolm models info Qwen/Qwen2.5-3B-Instruct
  kolm models recommend --device m3-pro --task redact-pii

Output is pure local lookup. No network calls.
`,
  gpu: `kolm gpu - detect, doctor, and stress-test the local accelerator.

USAGE
  kolm gpu detect [--json]                hardware fingerprint (vendor, vram, drivers)
  kolm gpu doctor [--json]                check torch / cuda / mlx / metal versions vs minimums
  kolm gpu setup                          print the install steps for the detected GPU
  kolm gpu stress [--seconds 30] [--json] run a brief gemm load and report tok/s estimate

EXAMPLES
  kolm gpu detect
  kolm gpu doctor --json | jq '.checks[] | select(.status != "ok")'
  kolm gpu stress --seconds 10

All four subcommands run fully offline. detect uses platform-native probes
(nvidia-smi, system_profiler, /proc/cpuinfo); doctor reports versions only.
`,
  improve: `kolm improve - re-distill an artifact from recent low-confidence captures.

USAGE
  kolm improve <artifact-id-or-path> [--epsilon 0.01] [--dry-run]

FLAGS
  --epsilon <n>   only swap when new K-score > old + epsilon (default: 0.01)
  --dry-run       compile but do not swap; print the new artifact path

The verb walks recent receipts + audit log for the artifact, finds high-
uncertainty rows (teacher-fallback, low confidence), batches them, recompiles,
and only swaps the live artifact if the new K-score beats the current one by
more than --epsilon. Safe to schedule (cron, GitHub Actions).
`,
  instant: `kolm instant - synthesise a recipe from a one-line task description.

USAGE
  kolm instant "<task>" [--n 64] [--teacher MODEL] [--base-model HF_ID]
                        [--schema schema.json] [--out FILE] [--k 0.85] [--compile]

FLAGS
  --n <n>          target pair count (default: 64)
  --teacher <m>    teacher model id (default: qwen-2.5-7b-instruct)
  --base-model <h> base model HuggingFace id (default: Qwen/Qwen2.5-3B-Instruct)
  --schema <f>     optional JSON schema hint for the output shape
  --out <f>        recipe path (default: instant-recipe.json)
  --k <n>          K-score gate (default: 0.85)
  --compile        also send the recipe to /v1/compile after synth

Requires a configured teacher (KOLM_TEACHER_BASE / KOLM_TEACHER_KEY). When the
teacher is unconfigured, status is 'pending' and the verb writes the partial
recipe so you can re-run after configuration.
`,
  diff: `kolm diff - compare two .kolm manifests field by field.

USAGE
  kolm diff <a.kolm> <b.kolm> [--json]

OUTPUT
  Default: a unified-style report (cid, base_model, K-score, task, compliance).
  --json:  a structured delta (a, b, changes[]).

EXIT CODES
  0  diff rendered (changes may be zero)
  1  bad args (missing artifact)
  5  artifact not found

This is the verb you run before a promote / rollback to see what actually
changed between two builds.
`,
  team: `kolm team - multi-tenant workspace management.

USAGE
  kolm team create <name> [--seats N]                create a new team workspace
  kolm team list                                     list teams you belong to
  kolm team show <slug>                              show one team (members, plan, quotas)
  kolm team invite <slug> <email> [--role member|admin|viewer]
  kolm team accept <token>                           accept an invite token
  kolm team members <slug>                           list members
  kolm team role <slug> <tenant_id> <role>           change a member's role
  kolm team remove <slug> <tenant_id>                remove a member
  kolm team transfer <slug> <new_owner_tenant_id>    transfer ownership
  kolm team delete <slug>                            delete a team

All forms require a logged-in session (kolm login).
`,
  tunnel: `kolm tunnel - remote access to a self-hosted .kolm via a signed reverse tunnel.

USAGE
  kolm tunnel new [--name n] [--team <team_id>]          provision a tunnel; prints a public URL + token
  kolm tunnel list                                       list active tunnels
  kolm tunnel start --token <t> --artifact <path>        run the agent that bridges traffic
  kolm tunnel close <token>                              revoke a tunnel

The kolm cloud terminates TLS; your machine runs the agent. No artifact bytes
leave your machine. Requires a logged-in session.

Public URL: https://kolm.ai/r/<token>  (POST JSON, get JSON back)
`,
  cloud: `kolm cloud - real GPU fine-tunes + bring-your-own-cloud deploys.

USAGE
  kolm cloud train <name> [--seeds <f.jsonl>] [--base <model>] [--confirm]
                                           rent a GPU, fine-tune on your seeds, package as .kolm
  kolm cloud targets                       list supported BYOC deploy targets
  kolm cloud deploy --target <t> --artifact <id> [--region r] [--name n] [--team <id>] [--out <path>]
  kolm cloud list                          list deployments
  kolm cloud show <deployment_id>          inspect one deployment
  kolm cloud destroy <deployment_id>       tear down a deployment

TRAIN BACKENDS
  together (default)   managed LoRA fine-tune on Together AI. Set KOLM_TOGETHER_TOKEN.
                       Cost: ~$2-5 for Qwen 2.5 7B on 2k pairs, ~30-45 min.
  runpod, lambda, vast (planned, see kolm compute list)

DEPLOY TARGETS
  fly, aws-nitro, gcp-cvm, azure-cvm, docker

The kolm cloud signs the deploy script; weights + receipts live in your account.
`,
  'cloud train': `kolm cloud train - rent a GPU and run a real LoRA fine-tune.

USAGE
  kolm cloud train <name> [--seeds <path>] [--base <model>] [--target-size 7b]
                          [--epochs 3] [--lora-r 16] [--lora-alpha 32]
                          [--backend together] [--budget <usd>] [--confirm]

EXAMPLES
  # quote cost (no money spent)
  kolm cloud train phi-redactor --seeds seeds.jsonl
  # confirm and run for real
  kolm cloud train phi-redactor --seeds seeds.jsonl --confirm

REQUIRES
  KOLM_TOGETHER_TOKEN env var (or TOGETHER_API_KEY) for the default backend.
  Get one at https://api.together.xyz/settings/api-keys

WHAT HAPPENS
  1. We read your seeds JSONL (each row: {prompt, completion} or {input, output}).
  2. Quote cost up-front based on row count, base model, and epochs.
  3. With --confirm: upload corpus, submit fine-tune, poll, download adapter.
  4. Persist a record to ~/.kolm/artifacts/<name>.cloud-train.json.
  5. Print the Together-hosted model id you can serve from.

NEVER RUNS ON CPU. The backend list deliberately excludes local-cpu so you
can't accidentally burn a week of laptop battery for a model that needs a GPU.
`,
  airgap: `kolm airgap - hard-offline mode (no network egress).

USAGE
  kolm airgap status                     show env state + on-disk artifacts
  kolm airgap enable                     write ~/.kolm/airgap.env (source it in your shell)
  kolm airgap disable                    remove ~/.kolm/airgap.env
  kolm airgap verify <artifact.kolm>     inspect + signature-check entirely offline

Sets TRANSFORMERS_OFFLINE=1, HF_DATASETS_OFFLINE=1, HF_HUB_OFFLINE=1, KOLM_AIRGAP=1.
After 'enable', source the env file in your shell to make every kolm verb in
that session refuse any network call.
`,
  compute: `kolm compute - where training runs (local CPU/GPU, cloud, or hybrid).

USAGE
  kolm compute list                      list known compute targets
  kolm compute detect                    detect the best local target
  kolm compute pick                      interactive picker
  kolm compute use <target>              persist a default in ~/.kolm/config.json
  kolm compute info <target>             cost, latency, and capability summary
  kolm compute test <target>             run a small benchmark on the target
  kolm compute status                    current pin + recent runs

Use 'compute info' before 'compute use' so you know what you are choosing.
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
    task: 'STUB. echoes input back unchanged. REPLACE recipes[0].source with real behavior before you ship.',
    base_model: 'none',
    recipes: [{
      id: 'rcp_main_v1',
      name: 'main recipe (STUB - echoes input)',
      source: [
        '// STUB RECIPE. Replace this body with your real logic.',
        '// Inputs come in as { text: string, ... }; return any JSON-serializable object.',
        '// lib.pack / lib.params / lib.patterns are available - see /docs/AUTHORING.md.',
        'function generate(input, lib) {',
        "  var text = (typeof input === 'string') ? input : (input && input.text) || '';",
        "  return { echoed: String(text), _stub: 'replace recipes[0].source with real logic' };",
        '}',
      ].join('\n'),
      tags: ['stub'],
      schema: { input: { text: 'string' }, output: { echoed: 'string' } },
    }],
    evals: {
      spec: 'rs-1-evals',
      n: 1,
      cases: [
        { id: 'echo', input: { text: 'hello' }, expected: { echoed: 'hello', _stub: 'replace recipes[0].source with real logic' } },
      ],
      coverage: 1.0,
    },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 50 },
  }),

  // Deterministic sentence-pick summarizer. No LLM. No network. Scores each
  // sentence by (word frequency / length) and returns the top-k as a single
  // string. Good enough to demo the happy path without echoing input back.
  summarizer: (jobId) => ({
    job_id: jobId,
    task: 'deterministic sentence-pick summarizer: scores sentences by word frequency and returns the top-k as a summary',
    base_model: 'none',
    recipes: [{
      id: 'rcp_summarizer_v1',
      name: 'sentence-pick summarizer',
      source: [
        'function generate(input, lib) {',
        "  var text = (typeof input === 'string') ? input : (input && input.text) || '';",
        "  if (!text) return { summary: '', sentences_kept: 0, sentences_total: 0 };",
        '  var k = (lib.params && lib.params.k) || 2;',
        '  if (typeof k !== "number" || k < 1) k = 2;',
        '  var stop = { a:1,an:1,and:1,are:1,as:1,at:1,be:1,but:1,by:1,for:1,from:1,had:1,has:1,have:1,he:1,her:1,his:1,i:1,in:1,is:1,it:1,its:1,me:1,my:1,no:1,not:1,of:1,on:1,or:1,our:1,she:1,so:1,that:1,the:1,their:1,them:1,they:1,this:1,to:1,was:1,we:1,were:1,will:1,with:1,you:1,your:1 };',
        '  var sents = text.split(/(?<=[.!?])\\s+/).map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; });',
        '  if (sents.length <= k) return { summary: sents.join(" "), sentences_kept: sents.length, sentences_total: sents.length };',
        '  var freq = {};',
        '  for (var i=0; i<sents.length; i++) {',
        '    var words = sents[i].toLowerCase().replace(/[^a-z0-9 ]+/g," ").split(/\\s+/).filter(Boolean);',
        '    for (var j=0; j<words.length; j++) { var w = words[j]; if (stop[w]) continue; freq[w] = (freq[w]||0) + 1; }',
        '  }',
        '  var scored = sents.map(function(s, idx){',
        '    var words = s.toLowerCase().replace(/[^a-z0-9 ]+/g," ").split(/\\s+/).filter(Boolean);',
        '    var sum = 0, kept = 0;',
        '    for (var j=0; j<words.length; j++) { var w = words[j]; if (stop[w]) continue; sum += (freq[w]||0); kept++; }',
        '    var score = kept > 0 ? sum / Math.sqrt(kept) : 0;',
        '    return { sentence: s, score: score, idx: idx };',
        '  });',
        '  scored.sort(function(a,b){ if (b.score !== a.score) return b.score - a.score; return a.idx - b.idx; });',
        '  var picks = scored.slice(0, k);',
        '  picks.sort(function(a,b){ return a.idx - b.idx; });',
        '  var summary = picks.map(function(p){ return p.sentence; }).join(" ");',
        '  return { summary: summary, sentences_kept: picks.length, sentences_total: sents.length };',
        '}',
      ].join('\n'),
      tags: ['summarization', 'deterministic', 'generic'],
      schema: { input: { text: 'string' }, output: { summary: 'string', sentences_kept: 'number', sentences_total: 'number' } },
    }],
    evals: {
      spec: 'rs-1-evals',
      n: 1,
      cases: [
        {
          id: 'short',
          input: { text: 'The quick brown fox jumps over the lazy dog. The fox is very quick. Dogs are lazy.' },
          expected: { summary: 'The quick brown fox jumps over the lazy dog. The fox is very quick.', sentences_kept: 2, sentences_total: 3 },
        },
      ],
      coverage: 1.0,
    },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 90 },
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
      description: 'starter categories for support-ticket triage — tenants extend via params.extra_categories',
      fallback_label: 'general',
      categories: [
        { name: 'billing',          keywords: ['refund', 'invoice', 'payment', 'charge', 'subscription'] },
        { name: 'bug',              keywords: ['error', 'crash', 'broken', 'fails', 'not working', '500'] },
        { name: 'auth',             keywords: ['password', 'reset', 'login', 'sign in', 'mfa', '2fa', 'account'] },
        { name: 'feature_request',  keywords: ['feature', 'would love', 'wish', 'request', 'dark mode', 'support for'] },
        { name: 'how_to',           keywords: ['how do i', 'how can i', 'where do i', 'tutorial', 'docs'] },
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
  if (!positional) {
    const err = new Error('kolm new <name> [--from blank|summarizer|redactor|extractor|classifier]');
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const name = slugify(positional);
  const fromIdx = args.indexOf('--from');
  // Auto-pick a sensible template when the user's name hints at the task. The
  // user can always override with --from. Mapping is intentionally narrow so
  // it never overrides an explicit choice or misclassifies a generic name.
  const lowerName = name.toLowerCase();
  let inferred = null;
  if (/summari[sz]|abstract|tldr|tl-dr|digest/.test(lowerName)) inferred = 'summarizer';
  else if (/redact|deidentify|de-identify|phi|pii|scrub|mask/.test(lowerName)) inferred = 'redactor';
  else if (/classif|triag|categor|label|route|router/.test(lowerName)) inferred = 'classifier';
  else if (/extract|parse|fields|invoice/.test(lowerName)) inferred = 'extractor';
  const explicitFrom = fromIdx >= 0 ? args[fromIdx + 1] : null;
  const tmplName = explicitFrom || inferred || 'blank';
  const tmpl = SPEC_TEMPLATES[tmplName];
  if (!tmpl) {
    const err = new Error(`unknown template "${tmplName}". choose: ${Object.keys(SPEC_TEMPLATES).join(', ')}`);
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const outIdx = args.indexOf('--out');
  const explicitOut = outIdx >= 0 ? args[outIdx + 1] : null;
  const force = args.includes('--force');
  const autoYes = args.includes('--yes') || args.includes('-y') || process.env.KOLM_AUTO_YES === '1';
  // Default out path. If the default collides, auto-bump to <name>-2.spec.json,
  // <name>-3.spec.json, up to <name>-10.spec.json. Explicit --out is honored
  // exactly (no auto-bump) so scripts get predictable paths. --force overwrites
  // either the default or the explicit path silently.
  let outPath;
  let autoBumped = false;
  let originalDefaultPath = null;
  if (explicitOut) {
    outPath = path.resolve(process.cwd(), explicitOut);
    if (fs.existsSync(outPath) && !force) {
      console.error(`error: ${outPath} already exists. pass --force to overwrite or pick a different --out path.`);
      process.exit(1);
    }
  } else {
    const defaultPath = path.resolve(process.cwd(), `${name}.spec.json`);
    originalDefaultPath = defaultPath;
    if (!fs.existsSync(defaultPath) || force) {
      outPath = defaultPath;
    } else {
      // Auto-bump: try <name>-2, <name>-3, ... <name>-10.
      let picked = null;
      for (let i = 2; i <= 10; i++) {
        const candidate = path.resolve(process.cwd(), `${name}-${i}.spec.json`);
        if (!fs.existsSync(candidate)) { picked = candidate; break; }
      }
      if (!picked) {
        console.error(`error: ${defaultPath} and ${name}-2..${name}-10 all exist. clean up or pass --out <path> or --force.`);
        process.exit(1);
      }
      outPath = picked;
      autoBumped = true;
    }
  }
  // Blank-template guard: warn aggressively, and in TTY interactively prompt
  // before writing the echo-stub. This is the exact failure mode the user hit
  // (compiling echo-stub without realizing). Non-TTY proceeds with warning to
  // stderr so --once style invocations still work.
  if (tmplName === 'blank') {
    const warn = (s) => process.stderr.write(s + '\n');
    warn('');
    warn('WARNING: the blank template is a STUB that echoes input back unchanged.');
    warn('         it compiles, signs, and passes its own eval - but does no real work.');
    warn('         edit recipes[0].source before you ship. concrete templates that work');
    warn('         out of the box: --from summarizer | redactor | extractor | classifier');
    warn('');
    if (process.stdin.isTTY && !autoYes) {
      const ans = (await prompt('continue with the echo-stub template? [y/N] ')).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log('aborted. nothing was written.');
        console.log('tip: pick a concrete template, e.g. `kolm new ' + name + ' --from summarizer`.');
        return;
      }
    }
  }
  const jobId = `job_${name.replace(/-/g, '_')}_v1`;
  const spec = tmpl(jobId);
  fs.writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');
  const relSpec = path.relative(process.cwd(), outPath) || outPath;
  if (autoBumped && originalDefaultPath) {
    const relOrig = path.relative(process.cwd(), originalDefaultPath) || originalDefaultPath;
    console.log(`note: ${relOrig} already exists. wrote: ${outPath}.`);
  } else {
    console.log(`wrote: ${outPath}`);
  }
  if (!explicitFrom && inferred) {
    console.log(`template: ${tmplName} (inferred from name "${name}"; override with --from blank)`);
  } else {
    console.log(`template: ${tmplName}`);
  }
  // For non-blank templates the WARNING block is unnecessary; only blank gets
  // it (emitted to stderr above so the y/N prompt is co-located).
  console.log('');
  console.log('next steps:');
  // Derive the artifact basename from the (possibly auto-bumped) spec path so
  // hints stay consistent: email-summarizer-2.spec.json -> email-summarizer-2.kolm.
  const artBase = path.basename(outPath).replace(/\.spec\.json$/i, '');
  console.log(`  1. compile:  kolm compile --spec ${relSpec} --out ${artBase}.kolm`);
  if (tmplName === 'summarizer') {
    console.log(`  2. run:      kolm run ${artBase}.kolm '{"text":"first sentence. second one. third one too."}'`);
  } else if (tmplName === 'redactor') {
    console.log(`  2. run:      kolm run ${artBase}.kolm '{"text":"call 555-123-4567 today"}'`);
  } else if (tmplName === 'extractor') {
    console.log(`  2. run:      kolm run ${artBase}.kolm '{"text":"invoice dated 2026-05-09"}'`);
  } else if (tmplName === 'classifier') {
    console.log(`  2. run:      kolm run ${artBase}.kolm '{"text":"I need a refund"}'`);
  } else {
    console.log(`  2. run:      kolm run ${artBase}.kolm '{"text":"any input"}'`);
  }
  console.log(`  3. verify:   kolm verify ${artBase}.kolm`);
  console.log(`  4. inspect:  kolm inspect ${artBase}.kolm`);
  // Surface the training-data flow as a first-class step for real templates.
  // Skip for blank (no template to seed from). Summarizer has no shipped
  // seed-template today; we point at 'generic' so the verb stays discoverable.
  const seedTemplateMap = {
    summarizer: 'generic',
    redactor: 'phi-redactor',
    classifier: 'ticket-classifier',
    extractor: 'invoice-extractor',
  };
  const seedName = seedTemplateMap[tmplName];
  if (seedName) {
    console.log(`  5. add training data:  kolm seeds new ${seedName}   # scaffold + iterate on your real examples`);
  }
  console.log('');
  console.log(`to edit behavior, open ${relSpec} and change recipes[0].source (a JS function).`);
  console.log(`docs: /docs/AUTHORING.md for the full schema + sensitive-data caveats.`);
}

// `kolm build <name> [--from <template>] [--examples <file>] [--out <path>]`
//
// One-shot wrapper: scaffolds the spec, scaffolds seeds (if none exist),
// compiles with honest eval, and runs verify. The point is to compress the
// 4-step new + seeds new + compile + verify chain into a single command so a
// first-time buyer goes from "I want a redactor" to "K=0.7026, here is what's
// failing" in one invocation. The user then iterates the recipe or the
// expected outputs and re-runs `kolm compile`.
async function cmdBuild(args) {
  if (maybeHelp('build', args)) return;
  const positional = args.find(a => !a.startsWith('--'));
  if (!positional) {
    console.error('usage: kolm build <name> [--from <template>] [--examples <file>]');
    console.error('');
    console.error('one-shot wrapper:  kolm new + kolm seeds new + kolm compile --spec + kolm verify');
    console.error('');
    console.error('templates: blank, summarizer, redactor, classifier, extractor');
    console.error('');
    console.error('example:');
    console.error('  kolm build my-redactor --from redactor');
    console.error('  kolm build my-redactor --from redactor --examples my-seeds.jsonl');
    const err = new Error('missing name');
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const name = slugify(positional);
  const fromFlag = pickFlag(args, '--from') || (() => {
    const lower = name.toLowerCase();
    if (/redact|deidentify|phi|pii|scrub|mask/.test(lower)) return 'redactor';
    if (/classif|triag|categor|label|route/.test(lower)) return 'classifier';
    if (/extract|parse|invoice/.test(lower)) return 'extractor';
    if (/summari[sz]|abstract|tldr|digest/.test(lower)) return 'summarizer';
    return 'blank';
  })();
  const examplesFlag = pickFlag(args, '--examples') || pickFlag(args, '--seeds');
  const outFlag = pickFlag(args, '--out');
  const autoYes = args.includes('--yes') || args.includes('-y') || process.env.KOLM_AUTO_YES === '1';

  const specPath = path.resolve(process.cwd(), `${name}.spec.json`);
  const artPath = outFlag
    ? path.resolve(process.cwd(), outFlag)
    : path.resolve(process.cwd(), `${name}.kolm`);
  const seedsPath = examplesFlag
    ? path.resolve(process.cwd(), examplesFlag)
    : path.resolve(process.cwd(), 'seeds.jsonl');

  // Step 1: spec scaffold
  console.log(`[1/4] scaffold spec`);
  if (fs.existsSync(specPath) && !args.includes('--force')) {
    console.log(`  reusing existing ${path.basename(specPath)}`);
  } else {
    const newArgs = [name, '--from', fromFlag, '--out', specPath];
    if (autoYes) newArgs.push('--yes');
    if (args.includes('--force')) newArgs.push('--force');
    await cmdNew(newArgs);
  }

  // Step 2: seeds scaffold (only if --examples not provided AND no seeds.jsonl exists)
  // Track whether the seeds are placeholder (auto-scaffolded) so we can surface
  // the K-score honestly after compile.
  console.log(`[2/4] seeds`);
  let usedPlaceholderSeeds = false;
  if (examplesFlag) {
    if (!fs.existsSync(seedsPath)) {
      const err = new Error(`--examples ${examplesFlag} not found`);
      err.exitCode = EXIT.NOT_FOUND;
      throw err;
    }
    console.log(`  using provided examples: ${path.relative(process.cwd(), seedsPath) || seedsPath}`);
  } else if (fs.existsSync(seedsPath)) {
    console.log(`  reusing existing ${path.basename(seedsPath)}`);
  } else {
    // Scaffold seeds via the same alias resolution `kolm seeds new` uses.
    const seedName = SEED_TEMPLATE_ALIASES[fromFlag] || (SEED_TEMPLATES[fromFlag] ? fromFlag : 'generic');
    await cmdSeedsNew([seedName]);
    usedPlaceholderSeeds = true;
  }

  // Step 3: compile (honest eval baked in)
  console.log(`[3/4] compile`);
  const compileArgs = ['--spec', specPath, '--examples', seedsPath, '--out', artPath, '--no-skill'];
  await cmdCompile(compileArgs);

  // Step 4: verify. Capture the verdict so we can still print iterate guidance
  // when the artifact fails the gate (which IS the diagnostic path on a first
  // build with placeholder seeds). We re-raise the verify error after, so the
  // exit code stays non-zero for CI.
  console.log(`[4/4] verify`);
  let verifyErr = null;
  try { await cmdVerify([artPath]); }
  catch (e) { verifyErr = e; }

  console.log('');
  if (verifyErr) {
    console.log(`built but did NOT pass: ${path.relative(process.cwd(), artPath) || artPath}`);
  } else {
    console.log(`done. ${path.relative(process.cwd(), artPath) || artPath}`);
  }
  // K-score honesty: when seeds were auto-scaffolded, the K reflects the
  // starter rows, not real training data. Make that loud so buyers don't
  // ship a placeholder-trained artifact thinking the number is meaningful.
  if (usedPlaceholderSeeds) {
    console.log('');
    console.log('** PLACEHOLDER SIGNAL: this K-score was computed on starter rows scaffolded');
    console.log('   by kolm seeds new, not your real data. Replace the rows in seeds.jsonl');
    console.log('   with YOUR examples (>= 5) and rebuild for an honest K-score.');
  }
  console.log('');
  console.log('iterate:');
  console.log(`  - replace ${usedPlaceholderSeeds ? 'PLACEHOLDER' : 'low-K'} rows in ${path.basename(seedsPath)} with your real data (>= 5 recommended)`);
  console.log(`  - validate first:  kolm seeds validate ${path.basename(seedsPath)}`);
  console.log(`  - tune recipes[0].source in ${path.basename(specPath)} (the regex / logic)`);
  console.log(`  - rerun:  kolm compile --spec ${path.basename(specPath)} --examples ${path.basename(seedsPath)} --out ${path.basename(artPath)}`);
  console.log('  - eval each failing case:  kolm eval ' + path.basename(artPath) + ' --trace');
  if (verifyErr) throw verifyErr;
}

async function cmdLogin(args) {
  if (maybeHelp('login', args)) return;
  const c = loadConfig();
  const keyFlag = pickFlag(args, '--key') || pickFlag(args, '-k');
  let key;
  if (keyFlag) {
    key = keyFlag.trim();
  } else if (!process.stdin.isTTY) {
    key = (await readStdin()).trim();
  } else {
    console.log('kolm login - paste your API key from kolm.ai/signup.');
    console.log(`Cloud: ${c.base}`);
    key = (await prompt('API key (ks_...): ')).trim();
  }
  if (!key.startsWith('ks_')) {
    console.error('error: API key must start with "ks_"');
    console.error('hint: get one from kolm.ai/signup, or run `kolm signup --email you@example.com`.');
    process.exit(1);
  }
  c.api_key = key;
  saveConfig(c);
  try {
    const a = await api(c, 'GET', '/v1/account');
    console.log(`logged in. tenant=${a.id || 'admin'} plan=${a.plan || '-'}`);
  } catch (e) {
    console.error('saved config but health check failed:', e.message);
  }
}

async function cmdSignup(args) {
  if (maybeHelp('signup', args)) return;
  const c = loadConfig();
  const emailFlag = pickFlag(args, '--email') || pickFlag(args, '-e');
  const nameFlag = pickFlag(args, '--name') || pickFlag(args, '-n');
  const planFlag = pickFlag(args, '--plan') || 'free';
  let email = emailFlag;
  if (!email) {
    if (!process.stdin.isTTY) {
      console.error('error: --email <address> required when stdin is not a TTY.');
      process.exit(1);
    }
    email = (await prompt('email: ')).trim();
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('error: --email must be a valid email address.');
    process.exit(1);
  }
  const body = { email };
  if (nameFlag) body.name = nameFlag;
  if (planFlag && planFlag !== 'free') body.plan = planFlag;
  let resp;
  try {
    resp = await api(c, 'POST', '/v1/signup', body);
  } catch (e) {
    console.error('signup failed:', e.message);
    console.error('hint: visit ' + c.base + '/signup if the API is unreachable.');
    process.exit(1);
  }
  if (!resp || !resp.api_key || !resp.api_key.startsWith('ks_')) {
    console.error('signup returned no api_key. response: ' + JSON.stringify(resp).slice(0, 200));
    process.exit(1);
  }
  c.api_key = resp.api_key;
  saveConfig(c);
  const tenant = resp.tenant || {};
  console.log('ok  signed up.');
  console.log('    email:   ' + email);
  console.log('    tenant:  ' + (tenant.name || tenant.id || '-'));
  console.log('    plan:    ' + (tenant.plan || planFlag));
  console.log('    api_key: ' + resp.api_key.slice(0, 12) + '...  (saved to ' + CONFIG_PATH + ')');
  if (resp.billing_url) {
    console.log('');
    console.log('billing: ' + resp.billing_url);
  }
  console.log('');
  console.log('next:');
  console.log('  kolm init                # scaffold a project in the current directory');
  console.log('  kolm new my-skill --from classifier');
  console.log('  kolm compile --spec my-skill.spec.json');
}

async function cmdWhoami(args) {
  if (maybeHelp('whoami', args)) return;
  const jsonOut = args.includes('--json');
  const c = loadConfig();
  if (!c.api_key) {
    if (jsonOut) {
      console.log(JSON.stringify({ logged_in: false, base: c.base, hint: 'run: kolm login --key ks_... or kolm signup --email you@example.com' }));
    } else {
      console.error('not logged in.');
      console.error('hint: run `kolm login --key ks_...` or `kolm signup --email you@example.com`');
    }
    process.exit(1);
  }
  let a;
  try {
    a = await api(c, 'GET', '/v1/account');
  } catch (e) {
    if (jsonOut) {
      console.log(JSON.stringify({ logged_in: false, base: c.base, error: e.message }));
    } else {
      console.error('cloud rejected the saved key:', e.message);
      console.error('hint: the key may have been rotated or revoked. run `kolm login --key ks_...` again.');
    }
    process.exit(2);
  }
  if (jsonOut) {
    console.log(JSON.stringify({ logged_in: true, base: c.base, tenant: a }));
    return;
  }
  console.log('tenant:  ' + (a.id || a.name || '-'));
  console.log('plan:    ' + (a.plan || '-'));
  if (a.quota !== undefined) console.log('quota:   ' + a.quota);
  if (a.seats !== undefined) console.log('seats:   ' + a.seats);
  console.log('base:    ' + c.base);
  console.log('key:     ' + (c.api_key || '').slice(0, 12) + '...');
}

async function cmdTrain(args) {
  if (maybeHelp('train', args)) return;
  const hasSpec = args.includes('--spec');
  const hasNamespace = args.includes('--namespace') || args.includes('-n');
  if (hasSpec && hasNamespace) {
    console.error('error: pass either --spec or --namespace, not both.');
    console.error('hint: --spec compiles from a written recipe; --namespace distills from captured pairs.');
    process.exit(EXIT.BAD_ARGS);
  }
  if (hasSpec) return cmdCompile(args);
  if (hasNamespace) return cmdDistill(args);
  console.error('usage: kolm train --spec <file.json>   (compile from spec)');
  console.error('       kolm train --namespace <n>      (distill captured pairs)');
  console.error('see:   kolm help train');
  process.exit(EXIT.BAD_ARGS);
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

  // ---- Rent-compile path: ship a spec to a rental backend (modal/vast/lambda/runpod),
  // train remotely, fetch the .kolm back. Must run BEFORE the local --spec path
  // since both require --spec; the presence of --rent decides where the work lands.
  const rentIdxEarly = args.indexOf('--rent');
  if (rentIdxEarly >= 0) {
    const backend = args[rentIdxEarly + 1];
    if (!backend) { console.error('error: --rent needs a backend name. try: kolm compute list'); process.exit(EXIT.BAD_ARGS); }
    const specIdx2 = args.indexOf('--spec');
    if (specIdx2 < 0) { console.error('error: --rent requires --spec <file.json>'); process.exit(EXIT.BAD_ARGS); }
    const specArg2 = args[specIdx2 + 1];
    let spec2;
    try { spec2 = JSON.parse(fs.readFileSync(specArg2, 'utf-8')); }
    catch (e) { console.error(`error: cannot read spec: ${e.message}`); process.exit(EXIT.NOT_FOUND); }
    const confirm = args.includes('--confirm');
    const budgetIdxR = args.indexOf('--budget');
    const budget = budgetIdxR >= 0 ? Number(args[budgetIdxR + 1]) : null;
    const { default: renter } = await import('../src/compute/rent.js');
    const r = await renter.rent(spec2, {
      backend,
      confirm,
      budget_usd: Number.isFinite(budget) ? budget : null,
      on_progress: ({ stage, pct }) => console.error(`  [${backend}] ${stage} ${pct != null ? pct + '%' : ''}`),
    });
    if (r.dry_run) {
      console.log(`quote for ${r.backend}:`);
      console.log(`  duration:   ${r.estimate.duration_human}`);
      console.log(`  cost:       ${r.estimate.cost_usd == null ? '(varies)' : '$' + r.estimate.cost_usd.toFixed(2)}`);
      console.log(`  basis:      ${r.estimate.cost_basis}`);
      console.log('');
      console.log('pass --confirm to actually rent + train. e.g.');
      console.log(`  kolm compile --spec ${specArg2} --rent ${backend} --confirm`);
      return;
    }
    if (!r.ok) {
      console.error(`compile --rent failed: ${r.reason}`);
      process.exit(EXIT.EXECUTION);
    }
    console.log(`rented ${r.backend} (${r.rental.teardown} teardown)`);
    console.log(`  duration:  ${r.estimate.duration_human} (quoted)`);
    console.log(`  cost:      ${r.estimate.cost_usd == null ? '(varies)' : '$' + r.estimate.cost_usd.toFixed(2)}`);
    if (r.result && r.result.artifact_path) {
      console.log(`  artifact:  ${r.result.artifact_path}`);
      if (r.result.k_score) console.log('  ' + fmtKScoreLine(r.result.k_score, path.basename(r.result.artifact_path)));
      console.log('');
      console.log(`run:    kolm run ${path.basename(r.result.artifact_path)} '<input-json>'`);
    } else {
      console.log('(adapter did not return an artifact path — check ~/.kolm/artifacts/)');
    }
    return;
  }

  // ---- Spec-driven local compile path: anyone (or any AI agent) can author a
  // .kolm by writing JSON. No cloud, no account. The artifact is signed with
  // a per-user secret stored at ~/.kolm/config.json (auto-generated on first
  // run); set RECIPE_RECEIPT_SECRET in env to share signatures across teams.
  // --gate <n>: override K-score gate (default 0.85). Applied via env var so
  // every K-line printer (compile/verify/score/inspect/eval/diff/improve) sees
  // the same threshold. Validated to [0.0, 1.0]; out-of-range falls back to
  // default with a warning.
  const gateIdxC = args.indexOf('--gate');
  if (gateIdxC >= 0) {
    const gv = Number(args[gateIdxC + 1]);
    if (!Number.isFinite(gv) || gv < 0 || gv > 1) {
      console.error(`warning: --gate ${args[gateIdxC + 1]} out of range [0, 1]; using default 0.85.`);
    } else {
      process.env.KOLM_K_GATE = String(gv);
    }
  }
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

    // recipes[i].source_file: <path>  — author-friendly alternative to embedding
    // the JS function as a JSON-escaped one-liner in recipes[i].source. Path is
    // resolved relative to the spec file (or cwd for stdin specs). File contents
    // become recipes[i].source so the rest of the pipeline is unchanged.
    // If both source and source_file are set, source wins and a warning is logged.
    if (Array.isArray(spec.recipes) && specArg !== '-' && specArg !== '/dev/stdin') {
      const specDir = path.dirname(path.resolve(specArg));
      for (const r of spec.recipes) {
        if (r && typeof r === 'object' && typeof r.source_file === 'string') {
          const sf = r.source_file;
          if (typeof r.source === 'string' && r.source.length > 0) {
            console.error(`warning: recipe ${r.id || '?'} has both source and source_file; using source.`);
            continue;
          }
          const sfPath = path.isAbsolute(sf) ? sf : path.resolve(specDir, sf);
          try {
            r.source = fs.readFileSync(sfPath, 'utf8');
          } catch (e) {
            console.error(`error: cannot read recipe source_file ${sfPath}: ${e.message}`);
            process.exit(1);
          }
        }
      }
    } else if (Array.isArray(spec.recipes) && (specArg === '-' || specArg === '/dev/stdin')) {
      for (const r of spec.recipes) {
        if (r && typeof r === 'object' && typeof r.source_file === 'string' && (!r.source || !r.source.length)) {
          const sfPath = path.isAbsolute(r.source_file) ? r.source_file : path.resolve(process.cwd(), r.source_file);
          try {
            r.source = fs.readFileSync(sfPath, 'utf8');
          } catch (e) {
            console.error(`error: cannot read recipe source_file ${sfPath}: ${e.message}`);
            process.exit(1);
          }
        }
      }
    }

    // --examples <file.jsonl> (alias --seeds): merge user-provided eval rows
    // into spec.evals.cases. Without this the user's training data is invisible
    // to compile and the K-score reflects only the spec's embedded test set.
    // Each row needs at minimum {input, expected} or {input, output}.
    const exFlag = pickFlag(args, '--examples') || pickFlag(args, '--seeds');
    if (exFlag) {
      let exPath;
      try { exPath = fs.realpathSync(exFlag); }
      catch { console.error(`error: cannot find examples file: ${exFlag}\nhint: run \`kolm seeds new <template>\` to scaffold seeds.jsonl, or pass an existing path.`); process.exit(1); }
      let userRows = [];
      try {
        const lines = fs.readFileSync(exPath, 'utf-8').split(/\r?\n/).filter(Boolean);
        for (const ln of lines) {
          try {
            const row = JSON.parse(ln);
            // Accept either {input, expected} (eval shape) or {input, output} (training shape).
            const expected = row.expected != null ? row.expected : row.output;
            if (row.input == null || expected == null) continue;
            userRows.push({
              id: row.id || `user_${userRows.length + 1}`,
              input: row.input,
              expected,
              ...(row.params ? { params: row.params } : {}),
              ...(row.tags ? { tags: row.tags } : {}),
              source: row.source || 'user-example',
            });
          } catch { /* skip malformed */ }
        }
      } catch (e) {
        console.error(`error: cannot read examples ${exPath}: ${e.message}`); process.exit(1);
      }
      if (!userRows.length) {
        console.error(`error: no usable rows in ${exPath}. each line needs {"input":..., "expected":...} or {"input":..., "output":...}.`); process.exit(1);
      }
      spec.evals = spec.evals || { spec: 'rs-1-evals', cases: [], coverage: 0 };
      const baseCases = Array.isArray(spec.evals.cases) ? spec.evals.cases : [];
      // De-dupe by id if the spec already has user_N from a prior compile.
      const seenIds = new Set(baseCases.map(c => c.id).filter(Boolean));
      const merged = baseCases.slice();
      let added = 0;
      for (const r of userRows) {
        let id = r.id;
        if (seenIds.has(id)) id = `${id}_${added + 1}`;
        seenIds.add(id);
        merged.push({ ...r, id });
        added++;
      }
      spec.evals.cases = merged;
      spec.evals.n = merged.length;
      console.log(`loaded ${added} user examples from ${path.relative(process.cwd(), exPath) || exPath} (merged into evals, total ${merged.length} cases)`);
    }
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
      if (r.k_score) {
        console.log(fmtKScoreLine(r.k_score, path.basename(r.outPath)));
      }
      if (r.evals_report) {
        const er = r.evals_report;
        console.log(`evals:     ${er.passed} / ${er.total} cases pass${er.failing && er.failing.length ? ` (${er.failing.length} failing)` : ''}`);
        if (er.failing && er.failing.length) {
          const sample = er.failing.slice(0, 5).map(f => f.id || '?').join(', ');
          console.log(`failing:   ${sample}${er.failing.length > 5 ? ` ... (+${er.failing.length - 5} more)` : ''}`);
          console.log(`fix:       inspect failing cases with \`kolm eval ${path.basename(r.outPath)} --trace\`,`);
          console.log(`           extend recipes[0].source patterns, or fix expected outputs.`);
        }
      }
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
      // Gate-fail exit: 2 agents (43, 48) flagged that --gate 0.999 printed
      // "gate >= 1.00 - fail" but still exited 0, silently green-lighting
      // sub-gate artifacts in CI. compile is the gate verb; it must fail
      // closed when verdict is fail. Artifact is still on disk (debuggable);
      // exit code signals "do not promote" to the wrapping pipeline.
      if (r.k_score && typeof r.k_score.composite === 'number' && r.k_score.composite < kGate()) {
        process.exit(EXIT.GATE_FAIL);
      }
      return;
    } catch (e) {
      const code = e.code ? `[${e.code}] ` : '';
      console.error(`compile failed: ${code}${e.message}`);
      if (process.env.KOLM_DEBUG) console.error(e.stack);
      process.exit(1);
    }
  }

  // ---- Cloud-compile path (existing): synthesize from task + corpus + examples.
  // --airgap (or KOLM_AIRGAP=1) forbids cloud roundtrip. If a spec exists in
  // cwd matching the task slug, route there; otherwise fail clean with a hint.
  const wantsAirgap = args.includes('--airgap') || !!process.env.KOLM_AIRGAP;
  if (wantsAirgap) {
    const taskHint = args.find(a => !a.startsWith('--'));
    const slug = taskHint ? String(taskHint).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) : '';
    const candidates = slug ? [
      path.resolve(process.cwd(), `${slug}.spec.json`),
      path.resolve(process.cwd(), `${slug.split('-')[0]}.spec.json`),
    ] : [];
    const foundSpec = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (foundSpec) {
      console.log(`airgap: routing to spec-mode compile (${path.basename(foundSpec)})`);
      const exArg = pickFlag(args, '--examples') || pickFlag(args, '--seeds');
      const outArg = pickFlag(args, '--out');
      const newArgs = ['--spec', foundSpec];
      if (exArg) newArgs.push('--examples', exArg);
      if (outArg) newArgs.push('--out', outArg);
      return cmdCompile(newArgs);
    }
    console.error('error: --airgap can\'t reach the cloud, and no matching spec found in cwd.');
    console.error('hint: scaffold one first:');
    console.error(`  kolm new ${slug || 'my-model'} --from redactor   # or classifier, extractor, summarizer`);
    console.error(`  kolm compile --spec ${slug || 'my-model'}.spec.json --examples seeds.jsonl`);
    const err = new Error('--airgap requires --spec or a matching spec in cwd');
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const c = loadConfig();
  if (!c.api_key) {
    console.error('not logged in. run: kolm login');
    console.error('(or use --spec <file.json> for offline spec-driven compile, or pass --airgap to compile from a local spec.)');
    const err = new Error('not logged in');
    err.exitCode = EXIT.MISSING_PREREQ;
    throw err;
  }
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
  // Record this artifact in ~/.kolm/cloud-trusted.json so the runner's HMAC
  // step accepts it. Cloud artifacts are signed with the server's secret,
  // which we don't possess locally; trusting by authenticated-download sha256
  // is the pragmatic workaround until the cloud publishes a verifier token.
  try {
    const { recordCloudTrusted } = await import('../src/artifact-runner.js');
    const sha = recordCloudTrusted(outPath, { source: 'cloud', cloud_base: c.base, job_id: state.id, task });
    if (sha && process.env.KOLM_DEBUG) console.error(`cloud-trust: recorded sha256=${sha.slice(0, 16)}…`);
  } catch (e) {
    if (process.env.KOLM_DEBUG) console.error('cloud-trust record failed:', e.message);
  }
  console.log(fmtKScore(state.k_score, path.basename(outPath)));
  // Disclose when this artifact's K-score was computed entirely against auto-
  // synthesized eval cases (no user examples). 0.985 vs. real data is
  // a very different signal than 0.985 vs. cases the user reviewed.
  if (state.evals_summary && state.evals_summary.total != null) {
    const total = state.evals_summary.total;
    const auto = state.evals_summary.auto_synthesized || 0;
    if (total > 0 && auto === total) {
      console.log('  evals:     ' + total + ' auto-synthesized (no user examples) — add real cases for honest signal');
    } else if (auto > 0) {
      console.log('  evals:     ' + (total - auto) + ' user / ' + auto + ' auto-synthesized');
    } else if (total > 0) {
      console.log('  evals:     ' + total + ' user-provided');
    }
  }
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
  // Pull --params <json|@file> and --input <file|@file|-> off args before
  // resolving positional argv. --input handles 3 buyer-friendly shapes:
  //   --input @path  : read path as JSON (auto-detect) or plain text
  //   --input path   : same (the @ is optional)
  //   --input -      : read input from stdin
  // Plus stdin fallback when positional input is missing and stdin is piped.
  let paramsArg = null;
  let inputArg = null;
  const cleaned = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--params' && i + 1 < args.length) { paramsArg = args[i + 1]; i++; }
    else if (args[i] === '--input' && i + 1 < args.length) { inputArg = args[i + 1]; i++; }
    else if (args[i] === '--json') { /* consumed below */ cleaned.push(args[i]); }
    else cleaned.push(args[i]);
  }
  const jsonOut = cleaned.includes('--json');
  // strip --json out of positional resolution so it isn't read as artifact/input
  const positional = cleaned.filter(a => a !== '--json');
  const ap = resolveArtifact(positional[0]);
  if (!ap) {
    const err = new Error(`artifact not found: ${positional[0]}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  // Decide where input comes from: --input flag wins, then positional, then stdin.
  let inputRaw = null;
  if (inputArg) {
    if (inputArg === '-') {
      inputRaw = fs.readFileSync(0, 'utf8');
    } else {
      const filePath = inputArg.startsWith('@') ? inputArg.slice(1) : inputArg;
      if (!fs.existsSync(filePath)) {
        const err = new Error(`--input file not found: ${filePath}`);
        err.exitCode = EXIT.NOT_FOUND;
        throw err;
      }
      inputRaw = fs.readFileSync(filePath, 'utf8');
    }
  } else if (positional[1] !== undefined) {
    inputRaw = positional[1];
  } else if (!process.stdin.isTTY) {
    // Piped stdin with no positional arg: cat foo.txt | kolm run art.kolm
    try { inputRaw = fs.readFileSync(0, 'utf8'); } catch { inputRaw = null; }
    if (inputRaw != null) inputRaw = inputRaw.replace(/\r?\n$/, '');
  }
  let input = null;
  if (inputRaw != null && inputRaw !== '') {
    const trimmed = inputRaw.trim();
    // If it looks like JSON, parse it. Otherwise pass the raw string through;
    // the recipe is responsible for handling string vs object shapes.
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try { input = JSON.parse(trimmed); }
      catch { input = inputRaw; }
    } else {
      input = inputRaw;
    }
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
      // Wave 38: text-mode prints only the recipe output (string-or-pretty-JSON)
      // plus a one-line footer on stderr (recipe + latency). Pipes stay clean
      // for `kolm run x.kolm 'foo' | jq`. --json keeps the full doc with
      // K-score / receipt / audit so CI and agents have one parseable blob.
      const result = { output: r.output, recipe: r.recipe_name || r.recipe_id, latency_us: r.latency_us, k_score: r.k_score, receipt: r.receipt, audit: r.audit };
      if (jsonOut) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const outStr = (typeof r.output === 'string')
          ? r.output
          : JSON.stringify(r.output, null, 2);
        console.log(outStr);
        const lat = typeof r.latency_us === 'number' ? `${r.latency_us}us` : '?';
        const recipe = r.recipe_name || r.recipe_id || '?';
        process.stderr.write(`recipe: ${recipe}  ·  ${lat}\n`);
      }
      appendRunLog({ command: 'run', artifact: ap, recipe_id: r.recipe_id, recipe_name: r.recipe_name, latency_us: r.latency_us, k_composite: r.k_score?.composite, ok: r.audit?.ok !== false });
      try {
        const { appendCapture } = await import('../src/tune.js');
        appendCapture(ap, { input, output: r.output, recipe: r.recipe_name || r.recipe_id, latency_us: r.latency_us });
      } catch {}
      if (!jsonOut) {
        await dispatchRun('PostRun', { command: 'run', cwd: process.cwd(), artifact: ap, latency_us: r.latency_us, k_score: r.k_score, recipe: r.recipe_name || r.recipe_id }, { onResult: printHookResult });
      } else {
        // --json: still fire hooks but swallow their stdout narration so the
        // result remains a single parseable JSON document.
        await dispatchRun('PostRun', { command: 'run', cwd: process.cwd(), artifact: ap, latency_us: r.latency_us, k_score: r.k_score, recipe: r.recipe_name || r.recipe_id }, { onResult: () => {} });
      }
    } catch (e) {
      const code = e.code || 'KOLM_E_RUN_FAILED';
      appendRunLog({ command: 'run', artifact: ap, ok: false, error: e.message, error_code: code });
      console.error(JSON.stringify({ error: e.message, code, tried: e.tried || null }, null, 2));
      const err = new Error(e.message);
      err.exitCode = EXIT.EXECUTION;
      err.code = code;
      throw err;
    }
  });
}

async function cmdEval(args) {
  if (maybeHelp('eval', args)) return;
  // Default to a human-readable summary so `kolm eval my.kolm` is useful at a
  // glance. Pass --json for the full machine-readable doc (used by CI / agents).
  // --trace forces per-case failure detail; without it we show the top 5.
  // --examples <file> evals against a fresh JSONL instead of the embedded
  // cases — the way to A/B a candidate artifact against real holdout data
  // without recompiling.
  const jsonOut = args.includes('--json');
  const traceFlag = args.includes('--trace');
  const examplesFlag = pickFlag(args, '--examples');
  const positional = args.filter(a => !a.startsWith('--'));
  const ap = resolveArtifact(positional[0]);
  if (!ap) {
    const err = new Error(`artifact not found: ${positional[0]}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  let overrideCases = null;
  if (examplesFlag) {
    if (!fs.existsSync(examplesFlag)) {
      const err = new Error(`--examples file not found: ${examplesFlag}`);
      err.exitCode = EXIT.NOT_FOUND;
      throw err;
    }
    const rows = readExamplesJsonl(examplesFlag);
    if (!rows.length) {
      const err = new Error(`--examples file has no parseable rows: ${examplesFlag}`);
      err.exitCode = EXIT.BAD_ARGS;
      throw err;
    }
    overrideCases = rows;
    if (!jsonOut) console.log(`loaded ${rows.length} cases from ${examplesFlag}`);
  }
  await withRunner(async ({ evalArtifact }) => {
    const r = await evalArtifact(ap, overrideCases ? { cases: overrideCases } : {});
    if (jsonOut) { console.log(JSON.stringify(r, null, 2)); return; }
    const name = path.basename(ap);
    const total = r.n != null ? r.n : (Array.isArray(r.cases) ? r.cases.length : 0);
    const passed = r.passed != null ? r.passed : (total - (r.errors ? r.errors.length : 0));
    const accPct = typeof r.accuracy === 'number' ? (r.accuracy * 100).toFixed(1) + '%' : '?';
    const lat = r.p50_latency_us != null ? `${r.p50_latency_us}us` : '?';
    console.log(`eval: ${name}${r.source === 'override' ? `  (against ${examplesFlag})` : ''}`);
    console.log(`  passed:    ${passed} / ${total}  (${accPct})`);
    console.log(`  p50_lat:   ${lat}`);
    const errs = Array.isArray(r.errors) ? r.errors : [];
    if (errs.length === 0) {
      console.log(`  failures:  none`);
      return;
    }
    const showAll = traceFlag;
    const slice = showAll ? errs : errs.slice(0, 5);
    console.log(`  failures:  ${errs.length}${showAll ? '' : (errs.length > 5 ? ` (showing first 5; pass --trace to see all)` : '')}`);
    for (const e of slice) {
      const id = e.id || '(no id)';
      const ex = typeof e.expected === 'string' ? e.expected : JSON.stringify(e.expected);
      const gotStr = typeof e.got === 'string' ? e.got : (e.got && typeof e.got === 'object' ? JSON.stringify(e.got) : String(e.got));
      const trunc = (s, n) => s == null ? '(null)' : (String(s).length > n ? String(s).slice(0, n) + '...' : String(s));
      console.log(`  - ${id}`);
      console.log(`      expected: ${trunc(ex, 100)}`);
      console.log(`      got:      ${trunc(gotStr, 100)}`);
      if (e.error) console.log(`      error:    ${trunc(e.error, 100)}`);
    }
    if (errs.length > 0) {
      console.log('');
      console.log(`hint: edit recipes[0].source in the spec to handle these inputs,`);
      console.log(`      or fix the expected outputs if they don't match what you actually want.`);
      console.log(`      re-compile with:  kolm compile --spec <spec>.spec.json --examples <seeds>.jsonl --out ${name}`);
    }
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
  if (!ap) {
    const err = new Error(`artifact not found: ${args[0]}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }

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
//   swebench-lite-n150  -- Opus-4.7 against swebench 4.1.0 evaluator
//
// Honesty pattern: the CLI verb is real, but the heavy harness is gated behind
// the operator-published Docker image. If docker / ANTHROPIC_API_KEY / the image
// are not available, exit 2 with a clear operator hint rather than silently
// no-op'ing. This mirrors /v1/specialists/auto-distill's 503 behaviour. No
// point-estimate lift is shipped before the first end-to-end signed run.
const REPRODUCE_SUITES = {
  'swebench-lite-n150': {
    image:        'kolmogorov/swebench-reproducer:1.0.0',
    default_n:    150,
    default_seed: 42,
    headline:     'Opus-4.7 vs baseline, swebench 4.1.0 evaluator (headline lift pending first signed run)',
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
  if (!ap) {
    const err = new Error(`artifact not found: ${args[0]}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  await withRunner(async ({ inspectArtifact }) => {
    const m = inspectArtifact(ap);
    console.log(`task: ${m.task}`);
    console.log(fmtKScore(m.k_score, path.basename(ap)));
  });
}

// cmdInspect: text mode by default, --json keeps the full machine dump.
// Same wave-38 pattern as cmdRun. Text mode shows the buyer what they need
// (task, K-score, build time, signature, recipes) without 44 lines of JSON.
async function cmdInspect(args) {
  if (maybeHelp('inspect', args)) return;
  const jsonOut = args.includes('--json');
  const positional = args.filter(a => !a.startsWith('--'));
  const ap = resolveArtifact(positional[0]);
  if (!ap) {
    const err = new Error(`artifact not found: ${positional[0]}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  await withRunner(async ({ inspectArtifact }) => {
    const m = inspectArtifact(ap);
    // Compute sha256 of the .kolm file on disk so callers don't need to shell
    // out to sha256sum to learn the artifact identity. Top-level field in both
    // text and --json output.
    let fileSha = null;
    try {
      const buf = fs.readFileSync(ap);
      fileSha = crypto.createHash('sha256').update(buf).digest('hex');
    } catch {}
    if (jsonOut) {
      const out = { ...m };
      if (fileSha) {
        out.sha256 = fileSha;
        out.sha256_short = fileSha.slice(0, 12);
      }
      out.path = path.resolve(ap);
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    // Text mode: human-readable summary, --json for the full dump.
    const basename = path.basename(ap);
    let sizeOnDisk = null;
    try { sizeOnDisk = fs.statSync(ap).size; } catch {}
    const builtAt = m.created_at ? new Date(m.created_at) : null;
    const ageSec = builtAt ? Math.max(1, Math.floor((Date.now() - builtAt.getTime()) / 1000)) : null;
    const fmtAge = (sec) => {
      if (sec == null) return '?';
      if (sec < 60) return sec + 's ago';
      if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
      if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
      return Math.floor(sec / 86400) + 'd ago';
    };
    const builtFmt = builtAt
      ? `${builtAt.toISOString().slice(0, 19).replace('T', ' ')}Z (${fmtAge(ageSec)})`
      : '?';
    console.log(`artifact: ${basename}`);
    console.log(`task:     ${m.task || '?'}`);
    console.log(`built:    ${builtFmt}`);
    if (sizeOnDisk != null) console.log(`size:     ${fmtBytes(sizeOnDisk)} on disk`);
    console.log('');
    console.log(fmtKScore(m.k_score, basename));
    console.log('');
    console.log(`runtime:    ${m.runtime || '?'}`);
    console.log(`tier:       ${m.tier || '?'}`);
    console.log(`base model: ${m.base_model || 'none'}`);
    const sigMode = m.signature_mode || '?';
    const sigStatus = m.signature_valid === true ? 'valid' : (m.signature_valid === false ? 'INVALID' : 'unknown');
    console.log(`signature:  ${sigStatus} (${sigMode})`);
    const recipeNames = Array.isArray(m.recipe_names) ? m.recipe_names : [];
    const recipeList = recipeNames.length ? ` (${recipeNames.join(', ')})` : '';
    console.log(`recipes:    ${m.recipes_n != null ? m.recipes_n : '?'}${recipeList}`);
    console.log(`evals:      ${m.evals_n != null ? `${m.evals_n} cases` : '?'}`);
  });
}

// cmdList scans the local artifact roots and prints a clean table of every
// .kolm on disk with name, K-score, size, and mtime. Replaces the
// long-broken `kolm artifacts list` reference the chat narrator pointed at.
//
// Roots scanned (in order):
//   ~/.kolm/artifacts/   (global, where `kolm compile` writes by default)
//   ./.kolm/artifacts/   (project-scoped, when a kolm.yaml sits at cwd)
//   ./                   (current dir, picks up `kolm build` outputs)
//
// Same artifact discovered at multiple roots is deduped by absolute path.
// --json emits a machine-readable array; default is the human table.
async function cmdList(args) {
  if (maybeHelp('list', args)) return;
  const jsonOut = args.includes('--json');
  const roots = [];
  roots.push({ dir: ARTIFACTS_DIR, label: 'global' });
  const projArt = path.join(process.cwd(), '.kolm', 'artifacts');
  if (fs.existsSync(projArt)) roots.push({ dir: projArt, label: 'project' });
  roots.push({ dir: process.cwd(), label: 'cwd' });
  const seen = new Set();
  const rows = [];
  for (const { dir, label } of roots) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.kolm')) continue;
      const full = path.resolve(dir, name);
      if (seen.has(full)) continue;
      seen.add(full);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile()) continue;
      rows.push({ path: full, name, size: stat.size, mtime: stat.mtime, source: label });
    }
  }
  // Resolve K-scores via the runner; keep failures non-fatal so a single
  // corrupt artifact doesn't blank the whole listing.
  await withRunner(async ({ inspectArtifact }) => {
    for (const r of rows) {
      try {
        const m = inspectArtifact(r.path);
        r.k = (m && m.k_score && typeof m.k_score.composite === 'number') ? m.k_score.composite : null;
        r.task = (m && m.task) || null;
      } catch {
        r.k = null;
        r.task = null;
      }
    }
  });
  rows.sort((a, b) => b.mtime - a.mtime);
  if (jsonOut) {
    console.log(JSON.stringify(rows.map(r => ({
      path: r.path,
      name: r.name,
      size_bytes: r.size,
      mtime: r.mtime.toISOString(),
      source: r.source,
      k_score: r.k,
      task: r.task,
    })), null, 2));
    return;
  }
  if (!rows.length) {
    console.log('no .kolm artifacts found.');
    console.log('');
    console.log('  ~/.kolm/artifacts/  (global)   - written by `kolm compile`');
    console.log('  ./                  (cwd)      - written by `kolm build`');
    console.log('');
    console.log('try: kolm build my-redactor --from redactor --yes');
    return;
  }
  // Header + rows. Columns: NAME, K-score, size, age, source.
  const fmtAge = (mtime) => {
    const sec = Math.max(1, Math.floor((Date.now() - mtime.getTime()) / 1000));
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h';
    return Math.floor(sec / 86400) + 'd';
  };
  const nameW = Math.max(4, ...rows.map(r => r.name.length));
  const sizeW = Math.max(4, ...rows.map(r => fmtBytes(r.size).length));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(pad('NAME', nameW) + '  K-SCORE  ' + pad('SIZE', sizeW) + '  AGE   SOURCE');
  for (const r of rows) {
    const kStr = (typeof r.k === 'number') ? r.k.toFixed(3) : '  -  ';
    const verdict = (typeof r.k === 'number') ? (r.k >= 0.85 ? 'p' : 'f') : ' ';
    console.log(
      pad(r.name, nameW) + '  ' +
      kStr + ' ' + verdict + '  ' +
      pad(fmtBytes(r.size), sizeW) + '  ' +
      pad(fmtAge(r.mtime), 4) + '  ' +
      r.source
    );
  }
  console.log('');
  console.log(`${rows.length} artifact${rows.length === 1 ? '' : 's'}. inspect with: kolm score <name>`);
}

async function cmdDiff(args) {
  if (maybeHelp('diff', args)) return;
  const positional = args.filter(a => !a.startsWith('--'));
  const jsonFlag = args.includes('--json');
  if (positional.length < 2) {
    const err = new Error('usage: kolm diff <a.kolm> <b.kolm> [--json]');
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const aPath = resolveArtifact(positional[0]);
  const bPath = resolveArtifact(positional[1]);
  if (!aPath || !bPath) {
    const err = new Error(`artifact not found: ${aPath ? positional[1] : positional[0]}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  await withRunner(async ({ inspectArtifact }) => {
    const a = inspectArtifact(aPath);
    const b = inspectArtifact(bPath);
    const delta = {
      a: { path: aPath, cid: a.cid, k_score: a.k_score?.composite ?? null, base_model: a.base_model || null },
      b: { path: bPath, cid: b.cid, k_score: b.k_score?.composite ?? null, base_model: b.base_model || null },
      changes: [],
    };
    const fields = [
      ['cid', a.cid, b.cid],
      ['base_model', a.base_model, b.base_model],
      ['k_score', a.k_score?.composite, b.k_score?.composite],
      ['recipe.task', a.recipe?.task, b.recipe?.task],
      ['recipe.objective', a.recipe?.objective, b.recipe?.objective],
      ['recipe.adapter', a.recipe?.adapter, b.recipe?.adapter],
      ['compliance_pack', a.compliance_pack, b.compliance_pack],
      ['kolm_version', a.kolm_version, b.kolm_version],
    ];
    for (const [field, av, bv] of fields) {
      if (JSON.stringify(av) !== JSON.stringify(bv)) {
        delta.changes.push({ field, before: av ?? null, after: bv ?? null });
      }
    }
    if (jsonFlag) {
      console.log(JSON.stringify(delta, null, 2));
      return;
    }
    console.log(`--- ${aPath}`);
    console.log(`+++ ${bPath}`);
    console.log(`    cid:     ${a.cid}`);
    console.log(`    cid:     ${b.cid}`);
    console.log('');
    if (delta.changes.length === 0) {
      console.log('  (no manifest changes)');
      return;
    }
    for (const c of delta.changes) {
      console.log(`@ ${c.field}`);
      console.log(`- ${JSON.stringify(c.before)}`);
      console.log(`+ ${JSON.stringify(c.after)}`);
    }
    console.log('');
    console.log(`${delta.changes.length} field${delta.changes.length === 1 ? '' : 's'} changed`);
  });
}

async function cmdVerify(args) {
  if (maybeHelp('verify', args)) return;
  const positional = args.filter(a => !a.startsWith('--'));
  const ap = resolveArtifact(positional[0]);
  if (!ap) {
    const err = new Error(`artifact not found: ${positional[0] || '(no artifact specified)'}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  const binderIdx = args.indexOf('--binder');
  const jsonFlag = args.includes('--json');
  const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname)).replace(/^\/([A-Z]):/, '$1:');
  const { buildBinder, writeBinder } = await import(new URL('../src/binder.js', import.meta.url).href);

  if (binderIdx >= 0) {
    const outPath = args[binderIdx + 1];
    if (!outPath || outPath.startsWith('--')) {
      const err = new Error('--binder requires an output HTML path');
      err.exitCode = EXIT.BAD_ARGS;
      throw err;
    }
    const result = await writeBinder(ap, outPath);
    if (jsonFlag) {
      console.log(JSON.stringify({
        ok: result.verdict !== 'fail',
        verdict: result.verdict,
        out_path: result.out_path,
        bytes: result.bytes,
        checks: result.checks,
      }, null, 2));
    } else {
      console.log(`binder written: ${result.out_path} (${result.bytes} bytes)`);
      console.log(`verdict: ${result.verdict}`);
      for (const c of result.checks) {
        const tag = c.status === 'pass' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'fail';
        console.log(`  [${tag}] ${c.name}: ${c.detail}`);
      }
    }
    if (result.verdict === 'fail') {
      const err = new Error('verification failed; see binder for details');
      err.exitCode = EXIT.EXECUTION;
      throw err;
    }
    return;
  }

  // No --binder: print the verification summary as JSON or plaintext.
  const result = await buildBinder(ap);
  void repoRoot;
  if (jsonFlag) {
    console.log(JSON.stringify({
      ok: result.verdict !== 'fail',
      verdict: result.verdict,
      checks: result.checks,
      cid: result.manifest.cid,
      k_score: result.manifest.k_score?.composite ?? null,
    }, null, 2));
  } else {
    console.log(`verdict: ${result.verdict}`);
    console.log(`cid:     ${result.manifest.cid}`);
    console.log(fmtKScoreLine(result.manifest.k_score, path.basename(ap)));
    for (const c of result.checks) {
      const tag = c.status === 'pass' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'fail';
      console.log(`  [${tag}] ${c.name}: ${c.detail}`);
    }
    console.log('');
    console.log('hint: add --binder out.html to emit a printable compliance report');
  }
  if (result.verdict === 'fail') {
    const err = new Error('verification failed');
    err.exitCode = EXIT.EXECUTION;
    throw err;
  }
}

async function cmdServe(args) {
  if (maybeHelp('serve', args)) return;
  const useMcp = args.includes('--mcp');
  const useHttp = args.includes('--http');
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8765;
  const hostIdx = args.indexOf('--host');
  const host = hostIdx >= 0 ? args[hostIdx + 1] : '127.0.0.1';

  if (useMcp) {
    const { startMcpServer } = await import('../services/mcp/server.js');
    await startMcpServer({ artifactsDir: ARTIFACTS_DIR, http: useHttp, port, projectCwd: process.cwd() });
    return;
  }

  if (useHttp) {
    // HTTP-serve a single generative .kolm artifact via apps/runtime/serve.py.
    // First positional arg that's not a flag is the artifact path.
    const artifact = args.find(a => !a.startsWith('--') && a !== 'serve');
    if (!artifact) {
      console.error('usage: kolm serve --http <artifact.kolm> [--port 8765] [--host 127.0.0.1]');
      process.exit(EXIT.BAD_ARGS);
    }
    const ap = path.isAbsolute(artifact) ? artifact : path.join(ARTIFACTS_DIR, artifact);
    if (!fs.existsSync(ap)) {
      console.error(`artifact not found: ${ap}`);
      process.exit(EXIT.NOT_FOUND);
    }
    const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
    console.log(`booting HTTP serve for ${path.basename(ap)} via ${py} apps/runtime/serve.py`);
    const r = spawnSync(py, ['-m', 'apps.runtime.serve', '--artifact', ap, '--port', String(port), '--host', host], {
      stdio: 'inherit',
      cwd: repoRoot.replace(/^\/([A-Z]):/, '$1:'),
    });
    process.exit(r.status || 0);
  }

  console.error('usage: kolm serve --mcp                    (frontier-agent MCP transport)');
  console.error('       kolm serve --http <artifact.kolm>   (OpenAI-compatible HTTP, vLLM/transformers)');
  process.exit(EXIT.BAD_ARGS);
}

async function cmdPublish(args) {
  if (maybeHelp('publish', args)) return;
  const positional = args.filter(a => !a.startsWith('--'));
  const ap = resolveArtifact(positional[0]);
  if (!ap) {
    console.error('error: artifact not found: ' + (positional[0] || '(none given)'));
    console.error('  usage: kolm publish <artifact.kolm> [--name <name>] [--public|--private]');
    process.exit(EXIT.NOT_FOUND);
  }
  const c = loadConfig();
  if (!c.api_key) {
    console.error('error: not signed in. run `kolm login` or `kolm signup` first.');
    process.exit(EXIT.UNAUTHORIZED || 4);
  }

  // Default name = basename without .kolm. Override with --name.
  const flagName = pickFlag(args, '--name');
  const defaultName = path.basename(ap, '.kolm');
  const name = (flagName || defaultName).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!name || name.length < 2) {
    console.error(`error: bad name "${flagName || defaultName}" — needs 2-64 chars, kebab-case`);
    process.exit(EXIT.BAD_ARGS);
  }
  // Default visibility: private. Buyer opts in via --public or --visibility public.
  // Healthcare buyers ship sensitive recipes; safest default is private.
  const flagVis = pickFlag(args, '--visibility');
  let visibility = 'private';
  if (args.includes('--public') || flagVis === 'public') visibility = 'public';
  else if (args.includes('--private') || flagVis === 'private') visibility = 'private';
  else if (flagVis && flagVis !== 'public' && flagVis !== 'private') {
    console.error(`error: --visibility must be 'public' or 'private', got "${flagVis}"`);
    process.exit(EXIT.BAD_ARGS);
  }

  const bytes = fs.readFileSync(ap);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');

  // Pull K-score / base / task off the artifact for the metadata row. Best
  // effort — corrupt artifact still publishes, just without rich metadata.
  let metadata = { artifact_id: path.basename(ap, '.kolm') };
  try {
    const info = await withRunner(({ inspectArtifact }) => inspectArtifact(ap));
    metadata = {
      artifact_id: info.id || info.artifact_id || path.basename(ap, '.kolm'),
      k_score: typeof info.k_score?.composite === 'number' ? info.k_score.composite : null,
      gate: info.k_score?.gate || 0.85,
      base_model: info.base_model || info.spec?.base_model || null,
      task: info.task || info.spec?.task || null,
      tags: Array.isArray(info.tags) ? info.tags : (Array.isArray(info.spec?.tags) ? info.spec.tags : []),
      license: info.license || info.spec?.license || null,
      receipt: info.receipt || null,
    };
  } catch (e) {
    // Non-fatal — the artifact still publishes.
  }

  console.log(`publishing ${path.basename(ap)}  (${fmtBytes(bytes.length)})`);
  console.log(`  sha256:     ${sha}`);
  console.log(`  visibility: ${visibility}`);
  if (metadata.k_score != null) console.log(`  K-score:    ${Number(metadata.k_score).toFixed(3)}  (gate ${metadata.gate})`);
  if (metadata.base_model) console.log(`  base:       ${metadata.base_model}`);

  let result;
  try {
    result = await api(c, 'POST', '/v1/hub/publish', {
      name,
      visibility,
      artifact_b64: bytes.toString('base64'),
      metadata,
    });
  } catch (e) {
    console.error('\npublish failed: ' + (e.message || e));
    if (e.status === 409) {
      console.error('  this name already exists. retry with --name <different>.');
    }
    if (e.status === 413) {
      console.error('  artifact exceeds 25 MB cap. trim the .kolm or contact support@kolm.ai for large-artifact storage.');
    }
    process.exit(1);
  }
  console.log('');
  console.log('ok  published');
  console.log(`  handle:     ${result.handle}`);
  console.log(`  url:        ${result.url}`);
  console.log(`  download:   ${result.download_url}`);
  console.log('');
  console.log(`  pull it anywhere:  kolm pull ${result.owner}/${result.name}`);
  console.log(`  verify it:         kolm verify ${result.owner}/${result.name}`);
}

// kolm pull <owner>/<name>[@sha256:<hex>] [--out <path>]
//
// Downloads a published .kolm from the hub. Verifies SHA-256 against the
// handle if the handle pins one. Writes to cwd by default; --out overrides.
async function cmdPull(args) {
  if (maybeHelp('pull', args)) return;
  const positional = args.filter(a => !a.startsWith('--'));
  const handle = positional[0];
  if (!handle) {
    console.error('usage: kolm pull <owner>/<name>[@sha256:<hex>] [--out <path>]');
    process.exit(EXIT.BAD_ARGS);
  }
  const m = handle.match(/^([a-z0-9-]+)\/([a-z0-9-]+)(?:@sha256:([0-9a-f]+))?$/i);
  if (!m) {
    console.error(`error: handle "${handle}" must be <owner>/<name>[@sha256:<hex>]`);
    process.exit(EXIT.BAD_ARGS);
  }
  const [, owner, name, shaPin] = m;
  const c = loadConfig();
  const outArg = pickFlag(args, '--out');

  console.log(`pulling ${owner}/${name}${shaPin ? `@sha256:${shaPin}` : ''}...`);
  let meta;
  try {
    meta = await api(c, 'GET', `/v1/hub/${owner}/${name}`);
  } catch (e) {
    console.error('error: ' + (e.message || e));
    if (e.status === 404) console.error('  no artifact at that handle (or it is private and you are not the owner)');
    process.exit(1);
  }

  const url = c.base.replace(/\/+$/, '') + `/v1/hub/${owner}/${name}/download`;
  const dlRes = await fetch(url, { headers: { ...authHeaders(c) } });
  if (!dlRes.ok) {
    console.error(`error: download http ${dlRes.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(await dlRes.arrayBuffer());
  const localSha = crypto.createHash('sha256').update(buf).digest('hex');

  if (shaPin && !localSha.startsWith(shaPin.toLowerCase())) {
    console.error(`error: sha256 mismatch. handle pinned ${shaPin}, got ${localSha.slice(0, 16)}`);
    process.exit(EXIT.CHECKSUM_FAIL || 5);
  }
  if (meta.sha256 && meta.sha256 !== localSha) {
    console.error(`error: server-reported sha256 (${meta.sha256.slice(0, 16)}) does not match download (${localSha.slice(0, 16)})`);
    process.exit(EXIT.CHECKSUM_FAIL || 5);
  }

  const outPath = path.resolve(outArg || `${name}.kolm`);
  fs.writeFileSync(outPath, buf);

  console.log('ok  pulled');
  console.log(`  file:       ${outPath}`);
  console.log(`  size:       ${fmtBytes(buf.length)}`);
  console.log(`  sha256:     ${localSha}`);
  if (meta.metadata?.k_score != null) {
    console.log(`  K-score:    ${Number(meta.metadata.k_score).toFixed(3)}  (gate ${meta.metadata.gate || 0.85})`);
  }
  if (meta.metadata?.base_model) console.log(`  base:       ${meta.metadata.base_model}`);
  console.log('');
  console.log(`  next:  kolm inspect ${outPath}`);
  console.log(`         kolm run ${outPath} '<input>'`);
}

// kolm hub [list|show <handle>] — browse the public artifact gallery.
async function cmdHub(args) {
  if (maybeHelp('hub', args)) return;
  const sub = args[0] || 'list';
  const c = loadConfig();
  if (sub === 'list' || sub === 'ls') {
    const q = pickFlag(args, '--q') || pickFlag(args, '--search') || '';
    const limit = Number(pickFlag(args, '--limit') || 50);
    const url = `/v1/hub${q ? `?q=${encodeURIComponent(q)}&limit=${limit}` : `?limit=${limit}`}`;
    let r;
    try { r = await api(c, 'GET', url); }
    catch (e) { console.error('error: ' + e.message); process.exit(1); }
    if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
    if (!r.artifacts.length) {
      console.log('(no published artifacts yet)');
      console.log('');
      console.log('publish your first:  kolm compile && kolm publish <file>.kolm --public');
      return;
    }
    console.log(`${r.total} published artifacts (showing ${r.artifacts.length}):`);
    console.log('');
    console.log('HANDLE                              K-SCORE  SIZE      BASE                          UPDATED');
    console.log('-'.repeat(110));
    for (const a of r.artifacts) {
      const handle = `${a.owner}/${a.name}`;
      const k = a.k_score != null ? Number(a.k_score).toFixed(3) : '   -  ';
      const sz = fmtBytes(a.size_bytes).padStart(8);
      const base = (a.base_model || '-').slice(0, 28).padEnd(28);
      const age = a.updated_at ? a.updated_at.slice(0, 10) : '-';
      console.log(`${handle.padEnd(36)}${k.padStart(7)}  ${sz}  ${base}  ${age}`);
    }
    console.log('');
    console.log(`  pull one:  kolm pull ${r.artifacts[0].owner}/${r.artifacts[0].name}`);
    return;
  }
  if (sub === 'show') {
    const handle = args[1];
    if (!handle) { console.error('usage: kolm hub show <owner>/<name>'); process.exit(EXIT.BAD_ARGS); }
    const m = handle.match(/^([a-z0-9-]+)\/([a-z0-9-]+)/i);
    if (!m) { console.error('error: handle must be <owner>/<name>'); process.exit(EXIT.BAD_ARGS); }
    const [, owner, name] = m;
    let r;
    try { r = await api(c, 'GET', `/v1/hub/${owner}/${name}`); }
    catch (e) { console.error('error: ' + e.message); process.exit(1); }
    if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`${r.owner}/${r.name}`);
    console.log('-'.repeat(48));
    console.log(`  handle:     ${r.handle}`);
    console.log(`  sha256:     ${r.sha256}`);
    console.log(`  size:       ${fmtBytes(r.size_bytes)}`);
    console.log(`  visibility: ${r.visibility}`);
    if (r.metadata?.k_score != null) console.log(`  K-score:    ${Number(r.metadata.k_score).toFixed(3)}  (gate ${r.metadata.gate || 0.85})`);
    if (r.metadata?.base_model) console.log(`  base:       ${r.metadata.base_model}`);
    if (r.metadata?.task) console.log(`  task:       ${r.metadata.task}`);
    if (r.metadata?.tags?.length) console.log(`  tags:       ${r.metadata.tags.join(', ')}`);
    if (r.metadata?.license) console.log(`  license:    ${r.metadata.license}`);
    console.log(`  updated:    ${r.updated_at}`);
    console.log('');
    console.log(`  download:   kolm pull ${r.owner}/${r.name}`);
    return;
  }
  console.error('usage: kolm hub [list|show <handle>]');
  process.exit(EXIT.BAD_ARGS);
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
  if (sub === 'image') {
    // kolm capture image <path-or-url> [--prompt "..."] [--response "..."] [--ocr] [--namespace n] [--label l]
    const rest = args.slice(1);
    const src = rest.find(a => !a.startsWith('-'));
    if (!src) {
      console.error('usage: kolm capture image <path|url|data-uri> [--prompt P] [--response R] [--ocr] [--namespace N] [--label L]');
      process.exit(EXIT.BAD_ARGS);
    }
    const prompt = pickFlag(rest, '--prompt') || '';
    const response = pickFlag(rest, '--response') || '';
    const label = pickFlag(rest, '--label') || null;
    const namespace = pickFlag(rest, '--namespace') || pickFlag(rest, '-n') || 'default';
    const ocr = rest.includes('--ocr');
    const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname)).replace(/^\/([A-Z]):/, '$1:');
    const script = [
      'import sys, json',
      'sys.path.insert(0, r"' + repoRoot + '")',
      'from apps.capture.image import capture_image, as_example',
      `img = capture_image(${JSON.stringify(src)}, ocr=${ocr ? 'True' : 'False'}, label=${label ? JSON.stringify(label) : 'None'})`,
      `ex = as_example(img, ${JSON.stringify(prompt)}, ${JSON.stringify(response)})`,
      'print(json.dumps(ex))',
    ].join('\n');
    const r = spawnSync(py, ['-c', script], { encoding: 'utf-8' });
    if (r.status !== 0) {
      console.error('image capture failed:', r.stderr || r.error || 'unknown');
      console.error('(install Pillow: pip install pillow)');
      process.exit(EXIT.EXECUTION);
    }
    const captureDir = path.join(KOLM_DIR, 'capture', 'images');
    fs.mkdirSync(captureDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const out = path.join(captureDir, `${namespace}-${ts}.jsonl`);
    fs.appendFileSync(out, r.stdout.trim() + '\n');
    console.log(`captured: ${out}`);
    console.log(`namespace: ${namespace}`);
    console.log('hint: kolm distill --namespace ' + namespace);
    return;
  }
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
  const base_model = pickFlag(args, '--base-model') || 'Qwen/Qwen2.5-3B-Instruct';
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

// Read a JSONL or JSON-array file of eval rows. Tolerant of both shapes the
// CLI documents: {input, expected} and {input, output} (the same JSONL used
// for training fixtures). Lines that don't parse are skipped silently — eval
// failure should be from the recipe, not a one-bad-line abort. Returns an
// array of {input, expected, id?, params?} suitable for evalArtifact({cases}).
function readExamplesJsonl(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const trimmed = text.trim();
  let rawRows;
  if (trimmed.startsWith('[')) {
    try { rawRows = JSON.parse(trimmed); }
    catch { rawRows = []; }
  } else {
    rawRows = trimmed.split(/\r?\n/).filter(Boolean).map(ln => {
      try { return JSON.parse(ln); } catch { return null; }
    }).filter(Boolean);
  }
  const out = [];
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row || typeof row !== 'object') continue;
    if (row.input === undefined) continue;
    const expected = row.expected !== undefined ? row.expected
                   : row.output   !== undefined ? row.output
                   : null;
    if (expected === null) continue;
    out.push({
      id: row.id || `case_${i + 1}`,
      input: row.input,
      expected,
      ...(row.params ? { params: row.params } : {}),
    });
  }
  return out;
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
  const jsonOut = args.includes('--json');
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

  let red = 0, yellow = 0;
  for (const ch of checks) {
    if (ch.status === 'missing') red++;
    else if (ch.status === 'warn') yellow++;
  }

  if (jsonOut) {
    const result = {
      ok: red === 0,
      blockers: red,
      warnings: yellow,
      checks,
    };
    console.log(JSON.stringify(result, null, 2));
    if (red > 0) process.exit(EXIT.MISSING_PREREQ);
    return;
  }

  // Render
  const STATUS = { ok: '✓', warn: '!', missing: '✗' };
  for (const ch of checks) {
    process.stdout.write(`${STATUS[ch.status] || '?'}  ${ch.name.padEnd(28)}  ${ch.detail || ''}\n`);
  }
  process.stdout.write('\n');
  if (red > 0) {
    process.stdout.write(`${red} blocker${red === 1 ? '' : 's'}, ${yellow} warning${yellow === 1 ? '' : 's'}. fix the ✗ rows above and re-run.\n`);
    process.exit(EXIT.MISSING_PREREQ);
  }
  process.stdout.write(`all required checks pass (${yellow} warning${yellow === 1 ? '' : 's'}).\n`);
  // Training-data tip: surfaces kolm seeds so new users know the path exists.
  // Two-line nudge, not a check (doesn't affect exit code or counters).
  process.stdout.write('\n');
  process.stdout.write('tip: to bootstrap training data for your task, run:\n');
  process.stdout.write('  kolm seeds new <template>          # scaffold a starter seed file\n');
  process.stdout.write('  kolm seeds bootstrap --task phi-redactor   # public-domain seed dataset\n');
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
      console.log('  ' + fmtKScoreLine(e.k_score, path.basename(ap)));
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
        console.log('    ' + fmtKScoreLine(r.k_score, path.basename(ap)));
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

// ASCII brand mark for `kolm version`. Mono / restrained, no emoji, no color
// (color() already respects NO_COLOR + TERM=dumb but the mark itself stays
// pure ASCII so it reads identically in any terminal, CI log, or pipe).
const KOLM_BRAND = [
  '',
  '  k o l m',
  '  ─────── the private AI compiler',
  '',
].join('\n');

async function cmdVersion(args) {
  if (maybeHelp('version', args)) return;
  const jsonOut = args.includes('--json');
  // Short form: --version / -v / --short returns a single SemVer line in <50ms.
  // This matches gh/deno/stripe/vercel behaviour; only the full `kolm version`
  // verb hits the network for a cloud handshake.
  const shortMode = args.includes('--short') || args.includes('-v');
  // Hard-offline mode: KOLM_AIRGAP=1, ~/.kolm/airgap.env on disk, or --offline.
  const offline = args.includes('--offline') || process.env.KOLM_AIRGAP === '1'
    || fs.existsSync(path.join(KOLM_DIR, 'airgap.env'));
  const c = loadConfig();
  if (jsonOut) {
    let cloud = null;
    if (!offline && !shortMode) {
      try {
        const url = c.base.replace(/\/+$/, '') + '/health';
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2000);
        const res = await fetch(url, { headers: authHeaders(c), signal: ctl.signal });
        clearTimeout(t);
        if (res.ok) cloud = await res.json();
      } catch {}
    }
    console.log(JSON.stringify({
      cli: VERSION,
      spec: 'rs-1',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      base: c.base,
      airgap: offline,
      cloud,
    }, null, 2));
    return;
  }
  if (shortMode) {
    console.log('kolm v' + VERSION);
    return;
  }
  console.log(KOLM_BRAND);
  console.log('kolm cli   v' + VERSION);
  console.log('spec       rs-1');
  if (offline) {
    console.log('kolm cloud (skipped: airgap mode)');
    return;
  }
  try {
    const url = c.base.replace(/\/+$/, '') + '/health';
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(url, { headers: authHeaders(c), signal: ctl.signal });
    clearTimeout(t);
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

// ---------- natural-language ask ----------
// `kolm ask "<question>"` routes a free-text prompt through /v1/assistant.
// The server-side intent parser is deterministic and rule-based (no LLM
// round-trip), and returns { ok, intent, narration, data?, next_steps? }.
// We render the narration + next_steps so non-technical users get a useful
// reply (or a guided path) without having to know any verb-noun grammar.
async function cmdAsk(args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP.ask || `kolm ask - ask in natural language. Usage: kolm ask "<your question>"`);
    return;
  }
  // Strip flags from the prompt so users can pass `--airgap` / `--offline` / `--json`.
  const wantJson = args.includes('--json');
  const wantOffline = args.includes('--airgap') || args.includes('--offline')
    || process.env.KOLM_AIRGAP === '1'
    || fs.existsSync(path.join(KOLM_DIR, 'airgap.env'));
  const promptArgs = args.filter(a => !['--json', '--airgap', '--offline'].includes(a));
  const prompt = promptArgs.join(' ').replace(/^["']|["']$/g, '');
  const c = loadConfig();
  // Local-first fallback mirrors `kolm chat` so the verb is useful without an
  // api key OR on a fully air-gapped box. Online path stays primary when a key
  // is configured and --offline is not set (deterministic intent parser, no LLM).
  const useLocal = wantOffline || !c.api_key;
  if (useLocal) {
    const r = localAssistantParse(prompt);
    if (wantJson) { console.log(JSON.stringify(r, null, 2)); return; }
    renderAskReply(r, c, { local: true });
    if (!c.api_key && !wantOffline) {
      console.log('note: run `kolm login` for live hosted replies (status, builds, quota).');
    }
    return;
  }
  try {
    const r = await api(c, 'POST', '/v1/assistant', { prompt });
    if (wantJson) { console.log(JSON.stringify(r, null, 2)); return; }
    renderAskReply(r, c, { local: false });
    if (!r.ok && !r.narration) {
      const err = new Error('assistant: no reply');
      err.exitCode = EXIT.EXECUTION;
      throw err;
    }
  } catch (e) {
    if (e.status === 401) {
      const err = new Error('auth_required. run `kolm login` or set KOLM_API_KEY.');
      err.exitCode = EXIT.MISSING_PREREQ;
      throw err;
    }
    // On any network/transport error fall back to the local parser so the verb
    // stays useful (matches `kolm chat` behaviour). Only surface the original
    // error in --json mode where callers parse it.
    if (wantJson) { throw e; }
    const r = localAssistantParse(prompt);
    renderAskReply(r, c, { local: true });
    console.log('note: hosted assistant unreachable (' + (e && e.message || 'network') + '). offline reply above.');
  }
}

// Shared renderer for ask + chat-once. Keeps formatting consistent so both
// verbs print identical layouts regardless of which path served the reply.
function renderAskReply(r, c, opts) {
  if (!r) return;
  if (r.narration) {
    console.log('');
    console.log(r.narration);
    console.log('');
  }
  if (r.data && r.data.command) {
    console.log('  ' + r.data.command);
    console.log('');
  }
  if (r.data && r.data.curl) {
    console.log(r.data.curl);
    console.log('');
  }
  if (Array.isArray(r.next_steps) && r.next_steps.length) {
    console.log('try:');
    for (const s of r.next_steps) {
      const tail = s.command ? s.command
        : (s.prompt ? `kolm ask "${s.prompt}"`
        : (s.href ? (c && c.base ? c.base.replace(/\/$/, '') : '') + s.href : ''));
      console.log('  ' + (s.label || '').padEnd(12) + tail);
    }
    console.log('');
  }
  if (Array.isArray(r.data && r.data.items) && r.data.items.length) {
    for (const it of r.data.items.slice(0, 10)) {
      console.log('  ' + (it.id || '').padEnd(24) + ' ' + (it.name || '').padEnd(28) + (it.k_score != null ? `K=${it.k_score}` : ''));
    }
    console.log('');
  }
}

// ---------- natural-language chat (REPL) ----------
// `kolm chat` opens an interactive natural-language session. Talks to the
// hosted /v1/assistant rule-based parser when online (deterministic, no LLM,
// no telemetry), with a local mirror of the same parser when offline or when
// --airgap is set. The local fallback covers every intent so the REPL stays
// useful on fully air-gapped machines: it cannot run real cloud compiles,
// but it tells the user which kolm verb to run and renders the canonical
// next steps. Reachable from `kolm chat`, `kolm chat --once "<prompt>"`,
// `echo "<prompt>" | kolm chat --once -` and `KOLM_AIRGAP=1 kolm chat`.

// Mirror of src/assistant.js detectIntent. Pure JS, no I/O, deterministic.
// Same regex precedence as the server so a given prompt produces the same
// intent on-box and off-box. Keep these in sync when the server parser
// changes.
function chatLc(s) { return String(s == null ? '' : s).toLowerCase(); }
function chatTrim(s) { return String(s == null ? '' : s).trim(); }

const CHAT_JOB_ID_RE = /\bjob_[0-9a-f]{6,}\b/i;

function chatExtractJobId(prompt) {
  const m = String(prompt == null ? '' : prompt).match(CHAT_JOB_ID_RE);
  return m ? m[0] : null;
}

function chatDetectIntent(prompt) {
  const p = chatLc(prompt);
  if (!p) return 'help';
  // A prompt containing a job_xxx id is ALWAYS a status query, never a new
  // compile. Mirrors src/assistant.js so airgap parity holds.
  if (CHAT_JOB_ID_RE.test(p)) return 'job_status';
  if (/^(help|hi|hello|hey|what can you do|what do you do)\b/.test(p)) return 'help';
  if (/\b(doctor|debug|why( is| 's|s) it broken|whats wrong|health check|check setup|check (my )?(setup|health|install|environment|config))\b/.test(p)) return 'doctor';
  if (/\b(usage|how much (have i|did i)|left in (my )?quota|consumed|burning)\b/.test(p)) return 'usage';
  if (/\b(status|account|where am i|am i on|what plan)\b/.test(p)) return 'status';
  if (/\b(list|show|all my|what (have i|did i) (build|compile|ship))\b/.test(p)) return 'list';
  if (/\b(upgrade|go pro|move to pro|switch to|change plan)\b/.test(p)) return 'upgrade';
  if (/\b(install|wire up|hook up|claude code|cursor|continue|cline)\b/.test(p)) return 'install';
  // Prefer compile when the prompt explicitly says "compile", even when a
  // word like "train" appears as part of a filename ("compile a redactor
  // using train.jsonl"). Mirrors src/assistant.js so airgap parity holds.
  if (/\bcompile\b/.test(p)) return 'compile';
  // Exclude filename matches like train.jsonl / tune.yaml via negative
  // lookahead on dot-extension. Real tune verbs are followed by whitespace
  // or end-of-string, not a file extension.
  if (/\b(tune|train|evolve|fine ?tune|fine ?tuning)\b(?!\.\w)/.test(p)) return 'tune';
  if (/\b(run|execute|invoke|call)\b/.test(p)) return 'run';
  if (/\b(compile|build|make|create|new)\b/.test(p)) return 'compile';
  return 'help';
}

function chatExtractTask(prompt) {
  return chatTrim(prompt)
    .replace(/^(please\s+)?(compile|build|make|create|new)\s+(me\s+)?(a\s+|an\s+)?(recipe\s+|concept\s+|artifact\s+|kolm\s+)?(that\s+|to\s+|for\s+|which\s+)?/i, '')
    .replace(/^[a-z\- ]{1,20}\s+to\s+/i, '');
}

function chatExtractTargetPlan(prompt) {
  const p = chatLc(prompt);
  const plans = ['enterprise', 'business', 'teams', 'pro', 'starter'];
  for (let i = 0; i < plans.length; i++) {
    if (p.indexOf(plans[i]) >= 0) return plans[i];
  }
  return 'pro';
}

function chatExtractHarness(prompt) {
  const p = chatLc(prompt);
  const list = ['claude-code', 'claude code', 'cursor', 'continue', 'cline'];
  for (let i = 0; i < list.length; i++) {
    if (p.indexOf(list[i]) >= 0) return list[i].replace(' ', '-');
  }
  return null;
}

function chatExtractConcept(prompt) {
  const tokens = chatTrim(prompt).split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (!last) return null;
  if (/^cpt_/.test(last)) return last;
  if (last.length >= 3 && last.length <= 64) return last;
  return null;
}

// Pure rule-based local mirror of /v1/assistant. Returns the same
// { ok, intent, narration, data?, next_steps? } shape the server returns,
// so renderChatReply works identically for both paths. Heavy intents
// (compile, run) surface the right local CLI command rather than firing
// any network call.
function localAssistantParse(prompt) {
  const intent = chatDetectIntent(prompt);
  switch (intent) {
    case 'help':
      return {
        ok: true,
        intent: 'help',
        narration: "I can help you compile, run, list, train, install, upgrade, or check status. Try 'compile a phi redactor' or 'show my last 3 compiles'.",
        next_steps: [
          { label: 'status',  prompt: 'show my status' },
          { label: 'list',    prompt: 'show my builds' },
          { label: 'compile', prompt: 'compile a recipe that redacts secrets' },
          { label: 'install', prompt: 'install claude-code' },
          { label: 'tune',    prompt: 'start tune loop' },
          { label: 'upgrade', prompt: 'upgrade to pro' },
        ],
      };
    case 'status':
    case 'usage':
      return {
        ok: true,
        intent: intent,
        narration: "Run 'kolm whoami' for account snapshot (offline-safe). Online: I'd pull live plan + quota.",
        next_steps: [
          { label: 'whoami',  command: 'kolm whoami' },
          { label: 'doctor',  command: 'kolm doctor' },
        ],
      };
    case 'list':
      return {
        ok: true,
        intent: 'list',
        narration: "Run 'kolm list' to see every local .kolm artifact with K-score, size, and age.",
        next_steps: [
          { label: 'list',    command: 'kolm list' },
          { label: 'inspect', command: 'kolm inspect <art.kolm>' },
        ],
      };
    case 'job_status': {
      // Offline mirror: we cannot query cloud-side job state, so we just
      // surface the right local command. Online (sendChat -> /v1/assistant)
      // hits the server case which returns live state.
      const jobId = chatExtractJobId(prompt);
      return {
        ok: true,
        intent: 'job_status',
        narration: jobId
          ? "Online: I'd fetch live status for " + jobId + ". Offline: run 'kolm whoami' for a snapshot or visit /dashboard."
          : "I could not parse a job id (looks like job_abcdef123456).",
        data: { job_id: jobId, command: jobId ? 'kolm jobs ' + jobId : null },
        next_steps: jobId ? [
          { label: 'view job', command: 'kolm jobs ' + jobId },
          { label: 'list jobs', command: 'kolm jobs list' },
        ] : [
          { label: 'list jobs', command: 'kolm jobs list' },
        ],
      };
    }
    case 'compile': {
      const task = chatExtractTask(prompt);
      const tail = task && task.length >= 4 ? ' "' + task + '"' : ' "<describe the recipe>"';
      return {
        ok: true,
        intent: 'compile',
        narration: "Online: I'd kick off a compile job. Offline: run 'kolm compile <task>' to start one locally.",
        data: { task: task || null, command: 'kolm compile' + tail },
        next_steps: [
          { label: 'compile',  command: 'kolm compile' + tail },
          { label: 'new spec', command: 'kolm new <name> --from blank' },
          { label: 'verify',   command: 'kolm verify <art.kolm> --binder report.html' },
        ],
      };
    }
    case 'run': {
      const cid = chatExtractConcept(prompt);
      const tail = cid ? ' ' + cid + '.kolm "<input>"' : ' <artifact>.kolm "<input>"';
      return {
        ok: true,
        intent: 'run',
        narration: "Run 'kolm run <artifact>.kolm \"<input>\"' to invoke a compiled artifact locally.",
        data: { concept_id: cid, command: 'kolm run' + tail },
        next_steps: [
          { label: 'run',     command: 'kolm run' + tail },
          { label: 'list',    command: 'kolm list' },
        ],
      };
    }
    case 'tune':
    case 'evolve':
      return {
        ok: true,
        intent: 'tune',
        narration: "Run 'kolm train --spec <file>.spec.json' to start a local distill loop.",
        next_steps: [
          { label: 'train',     command: 'kolm train --spec <file>.spec.json' },
          { label: 'tune init', command: 'kolm tune init' },
          { label: 'capture',   command: 'kolm tune capture-on' },
          { label: 'step',      command: 'kolm tune step --airgap' },
        ],
      };
    case 'install': {
      const h = chatExtractHarness(prompt);
      const target = h || '<harness>';
      return {
        ok: true,
        intent: 'install',
        narration: "Run 'kolm install claude-code' (or cursor / continue / cline) to wire kolm into your IDE.",
        data: { harness: h, command: 'kolm install ' + target + ' --apply' },
        next_steps: [
          { label: 'claude-code', command: 'kolm install claude-code --apply' },
          { label: 'cursor',      command: 'kolm install cursor --apply' },
          { label: 'continue',    command: 'kolm install continue --apply' },
          { label: 'cline',       command: 'kolm install cline --apply' },
        ],
      };
    }
    case 'upgrade': {
      const target = chatExtractTargetPlan(prompt);
      return {
        ok: true,
        intent: 'upgrade',
        narration: "Run 'kolm plan --target pro' for an upgrade link. Plans: starter $19 . pro $99 . teams $299 . business $999.",
        data: { target: target, command: 'kolm plan --target ' + target },
        next_steps: [
          { label: 'plan',    command: 'kolm plan --target ' + target },
          { label: 'whoami',  command: 'kolm whoami' },
        ],
      };
    }
    case 'doctor':
      return {
        ok: true,
        intent: 'doctor',
        narration: "Run 'kolm doctor' for a config + connectivity snapshot.",
        next_steps: [
          { label: 'doctor', command: 'kolm doctor' },
          { label: 'config', command: 'kolm config' },
        ],
      };
    default:
      return {
        ok: true,
        intent: 'help',
        narration: "I am not sure what you meant. Try 'help'.",
      };
  }
}

// Try the hosted assistant first. On network error or when --airgap is set,
// fall back to the local parser. Both paths return the same shape.
async function sendChat(c, prompt, opts) {
  const airgap = !!(opts && opts.airgap);
  if (airgap) {
    const r = localAssistantParse(prompt);
    r._source = 'local';
    return r;
  }
  if (!c.api_key) {
    // No key, no network round-trip possible. Treat as airgap and tag it.
    const r = localAssistantParse(prompt);
    r._source = 'local';
    r._note = 'not signed in. run: kolm login   (offline reply shown)';
    return r;
  }
  try {
    const r = await api(c, 'POST', '/v1/assistant', { prompt: prompt });
    r._source = 'cloud';
    return r;
  } catch (e) {
    // Auth errors are not network errors. Surface them so the caller sees
    // the same hint cmdAsk surfaces. Network / DNS / fetch errors fall
    // back to the offline mirror.
    if (e && (e.status === 401 || e.status === 403)) {
      return {
        ok: false,
        intent: 'help',
        narration: 'auth_required. run: kolm login',
        _source: 'cloud',
      };
    }
    const r = localAssistantParse(prompt);
    r._source = 'local';
    r._note = 'network unreachable (' + (e && e.message || 'error') + '). offline reply shown.';
    return r;
  }
}

function renderChatReply(reply) {
  if (!reply) {
    console.log(color('31', 'kolm > (no reply)'));
    return;
  }
  const tag = reply._source === 'local' ? color('2', '[airgap] ')
            : reply._source === 'action' ? color('2', '[action] ')
            : '';
  const head = color('36', 'kolm') + ' ' + color('2', '>') + ' ';
  const narration = reply.narration || (reply.ok === false ? '(no narration)' : '');
  // The narration may contain newlines (doctor case). Indent continuation
  // lines so they line up under the bubble head.
  const lines = String(narration).split('\n');
  console.log(tag + head + lines[0]);
  for (let i = 1; i < lines.length; i++) {
    console.log('       ' + lines[i]);
  }
  // Render a small structured card when the server (or local) returns a
  // job/artifact/command we can show in 2-4 lines.
  const d = reply.data || {};
  const card = [];
  if (d.job_id) card.push('  job:      ' + d.job_id);
  if (d.status) card.push('  status:   ' + d.status);
  if (d.k_score != null) card.push('  k_score:  ' + d.k_score);
  if (d.artifact_url) card.push('  artifact: ' + d.artifact_url);
  if (d.poll && !d.job_id) card.push('  poll:     ' + d.poll);
  if (d.command && !card.length) card.push('  ' + d.command);
  if (card.length) {
    console.log('');
    for (let i = 0; i < card.length; i++) console.log(card[i]);
  }
  if (Array.isArray(d.items) && d.items.length) {
    console.log('');
    const rows = d.items.slice(0, 6);
    for (let i = 0; i < rows.length; i++) {
      const it = rows[i];
      const id = String(it.id || '').padEnd(24);
      const name = String(it.name || '').padEnd(28);
      const k = it.k_score != null ? 'K=' + it.k_score : '';
      console.log('  ' + id + ' ' + name + ' ' + k);
    }
  }
  if (Array.isArray(reply.next_steps) && reply.next_steps.length) {
    console.log('');
    const steps = reply.next_steps.slice(0, 8);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const tail = s.command ? s.command
                : s.prompt  ? 'kolm ask "' + s.prompt + '"'
                : s.href    ? s.href
                : '';
      const label = String(s.label || '').padEnd(12);
      console.log('  ' + color('2', '->') + ' ' + label + ' ' + tail);
    }
  }
  if (reply._note) {
    console.log('');
    console.log(color('33', '  note: ' + reply._note));
  }
}

function printChatHelp() {
  console.log('');
  console.log(color('1', 'slash commands'));
  console.log('  /help                show this menu');
  console.log('  /exit, /quit         leave the session');
  console.log('  /clear               clear the screen');
  console.log('  /airgap              toggle airgap mode (narration-only, no shell-out)');
  console.log('  /yes                 toggle auto-confirm for actions');
  console.log('');
  console.log(color('1', 'action examples') + color('2', ' . chat will run the matching kolm verb (with confirm)'));
  console.log('  make a redactor for medical notes        -> kolm new ... --from redactor');
  console.log('  build me a summarizer                    -> kolm new ... --from summarizer');
  console.log('  anonymize my customer data               -> kolm seeds generate --strategy redact-pii-templated');
  console.log('  upgrade kolm                             -> kolm upgrade');
  console.log('  check setup                              -> kolm doctor');
  console.log('');
  console.log(color('1', 'narration examples') + color('2', ' . chat replies, no shell-out'));
  console.log('  show my status');
  console.log('  show my last 3 builds');
  console.log('  install claude-code');
  console.log('');
}

function readStdinSync() {
  // Drain stdin synchronously for `--once -`. Used so a piped prompt
  // (e.g. `echo "..." | kolm chat --once -`) reads cleanly without the
  // interactive readline loop ever starting.
  try {
    const buf = fs.readFileSync(0, 'utf8');
    return chatTrim(buf);
  } catch (_e) {
    return '';
  }
}

// --- action-mode helpers ------------------------------------------------
// The classifier in localAssistantParse() (mirrored on the server) returns a
// narrative reply for every intent. Action mode adds a second pass: for the
// subset of intents that map cleanly to a concrete kolm verb, we rebuild the
// argv and dispatch to the matching cmd* function.
//
// Informational intents (status / usage / list / help / install) stay
// narration-only. They are the read-only reference card and the chat dock
// already renders them well. Airgap mode forces every intent narration-only.

// Map a free-text prompt to one of the SPEC_TEMPLATES keys, with a sensible
// fallback to blank. Same heuristic the `kolm new` auto-template uses on the
// name slug, but applied to the entire prompt so phrases like "make a redactor
// for medical notes" or "build me a summarizer" resolve cleanly.
// Find a seeds.jsonl-shaped file in the current working directory so the
// "anonymize my customer data" -> `kolm seeds generate` plan has a concrete
// --from path. Prefers ./seeds.jsonl, then any *.jsonl. Returns the basename
// (relative) so the action label stays readable in the [Y/n] prompt.
function findSeedsFileInCwd() {
  try {
    const cwd = process.cwd();
    const preferred = path.join(cwd, 'seeds.jsonl');
    if (fs.existsSync(preferred)) return 'seeds.jsonl';
    const entries = fs.readdirSync(cwd).filter(function (f) { return /\.jsonl$/i.test(f); });
    if (entries.length === 1) return entries[0];
    // If multiple jsonls present, prefer the lexicographically first so the
    // plan is deterministic. The user can always re-run with explicit args.
    if (entries.length > 1) return entries.sort()[0];
  } catch (_e) { /* ignore */ }
  return null;
}

function chatInferTemplate(prompt) {
  const p = chatLc(prompt);
  // Use prefix word-boundaries only so "redactor"/"summarizer"/"classifier" /
  // "extractor" all match their root verbs cleanly. \b on both sides would
  // miss "redactor" because the trailing "or" keeps it inside the word.
  if (/\b(redact|deidentify|de-identify|phi|pii|scrub|mask|anonymi[sz]e)/.test(p)) return 'redactor';
  if (/\b(summari[sz]|abstract|tldr|tl-dr|digest|brief)/.test(p)) return 'summarizer';
  if (/\b(classif|triag|categor|label|route|router|sort)/.test(p)) return 'classifier';
  if (/\b(extract|parse|fields|invoice|receipt)/.test(p)) return 'extractor';
  return 'blank';
}

// Pick a short slug name out of a free-text "make/build/create a {kind}" ask.
// We use the inferred template name as the spine ("redactor", "summarizer",
// etc.) and let the user rename later via --out. This avoids guessing a domain
// slug ("medical-notes-redactor") that the user didn't actually type.
function chatInferArtifactName(prompt, template) {
  const stripped = chatTrim(prompt)
    .replace(/^(please\s+)?(compile|build|make|create|new)\s+(me\s+)?(a\s+|an\s+)?/i, '')
    .replace(/\s+(for|to|that|which|from)\s+.*$/i, '');
  const candidate = slugify(stripped);
  if (candidate && candidate !== 'artifact' && candidate.length >= 3 && candidate.length <= 40) return candidate;
  return template === 'blank' ? 'my-artifact' : 'my-' + template;
}

// Decide whether a parsed reply maps to an executable kolm verb. Returns
// either { action: 'new'|'compile_cloud'|'seeds_generate'|'upgrade'|'doctor',
// argv, label, expensive } or null when the intent is informational only.
//
// We INTENTIONALLY pass through {status, usage, list, install, help,
// job_status, tune, run} as narration-only. status/list/install are the
// reference-card surface; job_status only works online; run needs a concrete
// artifact id which the local parser cannot reliably extract from a chat
// prompt without surprising the user.
function chatPlanAction(prompt, reply) {
  if (!reply || reply.ok === false) return null;
  const intent = reply.intent;
  const lower = chatLc(prompt);

  if (intent === 'compile') {
    const task = chatExtractTask(prompt);
    // "make/build/create a {redactor|summarizer|...}" without a real task body
    // is a scaffold ask, not a cloud-compile ask. Route it through `kolm new`
    // so the user gets a spec.json they can edit + compile offline.
    const scaffoldVerb = /^(please\s+)?(make|build|create|new|scaffold|generate)\b/.test(lower);
    const looksLikeKind = /\b(redactor|summari[sz]er|classifier|extractor|recipe|artifact|kolm)\b/.test(lower);
    if (scaffoldVerb && looksLikeKind) {
      const tmpl = chatInferTemplate(prompt);
      const name = chatInferArtifactName(prompt, tmpl);
      return {
        action: 'new',
        argv: [name, '--from', tmpl],
        label: 'kolm new ' + name + ' --from ' + tmpl,
        expensive: false,
      };
    }
    // Otherwise treat it as a real cloud-compile task. Needs an account so
    // we mark it expensive (prompts unless --yes).
    if (task && task.length >= 4) {
      // Sniff for a jsonl/json/csv examples file referenced in the prompt
      // ("compile a redactor using train.jsonl as examples"). If we find
      // one AND it exists in cwd, wire it as --examples so the cloud has
      // real data to score against. We strip the filename + connector words
      // from the task body so the task description is the actual goal,
      // not "compile X using Y as examples".
      const fileMatch = prompt.match(/\b([\w.\-/\\]+\.(?:jsonl|json|csv))\b/i);
      const argv = [task];
      let label = 'kolm compile "' + task + '"';
      if (fileMatch && fs.existsSync(fileMatch[1])) {
        const cleaned = task
          .replace(/\s+using\s+\S+\.(?:jsonl|json|csv)\s*(?:as\s+(?:examples|the\s+dataset|training\s+data|seeds|data))?\s*$/i, '')
          .replace(/\s+(?:from|with)\s+\S+\.(?:jsonl|json|csv)\s*$/i, '')
          .trim();
        const finalTask = cleaned && cleaned.length >= 4 ? cleaned : task;
        argv.length = 0;
        argv.push(finalTask, '--examples', fileMatch[1]);
        label = 'kolm compile "' + finalTask + '" --examples ' + fileMatch[1];
      }
      return {
        action: 'compile_cloud',
        argv: argv,
        label: label,
        expensive: true,
      };
    }
    return null;
  }

  // "anonymize my customer data", "generate more examples", "make training data"
  if (/\b(anonymi[sz]e|redact|de-?identify|scrub)\b/.test(lower) && /\b(data|customer|dataset|examples|rows|seeds)\b/.test(lower)) {
    const from = findSeedsFileInCwd();
    if (!from) return null; // bail to narration so user sees a real hint
    return {
      action: 'seeds_generate',
      argv: ['generate', '--from', from, '--strategy', 'redact-pii-templated', '--count', '50'],
      label: 'kolm seeds generate --from ' + from + ' --strategy redact-pii-templated --count 50',
      expensive: false,
    };
  }
  if (/\b(generate|expand|mutate)\b/.test(lower) && /\b(training data|examples|seeds|rows|dataset)\b/.test(lower)) {
    const from = findSeedsFileInCwd();
    if (!from) return null;
    return {
      action: 'seeds_generate',
      argv: ['generate', '--from', from, '--strategy', 'templated', '--count', '50'],
      label: 'kolm seeds generate --from ' + from + ' --strategy templated --count 50',
      expensive: false,
    };
  }

  if (intent === 'upgrade') {
    // Be careful here: the server "upgrade" intent is plan-upgrade (billing).
    // We only re-route to `kolm upgrade` (the version-check verb) when the
    // user clearly meant "update the CLI", not "switch plans".
    if (/\b(upgrade|update)\s+(the\s+)?(kolm|cli|client|tool|binary|package)\b/.test(lower)
        || /\b(latest|newer|new)\s+version\b/.test(lower)
        || /\b(kolm|cli)\s+(version|release)\b/.test(lower)) {
      return {
        action: 'upgrade',
        argv: [],
        label: 'kolm upgrade',
        expensive: true,
      };
    }
    return null;
  }

  if (intent === 'doctor') {
    return {
      action: 'doctor',
      argv: [],
      label: 'kolm doctor',
      expensive: false,
    };
  }

  return null;
}

// One-shot [Y/n] prompt. Resolves true on Y / Enter / blank, false on N.
// Skipped (auto-yes) in non-TTY contexts so piped / CI usage doesn't hang.
function chatConfirm(label) {
  if (!process.stdin.isTTY) return Promise.resolve(true);
  return new Promise(function (resolve) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(color('36', 'kolm') + ' ' + color('2', '>') + ' about to run: ' + color('1', label) + ' . proceed? [Y/n] ', function (a) {
      rl.close();
      const ans = String(a || '').trim().toLowerCase();
      resolve(!(ans === 'n' || ans === 'no'));
    });
  });
}

// Dispatch a parsed plan to the appropriate cmd* function. Caller is
// responsible for printing the "about to run" header (so the [Y/n] flow and
// the cheap-action path can share the same line). Returns { ok, exitCode? }
// so the caller can decide whether to chain follow-ups.
async function chatRunAction(plan) {
  console.log('');
  try {
    if (plan.action === 'new')              await cmdNew(plan.argv);
    else if (plan.action === 'compile_cloud') await cmdCompile(plan.argv);
    else if (plan.action === 'seeds_generate') await cmdSeeds(plan.argv);
    else if (plan.action === 'upgrade')     await cmdUpgrade(plan.argv);
    else if (plan.action === 'doctor')      await cmdDoctor(plan.argv);
    else if (plan.action === 'verify')      await cmdVerify(plan.argv);
    else if (plan.action === 'run')         await cmdRun(plan.argv);
    else if (plan.action === 'compile_spec') await cmdCompile(plan.argv);
    else return { ok: false, error: 'unknown action: ' + plan.action };
    return { ok: true };
  } catch (e) {
    console.log(color('31', 'kolm > action failed: ') + (e && e.message || e));
    return { ok: false, error: e && e.message || String(e), exitCode: e && e.exitCode || EXIT.EXECUTION };
  }
}

// Print 1-2 sensible follow-ups after a successful action. Mirrors the
// next_steps array shape the chat dock already understands.
function chatPrintNextSteps(plan) {
  if (!plan) return;
  console.log('');
  console.log(color('36', 'kolm') + ' ' + color('2', '>') + ' done. next:');
  if (plan.action === 'new') {
    const name = plan.argv[0];
    console.log('  ' + color('2', '->') + ' compile  kolm compile --spec ' + name + '.spec.json');
    console.log('  ' + color('2', '->') + ' edit     open ' + name + '.spec.json and tweak recipes[0].source');
  } else if (plan.action === 'compile_cloud') {
    console.log('  ' + color('2', '->') + ' list     kolm list');
    console.log('  ' + color('2', '->') + ' run      kolm run <artifact>.kolm \'<input-json>\'');
  } else if (plan.action === 'seeds_generate') {
    console.log('  ' + color('2', '->') + ' inspect  kolm seeds list');
    console.log('  ' + color('2', '->') + ' train    kolm train --spec <spec> --seeds <file>.jsonl');
  } else if (plan.action === 'upgrade') {
    console.log('  ' + color('2', '->') + ' apply    kolm update');
    console.log('  ' + color('2', '->') + ' version  kolm version');
  } else if (plan.action === 'doctor') {
    console.log('  ' + color('2', '->') + ' login    kolm login');
    console.log('  ' + color('2', '->') + ' init     kolm init');
  }
}

// --- build-a-model funnel ---------------------------------------------------
// Multi-turn stateful guide for the "i wanna build a model" flow. Founder ask:
// "I put in NL I wanna build a model, I have an example or few, you need to
// be able to guide the user through every single step in a funnel."
//
// Phases: detect -> task -> examples -> confirm -> compile -> verify -> run -> done.
// Each step is ONE prompt + waits for the next user line. State lives in a
// closure object inside cmdChat() so it persists across readline turns.
//
// Triggers on NL phrases that mean "i want to build a thing". Kept narrow
// enough that single-shot intents ("show my status", "compile <task>") still
// route to the existing cmd* dispatcher.
function chatBuildFunnelTrigger(prompt) {
  const p = chatLc(prompt);
  if (!p) return false;
  // Don't hijack prompts that already specify a concrete compile (those go
  // through the existing compile dispatcher with a real task body).
  if (/^compile\s+(?!a\s|an\s)/.test(p)) return false;
  // Direct "i wanna build a model" family.
  if (/\b(i\s+(wanna|want\s+to|wish\s+to|would\s+like\s+to)|lets|let\'?s)\s+(build|make|create|train|compile|ship)\s+(a|an|me|my|some)?\s*(model|ai|recipe|artifact|kolm|classifier|redactor|summari[sz]er|extractor)\b/.test(p)) return true;
  // "build me a model" / "make me an ai".
  if (/\b(build|make|create)\s+me\s+(a|an)\s+(model|ai|recipe|artifact|kolm|classifier|redactor|summari[sz]er|extractor)\b/.test(p)) return true;
  // "i have examples" / "i have a few examples" / "with these examples".
  if (/\b(i\s+have|we\s+have)\s+(a\s+few\s+|some\s+|several\s+)?examples\b/.test(p)) return true;
  if (/\b(with|using)\s+(these|some|my|a\s+few)\s+examples\b/.test(p)) return true;
  // Generic "build a <thing>" / "build an ai" with no leading verb fragment.
  if (/^(build|make|create|train)\s+(a|an)\s+(model|ai|classifier|redactor|summari[sz]er|extractor)\b/.test(p)) return true;
  // "compile a model" / "compile an ai" - explicit but task-less compile asks.
  if (/^compile\s+(a|an)\s+(model|ai)\b/.test(p)) return true;
  return false;
}

// Phase-machine factory.
function chatCreateBuildFunnel() {
  return {
    phase: 'detect',
    task: null,
    template: null,
    artifact_name: null,
    examples_path: null,
    examples_source: null,
    pasted_jsonl: [],     // accumulator for multi-line paste in examples phase
    compile_result: null,
    verify_result: null,
    started_at: Date.now(),
  };
}

// Format the prompt for the current phase. Returns a string the caller
// prints with the standard `kolm > ` bubble head. Each phase is ONE
// question. No wall of text.
function chatFunnelPromptFor(state) {
  if (state.phase === 'detect') {
    return "got it. what should this model do? (e.g. 'redact PHI from doctor notes', 'classify support tickets by urgency', 'extract invoice fields'). type a sentence, or 'exit' to bail.";
  }
  if (state.phase === 'examples') {
    return "any examples? options:\n  paste JSONL (one row per line, e.g. {\"input\":\"...\",\"output\":\"...\"}  output|expected both accepted)\n  give a path (./seeds.jsonl)\n  type 'no' to bootstrap a starter pack\n  type 'exit' to bail";
  }
  if (state.phase === 'confirm') {
    const label = 'kolm new ' + state.artifact_name + ' --from ' + state.template +
      (state.examples_path ? '  then  kolm compile "' + state.task + '" --examples ' + state.examples_path : '');
    return "i'll scaffold this as " + color('1', state.artifact_name + '.kolm') + " using the " + color('1', state.template) + " template" +
      (state.examples_path ? " with examples from " + color('1', state.examples_path) : " (starter recipe, you can edit before compile)") +
      ". plan:\n  " + label + "\nproceed? (y/n, or type a new name)";
  }
  if (state.phase === 'verify') {
    return "compiled. want me to run " + color('1', 'kolm verify') + " to confirm chain + signatures? (y/n)";
  }
  if (state.phase === 'run') {
    return "verified. want to test it on a sample input now? (y/n, or paste an input string)";
  }
  return null;
}

// Given current state + user input, advance the state machine one step.
// Returns { newState, narration, action?, postAction?, finished, hint? }.
async function chatFunnelStep(state, input, opts) {
  const optsX = opts || {};
  const airgap = !!optsX.airgap;
  void optsX;
  const trimmed = chatTrim(input);
  const lower = chatLc(trimmed);
  // Bail anywhere with /exit, /quit, exit, stop, cancel.
  if (/^(\/?(exit|quit)|stop|cancel|nevermind|never\s+mind)$/.test(lower)) {
    state.phase = 'done';
    return { newState: state, narration: 'funnel cancelled. nothing was built.', finished: true };
  }

  // PHASE 1 -> 2: capture task
  if (state.phase === 'detect') {
    if (trimmed.length < 4) {
      return { newState: state, narration: "i need a sentence. what should the model do? (or 'exit' to bail)", finished: false };
    }
    state.task = trimmed;
    state.template = chatInferTemplate(trimmed);
    state.artifact_name = chatBuildFunnelDeriveName(trimmed, state.template);
    state.phase = 'examples';
    return { newState: state, narration: chatFunnelPromptFor(state), finished: false };
  }

  // PHASE 2 -> 3: examples
  if (state.phase === 'examples') {
    // Branch A: pasted JSONL (line starts with '{'). Accumulate consecutive
    // JSONL lines until we see a non-JSONL line or "done" / blank line so
    // the user can paste multiple rows back-to-back.
    if (trimmed.startsWith('{')) {
      const parsed = chatBuildFunnelParseJsonl(trimmed);
      if (!parsed.ok) {
        return { newState: state, narration: "couldn't parse JSONL: " + parsed.error + ". try again, paste a path, or type 'no'.", finished: false };
      }
      state.pasted_jsonl.push.apply(state.pasted_jsonl, parsed.rows);
      // Stay in examples phase, prompt for more rows. The user can type
      // 'done' (or 'y' / blank line) to commit, or paste more rows.
      return { newState: state, narration: 'queued ' + state.pasted_jsonl.length + ' row(s). paste more, or type ' + color('1', 'done') + ' to use these.', finished: false };
    }
    // Commit accumulated rows.
    if (state.pasted_jsonl.length > 0 && /^(done|y|yes|ok|that\'?s\s+it)$/.test(lower)) {
      const outPath = chatBuildFunnelWriteSeeds(state.pasted_jsonl, state.artifact_name);
      const count = state.pasted_jsonl.length;
      state.examples_path = outPath;
      state.examples_source = 'paste';
      state.pasted_jsonl = [];
      state.phase = 'confirm';
      return { newState: state, narration: 'saved ' + count + ' example(s) to ' + color('1', outPath) + '.\n\n' + chatFunnelPromptFor(state), finished: false };
    }
    // Branch B: file path. Validate early so the user finds out about format
    // problems here, not 3 verbs deeper at compile time.
    if (/\.(jsonl|json|csv|txt)$/i.test(trimmed) || trimmed.startsWith('./') || trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.indexOf('/') >= 0 || trimmed.indexOf('\\') >= 0) {
      const resolved = path.resolve(process.cwd(), trimmed);
      if (!fs.existsSync(resolved)) {
        return { newState: state, narration: "i don't see a file at " + trimmed + ". try a different path, paste JSONL, or type 'no'.", finished: false };
      }
      // Hard reject CSV with the awk one-liner to fix it.
      if (/\.csv$/i.test(trimmed)) {
        return { newState: state, narration: "i read JSONL, not CSV. convert " + path.basename(trimmed) + " first (one JSON object per line):\n  awk -F, 'NR>1{printf \"{\\\"input\\\":\\\"%s\\\",\\\"output\\\":\\\"%s\\\"}\\n\",$1,$2}' " + path.basename(trimmed) + " > seeds.jsonl\nthen come back with the .jsonl path.", finished: false };
      }
      // Early parseability + shape check so problems surface here.
      let validatedRows = 0;
      let validatedShape = 'unknown';
      try {
        const raw = fs.readFileSync(resolved, 'utf8');
        const lines = raw.split(/\r?\n/);
        let inputCount = 0; let outputCount = 0; let expectedCount = 0;
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i].trim();
          if (!ln || ln.startsWith('//') || ln.startsWith('#')) continue;
          try {
            const row = JSON.parse(ln);
            if (row && typeof row === 'object') {
              validatedRows++;
              if ('input' in row) inputCount++;
              if ('output' in row) outputCount++;
              if ('expected' in row) expectedCount++;
            }
          } catch (e) {
            return { newState: state, narration: "couldn't parse line " + (i + 1) + " of " + path.basename(trimmed) + ": " + e.message + ".\ntry: kolm seeds validate " + trimmed + "  to see all errors.", finished: false };
          }
        }
        if (validatedRows === 0) {
          return { newState: state, narration: "file " + path.basename(trimmed) + " has no usable rows. expected one JSON object per line.\ntry: kolm seeds validate " + trimmed, finished: false };
        }
        if (outputCount > 0 && expectedCount === 0) validatedShape = '{input, output}';
        else if (expectedCount > 0 && outputCount === 0) validatedShape = '{input, expected}';
        else if (outputCount > 0 && expectedCount > 0) validatedShape = '{input, output|expected} mixed';
        else validatedShape = '{input only}';
      } catch (e) {
        return { newState: state, narration: "couldn't read " + path.basename(trimmed) + ": " + e.message, finished: false };
      }
      state.examples_path = trimmed;
      state.examples_source = 'path';
      state.phase = 'confirm';
      return { newState: state, narration: "found " + validatedRows + " row(s) in " + color('1', trimmed) + " (shape: " + validatedShape + ").\n\n" + chatFunnelPromptFor(state), finished: false };
    }
    // Branch C: "no" / "none" / "skip"
    if (/^(no|n|none|skip|nothing|no examples)$/.test(lower) || /\b(no\s+examples|don\'?t\s+have)/.test(lower)) {
      const tmplName = state.template;
      const seedTask = tmplName === 'redactor' ? 'phi-redactor' : null;
      if (seedTask && PUBLIC_SEEDS[seedTask] && PUBLIC_SEEDS[seedTask].ships) {
        const dir = findPublicSeedsDir();
        const src = dir ? path.join(dir, PUBLIC_SEEDS[seedTask].file) : null;
        if (src && fs.existsSync(src)) {
          const outPath = path.resolve(process.cwd(), 'seeds.jsonl');
          if (!fs.existsSync(outPath)) {
            const raw = fs.readFileSync(src, 'utf8');
            fs.writeFileSync(outPath, raw);
          }
          state.examples_path = 'seeds.jsonl';
          state.examples_source = 'bootstrap';
          state.phase = 'confirm';
          return { newState: state, narration: "no problem. bootstrapped " + color('1', seedTask) + " public-domain starter pack into " + color('1', 'seeds.jsonl') + ". " + PUBLIC_SEEDS[seedTask].note + ".\n\n" + chatFunnelPromptFor(state), finished: false };
        }
      }
      state.examples_path = null;
      state.examples_source = 'none';
      state.phase = 'confirm';
      return { newState: state, narration: "ok. i'll scaffold the spec with the built-in starter recipe. you can edit recipes[0].source before compile, or add seeds.jsonl later.\n\n" + chatFunnelPromptFor(state), finished: false };
    }
    return { newState: state, narration: "i didn't catch that. paste JSONL (line starts with '{'), give a path ending in .jsonl, or type 'no'.", finished: false };
  }

  // PHASE 3 -> 4: confirm + dispatch scaffold
  if (state.phase === 'confirm') {
    if (lower === '' || /^(y|yes|yeah|yep|sure|ok|okay|go|proceed|do it|ship it)$/.test(lower)) {
      // proceed
    } else if (/^(n|no|nope|cancel|stop)$/.test(lower)) {
      state.phase = 'done';
      return { newState: state, narration: 'cancelled. nothing was built.', finished: true };
    } else {
      const candidate = slugify(trimmed);
      if (candidate && candidate.length >= 3 && candidate.length <= 40 && candidate !== 'artifact') {
        state.artifact_name = candidate;
        return { newState: state, narration: "renamed to " + color('1', state.artifact_name + '.kolm') + ".\n\n" + chatFunnelPromptFor(state), finished: false };
      }
      return { newState: state, narration: "i couldn't read that as y/n or a valid name. try 'y' to proceed, 'n' to cancel, or a short slug.", finished: false };
    }
    state.phase = 'compile';
    const newPlan = {
      action: 'new',
      argv: [state.artifact_name, '--from', state.template, '--yes'],
      label: 'kolm new ' + state.artifact_name + ' --from ' + state.template,
      expensive: false,
    };
    return { newState: state, narration: 'scaffolding...', action: newPlan, postAction: 'compile', finished: false };
  }

  // PHASE 4: after scaffold ran, decide compile path
  if (state.phase === 'compile') {
    if (airgap) {
      state.phase = 'done';
      const lines = [
        'scaffold ready: ' + color('1', state.artifact_name + '.spec.json'),
        'airgap mode is on, so i did not fire a cloud compile.',
        '',
        'ship checklist:',
        '  edit:    open ' + state.artifact_name + '.spec.json and tweak recipes[0].source',
        '  build:   kolm compile --spec ' + state.artifact_name + '.spec.json' + (state.examples_path ? ' --examples ' + state.examples_path : ''),
        '  run:     kolm run ' + state.artifact_name + '.kolm \'{"text":"<input>"}\'',
        '  verify:  kolm verify ' + state.artifact_name + '.kolm',
      ];
      if (state.examples_source === 'bootstrap') {
        lines.push('  note:    ' + color('2', 'examples are public-domain starter rows. add your own real rows for honest K-score.'));
      }
      return { newState: state, narration: lines.join('\n'), finished: true };
    }
    if (!state.examples_path) {
      state.phase = 'done';
      const lines = [
        'scaffold ready: ' + color('1', state.artifact_name + '.spec.json'),
        '',
        'next: edit recipes[0].source, then compile locally (no cloud needed):',
        '  kolm compile --spec ' + state.artifact_name + '.spec.json',
        '',
        'or add some examples first:',
        '  kolm seeds bootstrap --task phi-redactor   # public-domain starter',
        '  kolm seeds new ' + state.template + '                  # 5-row scaffold to edit',
      ];
      return { newState: state, narration: lines.join('\n'), finished: true };
    }
    const compilePlan = {
      action: 'compile_cloud',
      argv: [state.task, '--examples', state.examples_path],
      label: 'kolm compile "' + state.task + '" --examples ' + state.examples_path,
      expensive: true,
    };
    state.phase = 'verify';
    return { newState: state, narration: 'kicking off compile with your examples. this hits the cloud...', action: compilePlan, postAction: 'verify_prompt', finished: false };
  }

  // PHASE 5: verify gate (y/n)
  if (state.phase === 'verify') {
    if (/^(y|yes|yeah|sure|ok|okay|go|proceed)$/.test(lower) || lower === '') {
      const candidate = chatBuildFunnelFindArtifact(state.artifact_name);
      if (!candidate) {
        state.phase = 'run';
        return { newState: state, narration: "i can't find the compiled .kolm in ~/.kolm/artifacts/ or cwd. skipping verify.\n\n" + chatFunnelPromptFor(state), finished: false };
      }
      const verifyPlan = {
        action: 'verify',
        argv: [candidate],
        label: 'kolm verify ' + candidate,
        expensive: false,
      };
      state.phase = 'run';
      return { newState: state, narration: 'verifying...', action: verifyPlan, postAction: 'run_prompt', finished: false };
    }
    if (/^(n|no|nope|skip)$/.test(lower)) {
      state.phase = 'run';
      return { newState: state, narration: 'skipping verify.\n\n' + chatFunnelPromptFor(state), finished: false };
    }
    return { newState: state, narration: "y / n? (or 'exit' to bail)", finished: false };
  }

  // PHASE 6: run gate
  if (state.phase === 'run') {
    if (/^(n|no|nope|skip)$/.test(lower)) {
      state.phase = 'done';
      return chatFunnelDoneSummary(state);
    }
    if (/^(y|yes|yeah|sure|ok|okay|go|proceed)$/.test(lower) || lower === '') {
      return { newState: state, narration: "paste an input string (just the text), or type 'skip' to finish.", finished: false };
    }
    const candidate = chatBuildFunnelFindArtifact(state.artifact_name);
    if (!candidate) {
      state.phase = 'done';
      const done = chatFunnelDoneSummary(state);
      done.narration = "i can't find a compiled .kolm to run. " + done.narration;
      return done;
    }
    const runArgv = [candidate, JSON.stringify({ text: trimmed })];
    const runPlan = {
      action: 'run',
      argv: runArgv,
      label: 'kolm run ' + candidate + ' \'' + JSON.stringify({ text: trimmed }) + '\'',
      expensive: false,
    };
    state.phase = 'done';
    return { newState: state, narration: 'running...', action: runPlan, postAction: 'summary', finished: true };
  }

  state.phase = 'done';
  return chatFunnelDoneSummary(state);
}

function chatFunnelDoneSummary(state) {
  const lines = [
    'shipped ' + color('1', state.artifact_name + '.kolm') + '. checklist:',
    '  run:     kolm run ' + state.artifact_name + '.kolm \'{"text":"<input>"}\'',
    '  more:    edit seeds.jsonl, then kolm compile "' + state.task + '" --examples seeds.jsonl',
    '  share:   kolm push   ' + color('2', '(auth required)'),
  ];
  return { newState: state, narration: lines.join('\n'), finished: true };
}

// Derive a clean artifact slug from the user's task description.
function chatBuildFunnelDeriveName(taskDesc, template) {
  const lower = chatLc(taskDesc);
  const m1 = lower.match(/\b(phi|pii|ssn|email|phone|address)\b/);
  if (template === 'redactor' && m1) return m1[1].toLowerCase() + '-redactor';
  const m2 = lower.match(/\b(ticket|email|message|invoice|receipt|review|post|doctor|note|customer|order)s?\b/);
  if (m2) {
    const noun = m2[1].toLowerCase();
    if (template === 'classifier') return noun + '-classifier';
    if (template === 'extractor')  return noun + '-extractor';
    if (template === 'redactor')   return noun + '-redactor';
    if (template === 'summarizer') return noun + '-summarizer';
  }
  return chatInferArtifactName(taskDesc, template);
}

// Parse pasted JSONL. Tolerates code-fence wrappers and blank lines.
function chatBuildFunnelParseJsonl(text) {
  const cleaned = String(text || '')
    .replace(/^```(?:jsonl|json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const lines = cleaned.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!lines.length) return { ok: false, error: 'no lines found' };
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const r = JSON.parse(lines[i]);
      if (r && typeof r === 'object') rows.push(r);
    } catch (e) {
      return { ok: false, error: 'line ' + (i + 1) + ': ' + (e && e.message || 'parse error') };
    }
  }
  if (!rows.length) return { ok: false, error: 'no valid rows' };
  return { ok: true, rows: rows };
}

// Persist pasted rows to ./seeds.jsonl in cwd (auto-bumps if file exists).
function chatBuildFunnelWriteSeeds(rows, _artifactName) {
  let outPath = path.resolve(process.cwd(), 'seeds.jsonl');
  if (fs.existsSync(outPath)) {
    for (let i = 2; i <= 10; i++) {
      const candidate = path.resolve(process.cwd(), 'seeds-' + i + '.jsonl');
      if (!fs.existsSync(candidate)) { outPath = candidate; break; }
    }
  }
  const body = rows.map(function (r) { return JSON.stringify(Object.assign({}, r, { source: 'user' })); }).join('\n') + '\n';
  fs.writeFileSync(outPath, body);
  return path.relative(process.cwd(), outPath) || outPath;
}

// Find the most recent compiled artifact matching the name slug.
function chatBuildFunnelFindArtifact(artifactName) {
  try {
    const cwd = process.cwd();
    const direct = path.join(cwd, artifactName + '.kolm');
    if (fs.existsSync(direct)) return direct;
    let entries = [];
    try { entries = fs.readdirSync(cwd).filter(function (f) { return f.endsWith('.kolm') && f.indexOf(artifactName) >= 0; }); } catch (_e) {}
    if (entries.length) {
      entries.sort(function (a, b) {
        return fs.statSync(path.join(cwd, b)).mtimeMs - fs.statSync(path.join(cwd, a)).mtimeMs;
      });
      return path.join(cwd, entries[0]);
    }
    if (fs.existsSync(ARTIFACTS_DIR)) {
      let cand = fs.readdirSync(ARTIFACTS_DIR).filter(function (f) { return f.endsWith('.kolm'); });
      if (cand.length) {
        cand.sort(function (a, b) {
          return fs.statSync(path.join(ARTIFACTS_DIR, b)).mtimeMs - fs.statSync(path.join(ARTIFACTS_DIR, a)).mtimeMs;
        });
        return path.join(ARTIFACTS_DIR, cand[0]);
      }
    }
  } catch (_e) { /* ignore */ }
  return null;
}

// Detect funnel-start prompts that already contain BOTH the trigger and a
// task body in one line ("i wanna build a redactor for phi notes").
function chatBuildFunnelExtractEmbeddedTask(prompt) {
  const trimmed = chatTrim(prompt);
  if (!trimmed) return null;
  let task = trimmed
    .replace(/^(please\s+)?(i\s+(wanna|want\s+to|wish\s+to|would\s+like\s+to)\s+)?(build|make|create|train|compile|ship)\s+/i, '')
    .replace(/^(me\s+)?(a|an)\s+/i, '')
    .replace(/^(model|ai|recipe|artifact|kolm)\s+(to|that|which|for)\s+/i, '')
    .trim();
  if (!task) return null;
  if (/^(model|ai|recipe|artifact|redactor|summari[sz]er|classifier|extractor)$/i.test(task)) return null;
  if (task.length < 6) return null;
  task = task.replace(/\s*[,\.;]\s*(i\s+have|we\s+have)\s+(a\s+few\s+|some\s+)?examples?.*$/i, '').trim();
  return task && task.length >= 4 ? task : null;
}

async function cmdChat(args) {
  args = args || [];
  if (args.indexOf('--help') >= 0 || args.indexOf('-h') >= 0) {
    console.log(HELP.chat);
    process.exit(EXIT.OK);
  }

  let onceMode = false;
  let oncePrompt = null;
  let jsonMode = false;
  let airgapMode = process.env.KOLM_AIRGAP === '1';
  let autoYes = process.env.KOLM_CHAT_AUTO === '1';
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--once') { onceMode = true; oncePrompt = args[i + 1] != null ? args[i + 1] : ''; i += 2; continue; }
    if (a === '--json') { jsonMode = true; i++; continue; }
    if (a === '--airgap' || a === '--offline') { airgapMode = true; i++; continue; }
    if (a === '--online') { airgapMode = false; i++; continue; }
    if (a === '--yes' || a === '-y') { autoYes = true; i++; continue; }
    i++;
  }
  // Non-interactive (no TTY) shells cannot answer a [Y/n] prompt, and the
  // --once path is explicitly one-shot. Auto-yes in both so chat does not
  // hang forever waiting on stdin.
  const effectiveAutoYes = autoYes || onceMode || !process.stdin.isTTY;

  // build-a-model funnel state. null = funnel inactive. When set, onLine
  // routes the next line into chatFunnelStep() rather than the normal
  // intent dispatcher. Persists across turns within this chat session.
  let buildFunnelState = null;

  const c = loadConfig();

  // Local-only action short-circuit. The server's /v1/assistant fires a real
  // compile job for ANY "make/build/create" prompt, which would double-execute
  // when chat ALSO scaffolds locally via cmdNew. For local-only actions
  // (new / seeds generate / upgrade / doctor) we skip the cloud roundtrip
  // entirely and run the local plan with offline narration. compile_cloud
  // still goes through sendChat -> cloud because the work happens server-side.
  function localShortCircuitPlan(promptText) {
    if (airgapMode) return null;
    const localReply = localAssistantParse(promptText);
    const plan = chatPlanAction(promptText, localReply);
    if (!plan) return null;
    // For compile_cloud we usually want the cloud roundtrip (it does the
    // actual work). EXCEPTION: if the user referenced an examples file in
    // the prompt and chatPlanAction wired it as --examples, going through
    // /v1/assistant would fire a cloud compile WITHOUT the file (the cloud
    // never sees the local fs). Better to short-circuit and dispatch
    // locally so `kolm compile <task> --examples <file>` uploads the file
    // via the existing multipart compile flow.
    if (plan.action === 'compile_cloud') {
      if (plan.argv && plan.argv.indexOf('--examples') >= 0) {
        localReply._source = 'action';
        localReply.narration = "kicking off a cloud compile with your examples file.";
        localReply.next_steps = [];
        return { reply: localReply, plan: plan };
      }
      return null;
    }
    // We deliberately route this through the LOCAL parser to avoid double-
    // executing on the server. The narration is still accurate (these intents
    // are local-only by design) so we tag it as "action" rather than "airgap"
    // to avoid implying the network is unreachable.
    localReply._source = 'action';
    // Override the narration when the local parser's framing does not match
    // the action we are about to take. The default narration for "upgrade"
    // is plan-upgrade (billing); we are about to run the CLI self-update verb.
    if (plan.action === 'upgrade') {
      localReply.narration = "checking for a newer kolm CLI release. (this is the version-check verb, not a plan/billing change.)";
      delete localReply.data;
      localReply.next_steps = [{ label: 'apply', command: 'kolm update' }];
    } else if (plan.action === 'new') {
      localReply.narration = "scaffolding a starter spec.json for you to compile and edit.";
      localReply.next_steps = [];
    } else if (plan.action === 'seeds_generate') {
      localReply.narration = "expanding your seed file via rule-based mutation. nothing leaves the box.";
      localReply.next_steps = [];
    }
    return { reply: localReply, plan: plan };
  }

  // Decide-then-act helper used by both the --once and interactive paths.
  // Returns true if an action was dispatched (caller can short-circuit the
  // narration), false if the intent should fall through to renderChatReply.
  async function maybeAct(reply, promptText) {
    if (airgapMode) return false; // narration-only in airgap mode
    const plan = chatPlanAction(promptText, reply);
    if (!plan) return false;
    // If the cloud already kicked off a compile job in its /v1/assistant
    // response (reply.data.job_id present), do NOT also dispatch a local
    // `kolm compile`. The cloud roundtrip IS the compile — re-firing it
    // would create a duplicate job and burn the user's quota twice.
    if (plan.action === 'compile_cloud' && reply && reply.data && reply.data.job_id) {
      return false;
    }
    if (jsonMode) {
      // --json contract: stdout stays a single parseable document. Surface
      // the plan in the reply rather than executing.
      reply._planned_action = plan;
      return false;
    }
    if (plan.expensive && !effectiveAutoYes) {
      const ok = await chatConfirm(plan.label);
      if (!ok) {
        console.log(color('2', 'kolm > skipped. (no action taken)'));
        return true;
      }
    } else {
      // Auto-yes path (cheap action OR effectiveAutoYes). Print what we are
      // about to run so the user is never surprised, but skip the [Y/n] gate.
      console.log(color('36', 'kolm') + ' ' + color('2', '>') + ' about to run: ' + color('1', plan.label));
    }
    const r = await chatRunAction(plan);
    if (r.ok) chatPrintNextSteps(plan);
    return true;
  }

  // Print the kolm reply bubble (same shape renderChatReply uses for the
  // narration line) for funnel-driven replies. Indented continuation lines
  // line up under the bubble head.
  function printFunnelReply(narration) {
    const head = color('36', 'kolm') + ' ' + color('2', '>') + ' ';
    const lines = String(narration || '').split('\n');
    console.log(head + lines[0]);
    for (let i = 1; i < lines.length; i++) {
      console.log('       ' + lines[i]);
    }
  }

  // Drive one turn of the build-a-model funnel. Returns:
  //   { handled: true, finished, asked }
  //   - handled: always true if buildFunnelState was non-null on entry
  //   - finished: true when the funnel reached 'done' (state should be cleared)
  //   - asked: true if the funnel printed a new prompt and is waiting on input
  // Caller is responsible for re-arming the readline prompt.
  async function runFunnelTurn(input) {
    if (!buildFunnelState) return { handled: false };
    const result = await chatFunnelStep(buildFunnelState, input, { airgap: airgapMode, autoYes: effectiveAutoYes });
    if (result.narration) printFunnelReply(result.narration);
    // Dispatch any queued action (scaffold/compile/verify/run). Cheap actions
    // print "about to run:" and dispatch immediately; expensive actions
    // honor autoYes (which is true in --once / non-TTY contexts).
    if (result.action) {
      const plan = result.action;
      let go = true;
      if (plan.expensive && !effectiveAutoYes) {
        go = await chatConfirm(plan.label);
      } else {
        console.log(color('36', 'kolm') + ' ' + color('2', '>') + ' about to run: ' + color('1', plan.label));
      }
      if (go) {
        const r = await chatRunAction(plan);
        // If the dispatched action was the scaffold step, re-enter the
        // funnel one more time so it can decide whether to compile (or print
        // the airgap checklist). chatFunnelStep advanced phase to 'compile'
        // already; pass an empty line to re-drive.
        if (r.ok && result.postAction === 'compile') {
          const cont = await chatFunnelStep(buildFunnelState, '', { airgap: airgapMode, autoYes: effectiveAutoYes });
          if (cont.narration) printFunnelReply(cont.narration);
          if (cont.action) {
            const plan2 = cont.action;
            let go2 = true;
            if (plan2.expensive && !effectiveAutoYes) go2 = await chatConfirm(plan2.label);
            else console.log(color('36', 'kolm') + ' ' + color('2', '>') + ' about to run: ' + color('1', plan2.label));
            if (go2) await chatRunAction(plan2);
          }
          if (cont.finished) {
            buildFunnelState = null;
            return { handled: true, finished: true, asked: false };
          }
        }
      } else {
        console.log(color('2', 'kolm > skipped. (no action taken)'));
      }
    }
    if (result.finished) {
      buildFunnelState = null;
      return { handled: true, finished: true, asked: false };
    }
    return { handled: true, finished: false, asked: true };
  }

  if (onceMode) {
    let promptText = String(oncePrompt == null ? '' : oncePrompt).replace(/^["']|["']$/g, '');
    if (promptText === '-' || promptText === '') {
      promptText = readStdinSync();
    }
    // --once mode is single-shot: cannot ask follow-ups. If the prompt looks
    // like a build-a-model funnel trigger, fall through to single-shot
    // scaffold but print a hint suggesting interactive mode. The hint is
    // suppressed in --json so the JSON contract stays a single parseable
    // document.
    const funnelHinted = !jsonMode && chatBuildFunnelTrigger(promptText);
    // Local-only actions take the short-circuit path: no cloud roundtrip.
    // We apply this in BOTH normal and --json mode because the cloud's
    // /v1/assistant fires a real compile job for any "make/build/create"
    // prompt, which would dispatch a side-effect even when the local plan
    // is `new` (scaffold) and we are merely reporting a plan via --json.
    const sc = localShortCircuitPlan(promptText);
    if (sc) {
      if (jsonMode) {
        // --json contract: emit one parseable doc and exit. Use the local
        // reply (which already reflects the scaffold/seeds intent) and tag
        // the planned action so the caller can dispatch (or inspect) it.
        sc.reply._planned_action = sc.plan;
        console.log(JSON.stringify(sc.reply));
        process.exitCode = sc.reply && sc.reply.ok === false ? EXIT.EXECUTION : EXIT.OK;
        return;
      }
      renderChatReply(sc.reply);
      const plan = sc.plan;
      if (plan.expensive && !effectiveAutoYes) {
        const ok = await chatConfirm(plan.label);
        if (!ok) {
          console.log(color('2', 'kolm > skipped. (no action taken)'));
          process.exitCode = EXIT.OK;
          return;
        }
      } else {
        // Auto-yes path. Print what we are about to run so the user always
        // sees the resolved command before output starts.
        console.log(color('36', 'kolm') + ' ' + color('2', '>') + ' about to run: ' + color('1', plan.label));
      }
      const r = await chatRunAction(plan);
      if (r.ok) chatPrintNextSteps(plan);
      if (funnelHinted) {
        console.log('');
        console.log(color('2', 'tip: drop --once to enter the build funnel interactively (`kolm chat`).'));
      }
      // Set exit code and return rather than process.exit() so lingering
      // handles (open fetch sockets from cmdDoctor's cloud reachability check,
      // etc.) drain cleanly. process.exit() while a UV handle is closing
      // trips a libuv assertion on Windows.
      process.exitCode = r.ok ? EXIT.OK : (r.exitCode || EXIT.EXECUTION);
      return;
    }
    const reply = await sendChat(c, promptText, { airgap: airgapMode });
    if (jsonMode) {
      // Annotate the JSON reply with the planned action (if any) so callers
      // can decide what to dispatch. We do not execute in --json mode.
      const plan = airgapMode ? null : chatPlanAction(promptText, reply);
      if (plan) reply._planned_action = plan;
      console.log(JSON.stringify(reply));
      process.exitCode = reply && reply.ok === false ? EXIT.EXECUTION : EXIT.OK;
      return;
    }
    renderChatReply(reply);
    const acted = await maybeAct(reply, promptText);
    if (funnelHinted) {
      console.log('');
      console.log(color('2', 'tip: drop --once to enter the build funnel interactively (`kolm chat`).'));
    }
    // If we dispatched, exit on the action result; otherwise on reply.ok.
    if (!acted) {
      process.exitCode = reply && reply.ok === false ? EXIT.EXECUTION : EXIT.OK;
      return;
    }
    process.exitCode = EXIT.OK;
    return;
  }

  // readline is imported at the top of the file. For piped stdin (non-TTY)
  // we set terminal: false so readline emits 'line' events as they arrive
  // from the pipe; for an actual TTY we set terminal: true for interactive
  // prompt rendering.
  const rlTerminal = !!process.stdin.isTTY;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: rlTerminal });

  console.log(color('2', 'kolm chat') + ' . interactive assistant (action mode)');
  console.log(color('2', "type a prompt, " + color('1', '/help') + ' for commands, ' + color('1', '/exit') + ' or Ctrl+C to quit'));
  if (airgapMode) console.log(color('2', 'mode: ' + color('1', 'airgapped') + ' . narration only, no shell-out'));
  if (autoYes) console.log(color('2', 'mode: ' + color('1', 'auto-confirm') + ' . will run actions without prompting'));
  if (!c.api_key && !airgapMode) console.log(color('33', 'no api key. replies will use the offline rule-based parser. run: kolm login'));
  console.log('');

  // Line-event + queue architecture. Reading via rl.question(callback) breaks
  // when the callback is async on piped stdin: readline emits 'close' on EOF
  // before the next question() is wired up, so subsequent lines drop. The
  // queue serializes async processing while readline freely buffers input.
  const lineQueue = [];
  let processing = false;
  let rlClosed = false;
  let writingPrompt = false;

  function writeYouPrompt() {
    if (rlTerminal && !writingPrompt) {
      writingPrompt = true;
      process.stdout.write(color('32', 'you ') + color('2', '> '));
      writingPrompt = false;
    }
  }

  async function drainQueue() {
    if (processing) return;
    processing = true;
    try {
      while (lineQueue.length > 0) {
        const line = lineQueue.shift();
        await onLine(line);
      }
    } finally {
      processing = false;
    }
    if (rlClosed) {
      process.stdout.write('\n' + color('2', 'bye') + '\n');
      process.exit(EXIT.OK);
    } else {
      writeYouPrompt();
    }
  }

  const promptOnce = function () {
    // No-op in the queue architecture: prompts are written by writeYouPrompt()
    // before each read. Kept as a named function so existing call sites stay
    // readable.
    writeYouPrompt();
  };

  const onLine = async function (line) {
    const input = chatTrim(line);
    if (!input) return;

    if (input === '/exit' || input === '/quit') { rl.close(); return; }
    if (input === '/help') { printChatHelp(); return; }
    if (input === '/clear') { process.stdout.write('\x1b[2J\x1b[H'); return; }
    if (input === '/airgap') {
      airgapMode = !airgapMode;
      console.log(color('2', 'airgap mode: ' + (airgapMode ? 'on' : 'off')));
      return;
    }
    if (input === '/online') {
      airgapMode = false;
      console.log(color('2', 'airgap mode: off'));
      return;
    }
    if (input === '/yes') {
      autoYes = !autoYes;
      console.log(color('2', 'auto-confirm: ' + (autoYes ? 'on' : 'off')));
      return;
    }

    // Funnel mid-flight: route this line into the build-a-model state machine
    // rather than the single-shot intent dispatcher.
    if (buildFunnelState) {
      try {
        await runFunnelTurn(input);
      } catch (e) {
        console.log(color('31', 'error: ') + (e && e.message || e));
        buildFunnelState = null;
      }
      console.log('');
      return;
    }

    // Funnel start: NL phrases like "i wanna build a model" / "build me an ai"
    // open the multi-turn build flow. If the same line also includes a task
    // body, jump straight to the examples step.
    if (chatBuildFunnelTrigger(input)) {
      buildFunnelState = chatCreateBuildFunnel();
      const embeddedTask = chatBuildFunnelExtractEmbeddedTask(input);
      if (embeddedTask && embeddedTask.length >= 4) {
        try {
          await runFunnelTurn(embeddedTask);
        } catch (e) {
          console.log(color('31', 'error: ') + (e && e.message || e));
          buildFunnelState = null;
        }
      } else {
        printFunnelReply(chatFunnelPromptFor(buildFunnelState));
      }
      console.log('');
      return;
    }

    try {
      // Local-only actions short-circuit the cloud roundtrip so the server's
      // /v1/assistant does not double-execute (it fires a real compile job for
      // "make/build/create" prompts).
      const sc = localShortCircuitPlan(input);
      const reply = sc ? sc.reply : await sendChat(c, input, { airgap: airgapMode });
      renderChatReply(reply);
      // Action-mode: if the intent maps to a concrete kolm verb, prompt and
      // run it. Airgap mode stays narration-only.
      if (!airgapMode) {
        const plan = sc ? sc.plan : chatPlanAction(input, reply);
        // Cloud already executed the compile (reply.data.job_id is set);
        // skip the local dispatch to avoid burning a second compile.
        const cloudAlreadyCompiled = plan && plan.action === 'compile_cloud' &&
          reply && reply.data && reply.data.job_id;
        if (plan && !cloudAlreadyCompiled) {
          let go = true;
          if (plan.expensive && !autoYes) {
            go = await chatConfirm(plan.label);
          } else {
            console.log(color('36', 'kolm') + ' ' + color('2', '>') + ' about to run: ' + color('1', plan.label));
          }
          if (go) {
            const r = await chatRunAction(plan);
            if (r.ok) chatPrintNextSteps(plan);
          } else {
            console.log(color('2', 'kolm > skipped. (no action taken)'));
          }
        }
      }
    } catch (e) {
      console.log(color('31', 'error: ') + (e && e.message || e));
    }
    console.log('');
  };

  rl.on('line', function (line) {
    lineQueue.push(line);
    drainQueue();
  });
  rl.on('close', function () {
    rlClosed = true;
    // Trigger the drainer one more time so any pending lines finish before
    // we print "bye" and exit.
    drainQueue();
  });
  // Initial prompt for TTY users (queue path handles subsequent prompts).
  writeYouPrompt();
}

// ---------- kolm team ----------
// Multi-tenant team management against /v1/teams/*.
function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(args, name) {
  return args.includes(name);
}

// Reject unknown --flag-style args for a given subcommand. Cheap typo-guard
// that uves/gh/wrangler all do. Prefix-match suggester finds the closest known
// flag (first 4 chars, then middle 3) and prints "did you mean …?". Wire into
// new commands as we go — proven first in cmdCompute. Stripped --name=value
// down to --name before matching, so `--budget=10` still validates against the
// `--budget` allowlist.
// Levenshtein edit distance for command-name typo recovery. Pure JS, no deps.
// O(m*n) DP with a rolling single-row buffer (O(min(m,n)) memory). Used in the
// top-level dispatch default branch to surface "did you mean …?" for unknown
// verbs like `kolm complie` → `kolm compile`.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, prevDiag + cost);
      prevDiag = tmp;
    }
  }
  return prev[b.length];
}

// Pick the single closest known verb for a mistyped command, but only when the
// typo is genuinely close (≤ 2 edits, or ≤ 1/3 the verb length). Returns null
// when nothing is close enough — we'd rather fall through to natural-language
// `ask` than confidently misdirect the user.
function suggestVerb(cmd, verbs) {
  if (!cmd || typeof cmd !== 'string') return null;
  const lower = cmd.toLowerCase();
  let best = null;
  let bestDist = Infinity;
  for (const v of verbs) {
    const d = levenshtein(lower, v);
    if (d < bestDist) { bestDist = d; best = v; }
  }
  if (best == null) return null;
  const threshold = Math.max(2, Math.floor(best.length / 3));
  return bestDist <= threshold ? best : null;
}

function rejectUnknownFlags(args, allowed, ctx) {
  const passed = args.filter(a => a.startsWith('--')).map(a => a.split('=')[0]);
  const unknown = passed.filter(p => !allowed.includes(p));
  if (unknown.length === 0) return;
  const suggestions = unknown.map(u => {
    const best = allowed.find(a => a.startsWith(u.slice(0, 4))) || allowed.find(a => a.includes(u.slice(2, 5)));
    return best ? `${u} → did you mean ${best}?` : u;
  });
  const err = new Error(`unknown flag(s) for kolm ${ctx}: ${suggestions.join(', ')}\nallowed: ${allowed.join(' ')}`);
  err.exitCode = EXIT.BAD_ARGS;
  throw err;
}

async function cmdTeam(args) {
  const sub = args[0];
  const rest = args.slice(1);
  const c = loadConfig();
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    usage('team');
    return;
  }
  if (sub === 'create') {
    const name = rest[0];
    if (!name) { console.error('error: team name required'); process.exit(1); }
    const seats = parseInt(flag(rest, '--seats')) || undefined;
    const r = await api(c, 'POST', '/v1/teams', { name, seats_max: seats });
    console.log(JSON.stringify(r.team, null, 2));
    console.log(`\nshare:  kolm team invite ${r.team.slug} <email>`);
    return;
  }
  if (sub === 'list' || sub === 'ls') {
    const r = await api(c, 'GET', '/v1/teams');
    if (!r.teams || !r.teams.length) { console.log('(no teams; create one with `kolm team create <name>`)'); return; }
    for (const t of r.teams) {
      console.log(`${t.slug.padEnd(24)} ${(t.your_role || '').padEnd(8)} seats=${t.seats_used}/${t.seats_max}  ${t.name}`);
    }
    return;
  }
  if (sub === 'show') {
    const slug = rest[0];
    if (!slug) { console.error('error: slug required'); process.exit(1); }
    const r = await api(c, 'GET', '/v1/teams/' + encodeURIComponent(slug));
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (sub === 'invite') {
    const slug = rest[0];
    const email = rest[1];
    const role = flag(rest, '--role') || 'member';
    if (!slug || !email) { console.error('error: slug + email required'); process.exit(1); }
    const r = await api(c, 'POST', `/v1/teams/${encodeURIComponent(slug)}/invite`, { email, role });
    console.log(`invited ${email} as ${r.role}`);
    console.log(`send this link:  ${r.accept_url}`);
    console.log(`or token:        ${r.token}`);
    console.log(`expires:         ${r.expires_at}`);
    return;
  }
  if (sub === 'accept') {
    const token = rest[0];
    if (!token) { console.error('error: invite token required'); process.exit(1); }
    const r = await api(c, 'POST', `/v1/teams/invites/${encodeURIComponent(token)}/accept`, {});
    console.log(`joined ${r.team?.slug || '(unknown)'} as ${r.role}`);
    return;
  }
  if (sub === 'members') {
    const slug = rest[0];
    if (!slug) { console.error('error: slug required'); process.exit(1); }
    const r = await api(c, 'GET', '/v1/teams/' + encodeURIComponent(slug));
    for (const m of r.members || []) {
      console.log(`${(m.tenant_id || '').padEnd(28)} ${(m.role || '').padEnd(8)} joined ${m.joined_at || ''}`);
    }
    return;
  }
  if (sub === 'role') {
    const [slug, tenantId, newRole] = rest;
    if (!slug || !tenantId || !newRole) { console.error('error: slug + tenant_id + role required'); process.exit(1); }
    await api(c, 'PATCH', `/v1/teams/${encodeURIComponent(slug)}/members/${encodeURIComponent(tenantId)}`, { role: newRole });
    console.log(`role updated: ${tenantId} -> ${newRole}`);
    return;
  }
  if (sub === 'remove') {
    const [slug, tenantId] = rest;
    if (!slug || !tenantId) { console.error('error: slug + tenant_id required'); process.exit(1); }
    await api(c, 'DELETE', `/v1/teams/${encodeURIComponent(slug)}/members/${encodeURIComponent(tenantId)}`);
    console.log(`removed: ${tenantId}`);
    return;
  }
  if (sub === 'transfer') {
    const [slug, newOwner] = rest;
    if (!slug || !newOwner) { console.error('error: slug + new_owner_tenant_id required'); process.exit(1); }
    await api(c, 'POST', `/v1/teams/${encodeURIComponent(slug)}/transfer`, { new_owner_tenant_id: newOwner });
    console.log(`ownership transferred to ${newOwner}`);
    return;
  }
  if (sub === 'delete') {
    const slug = rest[0];
    if (!slug) { console.error('error: slug required'); process.exit(1); }
    await api(c, 'DELETE', '/v1/teams/' + encodeURIComponent(slug));
    console.log(`deleted: ${slug}`);
    return;
  }
  console.error('unknown team subcommand:', sub);
  process.exit(1);
}

// ---------- kolm tunnel ----------
// Remote-access tunnel: kolm.ai brokers requests, the local agent serves them
// from a .kolm artifact. The model and data stay on this machine.
async function cmdTunnel(args) {
  const sub = args[0];
  const rest = args.slice(1);
  const c = loadConfig();
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    usage('tunnel');
    return;
  }
  if (sub === 'new' || sub === 'create' || sub === 'register') {
    const body = {};
    const name = flag(rest, '--name');
    const team = flag(rest, '--team');
    if (name) body.name = name;
    if (team) body.team_id = team;
    const r = await api(c, 'POST', '/v1/tunnel/register', body);
    console.log(`token:       ${r.token}`);
    console.log(`public URL:  ${r.public_url}`);
    console.log(`expires:     ${r.expires_at}`);
    console.log(``);
    console.log(`start agent: kolm tunnel start --token ${r.token} --artifact <path-or-name>`);
    return;
  }
  if (sub === 'list' || sub === 'ls') {
    const r = await api(c, 'GET', '/v1/tunnels');
    if (!r.tunnels || !r.tunnels.length) { console.log('(no tunnels)'); return; }
    for (const t of r.tunnels) {
      console.log(`${t.token.padEnd(36)} ${t.status.padEnd(8)} ${t.live ? 'LIVE ' : 'idle '} ${t.name || ''}`);
      console.log(`  ${t.public_url}`);
    }
    return;
  }
  if (sub === 'close' || sub === 'stop' || sub === 'rm') {
    const token = rest[0];
    if (!token) { console.error('error: token required'); process.exit(1); }
    await api(c, 'DELETE', '/v1/tunnels/' + encodeURIComponent(token));
    console.log('closed');
    return;
  }
  if (sub === 'start' || sub === 'agent') {
    return cmdTunnelAgent(c, rest);
  }
  console.error('unknown tunnel subcommand:', sub);
  process.exit(1);
}

async function cmdTunnelAgent(c, args) {
  const token = flag(args, '--token') || process.env.KOLM_TUNNEL_TOKEN;
  const artifactArg = flag(args, '--artifact');
  if (!token) { console.error('error: --token required (or set KOLM_TUNNEL_TOKEN)'); process.exit(1); }
  if (!artifactArg) {
    const err = new Error('--artifact required');
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const ap = resolveArtifact(artifactArg);
  if (!ap) {
    const err = new Error(`artifact not found: ${artifactArg}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  const url = c.base.replace(/\/+$/, '') + '/v1/tunnel/agent/' + encodeURIComponent(token);
  const stopOnSig = () => { console.log('\nagent: shutting down'); process.exit(0); };
  process.on('SIGINT', stopOnSig);
  process.on('SIGTERM', stopOnSig);

  let attempt = 0;
  while (true) {
    attempt++;
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'text/event-stream', ...authHeaders(c) } });
    } catch (e) {
      console.error(`agent: connect failed (${e.message}); retry in ${Math.min(30, attempt * 2)}s`);
      await new Promise(r => setTimeout(r, Math.min(30, attempt * 2) * 1000));
      continue;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`agent: attach ${res.status}: ${txt}`);
      if (res.status === 404 || res.status === 410) process.exit(1);
      await new Promise(r => setTimeout(r, Math.min(30, attempt * 2) * 1000));
      continue;
    }
    attempt = 0;
    console.log(`agent: connected (token ${token.slice(0, 12)}...); serving ${path.basename(ap)}`);
    console.log(`public URL: ${c.base.replace(/\/+$/, '')}/r/${token}`);

    let buf = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!frame || frame.startsWith(':')) continue;
          const ev = (frame.match(/^event:\s*(.+)$/m) || [])[1];
          const dataLine = (frame.match(/^data:\s*([\s\S]+)$/m) || [])[1];
          if (!ev || !dataLine) continue;
          if (ev === 'hello') {
            try { console.log('agent: hello', JSON.parse(dataLine).tunnel_id || ''); } catch {}
            continue;
          }
          if (ev === 'request') {
            let req; try { req = JSON.parse(dataLine); } catch { continue; }
            handleTunnelRequest(c, token, req, ap).catch(err => {
              console.error('agent: request', req.request_id, 'failed:', err.message);
            });
          }
        }
      }
    } catch (e) {
      console.error('agent: stream ended:', e.message);
    }
    console.log('agent: reconnecting...');
    await new Promise(r => setTimeout(r, 1500));
  }
}

async function handleTunnelRequest(c, token, req, artifactPath) {
  const { request_id, method, path: rPath, body } = req;
  const t0 = Date.now();
  let input = null;
  if (body && body.length) {
    try { input = JSON.parse(body); } catch { input = body; }
    if (input && typeof input === 'object' && 'input' in input) input = input.input;
  }
  let response;
  try {
    const r = await withRunner(async ({ runArtifact }) => runArtifact(artifactPath, input));
    response = {
      request_id,
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        output: r.output,
        recipe: r.recipe_name || r.recipe_id,
        k_score: r.k_score?.composite,
        latency_us: r.latency_us,
        via: 'kolm-tunnel-agent',
      }),
    };
    console.log(`agent: ${method} ${rPath} -> 200 (${Date.now() - t0}ms)`);
  } catch (e) {
    response = {
      request_id,
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message, code: e.code || 'agent_error' }),
    };
    console.log(`agent: ${method} ${rPath} -> 500 (${Date.now() - t0}ms): ${e.message}`);
  }
  await api(c, 'POST', `/v1/tunnel/agent/${encodeURIComponent(token)}/response`, response);
}

// ---------- kolm cloud (BYOC) ----------
// Bring-your-own-cloud: deploy a .kolm artifact to your own Fly / AWS Nitro
// / GCP CVM / Azure CVM / Docker host. kolm.ai issues the signed deploy
// script and records the attestation. kolm.ai never runs the artifact.
async function cmdCloud(args) {
  const sub = args[0];
  const rest = args.slice(1);
  const c = loadConfig();
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    usage('cloud');
    return;
  }
  if (sub === 'targets') {
    const r = await api(c, 'GET', '/v1/byoc/targets');
    for (const t of r.targets || []) console.log(' - ' + t);
    return;
  }
  if (sub === 'deploy') {
    const target = flag(rest, '--target');
    const artifactId = flag(rest, '--artifact');
    if (!target || !artifactId) { console.error('error: --target and --artifact required'); process.exit(1); }
    const body = { target, artifact_id: artifactId };
    const region = flag(rest, '--region'); if (region) body.region = region;
    const name = flag(rest, '--name'); if (name) body.name = name;
    const team = flag(rest, '--team'); if (team) body.team_id = team;
    const r = await api(c, 'POST', '/v1/byoc/deploy', body);
    const out = flag(rest, '--out') || path.join(process.cwd(), `kolm-deploy-${r.deployment.id}.sh`);
    fs.writeFileSync(out, r.deploy_script, { mode: 0o700 });
    console.log(`deployment id:  ${r.deployment.id}`);
    console.log(`target:         ${r.deployment.target}`);
    console.log(`enroll_token:   ${r.deployment.enroll_token}`);
    console.log(`deploy script:  ${out}  (executable; review then run)`);
    console.log('');
    console.log('On your cloud host:');
    console.log(`  ./${path.basename(out)}`);
    console.log('');
    console.log('When the instance boots it will POST attestation to /v1/byoc/attestation;');
    console.log('check it with:  kolm cloud show ' + r.deployment.id);
    return;
  }
  if (sub === 'list' || sub === 'ls') {
    const r = await api(c, 'GET', '/v1/byoc/deployments');
    if (!r.deployments || !r.deployments.length) { console.log('(no deployments)'); return; }
    for (const d of r.deployments) {
      console.log(`${d.id.padEnd(20)} ${d.target.padEnd(10)} ${d.status.padEnd(10)} ${d.public_url || ''}`);
    }
    return;
  }
  if (sub === 'show') {
    const id_ = rest[0];
    if (!id_) { console.error('error: deployment_id required'); process.exit(1); }
    const r = await api(c, 'GET', '/v1/byoc/deployments/' + encodeURIComponent(id_));
    console.log(JSON.stringify(r.deployment, null, 2));
    return;
  }
  if (sub === 'destroy' || sub === 'rm' || sub === 'delete') {
    const id_ = rest[0];
    if (!id_) { console.error('error: deployment_id required'); process.exit(1); }
    await api(c, 'DELETE', '/v1/byoc/deployments/' + encodeURIComponent(id_));
    console.log('destroyed');
    return;
  }
  if (sub === 'train') {
    await cmdCloudTrain(rest);
    return;
  }
  console.error('unknown cloud subcommand:', sub);
  process.exit(1);
}

// ---------- kolm cloud train ----------
// Real GPU fine-tune on a rented backend (default: together). Reads a spec +
// seeds, quotes cost, optionally confirms and runs the job to completion, then
// packages the adapter into a .kolm artifact alongside the local spec.
//
// Honest about cost: prints a quote up-front, then the exact provider price
// once the fine-tune object is returned. No CPU fallback — refuse if no GPU
// backend is configured.
async function cmdCloudTrain(args) {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP['cloud train'] || HELP.cloud);
    return;
  }
  const name = args[0];
  if (!name || name.startsWith('--')) {
    console.error('error: name required. usage: kolm cloud train <name> [--seeds <f.jsonl>] [--base <model>] [--confirm]');
    process.exit(1);
  }
  const seedsFlag = pickFlag(args, '--seeds') || pickFlag(args, '--examples');
  const baseModel = pickFlag(args, '--base') || pickFlag(args, '--base-model') || 'Qwen/Qwen2.5-7B-Instruct';
  const targetSize = pickFlag(args, '--target-size') || '7b';
  const epochs = Number(pickFlag(args, '--epochs') || 3);
  const loraR = Number(pickFlag(args, '--lora-r') || 16);
  const loraAlpha = Number(pickFlag(args, '--lora-alpha') || 32);
  const backend = pickFlag(args, '--backend') || 'together';
  const budget = pickFlag(args, '--budget');
  const confirm = args.includes('--confirm');

  // Refuse CPU. The whole point of `cloud train` is "no stupid decisions like
  // training on a processor." If the user explicitly picks a local CPU backend,
  // bail loudly.
  if (backend.startsWith('local-cpu')) {
    console.error('error: cloud train will not run on CPU. pick a GPU backend (together, runpod, lambda) or use `kolm tune` for the local path.');
    process.exit(2);
  }

  // Resolve `name` into (specPath, seedsPath, id). Three accepted shapes:
  //   1. directory:        models/en-zh-translator/   → spec.json + seeds.jsonl inside
  //   2. spec file:        path/to/x.spec.json        → sibling seeds.jsonl
  //   3. bare slug:        my-redactor                → try ./my-redactor.spec.json then ./my-redactor/spec.json
  // The buyer's first arg is the recipe handle; we never re-slugify it into the id.
  // The spec's own `id` field is the canonical name on the artifact record.
  let specPath = null;
  let specDir = null;
  const argResolved = path.resolve(name);
  if (fs.existsSync(argResolved) && fs.statSync(argResolved).isDirectory()) {
    const candidate = path.join(argResolved, 'spec.json');
    if (fs.existsSync(candidate)) specPath = candidate;
    specDir = argResolved;
  } else if (name.endsWith('.spec.json') && fs.existsSync(argResolved)) {
    specPath = argResolved;
    specDir = path.dirname(argResolved);
  } else {
    const tryDotSpec = path.resolve(`${name}.spec.json`);
    const tryDirSpec = path.resolve(name, 'spec.json');
    if (fs.existsSync(tryDotSpec)) { specPath = tryDotSpec; specDir = path.dirname(tryDotSpec); }
    else if (fs.existsSync(tryDirSpec)) { specPath = tryDirSpec; specDir = path.dirname(tryDirSpec); }
  }

  // Seeds resolution: explicit flag > sibling of spec > cwd fallback.
  let seedsPath = seedsFlag
    ? path.resolve(seedsFlag)
    : specDir && fs.existsSync(path.join(specDir, 'seeds.jsonl'))
      ? path.join(specDir, 'seeds.jsonl')
      : path.resolve('./seeds.jsonl');

  if (!fs.existsSync(seedsPath)) {
    console.error(`error: seeds file not found: ${seedsPath}`);
    console.error('  scaffold one with: kolm seeds new <template>    (e.g. redactor, classifier, extractor)');
    console.error('  or pass --seeds <path.jsonl>');
    process.exit(1);
  }
  let pairCount = 0;
  try {
    const txt = fs.readFileSync(seedsPath, 'utf-8');
    pairCount = txt.split(/\r?\n/).filter((l) => l.trim()).length;
  } catch (e) {
    console.error(`error: cannot read seeds: ${e.message}`); process.exit(1);
  }
  if (pairCount < 10) {
    console.error(`error: need >=10 training pairs in ${seedsPath}, got ${pairCount}.`);
    console.error('  generate more with: kolm seeds generate --n 100');
    process.exit(1);
  }

  let spec = null;
  if (specPath) {
    try { spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')); }
    catch (e) { console.error(`error: cannot parse ${specPath}: ${e.message}`); process.exit(1); }
  }
  // Fallback id: basename of the dir or the name without extension; never the
  // slash-slugified full path.
  const fallbackId = (specDir ? path.basename(specDir) : name.replace(/\.spec\.json$/, ''))
    .replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  if (!spec) {
    spec = {
      id: fallbackId,
      name: fallbackId,
      target_size: targetSize,
      base_model: baseModel,
      epochs,
      lora_r: loraR,
      lora_alpha: loraAlpha,
      seeds_path: seedsPath,
    };
  } else {
    // Existing spec on disk — coerce its training fields. Treat literal "none"
    // as unset (legacy compile specs use base_model: "none" to mean rule-only).
    spec.id = spec.id || spec.name || spec.job_id || fallbackId;
    spec.name = spec.name || spec.id;
    spec.base_model = (spec.base_model && spec.base_model !== 'none') ? spec.base_model : baseModel;
    spec.target_size = spec.target_size || targetSize;
    spec.epochs = spec.epochs || epochs;
    spec.lora_r = spec.lora_r || loraR;
    spec.lora_alpha = spec.lora_alpha || loraAlpha;
    spec.seeds_path = seedsPath;
  }

  // Load the backend adapter. Quote first (no auth needed), check availability
  // only when the user actually confirms.
  let adapter;
  try {
    adapter = (await import(`../src/compute/backends/${backend}.js`)).default;
  } catch (e) {
    console.error(`error: no adapter for backend "${backend}": ${e.message}`);
    process.exit(1);
  }
  const quote = typeof adapter.estimateCost === 'function'
    ? adapter.estimateCost({ pairCount, baseModel: spec.base_model, epochs: spec.epochs })
    : null;

  console.log(`\nkolm cloud train  ·  ${backend}`);
  console.log('-'.repeat(48));
  console.log(`  recipe:        ${spec.id || spec.name}`);
  console.log(`  base model:    ${spec.base_model}`);
  console.log(`  target size:   ${spec.target_size}`);
  console.log(`  training pairs: ${pairCount}`);
  console.log(`  epochs:        ${spec.epochs}`);
  console.log(`  LoRA:          r=${spec.lora_r}, alpha=${spec.lora_alpha}`);
  if (quote) {
    console.log('');
    console.log(`  est. cost:     ~$${quote.estimated_cost_usd}  (${quote.basis})`);
    console.log(`  est. duration: ~${quote.estimated_duration_minutes} minutes`);
  } else {
    console.log('');
    console.log('  est. cost:     varies (no estimator for this backend)');
  }
  if (budget && quote && quote.estimated_cost_usd > Number(budget)) {
    console.error(`\nrefusing: estimated cost $${quote.estimated_cost_usd} exceeds --budget $${budget}`);
    process.exit(2);
  }
  if (!confirm) {
    console.log('');
    console.log('this is a quote. to actually run the fine-tune (real GPU, real money):');
    console.log(`  kolm cloud train ${name} --seeds ${seedsPath} --confirm`);
    console.log('');
    if (backend === 'together') {
      console.log('first time? get a Together AI key (free signup, $5 trial credit):');
      console.log('  https://api.together.xyz/settings/api-keys');
      console.log('  then: export KOLM_TOGETHER_TOKEN=...');
    }
    return;
  }

  // --confirm path: now we need a working API key.
  const det = await adapter.detect();
  if (!det.available) {
    console.error(`\nerror: backend "${backend}" not available: ${det.reason}`);
    console.error('');
    if (backend === 'together') {
      console.error('  get a Together AI key (free signup, $5 credit): https://api.together.xyz/settings/api-keys');
      console.error('  then: export KOLM_TOGETHER_TOKEN=...');
    }
    process.exit(1);
  }

  console.log('\nstarting fine-tune. this will spend money. ^C to cancel before submit completes.');
  let result;
  try {
    result = await adapter.run(spec, {
      on_progress: ({ stage, pct }) => process.stderr.write(`  [${backend}] ${stage}${pct != null ? ' ' + pct + '%' : ''}\n`),
    });
  } catch (e) {
    console.error('\nfine-tune failed:', e.message);
    process.exit(1);
  }

  // Persist the spec + result into ~/.kolm/artifacts/<id>.cloud-train.json so
  // the user has a record they can reference for `kolm publish` later.
  const artifactsDir = path.join(os.homedir(), '.kolm', 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const outPath = path.join(artifactsDir, `${spec.id || spec.name}.cloud-train.json`);
  const record = {
    spec_id: spec.id || spec.name,
    spec,
    result,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2));

  console.log('\n' + '='.repeat(48));
  console.log('ok  fine-tune complete');
  console.log('-'.repeat(48));
  console.log(`  backend:      ${result.compute.backend}`);
  console.log(`  base model:   ${result.metrics.base_model}`);
  console.log(`  output model: ${result.metrics.together_model_output || '(provider-managed)'}`);
  console.log(`  duration:     ${result.compute.duration_seconds}s`);
  if (result.compute.cost_usd != null) {
    console.log(`  cost:         $${Number(result.compute.cost_usd).toFixed(2)}  (actual, billed by ${backend})`);
  }
  console.log(`  adapter:      ${result.adapter.url}`);
  console.log(`  sha256:       ${result.adapter.sha256}`);
  console.log(`  size:         ${(result.adapter.size_bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log('');
  console.log(`record:  ${outPath}`);
  console.log('');
  console.log('next steps:');
  console.log(`  serve via together:    https://api.together.xyz/v1/chat/completions  (model: ${result.metrics.together_model_output})`);
  console.log(`  package as .kolm:      kolm compile --spec ${specPath || (spec.id + '.spec.json')}  (uses the adapter you just trained)`);
  console.log(`  see all your trains:   ls ${artifactsDir}/*.cloud-train.json`);
}

// ---------- kolm airgap ----------
// Hard-offline mode. Sets transformers/HF offline env vars and verifies that
// `inspect`, `run`, `eval`, and signature checks all work with zero network.
async function cmdCompute(args) {
  const sub = args[0] || 'status';
  const rest = args.slice(1);
  // Catch typos like `--budjet 10` early — beats running detect/pick with the
  // flag silently dropped. Proves the rejectUnknownFlags pattern in one place
  // before sweeping it across other commands (audit gap #10).
  rejectUnknownFlags(rest, ['--json', '--force', '--airgap', '--budget', '--min-vram', '--infer-only', '--auto-provision', '--spec', '--backend', '--confirm', '--help', '-h'], 'compute ' + sub);
  const flagJson = rest.includes('--json');
  const flagAutoProvision = rest.includes('--auto-provision');
  const { default: compute } = await import('../src/compute/index.js');

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    console.log('kolm compute - where training runs (CPU, GPU, MPS, MLX, Modal, RunPod, Together, Vast, your own box).\n');
    console.log('USAGE');
    console.log('  kolm compute list                      print every backend the CLI knows about');
    console.log('  kolm compute detect [--force]          probe each backend on this machine');
    console.log('  kolm compute pick [--airgap] [--budget USD] [--min-vram GB]   show the picker\'s choice + reason');
    console.log('  kolm compute use <name> [--auto-provision]  set default backend in ~/.kolm/config.json');
    console.log('  kolm compute info <name>               metadata for one backend');
    console.log('  kolm compute test <name>               run the backend\'s smoke test');
    console.log('  kolm compute status                    current pick + detection summary');
    console.log('  kolm compute quote --spec FILE         estimate cost + duration per backend');
    console.log('  kolm compute rent --spec FILE --backend N [--confirm]   one-shot rent → train → tear down');
    console.log('');
    console.log('EXAMPLES');
    console.log('  kolm compute detect                    # what does my box actually have?');
    console.log('  KOLM_MODAL_TOKEN=xx kolm compute pick  # confirm modal beats local-cpu');
    console.log('  kolm compute use local-mps             # default to Apple Silicon');
    console.log('  kolm compute use vast --auto-provision # rent an H100, train, tear down');
    console.log('  kolm compute pick --airgap             # only on-box backends');
    console.log('  kolm compute quote --spec spec.json    # how much would each backend cost?');
    console.log('  kolm compute rent --spec spec.json --backend modal --confirm  # actually spend');
    console.log('');
    console.log('FLAGS');
    console.log('  --json                                 emit machine-readable JSON');
    console.log('  --force                                bypass detect cache (1hr default)');
    console.log('  --airgap                               restrict to backends that work offline');
    console.log('  --budget <usd>                         cap per-hour cost (or rent total cost)');
    console.log('  --min-vram <gb>                        require >= N GB VRAM');
    console.log('  --auto-provision                       (vast/lambda) rent + tear down per job; requires KOLM_VAST_TOKEN or KOLM_LAMBDA_TOKEN');
    console.log('  --spec <file>                          spec file for quote / rent');
    console.log('  --backend <name>                       backend name for quote / rent');
    console.log('  --confirm                              actually spend money on rent (default: dry-run quote only)');
    return;
  }

  if (sub === 'list') {
    const backends = compute.list();
    if (flagJson) { console.log(JSON.stringify(backends, null, 2)); return; }
    console.log('NAME             KIND               TRAIN  AIRGAP  TIER  $/hr   COLD   FRAMEWORK');
    for (const b of backends) {
      const cost = b.cost_per_hour_usd == null ? '—' : ('$' + b.cost_per_hour_usd.toFixed(2));
      const cold = (b.cold_start_seconds || 0) + 's';
      const airgap = b.airgap === true ? 'yes' : b.airgap === 'depends' ? 'priv' : 'no';
      console.log(
        `${b.name.padEnd(16)} ${String(b.kind).padEnd(18)} ${(b.train ? 'yes' : 'no').padEnd(6)} ${airgap.padEnd(7)} ${String(b.tier).padEnd(5)} ${cost.padEnd(6)} ${cold.padEnd(6)} ${b.framework}`
      );
    }
    return;
  }

  if (sub === 'detect') {
    const force = rest.includes('--force');
    const det = await compute.detect({ force });
    if (flagJson) { console.log(JSON.stringify(det, null, 2)); return; }
    console.log(`detection at ${det.at} ${force ? '(forced)' : '(cached)'}`);
    for (const [name, r] of Object.entries(det.backends)) {
      const tag = r.available ? '✓' : '×';
      const detail = r.available ? (r.device || r.region || '') : (r.reason || '');
      console.log(`  ${tag} ${name.padEnd(16)} ${detail}`);
    }
    return;
  }

  if (sub === 'pick') {
    const constraints = {};
    if (rest.includes('--airgap')) constraints.airgap = true;
    const bIdx = rest.indexOf('--budget');
    if (bIdx >= 0 && rest[bIdx + 1]) constraints.budget_usd = Number(rest[bIdx + 1]);
    const vIdx = rest.indexOf('--min-vram');
    if (vIdx >= 0 && rest[vIdx + 1]) constraints.min_vram_gb = Number(rest[vIdx + 1]);
    if (rest.includes('--infer-only')) constraints.train_required = false;
    const pick = await compute.pick(constraints);
    if (flagJson) { console.log(JSON.stringify(pick, null, 2)); return; }
    if (!pick.backend) { console.log('no backend matched the constraints.'); return; }
    console.log(`pick:     ${pick.backend}`);
    console.log(`device:   ${pick.device || '(adapter-resolved)'}`);
    console.log(`score:    ${pick.score}`);
    console.log(`reason:   ${pick.reason}`);
    if (pick.alternatives && pick.alternatives.length) {
      console.log('alternatives:');
      for (const a of pick.alternatives) {
        console.log(`  ${a.backend.padEnd(16)} score=${a.score} ${a.available ? '(available)' : ''}`);
      }
    }
    return;
  }

  if (sub === 'use') {
    // First positional arg that isn't a flag is the backend name.
    const name = rest.find(a => !a.startsWith('-'));
    if (!name) {
      const err = new Error('usage: kolm compute use <backend-name> [--auto-provision]');
      err.exitCode = EXIT.BAD_ARGS;
      throw err;
    }
    if (flagAutoProvision && !['vast', 'lambda'].includes(name)) {
      const err = new Error(`--auto-provision is only supported for vast and lambda (got: ${name})\nhint: vast and lambda are the only backends that can rent + tear down per job`);
      err.exitCode = EXIT.BAD_ARGS;
      throw err;
    }
    try {
      const out = compute.use(name);
      // Persist compute_options.auto_provision so the trainer job picks it up.
      // We re-read the config the same way compute.use() wrote it.
      const cfgPath = out.written_to;
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch { /* fresh file */ }
      cfg.compute_options = cfg.compute_options || {};
      if (flagAutoProvision) {
        cfg.compute_options.auto_provision = true;
      } else if (cfg.compute_options.auto_provision === true) {
        // Explicit `kolm compute use <name>` (no flag) clears stale state so
        // the user doesn't accidentally inherit auto-provision from a prior
        // session pointed at a different backend.
        delete cfg.compute_options.auto_provision;
      }
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      console.log('default backend set to:', out.backend);
      console.log('written to:', out.written_to);
      if (flagAutoProvision) {
        console.log('auto-provision:   on (kolm will rent + tear down ' + name + ' instances per job)');
        const tokenVar = name === 'vast' ? 'KOLM_VAST_TOKEN' : 'KOLM_LAMBDA_TOKEN';
        if (!process.env[tokenVar]) {
          console.log('warning:          ' + tokenVar + ' is not set in this shell. Export it before training.');
        }
        if (name === 'lambda' && !process.env.KOLM_LAMBDA_SSH_KEY_NAME) {
          console.log('warning:          KOLM_LAMBDA_SSH_KEY_NAME is not set. Upload an SSH key at https://cloud.lambdalabs.com/ssh-keys and export the name.');
        }
      }
    } catch (origErr) {
      const err = new Error(`${origErr.message}\nhint: try \`kolm compute list\` to see available names`);
      err.exitCode = EXIT.BAD_ARGS;
      throw err;
    }
    return;
  }

  if (sub === 'info') {
    const name = rest[0];
    if (!name) {
      const err = new Error('usage: kolm compute info <backend-name>');
      err.exitCode = EXIT.BAD_ARGS;
      throw err;
    }
    const i = compute.info(name);
    if (!i) {
      const err = new Error(`unknown backend: ${name}`);
      err.exitCode = EXIT.NOT_FOUND;
      throw err;
    }
    if (flagJson) { console.log(JSON.stringify(i, null, 2)); return; }
    for (const [k, v] of Object.entries(i)) {
      console.log(`  ${k.padEnd(22)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    if (name === 'vast') {
      console.log('');
      console.log('  Pass `--auto-provision` to rent + tear down per job. Requires KOLM_VAST_TOKEN.');
      console.log('  Tunables: KOLM_VAST_MIN_VRAM_GB (default 24), KOLM_VAST_MAX_DPH (default 1.50).');
    } else if (name === 'lambda') {
      console.log('');
      console.log('  Pass `--auto-provision` to rent + tear down per job. Requires KOLM_LAMBDA_TOKEN.');
      console.log('  Also set KOLM_LAMBDA_SSH_KEY_NAME (name of an SSH key you uploaded to Lambda).');
    }
    return;
  }

  if (sub === 'test') {
    const name = rest[0];
    if (!name) {
      const err = new Error('usage: kolm compute test <backend-name>');
      err.exitCode = EXIT.BAD_ARGS;
      throw err;
    }
    const out = await compute.test(name);
    if (flagJson) {
      console.log(JSON.stringify(out, null, 2));
      if (!out.ok) process.exit(2);
      return;
    }
    console.log(`${out.ok ? 'PASS' : 'FAIL'}  ${name}  ${out.latency_ms != null ? out.latency_ms + 'ms' : ''}`);
    if (!out.ok && out.reason) console.log(`  reason: ${out.reason}`);
    if (out.device) console.log(`  device: ${out.device}`);
    if (!out.ok) process.exit(2);
    return;
  }

  if (sub === 'status') {
    const c = loadConfig();
    const det = await compute.detect();
    const pick = await compute.pick({});
    const cfgDefault = c.default_compute_backend || '(unset — using picker)';
    if (flagJson) { console.log(JSON.stringify({ default: cfgDefault, pick, detection: det }, null, 2)); return; }
    console.log(`default backend:  ${cfgDefault}`);
    console.log(`picker pick:      ${pick.backend} (score ${pick.score})`);
    console.log(`reason:           ${pick.reason}`);
    const avail = Object.entries(det.backends).filter(([, r]) => r.available);
    console.log(`available:        ${avail.length}/${Object.keys(det.backends).length} backends`);
    for (const [name, r] of avail) {
      console.log(`  ✓ ${name.padEnd(16)} ${r.device || ''}`);
    }
    return;
  }

  if (sub === 'quote') {
    const specIdx = rest.indexOf('--spec');
    const specPath = specIdx >= 0 ? rest[specIdx + 1] : null;
    if (!specPath) {
      const err = new Error('usage: kolm compute quote --spec <file.json> [--backend <name>]');
      err.exitCode = EXIT.BAD_ARGS;
      throw err;
    }
    let spec;
    try { spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')); }
    catch (e) {
      const err = new Error(`cannot read spec: ${e.message}`);
      err.exitCode = EXIT.NOT_FOUND;
      throw err;
    }
    const bIdx = rest.indexOf('--backend');
    const onlyBackend = bIdx >= 0 ? rest[bIdx + 1] : null;
    const { default: estimator } = await import('../src/compute/estimator.js');
    const out = onlyBackend ? estimator.estimate(spec, onlyBackend) : estimator.estimateAll(spec);
    if (flagJson) { console.log(JSON.stringify(out, null, 2)); return; }
    const rows = Array.isArray(out) ? out : [out];
    console.log('BACKEND          DURATION    COST       BASIS              SUPPORTED');
    for (const r of rows) {
      if (!r.supported) {
        console.log(`${r.backend.padEnd(16)} ${'—'.padEnd(11)} ${'—'.padEnd(10)} ${(r.reason || '').padEnd(18)} no`);
        continue;
      }
      const cost = r.cost_usd == null ? '(quote at run)' : `$${r.cost_usd.toFixed(2)}`;
      console.log(`${r.backend.padEnd(16)} ${(r.duration_human || '').padEnd(11)} ${cost.padEnd(10)} ${(r.cost_basis || '').padEnd(18)} yes`);
    }
    if (!onlyBackend) {
      console.log('');
      console.log('hint: kolm compute rent --spec ' + specPath + ' --backend <name> --confirm');
    }
    return;
  }

  if (sub === 'rent') {
    const specIdx = rest.indexOf('--spec');
    const specPath = specIdx >= 0 ? rest[specIdx + 1] : null;
    const bIdx = rest.indexOf('--backend');
    const backend = bIdx >= 0 ? rest[bIdx + 1] : null;
    if (!specPath || !backend) {
      const err = new Error('usage: kolm compute rent --spec <file.json> --backend <name> [--confirm] [--budget USD]');
      err.exitCode = EXIT.BAD_ARGS;
      throw err;
    }
    let spec;
    try { spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')); }
    catch (e) {
      const err = new Error(`cannot read spec: ${e.message}`);
      err.exitCode = EXIT.NOT_FOUND;
      throw err;
    }
    const budgetIdx = rest.indexOf('--budget');
    const budget = budgetIdx >= 0 ? Number(rest[budgetIdx + 1]) : null;
    const confirm = rest.includes('--confirm');
    const { default: renter } = await import('../src/compute/rent.js');
    const result = await renter.rent(spec, {
      backend,
      confirm,
      budget_usd: Number.isFinite(budget) ? budget : null,
      on_progress: ({ stage, pct }) => {
        if (!flagJson) console.error(`  [${backend}] ${stage} ${pct != null ? pct + '%' : ''}`);
      },
    });
    if (flagJson) { console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exit(EXIT.EXECUTION); return; }
    if (result.dry_run) {
      console.log(`quote for ${result.backend}:`);
      console.log(`  duration:   ${result.estimate.duration_human}`);
      console.log(`  cost:       ${result.estimate.cost_usd == null ? '(varies)' : '$' + result.estimate.cost_usd.toFixed(2)}`);
      console.log(`  basis:      ${result.estimate.cost_basis}`);
      console.log('');
      console.log('pass --confirm to actually rent + run.');
      return;
    }
    if (!result.ok) {
      console.error(`rent failed: ${result.reason}`);
      process.exit(EXIT.EXECUTION);
    }
    console.log(`rented ${result.backend}`);
    console.log(`  started:   ${result.started_at}`);
    console.log(`  finished:  ${result.finished_at}`);
    console.log(`  quote:     ${result.estimate.duration_human} @ ${result.estimate.cost_usd == null ? '(varies)' : '$' + result.estimate.cost_usd.toFixed(2)}`);
    console.log(`  teardown:  ${result.rental.teardown} (${result.rental.managed_by})`);
    if (result.result && result.result.artifact_path) {
      console.log(`  artifact:  ${result.result.artifact_path}`);
    }
    return;
  }

  // Throw (instead of process.exit) so withErrorContext can prefix the message
  // with `[kolm compute]` and the global catch honors exitCode = BAD_ARGS.
  throw Object.assign(new Error(`unknown subcommand: ${sub}. try: kolm compute --help`), { exitCode: EXIT.BAD_ARGS });
}

async function cmdAirgap(args) {
  const sub = args[0] || 'status';
  const rest = args.slice(1);
  const airgapEnvPath = path.join(KOLM_DIR, 'airgap.env');
  const vars = {
    KOLM_AIRGAP: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_DATASETS_OFFLINE: '1',
    HF_HUB_OFFLINE: '1',
  };
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    usage('airgap');
    return;
  }
  if (sub === 'status') {
    const enabled = fs.existsSync(airgapEnvPath);
    console.log(`airgap mode:         ${enabled ? 'enabled' : 'off'}`);
    console.log(`env file:            ${airgapEnvPath}${enabled ? '' : ' (missing — run `kolm airgap enable`)'}`);
    console.log(`runtime env vars:`);
    for (const k of Object.keys(vars)) {
      const live = process.env[k] || '(unset)';
      console.log(`  ${k.padEnd(24)} ${live}`);
    }
    const arts = fs.existsSync(ARTIFACTS_DIR) ? fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('.kolm')) : [];
    console.log(`local .kolm artifacts: ${arts.length} in ${ARTIFACTS_DIR}`);
    console.log(`receipt secret:        ${process.env.RECIPE_RECEIPT_SECRET ? 'set (signatures verifiable)' : 'unset — set RECIPE_RECEIPT_SECRET to verify HMAC chain'}`);
    return;
  }
  if (sub === 'enable') {
    ensureDir();
    const lines = Object.entries(vars).map(([k, v]) => `export ${k}=${v}`).join('\n') + '\n';
    fs.writeFileSync(airgapEnvPath, lines, { mode: 0o600 });
    console.log('wrote ' + airgapEnvPath);
    console.log('');
    console.log('shell:    source ~/.kolm/airgap.env');
    console.log('windows:  Get-Content $env:USERPROFILE\\.kolm\\airgap.env | ForEach-Object { if ($_ -match "export (\\w+)=(.+)") { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process") } }');
    return;
  }
  if (sub === 'disable') {
    if (fs.existsSync(airgapEnvPath)) {
      fs.unlinkSync(airgapEnvPath);
      console.log('removed ' + airgapEnvPath);
    } else {
      console.log('already disabled');
    }
    return;
  }
  if (sub === 'verify') {
    const ap = resolveArtifact(rest[0]);
    if (!ap) {
      const err = new Error(`artifact not found: ${rest[0]}`);
      err.exitCode = EXIT.NOT_FOUND;
      throw err;
    }
    for (const [k, v] of Object.entries(vars)) process.env[k] = process.env[k] || v;
    await withRunner(async ({ inspectArtifact, runArtifact }) => {
      const info = inspectArtifact(ap);
      console.log(JSON.stringify({
        artifact: path.basename(ap),
        manifest_job: info.manifest?.job_id,
        signature: info.signature || info.manifest?.signature || '(none)',
        recipes: (info.recipes?.recipes || []).map(r => ({ id: r.id, name: r.name })),
        k_score: info.manifest?.k_score?.composite ?? null,
        size_bytes: info.size_bytes,
        offline_env: Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k] || null])),
      }, null, 2));
      console.log('');
      console.log('verified offline — no network calls made.');
    });
    return;
  }
  console.error('unknown airgap subcommand:', sub);
  console.error('try: kolm airgap --help');
  process.exit(EXIT.BAD_ARGS);
}

// Detect when the user typed a bare natural-language string instead of a
// verb (e.g. `kolm "what's my status"` or `kolm refund the customer in 87421`).
// We route through /v1/assistant the same way `kolm ask` does so non-technical
// users get a useful reply without memorising the verb-noun grammar.
function looksLikeNaturalLanguage(cmd, rest) {
  if (!cmd) return false;
  if (cmd.startsWith('-')) return false;
  // multi-word first arg ("what's my status") OR mixed-case sentence-y
  if (/\s/.test(cmd)) return true;
  // single-word cmd that is clearly English: ends with ? or contains apostrophe
  if (/[?']/.test(cmd)) return true;
  // sentence-style: starts with a question word + more args
  if (rest.length && /^(what|how|where|when|why|who|show|tell|give|make|build|let|please|i|my)$/i.test(cmd)) return true;
  return false;
}

// ---------- kolm completion ----------
// Single source of truth for the verb + subcommand tables the shell completion
// scripts consume. Keep this in sync with the dispatch switch below.
const COMPLETION_VERBS = [
  'init', 'signup', 'login', 'whoami', 'new', 'build', 'compile', 'train', 'run', 'eval', 'benchmark', 'bench',
  'score', 'list', 'ls', 'inspect', 'diff', 'verify', 'serve', 'publish', 'pull', 'hub', 'capture', 'labels', 'distill',
  'config', 'install', 'tune', 'rag', 'team', 'tunnel', 'cloud', 'airgap',
  'compute', 'doctor', 'logs', 'ask', 'chat', 'version', 'help', 'completion', 'upgrade', 'update',
  'models', 'gpu', 'export', 'seeds', 'anonymize', 'improve', 'instant',
];
const COMPLETION_SUBS = {
  compute: ['list', 'detect', 'pick', 'use', 'info', 'test', 'status'],
  airgap:  ['status', 'enable', 'disable', 'verify'],
  team:    ['create', 'list', 'show', 'invite', 'accept', 'members', 'role', 'remove', 'transfer', 'delete'],
  tunnel:  ['new', 'list', 'start', 'close'],
  cloud:   ['train', 'targets', 'deploy', 'list', 'show', 'destroy'],
  hub:     ['list', 'ls', 'show'],
  tune:    ['init', 'capture-on', 'capture-off', 'step', 'eval', 'promote', 'rollback', 'watch', 'status'],
  rag:     ['index', 'query', 'attach', 'list'],
  capture: ['status'],
  install: ['claude-code', 'cursor', 'continue', 'cline'],
  completion: ['bash', 'zsh', 'fish'],
  models:  ['list', 'info', 'recommend', 'pin', 'devices'],
  gpu:     ['detect', 'doctor', 'setup', 'stress'],
  seeds:   ['new', 'generate', 'list', 'bootstrap', 'validate'],
};

function emitBashCompletion() {
    const verbs = COMPLETION_VERBS.join(' ');
    const subLines = Object.entries(COMPLETION_SUBS)
        .map(([v, subs]) => `            ${v}) COMPREPLY=( $(compgen -W "${subs.join(' ')}" -- "$cur") ) ;;`)
        .join('\n');
    return `# kolm bash completion. install with: kolm completion bash >> ~/.bashrc
_kolm_complete() {
    local cur prev verbs
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    verbs="${verbs}"
    if [ "$COMP_CWORD" -eq 1 ]; then
        COMPREPLY=( $(compgen -W "$verbs" -- "$cur") )
        return 0
    fi
    if [ "$COMP_CWORD" -eq 2 ]; then
        case "$prev" in
${subLines}
            *) COMPREPLY=() ;;
        esac
        return 0
    fi
    return 0
}
complete -F _kolm_complete kolm
`;
}

function emitZshCompletion() {
    const verbLines = COMPLETION_VERBS.map(v => `        '${v}:run the kolm ${v} subcommand'`).join(' \\\n');
    const subBlocks = Object.entries(COMPLETION_SUBS).map(([v, subs]) => {
        const args = subs.map(s => `'${s}:${v} ${s}'`).join(' \\\n                    ');
        return `            ${v})
                _values '${v} subcommands' \\
                    ${args}
                ;;`;
    }).join('\n');
    return `#compdef kolm
# kolm zsh completion. install with: kolm completion zsh > ~/.zsh/completions/_kolm
# Then ensure ~/.zsh/completions is on your fpath and run \`compinit\`.

_kolm() {
    local -a verbs
    verbs=( \\
${verbLines} \\
    )
    if (( CURRENT == 2 )); then
        _describe -t commands 'kolm command' verbs
        return 0
    fi
    if (( CURRENT == 3 )); then
        case "\${words[2]}" in
${subBlocks}
        esac
    fi
}

_kolm "$@"
`;
}

function emitFishCompletion() {
    const lines = [];
    lines.push('# kolm fish completion. install with: kolm completion fish > ~/.config/fish/completions/kolm.fish');
    lines.push('');
    lines.push("# top-level verbs (only when no subcommand has been typed yet)");
    for (const v of COMPLETION_VERBS) {
        lines.push(`complete -c kolm -n "__fish_use_subcommand" -a "${v}" -d "kolm ${v}"`);
    }
    lines.push('');
    lines.push('# second-level subcommands');
    for (const [v, subs] of Object.entries(COMPLETION_SUBS)) {
        for (const s of subs) {
            lines.push(`complete -c kolm -n "__fish_seen_subcommand_from ${v}" -a "${s}" -d "${v} ${s}"`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

// ---------- kolm models ----------
async function cmdModels(args) {
    if (maybeHelp('models', args)) return;
    const sub = args[0];
    const rest = args.slice(1);
    const M = await import('../src/models.js');
    const D = await import('../src/devices.js');
    const jsonOut = rest.includes('--json');

    switch (sub) {
        case undefined:
        case 'list': {
            const filter = {};
            const flag = (n) => rest[rest.indexOf(n) + 1];
            if (rest.includes('--family'))     filter.family     = flag('--family');
            if (rest.includes('--tier'))       filter.tier       = flag('--tier');
            if (rest.includes('--license'))    filter.license    = flag('--license');
            if (rest.includes('--permissive')) filter.permissive = true;
            if (rest.includes('--max-vram'))   filter.max_vram_gb = Number(flag('--max-vram'));
            const list = M.list(filter);
            if (jsonOut) { console.log(JSON.stringify(list, null, 2)); return; }
            const w = (s, n) => String(s).padEnd(n);
            console.log(w('MODEL', 38), w('LICENSE', 18), w('PARAMS', 8), w('VRAM-4BIT', 10), 'NOTES');
            for (const m of list) {
                console.log(w(m.id, 38), w(m.license, 18), w(`${m.params_b}B`, 8), w(`${m.vram_gb_4bit}GB`, 10), m.notes || '');
            }
            return;
        }
        case 'info': {
            const id = rest[0];
            if (!id) {
                const err = new Error('usage: kolm models info <model-id>');
                err.exitCode = EXIT.BAD_ARGS; throw err;
            }
            const m = M.info(id);
            if (!m) {
                const err = new Error(`unknown model: ${id}`);
                err.exitCode = EXIT.NOT_FOUND; throw err;
            }
            if (jsonOut) { console.log(JSON.stringify(m, null, 2)); return; }
            for (const [k, v] of Object.entries(m)) console.log(`  ${k.padEnd(20)} ${Array.isArray(v) ? v.join(', ') : v}`);
            return;
        }
        case 'recommend': {
            const reqs = {};
            const flag = (n) => rest[rest.indexOf(n) + 1];
            if (rest.includes('--use'))         reqs.use            = flag('--use');
            if (rest.includes('--vram'))        reqs.vram_gb        = Number(flag('--vram'));
            if (rest.includes('--permissive'))  reqs.permissive     = true;
            if (rest.includes('--english-only')) reqs.english_only  = true;
            if (rest.includes('--tool-use'))    reqs.tool_use       = flag('--tool-use');
            if (rest.includes('--device')) {
                const did = flag('--device');
                const d = D.info(did);
                if (!d) {
                    const err = new Error(`unknown device: ${did}. try: kolm models devices`);
                    err.exitCode = EXIT.BAD_ARGS; throw err;
                }
                reqs.target_device = d;
            }
            if (rest.includes('--train-device')) {
                const did = flag('--train-device');
                const d = D.info(did);
                if (!d) {
                    const err = new Error(`unknown device: ${did}. try: kolm models devices`);
                    err.exitCode = EXIT.BAD_ARGS; throw err;
                }
                reqs.train_device = d;
            }
            const out = M.recommend(reqs);
            if (jsonOut) { console.log(JSON.stringify(out, null, 2)); return; }
            console.log('pick:', out.pick);
            if (out.device_fit !== null) console.log('device_fit:', out.device_fit);
            if (out.device_train !== null) console.log('device_train:', out.device_train);
            console.log('top:');
            for (const t of out.top) console.log(`  ${t.score.toFixed(3)}  ${t.id}`);
            return;
        }
        case 'pin': {
            const tenant = rest[0];
            const modelId = rest[1];
            if (!tenant || !modelId) {
                const err = new Error('usage: kolm models pin <tenant> <model-id>');
                err.exitCode = EXIT.BAD_ARGS; throw err;
            }
            await M.setPin(tenant, modelId);
            if (jsonOut) { console.log(JSON.stringify({ tenant, pinned: modelId })); return; }
            console.log(`pinned ${tenant} -> ${modelId}`);
            return;
        }
        case 'devices': {
            const list = D.list();
            if (jsonOut) { console.log(JSON.stringify(list, null, 2)); return; }
            const w = (s, n) => String(s).padEnd(n);
            console.log(w('DEVICE', 18), w('CLASS', 12), w('ARCH', 16), w('VRAM-GB', 10), 'NOTES');
            for (const d of list) console.log(w(d.id, 18), w(d.class, 12), w(d.arch, 16), w(d.vram_gb ?? '-', 10), d.notes || '');
            return;
        }
        default: {
            const err = new Error(`unknown subcommand: ${sub}. try: list info recommend pin devices`);
            err.exitCode = EXIT.BAD_ARGS; throw err;
        }
    }
}

// ---------- kolm gpu ----------
async function cmdGpu(args) {
    if (maybeHelp('gpu', args)) return;
    const sub = args[0] || 'detect';
    const rest = args.slice(1);
    const D = await import('../src/devices.js');
    const jsonOut = rest.includes('--json');

    switch (sub) {
        case 'detect': {
            const det = await D.detectLocal();
            const dev = D.info(det.id);
            if (jsonOut) { console.log(JSON.stringify({ ...det, profile: dev }, null, 2)); return; }
            console.log(`detected: ${det.id} (source=${det.source}, confidence=${det.confidence})`);
            if (det.raw) console.log(`  raw: ${JSON.stringify(det.raw)}`);
            if (dev) {
                console.log(`  arch: ${dev.arch}, sm: ${dev.sm}, vram_gb: ${dev.vram_gb}`);
                if (dev.cuda_min) console.log(`  requires cuda >= ${dev.cuda_min}, torch >= ${dev.torch_min}, flash_attn=${dev.flash_attn}`);
            }
            return;
        }
        case 'doctor': {
            // Run a battery of checks: python, torch, cuda, flash-attn, bnb, unsloth.
            const checks = [];
            const py = spawnSync('python', ['--version'], { encoding: 'utf8' });
            checks.push({ name: 'python', ok: py.status === 0, detail: (py.stdout || py.stderr).trim() });

            const torchScript = `import json; out={};
try: import torch; out['torch']=torch.__version__; out['cuda_avail']=torch.cuda.is_available(); out['cuda_version']=torch.version.cuda
except Exception as e: out['torch']=None; out['err']=str(e)
print(json.dumps(out))`;
            const t = spawnSync('python', ['-c', torchScript], { encoding: 'utf8' });
            let torchInfo = {};
            try { torchInfo = JSON.parse(t.stdout || '{}'); } catch {}
            checks.push({ name: 'torch', ok: !!torchInfo.torch, detail: JSON.stringify(torchInfo) });

            const probe = (mod) => {
                const r = spawnSync('python', ['-c', `import ${mod}; print(getattr(${mod}, '__version__', 'unknown'))`], { encoding: 'utf8' });
                if (r.status === 0) return { name: mod, ok: true, detail: (r.stdout || '').trim() };
                // On miss, just say "not installed" -- spare the user a traceback.
                return { name: mod, ok: false, detail: 'not installed' };
            };
            for (const mod of ['transformers', 'peft', 'trl', 'bitsandbytes', 'unsloth', 'flash_attn', 'liger_kernel']) {
                checks.push(probe(mod));
            }

            const det = await D.detectLocal();
            const dev = D.info(det.id);
            const minTorch = dev?.torch_min;
            const torchOk = torchInfo.torch && minTorch ? compareVersions(torchInfo.torch.split('+')[0], minTorch) >= 0 : null;
            const blockers = [];
            if (dev?.class === 'training' && !torchInfo.cuda_avail) blockers.push('torch is not built with CUDA -- training will fail on this device');
            if (dev?.class === 'training' && minTorch && torchOk === false) blockers.push(`torch ${torchInfo.torch} < required ${minTorch} for ${dev.id}`);
            if (dev?.class === 'training' && !checks.find(c => c.name === 'flash_attn').ok) blockers.push('flash_attn not installed -- training will be 2-3x slower');
            if (dev?.class === 'training' && !checks.find(c => c.name === 'unsloth').ok) blockers.push('unsloth not installed -- main training path unavailable');

            if (jsonOut) { console.log(JSON.stringify({ device: det, checks, blockers, ok: blockers.length === 0 }, null, 2)); return; }
            console.log(`device: ${det.id}`);
            console.log('checks:');
            for (const c of checks) console.log(`  ${c.ok ? 'OK  ' : 'MISS'}  ${c.name.padEnd(16)} ${c.detail || ''}`);
            if (blockers.length) {
                console.log('\nblockers:');
                for (const b of blockers) console.log(`  -- ${b}`);
                const err = new Error(`${blockers.length} blocker(s). run 'kolm gpu setup' to install.`);
                err.exitCode = EXIT.RUNTIME; throw err;
            } else {
                console.log('\nall checks passed.');
            }
            return;
        }
        case 'setup': {
            // Build the right pip install line for the detected device.
            const det = await D.detectLocal();
            const dev = D.info(det.id);
            const dryRun = rest.includes('--dry-run');
            if (!dev || dev.class !== 'training') {
                const err = new Error(`device ${det.id} is not a training rig; nothing to set up`);
                err.exitCode = EXIT.BAD_ARGS; throw err;
            }
            const cudaTag = (dev.cuda_min || '12.4').replace('.', '');
            const torchSpec = `torch>=${dev.torch_min || '2.4'}`;
            // sm_120 (Blackwell) requires cu128 wheels and a recent torch.
            const torchIndex = dev.arch === 'blackwell'
                ? 'https://download.pytorch.org/whl/cu128'
                : `https://download.pytorch.org/whl/cu${cudaTag}`;
            const lines = [
                `# Detected: ${det.id} (${dev.arch}, sm ${dev.sm}, ${dev.vram_gb}GB)`,
                `python -m pip install --upgrade pip`,
                `python -m pip install --index-url ${torchIndex} ${torchSpec} torchvision torchaudio`,
                `python -m pip install transformers peft trl datasets accelerate`,
                `python -m pip install bitsandbytes`,
                `python -m pip install unsloth`,
                `python -m pip install liger-kernel`,
            ];
            if (dev.flash_attn === 'fa3') {
                lines.push(`# Flash-Attention 3 (Blackwell/Hopper). Build from source if wheel unavailable.`);
                lines.push(`python -m pip install flash-attn --no-build-isolation`);
            } else if (dev.flash_attn === 'fa2') {
                lines.push(`python -m pip install flash-attn --no-build-isolation`);
            }
            if (jsonOut) { console.log(JSON.stringify({ device: det.id, commands: lines, dry_run: dryRun }, null, 2)); return; }
            console.log(lines.join('\n'));
            if (!dryRun && !rest.includes('--yes')) {
                console.log('\nthis will install the CUDA training stack. re-run with --yes to execute.');
                return;
            }
            if (!dryRun && rest.includes('--yes')) {
                for (const line of lines) {
                    if (line.startsWith('#')) continue;
                    console.log(`\n$ ${line}`);
                    const r = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'sh',
                        process.platform === 'win32' ? ['/c', line] : ['-c', line],
                        { stdio: 'inherit' });
                    if (r.status !== 0) {
                        const err = new Error(`install step failed: ${line}`);
                        err.exitCode = EXIT.RUNTIME; throw err;
                    }
                }
                console.log('\nrun "kolm gpu doctor" to verify.');
            }
            return;
        }
        case 'stress': {
            // 30s forward/backward loop on a small model to verify the stack works.
            const det = await D.detectLocal();
            const py = `
import time, torch
if not torch.cuda.is_available():
    raise SystemExit('torch.cuda not available')
print('device:', torch.cuda.get_device_name(0))
print('vram:', round(torch.cuda.get_device_properties(0).total_memory/1024**3, 1), 'GB')
x = torch.randn(2048, 2048, device='cuda', dtype=torch.bfloat16)
w = torch.randn(2048, 2048, device='cuda', dtype=torch.bfloat16, requires_grad=True)
t0 = time.time()
steps = 0
while time.time() - t0 < 5:
    y = (x @ w).relu()
    y.sum().backward()
    w.grad = None
    steps += 1
elapsed = time.time() - t0
tflops = (2*2048**3 * steps * 2) / elapsed / 1e12
print(f'steps: {steps}, elapsed: {elapsed:.1f}s, tflops: {tflops:.1f}')
print('OK')
`;
            const r = spawnSync('python', ['-c', py], { encoding: 'utf8' });
            if (jsonOut) { console.log(JSON.stringify({ device: det.id, ok: r.status === 0, stdout: r.stdout, stderr: r.stderr }, null, 2)); return; }
            if (r.stdout) process.stdout.write(r.stdout);
            if (r.stderr) process.stderr.write(r.stderr);
            if (r.status !== 0) {
                const err = new Error('stress test failed');
                err.exitCode = EXIT.RUNTIME; throw err;
            }
            return;
        }
        default: {
            const err = new Error(`unknown subcommand: ${sub}. try: detect doctor setup stress`);
            err.exitCode = EXIT.BAD_ARGS; throw err;
        }
    }
}

async function cmdCompletion(args) {
    if (maybeHelp('completion', args)) return;
    const shell = args[0];
    if (!shell) {
        console.error('usage: kolm completion <bash|zsh|fish>');
        throw Object.assign(new Error('missing shell argument'), { exitCode: EXIT.BAD_ARGS });
    }
    switch (shell) {
        case 'bash': process.stdout.write(emitBashCompletion()); return;
        case 'zsh':  process.stdout.write(emitZshCompletion());  return;
        case 'fish': process.stdout.write(emitFishCompletion()); return;
        default:
            console.error(`error: unknown shell '${shell}'. supported: bash, zsh, fish.`);
            throw Object.assign(new Error(`unknown shell: ${shell}`), { exitCode: EXIT.BAD_ARGS });
    }
}

// ---------- kolm upgrade ----------
// Informational verb only — never auto-upgrades. Reads the current version from
// the package.json that ships next to this CLI, then fetches the latest
// version from the canonical install source (github main package.json, NOT
// the unrelated `kolm` package on npm registry). 5s timeout. If the network
// is down or github is unreachable, status is `unknown` and we keep the
// current version.
function readPackageVersion() {
    try {
        const pkgPath = new URL('../package.json', import.meta.url);
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return pkg.version || VERSION;
    } catch {
        return VERSION;
    }
}

// Resolve the canonical latest version of kolm. The canonical install is
// `npm i -g github:sneaky-hippo/kolmogorov-stack` (NOT the unrelated `kolm`
// npm package), so we read the version off the github main branch's
// package.json. Falls back to null on any error.
function fetchLatestNpmVersion(timeoutMs) {
    return new Promise((resolve) => {
        const url = 'https://raw.githubusercontent.com/sneaky-hippo/kolmogorov-stack/main/package.json';
        const controller = new AbortController();
        const timer = setTimeout(() => { try { controller.abort(); } catch {} }, Math.max(500, Number(timeoutMs) || 5000));
        fetch(url, { signal: controller.signal, headers: { 'accept': 'application/json' } })
            .then(async (res) => {
                clearTimeout(timer);
                if (!res.ok) return resolve(null);
                const text = await res.text();
                try {
                    const pkg = JSON.parse(text);
                    if (pkg && typeof pkg.version === 'string' && pkg.version) return resolve(pkg.version);
                } catch {}
                resolve(null);
            })
            .catch(() => { clearTimeout(timer); resolve(null); });
    });
}

// Compare two semver-ish strings. Returns -1/0/1. Falls back to lexical compare
// when both strings fail the simple x.y.z parse so we never throw on weird tags.
function compareVersions(a, b) {
    const parse = (s) => {
        const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const pa = parse(a), pb = parse(b);
    if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }
    return 0;
}

async function cmdUpgrade(args) {
    if (maybeHelp('upgrade', args)) return;
    const jsonOut = args.includes('--json');
    const current = readPackageVersion();
    const latest = await fetchLatestNpmVersion(5000);
    let status;
    if (!latest) status = 'unknown';
    else if (compareVersions(latest, current) > 0) status = 'outdated';
    else status = 'current';
    if (jsonOut) {
        console.log(JSON.stringify({ current, latest: latest || null, status }, null, 2));
        return;
    }
    console.log(`current: ${current}`);
    console.log(`latest:  ${latest || '(unknown. npm unreachable)'}`);
    console.log('');
    if (status === 'outdated') {
        console.log(`a newer kolm release is available: ${latest}.`);
        console.log('upgrade with:');
        console.log('  npm i -g github:sneaky-hippo/kolmogorov-stack');
        console.log('  # or one-shot:');
        console.log('  kolm update');
        console.log('');
        console.log('breaking changes for this release (if any) are listed at https://kolm.ai/changelog.');
        return;
    }
    if (status === 'current') {
        console.log('kolm is up to date.');
        return;
    }
    console.log('could not reach github to check for updates.');
    console.log('to upgrade manually:');
    console.log('  npm i -g github:sneaky-hippo/kolmogorov-stack');
}

// ---------- seeds ----------
// `kolm seeds <sub>` is the honest training-data helper family.
//
// Goals (the founder constraints):
//   1. NO hallucinated data. Every strategy needs seeds as input (except
//      `bootstrap` which ships public-domain data).
//   2. NO fake K-scores. We only emit input/output pairs. K-score is computed
//      later by the train loop, with provenance broken out per row.
//   3. NO third-party API leakage. The only network egress allowed is the
//      `local-llm` strategy, which is gated to localhost (validateLocalhost)
//      and prompts the user for explicit confirmation before sending seeds.
//   4. Local-first. Everything (templates, public seed dataset, mutation rules)
//      ships on disk. The verb works fully offline.
//   5. Determinism. Same --from + --strategy + --seed-rng -> identical bytes.
//
// Subcommands:
//   new <name>         scaffold a seeds.jsonl with starter rows for the task type
//   generate           expand seeds via rule-based mutation (5 strategies)
//   list               list ~/.kolm/seeds files with provenance summary
//   bootstrap          install a public-domain starter dataset shipped with kolm
//
// Provenance: every emitted row gets {"source": "templated|seed|public|local-llm",
// "from_seed": <index>}. The train loop reads these and reports K-score per source.

// Seed templates per task type. These are STARTER rows for the user to replace
// with their own real examples. They are intentionally small (3-5 per template)
// because the point is to teach the format and unblock the user, not to generate
// training data from thin air.
const SEED_TEMPLATES = {
  // phi-redactor seeds align with the redactor spec template's output shape
  // ({redacted, hits}). matches() does subset-equal on objects, so expected =
  // {redacted: "..."} passes regardless of the hits array. Three rows pass the
  // starter recipe (date/phone/email/SSN_LIKE patterns shipped); two fail (name
  // and address have no default pattern) so the user immediately sees what to
  // extend. K-score reflects this honestly: ~0.6 on first build, climbing as
  // the user adds patterns to recipes[0].source for the cases they care about.
  'phi-redactor': [
    { input: 'follow-up scheduled 2024-03-12.', output: { redacted: 'follow-up scheduled [DATE].' }, tags: ['date'] },
    { input: 'contact 555-123-4567 or jsmith@example.com', output: { redacted: 'contact [PHONE] or [EMAIL]' }, tags: ['phone', 'email'] },
    { input: 'SSN 555-44-3333 was flagged.', output: { redacted: 'SSN [SSN] was flagged.' }, tags: ['ssn'] },
    { input: 'patient John Doe visited the clinic.', output: { redacted: 'patient [NAME] visited the clinic.' }, tags: ['name'] },
    { input: 'address: 1234 Oak Street, Springfield, IL 62701', output: { redacted: 'address: [ADDRESS]' }, tags: ['address'] },
  ],
  // ticket-classifier seeds match the classifier recipe's {label, score, scores}
  // shape via subset-equal on {label}. Default pack has 'billing' and 'bug';
  // the other 3 are categories the user adds at run time via
  // params.extra_categories. First-build K reflects the user's pack gap honestly.
  'ticket-classifier': [
    { input: 'invoice from last month shows the wrong amount, please refund.', output: { label: 'billing' }, tags: ['billing'] },
    { input: 'when i click export the page just crashes with a 500 error.', output: { label: 'bug' }, tags: ['bug'] },
    { input: 'my password reset email never arrived. been waiting 20 minutes.', output: { label: 'auth' }, tags: ['auth'] },
    { input: 'would love to see dark mode in the dashboard.', output: { label: 'feature_request' }, tags: ['feature_request'] },
    { input: 'how do i add a teammate to my workspace?', output: { label: 'how_to' }, tags: ['how_to'] },
  ],
  // invoice-extractor seeds match the extractor recipe's {fields, raw} shape via
  // subset-equal on {fields}. Default pack rule is iso_date only; the recipe
  // returns null for fields it can't parse. Seeds with iso dates pass; the one
  // with US-format dates fails to teach the user to add a date_us rule.
  'invoice-extractor': [
    { input: 'Invoice from Acme Corp, dated 2024-03-15, total $1,234.56', output: { fields: { iso_date: '2024-03-15' } }, tags: ['iso_date'] },
    { input: 'INV-7821: Initech, $4,500.00, billed 2023-12-30.', output: { fields: { iso_date: '2023-12-30' } }, tags: ['iso_date'] },
    { input: 'Soylent Industries invoice 2024-05-01 for 250.00', output: { fields: { iso_date: '2024-05-01' } }, tags: ['iso_date'] },
    { input: 'Bill: Globex LLC, amount due 99.00 USD, invoice date 04/02/2024', output: { fields: { iso_date: '2024-04-02' } }, tags: ['date_us'] },
    { input: 'Hooli, total: 12345.67, date: 2024-02-09, vendor: Hooli Inc.', output: { fields: { iso_date: '2024-02-09', vendor: 'Hooli Inc.' } }, tags: ['iso_date', 'vendor'] },
  ],
  'generic': [
    { input: 'sample input one. replace with your real example.', output: 'sample expected output one.', tags: ['placeholder'] },
    { input: 'sample input two. replace with your real example.', output: 'sample expected output two.', tags: ['placeholder'] },
    { input: 'sample input three. replace with your real example.', output: 'sample expected output three.', tags: ['placeholder'] },
  ],
};

// 100-name dictionary used by the redact-pii-templated strategy. Names are
// common English first+last combos. Shipped on disk so it works airgapped.
const NAME_DICT = [
  'Alex Carter', 'Bailey Brown', 'Casey Clark', 'Drew Davis', 'Evan Edwards',
  'Frankie Fisher', 'Gray Garcia', 'Harper Hall', 'Indigo Ingram', 'Jordan Johnson',
  'Kai King', 'Logan Lewis', 'Morgan Martin', 'Nico Nguyen', 'Oakley Owens',
  'Parker Parker', 'Quinn Quincy', 'Reese Roberts', 'Sage Sanchez', 'Taylor Turner',
  'Uri Underwood', 'Val Vance', 'Wren Walker', 'Xan Xu', 'Yael Young',
  'Zion Zimmerman', 'Avery Adams', 'Blair Bailey', 'Cameron Cook', 'Dakota Diaz',
  'Eli Ellis', 'Finley Fox', 'Greer Gray', 'Hayden Hayes', 'Iris Irwin',
  'Jules Jenkins', 'Kit Kelly', 'Lane Long', 'Micah Mills', 'Noor Nash',
  'Ollie Ortiz', 'Phoenix Patel', 'Quinn Quintero', 'River Reed', 'Sky Stone',
  'Toni Tate', 'Uma Ueda', 'Vince Vargas', 'Wade Webb', 'Xen Xiong',
  'Yuki Yamada', 'Zane Zhou', 'Ari Atkins', 'Bowie Burns', 'Cleo Coleman',
  'Devon Doyle', 'Emery Eaton', 'Fern Flores', 'Gus Gonzalez', 'Holly Holmes',
  'Ivy Ito', 'Jess Jacobs', 'Kim Kane', 'Lou Lambert', 'Max Moore',
  'Niko Newton', 'Owen Oden', 'Pat Park', 'Quill Quan', 'Ren Reyes',
  'Sam Sutton', 'Theo Thomas', 'Ula Usman', 'Vera Vega', 'Wes Wood',
  'Xena Xu', 'Yves Yates', 'Zola Zane', 'Ash Anderson', 'Beau Bishop',
  'Cody Costa', 'Dani Drake', 'Echo Estes', 'Felix Frazier', 'Gemma Greene',
  'Henley Hu', 'Imani Isaac', 'Jay Joyce', 'Kris Khan', 'Leo Lin',
  'Mira Mahmoud', 'Nat Norris', 'Onyx Ortega', 'Piper Pena', 'Rae Rivera',
  'Sloan Singh', 'Tess Toledo', 'Umi Ueno', 'Vega Vu', 'Wilder Wright',
];

// Synonym dictionary used by classify-mutate. Small, hand-built. Words that
// don't have entries here are left alone.
const SYNONYMS = {
  'wait': ['hang', 'sit', 'idle'],
  'waiting': ['hanging', 'sitting', 'idling'],
  'minutes': ['mins', 'minutes'],
  'never': ['still has not', 'has not'],
  'arrived': ['shown up', 'come through'],
  'reset': ['reissue', 'reissuing'],
  'wrong': ['incorrect', 'off'],
  'amount': ['total', 'figure'],
  'refund': ['credit', 'return the funds for'],
  'click': ['tap', 'press'],
  'spins': ['hangs', 'loads forever'],
  'forever': ['indefinitely', 'and never finishes'],
  'love': ['like', 'appreciate'],
  'see': ['get', 'have'],
  'add': ['invite', 'bring on'],
  'teammate': ['colleague', 'collaborator'],
  'workspace': ['org', 'team'],
};

// Mulberry32 PRNG. Deterministic, 32-bit state. Same seed -> same sequence.
function seededRng(seed) {
  let t = (seed | 0) || 1;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function rngInt(rng, lo, hi) {
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}
function rngPick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// Validate that a URL points at the local machine. Refuses anything else.
// Accepted hosts: localhost, 127.0.0.1, ::1. Anything else throws.
function validateLocalhost(urlStr) {
  let u;
  try { u = new URL(urlStr); }
  catch (e) {
    const err = new Error(`invalid url for --local-llm-url: ${urlStr}`);
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const host = (u.hostname || '').toLowerCase();
  const ok = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!ok) {
    const err = new Error(`refused: --local-llm-url must be localhost (got "${host}"). kolm seeds never leaks data to a third-party endpoint.`);
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  return u;
}

// Read a jsonl file. Tolerates blank lines and `//` comment lines (the header
// note line in bootstrap datasets). Throws on parse error with line context.
function loadSeeds(filePath) {
  if (!fs.existsSync(filePath)) {
    const err = new Error(`seeds file not found: ${filePath}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    if (ln.startsWith('//') || ln.startsWith('#')) continue;
    try {
      const row = JSON.parse(ln);
      if (row && typeof row === 'object') out.push(row);
    } catch (e) {
      const err = new Error(`seeds parse error at line ${i + 1}: ${e.message}`);
      err.exitCode = EXIT.BAD_ARGS;
      throw err;
    }
  }
  return out;
}

// Write rows to a jsonl file. Creates parent dirs as needed.
function writeJsonl(rows, outPath) {
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const body = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(outPath, body);
  return body.length;
}

// Identifier permutation. Given an identifier kind, return a new one that
// looks like a valid-shape example but uses ranges reserved for testing
// (so we don't accidentally generate a real person's number).
function permuteIdentifier(rng, kind) {
  if (kind === 'mrn') {
    return String(rngInt(rng, 1000000, 9999999));
  }
  if (kind === 'ssn') {
    // Use 9xx area numbers which are reserved (not issued) per SSA.
    return `9${rngInt(rng, 10, 99)}-${rngInt(rng, 10, 99)}-${rngInt(rng, 1000, 9999)}`;
  }
  if (kind === 'phone') {
    // Use 555 prefix (Hollywood-style, reserved for fiction).
    return `555-${rngInt(rng, 100, 999)}-${rngInt(rng, 1000, 9999)}`;
  }
  if (kind === 'email') {
    const handles = ['alex', 'bailey', 'casey', 'drew', 'evan'];
    return `${rngPick(rng, handles)}@example.com`;
  }
  if (kind === 'date') {
    const yr = rngInt(rng, 2020, 2025);
    const mo = String(rngInt(rng, 1, 12)).padStart(2, '0');
    const da = String(rngInt(rng, 1, 28)).padStart(2, '0');
    const formats = [
      `${yr}-${mo}-${da}`,
      `${mo}/${da}/${yr}`,
      `${da} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo, 10) - 1]} ${yr}`,
      `${yr}/${mo}/${da}`,
      `${mo}-${da}-${yr}`,
    ];
    return rngPick(rng, formats);
  }
  if (kind === 'name') {
    return rngPick(rng, NAME_DICT);
  }
  return null;
}

// Templated mutation. Generic. Rotates punctuation, casing, and minor
// connectives. Never invents semantic content. The output is just a stylistic
// variation of the input row used to test the model for robustness, not to
// ground-truth a new fact.
function mutateText(text, rng) {
  if (typeof text !== 'string') return text;
  const ops = [
    s => s,
    s => s.replace(/\s+/g, ' ').trim(),
    s => s.endsWith('.') ? s : s + '.',
    s => s.charAt(0).toUpperCase() + s.slice(1),
    s => s.replace(/\.$/, ''),
    s => s.toLowerCase(),
    s => s.replace(/,\s*/g, ', '),
    s => s.replace(/\s+--\s+/g, ', '),
    s => s.replace(/\bplease\b/gi, ''),
    s => s.replace(/\bjust\b/gi, ''),
  ];
  // Apply 1-3 ops chosen by rng.
  const n = rngInt(rng, 1, 3);
  let out = text;
  for (let i = 0; i < n; i++) out = rngPick(rng, ops)(out);
  return out.replace(/\s+/g, ' ').trim();
}

// PII-aware mutation. Walks the input/output text replacing numeric-shaped
// identifiers with permutations and names with dictionary picks. Only touches
// patterns that look like the identifier; everything else is left alone.
function mutatePIIRow(seed, rng) {
  let input = String(seed.input || '');
  let output = String(seed.output || '');
  // Permute MRN: a 7-digit number after "MRN".
  input = input.replace(/MRN\s+\d+/gi, (m) => `MRN ${permuteIdentifier(rng, 'mrn')}`);
  // SSN.
  input = input.replace(/\bSSN\s+\d{3}-\d{2}-\d{4}/gi, () => `SSN ${permuteIdentifier(rng, 'ssn')}`);
  input = input.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => permuteIdentifier(rng, 'ssn'));
  // Phone (10-digit dashed).
  input = input.replace(/\b\d{3}-\d{3}-\d{4}\b/g, () => permuteIdentifier(rng, 'phone'));
  // Email.
  input = input.replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, () => permuteIdentifier(rng, 'email'));
  // Dates in yyyy-mm-dd form.
  input = input.replace(/\b\d{4}-\d{2}-\d{2}\b/g, () => permuteIdentifier(rng, 'date'));
  // Names: any capital-then-capital "Firstname Lastname" near "patient" or "contact".
  input = input.replace(/(patient|contact|Mr\.|Ms\.|Mrs\.|Dr\.)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/g,
    (m, prefix) => `${prefix} ${permuteIdentifier(rng, 'name')}`);
  return { input: mutateText(input, rng), output: mutateText(output, rng) };
}

// Classifier mutation. Swaps synonyms in the input. Output (the class label)
// is preserved verbatim. Optionally splices a sentence order if input has
// two sentences.
function mutateClassifyRow(seed, rng) {
  let input = String(seed.input || '');
  // Synonym pass.
  input = input.replace(/\b([a-z]+)\b/gi, (w) => {
    const key = w.toLowerCase();
    const opts = SYNONYMS[key];
    if (!opts || opts.length === 0) return w;
    if (rng() < 0.4) return rngPick(rng, opts);
    return w;
  });
  // Sentence order swap (if 2 sentences).
  if (rng() < 0.3) {
    const parts = input.split(/(?<=\.)\s+/);
    if (parts.length === 2) input = `${parts[1]} ${parts[0]}`;
  }
  // Case variation.
  if (rng() < 0.2) input = input.toLowerCase();
  return { input: mutateText(input, rng), output: String(seed.output || '') };
}

// Extractor mutation. The input is permuted (field order, format), the output
// (a JSON object) is preserved with the same fields but optionally re-ordered.
function mutateExtractRow(seed, rng) {
  let input = String(seed.input || '');
  let output = String(seed.output || '');
  // Swap "amount: X, date: Y" -> "date: Y, amount: X" etc.
  const segs = input.split(',').map(s => s.trim()).filter(Boolean);
  if (segs.length >= 2 && rng() < 0.5) {
    // Shuffle by a single-swap (deterministic per rng draw).
    const i = rngInt(rng, 0, segs.length - 1);
    const j = rngInt(rng, 0, segs.length - 1);
    if (i !== j) { const t = segs[i]; segs[i] = segs[j]; segs[j] = t; }
    input = segs.join(', ');
  }
  // Re-order JSON output keys deterministically (if it's a JSON object).
  try {
    const obj = JSON.parse(output);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const keys = Object.keys(obj);
      // Single rng-driven rotation.
      const rot = rngInt(rng, 0, keys.length - 1);
      const rotated = keys.slice(rot).concat(keys.slice(0, rot));
      const reord = {};
      for (const k of rotated) reord[k] = obj[k];
      output = JSON.stringify(reord);
    }
  } catch (e) { /* output wasn't JSON, leave it */ }
  return { input: mutateText(input, rng), output };
}

// Local-LLM strategy. Optional, opt-in. Only ever called against a localhost
// endpoint (validated). Builds a deterministic prompt, posts to the endpoint,
// reads the response, attaches provenance. If the endpoint isn't reachable,
// throws a useful hint instead of silently falling back.
async function mutateViaLocalLlm(seed, rng, opts) {
  const u = opts.urlObj;
  const body = JSON.stringify({
    model: opts.model,
    prompt: `Paraphrase the following input/output pair, keeping the output's structure and semantics identical. Reply with JSON only: {"input": "...", "output": "..."}\n\nINPUT: ${seed.input}\nOUTPUT: ${seed.output}`,
    stream: false,
    options: { seed: rngInt(rng, 1, 1 << 30) },
  });
  return await new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname,
      port: u.port || 11434,
      path: '/api/generate',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        try {
          const env = JSON.parse(chunks);
          const text = (env && env.response) || '';
          // Try to extract a {"input":..."output":...} JSON object.
          const m = text.match(/\{[\s\S]*\}/);
          if (m) {
            const obj = JSON.parse(m[0]);
            if (obj && typeof obj.input === 'string' && typeof obj.output === 'string') {
              resolve({ input: obj.input, output: obj.output });
              return;
            }
          }
          // Fallback: keep the seed but mark provenance honestly.
          resolve({ input: String(seed.input), output: String(seed.output) });
        } catch (e) {
          reject(new Error(`local-llm parse error: ${e.message}`));
        }
      });
    });
    req.on('error', (e) => reject(new Error(`local-llm endpoint unreachable at ${u.origin}: ${e.message}. is it running? try: ollama serve`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('local-llm endpoint timed out after 30s')); });
    req.write(body);
    req.end();
  });
}

// Spec-template names (used by `kolm new --from <name>`) -> canonical seed
// template name. Lets `kolm seeds new redactor` resolve to phi-redactor without
// the user having to know the internal naming. This makes the `kolm new ... `
// next-steps hint line up with what actually works.
const SEED_TEMPLATE_ALIASES = {
  redactor: 'phi-redactor',
  redact: 'phi-redactor',
  pii: 'phi-redactor',
  phi: 'phi-redactor',
  classifier: 'ticket-classifier',
  classify: 'ticket-classifier',
  ticket: 'ticket-classifier',
  triage: 'ticket-classifier',
  extractor: 'invoice-extractor',
  extract: 'invoice-extractor',
  invoice: 'invoice-extractor',
  summarizer: 'generic',
  summarize: 'generic',
  blank: 'generic',
};

// `kolm seeds new <name>`
async function cmdSeedsNew(args) {
  const positional = args.find(a => !a.startsWith('--'));
  if (!positional) {
    const err = new Error('kolm seeds new <name>  (one of: ' + Object.keys(SEED_TEMPLATES).join(', ') + ')');
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const rawName = String(positional).toLowerCase();
  const name = SEED_TEMPLATE_ALIASES[rawName] || rawName;
  const tmpl = SEED_TEMPLATES[name];
  if (!tmpl) {
    const valid = Object.keys(SEED_TEMPLATES).concat(Object.keys(SEED_TEMPLATE_ALIASES));
    const err = new Error(`unknown template "${rawName}". choose: ${Object.keys(SEED_TEMPLATES).join(', ')} (or aliases: ${Object.keys(SEED_TEMPLATE_ALIASES).join(', ')})`);
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  if (name !== rawName) {
    console.error(`(alias: ${rawName} -> ${name})`);
  }
  const outFlag = pickFlag(args, '--out');
  const outPath = outFlag
    ? path.resolve(process.cwd(), outFlag)
    : path.resolve(process.cwd(), 'seeds.jsonl');
  const force = args.includes('--force');
  if (fs.existsSync(outPath) && !force) {
    const err = new Error(`refuses to overwrite ${outPath}. pass --force or pick --out <path>.`);
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  // Add provenance: source=seed-template (these are placeholders, not real data).
  const rows = tmpl.map((r, i) => Object.assign({}, r, { source: 'seed-template', from_seed: i }));
  writeJsonl(rows, outPath);
  console.log(`wrote ${rows.length} starter rows to ${outPath}`);
  console.log('');
  // Auto-detect a matching spec in cwd so the next-step is copy-pasteable.
  let specHint = '<your-spec>.spec.json';
  let artHint = '<your-name>.kolm';
  try {
    const cwdFiles = fs.readdirSync(process.cwd()).filter(f => f.endsWith('.spec.json'));
    if (cwdFiles.length === 1) {
      specHint = cwdFiles[0];
      artHint = specHint.replace(/\.spec\.json$/, '.kolm');
    } else if (cwdFiles.length > 1) {
      // Prefer the one whose stem matches the seed template name.
      const stemMatch = cwdFiles.find(f => f.startsWith(name) || f.startsWith(rawName));
      if (stemMatch) {
        specHint = stemMatch;
        artHint = stemMatch.replace(/\.spec\.json$/, '.kolm');
      }
    }
  } catch {}
  console.log('next:');
  console.log(`  1. edit ${path.basename(outPath)} - replace placeholders with YOUR real examples (>= 5 recommended)`);
  console.log(`  2. compile: kolm compile --spec ${specHint} --examples ${path.basename(outPath)} --out ${artHint}`);
  console.log(`  3. verify:  kolm verify ${artHint}`);
  console.log(`  4. (more)   kolm seeds generate --from ${path.basename(outPath)} --count 200   # expand via deterministic mutation`);
  console.log('');
  console.log('honesty: these starter rows are PLACEHOLDERS, not training data.');
  console.log('         replace them with examples you actually want the model to learn from.');
  console.log('         K-score against placeholders means nothing; K-score against your real');
  console.log('         examples is the only number that should drive ship/no-ship decisions.');
}

// `kolm seeds generate --from <file> --count N [--strategy s] [--seed-rng N] [--out p]`
async function cmdSeedsGenerate(args) {
  const fromFlag = pickFlag(args, '--from');
  if (!fromFlag) {
    const err = new Error('kolm seeds generate --from <file.jsonl> --count <N> [--strategy <name>] [--seed-rng <int>] [--out <path>]');
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const countFlag = pickFlag(args, '--count') || pickFlag(args, '-n');
  const count = parseInt(countFlag, 10);
  if (!Number.isFinite(count) || count <= 0) {
    const err = new Error('--count <N> required and must be a positive integer.');
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const strategy = pickFlag(args, '--strategy') || 'templated';
  const validStrategies = ['templated', 'redact-pii-templated', 'classify-mutate', 'extract-permute', 'local-llm'];
  if (validStrategies.indexOf(strategy) < 0) {
    const err = new Error(`unknown --strategy "${strategy}". choose: ${validStrategies.join(', ')}`);
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const seedRng = parseInt(pickFlag(args, '--seed-rng'), 10);
  const rngSeed = Number.isFinite(seedRng) ? seedRng : 1;
  const jsonOut = args.includes('--json');
  const skipPrompt = args.includes('--yes') || args.includes('-y') || !process.stdin.isTTY;

  const seeds = loadSeeds(path.resolve(process.cwd(), fromFlag));
  if (seeds.length === 0) {
    const err = new Error(`no seed rows found in ${fromFlag}. expected one JSON object per line.`);
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  if (count < seeds.length) {
    const err = new Error(`--count ${count} is less than ${seeds.length} input seeds. we never drop seeds; bump --count or trim --from.`);
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }

  // Local-llm setup.
  let llmOpts = null;
  if (strategy === 'local-llm') {
    const urlFlag = pickFlag(args, '--local-llm-url') || 'http://localhost:11434';
    const modelFlag = pickFlag(args, '--local-llm-model') || 'llama3.2:3b';
    const urlObj = validateLocalhost(urlFlag);
    if (!skipPrompt) {
      console.log('');
      console.log(`local-llm strategy will POST your seeds to ${urlObj.origin} (model: ${modelFlag}).`);
      console.log('No data leaves your machine if and only if that endpoint runs locally.');
      console.log('This is the only network call kolm seeds will ever make, and only to localhost.');
      console.log('');
      const ans = (await prompt('Proceed? [y/N] ')).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log('aborted. nothing was sent.');
        return;
      }
    }
    llmOpts = { urlObj, model: modelFlag };
  }

  const outFlag = pickFlag(args, '--out');
  const seedsDir = path.join(KOLM_DIR, 'seeds');
  if (!fs.existsSync(seedsDir)) fs.mkdirSync(seedsDir, { recursive: true });
  const ts = `${Date.now().toString(36)}-${rngSeed}`;
  const outPath = outFlag ? path.resolve(process.cwd(), outFlag) : path.join(seedsDir, `expanded-${ts}.jsonl`);

  const rng = seededRng(rngSeed);
  const out = [];
  // Pass 1: emit every user seed verbatim with provenance source=seed.
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i];
    out.push({
      input: String(s.input != null ? s.input : ''),
      output: String(s.output != null ? s.output : ''),
      source: 'seed',
      from_seed: i,
    });
  }
  // Pass 2: produce (count - seeds.length) mutated rows.
  const toGenerate = count - seeds.length;
  for (let i = 0; i < toGenerate; i++) {
    const idx = i % seeds.length;
    const seed = seeds[idx];
    let mut;
    if (strategy === 'templated') {
      mut = { input: mutateText(String(seed.input || ''), rng), output: mutateText(String(seed.output || ''), rng) };
    } else if (strategy === 'redact-pii-templated') {
      mut = mutatePIIRow(seed, rng);
    } else if (strategy === 'classify-mutate') {
      mut = mutateClassifyRow(seed, rng);
    } else if (strategy === 'extract-permute') {
      mut = mutateExtractRow(seed, rng);
    } else if (strategy === 'local-llm') {
      try {
        mut = await mutateViaLocalLlm(seed, rng, llmOpts);
      } catch (e) {
        console.error(`error: ${e.message}`);
        const err = new Error('local-llm strategy failed. nothing was written.');
        err.exitCode = EXIT.EXECUTION;
        throw err;
      }
    }
    out.push({
      input: mut.input,
      output: mut.output,
      source: strategy === 'local-llm' ? 'local-llm' : 'templated',
      from_seed: idx,
    });
  }

  const bytes = writeJsonl(out, outPath);
  const seedCount = seeds.length;
  const mutCount = out.length - seedCount;
  if (jsonOut) {
    console.log(JSON.stringify({
      out: outPath,
      bytes: bytes,
      total: out.length,
      seeds: seedCount,
      mutated: mutCount,
      hallucinated: 0,
      strategy: strategy,
      seed_rng: rngSeed,
      provenance: 'every row has source + from_seed',
      deterministic: true,
    }));
    return;
  }
  console.log(`generating ${count} rows from ${seedCount} seeds using strategy '${strategy}'...`);
  console.log(`  written: ${outPath} (${Math.round(bytes / 1024)}KB)`);
  console.log(`  composition: ${seedCount} user seeds + ${mutCount} ${strategy === 'local-llm' ? 'local-llm' : 'templated'} mutations + 0 hallucinated`);
  console.log(`  provenance tags written: yes (every row has source + from_seed)`);
  console.log(`  determinism: --seed-rng ${rngSeed} (reproducible)`);
  console.log('');
  console.log('honest reporting: when you train with this file, K-score reports will');
  console.log("distinguish 'K on user seeds' vs 'K on " + (strategy === 'local-llm' ? 'local-llm' : 'templated') + " rows'. Templated rows");
  console.log('test for robustness, not ground truth.');
}

// `kolm seeds list`
async function cmdSeedsList(args) {
  const jsonOut = args.includes('--json');
  const seedsDir = path.join(KOLM_DIR, 'seeds');
  if (!fs.existsSync(seedsDir)) {
    if (jsonOut) { console.log(JSON.stringify({ dir: seedsDir, files: [] })); return; }
    console.log(`no seeds yet. dir does not exist: ${seedsDir}`);
    console.log('try: kolm seeds new <name>');
    return;
  }
  const entries = fs.readdirSync(seedsDir).filter(n => n.endsWith('.jsonl'));
  if (entries.length === 0) {
    if (jsonOut) { console.log(JSON.stringify({ dir: seedsDir, files: [] })); return; }
    console.log(`no seeds files in ${seedsDir}`);
    console.log('try: kolm seeds new <name>');
    return;
  }
  const summaries = [];
  for (const name of entries) {
    const p = path.join(seedsDir, name);
    let rows = 0;
    const counts = { seed: 0, templated: 0, 'local-llm': 0, public: 0, 'seed-template': 0, other: 0 };
    try {
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
      for (const ln of lines) {
        const t = ln.trim();
        if (!t || t.startsWith('//') || t.startsWith('#')) continue;
        rows++;
        try {
          const r = JSON.parse(t);
          const src = String(r && r.source || 'other');
          if (counts[src] !== undefined) counts[src]++; else counts.other++;
        } catch (e) { counts.other++; }
      }
    } catch (e) { /* skip */ }
    const stat = fs.statSync(p);
    summaries.push({ name, path: p, rows, size_bytes: stat.size, mtime: stat.mtime.toISOString(), counts });
  }
  if (jsonOut) {
    for (const s of summaries) console.log(JSON.stringify(s));
    return;
  }
  console.log(`seeds in ${seedsDir}:`);
  console.log('');
  for (const s of summaries) {
    const mix = Object.entries(s.counts).filter(([k, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`  ${s.name}  ${s.rows} rows  ${Math.round(s.size_bytes / 1024)}KB  [${mix || 'unknown'}]`);
  }
  console.log('');
  console.log(`total: ${summaries.length} file${summaries.length === 1 ? '' : 's'}.`);
}

// Public-domain dataset registry. Files live in <install-dir>/data/public-seeds.
// Only phi-redactor is shipped today; the others are placeholders.
const PUBLIC_SEEDS = {
  'phi-redactor':     { file: 'phi-redactor.jsonl',     ships: true,  rows_hint: 10, note: 'synthetic, public domain, illustrative only' },
  'email-classifier': { file: 'email-classifier.jsonl', ships: false, rows_hint: 50, note: 'coming-in-v11.30' },
  'invoice-fields':   { file: 'invoice-fields.jsonl',   ships: false, rows_hint: 15, note: 'coming-in-v11.30' },
};

function findPublicSeedsDir() {
  // We look in two places:
  //   1. the kolm install dir (../data/public-seeds relative to this file)
  //   2. the current working directory's ./data/public-seeds (dev path)
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
  const candidates = [
    path.resolve(here, '..', 'data', 'public-seeds'),
    path.resolve(process.cwd(), 'data', 'public-seeds'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// `kolm seeds bootstrap --task <name>`
async function cmdSeedsBootstrap(args) {
  const taskFlag = pickFlag(args, '--task') || pickFlag(args, '-t');
  if (!taskFlag) {
    const err = new Error('kolm seeds bootstrap --task <name>  (one of: ' + Object.keys(PUBLIC_SEEDS).join(', ') + ')');
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const meta = PUBLIC_SEEDS[taskFlag];
  if (!meta) {
    const err = new Error(`unknown --task "${taskFlag}". choose: ${Object.keys(PUBLIC_SEEDS).join(', ')}`);
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  if (!meta.ships) {
    const err = new Error(`task "${taskFlag}" is not yet shipped (${meta.note}). available: ${Object.entries(PUBLIC_SEEDS).filter(([k, v]) => v.ships).map(([k]) => k).join(', ')}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  const dir = findPublicSeedsDir();
  if (!dir) {
    const err = new Error('could not locate data/public-seeds. is kolm installed correctly?');
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  const src = path.join(dir, meta.file);
  if (!fs.existsSync(src)) {
    const err = new Error(`public dataset file missing: ${src}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  const outFlag = pickFlag(args, '--out');
  const seedsDir = path.join(KOLM_DIR, 'seeds');
  if (!fs.existsSync(seedsDir)) fs.mkdirSync(seedsDir, { recursive: true });
  const outPath = outFlag ? path.resolve(process.cwd(), outFlag) : path.join(seedsDir, meta.file);
  // Read, tag with provenance source=public, write to outPath.
  const raw = fs.readFileSync(src, 'utf8').split(/\r?\n/);
  const rows = [];
  let comments = [];
  for (let i = 0; i < raw.length; i++) {
    const ln = raw[i].trim();
    if (!ln) continue;
    if (ln.startsWith('//') || ln.startsWith('#')) { comments.push(ln); continue; }
    try {
      const r = JSON.parse(ln);
      if (r && typeof r === 'object') {
        rows.push(Object.assign({}, r, { source: 'public', from_seed: i }));
      }
    } catch (e) { /* skip */ }
  }
  // Preserve the leading comment header in the copied file so the user can
  // see the public-domain note.
  const body = comments.concat(rows.map(r => JSON.stringify(r))).join('\n') + '\n';
  fs.writeFileSync(outPath, body);

  console.log(`bootstrapped public seed dataset: ${taskFlag}`);
  console.log(`  source: ${src}`);
  console.log(`  copied to: ${outPath} (${rows.length} rows)`);
  console.log(`  note: ${meta.note}`);
  console.log('');
  console.log('these are PUBLIC SEED DATASETS, not synthetic K-score.');
  console.log('use them to bootstrap your model, then add your own real examples for higher K-score.');
  console.log('');
  console.log('next:');
  console.log(`  kolm seeds generate --from ${path.relative(process.cwd(), outPath)} --count 200 --strategy redact-pii-templated`);
}

// `kolm anonymize <file>` - rule-based PII redaction. Default is 1:1 (N input
// rows -> N output rows with PII permuted, no expansion). Use --expand to opt
// in to the multi-row mutation behavior (was the old default; renamed to make
// the verb honest with its name).
async function cmdAnonymize(args) {
  if (maybeHelp('anonymize', args)) return;
  const positional = args.find(a => !a.startsWith('--'));
  if (!positional) {
    const err = new Error('kolm anonymize <file.jsonl> [--expand <N>] [--out <path>] [--seed-rng <int>]');
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const inputPath = path.resolve(process.cwd(), positional);
  if (!fs.existsSync(inputPath)) {
    const err = new Error(`anonymize input not found: ${inputPath}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  // CSV files are not supported. Reject early with an actionable hint.
  if (/\.csv$/i.test(inputPath)) {
    const err = new Error(`kolm anonymize reads JSONL, not CSV.\nconvert your CSV first (each row -> one JSON object on its own line):\n  awk -F, 'NR>1{printf "{\\"input\\":\\"%s\\",\\"output\\":\\"%s\\"}\\n",$1,$2}' ${path.basename(inputPath)} > seeds.jsonl`);
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  // --expand opts into the row-mutation mode that was the old default. Without
  // it we run 1:1 (each input row -> one output row, PII permuted).
  const expandArg = pickFlag(args, '--expand');
  const wantsExpand = args.includes('--expand') || (expandArg && expandArg.length > 0);
  // --count is the legacy spelling for --expand. Accept it but warn so users
  // migrate. If --count is passed without --expand, treat as expand mode.
  const countFlag = pickFlag(args, '--count') || pickFlag(args, '-n');
  if (countFlag && !wantsExpand) {
    console.error("note: --count <N> is the legacy spelling. use --expand <N> for explicit row-mutation mode.");
  }
  const seedRngFlag = pickFlag(args, '--seed-rng') || '1';
  const outFlag = pickFlag(args, '--out');
  const jsonOut = args.includes('--json');
  const inBase = path.basename(inputPath).replace(/\.jsonl?$/i, '');
  const defaultOut = path.resolve(process.cwd(), `${inBase}-anonymized.jsonl`);
  const outPath = outFlag ? path.resolve(process.cwd(), outFlag) : defaultOut;

  // 1:1 mode: read the file, permute PII in each row, write same count out.
  if (!wantsExpand && !countFlag) {
    const seeds = loadSeeds(inputPath);
    if (seeds.length === 0) {
      const err = new Error(`no rows found in ${path.basename(inputPath)}. expected one JSON object per line.`);
      err.exitCode = EXIT.BAD_ARGS;
      throw err;
    }
    const rngSeed = parseInt(seedRngFlag, 10) || 1;
    const rng = seededRng(rngSeed);
    const out = [];
    for (let i = 0; i < seeds.length; i++) {
      const permuted = mutatePIIRow(seeds[i], rng);
      out.push({
        input: permuted.input,
        output: permuted.output,
        source: 'redacted',
        from_seed: i,
      });
    }
    const bytes = writeJsonl(out, outPath);
    if (jsonOut) {
      console.log(JSON.stringify({
        out: outPath,
        bytes: bytes,
        total: out.length,
        input_rows: seeds.length,
        output_rows: out.length,
        mode: 'redact',
        seed_rng: rngSeed,
        deterministic: true,
      }));
      return;
    }
    console.log(`anonymized ${seeds.length} -> ${out.length} rows (1:1, no expansion).`);
    console.log(`  written: ${outPath} (${Math.round(bytes / 1024)}KB)`);
    console.log(`  PII permuted: names, emails, MRNs, SSNs, phones, dates, addresses.`);
    console.log(`  determinism: --seed-rng ${rngSeed} (reproducible)`);
    console.log(`  no network, no LLM, no third-party API.`);
    console.log('');
    console.log(`for row-mutation expansion (1 -> N synthetic variations), pass --expand <N>.`);
    return;
  }

  // --expand mode: dispatch to cmdSeedsGenerate with the locked PII strategy.
  // Determine target count: if --expand had a numeric value or --count was given.
  let targetCount = countFlag || expandArg;
  if (!targetCount || !/^\d+$/.test(String(targetCount))) targetCount = '50';
  const genArgs = [
    '--from', inputPath,
    '--count', String(targetCount),
    '--strategy', 'redact-pii-templated',
    '--seed-rng', String(seedRngFlag),
    '--out', outPath,
    '--yes',
  ];
  if (jsonOut) genArgs.push('--json');
  await cmdSeedsGenerate(genArgs);
  if (!jsonOut) {
    let total = 0;
    try {
      const lines = fs.readFileSync(outPath, 'utf8').split(/\r?\n/);
      for (const ln of lines) {
        const t = ln.trim();
        if (!t || t.startsWith('//') || t.startsWith('#')) continue;
        total++;
      }
    } catch (e) { /* keep total=0 if read fails */ }
    console.log('');
    console.log(`wrote ${total} rows (expand mode). all sources marked 'seed' or 'templated'.`);
  }
}

// `kolm seeds validate <file>` - shape + parseability check before compile.
// Reports row count, detected shape ({input,output} or {input,expected}), and
// any parse errors with line numbers. Catches the CSV-as-JSONL trap early.
async function cmdSeedsValidate(args) {
  const positional = args.find(a => !a.startsWith('--'));
  if (!positional) {
    const err = new Error('kolm seeds validate <file.jsonl> [--json]');
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const inputPath = path.resolve(process.cwd(), positional);
  const jsonOut = args.includes('--json');
  if (!fs.existsSync(inputPath)) {
    const err = new Error(`file not found: ${inputPath}`);
    err.exitCode = EXIT.NOT_FOUND;
    throw err;
  }
  if (/\.csv$/i.test(inputPath)) {
    const err = new Error(`kolm reads JSONL, not CSV.\nconvert your CSV first (each row -> one JSON object on its own line):\n  awk -F, 'NR>1{printf "{\\"input\\":\\"%s\\",\\"output\\":\\"%s\\"}\\n",$1,$2}' ${path.basename(inputPath)} > seeds.jsonl`);
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  const raw = fs.readFileSync(inputPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const errors = [];
  let rows = 0;
  let inputCount = 0;
  let outputCount = 0;
  let expectedCount = 0;
  let bothShapes = 0;
  const sampleErrors = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    if (ln.startsWith('//') || ln.startsWith('#')) continue;
    try {
      const row = JSON.parse(ln);
      if (!row || typeof row !== 'object') {
        if (sampleErrors.length < 5) sampleErrors.push({ line: i + 1, error: 'not a JSON object' });
        errors.push(i + 1);
        continue;
      }
      rows++;
      if ('input' in row) inputCount++;
      if ('output' in row) outputCount++;
      if ('expected' in row) expectedCount++;
      if ('output' in row && 'expected' in row) bothShapes++;
    } catch (e) {
      if (sampleErrors.length < 5) sampleErrors.push({ line: i + 1, error: e.message });
      errors.push(i + 1);
    }
  }
  // Determine the dominant shape so we can tell the user which one they have.
  let shape = 'unknown';
  if (rows > 0) {
    if (outputCount >= rows * 0.8 && expectedCount === 0) shape = '{input, output}';
    else if (expectedCount >= rows * 0.8 && outputCount === 0) shape = '{input, expected}';
    else if (outputCount > 0 && expectedCount > 0) shape = '{input, output|expected} mixed';
    else if (outputCount === 0 && expectedCount === 0) shape = 'no output|expected field';
    else shape = '{input, output}';
  }
  if (jsonOut) {
    console.log(JSON.stringify({
      file: inputPath,
      rows,
      shape,
      input_count: inputCount,
      output_count: outputCount,
      expected_count: expectedCount,
      mixed: bothShapes > 0,
      parse_errors: errors,
      ok: errors.length === 0 && rows > 0 && inputCount === rows,
    }, null, 2));
    return;
  }
  console.log(`validating ${path.relative(process.cwd(), inputPath) || inputPath}`);
  console.log('');
  console.log(`  rows:     ${rows}`);
  console.log(`  shape:    ${shape}`);
  console.log(`  errors:   ${errors.length}`);
  if (sampleErrors.length > 0) {
    console.log('');
    console.log('parse errors (first 5):');
    for (const e of sampleErrors) console.log(`  line ${e.line}: ${e.error}`);
  }
  console.log('');
  if (rows === 0) {
    console.log('not usable: 0 rows. expected one JSON object per line.');
    const err = new Error('no usable rows');
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  if (errors.length > 0) {
    console.log('not usable: some rows failed to parse. fix the lines above, or re-export.');
    const err = new Error(`${errors.length} parse errors`);
    err.exitCode = EXIT.BAD_ARGS;
    throw err;
  }
  if (inputCount < rows) {
    console.log(`warning: only ${inputCount}/${rows} rows have an "input" field. compile will skip the rest.`);
  }
  if (shape === 'no output|expected field') {
    console.log('warning: no "output" or "expected" field on any row. compile will treat all rows as ground-truth gaps.');
  }
  if (errors.length === 0 && rows > 0 && inputCount === rows) {
    console.log(`ok. ${rows} rows, shape ${shape}. ready to use:`);
    console.log(`  kolm compile --spec <name>.spec.json --examples ${path.relative(process.cwd(), inputPath) || inputPath}`);
  }
}

// `kolm seeds` dispatcher.
async function cmdSeeds(args) {
  const sub = args && args[0];
  const rest = (args || []).slice(1);
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(HELP.seeds);
    return;
  }
  if (sub === 'new')       return cmdSeedsNew(rest);
  if (sub === 'generate')  return cmdSeedsGenerate(rest);
  if (sub === 'list')      return cmdSeedsList(rest);
  if (sub === 'bootstrap') return cmdSeedsBootstrap(rest);
  if (sub === 'validate' || sub === 'check') return cmdSeedsValidate(rest);
  const err = new Error(`unknown subcommand: ${sub}\ntry: kolm seeds --help`);
  err.exitCode = EXIT.BAD_ARGS;
  throw err;
}

// ---------- update ----------
// `kolm update` self-installs the latest commit from the canonical github
// source. This is the verb that actually does it (kolm upgrade only checks).
// Honest path: spawn `npm i -g github:sneaky-hippo/kolmogorov-stack` and
// stream npm's stdout/stderr through to the user. Exit code is whatever npm
// returned. On Windows we shell through `cmd /c` so npm.cmd resolves.
async function cmdUpdate(args) {
    if (maybeHelp('update', args)) return;
    const jsonOut = args.includes('--json');
    const dryRun = args.includes('--dry-run');
    const source = 'github:sneaky-hippo/kolmogorov-stack';
    const before = readPackageVersion();

    if (dryRun) {
        if (jsonOut) {
            console.log(JSON.stringify({ source, current: before, dry_run: true }, null, 2));
        } else {
            console.log(`would run: npm i -g ${source}`);
            console.log(`current:   ${before}`);
        }
        return;
    }

    if (!jsonOut) {
        console.log(`updating kolm from ${source} ...`);
        console.log(`current:   ${before}`);
        console.log('');
    }

    const { spawnSync } = await import('node:child_process');
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd' : 'npm';
    const argv = isWin
        ? ['/c', 'npm', 'i', '-g', source]
        : ['i', '-g', source];
    const r = spawnSync(cmd, argv, { stdio: jsonOut ? 'pipe' : 'inherit', encoding: 'utf-8' });

    if (r.error) {
        const e = new Error(`could not invoke npm: ${r.error.message}`);
        e.exitCode = EXIT.NOT_FOUND;
        throw e;
    }
    if (r.status !== 0) {
        if (jsonOut) {
            console.log(JSON.stringify({ source, current: before, status: 'failed', exit_code: r.status, stderr: (r.stderr || '').slice(-2000) }, null, 2));
        } else {
            console.error('');
            console.error(`npm exited with code ${r.status}. update did not complete.`);
            console.error('common fixes:');
            console.error('  - ensure node 20+ and npm 10+ are on PATH');
            console.error('  - on macos/linux: try `sudo npm i -g github:sneaky-hippo/kolmogorov-stack`');
            console.error('  - on windows: run an admin PowerShell, then re-run `kolm update`');
        }
        const e = new Error(`npm install failed (exit ${r.status})`);
        e.exitCode = EXIT.UNKNOWN;
        throw e;
    }

    const after = readPackageVersion();
    if (jsonOut) {
        console.log(JSON.stringify({ source, before, after, status: before === after ? 'reinstalled' : 'updated' }, null, 2));
        return;
    }
    console.log('');
    if (before === after) {
        console.log(`kolm reinstalled at ${after} (already current).`);
    } else {
        console.log(`kolm updated: ${before} -> ${after}.`);
    }
    console.log('next: kolm version');
}

// ---------- export ----------
// `kolm export <artifact.kolm> --backend <gguf|mlx|executorch|tensorrt|coreml|onnx>
//                              [--out <dir>] [--quant <q4_k_m|q5_k_m|q8_0|f16>]
//                              [--base-model <hf-id>]`
//
// `kolm export <artifact.kolm> --preview --device <name> --quant <q>`
//   Computes the forecast (size_mb, tok/s, k_loss, fits, backend) in pure JS
//   using the same lookup table as /device-transfer. No python, no toolchain.
//
// Honest path (non-preview): spawn `python -m apps.export` with the user's
// Python (3.10+ on PATH). If python isn't there, or the backend's toolchain
// isn't installed, we surface the install hint from the backend module
// instead of pretending.

// Device-transfer lookup table. Keep in sync with the JS object on
// public/device-transfer.html (search: DEVICE_TRANSFER_TABLE).
const DEVICE_TRANSFER_TABLE = {
  BASES: {
    'llama-3.1-8b':  { label: 'Llama-3.1-8B',       params_b: 8.0, sizes_gb: { fp16: 16.0, int8: 8.0,  int4: 4.4,  int3: 3.3  }, fp16_k: 0.94 },
    'llama-3.2-3b':  { label: 'Llama-3.2-3B',       params_b: 3.2, sizes_gb: { fp16: 6.0,  int8: 3.0,  int4: 1.7,  int3: 1.3  }, fp16_k: 0.93 },
    'llama-3.2-1b':  { label: 'Llama-3.2-1B',       params_b: 1.2, sizes_gb: { fp16: 2.0,  int8: 1.0,  int4: 0.58, int3: 0.44 }, fp16_k: 0.90 },
    'phi-3-mini':    { label: 'Phi-3-mini-3.8B',    params_b: 3.8, sizes_gb: { fp16: 7.6,  int8: 3.8,  int4: 2.1,  int3: 1.6  }, fp16_k: 0.92 },
    'mistral-7b':    { label: 'Mistral-7B',         params_b: 7.2, sizes_gb: { fp16: 14.0, int8: 7.0,  int4: 3.9,  int3: 2.9  }, fp16_k: 0.93 },
  },
  K_LOSS: { fp16: 0.0, int8: -0.005, int4: -0.02, int3: -0.05 },
  QUANT_RATE_SCALE: { fp16: 0.30, int8: 0.55, int4: 1.0, int3: 1.15 },
  DEVICES: {
    'pi5-4':              { label: 'Raspberry Pi 5 (4GB)',           ram_gb: 4,  base_rate: 4,   typical_class: '3b', backend: 'gguf' },
    'pi5-8':              { label: 'Raspberry Pi 5 (8GB)',           ram_gb: 8,  base_rate: 4,   typical_class: '3b', backend: 'gguf' },
    'jetson-orin-nano':   { label: 'Jetson Orin Nano (8GB)',         ram_gb: 8,  base_rate: 12,  typical_class: '7b', backend: 'gguf' },
    'jetson-agx-32':      { label: 'Jetson AGX Orin (32GB)',         ram_gb: 32, base_rate: 32,  typical_class: '7b', backend: 'tensorrt' },
    'jetson-agx-64':      { label: 'Jetson AGX Orin (64GB)',         ram_gb: 64, base_rate: 35,  typical_class: '7b', backend: 'tensorrt' },
    'steam-deck':         { label: 'Steam Deck (16GB)',              ram_gb: 16, base_rate: 15,  typical_class: '7b', backend: 'gguf' },
    'm3-pro':             { label: 'M3 Pro MacBook Pro (18GB)',      ram_gb: 18, base_rate: 30,  typical_class: '7b', backend: 'mlx' },
    'm3-max':             { label: 'M3 Max MacBook Pro (36GB)',      ram_gb: 36, base_rate: 60,  typical_class: '7b', backend: 'mlx' },
    'snapdragon-x-elite': { label: 'Snapdragon X Elite laptop',      ram_gb: 32, base_rate: 40,  typical_class: '7b', backend: 'onnx' },
    'rtx-4090':           { label: 'NVIDIA RTX 4090 desktop',        ram_gb: 24, base_rate: 175, typical_class: '7b', backend: 'gguf' },
    'iphone-15-pro':      { label: 'iPhone 15 Pro (8GB)',            ram_gb: 8,  base_rate: 12,  typical_class: '3b', backend: 'coreml' },
    'pixel-8':            { label: 'Pixel 8 (8GB)',                  ram_gb: 8,  base_rate: 10,  typical_class: '3b', backend: 'onnx' },
  },
};

// Resolve a friendly device key from a free-form --device string. Accepts the
// internal key (e.g. 'm3-pro'), the label substring ('M3 Pro'), or a slugified
// form. Returns the canonical key or null.
function resolveDeviceKey(input) {
  if (!input) return null;
  const t = DEVICE_TRANSFER_TABLE.DEVICES;
  if (t[input]) return input;
  const norm = String(input).toLowerCase().trim();
  // Exact slug match.
  for (const k of Object.keys(t)) if (k.toLowerCase() === norm) return k;
  // Substring match against label or key.
  for (const k of Object.keys(t)) {
    if (k.toLowerCase().includes(norm)) return k;
    if (t[k].label.toLowerCase().includes(norm)) return k;
  }
  return null;
}

// Normalize a quant flag. Accepts fp16 / int8 / int4 / int3, plus the gguf
// aliases q4_k_m / q5_k_m / q8_0 / f16 (mapping to the nearest tier the
// forecast table understands).
function resolveQuantKey(input) {
  if (!input) return 'int4';
  const s = String(input).toLowerCase();
  if (s === 'fp16' || s === 'f16' || s === 'bf16' || s === 'f32') return 'fp16';
  if (s === 'int8' || s === 'q8_0') return 'int8';
  if (s === 'int4' || s === 'q4_k_m' || s === 'q5_k_m' || s === 'q4_0') return 'int4';
  if (s === 'int3' || s === 'q3_k_s' || s === 'q3_0') return 'int3';
  return null;
}

// Infer a base key from a .kolm manifest, best-effort. Returns null on miss.
function inferBaseFromManifest(artifactPath) {
  if (!artifactPath) return null;
  try {
    // Read just the manifest.json out of the zip without extracting all of it.
    // We use a tiny zip-central-directory walk via the existing util if
    // present; otherwise we shell out to `unzip -p`. Both are best-effort.
    const buf = fs.readFileSync(artifactPath);
    // Find "manifest.json" in the central directory. A .kolm is a zip;
    // the manifest is small. We do a string search for the bytes.
    const needle = Buffer.from('manifest.json');
    let idx = buf.indexOf(needle);
    if (idx < 0) return null;
    // Scan forward looking for the local file header signature 0x04034b50
    // before this filename. The local-header layout puts a small JSON blob
    // right after the filename when compression method is 0 (stored).
    // Easiest portable path: just regex out a "base":"..." string near
    // the first manifest.json filename hit. The manifest is small enough
    // that this is reliable for our writer.
    const slice = buf.slice(idx, Math.min(buf.length, idx + 8192)).toString('utf8');
    const m = slice.match(/"base"\s*:\s*"([^"]+)"/);
    if (!m) return null;
    const bs = m[1].toLowerCase();
    // Heuristic: map common HF ids to our base keys.
    if (bs.includes('llama-3.1-8b') || bs.includes('llama-3-8b')) return 'llama-3.1-8b';
    if (bs.includes('llama-3.2-3b') || bs.includes('llama-3-3b')) return 'llama-3.2-3b';
    if (bs.includes('llama-3.2-1b') || bs.includes('llama-3-1b')) return 'llama-3.2-1b';
    if (bs.includes('phi-3') || bs.includes('phi3')) return 'phi-3-mini';
    if (bs.includes('mistral-7b') || bs.includes('mistral_7b')) return 'mistral-7b';
    return null;
  } catch (e) {
    return null;
  }
}

// Compute the forecast. Mirrors the JS function on /device-transfer.
function computeExportPreview({ baseKey, quantKey, deviceKey }) {
  const T = DEVICE_TRANSFER_TABLE;
  const base = T.BASES[baseKey];
  const dev = T.DEVICES[deviceKey];
  if (!base) {
    const e = new Error(`unknown base: ${baseKey}. one of: ${Object.keys(T.BASES).join(', ')}`);
    e.exitCode = EXIT.BAD_ARGS;
    throw e;
  }
  if (!dev) {
    const e = new Error(`unknown device: ${deviceKey}. one of: ${Object.keys(T.DEVICES).join(', ')}`);
    e.exitCode = EXIT.BAD_ARGS;
    throw e;
  }
  const sizeGb = base.sizes_gb[quantKey];
  const kLoss = T.K_LOSS[quantKey];
  const kEst = Math.max(0, base.fp16_k + kLoss);
  const refParams = dev.typical_class === '3b' ? 3.2 : 7.2;
  const paramScale = refParams / base.params_b;
  let rate = dev.base_rate * T.QUANT_RATE_SCALE[quantKey] * paramScale;
  rate = Math.round(rate * 10) / 10;
  const needGb = sizeGb + 1.0;
  const fitPct = needGb / dev.ram_gb;
  let verdict = 'fit';
  if (fitPct > 1.0) verdict = 'over';
  else if (fitPct > 0.80) verdict = 'tight';
  const ms = rate > 0 ? Math.round(1000 / rate * 10) / 10 : null;
  return {
    device: dev.label,
    device_key: deviceKey,
    quant: quantKey,
    base: base.label,
    base_key: baseKey,
    size_gb: sizeGb,
    size_mb: Math.round(sizeGb * 1024),
    estimated_latency_ms: ms,
    tok_per_s: rate,
    k_score_fp16: base.fp16_k,
    k_loss: kLoss,
    k_score_est: Math.round(kEst * 1000) / 1000,
    fits: verdict !== 'over',
    fit_verdict: verdict,
    need_gb: Math.round(needGb * 10) / 10,
    device_ram_gb: dev.ram_gb,
    backend: dev.backend,
    note: 'forecast. estimates from public llama.cpp / MLX / CoreML benchmarks (2025). measure on your actual hardware before procurement.',
  };
}

async function cmdExport(args) {
  if (maybeHelp('export', args)) return;
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const isPreview = args.includes('--preview');
  const artifact = args.find(a => !a.startsWith('--'));

  // ---------- preview path: no toolchain, no artifact required ----------
  if (isPreview) {
    const quantKey = resolveQuantKey(get('--quant')) || 'int4';
    if (!resolveQuantKey(get('--quant') || 'int4')) {
      const e = new Error(`--quant invalid. one of: fp16 | int8 | int4 | int3 (gguf aliases: q4_k_m, q5_k_m, q8_0, f16, q3_k_s)`);
      e.exitCode = EXIT.BAD_ARGS;
      throw e;
    }
    const deviceArg = get('--device');
    if (!deviceArg) {
      const e = new Error('--device required for --preview. one of: ' + Object.keys(DEVICE_TRANSFER_TABLE.DEVICES).join(', '));
      e.exitCode = EXIT.BAD_ARGS;
      throw e;
    }
    const deviceKey = resolveDeviceKey(deviceArg);
    if (!deviceKey) {
      const e = new Error(`--device unknown: ${deviceArg}. one of: ${Object.keys(DEVICE_TRANSFER_TABLE.DEVICES).join(', ')}`);
      e.exitCode = EXIT.BAD_ARGS;
      throw e;
    }
    // Resolve base: explicit --base wins, else inferred from artifact, else default.
    let baseKey = get('--base') || null;
    if (!baseKey && artifact) {
      const ap = resolveArtifact(artifact);
      if (ap) baseKey = inferBaseFromManifest(ap);
    }
    if (!baseKey) baseKey = 'llama-3.2-3b';
    if (!DEVICE_TRANSFER_TABLE.BASES[baseKey]) {
      const e = new Error(`--base unknown: ${baseKey}. one of: ${Object.keys(DEVICE_TRANSFER_TABLE.BASES).join(', ')}`);
      e.exitCode = EXIT.BAD_ARGS;
      throw e;
    }
    const result = computeExportPreview({ baseKey, quantKey, deviceKey });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  // ---------- real export path ----------
  if (!artifact) {
    const e = new Error('usage: kolm export <artifact.kolm> --backend <name>  (or --preview --device <name> --quant <q>)');
    e.exitCode = EXIT.BAD_ARGS;
    throw e;
  }
  const backend = get('--backend');
  if (!backend) {
    const e = new Error('--backend required. one of: gguf | mlx | executorch | tensorrt | coreml | onnx');
    e.exitCode = EXIT.BAD_ARGS;
    throw e;
  }
  const out = get('--out') || path.join(process.cwd(), 'exports');
  const opts = {};
  if (get('--quant')) opts.quant = get('--quant');
  if (get('--base-model')) opts.base_model = get('--base-model');
  if (get('--opset')) opts.opset = Number(get('--opset'));
  if (args.includes('--quantize') || args.includes('--q4')) opts.quantize = true;

  const ap = resolveArtifact(artifact);
  if (!ap) {
    const e = new Error(`artifact not found: ${artifact}`);
    e.exitCode = EXIT.NOT_FOUND;
    throw e;
  }

  const py = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');
  const { spawnSync } = await import('node:child_process');
  const argsJson = JSON.stringify({ artifact: ap, backend, out, opts });
  const script = [
    'import json, sys, traceback',
    'from pathlib import Path',
    'from apps.export import get_exporter, ExportError, ExportNotApplicable',
    'import zipfile, tempfile, os',
    'cfg = json.loads(sys.stdin.read())',
    'art = cfg["artifact"]',
    'work = tempfile.mkdtemp(prefix="kolm-export-")',
    'with zipfile.ZipFile(art) as z: z.extractall(work)',
    'try:',
    '    runner = get_exporter(cfg["backend"])',
    '    result = runner(work, cfg["out"], **(cfg.get("opts") or {}))',
    '    print(json.dumps({"ok": True, "result": result}))',
    'except ExportNotApplicable as e:',
    '    print(json.dumps({"ok": False, "kind": "not-applicable", "error": str(e)}))',
    '    sys.exit(2)',
    'except ExportError as e:',
    '    print(json.dumps({"ok": False, "kind": "export-error", "error": str(e)}))',
    '    sys.exit(1)',
    'except Exception as e:',
    '    print(json.dumps({"ok": False, "kind": "unexpected", "error": str(e), "trace": traceback.format_exc()}))',
    '    sys.exit(1)',
  ].join('\n');

  const res = spawnSync(py, ['-c', script], { input: argsJson, encoding: 'utf8' });
  if (res.error) {
    const e = new Error(`failed to spawn python (${py}): ${res.error.message}\nset KOLM_PY to your python interpreter`);
    e.exitCode = EXIT.EXECUTION;
    throw e;
  }
  process.stderr.write(res.stderr || '');
  process.stdout.write((res.stdout || '') + (res.stdout && !res.stdout.endsWith('\n') ? '\n' : ''));
  if (res.status !== 0) {
    const e = new Error(`export failed (exit ${res.status})`);
    e.exitCode = EXIT.EXECUTION;
    throw e;
  }
}

// ---------- improve ----------
// `kolm improve <artifact|job-id> [--epsilon 0.01] [--dry-run]`
//
// Walks recent receipts + audit log for the artifact, finds high-uncertainty
// rows (teacher-fallback, low confidence), batches them, recompiles, and
// only swaps the artifact if new_K > old_K + epsilon.
async function cmdImprove(args) {
  if (maybeHelp('improve', args)) return;
  const id = args.find(a => !a.startsWith('--'));
  if (!id) {
    const e = new Error('usage: kolm improve <artifact-id> [--epsilon 0.01] [--dry-run]');
    e.exitCode = EXIT.BAD_ARGS;
    throw e;
  }
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const epsilon = Number(get('--epsilon')) || 0.01;
  const dryRun = args.includes('--dry-run');

  const base = process.env.KOLM_BASE_URL || 'https://kolm.ai';
  const token = process.env.KOLM_API_KEY || (function () {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).api_key || null; } catch { return null; }
  })();
  if (!token) {
    const e = new Error('kolm improve needs an API key. run `kolm login` first.');
    e.exitCode = EXIT.AUTH;
    throw e;
  }

  // 1) Fetch the artifact's current K-score.
  const jobRes = await fetch(`${base}/v1/compile/${encodeURIComponent(id)}`, {
    headers: { 'authorization': `Bearer ${token}` },
  });
  if (!jobRes.ok) {
    const e = new Error(`fetch artifact ${id}: ${jobRes.status}`);
    e.exitCode = EXIT.NOT_FOUND;
    throw e;
  }
  const job = await jobRes.json();
  const oldK = Number(job.k_score) || 0;
  console.log(`current K: ${oldK.toFixed(3)} on ${job.task ? String(job.task).slice(0, 60) : id}`);

  // 2) Pull recent audit rows for failed verifications + fallbacks.
  const auditRes = await fetch(`${base}/v1/audit/log?limit=500`, {
    headers: { 'authorization': `Bearer ${token}` },
  });
  const audit = auditRes.ok ? await auditRes.json() : { events: [] };
  const events = Array.isArray(audit.events || audit.items) ? (audit.events || audit.items) : [];
  const candidates = events.filter(e => {
    if (!e || !e.payload) return false;
    if (e.payload.job_id && e.payload.job_id !== id) return false;
    // Heuristic: pull anything tagged fallback OR low confidence.
    return e.op && (
      e.op.includes('fallback') || e.op.includes('fail') ||
      (typeof e.payload.confidence === 'number' && e.payload.confidence < 0.7)
    );
  });
  console.log(`found ${candidates.length} high-uncertainty event(s) since last compile`);

  if (!candidates.length) {
    console.log('nothing to improve. K-score gate already holding.');
    return;
  }
  if (dryRun) {
    console.log('--dry-run: not recompiling. Examples that would be added:');
    candidates.slice(0, 10).forEach((e, i) => {
      console.log(`  ${i + 1}. ${JSON.stringify(e.payload).slice(0, 120)}`);
    });
    return;
  }

  // 3) Recompile with the new examples appended.
  const newExamples = candidates.map(e => ({
    input: e.payload.input || '',
    output: e.payload.expected || e.payload.output || '',
  })).filter(x => x.input);
  if (!newExamples.length) {
    console.log('candidates had no usable input/output pairs. skipping.');
    return;
  }
  const compileBody = {
    task: job.task,
    base_model: job.base_model,
    preset: job.preset || 'lora-fast',
    lora_rank: job.lora_rank || 16,
    k_threshold: Math.max(oldK + epsilon, job.k_threshold || 0.85),
    examples: newExamples,
  };
  const newRes = await fetch(`${base}/v1/compile?sync=1`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(compileBody),
  });
  const newJob = await newRes.json();
  if (!newRes.ok || newJob.error) {
    console.log(`recompile rejected: ${newJob.error || newRes.status}`);
    console.log(`old artifact ${id} unchanged. K stayed at ${oldK.toFixed(3)}.`);
    return;
  }
  const newK = Number(newJob.k_score) || 0;
  console.log(`new K: ${newK.toFixed(3)} (threshold ${(oldK + epsilon).toFixed(3)})`);
  if (newK <= oldK + epsilon) {
    console.log(`improvement below epsilon. old artifact ${id} kept.`);
  } else {
    console.log(`new artifact ${newJob.job_id} replaces ${id} for K-score regression guard.`);
  }
}

// ---------- instant ----------
async function cmdInstant(args) {
  if (maybeHelp('instant', args)) return;
  // Usage: kolm instant "task description" [--n 64] [--teacher qwen-2.5-7b]
  //        [--base-model Qwen/Qwen2.5-3B-Instruct] [--out task.kolm.json]
  //        [--schema schema.json] [--k 0.85] [--compile]
  const task = args.find(a => !a.startsWith('--'));
  if (!task) {
    const e = new Error('usage: kolm instant "describe the task" [--n 64] [--teacher MODEL] [--base-model HF_ID] [--schema schema.json] [--out FILE] [--k 0.85] [--compile]');
    e.exitCode = EXIT.BAD_ARGS;
    throw e;
  }
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const n = Number(get('--n')) || 64;
  const teacher = get('--teacher') || 'qwen-2.5-7b-instruct';
  const baseModel = get('--base-model') || 'Qwen/Qwen2.5-3B-Instruct';
  const schemaPath = get('--schema');
  const out = get('--out') || 'instant-recipe.json';
  const kThreshold = Number(get('--k')) || 0.85;
  const compileAfter = args.includes('--compile');

  let schemaHint = null;
  if (schemaPath) {
    try { schemaHint = JSON.parse(fs.readFileSync(schemaPath, 'utf8')); }
    catch (err) {
      const e = new Error(`could not parse schema ${schemaPath}: ${err.message}`);
      e.exitCode = EXIT.BAD_ARGS;
      throw e;
    }
  }

  const cfgPayload = {
    task, n, teacher, base_model: baseModel,
    schema_hint: schemaHint, k_threshold: kThreshold,
  };

  const python = process.env.KOLM_PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3');
  const script = `
import json, sys
cfg = json.loads(sys.stdin.read())
from apps.trainer.instant import synthesize_recipe, InstantConfig
recipe = synthesize_recipe(
    task=cfg['task'],
    n=cfg['n'],
    teacher=cfg['teacher'],
    schema_hint=cfg.get('schema_hint'),
    config=InstantConfig(base_model=cfg['base_model'], k_threshold=cfg['k_threshold']),
)
print(json.dumps(recipe, ensure_ascii=False))
`;
  console.log(`synthesizing ${n} pairs via teacher=${teacher}...`);
  const { spawnSync } = require('child_process');
  const proc = spawnSync(python, ['-c', script], {
    input: JSON.stringify(cfgPayload),
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env, PYTHONPATH: process.cwd() },
  });
  if (proc.status !== 0) {
    const e = new Error(`instant synth failed:\n${proc.stderr || proc.stdout || ''}`);
    e.exitCode = EXIT.EXECUTION;
    throw e;
  }
  let recipe;
  try { recipe = JSON.parse(proc.stdout.trim().split('\n').pop()); }
  catch (err) {
    const e = new Error(`could not parse recipe JSON: ${err.message}\n${proc.stdout}`);
    e.exitCode = EXIT.EXECUTION;
    throw e;
  }

  fs.writeFileSync(out, JSON.stringify(recipe, null, 2), 'utf8');
  const s = recipe.stats || {};
  console.log(`status: ${recipe.status} kept=${s.kept}/${s.requested} reject_rate=${s.reject_rate} rounds=${s.rounds} elapsed=${s.elapsed_s}s`);
  console.log(`wrote ${out}`);

  if (recipe.status !== 'ready') {
    console.log(`recipe not ready (${recipe.status}). configure a teacher with KOLM_TEACHER_BASE / KOLM_TEACHER_KEY and re-run.`);
    return;
  }
  if (!compileAfter) {
    console.log(`next: kolm compile --recipe ${out}`);
    return;
  }

  const base = process.env.KOLM_BASE_URL || 'https://kolm.ai';
  const token = process.env.KOLM_API_KEY || (function () {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).api_key || null; } catch { return null; }
  })();
  if (!token) {
    console.log('--compile needs a logged-in API key. run `kolm login` first.');
    return;
  }
  const res = await fetch(`${base}/v1/compile?sync=1`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      task: recipe.task,
      base_model: recipe.base_model,
      preset: recipe.preset,
      k_threshold: recipe.k_threshold,
      examples: recipe.examples.map(p => ({ input: p.prompt, output: p.completion })),
      verifier: recipe.verifier,
    }),
  });
  const job = await res.json();
  if (!res.ok || job.error) {
    console.log(`compile rejected: ${job.error || res.status}`);
    return;
  }
  console.log(`compiled. job=${job.job_id} K=${Number(job.k_score || 0).toFixed(3)}`);
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
      case 'init':     await withErrorContext('init',     () => cmdInit(rest)); break;
      case 'signup':   await withErrorContext('signup',   () => cmdSignup(rest)); break;
      case 'login':    await withErrorContext('login',    () => cmdLogin(rest)); break;
      case 'whoami':   await withErrorContext('whoami',   () => cmdWhoami(rest)); break;
      case 'new':      await withErrorContext('new',      () => cmdNew(rest)); break;
      case 'build':    await withErrorContext('build',    () => cmdBuild(rest)); break;
      case 'compile':  await withErrorContext('compile',  () => cmdCompile(rest)); break;
      case 'train':    await withErrorContext('train',    () => cmdTrain(rest)); break;
      case 'run':      await withErrorContext('run',      () => cmdRun(rest)); break;
      case 'eval':     await withErrorContext('eval',     () => cmdEval(rest)); break;
      case 'benchmark':
      case 'bench':    await withErrorContext('bench',    () => cmdBenchmark(rest)); break;
      case 'score':    await withErrorContext('score',    () => cmdScore(rest)); break;
      case 'list':
      case 'ls':       await withErrorContext('list',     () => cmdList(rest)); break;
      case 'inspect':  await withErrorContext('inspect',  () => cmdInspect(rest)); break;
      case 'diff':     await withErrorContext('diff',     () => cmdDiff(rest)); break;
      case 'verify':   await withErrorContext('verify',   () => cmdVerify(rest)); break;
      case 'serve':    await withErrorContext('serve',    () => cmdServe(rest)); break;
      case 'publish':  await withErrorContext('publish',  () => cmdPublish(rest)); break;
      case 'pull':     await withErrorContext('pull',     () => cmdPull(rest)); break;
      case 'hub':      await withErrorContext('hub',      () => cmdHub(rest)); break;
      case 'capture':  await withErrorContext('capture',  () => cmdCapture(rest)); break;
      case 'labels':   await withErrorContext('labels',   () => cmdLabels(rest)); break;
      case 'distill':  await withErrorContext('distill',  () => cmdDistill(rest)); break;
      case 'config':   await withErrorContext('config',   () => cmdConfig(rest)); break;
      case 'install':  await withErrorContext('install',  () => cmdInstall(rest)); break;
      case 'tune':     await withErrorContext('tune',     () => cmdTune(rest)); break;
      case 'rag':      await withErrorContext('rag',      () => cmdRag(rest)); break;
      case 'team':     await withErrorContext('team',     () => cmdTeam(rest)); break;
      case 'tunnel':   await withErrorContext('tunnel',   () => cmdTunnel(rest)); break;
      case 'cloud':    await withErrorContext('cloud',    () => cmdCloud(rest)); break;
      case 'airgap':   await withErrorContext('airgap',   () => cmdAirgap(rest)); break;
      case 'compute':  await withErrorContext('compute',  () => cmdCompute(rest)); break;
      case 'doctor':   await withErrorContext('doctor',   () => cmdDoctor(rest)); break;
      case 'logs':     await withErrorContext('logs',     () => cmdLogs(rest)); break;
      case 'ask':      await withErrorContext('ask',      () => cmdAsk(rest)); break;
      case 'chat':     await withErrorContext('chat',     () => cmdChat(rest)); break;
      case 'completion': await withErrorContext('completion', () => cmdCompletion(rest)); break;
      case 'upgrade':  await withErrorContext('upgrade',  () => cmdUpgrade(rest)); break;
      case 'update':
      case 'self-update': await withErrorContext('update', () => cmdUpdate(rest)); break;
      case 'models':   await withErrorContext('models',   () => cmdModels(rest)); break;
      case 'gpu':      await withErrorContext('gpu',      () => cmdGpu(rest)); break;
      case 'export':   await withErrorContext('export',   () => cmdExport(rest)); break;
      case 'seeds':    await withErrorContext('seeds',    () => cmdSeeds(rest)); break;
      case 'anonymize':await withErrorContext('anonymize',() => cmdAnonymize(rest)); break;
      case 'improve':  await withErrorContext('improve',  () => cmdImprove(rest)); break;
      case 'instant':  await withErrorContext('instant',  () => cmdInstant(rest)); break;
      case 'version':  await withErrorContext('version',  () => cmdVersion(rest)); break;
      case '--version':
      case '-v':       await withErrorContext('version',  () => cmdVersion(['--short', ...rest])); break;
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        // First-run banner before help so fresh installs see the welcome path
        // (signup -> login -> compile) without having to know which verb to type.
        if (!rest || !rest[0]) firstRunBannerIfNeeded();
        usage(rest && rest[0]);
        break;
      default:
        if (looksLikeNaturalLanguage(cmd, rest)) {
          await withErrorContext('ask', () => cmdAsk([cmd, ...rest]));
        } else {
          const guess = suggestVerb(cmd, COMPLETION_VERBS);
          console.error('unknown command:', cmd);
          if (guess) console.error('did you mean: kolm ' + guess + ' ?');
          console.error('try: kolm ask "' + [cmd, ...rest].join(' ') + '"   (natural-language fallback)');
          usage();
          process.exit(EXIT.BAD_ARGS);
        }
    }
  } catch (e) {
    console.error('error:', e.message);
    if (process.env.KOLM_DEBUG) console.error(e.stack);
    // Honor exitCode set by withErrorContext / inner throws so EXIT.* semantics
    // from wave 1 are preserved. Default to EXIT.EXECUTION as before.
    const code = Number.isInteger(e && e.exitCode) ? e.exitCode : EXIT.EXECUTION;
    process.exit(code);
  }
}

main();
