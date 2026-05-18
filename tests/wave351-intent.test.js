// Wave 351 - src/intent.js natural-language classifier.
//
// Unit-level behaviour assertions for the three classifier layers (keyword
// fast path, regex extractors, overlap fallback) plus snapshotContext and
// recommendNext. No CLI spawning -- those are in wave352.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// On Windows ESM dynamic-import requires a file:// URL not a bare absolute path.
const INTENT_PATH = pathToFileURL(path.resolve(REPO_ROOT, 'src', 'intent.js')).href;

function isolatedHome() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w351-'));
  return d;
}

test('W351 #1 - intent.js loads as ESM and exports the public API', async () => {
  const m = await import(INTENT_PATH);
  assert.equal(typeof m.classifyIntent, 'function', 'classifyIntent must be exported');
  assert.equal(typeof m.snapshotContext, 'function', 'snapshotContext must be exported');
  assert.equal(typeof m.recommendNext, 'function', 'recommendNext must be exported');
  assert.equal(typeof m.listVerbs, 'function', 'listVerbs must be exported');
  assert.ok(Array.isArray(m.VERB_DESCRIPTIONS), 'VERB_DESCRIPTIONS array must be exported');
  assert.ok(m.VERB_DESCRIPTIONS.length >= 30, 'VERB_DESCRIPTIONS must cover >= 30 verbs');
});

test('W351 #2 - keyword fast path: exact phrasing returns confidence 0.99', async () => {
  const { classifyIntent } = await import(INTENT_PATH);
  const intent = await classifyIntent('show captures');
  assert.equal(intent.verb, 'tail', 'show captures -> tail');
  assert.equal(intent.source, 'keyword');
  assert.ok(intent.confidence >= 0.9, `confidence ${intent.confidence} must be >= 0.9`);
  // The keyword path enriches tail with the captures positional.
  assert.deepEqual(intent.args, ['captures']);
});

test('W351 #3 - keyword fast path: prefix and substring matches', async () => {
  const { classifyIntent } = await import(INTENT_PATH);
  // prefix: extra trailing words -> still classified
  const i1 = await classifyIntent('list models please now');
  assert.equal(i1.verb, 'models');
  // substring: "could you" wraps the keyword phrase
  const i2 = await classifyIntent('could you show me artifacts now');
  // either 'list' or 'artifacts' is a sensible answer; both are in the keyword
  // table for "show artifacts" / "list artifacts" phrasings.
  assert.ok(['list', 'artifacts', 'tail'].includes(i2.verb), `got ${i2.verb}`);
});

test('W351 #4 - regex: captures-with-namespace extracts the namespace arg', async () => {
  const { classifyIntent } = await import(INTENT_PATH);
  const intent = await classifyIntent('show captures in namespace support');
  assert.equal(intent.verb, 'tail');
  assert.ok(intent.args.includes('--namespace'), 'must include --namespace flag');
  assert.ok(intent.args.includes('support'), 'must include namespace name');
});

test('W351 #5 - regex: compile <spec-file> -> args=[--spec, path]', async () => {
  const { classifyIntent } = await import(INTENT_PATH);
  const intent = await classifyIntent('compile phi-redactor.spec.json');
  assert.equal(intent.verb, 'compile');
  assert.deepEqual(intent.args, ['--spec', 'phi-redactor.spec.json']);
  assert.ok(intent.confidence >= 0.9);
});

test('W351 #6 - regex: build a <template> from <dir> -> init-agent with template+from', async () => {
  const { classifyIntent } = await import(INTENT_PATH);
  const intent = await classifyIntent('build a redactor from ./notes/');
  assert.equal(intent.verb, 'init-agent');
  assert.ok(intent.args.includes('--template'));
  assert.ok(intent.args.includes('redactor'));
  assert.ok(intent.args.includes('--from'));
  assert.ok(intent.args.includes('./notes/'));
});

test('W351 #7 - regex: run <artifact> "<input>" -> run with positional + input', async () => {
  const { classifyIntent } = await import(INTENT_PATH);
  const intent = await classifyIntent('run phi-redactor.kolm with "Patient John Doe"');
  assert.equal(intent.verb, 'run');
  assert.equal(intent.args[0], 'phi-redactor.kolm');
  assert.equal(intent.args[1], 'Patient John Doe');
});

