// Natural-language entry point. Takes a free-text prompt from an authed user
// and parses it into one of a small set of intents. Deterministic, rule-based:
// no LLM round-trip required, no telemetry leaves the box. Lives inside auth
// so all reads/writes are scoped to req.tenant_record.
//
// Intents:
//   status      - account snapshot (plan, quota, used)
//   usage       - same as status but framed "how much have i used"
//   list        - list compiled concepts / artifacts for this tenant
//   compile     - REAL compile - creates and runs a compile job. Returns the
//                 job id + poll URL + artifact URL when complete.
//   job_status  - look up a known compile job by id (Poll /v1/compile/job_xxx,
//                 "status of job_xxx", or bare "job_xxx"). Returns live state.
//   run         - run a previously-compiled concept by id or name
//   tune        - explain how to start a local tune loop (airgap CLI verb)
//   evolve      - alias for tune
//   install     - explain `kolm install <harness>` for claude-code/cursor/etc.
//   upgrade     - start a plan-change to pro/teams/business/enterprise
//   help        - menu of what i can do
//   doctor      - return a health/config snapshot for this account
//
// Output is always:
//   { ok, intent, narration, data?, next_steps? }
// narration is short, plain text suitable for a chat bubble. data is the raw
// structured payload (artifact list, account record, billing url) so the UI
// can render cards alongside the bubble.

import { all, findOne } from './store.js';

const PRO_PLANS = new Set(['starter', 'pro', 'teams', 'business', 'enterprise']);

// `job_xxxxxxxxxxxx` is the shape createJob() emits (job_ + 12 hex chars).
// Loosened to 6+ hex so older/test ids still match.
const JOB_ID_RE = /\bjob_[0-9a-f]{6,}\b/i;

function lc(s) { return String(s || '').toLowerCase(); }
function trim(s) { return String(s || '').trim(); }

// Pull a job_xxx id out of a prompt. Works on bare ids, "status of job_xxx",
// "check job_xxx", and pasted poll URLs like "/v1/compile/job_xxx".
function extractJobId(prompt) {
  const m = String(prompt || '').match(JOB_ID_RE);
  return m ? m[0] : null;
}

