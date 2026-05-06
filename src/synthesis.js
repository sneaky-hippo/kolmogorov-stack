// Synthesis layer.
// Two paths:
//   1. Claude path — when ANTHROPIC_API_KEY is set, ask Claude for a JS generator.
//   2. Pattern path — deterministic rule-based synthesis from positive/negative examples.
// Both produce JS source. Both pass through the same verifier and quality gate.

import 'dotenv/config';
import { libraryDescription, subroutines } from './library.js';
import { compileJs, verify, hashSource, QUALITY_GATE } from './verifier.js';

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
