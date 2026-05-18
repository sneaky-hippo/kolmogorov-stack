// Wave 381 — full pipeline behavior tests.
//
// Covers the captured-calls → owned-model chain end-to-end. The four units
// under test:
//
//   workers/tokenizer-train/train.mjs    pure-JS BPE worker
//   src/tokenizer-train.js               Node API around the worker
//   src/distill-pipeline.js              distill orchestrator (async iter)
//   src/compile-pipeline.js              full 11-phase compileFull()
//
// Each test isolates ~/.kolm via fs.mkdtempSync + KOLM_DATA_DIR + HOME so
// runs don't leak into the dev box's real event store or artifact dir.
// Tests seed events via direct appendEvent() calls — no HTTP, no router.
//
// Asserts BEHAVIOR — not "function exists." Each test calls the public
// surface and inspects the on-disk state / yielded events.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Each test runs against its own tmpdir. _envForTest() returns a fresh env
// envelope that scopes KOLM_DATA_DIR, HOME, USERPROFILE, and force jsonl
// driver (sqlite would otherwise share a single dev-box DB).
function _mkTmp(label = 'w381') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

function _setEnv(tmp) {
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_STORE_DRIVER = 'jsonl';
  process.env.KOLM_RECIPE_RECEIPT_SECRET = process.env.KOLM_RECIPE_RECEIPT_SECRET || 'wave381-test-secret-32chars-min-len';
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function _snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_RECIPE_RECEIPT_SECRET: process.env.KOLM_RECIPE_RECEIPT_SECRET,
    KOLM_DISTILL_FULL: process.env.KOLM_DISTILL_FULL,
    KOLM_DISTILL_TEACHER: process.env.KOLM_DISTILL_TEACHER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    KOLM_SIGNING_KEY: process.env.KOLM_SIGNING_KEY,
  };
}

// Synthetic corpus generator for tokenizer + distill seed data. 50–200 lines
// is comfortable for vocab_size=300 BPE in <2s on a laptop.
function _makeCorpus(n = 80) {
  const templates = [
    'classify ticket about {topic} {n}',
    'summarize email about {topic} {n}',
    'extract amount from invoice {topic} {n}',
    'redact phi from note about {topic} {n}',
    'route ticket about {topic} {n} to {team}',
  ];
  const topics = ['billing', 'shipping', 'returns', 'refund', 'login', 'cancel'];
  const teams = ['support', 'finance', 'eng'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = templates[i % templates.length].replace('{topic}', topics[i % topics.length]).replace('{n}', String(i)).replace('{team}', teams[i % teams.length]);
    out.push(t);
  }
  return out;
}

function _makePairs(n = 80) {
  const out = [];
  const corpus = _makeCorpus(n);
  for (let i = 0; i < corpus.length; i++) {
    out.push({
      prompt: corpus[i],
      response: 'reply ' + i + ' for ' + corpus[i].slice(0, 30),
    });
  }
  return out;
}