test('W351 #8 - regex: export <art> to <fmt>', async () => {
  const { classifyIntent } = await import(INTENT_PATH);
  const intent = await classifyIntent('export phi-redactor.kolm to gguf');
  assert.equal(intent.verb, 'export');
  assert.deepEqual(intent.args, ['phi-redactor.kolm', '--to', 'gguf']);
});

test('W351 #9 - regex: distill from captures + namespace', async () => {
  const { classifyIntent } = await import(INTENT_PATH);
  const intent = await classifyIntent('distill from captures in namespace prod');
  assert.equal(intent.verb, 'distill');
  assert.ok(intent.args.includes('--from-captures'));
  assert.ok(intent.args.includes('--namespace'));
  assert.ok(intent.args.includes('prod'));
});

test('W351 #10 - overlap fallback: never throws "not implemented" for unknown input', async () => {
  const { classifyIntent } = await import(INTENT_PATH);
  // Garbage input must still resolve to some verb, with low confidence.
  const intent = await classifyIntent('zzzzzz qqqqq xxxxx flibbertigibbet');
  assert.ok(intent.verb, 'verb must be set');
  assert.ok(typeof intent.confidence === 'number');
  assert.ok(intent.confidence <= 0.7, 'confidence must reflect uncertainty');
  assert.ok(['overlap', 'fallback', 'keyword', 'regex', 'llm'].includes(intent.source));
});

test('W351 #11 - empty input routes to `what` (snapshot)', async () => {
  const { classifyIntent } = await import(INTENT_PATH);
  const intent = await classifyIntent('');
  assert.equal(intent.verb, 'what');
  const intent2 = await classifyIntent('   ');
  assert.equal(intent2.verb, 'what');
});

test('W351 #12 - context-aware: namespace mention matches an existing namespace', async () => {
  const { classifyIntent } = await import(INTENT_PATH);
  const context = {
    captures_summary: [
      { namespace: 'support', count: 50 },
      { namespace: 'sales', count: 10 },
    ],
  };
  const intent = await classifyIntent('show captures support', context);
  assert.equal(intent.verb, 'tail');
  assert.ok(intent.args.includes('--namespace'));
  assert.ok(intent.args.includes('support'));
});

test('W351 #13 - listVerbs() returns stable verb names matching VERB_DESCRIPTIONS', async () => {
  const { listVerbs, VERB_DESCRIPTIONS } = await import(INTENT_PATH);
  const verbs = listVerbs();
  assert.deepEqual(verbs, VERB_DESCRIPTIONS.map(v => v.verb));
  // Sanity: a few high-value verbs must be present.
  for (const v of ['compile', 'run', 'verify', 'tail', 'distill', 'publish', 'pull',
                   'do', 'what', 'next', 'explain', 'fix']) {
    assert.ok(verbs.includes(v), `listVerbs() must include '${v}'`);
  }
});

