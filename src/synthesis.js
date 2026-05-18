// Synthesis layer.
// Two paths:
//   1. Claude path — when ANTHROPIC_API_KEY is set, ask Claude for a JS generator.
//   2. Pattern path — deterministic rule-based synthesis from positive/negative examples.
// Both produce JS source. Both pass through the same verifier and quality gate.

import 'dotenv/config';
import { libraryDescription, subroutines } from './library.js';
import { compileJs, verify, hashSource, QUALITY_GATE } from './verifier.js';
import { generateVariations as llmGenerateVariations, isConfigured as llmIsConfigured, describeConfig as llmDescribe } from './llm-call.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';

let anthropicClient = null;
async function client() {
  if (!ANTHROPIC_KEY) return null;
  if (anthropicClient) return anthropicClient;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  anthropicClient = new Anthropic({ apiKey: ANTHROPIC_KEY });
  return anthropicClient;
}

const SYSTEM_PROMPT = `You synthesize tiny, deterministic JavaScript "generators" that map an input to a concept's full output.

CONTRACT
- Output a SINGLE JS source string.
- Define exactly: function generate(input, lib) { ... return output; }
- No imports. No I/O. No global state. No randomness. Pure function only.
- Use the subroutine library \`lib\` when helpful — it dramatically shrinks generators.
- Keep generators under 2 KB. Smaller is better.
- Be exact about the output_spec.

LIBRARY (already bound as \`lib\`)
${libraryDescription()}

OUTPUT FORMAT
Return ONLY the JS source for the function. No markdown fences, no commentary, no preamble.`;

export async function synthesize(opts) {
  return synthesizeStream(opts, () => {});
}

// Streaming variant: emits SSE-style events through `emit(event, payload)`.
// Returns the same final shape as synthesize().
export async function synthesizeStream({ positives, negatives = [], output_spec, priors = {} }, emit) {
  const startedAt = Date.now();
  const attempts = [];

  const strategies = [];
  if (await client()) strategies.push('claude');
  strategies.push('pattern');
  emit('plan', { strategies });

  for (const strategy of strategies) {
    emit('strategy_begin', { strategy });
    const candidates = await produceCandidates(strategy, { positives, negatives, output_spec, priors }, emit);
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      emit('candidate', { strategy, idx: i, size_bytes: Buffer.byteLength(cand.source, 'utf8') });
      try {
        const compiled = compileJs(cand.source);
        const result = verify(compiled, { positives, negatives, property_tests: priors.property_tests || [] });
        emit('verified', {
          strategy, idx: i,
          quality_score: result.quality_score,
          pass_rate_positive: result.pass_rate_positive,
          reject_rate_negative: result.reject_rate_negative,
          latency_p50_us: result.latency_p50_us,
        });
        attempts.push({ strategy, source: cand.source, result, prompt: cand.prompt });
        if (result.quality_score >= QUALITY_GATE && result.pass_rate_positive >= 0.85) {
          const f = finalize(cand.source, result, strategy, attempts, startedAt);
          emit('accepted', { strategy, quality_score: f.quality_score, size_bytes: f.size_bytes });
          return f;
        }
      } catch (e) {
        emit('compile_error', { strategy, idx: i, error: String(e.message || e) });
        attempts.push({ strategy, source: cand.source, error: String(e.message || e) });
      }
    }
    emit('strategy_end', { strategy, attempts: candidates.length });
  }

  // Below quality gate: return the best attempt with `accepted: false`.
  const best = attempts
    .filter(a => a.result)
    .sort((a, b) => b.result.quality_score - a.result.quality_score)[0];

  if (!best) {
    return {
      accepted: false,
      reason: 'no candidate compiled',
      attempts: attempts.map(a => ({ strategy: a.strategy, error: a.error })),
      duration_ms: Date.now() - startedAt,
    };
  }

  return {
    accepted: false,
    reason: `quality ${best.result.quality_score} below gate ${QUALITY_GATE}`,
    best_source: best.source,
    best_result: best.result,
    strategy: best.strategy,
    attempts_n: attempts.length,
    duration_ms: Date.now() - startedAt,
  };
}