function detectIntent(prompt) {
  const p = lc(prompt);
  if (!p) return 'help';
  // Order matters: more specific first.
  // A prompt containing a job_xxx id is ALWAYS a status query, never a new
  // compile. This catches the dashboard's own poll-suggestion strings like
  // "Poll /v1/compile/job_xxx for progress". Without this, every Poll
  // copy-paste fires a fresh compile (the URL contains the word "compile").
  if (JOB_ID_RE.test(p)) return 'job_status';
  if (/^(help|hi|hello|hey|what can you do|what do you do)\b/.test(p)) return 'help';
  if (/\b(doctor|debug|why( is| 's|s) it broken|whats wrong|health check)\b/.test(p)) return 'doctor';
  if (/\b(usage|how much (have i|did i)|left in (my )?quota|consumed|burning)\b/.test(p)) return 'usage';
  if (/\b(status|account|where am i|am i on|what plan)\b/.test(p)) return 'status';
  if (/\b(list|show|all my|what (have i|did i) (build|compile|ship))\b/.test(p)) return 'list';
  if (/\b(upgrade|go pro|move to pro|switch to|change plan)\b/.test(p)) return 'upgrade';
  if (/\b(install|wire up|hook up|claude code|cursor|continue|cline)\b/.test(p)) return 'install';
  // Prefer compile when the prompt explicitly says "compile", even if a word
  // like "train" appears later in the same sentence (very common shape:
  // "compile a redactor using train.jsonl"). Without this, the tune branch
  // would steal compile prompts whenever the filename contains "train".
  if (/\bcompile\b/.test(p)) return 'compile';
  // Exclude filename matches like "train.jsonl" / "tune.yaml" via a negative
  // lookahead on a dot-extension. Real tune verbs are followed by whitespace
  // or end-of-string, not by a file extension.
  if (/\b(tune|train|evolve|fine ?tune|fine ?tuning)\b(?!\.\w)/.test(p)) return 'tune';
  if (/\b(run|execute|invoke|call)\b/.test(p)) return 'run';
  if (/\b(compile|build|make|create|new)\b/.test(p)) return 'compile';
  return 'help';
}

function extractTask(prompt) {
  // Strip leading verb fragments to get the actual task. "compile a recipe
  // that redacts secrets" -> "redacts secrets".
  return trim(prompt)
    .replace(/^(please\s+)?(compile|build|make|create|new)\s+(me\s+)?(a\s+|an\s+)?(recipe\s+|concept\s+|artifact\s+|kolm\s+)?(that\s+|to\s+|for\s+|which\s+)?/i, '')
    .replace(/^[a-z\- ]{1,20}\s+to\s+/i, '');
}

function extractTargetPlan(prompt) {
  const p = lc(prompt);
  for (const plan of ['enterprise', 'business', 'teams', 'pro', 'starter']) {
    if (p.includes(plan)) return plan;
  }
  return 'pro';
}

function extractHarness(prompt) {
  const p = lc(prompt);
  for (const h of ['claude-code', 'claude code', 'cursor', 'continue', 'cline']) {
    if (p.includes(h)) return h.replace(' ', '-');
  }
  return null;
}

function extractConcept(prompt) {
  // pick the last token that looks like an id or name
  const tokens = trim(prompt).split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (!last) return null;
  if (/^cpt_/.test(last)) return last;
  if (last.length >= 3 && last.length <= 64) return last;
  return null;
}

function listConcepts(tenantId) {
  const c = all('concepts');
  return c
    .filter(x => !x._deleted && x.tenant_id === tenantId)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, 30)
    .map(x => ({
      id: x.id,
      name: x.name,
      created_at: x.created_at,
      k_score: x.k_score ?? null,
      pass_rate: x.pass_rate_positive ?? null,
      latency_p50_us: x.latency_p50_us ?? null,
    }));
}

export async function handleAssistant(req, _res, deps) {
  const tenant = req.tenant_record;
  const prompt = String((req.body || {}).prompt || '').slice(0, 2000);
  const intent = detectIntent(prompt);

  switch (intent) {
    case 'help':
      return {
        ok: true,
        intent,
        narration: 'I can manage your local builds without leaving this page. Try one of: "what is my status", "show my builds", "compile a recipe that redacts secrets", "run cpt_xxx hello", "tune", "install claude-code", "upgrade to pro".',
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
        intent,
        narration: `You're on the ${tenant.plan || 'free'} plan. ${tenant.used || 0} of ${tenant.quota || 0} units used this period. ${Math.max(0, (tenant.quota || 0) - (tenant.used || 0))} remaining.`,
        data: {
          plan: tenant.plan,
          quota: tenant.quota,
          used: tenant.used,
          remaining: Math.max(0, (tenant.quota || 0) - (tenant.used || 0)),
          tenant_id: tenant.id,
          email: tenant.email,
        },
      };

    case 'list': {
      const items = listConcepts(tenant.id);
      const narration = items.length === 0
        ? 'No builds yet. Try "compile a recipe that does <task>" to create your first one.'
        : `${items.length} build${items.length === 1 ? '' : 's'}. Most recent first.`;
      return { ok: true, intent, narration, data: { items } };
    }

    case 'job_status': {
      // Pasted poll URL, bare job id, or "status of job_xxx". Look up the
      // job and return live state. Never creates a new job.
      const jobId = extractJobId(prompt);
      if (!jobId) {
        return { ok: false, intent, narration: 'Could not parse a job id. Job ids look like job_abcdef123456.' };
      }
      const lookup = deps && typeof deps.lookupJob === 'function' ? deps.lookupJob : null;
      const j = lookup ? lookup({ tenant, job_id: jobId }) : null;
      if (!j) {
        return {
          ok: false,
          intent,
          narration: `Job ${jobId} not found in your account. Try "show my builds".`,
          data: { job_id: jobId, status: 'not_found' },
        };
      }
      const done = j.status === 'completed';
      const failed = j.status === 'failed';
      const pct = typeof j.progress === 'number' ? Math.round(j.progress) : null;
      // k_score can be a plain number (legacy) or a breakdown object whose
      // .composite is the real headline number. Handle both shapes.
      const kNum = (typeof j.k_score === 'number')
        ? j.k_score
        : (j.k_score && typeof j.k_score.composite === 'number')
          ? j.k_score.composite
          : null;
      const kStr = kNum != null ? kNum.toFixed(4) : null;
      const artifactUrl = done ? `/v1/compile/${j.id}/.kolm` : null;
      const narration = done
        ? `Job ${j.id} done. K-score ${kStr || '-'}. Artifact ready at ${artifactUrl}.`
        : failed
          ? `Job ${j.id} failed: ${j.error || 'unknown error'}.`
          : `Job ${j.id} is ${j.status}${pct != null ? ` (${pct}%)` : ''}. ${j.stages && j.stages.length ? `Last stage: ${j.stages[j.stages.length - 1].name}.` : ''}`;
      const data = {
        job_id: j.id,
        status: j.status,
        progress: j.progress || 0,
        // Surface a flat numeric k_score so the dashboard chat dock's
        // existing typeof-number check renders "K=0.84" rather than [object].
        k_score: kNum,
        k_score_full: j.k_score || null,
        stages: j.stages || [],
        artifact_url: artifactUrl,
        poll: `/v1/compile/${j.id}`,
        error: j.error || null,
      };
      const steps = done
        ? [
            { label: 'download .kolm', href: artifactUrl },
            { label: 'view job',       href: '/dashboard#compile-' + j.id },
          ]
        : failed
          ? [ { label: 'open /train', href: '/train' } ]
          : [ { label: 'view job', href: `/v1/compile/${j.id}` } ];
      return { ok: true, intent, narration, data, next_steps: steps };
    }

    case 'compile': {
      const task = extractTask(prompt);
      if (!task || task.length < 4) {
        return {
          ok: false,
          intent,
          narration: 'Tell me what the recipe should do. Example: "compile a recipe that classifies support tickets by urgency".',
        };
      }
      // Real compile — creates a compile job, runs it (sync on serverless,
      // fire-and-forget on long-running nodes). Caller polls `data.poll`.
      const out = await deps.compile({ task });
      const done = out.status === 'completed';
      // k_score may arrive as a number (legacy) or breakdown object.
      const outKNum = (typeof out.k_score === 'number')
        ? out.k_score
        : (out.k_score && typeof out.k_score.composite === 'number')
          ? out.k_score.composite
          : null;
      const outKStr = outKNum != null ? outKNum.toFixed(4) : '-';
      const narration = done
        ? `Compiled. job ${out.job_id} · K-score ${outKStr}. Artifact ready at ${out.artifact_url}.`
        : `Compile started. job ${out.job_id} · status: ${out.status}. Watching for progress.`;
      const steps = done
        ? [
            { label: 'download .kolm', href: out.artifact_url },
            { label: 'view job',       href: '/dashboard#compile-' + out.job_id },
          ]
        : [
            { label: 'view job',  href: out.poll },
            { label: 'dashboard', href: '/dashboard' },
          ];
      return { ok: true, intent, narration, data: out, next_steps: steps };
    }

    case 'run': {
      const cid = extractConcept(prompt);
      if (!cid) {
        return { ok: false, intent, narration: 'Tell me which concept to run. Example: "run cpt_xxx hello world".' };
      }
      const concept = findOne('concepts', x => x.id === cid && x.tenant_id === tenant.id);
      if (!concept) {
        return { ok: false, intent, narration: `Concept ${cid} not found in your account. Try "show my builds".` };
      }
      // Use the prompt tail (everything after the concept id) as input.
      const idx = prompt.toLowerCase().indexOf(cid.toLowerCase());
      const input = idx >= 0 ? trim(prompt.slice(idx + cid.length)) : 'hello';
      const r = await deps.run({ tenant, concept_id: cid, input: input || 'hello' });
      return {
        ok: !!r?.output,
        intent,
        narration: r?.output
          ? `Output: ${String(r.output).slice(0, 280)}${r.cache === 'hit' ? ' (cache hit)' : ''}`
          : 'Run failed. Open /run for the guided runner.',
        data: r,
      };
    }

    case 'tune':
    case 'evolve':
      return {
        ok: true,
        intent: 'tune',
        narration: 'Tune is a local CLI loop — the trainer never leaves your laptop. Run: kolm tune init && kolm tune capture-on && kolm tune step --airgap. The dashboard shows promoted revisions when you push them back. See /evolve for the full pipeline.',
        next_steps: [
          { label: 'open /evolve', href: '/evolve' },
          { label: 'docs/TUNE.md', href: '/docs' },
        ],
      };

    case 'install': {
      const h = extractHarness(prompt);
      if (!h) {
        return {
          ok: true,
          intent,
          narration: 'Which harness? Supported: claude-code, cursor, continue, cline. Run: kolm install <harness> --apply',
          next_steps: [
            { label: 'claude-code', prompt: 'install claude-code' },
            { label: 'cursor',      prompt: 'install cursor' },
            { label: 'continue',    prompt: 'install continue' },
            { label: 'cline',       prompt: 'install cline' },
          ],
        };
      }
      return {
        ok: true,
        intent,
        narration: `Run: kolm install ${h} --apply. That writes the hooks + MCP config so ${h} discovers your .kolm artifacts automatically. See /docs for what gets written.`,
        data: { harness: h, command: `kolm install ${h} --apply` },
      };
    }

    case 'upgrade': {
      const target = extractTargetPlan(prompt);
      const billing = await deps.changePlan({ tenant, target });
      return {
        ok: true,
        intent,
        narration: billing?.billing_url
          ? `Open the secure billing link to switch to ${target}. Plan flips when payment clears.`
          : billing?.error === 'billing_not_configured'
            ? `${target} billing is not yet wired in. Mail founders@kolm.ai and we'll set you up directly.`
            : `Plan changed to ${billing?.plan || target}.`,
        data: billing,
      };
    }

    case 'doctor': {
      const items = listConcepts(tenant.id);
      const lines = [];
      lines.push(`plan: ${tenant.plan || 'free'}`);
      lines.push(`builds: ${items.length}`);
      lines.push(`used / quota: ${tenant.used || 0} / ${tenant.quota || 0}`);
      lines.push(`receipts: signed via rs-1`);
      lines.push(`local CLI: see /docs (kolm doctor)`);
      return {
        ok: true,
        intent,
        narration: lines.join('\n'),
        data: { plan: tenant.plan, builds: items.length, used: tenant.used, quota: tenant.quota },
      };
    }

    default:
      return { ok: true, intent: 'help', narration: 'I am not sure what you meant. Try "help".' };
  }
}

// ---------- scaffoldRecipeFromNl (Wave 197) ----------
//
// Free-text request -> structured recipe scaffold ready to drop into
// public/docs/showcase/<slug>.spec.json + models/<slug>/seeds.jsonl.
//
// This is the backend the `kolm nl` CLI verb routes to. Air-gap mode
// (airGap:true) is deterministic and never calls a network: classification
// is a keyword match over the input text, and seed examples are emitted
// from a small template library. Networked mode is NOT YET WIRED: the
// scaffolder always returns the air-gap output and stamps
// `network_status: 'not_yet_wired'` on the result so callers know.
//
// Returns:
//   {
//     suggested_slug,
//     suggested_task_description,
//     recipe_class,                // one of RECIPE_CLASSES
//     suggested_k_score_gate,      // 0.5 .. 0.99
//     suggested_seed_examples,     // length-10 [{prompt, completion}]
//     next_steps: [string],
//     class_inference_basis,       // 'class_hint' | 'keyword:<word>' | 'default'
//     network_status,              // 'air_gap' | 'not_yet_wired'
//   }

const NL_RECIPE_CLASSES = ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'];

// Keyword -> recipe-class inference table. Ordered: first match wins.
// Honest mapping: parsing structured formats (EDI / FHIR / CSV / regex /
// lookup tables) -> rule. Computing standard measures with a spec but
// emitted by an LLM -> synthesized_rule. Compiled/native -> compiled_rule.
// Free-form generation (drafting prose, summarizing) -> distilled_model.
const NL_CLASS_KEYWORDS = [
  // distilled_model first: generative requests need real model bytes
  { class: 'distilled_model', words: ['draft', 'write a', 'compose', 'generate prose', 'generate text', 'summari', 'paraphrase', 'rewrite', 'explain', 'translate', 'appeal letter', 'reply to', 'respond to', 'narrative'] },
  // compiled_rule: explicit native / wasm / C / Rust / binary
  { class: 'compiled_rule', words: ['native', 'wasm', 'c99', 'rust', 'compiled binary', 'binary recipe', 'lowered to'] },
  // synthesized_rule: known measures / specs where teacher emits rule code
  { class: 'synthesized_rule', words: ['hedis', 'cpt code', 'icd-10 lookup', 'ndc lookup', 'compute measure', 'compute hedis', 'compute the', 'apply spec', 'measure'] },
  // rule: deterministic parsers, redactors, validators, classifiers, transformers
  { class: 'rule', words: ['parse', 'parser', 'redact', 'redactor', 'normalize', 'validator', 'validate', 'extract', 'classify', 'classifier', 'edi', '837', '835', '834', '270', '271', '278', 'x12', 'fhir', 'route by', 'lookup'] },
];

function nlSlugify(s, max = 48) {
  const out = String(s || '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return out || 'untitled-recipe';
}

function nlInferClass(text, classHint) {
  if (classHint && NL_RECIPE_CLASSES.includes(classHint)) {
    return { class: classHint, basis: 'class_hint' };
  }
  const t = String(text || '').toLowerCase();
  for (const row of NL_CLASS_KEYWORDS) {
    for (const w of row.words) {
      if (t.includes(w)) return { class: row.class, basis: `keyword:${w}` };
    }
  }
  // Default: rule. Honest floor: if nothing matched, recipe is the
  // simplest thing that could work and the user is expected to upgrade
  // the class explicitly once they need teacher / weights.
  return { class: 'rule', basis: 'default' };
}

// Gate thresholds tied to class severity. Stricter floor for higher
// classes because they carry more cost (teacher / weights / native).
function nlSuggestKScoreGate(klass) {
  if (klass === 'distilled_model') return 0.85;
  if (klass === 'compiled_rule')   return 0.92;
  if (klass === 'synthesized_rule')return 0.90;
  return 0.88; // rule
}

// Deterministic seed-example library. Returns exactly 10 {prompt, completion}
// pairs. Pulls a templated batch based on the inferred class so the seeds
// look at least adjacent to what the user asked for. Pure function of
// (text, class): same inputs always produce same outputs.
function nlBuildSeedExamples(text, klass) {
  const t = String(text || '').slice(0, 200);
  // Library of starter pairs per class. The point is to give the user a
  // schema to overwrite, not to produce a working dataset.
  const libs = {
    rule: [
      { prompt: 'input row 1', completion: '{ "ok": true, "parsed": {} }' },
      { prompt: 'input row 2', completion: '{ "ok": true, "parsed": {} }' },
      { prompt: 'empty input', completion: '{ "ok": false, "error": "empty_input" }' },
      { prompt: 'malformed input', completion: '{ "ok": false, "error": "parse_failed" }' },
      { prompt: 'header row', completion: '{ "ok": true, "kind": "header" }' },
      { prompt: 'trailer row', completion: '{ "ok": true, "kind": "trailer" }' },
      { prompt: 'duplicate row', completion: '{ "ok": true, "duplicate": true }' },
      { prompt: 'oversized input', completion: '{ "ok": false, "error": "too_large" }' },
      { prompt: 'control characters', completion: '{ "ok": true, "warnings": ["control_chars_stripped"] }' },
      { prompt: 'unicode input', completion: '{ "ok": true, "encoding": "utf8" }' },
    ],
    synthesized_rule: [
      { prompt: 'spec input case 1', completion: '{ "result": 0, "passed": true }' },
      { prompt: 'spec input case 2', completion: '{ "result": 1, "passed": true }' },
      { prompt: 'spec input case 3', completion: '{ "result": 0, "passed": false }' },
      { prompt: 'edge: missing field', completion: '{ "result": null, "error": "missing_required_field" }' },
      { prompt: 'edge: out of range', completion: '{ "result": null, "error": "out_of_range" }' },
      { prompt: 'edge: deprecated code', completion: '{ "result": null, "warning": "deprecated_code" }' },
      { prompt: 'positive control', completion: '{ "result": 1, "passed": true }' },
      { prompt: 'negative control', completion: '{ "result": 0, "passed": false }' },
      { prompt: 'boundary lower', completion: '{ "result": 0, "passed": true }' },
      { prompt: 'boundary upper', completion: '{ "result": 1, "passed": true }' },
    ],
    compiled_rule: [
      { prompt: 'native input 1', completion: '{ "ok": true, "binary": "ok" }' },
      { prompt: 'native input 2', completion: '{ "ok": true, "binary": "ok" }' },
      { prompt: 'edge case 1', completion: '{ "ok": false, "error": "edge_1" }' },
      { prompt: 'edge case 2', completion: '{ "ok": false, "error": "edge_2" }' },
      { prompt: 'perf case 1', completion: '{ "ok": true, "latency_us": 10 }' },
      { prompt: 'perf case 2', completion: '{ "ok": true, "latency_us": 12 }' },
      { prompt: 'determinism check', completion: '{ "ok": true, "deterministic": true }' },
      { prompt: 'platform check', completion: '{ "ok": true, "platform": "any" }' },
      { prompt: 'wasm check', completion: '{ "ok": true, "runtime": "wasm" }' },
      { prompt: 'native check', completion: '{ "ok": true, "runtime": "native" }' },
    ],
    distilled_model: [
      { prompt: 'sample request 1', completion: 'sample response 1' },
      { prompt: 'sample request 2', completion: 'sample response 2' },
      { prompt: 'sample request 3', completion: 'sample response 3' },
      { prompt: 'sample request 4', completion: 'sample response 4' },
      { prompt: 'sample request 5', completion: 'sample response 5' },
      { prompt: 'sample request 6', completion: 'sample response 6' },
      { prompt: 'sample request 7', completion: 'sample response 7' },
      { prompt: 'sample request 8', completion: 'sample response 8' },
      { prompt: 'sample request 9', completion: 'sample response 9' },
      { prompt: 'sample request 10', completion: 'sample response 10' },
    ],
  };
  const base = libs[klass] || libs.rule;
  // Annotate the first prompt with a verbatim slice of the user's request
  // so the scaffold is not 100% generic. Determinism preserved: same input
  // text -> same prompt[0].
  const out = base.map((p, i) => ({ prompt: p.prompt, completion: p.completion }));
  if (t) {
    out[0] = { prompt: `request: ${t}`, completion: out[0].completion };
  }
  return out;
}

function nlBuildNextSteps(klass, slug) {
  const steps = [
    `write models/${slug}/seeds.jsonl by editing suggested_seed_examples`,
    `write public/docs/showcase/${slug}.spec.json from suggested_task_description + recipe_class`,
    `kolm compile --spec public/docs/showcase/${slug}.spec.json`,
    `kolm verify ${slug}.kolm`,
  ];
  if (klass === 'distilled_model') {
    steps.splice(2, 0, 'kolm capture --provider <p> --as <ns>  (or set teacher_vendor in spec)');
  } else if (klass === 'synthesized_rule') {
    steps.splice(2, 0, 'set teacher_vendor in spec.json (synthesized_rule requires teacher attribution)');
  } else if (klass === 'compiled_rule') {
    steps.splice(2, 0, 'add compiled_targets: ["wasm32-wasi"] or ["x86_64-linux"] to spec.json');
  }
  steps.push('refine + verify before compile: scaffolds are starting points, not finished recipes');
  return steps;
}

export function scaffoldRecipeFromNl(opts) {
  const o = opts || {};
  const text = String(o.text || '').trim();
  const classHint = o.classHint || null;
  const airGap = !!o.airGap;
  if (!text) {
    return {
      ok: false,
      error: 'empty_input',
      narration: 'scaffoldRecipeFromNl: text is required',
    };
  }
  const inferred = nlInferClass(text, classHint);
  const klass = inferred.class;
  const slug = nlSlugify(text);
  const gate = nlSuggestKScoreGate(klass);
  const seeds = nlBuildSeedExamples(text, klass);
  const steps = nlBuildNextSteps(klass, slug);
  return {
    ok: true,
    suggested_slug: slug,
    suggested_task_description: text,
    recipe_class: klass,
    suggested_k_score_gate: gate,
    suggested_seed_examples: seeds,
    next_steps: steps,
    class_inference_basis: inferred.basis,
    network_status: airGap ? 'air_gap' : 'not_yet_wired',
    note: 'scaffolds are starting points. refine + verify before compile.',
  };
}
