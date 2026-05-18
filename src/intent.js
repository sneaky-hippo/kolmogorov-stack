// src/intent.js — natural-language intent dispatcher.
//
// The contract: given a free-form English instruction ("show me my captures"),
// resolve it to a concrete kolm verb + argv WITHOUT requiring an LLM round-trip
// for the 80% case. The classifier ships with three layers, evaluated in order:
//
//   1. KEYWORD FAST PATH  — exact-match table of common phrases. Zero latency,
//      zero deps, deterministic. Covers ~50 of the most common asks.
//   2. REGEX + HEURISTIC  — pattern extractors for namespace, file path, count,
//      etc. Routes phrasings the keyword path missed but whose structure is
//      mechanical ("compile a redactor from ./notes/" → cmdCompile + path arg).
//   3. LLM FALLBACK       — if KOLM_LLM_PROVIDER (or KOLM_INTENT_LLM) is set
//      and a key exists, ask the configured model for a verb. If no LLM is
//      configured, we rank verbs by token-overlap against VERB_DESCRIPTIONS
//      and return the top-3 as alternatives so the caller can present a
//      disambiguation prompt. Either way the function NEVER throws "not
//      implemented" — we always return some Intent so the dispatcher can
//      decide what to do.
//
// The intent classifier is ESM-only, has zero npm deps, and is consumed by the
// `kolm do`, `kolm interactive`, and `kolm next` verbs.
//
// PUBLIC API
//
//   classifyIntent(text, context) → Promise<Intent>
//     Intent = { verb: string, args: string[], confidence: number,
//                alternatives: Intent[], source: 'keyword' | 'regex' |
//                'llm' | 'overlap', original: string, normalized: string }
//     IntentContext = { cwd, artifacts: string[],
//                       captures_summary: [{namespace, count}], current_tenant? }
//
//   VERB_DESCRIPTIONS — one entry per supported verb (name, one-line
//     description, sample phrasings, sample args). Mirrored in AGENT_GUIDE.md
//     so AI agents and humans see the same surface.
//
//   listVerbs() → string[]  — the verb names in VERB_DESCRIPTIONS, stable
//                              order, for completion + docs builders.
//
// All input normalisation collapses whitespace, lowercases, and strips
// trailing punctuation. The original input is preserved on the returned Intent
// so callers can show "you said: …" prompts.

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// VERB_DESCRIPTIONS — the single-source-of-truth table the keyword path,
// the overlap-ranker, and AGENT_GUIDE.md all read from. Keep it stable.
//
// Each entry:
//   verb        — the CLI verb to dispatch (matches cli/kolm.js dispatch table)
//   desc        — one-line plain-English description (what it does)
//   when        — when a user would want this (used by overlap-ranker)
//   phrasings   — exact phrases that mean "run this verb". Triggers fast path.
//   examples    — full command lines (mirror to AGENT_GUIDE.md "Recipes")
//   args        — sample args for `kolm do --dry-run` output (advisory)
// ---------------------------------------------------------------------------