function finalize(source, result, strategy, attempts, startedAt) {
  return {
    accepted: true,
    source,
    quality_score: result.quality_score,
    pass_rate_positive: result.pass_rate_positive,
    reject_rate_negative: result.reject_rate_negative,
    latency_p50_us: result.latency_p50_us,
    size_bytes: Buffer.byteLength(source, 'utf8'),
    source_hash: hashSource(source),
    strategy,
    test_trace: result.trace,
    attempts_n: attempts.length,
    duration_ms: Date.now() - startedAt,
  };
}

async function produceCandidates(strategy, ctx, emit = () => {}) {
  if (strategy === 'claude') return claudeCandidates(ctx, emit);
  if (strategy === 'pattern') return patternCandidates(ctx);
  return [];
}

async function claudeCandidates({ positives, negatives, output_spec, priors }, emit = () => {}) {
  const c = await client();
  if (!c) return [];
  const userMsg = `OUTPUT_SPEC:
${JSON.stringify(output_spec, null, 2)}

POSITIVES (must produce expected output):
${JSON.stringify(positives.slice(0, 12), null, 2)}

${negatives.length ? `NEGATIVES (must NOT produce expected_not):
${JSON.stringify(negatives.slice(0, 8), null, 2)}` : ''}

${priors.hint ? `HINT: ${priors.hint}` : ''}

Synthesize a generator that satisfies all positives and rejects all negatives.`;

  const candidates = [];
  for (const temperature of [0, 0.4]) {
    try {
      emit('claude_request', { temperature, model: MODEL });
      const resp = await c.messages.create({
        model: MODEL,
        max_tokens: 1500,
        temperature,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      });
      const text = resp.content.map(b => b.text || '').join('');
      const source = stripFences(text).trim();
      if (source.includes('function generate')) {
        candidates.push({ source, prompt: userMsg });
        emit('claude_response', { temperature, size_bytes: Buffer.byteLength(source, 'utf8') });
      }
    } catch (e) {
      emit('claude_error', { temperature, error: String(e.message || e) });
    }
  }
  return candidates;
}

function stripFences(s) {
  return s.replace(/^```(?:javascript|js)?\s*/i, '').replace(/```\s*$/, '').trim();
}

// Pattern-based synthesizer: detects common generator shapes from examples.
// Works with no API key. Gives the demo a deterministic floor.
function patternCandidates({ positives, output_spec }) {
  const out = [];
  const expectedKinds = inferOutputKind(positives, output_spec);

  if (expectedKinds.has('boolean')) {
    out.push({ source: synthBoolFromKeywords(positives), strategy: 'pattern' });
  }
  if (expectedKinds.has('regex_extract')) {
    out.push({ source: synthRegexExtract(positives, output_spec), strategy: 'pattern' });
  }
  if (expectedKinds.has('classify')) {
    out.push({ source: synthClassifier(positives), strategy: 'pattern' });
  }
  if (expectedKinds.has('number')) {
    out.push({ source: synthNumber(positives), strategy: 'pattern' });
    out.push({ source: synthCount(positives), strategy: 'pattern' });
  }
  return out;
}

function inferOutputKind(positives, spec) {
  const kinds = new Set();
  if (spec?.type === 'boolean') kinds.add('boolean');
  if (spec?.type === 'string[]' || spec?.type === 'array') kinds.add('regex_extract');
  if (spec?.type === 'enum') kinds.add('classify');
  if (spec?.type === 'number' || spec?.type === 'integer') kinds.add('number');

  const sample = positives[0]?.expected;
  if (typeof sample === 'boolean') kinds.add('boolean');
  if (Array.isArray(sample)) kinds.add('regex_extract');
  if (typeof sample === 'number') kinds.add('number');
  if (typeof sample === 'string') kinds.add('classify');
  return kinds;
}