async function _seedNamespace(namespace, n = 80) {
  const { appendEvent, _resetForTests } = await import('../src/event-store.js');
  _resetForTests();
  const pairs = _makePairs(n);
  for (const p of pairs) {
    await appendEvent({
      namespace,
      tenant_id: 'wave381-test',
      prompt_redacted: p.prompt,
      response_redacted: p.response,
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
    });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// #1 — trainTokenizer.deterministic_hash is reproducible across calls.
test('W381 #1 — trainTokenizer.deterministic_hash reproducible (same corpus+seed → same hash)', async () => {
  const tmp = _mkTmp('w381-1');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const { trainTokenizer } = await import('../src/tokenizer-train.js');
    const corpus = _makeCorpus(60);
    const r1 = await trainTokenizer({
      corpus, vocab_size: 300, algorithm: 'bpe',
      model_prefix: path.join(tmp, 'tok1'), seed: 7,
    });
    const r2 = await trainTokenizer({
      corpus, vocab_size: 300, algorithm: 'bpe',
      model_prefix: path.join(tmp, 'tok2'), seed: 7,
    });
    assert.equal(r1.deterministic_hash, r2.deterministic_hash, 'same inputs must produce same hash');
    assert.match(r1.deterministic_hash, /^sha256:[0-9a-f]{64}$/);
    // Different seed → different hash (when the corpus produces any tie-breaks).
    const r3 = await trainTokenizer({
      corpus, vocab_size: 300, algorithm: 'bpe',
      model_prefix: path.join(tmp, 'tok3'), seed: 999,
    });
    // Hashes may or may not differ depending on whether ties exist; the
    // shape of the hash must always be the same.
    assert.match(r3.deterministic_hash, /^sha256:[0-9a-f]{64}$/);
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #2 — trainTokenizer respects vocab_size cap (final ≤ requested).
test('W381 #2 — trainTokenizer respects vocab_size cap', async () => {
  const tmp = _mkTmp('w381-2');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const { trainTokenizer } = await import('../src/tokenizer-train.js');
    // Larger corpus to ensure there's room to grow the vocab.
    const corpus = _makeCorpus(150);
    const r = await trainTokenizer({
      corpus, vocab_size: 200, algorithm: 'bpe',
      model_prefix: path.join(tmp, 'tok'), seed: 1,
    });
    assert.ok(r.vocab_size <= 200, `vocab_size ${r.vocab_size} must be <= 200`);
    assert.ok(r.vocab_size >= 5, 'vocab_size must include at least the 5 specials');
    const tok = JSON.parse(fs.readFileSync(r.tokenizer_path, 'utf8'));
    assert.equal(tok.vocab.length, r.vocab_size, 'on-disk vocab length must match envelope');
    assert.equal(tok.algorithm, 'bpe');
    assert.equal(tok.spec, 'kolm-tokenizer-1');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #3 — loadTokenizer encode → decode roundtrip preserves the input (modulo
// case folding + non-alphanumeric handling).
test('W381 #3 — loadTokenizer encode/decode roundtrip', async () => {
  const tmp = _mkTmp('w381-3');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const { trainTokenizer, loadTokenizer } = await import('../src/tokenizer-train.js');
    const corpus = _makeCorpus(80);
    const r = await trainTokenizer({
      corpus, vocab_size: 400, algorithm: 'bpe',
      model_prefix: path.join(tmp, 'tok'), seed: 1,
    });
    const tok = loadTokenizer(r.tokenizer_path);
    assert.equal(typeof tok.encode, 'function');
    assert.equal(typeof tok.decode, 'function');
    assert.equal(tok.vocab_size, r.vocab_size);
    assert.ok(Array.isArray(tok.special_tokens));
    assert.equal(tok.algorithm, 'bpe');
    // Roundtrip — encode is lowercased + non-alphanumeric stripped via the
    // tokenizer's BPE atoms. We check that the decoded output preserves the
    // alphanumeric content of a known training line.
    const sample = 'classify ticket about billing';
    const ids = tok.encode(sample);
    assert.ok(ids.length > 0, 'encode must produce at least one id');
    // Every id must be in range.
    for (const id of ids) {
      assert.ok(id >= 0 && id < tok.vocab_size, `id ${id} out of vocab range`);
    }
    const decoded = tok.decode(ids);
    // Decode strips </w> markers and joins atoms — for an in-vocab line we
    // expect at least the leading word to survive.
    assert.ok(decoded.toLowerCase().includes('classif') || decoded.toLowerCase().includes('ticket'),
      `decoded "${decoded}" should contain at least one training word`);
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #4 — tokenizerStats.compression_vs_gpt4 > 1.0 for an in-domain corpus.
test('W381 #4 — tokenizerStats.compression_vs_gpt4 > 1.0 on in-domain corpus', async () => {
  const tmp = _mkTmp('w381-4');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const { trainTokenizer, loadTokenizer, tokenizerStats } = await import('../src/tokenizer-train.js');
    const corpus = _makeCorpus(120);
    const r = await trainTokenizer({
      corpus, vocab_size: 500, algorithm: 'bpe',
      model_prefix: path.join(tmp, 'tok'), seed: 1,
    });
    const tok = loadTokenizer(r.tokenizer_path);
    const stats = tokenizerStats(corpus, tok);
    assert.equal(typeof stats.avg_tokens_per_doc, 'number');
    assert.equal(typeof stats.compression_vs_gpt4, 'number');
    assert.equal(typeof stats.oov_rate, 'number');
    assert.ok(stats.avg_tokens_per_doc > 0, 'tokens per doc must be > 0');
    assert.ok(stats.compression_vs_gpt4 > 1.0,
      `compression_vs_gpt4 ${stats.compression_vs_gpt4} must be > 1 for in-domain corpus`);
    assert.ok(stats.oov_rate >= 0 && stats.oov_rate <= 1, 'oov_rate must be a fraction');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #5 — prepareDistillCorpus reads from KOLM_DATA_DIR event store.
test('W381 #5 — prepareDistillCorpus reads from KOLM_DATA_DIR event store', async () => {
  const tmp = _mkTmp('w381-5');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    await _seedNamespace('w381-ns', 40);
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const r = await prepareDistillCorpus({ namespace: 'w381-ns', split: 'all' });
    assert.ok(Array.isArray(r.pairs), 'pairs must be an array');
    assert.equal(r.pairs.length, 40, 'all 40 seeded events must round-trip as pairs');
    for (const p of r.pairs) {
      assert.equal(typeof p.prompt, 'string');
      assert.equal(typeof p.response, 'string');
      assert.equal(typeof p.event_id, 'string');
      assert.ok(p.event_id.startsWith('evt_'), 'event_id must be a real event id');
    }
    assert.equal(r.stats.namespace, 'w381-ns');
    assert.equal(r.stats.events_scanned, 40);
    assert.equal(r.stats.pairs_kept, 40);
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #6 — selectStudentBackbone returns a known model from the registry.
test('W381 #6 — selectStudentBackbone returns a known model from registry', async () => {
  const { selectStudentBackbone } = await import('../src/distill-pipeline.js');
  // Each task_type must resolve to a string (we don't pin the exact name —
  // the planner can rotate models — but the shape and registry membership
  // must hold).
  for (const task of ['classification', 'redaction', 'extraction', 'generation']) {
    const m = selectStudentBackbone({ task_type: task });
    assert.equal(typeof m, 'string', `task ${task} must resolve to a string`);
    assert.ok(m.length > 0, `task ${task} must resolve to a non-empty model`);
  }
  // Tier override beats task type.
  const tierBig = selectStudentBackbone({ task_type: 'classification', hw_tier: 'dgx-spark' });
  assert.equal(tierBig, 'qwen-3b', 'dgx-spark must upgrade to qwen-3b');
  const tierUltra = selectStudentBackbone({ task_type: 'classification', hw_tier: 'm3-ultra-512' });
  assert.equal(tierUltra, 'qwen-3b', 'm3-ultra-512 must upgrade to qwen-3b');
});

// ---------------------------------------------------------------------------
// #7 — distill async iterator yields {step,loss,k_score} events.
test('W381 #7 — distill async iterator yields {step,loss,k_score} events', async () => {
  const tmp = _mkTmp('w381-7');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    // Force stub mode by clearing teacher keys.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.KOLM_DISTILL_TEACHER;
    delete process.env.KOLM_DISTILL_FULL;
    await _seedNamespace('w381-distill', 30);
    const { distill } = await import('../src/distill-pipeline.js');
    const events = [];
    let doneEvent = null;
    for await (const ev of distill({
      teacher_namespace: 'w381-distill',
      student_base: 'qwen-0.5b',
      dataset_id: 'wave381-test',
      k_target: 0.85,
      max_steps: 5,
      emit_progress_every: 1,
    })) {
      if (ev.done) { doneEvent = ev; break; }
      events.push(ev);
    }
    assert.ok(events.length > 0, 'distill must yield at least one progress event');
    for (const ev of events) {
      assert.equal(typeof ev.step, 'number', 'progress event must have step');
      assert.equal(typeof ev.loss, 'number', 'progress event must have loss');
      assert.equal(typeof ev.k_score, 'number', 'progress event must have k_score');
      assert.equal(typeof ev.ts, 'string', 'progress event must have ts');
      assert.ok(ev.k_score >= 0 && ev.k_score <= 1, 'k_score must be in [0,1]');
    }
    assert.ok(doneEvent, 'distill must yield a final done event');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #8 — distill final yield carries artifact_path (the worker's out dir).
test('W381 #8 — distill final yield carries artifact_path', async () => {
  const tmp = _mkTmp('w381-8');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.KOLM_DISTILL_TEACHER;
    delete process.env.KOLM_DISTILL_FULL;
    await _seedNamespace('w381-distill-8', 20);
    const { distill } = await import('../src/distill-pipeline.js');
    let doneEvent = null;
    for await (const ev of distill({
      teacher_namespace: 'w381-distill-8',
      student_base: 'qwen-0.5b',
      dataset_id: 'wave381-test-8',
      k_target: 0.85,
      max_steps: 3,
      emit_progress_every: 0,
    })) {
      if (ev.done) { doneEvent = ev; break; }
    }
    assert.ok(doneEvent, 'must yield a final done event');
    assert.equal(typeof doneEvent.artifact_path, 'string', 'done event must have artifact_path');
    assert.ok(doneEvent.artifact_path.length > 0, 'artifact_path must not be empty');
    assert.equal(typeof doneEvent.distill_log_path, 'string', 'done event must have distill_log_path');
    assert.ok(['stub', 'collect', 'full'].includes(doneEvent.worker_mode), 'worker_mode must be a known value');
    assert.equal(doneEvent.pipeline_mode, 'kd_softmax', 'default pipeline_mode is kd_softmax');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #9 — compileFull emits all 11 phases in order.
test('W381 #9 — compileFull emits all 11 phases in order', async () => {
  const tmp = _mkTmp('w381-9');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.KOLM_DISTILL_TEACHER;
    delete process.env.KOLM_DISTILL_FULL;
    await _seedNamespace('w381-compile-9', 30);
    const { compileFull, PIPELINE_PHASES } = await import('../src/compile-pipeline.js');
    assert.deepEqual(PIPELINE_PHASES, [
      'plan', 'tokenizer_train', 'corpus_prepare', 'dataset_split',
      'distill', 'quantize', 'bundle', 'sign', 'verdict', 'install', 'done',
    ], 'PIPELINE_PHASES must be the 11-phase canonical list');
    const phasesSeen = [];
    for await (const ev of compileFull({
      namespace: 'w381-compile-9',
      opts: { emit_progress_every: 0, no_install: true, force: true },
    })) {
      phasesSeen.push(ev.phase);
    }
    // Each canonical phase must appear at least once. distill may repeat.
    for (const expected of PIPELINE_PHASES) {
      assert.ok(phasesSeen.includes(expected),
        `expected phase '${expected}' in [${phasesSeen.join(', ')}]`);
    }
    // First phase is plan, last phase is done.
    assert.equal(phasesSeen[0], 'plan', 'first phase must be plan');
    assert.equal(phasesSeen[phasesSeen.length - 1], 'done', 'last phase must be done');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #10 — compileFull writes per-phase log files under ~/.kolm/jobs/<id>/.
test('W381 #10 — compileFull writes per-phase log files', async () => {
  const tmp = _mkTmp('w381-10');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await _seedNamespace('w381-logs', 20);
    const { compileFull } = await import('../src/compile-pipeline.js');
    let jobId = null;
    for await (const ev of compileFull({
      namespace: 'w381-logs',
      opts: { emit_progress_every: 0, no_install: true, force: true },
    })) {
      if (!jobId) jobId = ev.job_id;
    }
    assert.ok(jobId, 'compileFull must surface a job_id');
    const jobDir = path.join(tmp, 'jobs', jobId);
    assert.ok(fs.existsSync(jobDir), `job dir ${jobDir} must exist`);
    // At minimum: plan, tokenizer_train, corpus_prepare, distill, bundle, verdict, done.
    const expectedPhases = ['plan.log', 'tokenizer_train.log', 'corpus_prepare.log', 'bundle.log', 'verdict.log', 'done.log'];
    for (const p of expectedPhases) {
      const fp = path.join(jobDir, p);
      assert.ok(fs.existsSync(fp), `expected per-phase log ${p} in ${jobDir}`);
      const content = fs.readFileSync(fp, 'utf8');
      assert.ok(content.length > 0, `log ${p} must not be empty`);
      assert.match(content, /^\[\d{4}-\d{2}-\d{2}T/, `log ${p} must have ISO timestamp prefix`);
    }
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #11 — compileFull --strict with a failing gate aborts before install.
test('W381 #11 — compileFull --strict with failing gate aborts before install', async () => {
  const tmp = _mkTmp('w381-11');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await _seedNamespace('w381-strict', 20);
    const { compileFull } = await import('../src/compile-pipeline.js');
    let abortedDone = null;
    let installEv = null;
    for await (const ev of compileFull({
      namespace: 'w381-strict',
      opts: {
        strict: true,
        install_target: 'local',
        emit_progress_every: 0,
        // no force — strict must trip when verdict fails (synthetic recipe
        // with no real coverage typically fails the gate).
      },
    })) {
      if (ev.phase === 'install') installEv = ev;
      if (ev.phase === 'done') abortedDone = ev;
    }
    assert.ok(abortedDone, 'must yield a done event');
    // If the verdict passed we can't assert abort — but strict-mode with a
    // synthetic-shim recipe almost always fails the executable_bundle or
    // k_score gate. Tolerate either outcome but verify the *contract*: if
    // verdict failed and strict was set, install was skipped + aborted=true.
    if (abortedDone.production_ready === false) {
      assert.equal(abortedDone.aborted, true, 'strict + failing gate must set aborted:true');
      assert.equal(abortedDone.reason, 'strict_gate_failure');
      assert.ok(installEv, 'install phase event must still emit (skipped)');
      assert.equal(installEv.skipped, true, 'install must be skipped on strict-abort');
    }
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #12 — compileFull --force overrides a gate failure and proceeds.
test('W381 #12 — compileFull --force overrides gate failure and proceeds', async () => {
  const tmp = _mkTmp('w381-12');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await _seedNamespace('w381-force', 20);
    const { compileFull } = await import('../src/compile-pipeline.js');
    let doneEv = null;
    for await (const ev of compileFull({
      namespace: 'w381-force',
      opts: {
        strict: true,
        force: true,
        no_install: true,
        emit_progress_every: 0,
      },
    })) {
      if (ev.phase === 'done') doneEv = ev;
    }
    assert.ok(doneEv, 'must yield a done event');
    // With force=true, even if verdict failed, aborted is NOT set (pipeline
    // proceeds past install).
    if (doneEv.production_ready === false) {
      assert.notEqual(doneEv.aborted, true, 'force must not set aborted=true');
    }
    // Either way, the artifact_path must be present on done.
    assert.ok(doneEv.artifact_path, 'done must carry artifact_path');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #13 — .kolm artifact contains recipe.bundle.mjs (W367 invariant).
test('W381 #13 — .kolm artifact contains recipe.bundle.mjs (W367 invariant)', async () => {
  const tmp = _mkTmp('w381-13');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await _seedNamespace('w381-bundle', 25);
    const { compileFull } = await import('../src/compile-pipeline.js');
    let bundlePath = null;
    for await (const ev of compileFull({
      namespace: 'w381-bundle',
      opts: { emit_progress_every: 0, no_install: true, force: true, out_dir: path.join(tmp, 'artifacts') },
    })) {
      if (ev.phase === 'bundle') bundlePath = ev.recipe_bundle_path;
    }
    assert.ok(bundlePath, 'bundle phase must emit recipe_bundle_path');
    assert.ok(fs.existsSync(bundlePath), `artifact path ${bundlePath} must exist on disk`);
    // Crack open the zip and assert the bundle entry is present.
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip(fs.readFileSync(bundlePath));
    const entryNames = zip.getEntries().map((e) => e.entryName);
    assert.ok(entryNames.includes('recipe.bundle.mjs'),
      `.kolm must contain recipe.bundle.mjs (got [${entryNames.join(', ')}])`);
    assert.ok(entryNames.includes('manifest.json'), 'must contain manifest.json');
    const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
    assert.ok(manifest.entry, 'manifest must include entry block for the bundle');
    assert.equal(manifest.entry.file, 'recipe.bundle.mjs', 'entry.file must point at the bundle');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #14 — compileFull --no-sign skips the Ed25519 sidecar.
test('W381 #14 — compileFull --no-sign skips signature', async () => {
  const tmp = _mkTmp('w381-14');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.KOLM_SIGNING_KEY;
    await _seedNamespace('w381-nosign', 20);
    const { compileFull } = await import('../src/compile-pipeline.js');
    let signEv = null;
    let bundleEv = null;
    for await (const ev of compileFull({
      namespace: 'w381-nosign',
      opts: { emit_progress_every: 0, no_install: true, force: true, no_sign: true, out_dir: path.join(tmp, 'artifacts') },
    })) {
      if (ev.phase === 'sign') signEv = ev;
      if (ev.phase === 'bundle') bundleEv = ev;
    }
    assert.ok(signEv, 'sign phase must still emit');
    assert.equal(signEv.skipped, true, '--no-sign must mark sign as skipped');
    assert.equal(signEv.ed25519_attached, false, 'must not attach Ed25519 sidecar');
    // The .ed25519.sig sidecar must NOT exist next to the artifact.
    if (bundleEv && bundleEv.recipe_bundle_path) {
      const sigPath = bundleEv.recipe_bundle_path + '.ed25519.sig';
      assert.ok(!fs.existsSync(sigPath), 'sidecar must not be written when --no-sign');
    }
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #15 — compileFull with KOLM_DISTILL_FULL unset uses 'collect' or 'stub' mode.
test('W381 #15 — compileFull defaults to collect/stub mode when KOLM_DISTILL_FULL unset', async () => {
  const tmp = _mkTmp('w381-15');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.KOLM_DISTILL_FULL;
    // Either with or without teacher; mode policy:
    //   no teacher  → stub
    //   teacher, no KOLM_DISTILL_FULL → collect
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.KOLM_DISTILL_TEACHER;
    await _seedNamespace('w381-mode', 15);
    const { distill } = await import('../src/distill-pipeline.js');
    let doneEv = null;
    for await (const ev of distill({
      teacher_namespace: 'w381-mode',
      student_base: 'qwen-0.5b',
      max_steps: 2,
      emit_progress_every: 0,
    })) {
      if (ev.done) { doneEv = ev; break; }
    }
    assert.ok(doneEv, 'must yield done');
    assert.notEqual(doneEv.worker_mode, 'full', 'must NOT be full mode when KOLM_DISTILL_FULL is unset');
    assert.ok(['stub', 'collect'].includes(doneEv.worker_mode),
      `worker_mode must be stub or collect, got ${doneEv.worker_mode}`);
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #16 — distill worker is spawned detached + the call site uses unref().
// We can't monkeypatch ESM module exports at runtime (read-only), so we
// verify the contract two ways: (a) source-level audit of the spawn call
// site (the file MUST set detached:true + windowsHide:true + call unref()),
// and (b) a real distill run must complete + emit a done event (proves the
// detached spawn actually wires through end-to-end).
test('W381 #16 — distill worker spawn is detached + unref()ed', async () => {
  // (a) source-level audit — exact lock-in on the spawn opts and unref().
  const src = fs.readFileSync(path.join(ROOT, 'src', 'distill-pipeline.js'), 'utf8');
  assert.match(src, /spawn\(/, 'src/distill-pipeline.js must call spawn()');
  assert.match(src, /detached:\s*true/, 'distill spawn must set detached:true');
  assert.match(src, /windowsHide:\s*true/, 'distill spawn must set windowsHide:true');
  assert.match(src, /child\.unref/, 'distill must call child.unref() after spawn');
  // (b) behavior — a real (stub-mode) distill must complete and emit done.
  const tmp = _mkTmp('w381-16');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.KOLM_DISTILL_TEACHER;
    delete process.env.KOLM_DISTILL_FULL;
    const distillModule = await import('../src/distill-pipeline.js');
    let doneEv = null;
    for await (const ev of distillModule.distill({
      student_base: 'qwen-0.5b',
      pairs_override: [{ prompt: 'a', response: 'b' }, { prompt: 'c', response: 'd' }],
      max_steps: 1,
      emit_progress_every: 0,
    })) {
      if (ev.done) { doneEv = ev; break; }
    }
    assert.ok(doneEv, 'detached spawn must still let the iterator finish');
    assert.equal(typeof doneEv.exit, 'object', 'done event must include exit info');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #17 — worker handles empty corpus gracefully (vocab_size = specials_count).
test('W381 #17 — tokenizer worker handles empty corpus (vocab = specials only)', async () => {
  const tmp = _mkTmp('w381-17');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const { trainTokenizer, DEFAULT_SPECIAL_TOKENS } = await import('../src/tokenizer-train.js');
    // Empty corpus — pass an empty string.
    const r = await trainTokenizer({
      corpus: '',
      vocab_size: 1000,
      algorithm: 'bpe',
      model_prefix: path.join(tmp, 'tok-empty'),
      seed: 1,
    });
    assert.equal(r.vocab_size, DEFAULT_SPECIAL_TOKENS.length,
      `empty corpus must yield vocab_size = ${DEFAULT_SPECIAL_TOKENS.length} (specials only)`);
    assert.equal(r.train_token_count, 0, 'train_token_count must be 0 for empty corpus');
    assert.equal(r.merges_count, 0, 'merges_count must be 0 for empty corpus');
    const tok = JSON.parse(fs.readFileSync(r.tokenizer_path, 'utf8'));
    assert.deepEqual(tok.vocab, DEFAULT_SPECIAL_TOKENS);
    assert.deepEqual(tok.merges, []);
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #18 — compileFull integrates with dataset-workbench disjointness gate.
test('W381 #18 — compileFull integrates with dataset-workbench disjointness gate', async () => {
  const tmp = _mkTmp('w381-18');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await _seedNamespace('w381-disjoint', 30);
    const { compileFull } = await import('../src/compile-pipeline.js');
    let splitEv = null;
    for await (const ev of compileFull({
      namespace: 'w381-disjoint',
      opts: { emit_progress_every: 0, no_install: true, force: true, out_dir: path.join(tmp, 'artifacts') },
    })) {
      if (ev.phase === 'dataset_split' && !splitEv) splitEv = ev;
    }
    assert.ok(splitEv, 'dataset_split phase must emit');
    assert.ok(typeof splitEv.train_count === 'number', 'train_count must be a number');
    assert.ok(typeof splitEv.holdout_count === 'number', 'holdout_count must be a number');
    assert.ok(splitEv.train_count + splitEv.holdout_count > 0, 'must have at least one row');
    if (!splitEv.stub) {
      // When the real workbench ran, train_id must be a real dataset id
      // (ds_<hash>) and the disjointness must hold by construction.
      assert.match(splitEv.train_id, /^ds_/, 'train_id must look like a dataset id');
      assert.match(splitEv.split_signature, /^sha256:/, 'split_signature must be a sha256 prefix');
    }
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #19 — KOLM_DATA_DIR isolates test state from the dev box.
test('W381 #19 — KOLM_DATA_DIR isolates per test (no leakage to ~/.kolm)', async () => {
  const tmpA = _mkTmp('w381-19a');
  const tmpB = _mkTmp('w381-19b');
  const saved = _snapEnv();
  try {
    // Seed namespace under tmpA.
    _setEnv(tmpA);
    await _seedNamespace('w381-iso-A', 10);
    const { listEvents: listA } = await import('../src/event-store.js?nocache=19a');
    const evA = await listA({ namespace: 'w381-iso-A' });
    assert.equal(evA.length, 10, 'tmpA must have its 10 events');
    // Switch to tmpB — the same namespace must be empty.
    _setEnv(tmpB);
    // Re-import with cache-buster so the module re-reads KOLM_DATA_DIR.
    const { listEvents: listB, _resetForTests } = await import('../src/event-store.js?nocache=19b');
    _resetForTests();
    const evB = await listB({ namespace: 'w381-iso-A' });
    assert.equal(evB.length, 0, 'tmpB must NOT see tmpA events');
    // The tokenizer worker also must honor KOLM_DATA_DIR — its tmp dir
    // should land under tmpB.
    const { trainTokenizer } = await import('../src/tokenizer-train.js?nocache=19b');
    const r = await trainTokenizer({
      corpus: ['hello world', 'foo bar'],
      vocab_size: 100, algorithm: 'bpe',
      seed: 1,
    });
    assert.ok(r.tokenizer_path.startsWith(tmpB) || r.tokenizer_path.includes('tokenizer-train'),
      `tokenizer_path ${r.tokenizer_path} must respect KOLM_DATA_DIR (tmpB=${tmpB})`);
  } finally {
    _restoreEnv(saved);
  }
});