export const VERB_DESCRIPTIONS = [
  { verb: 'compile', desc: 'Build a .kolm artifact from a spec or task description.',
    when: 'You want to ship a new behaviour. The output is a signed .kolm.',
    phrasings: ['compile', 'build a kolm', 'make a kolm', 'build the artifact', 'compile the spec'],
    examples: ['kolm compile --spec phi-redactor.spec.json'] },
  { verb: 'run', desc: 'Execute a .kolm artifact against an input.',
    when: 'You have a .kolm and want to call it.',
    phrasings: ['run', 'execute', 'invoke', 'call the artifact'],
    examples: ['kolm run phi-redactor.kolm "Patient John Doe..."'] },
  { verb: 'eval', desc: 'Re-run the evals embedded in a .kolm and recompute K-score.',
    when: 'You want to know if an artifact still passes its tests.',
    phrasings: ['eval', 'evaluate', 'rerun evals', 'check the score'],
    examples: ['kolm eval phi-redactor.kolm'] },
  { verb: 'bench', desc: 'Reproducible benchmark on a .kolm (latency + cost vs LLM).',
    when: 'You want measured performance numbers, not estimates.',
    phrasings: ['bench', 'benchmark', 'measure performance', 'how fast'],
    examples: ['kolm bench phi-redactor.kolm --runs 100'] },
  { verb: 'verify', desc: 'Verify a .kolm signature, K-score gate, and emit a compliance binder.',
    when: 'Audit / compliance / pre-deploy gate.',
    phrasings: ['verify', 'check the signature', 'audit the artifact'],
    examples: ['kolm verify phi-redactor.kolm --binder report.html'] },
  { verb: 'inspect', desc: 'Print the manifest, recipes, signature, and K-score of a .kolm.',
    when: 'You want to look inside an artifact.',
    phrasings: ['inspect', 'show the artifact', 'open the kolm', 'what is in this kolm'],
    examples: ['kolm inspect phi-redactor.kolm'] },
  { verb: 'list', desc: 'List every local .kolm artifact under ~/.kolm/artifacts/.',
    when: 'You want to see what you have shipped.',
    phrasings: ['list', 'ls', 'show artifacts', 'list artifacts', 'what artifacts', 'all artifacts'],
    examples: ['kolm list'] },
  { verb: 'artifacts', desc: 'List/show/diff remote artifacts on the cloud.',
    when: 'You want to see what is published to your tenant cloud.',
    phrasings: ['artifacts list', 'remote artifacts', 'cloud artifacts', 'list remote'],
    examples: ['kolm artifacts list', 'kolm artifacts show <id>'] },
  { verb: 'tail', desc: 'Tail captures (SSE) from a namespace.',
    when: 'You want a live feed of LLM observations to a namespace.',
    phrasings: ['tail captures', 'show captures', 'list captures', 'watch captures', 'stream captures', 'see captures', 'follow captures',
      'show me captures', 'list my captures', 'show me my captures'],
    examples: ['kolm tail captures --namespace support'] },
  { verb: 'capture', desc: 'Configure the OpenAI/Anthropic proxy and view capture status.',
    when: 'You want to enable per-namespace capture (pairs → distill).',
    phrasings: ['capture', 'capture status', 'capture config', 'enable capture'],
    examples: ['kolm capture --provider openai --as ks_proxy'] },
  { verb: 'distill', desc: 'Auto-distill captured (input, output) pairs into a local LoRA.',
    when: 'You have hundreds of captures and want a specialist model.',
    phrasings: ['distill', 'distill captures', 'train from captures', 'fine tune'],
    examples: ['kolm distill --from-captures --namespace support'] },
  { verb: 'replay', desc: 'Replay captured pairs against an artifact and diff results.',
    when: 'You want regression detection on a new artifact version.',
    phrasings: ['replay', 'replay captures', 'replay a namespace'],
    examples: ['kolm replay support art_123 phi-redactor.kolm'] },
  { verb: 'serve', desc: 'Expose ~/.kolm/artifacts/ as MCP tools or an HTTP endpoint.',
    when: 'You want frontier models or apps to call your artifacts.',
    phrasings: ['serve', 'start the server', 'expose mcp', 'serve mcp', 'host artifacts'],
    examples: ['kolm serve --mcp --http --port 7787'] },
  { verb: 'publish', desc: 'Push a .kolm to the public verifiable hub.',
    when: 'You want to share an artifact with the world.',
    phrasings: ['publish', 'push to hub', 'share artifact'],
    examples: ['kolm publish phi-redactor.kolm --public'] },
  { verb: 'pull', desc: 'Download a published artifact (SHA-256 pinned).',
    when: 'You want to use someone else’s .kolm.',
    phrasings: ['pull', 'download', 'get an artifact'],
    examples: ['kolm pull kolm/phi-redactor'] },
  { verb: 'hub', desc: 'Browse the public artifact gallery.',
    when: 'You want to see what others have published.',
    phrasings: ['hub', 'browse hub', 'gallery', 'show the hub'],
    examples: ['kolm hub list'] },
  { verb: 'marketplace', desc: 'Search / install / publish marketplace items.',
    when: 'You want curated, tenant-scoped artifacts.',
    phrasings: ['marketplace', 'search marketplace', 'find a model'],
    examples: ['kolm marketplace search redactor'] },
  { verb: 'login', desc: 'Save an API key to ~/.kolm/config.json.',
    when: 'You need to authenticate.',
    phrasings: ['login', 'log in', 'sign in', 'auth', 'authenticate'],
    examples: ['kolm login --key ks_...'] },
  { verb: 'signup', desc: 'Provision a tenant + API key from the CLI.',
    when: 'You do not have an account yet.',
    phrasings: ['signup', 'sign up', 'create account', 'new account', 'register'],
    examples: ['kolm signup --email you@example.com'] },
  { verb: 'whoami', desc: 'Echo current tenant + plan + base URL.',
    when: 'You want to know which account you are logged in as.',
    phrasings: ['whoami', 'who am i', 'who is logged in', 'current account', 'current tenant', 'current user'],
    examples: ['kolm whoami --json'] },
  { verb: 'status', desc: 'Local snapshot: CLI version, base, key fingerprint, jobs.',
    when: 'You want a quick local-side health summary.',
    phrasings: ['status', 'kolm status', 'show status', 'local status'],
    examples: ['kolm status --json'] },
  { verb: 'health', desc: 'Probe the cloud endpoint (HTTP + RTT).',
    when: 'You want to know if the kolm.ai cloud is reachable.',
    phrasings: ['health', 'cloud health', 'is kolm up', 'ping cloud'],
    examples: ['kolm health --json'] },
  { verb: 'metrics', desc: 'Print local CLI usage metrics.',
    when: 'You want to know how much you have used kolm.',
    phrasings: ['metrics', 'usage metrics', 'show metrics'],
    examples: ['kolm metrics --json'] },
  { verb: 'support-bundle', desc: 'Collect a tarball of state for support tickets.',
    when: 'You hit a bug and need to send a repro.',
    phrasings: ['support bundle', 'support', 'collect support', 'send a bundle'],
    examples: ['kolm support-bundle --out bundle.tgz'] },
  { verb: 'init', desc: 'Scaffold kolm.yaml + .kolm/ at cwd.',
    when: 'Bootstrap a new project directory.',
    phrasings: ['init', 'initialize', 'init project', 'new project', 'bootstrap project'],
    examples: ['kolm init --name my-app'] },
  { verb: 'init-agent', desc: 'Scaffold a script-first agent project.',
    when: 'You want a redactor / classifier / extractor template.',
    phrasings: ['init agent', 'new agent', 'scaffold agent', 'create agent project'],
    examples: ['kolm init-agent phi-redactor --template redactor'] },
  { verb: 'new', desc: 'Scaffold a spec.json from a template.',
    when: 'You want to start a new spec from scratch.',
    phrasings: ['new', 'new spec', 'scaffold spec', 'make a spec'],
    examples: ['kolm new phi-redactor --from redactor'] },
  { verb: 'build', desc: 'One-shot: new + seeds + compile + verify (fastest path).',
    when: 'You want one command to take you from idea to verified artifact.',
    phrasings: ['build', 'fast build', 'one shot', 'one-shot build', 'do everything'],
    examples: ['kolm build phi-redactor'] },
  { verb: 'seeds', desc: 'Local-first training-data helpers (new / generate / list / bootstrap).',
    when: 'You need to author or synthesise training rows.',
    phrasings: ['seeds', 'training data', 'generate seeds', 'make seeds', 'mine seeds'],
    examples: ['kolm seeds new "redact PHI from clinical notes"'] },
  { verb: 'redact', desc: 'Redact PII/PHI from a JSONL file.',
    when: 'You have raw data with personal identifiers to strip.',
    phrasings: ['redact', 'remove pii', 'strip identifiers', 'scrub data'],
    examples: ['kolm redact rows.jsonl'] },
  { verb: 'anonymize', desc: 'Templated PII/PHI replacement (shortcut for seeds generate).',
    when: 'You want anonymised seeds for compile.',
    phrasings: ['anonymize', 'anonymise', 'replace identifiers'],
    examples: ['kolm anonymize rows.jsonl'] },
  { verb: 'doctor', desc: 'Sanity-check the env (config, cloud, docker, project).',
    when: 'Something is broken and you want a diagnostic.',
    phrasings: ['doctor', 'diagnose', 'health check', 'sanity check', 'why is it broken'],
    examples: ['kolm doctor'] },
  { verb: 'loop', desc: 'Run the value-loop smoke (capture → distill → replay).',
    when: 'You want to know the end-to-end pipeline works.',
    phrasings: ['loop', 'value loop', 'smoke test', 'run the loop', 'e2e test'],
    examples: ['kolm loop --json'] },
  { verb: 'logs', desc: 'Tail local run history (~/.kolm/logs/runs.jsonl).',
    when: 'You want to see what you have run recently.',
    phrasings: ['logs', 'show logs', 'tail logs', 'recent runs', 'run history'],
    examples: ['kolm logs --limit 50'] },
  { verb: 'jobs', desc: 'List or prune background jobs (~/.kolm/jobs.jsonl).',
    when: 'You ran a --detach and want to see live jobs.',
    phrasings: ['jobs', 'show jobs', 'list jobs'],
    examples: ['kolm jobs list'] },
  { verb: 'watch', desc: 'Tail the log of a specific background job.',
    when: 'You want live output from a detached compile.',
    phrasings: ['watch', 'watch job', 'follow job'],
    examples: ['kolm watch <job-id>'] },
  { verb: 'sessions', desc: 'List all detached compile/distill sessions on this host.',
    when: 'You want to find a long-running session to resume.',
    phrasings: ['sessions', 'list sessions', 'show sessions'],
    examples: ['kolm sessions'] },
  { verb: 'resume', desc: 'Tail an already-detached session log.',
    when: 'You disconnected and want to re-attach to a session.',
    phrasings: ['resume', 'resume session', 'attach session'],
    examples: ['kolm resume <session-id>'] },
  { verb: 'rescue', desc: 'Adopt an orphaned PID via reptyr (Linux only).',
    when: 'A process is running but you lost the parent terminal.',
    phrasings: ['rescue', 'rescue pid', 'rescue session', 'adopt orphan'],
    examples: ['kolm rescue <pid>'] },
  { verb: 'install', desc: 'Wire kolm MCP into Claude Code / Cursor / Continue / Cline.',
    when: 'You want frontier-model tooling to discover your artifacts.',
    phrasings: ['install', 'install mcp', 'wire claude', 'wire cursor', 'integrate'],
    examples: ['kolm install claude-code --apply'] },
  { verb: 'models', desc: 'Local model registry (list / info / recommend / pin / devices).',
    when: 'You want to choose a base model or check what is available.',
    phrasings: ['models', 'list models', 'what models', 'show models', 'available models',
      'list my models', 'show me models', 'show my models'],
    examples: ['kolm models list'] },
  { verb: 'gpu', desc: 'Accelerator probe (detect / doctor / setup / stress).',
    when: 'You want to know what GPU you have and if it works.',
    phrasings: ['gpu', 'detect gpu', 'check gpu', 'what gpu'],
    examples: ['kolm gpu detect'] },
  { verb: 'export', desc: 'Convert a .kolm to GGUF / MLX / ONNX / CoreML / TensorRT.',
    when: 'You want to ship to a non-kolm runtime.',
    phrasings: ['export', 'export to gguf', 'convert to', 'export artifact'],
    examples: ['kolm export phi-redactor.kolm --to gguf'] },
  { verb: 'quantize', desc: 'Quantise an adapter via the isolated worker (int4/int8/gptq/awq).',
    when: 'You want a smaller, faster artifact for edge.',
    phrasings: ['quantize', 'quantise', 'compress model', 'shrink model'],
    examples: ['kolm quantize int4 --in adapter.bin'] },
  { verb: 'runtime', desc: 'Runtime targets / doctor / build-from-source.',
    when: 'You need a runtime that does not ship by default.',
    phrasings: ['runtime', 'runtime info', 'runtime targets', 'list runtimes'],
    examples: ['kolm runtime targets'] },
  { verb: 'profile', desc: 'Save / use / list / show / delete a kolm profile.',
    when: 'You switch between work / personal / client tenants.',
    phrasings: ['profile', 'profiles', 'switch profile', 'use profile'],
    examples: ['kolm profile use work'] },
  { verb: 'team', desc: 'Multi-tenant workspaces (create / list / invite / members).',
    when: 'You want shared seats with teammates.',
    phrasings: ['team', 'teams', 'invite teammate', 'create team'],
    examples: ['kolm team create my-team'] },
  { verb: 'tunnel', desc: 'Remote access to a self-hosted kolm (new / list / start / close).',
    when: 'You self-host and want to expose a public endpoint.',
    phrasings: ['tunnel', 'expose endpoint', 'open tunnel'],
    examples: ['kolm tunnel new --port 7787'] },
  { verb: 'cloud', desc: 'Real GPU train + BYOC deploy (train / deploy / list / show).',
    when: 'You want training on a real GPU you do not own.',
    phrasings: ['cloud train', 'train on cloud', 'gpu train', 'cloud deploy'],
    examples: ['kolm cloud train --spec phi-redactor.spec.json'] },
  { verb: 'compute', desc: 'Where training runs (list / detect / pick / use / info).',
    when: 'You want to choose a compute backend.',
    phrasings: ['compute', 'compute list', 'pick compute'],
    examples: ['kolm compute list'] },
  { verb: 'airgap', desc: 'Hard-offline mode (status / enable / disable / verify).',
    when: 'You need to certify that kolm makes no network calls.',
    phrasings: ['airgap', 'offline mode', 'enable airgap'],
    examples: ['kolm airgap enable'] },
  { verb: 'rag', desc: 'Airgapped local lookup (index / query / attach / list).',
    when: 'You want BM25 over local files attached to a recipe.',
    phrasings: ['rag', 'index files', 'index a folder', 'query rag'],
    examples: ['kolm rag index ./docs/'] },
  { verb: 'tune', desc: 'Evolve a local adapter (init / capture-on / step / promote / watch).',
    when: 'You want a self-improving local LoRA.',
    phrasings: ['tune', 'tune model', 'evolve adapter', 'capture on'],
    examples: ['kolm tune init'] },
  { verb: 'drift', desc: 'Drift detect / cron / verify (supersession events).',
    when: 'You want to know when a deployed artifact is going stale.',
    phrasings: ['drift', 'detect drift', 'check drift'],
    examples: ['kolm drift detect'] },
  { verb: 'config', desc: 'Inspect or set kolm config (base / api_key).',
    when: 'You want to change the cloud endpoint or key.',
    phrasings: ['config', 'show config', 'set config'],
    examples: ['kolm config base https://kolm.ai'] },
  { verb: 'keys', desc: 'Ed25519 key rotation lifecycle (list / rotate / fingerprint / export).',
    when: 'You manage signing keys.',
    phrasings: ['keys', 'rotate keys', 'list keys', 'fingerprint'],
    examples: ['kolm keys list'] },
  { verb: 'completion', desc: 'Emit a bash/zsh/fish completion script.',
    when: 'You want shell autocomplete for kolm.',
    phrasings: ['completion', 'shell completion', 'autocomplete'],
    examples: ['kolm completion bash'] },
  { verb: 'upgrade', desc: 'Check for a newer kolm release (does not install).',
    when: 'You want to know if there is a new version.',
    phrasings: ['upgrade', 'check for updates', 'new version'],
    examples: ['kolm upgrade'] },
  { verb: 'update', desc: 'Self-install the latest kolm from github.',
    when: 'You want to install the newest kolm now.',
    phrasings: ['update', 'self update', 'self-update', 'reinstall'],
    examples: ['kolm update'] },
  { verb: 'version', desc: 'Print version (CLI + server contract).',
    when: 'You want the version string.',
    phrasings: ['version', 'which version', 'what version', 'show version'],
    examples: ['kolm version'] },
  { verb: 'tui', desc: 'Interactive .kolm shell (multi-pane TUI).',
    when: 'You want a keyboard-driven UI for captures + artifacts.',
    phrasings: ['tui', 'open tui', 'launch tui'],
    examples: ['kolm tui'] },
  { verb: 'repl', desc: 'Interactive kolm REPL (one verb per line).',
    when: 'You want to type many kolm verbs without re-spawning the CLI.',
    phrasings: ['repl', 'open repl', 'interactive shell'],
    examples: ['kolm repl'] },
  { verb: 'chat', desc: 'Interactive natural-language session (airgap-safe).',
    when: 'You want a chat-style assistant.',
    phrasings: ['chat', 'open chat', 'start chat', 'talk to kolm'],
    examples: ['kolm chat'] },
  { verb: 'ask', desc: 'Natural-language gateway to status / builds / install / compile.',
    when: 'One-shot natural-language question.',
    phrasings: ['ask', 'ask kolm'],
    examples: ['kolm ask "what is my k score?"'] },
  { verb: 'do', desc: 'Natural-language dispatcher — classify and run any verb.',
    when: 'You do not remember the verb name; describe the task.',
    phrasings: ['do', 'run command'],
    examples: ['kolm do "show captures"'] },
  { verb: 'what', desc: 'Snapshot of the current kolm state (artifacts, captures, jobs).',
    when: 'You want a one-screen dashboard of where you are.',
    phrasings: ['what', 'what is going on', 'snapshot', 'dashboard', 'overview', 'show me everything'],
    examples: ['kolm what --json'] },
  { verb: 'next', desc: 'Recommend the highest-value next action given current state.',
    when: 'You are stuck and want a guided next step.',
    phrasings: ['next', 'next step', 'what next', 'what should i do'],
    examples: ['kolm next --json'] },
  { verb: 'explain', desc: 'Plain-English description of a .kolm artifact.',
    when: 'You want to understand what an artifact does and how it was trained.',
    phrasings: ['explain', 'describe', 'explain artifact', 'what does this do'],
    examples: ['kolm explain phi-redactor.kolm'] },
  { verb: 'fix', desc: 'Auto-iterate: surface failing eval cases and suggest seed fixes.',
    when: 'An artifact failed eval and you want help patching it.',
    phrasings: ['fix', 'auto fix', 'patch artifact', 'fix the kolm'],
    examples: ['kolm fix phi-redactor.kolm --apply'] },
];