function synthBoolFromKeywords(positives) {
  // Count token frequency in each class, keep words that strongly favor one side.
  const STOP = new Set(['the','and','for','you','your','this','that','from','with','have','was','are','our','its','it','to','of','in','on','at','is','as','a','an','or','if','be','my','me','we','i','no','so','do']);
  const posCount = new Map(), negCount = new Map();
  let posN = 0, negN = 0;
  for (const p of positives) {
    const tokens = String(p.input).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOP.has(t));
    const target = p.expected ? posCount : negCount;
    if (p.expected) posN++; else negN++;
    for (const t of new Set(tokens)) target.set(t, (target.get(t) || 0) + 1);
  }
  const scored = [];
  for (const [t, n] of posCount) {
    const p = posN ? n / posN : 0;
    const q = negN ? (negCount.get(t) || 0) / negN : 0;
    if (q === 0 && p > 0) scored.push({ t, score: p + 0.5 });
    else if (p - q >= 0.3) scored.push({ t, score: p - q });
  }
  scored.sort((a, b) => b.score - a.score);
  const trueList = scored.slice(0, 24).map(x => x.t);
  return `function generate(input, lib) {
  const trueWords = ${JSON.stringify(trueList)};
  if (trueWords.length === 0) return false;
  const tokens = String(input).toLowerCase().split(/[^a-z0-9]+/);
  const set = new Set(trueWords);
  return tokens.some(t => set.has(t));
}`;
}

function synthRegexExtract(_positives, spec) {
  const want = (spec?.pattern || 'email').toLowerCase();
  const known = ['email','url','phone','price','date','ipv4'];
  const pattern = known.includes(want) ? want : 'email';
  return `function generate(input, lib) {
  const re = lib.patterns.${pattern};
  return String(input).match(re) || [];
}`;
}

function synthClassifier(positives) {
  const classes = new Map();
  for (const p of positives) {
    const cls = p.expected;
    if (!classes.has(cls)) classes.set(cls, []);
    classes.get(cls).push(String(p.input).toLowerCase());
  }
  const rules = [...classes.entries()].map(([cls, samples]) => {
    const tokens = new Set();
    for (const s of samples) for (const t of s.split(/[^a-z0-9]+/).filter(Boolean)) tokens.add(t);
    return { cls, tokens: [...tokens].slice(0, 20) };
  });
  return `function generate(input, lib) {
  const rules = ${JSON.stringify(rules)};
  const inp = String(input).toLowerCase();
  let bestCls = null, bestN = -1;
  for (const r of rules) {
    const n = r.tokens.filter(t => inp.includes(t)).length;
    if (n > bestN) { bestN = n; bestCls = r.cls; }
  }
  return bestCls;
}`;
}

function synthNumber(positives) {
  const xs = positives.map(p => String(p.input).length);
  const ys = positives.map(p => Number(p.expected));
  const n = xs.length || 1;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (ys[i] - meanY); den += (xs[i] - meanX) ** 2; }
  const m = den === 0 ? 0 : num / den;
  const b = meanY - m * meanX;
  return `function generate(input, lib) {
  const x = String(input).length;
  return ${m} * x + ${b};
}`;
}

// Count-words style numeric: word count on input string.
function synthCount(_positives) {
  return `function generate(input, lib) {
  return lib.tokenize(String(input)).length;
}`;
}
export { QUALITY_GATE };

// ---------- seedsNewFromBrief (Wave 199) ----------
//
// Natural-language brief -> candidate training rows. Two paths:
//   1. Air-gap mode (airGap:true) — deterministic; pulls from a per-class
//      library of domain-keyed starter rows (CARC denial codes 50/197/204/16,
//      EDI 837 fragments, HEDIS measure stubs, etc.). No network, no telemetry.
//   2. Networked mode (default) — when KOLM_LLM_* env vars are configured,
//      calls a real LLM endpoint via src/llm-call.js to fan the air-gap
//      seed library into N synthesized variations. Concurrency 4, retry 2.
//      When the LLM is unconfigured the path degrades to a deterministic
//      template+synonym augmentation so the user always gets something.
//
// Honest scope contract:
//   - candidates are CANDIDATES, not labels. They must go through
//     `kolm seeds split` + `kolm eval` + the K-score gate before any
//     promotion. The flow is "scaffold -> validate -> gate", not
//     "scaffold -> ship".
//
// Output shape:
//   {
//     class,              // one of 4 recipe classes
//     candidates: [{ input, output, tags }],
//     gate_suggestion,    // suggested K-score gate per class
//     next_steps: [string],
//     network_status,     // 'air_gap' | 'networked_llm' | 'networked_fallback'
//     class_inference_basis,
//     note,
//   }

