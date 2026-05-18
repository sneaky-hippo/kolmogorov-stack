// W345 — `kolm eval` and `kolm bench` MUST agree on pass count for the same
// .kolm and the same cases.
//
// Trial bug: a user reported eval=5/7, bench=2/7 on the same artifact. Root
// cause: src/artifact-runner.js used a subset-equal matcher (object subset
// pass, numeric tolerance 1e-6) while src/benchmark.js used a strict deep-
// equal (key sets must match both ways, numeric tolerance 1e-9). The two
// verbs read the same bytes and reported different numbers.
//
// Fix: both call src/case-scorer.js::scoreCase. This test compiles a small
// artifact, exercises eval and bench against the same .kolm and the same
// cases (the artifact's embedded evals), and asserts pass counts match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileSpec } from '../src/spec-compile.js';
import { evalArtifact } from '../src/artifact-runner.js';
import { benchmarkArtifact } from '../src/benchmark.js';
import { scoreCase, subsetEqualMatch } from '../src/case-scorer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A recipe that emits an EXTRA `confidence` key not in `expected`. The legacy
// eval matcher (subset-equal) treats this as pass; the legacy bench matcher
// (deep-equal) treats it as fail. So under the bug, eval and bench would
// disagree on every case. Under the W345 fix they agree.
const SPEC = {
  job_id: 'job_w345_parity_v1',
  task: 'Classify greeting; emit extra confidence key (tests subset-vs-strict mismatch).',
  base_model: 'none',
  target_device: 'any',
  recipes: [{
    id: 'rcp_w345_v1',
    name: 'subset-emitting greeter',
    schema: {
      input:  { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      output: { type: 'object', properties: { is_greeting: { type: 'boolean' } } },
    },
    // Emits {is_greeting, confidence}. Expected has only {is_greeting}. eval
    // saw "subset" -> pass; legacy bench saw extra key -> fail.
    source: "function generate(input, lib) {\n  const s = String((input && input.text) || '').toLowerCase();\n  const hit = /\\b(hi|hello|hey|howdy|greetings)\\b/.test(s);\n  return { is_greeting: hit, confidence: hit ? 0.9 : 0.1 };\n}",
  }],
  evals: {
    spec: 'rs-1-evals',
    n: 7,
    coverage: 1.0,
    cases: [
      { id: 'ev_1', input: { text: 'hi there' },          expected: { is_greeting: true  } },
      { id: 'ev_2', input: { text: 'hello world' },       expected: { is_greeting: true  } },
      { id: 'ev_3', input: { text: 'hey friend' },        expected: { is_greeting: true  } },
      { id: 'ev_4', input: { text: 'howdy partner' },     expected: { is_greeting: true  } },
      { id: 'ev_5', input: { text: 'greetings traveler' },expected: { is_greeting: true  } },
      { id: 'ev_6', input: { text: 'where is my order' }, expected: { is_greeting: false } },
      { id: 'ev_7', input: { text: 'deploy at 3pm' },     expected: { is_greeting: false } },
    ],
  },
  training_stats: { approach: 'rule', regex_count: 1, verifier_accepted: true, latency_p50_us: 40 },
};

let ARTIFACT;
let TMP;

test('W345 setup — compile a small artifact whose output is a superset of expected', async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w345-'));
  ARTIFACT = path.join(TMP, 'parity.kolm');
  const r = await compileSpec(SPEC, { outDir: TMP, outPath: ARTIFACT, allowSeedAutoResolve: false, allow_below_gate: true });
  assert.ok(fs.existsSync(ARTIFACT), 'compile produced no artifact');
  assert.ok(r.bytes > 500, 'artifact too small to be real');
});