// ---------------------------------------------------------------------------
// Stable lookup helpers.
// ---------------------------------------------------------------------------

export function listVerbs() {
  return VERB_DESCRIPTIONS.map(v => v.verb);
}

// Build the phrasing → verb index once at module load.
const PHRASING_INDEX = (() => {
  const idx = new Map();
  for (const entry of VERB_DESCRIPTIONS) {
    for (const phrase of entry.phrasings) {
      idx.set(normalize(phrase), entry.verb);
    }
  }
  return idx;
})();

// ---------------------------------------------------------------------------
// Normalisation. Lowercase, collapse whitespace, strip trailing punctuation,
// strip surrounding quotes. Keep contractions ("what's", "i'd") because the
// keyword index uses them.
// ---------------------------------------------------------------------------

function normalize(text) {
  if (text == null) return '';
  let s = String(text).trim();
  // strip wrapping quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.toLowerCase();
  s = s.replace(/[\s\n\t]+/g, ' ');
  s = s.replace(/[.?!,;]+$/g, '');
  return s;
}

function tokens(text) {
  return normalize(text).split(' ').filter(t => t.length > 0);
}

// ---------------------------------------------------------------------------
// 1. KEYWORD FAST PATH
//
// Try the exact phrasing first, then progressive prefix matches, then any
// phrasing that appears as a substring of the input. This catches:
//   "show captures"            → exact match     (confidence 0.99)
//   "show captures please"     → prefix match    (confidence 0.95)
//   "could you show captures"  → substring match (confidence 0.90)
// ---------------------------------------------------------------------------