const SEEDS_RECIPE_CLASSES = ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'];

// Keyword -> recipe-class inference. Mirrors scaffoldRecipeFromNl (W197):
// same order, same intent, so a brief routed through either path lands
// in the same class. Keeping the tables parallel (not merged) so each
// wave's tests pin behavior independently and one wave's refactor cannot
// silently move the other.
const SEEDS_CLASS_KEYWORDS = [
  // distilled_model first: generative requests need real model bytes
  { class: 'distilled_model', words: ['draft', 'write a', 'compose', 'generate prose', 'generate text', 'summari', 'paraphrase', 'rewrite', 'explain', 'translate', 'appeal letter', 'reply to', 'respond to', 'narrative', 'denial appeal'] },
  // compiled_rule: explicit native / wasm / C / Rust / binary
  { class: 'compiled_rule', words: ['native', 'wasm', 'c99', 'rust', 'compiled binary', 'binary recipe', 'lowered to'] },
  // synthesized_rule: known measures / specs where teacher emits rule code
  { class: 'synthesized_rule', words: ['hedis', 'cpt code', 'icd-10 lookup', 'ndc lookup', 'compute measure', 'compute hedis', 'compute the', 'apply spec', 'measure', 'hedis measure'] },
  // rule: deterministic parsers, redactors, validators, classifiers, transformers, EDI/X12 segments
  { class: 'rule', words: ['parse', 'parser', 'redact', 'redactor', 'normalize', 'validator', 'validate', 'extract', 'classify', 'classifier', 'edi', '837', '835', '834', '270', '271', '278', 'x12', 'fhir', 'route by', 'lookup', 'denial code'] },
];

function seedsInferClass(text, classHint) {
  if (classHint && SEEDS_RECIPE_CLASSES.includes(classHint)) {
    return { class: classHint, basis: 'class_hint' };
  }
  const t = String(text || '').toLowerCase();
  for (const row of SEEDS_CLASS_KEYWORDS) {
    for (const w of row.words) {
      if (t.includes(w)) return { class: row.class, basis: `keyword:${w}` };
    }
  }
  return { class: 'rule', basis: 'default' };
}

// Per-class K-score gate. Stricter floor for higher classes (more cost
// -> more proof). Matches scaffoldRecipeFromNl numbers verbatim.
function seedsGateForClass(klass) {
  if (klass === 'distilled_model') return 0.85;
  if (klass === 'compiled_rule')   return 0.92;
  if (klass === 'synthesized_rule')return 0.90;
  return 0.88;
}