test('W345 #1 — eval and bench return identical pass counts on the same artifact', async () => {
  const evalR  = await evalArtifact(ARTIFACT);
  const benchR = await benchmarkArtifact(ARTIFACT, { runs: 1 });
  // eval result: { n, passed, ... }; bench result: { evals: { n, passed, ... } }
  const evalPassed  = evalR.passed;
  const benchPassed = benchR.evals.passed;
  const evalN  = evalR.n;
  const benchN = benchR.evals.n;
  assert.strictEqual(evalN, benchN, `eval n=${evalN} but bench n=${benchN} (case count drift)`);
  assert.strictEqual(evalPassed, benchPassed, `eval passed=${evalPassed} but bench passed=${benchPassed} on same artifact — see W345`);
  // Both should be 7 (every superset matches its subset under the canonical matcher).
  assert.strictEqual(evalPassed, 7, `subset-matcher should pass all 7; got ${evalPassed}`);
});

test('W345 #2 — eval and bench agree even on partial-pass cases (mixed expected types)', async () => {
  // Override cases path: pass cases via opts.cases (eval) / opts.input is N/A
  // for cases, but the artifact's embedded evals are the shared source of
  // truth for bench, so we recompile a variant where 2 of 7 cases will fail
  // both verbs identically.
  const SPEC_MIX = {
    ...SPEC,
    job_id: 'job_w345_mix_v1',
    evals: {
      ...SPEC.evals,
      cases: [
        { id: 'ev_1', input: { text: 'hi there' },          expected: { is_greeting: true  } },
        { id: 'ev_2', input: { text: 'hello world' },       expected: { is_greeting: true  } },
        { id: 'ev_3', input: { text: 'hey friend' },        expected: { is_greeting: true  } },
        // Intentional fails (expected wrong direction):
        { id: 'ev_4_wrong', input: { text: 'where is my order' }, expected: { is_greeting: true  } },
        { id: 'ev_5_wrong', input: { text: 'deploy at 3pm' },     expected: { is_greeting: true  } },
        { id: 'ev_6', input: { text: 'where is my order' }, expected: { is_greeting: false } },
        { id: 'ev_7', input: { text: 'deploy at 3pm' },     expected: { is_greeting: false } },
      ],
    },
  };
  const mixPath = path.join(TMP, 'parity-mix.kolm');
  await compileSpec(SPEC_MIX, { outDir: TMP, outPath: mixPath, allowSeedAutoResolve: false, allow_below_gate: true });
  const evalR  = await evalArtifact(mixPath);
  const benchR = await benchmarkArtifact(mixPath, { runs: 1 });
  assert.strictEqual(evalR.n, benchR.evals.n);
  assert.strictEqual(evalR.passed, benchR.evals.passed,
    `eval passed=${evalR.passed} but bench passed=${benchR.evals.passed} on same artifact — see W345`);
  // 5 of 7 expected to pass (the 2 _wrong cases fail under any matcher).
  assert.strictEqual(evalR.passed, 5, `expected 5/7 pass; got ${evalR.passed}/7`);
});

test('W345 #3 — scoreCase unit: subset-equal pass, no false negatives on extra keys', () => {
  const r1 = scoreCase({ input: 'x', expected: { is_greeting: true } }, { is_greeting: true, confidence: 0.9 });
  assert.strictEqual(r1.pass, true, 'subset match must pass when actual is a superset of expected');
  assert.strictEqual(r1.comparator, 'subset_equal');

  const r2 = scoreCase({ input: 'x', expected: { is_greeting: true } }, { is_greeting: false, confidence: 0.1 });
  assert.strictEqual(r2.pass, false, 'subset match must fail when expected key has wrong value');

  // Numeric tolerance check — canonical eval matcher uses 1e-6.
  assert.strictEqual(subsetEqualMatch(1.0000001, 1.0), true, 'numeric tolerance 1e-6 should accept 1e-7 drift');
  assert.strictEqual(subsetEqualMatch(1.001, 1.0), false, 'numeric tolerance 1e-6 must reject 1e-3 drift');
});

test('W345 #4 — both verbs import src/case-scorer.js (source spot-check)', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'src', 'artifact-runner.js'), 'utf8');
  const bench  = fs.readFileSync(path.join(ROOT, 'src', 'benchmark.js'), 'utf8');
  assert.ok(runner.includes("from './case-scorer.js'"), 'artifact-runner must import case-scorer');
  assert.ok(bench.includes("from './case-scorer.js'"), 'benchmark must import case-scorer');
});

test('W345 teardown — remove tmp dir', () => {
  if (TMP && fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
});