function keywordMatch(normalizedText) {
  // exact
  if (PHRASING_INDEX.has(normalizedText)) {
    return { verb: PHRASING_INDEX.get(normalizedText), confidence: 0.99, source: 'keyword' };
  }
  // longest prefix
  let bestPrefix = null;
  for (const [phrase, verb] of PHRASING_INDEX) {
    if (normalizedText.startsWith(phrase + ' ') && (!bestPrefix || phrase.length > bestPrefix.phrase.length)) {
      bestPrefix = { phrase, verb };
    }
  }
  if (bestPrefix) {
    return { verb: bestPrefix.verb, confidence: 0.95, source: 'keyword', matchedPhrase: bestPrefix.phrase };
  }
  // longest substring
  let bestSub = null;
  for (const [phrase, verb] of PHRASING_INDEX) {
    if (normalizedText.includes(' ' + phrase + ' ') || normalizedText.endsWith(' ' + phrase) || normalizedText.startsWith(phrase + ' ')) {
      if (!bestSub || phrase.length > bestSub.phrase.length) bestSub = { phrase, verb };
    }
  }
  if (bestSub) {
    return { verb: bestSub.verb, confidence: 0.90, source: 'keyword', matchedPhrase: bestSub.phrase };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. REGEX + HEURISTIC EXTRACTORS
//
// These run AFTER the keyword pass, and they synthesise args. e.g. a phrase
// like "show captures in namespace support" produces args ['captures',
// '--namespace', 'support'] for cmdTail.
//
// Order matters — first match wins.
// ---------------------------------------------------------------------------

const REGEX_RULES = [
  // captures in / from namespace <name>
  {
    pattern: /(?:show|list|tail|watch|stream|see|follow)\s+(?:my\s+)?captures?(?:\s+(?:in|from|for|under|of)\s+(?:namespace\s+)?["'`]?([\w.\-:/]+)["'`]?)?/i,
    build: (m) => ({
      verb: 'tail',
      args: ['captures', ...(m[1] ? ['--namespace', m[1]] : [])],
      confidence: 0.92,
      source: 'regex',
    }),
  },
  // capture count
  {
    pattern: /(?:how many|count|number of)\s+captures?(?:\s+(?:in|from|for|under)\s+(?:namespace\s+)?["'`]?([\w.\-:/]+)["'`]?)?/i,
    build: (m) => ({
      verb: 'capture',
      args: ['status', ...(m[1] ? ['--namespace', m[1]] : [])],
      confidence: 0.9,
      source: 'regex',
    }),
  },
  // distill from captures (with namespace optional)
  {
    pattern: /(?:distill|train|fine[- ]?tune)(?:\s+(?:from|using|with))?\s+(?:my\s+)?captures?(?:\s+(?:in|from|for|under)\s+(?:namespace\s+)?["'`]?([\w.\-:/]+)["'`]?)?/i,
    build: (m) => ({
      verb: 'distill',
      args: ['--from-captures', ...(m[1] ? ['--namespace', m[1]] : [])],
      confidence: 0.9,
      source: 'regex',
    }),
  },
  // build a (redactor|classifier|extractor|agent|chatbot) [from <dir>]
  {
    pattern: /(?:build|make|create|scaffold)\s+(?:a\s+)?(redactor|classifier|extractor|extraction|chatbot|agent)(?:\s+(?:from|using)\s+["'`]?([^"'`]+?)["'`]?)?$/i,
    build: (m) => {
      const tpl = (m[1] || '').toLowerCase().replace('extractor', 'extraction');
      const args = ['inferred-' + tpl, '--template', tpl];
      if (m[2]) args.push('--from', m[2]);
      return { verb: 'init-agent', args, confidence: 0.88, source: 'regex' };
    },
  },
  // compile <file>
  {
    pattern: /compile(?:\s+(?:the|my))?\s+([\w.\-/\\]+\.(?:spec\.json|spec|yaml|yml|json))$/i,
    build: (m) => ({ verb: 'compile', args: ['--spec', m[1]], confidence: 0.93, source: 'regex' }),
  },
  // run <artifact> "<input>"
  {
    pattern: /(?:run|execute|invoke|call)\s+([\w.\-/\\]+\.kolm)(?:\s+(?:on|with|against)\s+["'`]([^"'`]+)["'`])?/i,
    build: (m) => ({
      verb: 'run',
      args: [m[1], ...(m[2] ? [m[2]] : [])],
      confidence: 0.95,
      source: 'regex',
    }),
  },
  // inspect/explain/eval/verify/bench <artifact>
  {
    pattern: /(?:inspect|open|explain|describe|eval|evaluate|verify|audit|bench|benchmark)\s+(?:the\s+)?([\w.\-/\\]+\.kolm)/i,
    build: (m, raw) => {
      const verbWord = raw.match(/^(\w+)/i)[1].toLowerCase();
      const verb = verbWord.startsWith('eval') ? 'eval'
        : verbWord.startsWith('verify') || verbWord === 'audit' ? 'verify'
        : verbWord.startsWith('bench') ? 'bench'
        : verbWord === 'explain' || verbWord === 'describe' ? 'explain'
        : 'inspect';
      return { verb, args: [m[1]], confidence: 0.92, source: 'regex' };
    },
  },
  // mine from a folder of <kind> [in <dir>]
  {
    pattern: /(?:mine|generate|extract)\s+(?:seeds?|training\s+data|examples?)?\s*(?:from|in|under)\s+["'`]?([^\s"'`]+\/?)["'`]?/i,
    build: (m) => ({
      verb: 'seeds',
      args: ['generate', '--from', m[1]],
      confidence: 0.85,
      source: 'regex',
    }),
  },
  // synthetic n=NUM
  {
    pattern: /(?:generate|create|make)\s+(\d+)\s+(?:synthetic\s+)?(?:examples?|seeds?|rows?)/i,
    build: (m) => ({
      verb: 'seeds',
      args: ['generate', '--n', m[1], '--strategy', 'synthetic'],
      confidence: 0.85,
      source: 'regex',
    }),
  },
  // export to <fmt>
  {
    pattern: /export\s+([\w.\-/\\]+\.kolm)\s+(?:to|as)\s+(gguf|mlx|onnx|coreml|tensorrt)/i,
    build: (m) => ({
      verb: 'export',
      args: [m[1], '--to', m[2].toLowerCase()],
      confidence: 0.95,
      source: 'regex',
    }),
  },
  // publish <artifact>
  {
    pattern: /(?:publish|push|upload|share)\s+([\w.\-/\\]+\.kolm)(?:\s+(public|private))?/i,
    build: (m) => ({
      verb: 'publish',
      args: [m[1], ...(m[2] === 'public' ? ['--public'] : [])],
      confidence: 0.92,
      source: 'regex',
    }),
  },
  // pull <owner>/<name>
  {
    pattern: /(?:pull|download|get|fetch)\s+([\w\-]+\/[\w.\-]+(?:@sha:[a-f0-9]+)?)/i,
    build: (m) => ({ verb: 'pull', args: [m[1]], confidence: 0.92, source: 'regex' }),
  },
  // install <harness>
  {
    pattern: /(?:install|wire|integrate)\s+(claude(?:-code)?|cursor|continue|cline)/i,
    build: (m) => {
      const h = m[1].toLowerCase() === 'claude' ? 'claude-code' : m[1].toLowerCase();
      return { verb: 'install', args: [h, '--apply'], confidence: 0.9, source: 'regex' };
    },
  },
  // marketplace search <term>
  {
    pattern: /(?:search|find)\s+(?:the\s+)?marketplace\s+(?:for\s+)?([\w\s\-]+)/i,
    build: (m) => ({ verb: 'marketplace', args: ['search', m[1].trim()], confidence: 0.9, source: 'regex' }),
  },
  // login with key ks_*
  {
    pattern: /(?:log\s*in|login|sign\s*in|auth(?:enticate)?)(?:\s+with\s+(?:key\s+)?(ks_[a-z0-9_]+))?/i,
    build: (m) => ({
      verb: 'login',
      args: m[1] ? ['--key', m[1]] : [],
      confidence: 0.9,
      source: 'regex',
    }),
  },
];

function regexMatch(normalizedText, original) {
  for (const rule of REGEX_RULES) {
    // Prefer the original-case match so string-typed captures (e.g. the input
    // for `run X.kolm with "Patient John Doe"`) preserve their original case.
    // Fall back to the normalized lowercase match for case-insensitive verbs.
    const m = original.match(rule.pattern) || normalizedText.match(rule.pattern);
    if (m) return rule.build(m, original);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. LLM FALLBACK — opt-in. Reads KOLM_LLM_PROVIDER ('anthropic' | 'openai').
// If a provider + key is configured, we ask the LLM to pick a verb; otherwise
// we rank verbs by token-overlap with the description table.
// ---------------------------------------------------------------------------

function overlapRank(normalizedText, k = 3) {
  const inputTokens = new Set(tokens(normalizedText));
  // stop-word filter so "the", "a", "my" don't dominate the overlap signal.
  const STOP = new Set(['the', 'a', 'an', 'my', 'your', 'our', 'is', 'are', 'do', 'i', 'you',
    'to', 'for', 'of', 'in', 'on', 'at', 'with', 'from', 'and', 'or', 'please', 'help',
    'me', 'us', 'we', 'it', 'this', 'that', 'these', 'those', 'be', 'been', 'was', 'were',
    'show', 'list', 'tell', 'give', 'make', 'want', 'need']);
  for (const w of STOP) inputTokens.delete(w);
  if (inputTokens.size === 0) return [];
  const scored = [];
  for (const entry of VERB_DESCRIPTIONS) {
    const haystack = (entry.verb + ' ' + entry.desc + ' ' + entry.when + ' ' + entry.phrasings.join(' ')).toLowerCase();
    const hayTokens = new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean));
    for (const w of STOP) hayTokens.delete(w);
    let overlap = 0;
    for (const t of inputTokens) if (hayTokens.has(t)) overlap++;
    if (overlap === 0) continue;
    // Bonus when the verb itself appears verbatim in the input.
    const verbBonus = inputTokens.has(entry.verb) ? 1 : 0;
    const score = (overlap + verbBonus) / Math.max(inputTokens.size, 1);
    scored.push({ verb: entry.verb, score, confidence: Math.min(0.65, 0.30 + score * 0.5) });
  }
  scored.sort((a, b) => b.score - a.score || a.verb.localeCompare(b.verb));
  return scored.slice(0, k).map(s => ({
    verb: s.verb,
    args: [],
    confidence: s.confidence,
    source: 'overlap',
  }));
}

async function llmClassify(text, providerConfig) {
  // Provider abstraction — keep zero npm deps. We use native fetch.
  const provider = providerConfig.provider;
  const verbList = VERB_DESCRIPTIONS.map(v => `${v.verb}: ${v.desc}`).join('\n');
  const prompt = [
    'You are an intent classifier for the kolm CLI. The user says:',
    JSON.stringify(text),
    '',
    'Pick exactly one verb from this list. Return ONLY a JSON object',
    '{"verb":"<name>","args":[<list of args>],"confidence":0.0..1.0}.',
    'If you cannot pick, return {"verb":"ask","args":[],"confidence":0.2}.',
    '',
    'Verbs:',
    verbList,
  ].join('\n');
  if (provider === 'anthropic') {
    const url = (providerConfig.base || 'https://api.anthropic.com') + '/v1/messages';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': providerConfig.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: providerConfig.model || 'claude-3-5-haiku-20241022',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error('anthropic ' + res.status);
    const j = await res.json();
    const text = j?.content?.[0]?.text || '';
    return parseLlmResponse(text);
  }
  if (provider === 'openai') {
    const url = (providerConfig.base || 'https://api.openai.com') + '/v1/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + providerConfig.key,
      },
      body: JSON.stringify({
        model: providerConfig.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error('openai ' + res.status);
    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content || '';
    return parseLlmResponse(text);
  }
  throw new Error('unknown provider: ' + provider);
}

function parseLlmResponse(text) {
  if (!text) return null;
  // Strip surrounding ```json fences if present.
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const open = s.indexOf('{');
  const close = s.lastIndexOf('}');
  if (open < 0 || close < open) return null;
  try {
    const obj = JSON.parse(s.slice(open, close + 1));
    if (!obj || typeof obj.verb !== 'string') return null;
    const known = new Set(listVerbs());
    if (!known.has(obj.verb)) return null;
    return {
      verb: obj.verb,
      args: Array.isArray(obj.args) ? obj.args.map(String) : [],
      confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0.5)),
      source: 'llm',
    };
  } catch {
    return null;
  }
}

function llmConfig() {
  const provider = process.env.KOLM_LLM_PROVIDER || process.env.KOLM_INTENT_LLM || '';
  if (!provider) return null;
  let key = process.env.KOLM_LLM_KEY || '';
  if (!key && provider === 'anthropic') key = process.env.ANTHROPIC_API_KEY || '';
  if (!key && provider === 'openai') key = process.env.OPENAI_API_KEY || '';
  if (!key) return null;
  return {
    provider,
    key,
    base: process.env.KOLM_LLM_BASE || '',
    model: process.env.KOLM_LLM_MODEL || '',
  };
}

// ---------------------------------------------------------------------------
// PUBLIC: classifyIntent
// ---------------------------------------------------------------------------

export async function classifyIntent(text, context = {}) {
  const original = text == null ? '' : String(text);
  const normalized = normalize(original);
  const empty = !normalized;

  const baseEnvelope = (intent, alts = []) => ({
    verb: intent.verb,
    args: intent.args || [],
    confidence: intent.confidence,
    alternatives: alts,
    source: intent.source,
    matchedPhrase: intent.matchedPhrase || null,
    original,
    normalized,
  });

  if (empty) {
    return baseEnvelope({ verb: 'what', args: [], confidence: 0.5, source: 'empty' });
  }

  // 1. KEYWORD FAST PATH
  const kw = keywordMatch(normalized);
  if (kw) {
    // Apply contextual heuristics for capture-related verbs FIRST so a phrase
    // like "show captures support" can pull the namespace from caller context
    // even when the regex pattern (which requires "in/from/for ...") did not
    // extract one. The contextual answer beats the namespace-less regex.
    if (kw.verb === 'tail') {
      const r = regexMatch(normalized, original);
      const hasRegexNs = !!(r && r.verb === 'tail' && r.args && r.args.includes('--namespace'));
      const ns = hasRegexNs
        ? r.args[r.args.indexOf('--namespace') + 1]
        : pickContextualNamespace(normalized, context);
      const args = ['captures', ...(ns ? ['--namespace', ns] : [])];
      return baseEnvelope({ ...kw, args });
    }
    if (kw.verb === 'distill') {
      const r = regexMatch(normalized, original);
      const hasRegexNs = !!(r && r.verb === 'distill' && r.args && r.args.includes('--namespace'));
      const ns = hasRegexNs
        ? r.args[r.args.indexOf('--namespace') + 1]
        : pickContextualNamespace(normalized, context);
      const args = ['--from-captures', ...(ns ? ['--namespace', ns] : [])];
      return baseEnvelope({ ...kw, args });
    }
    // For everything else: prefer a regex hit that extracted args, since the
    // regex is more specific than a bare keyword. For 'build', a phrase like
    // "build a redactor from ./notes/" should resolve to init-agent, not the
    // bare 'build' verb.
    const r = regexMatch(normalized, original);
    if (r && r.args && r.args.length > 0) {
      // If regex picked a different verb (e.g. init-agent for "build a redactor
      // from <dir>"), prefer the regex result -- it captured more semantic
      // structure than the keyword.
      if (r.verb !== kw.verb) {
        return baseEnvelope({ ...r, source: 'regex' });
      }
      return baseEnvelope({ ...kw, args: r.args, confidence: Math.max(kw.confidence, r.confidence) });
    }
    return baseEnvelope({ ...kw, args: kw.args || [] });
  }

  // 2. REGEX
  const r = regexMatch(normalized, original);
  if (r) return baseEnvelope(r);

  // 3. LLM FALLBACK (or overlap ranking when no LLM is configured)
  const llm = llmConfig();
  if (llm) {
    try {
      const out = await llmClassify(original, llm);
      if (out) {
        const alts = overlapRank(normalized, 3).filter(a => a.verb !== out.verb);
        return baseEnvelope(out, alts);
      }
    } catch (_) {
      // fall through to overlap
    }
  }
  const ranked = overlapRank(normalized, 3);
  if (ranked.length === 0) {
    // Last resort: route to `ask` so the user gets a useful natural-language reply.
    return baseEnvelope({ verb: 'ask', args: [original], confidence: 0.2, source: 'fallback' });
  }
  const [top, ...rest] = ranked;
  return baseEnvelope(top, rest);
}

// Pull a namespace out of the input that matches an existing one in context.
function pickContextualNamespace(normalized, context) {
  const ns = context && Array.isArray(context.captures_summary) ? context.captures_summary : [];
  if (!ns.length) return null;
  for (const row of ns) {
    if (!row || !row.namespace) continue;
    const name = String(row.namespace).toLowerCase();
    if (normalized.includes(' ' + name) || normalized.endsWith(' ' + name) || normalized.includes("'" + name + "'") || normalized.includes('"' + name + '"')) {
      return row.namespace;
    }
  }
  // Also look for "namespace <name>" literal anywhere
  const m = normalized.match(/namespace\s+["'`]?([\w.\-:/]+)["'`]?/);
  if (m) return m[1];
  return null;
}

// ---------------------------------------------------------------------------
// Snapshot helpers used by `kolm what` and `kolm next`.
//
// These are NOT pure — they read disk. Kept here next to the classifier so the
// dispatcher in cli/kolm.js stays thin.
// ---------------------------------------------------------------------------

export async function snapshotContext({ cwd = process.cwd(), home = null } = {}) {
  // When caller passes home explicitly, treat as a sandbox: skip the
  // capture-store probe (which reads from a process-wide SQLite path that
  // is not parameterized by HOME). This keeps tests deterministic.
  const SANDBOX_MODE = home != null;
  const HOME = home || (process.env.KOLM_HOME || (await import('node:os')).homedir());
  const KOLM_DIR = path.join(HOME, '.kolm');
  const ARTIFACTS_DIR = path.join(KOLM_DIR, 'artifacts');
  const JOBS_PATH = path.join(KOLM_DIR, 'jobs.jsonl');

  const out = {
    cwd,
    home: HOME,
    artifacts: [],
    captures_summary: [],
    jobs: [],
    config: null,
    current_tenant: null,
    counts: { artifacts: 0, captures: 0, namespaces: 0, jobs: 0 },
    generated_at: new Date().toISOString(),
  };

  // Local artifacts under ~/.kolm/artifacts/ AND in cwd.
  const seenArt = new Set();
  const addArt = (p) => {
    try {
      const abs = path.resolve(p);
      if (seenArt.has(abs)) return;
      seenArt.add(abs);
      const st = fs.statSync(abs);
      out.artifacts.push({
        name: path.basename(abs),
        path: abs,
        size_bytes: st.size,
        modified: st.mtime.toISOString(),
      });
    } catch (_) { /* skip */ }
  };
  if (fs.existsSync(ARTIFACTS_DIR)) {
    try {
      for (const f of fs.readdirSync(ARTIFACTS_DIR)) {
        if (f.endsWith('.kolm')) addArt(path.join(ARTIFACTS_DIR, f));
      }
    } catch (_) {}
  }
  try {
    for (const f of fs.readdirSync(cwd)) {
      if (f.endsWith('.kolm')) addArt(path.join(cwd, f));
    }
  } catch (_) {}
  out.counts.artifacts = out.artifacts.length;

  // Enrich each artifact with manifest metadata if we can read it.
  for (const a of out.artifacts) {
    try {
      const mod = await import('./artifact-runner.js');
      const bundle = mod.loadArtifact(a.path);
      const m = bundle.manifest || {};
      a.task = m.task || null;
      a.k_score = m.k_score?.composite ?? null;
      a.production_ready = m.production_ready === true;
      a.base_model = m.base_model || null;
      a.runtime = m.runtime || m.runtime_target || null;
      a.created_at = m.created_at || null;
      a.artifact_class = m.artifact_class || null;
    } catch (_) { /* leave bare */ }
  }

  // Jobs
  if (fs.existsSync(JOBS_PATH)) {
    try {
      const lines = fs.readFileSync(JOBS_PATH, 'utf8').split('\n').filter(Boolean);
      for (const l of lines) {
        try { out.jobs.push(JSON.parse(l)); } catch (_) {}
      }
    } catch (_) {}
  }
  // Also support the per-job-file layout from src/jobs.js (jobs/*.json).
  const JOBS_DIR = path.join(KOLM_DIR, 'jobs');
  if (fs.existsSync(JOBS_DIR)) {
    try {
      for (const f of fs.readdirSync(JOBS_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8'));
          out.jobs.push(j);
        } catch (_) {}
      }
    } catch (_) {}
  }
  out.counts.jobs = out.jobs.length;

  // Config (for current_tenant)
  const CONFIG_PATH = path.join(KOLM_DIR, 'config.json');
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      out.config = { base: c.base || null, api_key: c.api_key ? c.api_key.slice(0, 6) + '...' : null };
      if (c.tenant) out.current_tenant = c.tenant;
    } catch (_) {}
  }

  // Capture-namespace summary. Best-effort: try src/capture-store.allCapturesForTenant
  // when a tenant + driver are reachable, else read the JSON store directly.
  // In SANDBOX_MODE (caller passed an isolated HOME), skip this probe — the
  // capture store reads from a process-wide path that the HOME override does
  // not isolate.
  if (!SANDBOX_MODE) {
    try {
      const captureStore = await import('./capture-store.js');
      // We only want a namespace-aggregated summary, so we use the in-process
      // path. If a driver is configured and there's no tenant, we still get an
      // empty list — that's fine, we'll fall through to the JSON-store reader.
      const tenant = (out.current_tenant && (out.current_tenant.id || out.current_tenant)) || 'local';
      let rows = [];
      try { rows = await captureStore.allCapturesForTenant(tenant, 50000); } catch (_) {}
      if (rows && rows.length) {
        out.captures_summary = aggregateNamespaces(rows);
      }
    } catch (_) { /* capture-store not usable in this context */ }
  }

  // Fallback to reading the on-disk observations table (JSON store) directly.
  // We respect the `cwd` parameter (so tests can override) and only fall back
  // to process.cwd() if no caller-supplied cwd was given.
  if (out.captures_summary.length === 0) {
    const cwdForFallback = cwd || process.cwd();
    const candidates = [
      process.env.KOLM_DATA_DIR ? path.join(process.env.KOLM_DATA_DIR, 'observations.json') : null,
      path.join(KOLM_DIR, 'data', 'observations.json'),
      path.join(cwdForFallback, 'data', 'observations.json'),
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
        const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(rows) && rows.length) {
          out.captures_summary = aggregateNamespaces(rows);
          break;
        }
      } catch (_) {}
    }
  }
  out.counts.captures = out.captures_summary.reduce((s, r) => s + r.count, 0);
  out.counts.namespaces = out.captures_summary.length;
  return out;
}

function aggregateNamespaces(rows) {
  const agg = new Map();
  for (const r of rows) {
    if (!r) continue;
    const ns = r.corpus_namespace || r.namespace || 'default';
    const cur = agg.get(ns) || { namespace: ns, count: 0, last_seen: null };
    cur.count += 1;
    const t = r.captured_at || r.created_at || r.t || null;
    if (t && (!cur.last_seen || t > cur.last_seen)) cur.last_seen = t;
    agg.set(ns, cur);
  }
  return [...agg.values()].sort((a, b) => b.count - a.count);
}

// Recommend the next best action. Returns an array of {action, command, why,
// rank} entries ordered by rank descending. The rank scoring is deterministic.
export function recommendNext(snapshot) {
  const recs = [];
  const totalCaptures = snapshot.counts.captures;
  const totalArtifacts = snapshot.counts.artifacts;
  const arts = snapshot.artifacts || [];
  const ns = snapshot.captures_summary || [];

  if (!snapshot.config || !snapshot.config.api_key) {
    recs.push({
      action: 'login',
      command: 'kolm login',
      why: 'no API key in ~/.kolm/config.json — login first so cloud verbs work.',
      rank: 100,
    });
  }
  if (totalArtifacts === 0) {
    recs.push({
      action: 'build_first_artifact',
      command: 'kolm build my-first-artifact',
      why: 'no .kolm artifacts found yet — the one-shot build verb scaffolds, compiles, and verifies in one step.',
      rank: 95,
    });
  } else {
    // Pick the lowest-K-score artifact and suggest re-evaluating.
    const ranked = arts.filter(a => typeof a.k_score === 'number').sort((a, b) => a.k_score - b.k_score);
    if (ranked.length) {
      const worst = ranked[0];
      if (worst.k_score < 0.85) {
        recs.push({
          action: 'fix_low_kscore',
          command: `kolm fix ${path.basename(worst.path)}`,
          why: `${path.basename(worst.path)} is at K=${worst.k_score.toFixed(2)} (below the 0.85 gate). \`kolm fix\` will surface failing cases.`,
          rank: 90,
        });
      } else {
        recs.push({
          action: 'ship_top_artifact',
          command: `kolm publish ${path.basename(arts[0].path)}`,
          why: `${path.basename(arts[0].path)} is ready. Publish it so others (and frontier agents via MCP) can use it.`,
          rank: 50,
        });
      }
    }
  }
  // Captures: any namespace with >= 1000 pairs is distill-ready.
  const ready = ns.filter(n => n.count >= 1000);
  if (ready.length) {
    const top = ready[0];
    recs.push({
      action: 'distill_ready_namespace',
      command: `kolm distill --from-captures --namespace ${top.namespace}`,
      why: `namespace '${top.namespace}' has ${top.count} captured pairs — past the distill threshold. Auto-distill builds a specialist LoRA.`,
      rank: 92,
    });
  } else if (ns.length) {
    const top = ns[0];
    recs.push({
      action: 'monitor_captures',
      command: `kolm tail captures --namespace ${top.namespace}`,
      why: `namespace '${top.namespace}' has ${top.count} pairs (need 1000 for auto-distill). Tail to monitor inflow.`,
      rank: 60,
    });
  } else if (totalCaptures === 0 && totalArtifacts > 0) {
    recs.push({
      action: 'enable_capture',
      command: 'kolm capture --provider openai --as proxy',
      why: 'you have artifacts but no captures. Enable the proxy to log (input, output) pairs you can distill from.',
      rank: 70,
    });
  }
  // Jobs in flight
  const running = (snapshot.jobs || []).filter(j => j && (j.status === 'running' || j.status === 'queued'));
  if (running.length) {
    recs.push({
      action: 'watch_running_job',
      command: `kolm watch ${running[0].id}`,
      why: `${running.length} background job(s) still running — \`kolm watch\` tails the live log.`,
      rank: 80,
    });
  }
  // Always-available baseline.
  recs.push({
    action: 'show_dashboard',
    command: 'kolm what',
    why: 'one-screen dashboard of artifacts, captures, and jobs.',
    rank: 10,
  });
  recs.sort((a, b) => b.rank - a.rank);
  return recs.slice(0, 3);
}

export default {
  VERB_DESCRIPTIONS,
  listVerbs,
  classifyIntent,
  snapshotContext,
  recommendNext,
};