// Per-class candidate library. The point is to give the user a domain-
// flavored starting set they can edit, not to ship "ground truth". Every
// row carries `tags` including `synthesized: true` so the train loop can
// never count these as real labels.
//
// Domain choices:
//   - rule: 8 CARC denial codes (50/197/204/16/45/96/27/29) +
//     EDI 837 segment shape + ICD-10 / CPT lookup rows
//   - synthesized_rule: HEDIS measure rows (CBP, CDC, BCS) + boundary cases
//   - compiled_rule: native-binary perf + determinism + WASM rows
//   - distilled_model: denial-appeal prose stubs + redaction prose stubs
function seedsLibraryFor(klass) {
  if (klass === 'distilled_model') {
    return [
      { input: 'denial CARC 50 (not medically necessary), CPT 70553 brain MRI', output: 'Appeal letter draft: cite NCD policy + clinical indication for CPT 70553 (brain MRI with contrast).' },
      { input: 'denial CARC 197 (precert absent), CPT 27447 knee arthroplasty', output: 'Appeal letter draft: attach precert reference + cite plan precert policy carve-out.' },
      { input: 'denial CARC 204 (not covered under plan), Rx J1745 infliximab', output: 'Appeal letter draft: cite formulary tier + step-therapy completion evidence.' },
      { input: 'denial CARC 16 (claim lacks information), CPT 99213 office visit', output: 'Appeal letter draft: enclose missing chart note + signed attestation.' },
      { input: 'request: summarize a clinical note for the member portal', output: 'Plain-language summary stub: diagnosis + plan + next visit. Avoid PHI in the summary.' },
      { input: 'request: paraphrase a denial reason for a member-facing letter', output: 'Member-facing paraphrase stub: plain language, sixth-grade reading level.' },
      { input: 'request: write a prior-auth justification letter for a high-cost imaging study', output: 'Prior-auth justification stub: cite ACR appropriateness criteria + clinical history.' },
      { input: 'request: compose a peer-to-peer talking-points memo', output: 'Peer-to-peer memo stub: indication, prior trials, clinical guideline citations.' },
      { input: 'request: translate an EOB into member-friendly language', output: 'EOB translation stub: explain copay, deductible application, network status.' },
      { input: 'request: draft a coverage-determination request', output: 'Coverage-determination request stub: cite plan language + clinical evidence.' },
    ];
  }
  if (klass === 'synthesized_rule') {
    return [
      { input: 'HEDIS CBP (Controlling High Blood Pressure): member age 64, BP 138/85', output: '{"measure":"CBP","numerator":true,"reason":"BP < 140/90"}' },
      { input: 'HEDIS CBP: member age 72, BP 145/92', output: '{"measure":"CBP","numerator":false,"reason":"BP >= 140/90"}' },
      { input: 'HEDIS CDC (Comprehensive Diabetes Care): A1C 6.8% in measurement year', output: '{"measure":"CDC-A1C","numerator":true,"reason":"A1C < 8%"}' },
      { input: 'HEDIS CDC: A1C 9.4% in measurement year', output: '{"measure":"CDC-A1C","numerator":false,"reason":"A1C >= 8%"}' },
      { input: 'HEDIS BCS (Breast Cancer Screening): female 52, mammogram on 2025-09-15', output: '{"measure":"BCS","numerator":true,"reason":"mammogram in lookback window"}' },
      { input: 'HEDIS BCS: female 48, no mammogram in lookback', output: '{"measure":"BCS","numerator":false,"reason":"no mammogram"}' },
      { input: 'boundary: HEDIS CBP at exactly 140/90', output: '{"measure":"CBP","numerator":false,"reason":"boundary excluded"}' },
      { input: 'boundary: HEDIS CDC at exactly 8.0%', output: '{"measure":"CDC-A1C","numerator":false,"reason":"boundary excluded"}' },
      { input: 'denominator exclusion: HEDIS CBP, ESRD diagnosis', output: '{"measure":"CBP","excluded":true,"reason":"ESRD denominator exclusion"}' },
      { input: 'denominator exclusion: HEDIS BCS, bilateral mastectomy', output: '{"measure":"BCS","excluded":true,"reason":"bilateral mastectomy exclusion"}' },
    ];
  }
  if (klass === 'compiled_rule') {
    return [
      { input: 'native input: denial code "50"', output: '{"ok":true,"class":"medical_necessity","runtime":"native"}' },
      { input: 'native input: denial code "197"', output: '{"ok":true,"class":"precert_absent","runtime":"native"}' },
      { input: 'wasm input: denial code "204"', output: '{"ok":true,"class":"not_covered","runtime":"wasm"}' },
      { input: 'wasm input: denial code "16"', output: '{"ok":true,"class":"missing_info","runtime":"wasm"}' },
      { input: 'perf check: 10k rows', output: '{"ok":true,"latency_us_p50":12}' },
      { input: 'perf check: 100k rows', output: '{"ok":true,"latency_us_p50":13}' },
      { input: 'determinism check: same input, two runs', output: '{"ok":true,"deterministic":true}' },
      { input: 'platform check: x86_64-linux', output: '{"ok":true,"platform":"x86_64-linux"}' },
      { input: 'platform check: aarch64-darwin', output: '{"ok":true,"platform":"aarch64-darwin"}' },
      { input: 'edge: unknown denial code "ZZZ"', output: '{"ok":false,"error":"unknown_code"}' },
    ];
  }
  // rule (default): CARC denial codes + EDI 837 fragments + ICD/CPT lookup
  return [
    { input: 'denial code "50"', output: '{"carc":"50","category":"medical_necessity","appealable":true}' },
    { input: 'denial code "197"', output: '{"carc":"197","category":"precert_absent","appealable":true}' },
    { input: 'denial code "204"', output: '{"carc":"204","category":"not_covered","appealable":true}' },
    { input: 'denial code "16"', output: '{"carc":"16","category":"missing_info","appealable":true}' },
    { input: 'denial code "45"', output: '{"carc":"45","category":"charge_exceeds_fee_schedule","appealable":false}' },
    { input: 'denial code "96"', output: '{"carc":"96","category":"non_covered_charge","appealable":true}' },
    { input: 'EDI 837P CLM segment: CLM*123456*250.00***11:B:1*Y*A*Y*Y', output: '{"segment":"CLM","claim_id":"123456","total_charge":250.00,"place_of_service":"11"}' },
    { input: 'EDI 837 NM1 segment: NM1*IL*1*DOE*JOHN****MI*W123456789', output: '{"segment":"NM1","entity":"insured","last":"DOE","first":"JOHN","member_id":"W123456789"}' },
    { input: 'CPT lookup: 99213', output: '{"cpt":"99213","short":"Office/outpatient visit, est, low-mod"}' },
    { input: 'ICD-10 lookup: I10', output: '{"icd10":"I10","short":"Essential (primary) hypertension"}' },
  ];
}