test('W351 #14 - snapshotContext returns expected shape against an empty HOME', async () => {
  const home = isolatedHome();
  try {
    const { snapshotContext } = await import(INTENT_PATH);
    const snap = await snapshotContext({ cwd: home, home });
    assert.ok(snap, 'snap must be returned');
    assert.ok(Array.isArray(snap.artifacts), 'artifacts is an array');
    assert.ok(Array.isArray(snap.captures_summary), 'captures_summary is an array');
    assert.ok(Array.isArray(snap.jobs), 'jobs is an array');
    assert.equal(snap.counts.artifacts, 0, 'empty HOME -> 0 artifacts');
    assert.equal(snap.counts.captures, 0, 'empty HOME -> 0 captures');
    assert.equal(snap.counts.jobs, 0, 'empty HOME -> 0 jobs');
    assert.equal(typeof snap.generated_at, 'string', 'generated_at must be ISO');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W351 #15 - snapshotContext picks up jobs from ~/.kolm/jobs.jsonl', async () => {
  const home = isolatedHome();
  try {
    fs.mkdirSync(path.join(home, '.kolm'), { recursive: true });
    const jobsPath = path.join(home, '.kolm', 'jobs.jsonl');
    fs.writeFileSync(jobsPath, [
      JSON.stringify({ id: 'job-1', kind: 'compile', status: 'running' }),
      JSON.stringify({ id: 'job-2', kind: 'distill', status: 'done' }),
    ].join('\n') + '\n');
    const { snapshotContext } = await import(INTENT_PATH);
    const snap = await snapshotContext({ cwd: home, home });
    assert.equal(snap.counts.jobs, 2);
    assert.deepEqual(snap.jobs.map(j => j.id).sort(), ['job-1', 'job-2']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W351 #16 - recommendNext returns ranked recommendations and includes login when no config', async () => {
  const { recommendNext } = await import(INTENT_PATH);
  const empty = {
    counts: { artifacts: 0, captures: 0, namespaces: 0, jobs: 0 },
    artifacts: [],
    captures_summary: [],
    jobs: [],
    config: null,
    current_tenant: null,
  };
  const recs = recommendNext(empty);
  assert.ok(Array.isArray(recs));
  assert.ok(recs.length >= 1 && recs.length <= 3, `1-3 recs expected, got ${recs.length}`);
  // Top rec for empty state should be login.
  assert.equal(recs[0].action, 'login');
  assert.ok(recs[0].command.startsWith('kolm login'));
});

test('W351 #17 - recommendNext suggests distill when a namespace is past 1000 captures', async () => {
  const { recommendNext } = await import(INTENT_PATH);
  const snap = {
    counts: { artifacts: 1, captures: 1500, namespaces: 1, jobs: 0 },
    artifacts: [{ name: 'phi.kolm', path: '/a/b/phi.kolm', k_score: 0.95, production_ready: true }],
    captures_summary: [{ namespace: 'support', count: 1500 }],
    jobs: [],
    config: { base: 'https://kolm.ai', api_key: 'ks_aaa' },
  };
  const recs = recommendNext(snap);
  const top = recs[0];
  assert.equal(top.action, 'distill_ready_namespace');
  assert.ok(top.command.includes('support'));
});

test('W351 #18 - recommendNext flags low-K-score artifacts via the fix verb', async () => {
  const { recommendNext } = await import(INTENT_PATH);
  const snap = {
    counts: { artifacts: 1, captures: 0, namespaces: 0, jobs: 0 },
    artifacts: [{ name: 'low.kolm', path: '/a/b/low.kolm', k_score: 0.40, production_ready: false }],
    captures_summary: [],
    jobs: [],
    config: { base: 'https://kolm.ai', api_key: 'ks_aaa' },
  };
  const recs = recommendNext(snap);
  assert.ok(recs.some(r => r.action === 'fix_low_kscore'),
    `expected fix_low_kscore in recs, got: ${recs.map(r => r.action).join(',')}`);
  const fix = recs.find(r => r.action === 'fix_low_kscore');
  assert.ok(fix.command.startsWith('kolm fix'));
  assert.ok(fix.command.includes('low.kolm'));
});

test('W351 #19 - VERB_DESCRIPTIONS entries are well-formed (verb, desc, phrasings, examples)', async () => {
  const { VERB_DESCRIPTIONS } = await import(INTENT_PATH);
  for (const entry of VERB_DESCRIPTIONS) {
    assert.equal(typeof entry.verb, 'string', `entry must have a string verb (got ${JSON.stringify(entry)})`);
    assert.ok(entry.verb.length > 0);
    assert.equal(typeof entry.desc, 'string', `entry.${entry.verb}.desc must be a string`);
    assert.ok(entry.desc.length > 0);
    assert.ok(Array.isArray(entry.phrasings), `entry.${entry.verb}.phrasings must be an array`);
    assert.ok(entry.phrasings.length > 0);
    assert.ok(Array.isArray(entry.examples), `entry.${entry.verb}.examples must be an array`);
  }
});

test('W351 #20 - classifyIntent always returns the original input verbatim on the Intent', async () => {
  const { classifyIntent } = await import(INTENT_PATH);
  const inputs = ['show captures', '  list models please  ', 'compile foo.spec.json', 'zzzz xxxx'];
  for (const text of inputs) {
    const intent = await classifyIntent(text);
    assert.equal(intent.original, text, `original must equal input ${JSON.stringify(text)}`);
    assert.equal(typeof intent.normalized, 'string');
  }
});