function seedsNextSteps(klass, count) {
  return [
    `review the ${count} candidate row${count === 1 ? '' : 's'} above and replace placeholders with YOUR real examples`,
    `kolm seeds split  (partition into train/holdout/external)`,
    `kolm eval         (score against your K-score gate)`,
    `kolm verify       (confirm receipts before any promotion)`,
    klass === 'distilled_model'
      ? 'distilled_model: seeds become teacher prompts; capture real teacher responses with `kolm capture`'
      : klass === 'synthesized_rule'
        ? 'synthesized_rule: seeds become spec inputs; teacher emits the rule code itself'
        : klass === 'compiled_rule'
          ? 'compiled_rule: seeds become native-binary fixtures; toolchain compiles to wasm32-wasi or platform target'
          : 'rule: seeds become test fixtures; you author the rule code in JavaScript',
    'honest scope: these rows are CANDIDATES, not labels. K-score against candidates is not ground truth.',
  ];
}

// `count` defaulting: 10 candidates is what scaffoldRecipeFromNl (W197)
// also returns; keep parity so callers chaining `kolm nl` -> `kolm seeds new`
// see consistent shape sizes.
//
// Returns a Promise because the networked path makes real LLM calls. The
// air-gap path resolves synchronously inside the same promise so callers
// can `await` either branch with a single shape.
export async function seedsNewFromBrief(opts) {
  const o = opts || {};
  const brief = String(o.brief || '').trim();
  const classHint = o.classHint || null;
  const count = Number.isFinite(o.count) && o.count > 0 ? Math.floor(o.count) : 10;
  const airGap = !!o.airGap;
  const teacherVendor = String(o.teacherVendor || 'anthropic');

  if (!brief) {
    return {
      ok: false,
      error: 'empty_input',
      narration: 'seedsNewFromBrief: brief is required',
    };
  }

  const inferred = seedsInferClass(brief, classHint);
  const klass = inferred.class;
  const gate = seedsGateForClass(klass);
  const lib = seedsLibraryFor(klass);

  // Air-gap path: deterministic. Pull from the per-class library, tile to
  // `count` if the library is shorter, annotate the first row with a
  // verbatim slice of the brief so the output is not 100% generic. Same
  // brief + same class + same count -> same bytes.
  if (airGap) {
    const candidates = buildAirGapCandidates(brief, klass, lib, count);
    return {
      ok: true,
      class: klass,
      candidates,
      gate_suggestion: gate,
      next_steps: seedsNextSteps(klass, candidates.length),
      network_status: 'air_gap',
      class_inference_basis: inferred.basis,
      teacher_vendor: teacherVendor,
      note: 'candidates are CANDIDATES, not labels. Run `kolm seeds split` + `kolm eval` before promoting any row to ground truth.',
    };
  }

  // Networked path: call the configured LLM to fan out the air-gap library
  // seed into `count` semantically-equivalent variations preserving the
  // input->output mapping. Concurrency 4, retry 2 (handled inside llm-call).
  if (llmIsConfigured()) {
    const seed = lib[0];
    let rows = [];
    try {
      rows = await llmGenerateVariations({
        seed,
        count,
        hint: `Domain: ${klass}. Brief: ${brief.slice(0, 200)}`,
      });
    } catch (_) {
      // Fall through to the deterministic fallback path below.
      rows = [];
    }
    if (rows.length > 0) {
      const candidates = rows.slice(0, count).map((r, i) => ({
        input: r.input,
        output: r.output,
        tags: ['synthesized', `class:${klass}`, `idx:${i}`, 'networked'],
        synthesized: true,
        source: 'networked-llm',
      }));
      if (candidates.length > 0) {
        candidates[0] = { ...candidates[0], tags: candidates[0].tags.concat(['brief-anchor']) };
      }
      return {
        ok: true,
        class: klass,
        candidates,
        gate_suggestion: gate,
        next_steps: seedsNextSteps(klass, candidates.length),
        network_status: 'networked_llm',
        llm: llmDescribe(),
        class_inference_basis: inferred.basis,
        teacher_vendor: teacherVendor,
        note: 'candidates are CANDIDATES, not labels. Run `kolm seeds split` + `kolm eval` before promoting any row to ground truth.',
      };
    }
    // Configured LLM responded with nothing usable — fall back deterministically.
  }

  // Deterministic networked fallback: template+synonym augmentation over
  // the air-gap library so the user always gets `count` rows. Same brief +
  // same class + same count -> same bytes, but tags + source mark these as
  // augmented (not air-gap and not LLM-generated).
  const candidates = buildSynonymAugmentedCandidates(brief, klass, lib, count);
  return {
    ok: true,
    class: klass,
    candidates,
    gate_suggestion: gate,
    next_steps: seedsNextSteps(klass, candidates.length),
    network_status: 'networked_fallback',
    llm: llmDescribe(),
    class_inference_basis: inferred.basis,
    teacher_vendor: teacherVendor,
    note: 'LLM not configured (set KOLM_LLM_*) — emitted deterministic template+synonym variations. candidates are CANDIDATES; gate before promotion.',
  };
}

// ---------------------------------------------------------------------------
// Deterministic candidate builders shared by air-gap + fallback paths.
// ---------------------------------------------------------------------------
function buildAirGapCandidates(brief, klass, lib, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = lib[i % lib.length];
    out.push({
      input: base.input,
      output: base.output,
      tags: ['synthesized', `class:${klass}`, `idx:${i}`],
      synthesized: true,
      source: 'deterministic-air-gap',
    });
  }
  if (out.length > 0) {
    out[0] = {
      input: `request: ${brief.slice(0, 200)}  ||  ${out[0].input}`,
      output: out[0].output,
      tags: out[0].tags.concat(['brief-anchor']),
      synthesized: true,
      source: 'deterministic-air-gap',
    };
  }
  return out;
}

// Deterministic template+synonym augmentation. Each row picks a base row
// from the library and applies one of ~6 surface-form rewrites: change the
// leading verb, swap article, add a context phrase, etc. Pure function of
// (brief, class, count): same inputs produce identical bytes.
const SYNONYM_TEMPLATES = [
  (s) => s,
  (s) => `please ${s.toLowerCase()}`,
  (s) => `${s} (case A)`,
  (s) => `${s} (case B)`,
  (s) => s.replace(/^([A-Z])/, (m) => m.toLowerCase()),
  (s) => `urgent: ${s}`,
  (s) => `${s} — production`,
  (s) => `[priority] ${s}`,
];

function buildSynonymAugmentedCandidates(brief, klass, lib, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = lib[i % lib.length];
    const tpl = SYNONYM_TEMPLATES[i % SYNONYM_TEMPLATES.length];
    out.push({
      input: tpl(base.input),
      output: base.output,
      tags: ['synthesized', `class:${klass}`, `idx:${i}`, 'augmented'],
      synthesized: true,
      source: 'deterministic-synonym',
    });
  }
  if (out.length > 0) {
    out[0] = {
      input: `request: ${brief.slice(0, 200)}  ||  ${out[0].input}`,
      output: out[0].output,
      tags: out[0].tags.concat(['brief-anchor']),
      synthesized: true,
      source: 'deterministic-synonym',
    };
  }
  return out;
}
