// Wave 157 (Q+3a) — PHI redactor receipt-chain integration.
//
// Covers the wiring that closes the receipt chain between the distill worker
// (which writes redact_class + teacher-call-log + reinjection-log + the three
// log hashes into manifest.json) and the artifact verifier (binder check #14,
// which fails when redact_class != 'none' but any of the log hashes are
// missing, or when a bundled teacher-call-log either fails its re-hash or
// contains raw PHI the redactor should have masked).
//
// Test surface:
//   1. Worker manifest contract — stub mode has redact_class='none' + null
//      log hashes; --redact-class=invalid is rejected.
//   2. distill-provenance.js round-trip threads redact_class +
//      teacher_call_log_hash + reinjection_log_hash through.
//   3. spec-compile.js binds them to manifest.training (already exercised by
//      the buildAndZip path in tests 4-9 below).
//   4. binder check #14:
//      a. absent when redact_class is 'none' or undefined
//      b. fail when class declared + any of the 3 hashes missing
//      c. pass when all 3 present + no log bundled (hash-claim-only)
//      d. pass when all 3 present + bundled log matches its hash AND has no
//         raw-PHI leakage
//      e. fail when bundled log's sha256 does not match training.teacher_call_log_hash
//      f. fail when bundled log contains raw PHI (e.g., email) the redactor
//         should have masked

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildAndZip } from '../src/artifact.js';
import { buildBinder } from '../src/binder.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER = path.resolve(__dirname, '..', 'workers', 'distill', 'distill.mjs');

process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';

const TMP = path.join(os.tmpdir(), 'kolm-wave157-redactor-' + crypto.randomBytes(3).toString('hex'));
fs.mkdirSync(TMP, { recursive: true });

function runWorker(args, opts = {}) {
  const res = spawnSync(process.execPath, [WORKER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30000,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function writeSpec(dir, spec) {
  const p = path.join(dir, 'spec.json');
  fs.writeFileSync(p, JSON.stringify(spec, null, 2));
  return p;
}

function writeSeeds(dir, rows) {
  const p = path.join(dir, 'seeds.jsonl');
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function namedCheck(checks, name) {
  return checks.find(c => c.name === name);
}

function sha256Prefixed(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function baseSpec(overrides = {}) {
  return {
    job_id: 'job_w157_' + crypto.randomBytes(3).toString('hex'),
    task: 'wave157_redactor',
    base_model: 'none',
    recipes: [{
      id: 'rcp', name: 'echo',
      source: 'function generate(i){ return { echo: String(i && i.text || i) }; }',
      source_hash: 'deadbeef', version_id: 1, tags: [],
    }],
    training_stats: { distilled_pairs: 0, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0 },
    evals: { spec: 'rs-1-evals', n: 0, cases: [] },
    outDir: TMP,
    artifact_class: 'rule',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Worker manifest contract (stub mode + flag validation)
// ---------------------------------------------------------------------------
test('worker --mode=stub: manifest sets redact_class=none and nulls log hashes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w157-stub-'));
  try {
    writeSpec(tmp, { job_id: 'job_w157_stub' });
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' },
    ]);
    const out = path.join(tmp, 'out');
    const r = runWorker(['--mode=stub',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${out}`]);
    assert.equal(r.status, 0, r.stderr);
    const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(mf.redact_class, 'none');
    assert.equal(mf.teacher_call_log_hash, null);
    assert.equal(mf.reinjection_log_hash, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('worker: --redact-class=banana is rejected with hint listing valid values', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w157-bad-'));
  try {
    writeSpec(tmp, {});
    writeSeeds(tmp, [{ input: 'a', output: 'A' }, { input: 'b', output: 'B' }]);
    const r = runWorker(['--mode=collect',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${path.join(tmp, 'out')}`,
      '--teacher=anthropic:claude-opus-4-7',
      '--redact-class=banana']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /redact-class/);
    assert.match(r.stderr, /none.*phi.*pci.*multi.*auto/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('worker: --no-redact + --redact-class=phi is rejected (conflict)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w157-conflict-'));
  try {
    writeSpec(tmp, {});
    writeSeeds(tmp, [{ input: 'a', output: 'A' }, { input: 'b', output: 'B' }]);
    const r = runWorker(['--mode=collect',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${path.join(tmp, 'out')}`,
      '--teacher=anthropic:claude-opus-4-7',
      '--no-redact',
      '--redact-class=phi']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /conflict|conflicts/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. loadDistillProvenance threads the new fields through
// ---------------------------------------------------------------------------
test('loadDistillProvenance: stub-mode dir returns redact_class=none and nulls', async () => {
  const { loadDistillProvenance } = await import('../src/distill-provenance.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w157-prov-'));
  try {
    writeSpec(tmp, {});
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' },
    ]);
    const out = path.join(tmp, 'out');
    runWorker(['--mode=stub',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${out}`]);
    const prov = await loadDistillProvenance(out);
    assert.equal(prov.redact_class, 'none');
    assert.equal(prov.teacher_call_log_hash, null);
    assert.equal(prov.reinjection_log_hash, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3-7. Verifier check #14 (PHI redactor receipt integrity)
// ---------------------------------------------------------------------------
test('check #14: absent when training.redact_class is undefined (legacy artifact)', async () => {
  const built = await buildAndZip(baseSpec());
  const r = await buildBinder(built.outPath);
  assert.equal(namedCheck(r.checks, 'PHI redactor receipt integrity'), undefined,
    'check #14 should not fire when redact_class is unset');
});

test('check #14: absent when training.redact_class is "none"', async () => {
  const built = await buildAndZip(baseSpec({
    training_stats: {
      distilled_pairs: 0, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      redact_class: 'none',
    },
  }));
  const r = await buildBinder(built.outPath);
  assert.equal(namedCheck(r.checks, 'PHI redactor receipt integrity'), undefined,
    'check #14 should not fire when redact_class=none');
});

test('check #14: fails when redact_class=phi but log hashes are missing', async () => {
  const built = await buildAndZip(baseSpec({
    training_stats: {
      distilled_pairs: 5, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      redact_class: 'phi',
      // Only redaction_map_hash present; the other two missing.
      redaction_map_hash: 'sha256:' + 'a'.repeat(64),
    },
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'PHI redactor receipt integrity');
  assert.ok(c, 'check #14 present');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /teacher_call_log_hash/);
  assert.match(c.detail, /reinjection_log_hash/);
});

test('check #14: passes (hash-claim-only) when all 3 hashes present + log not bundled', async () => {
  const built = await buildAndZip(baseSpec({
    training_stats: {
      distilled_pairs: 5, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      redact_class: 'phi',
      redaction_map_hash: 'sha256:' + 'a'.repeat(64),
      teacher_call_log_hash: 'sha256:' + 'b'.repeat(64),
      reinjection_log_hash: 'sha256:' + 'c'.repeat(64),
    },
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'PHI redactor receipt integrity');
  assert.ok(c, 'check #14 present');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /redact_class=phi/);
  assert.match(c.detail, /not bundled/);
});

test('check #14: passes (bundled-replay clean) when log matches its hash + has no leakage', async () => {
  // Token-only redacted lines — what the redactor should produce in real life.
  const cleanLog =
    JSON.stringify({ redacted_input: 'Hi [PHI_NAME_1], appt on [PHI_DATE_1].', redacted_response: 'Acknowledged [PHI_NAME_1].' }) + '\n' +
    JSON.stringify({ redacted_input: 'Call [PHI_PHONE_1] re MRN [PHI_MRN_1].', redacted_response: 'Logged.' }) + '\n';
  const cleanBuf = Buffer.from(cleanLog, 'utf8');
  const built = await buildAndZip(baseSpec({
    training_stats: {
      distilled_pairs: 2, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      redact_class: 'phi',
      redaction_map_hash: 'sha256:' + 'a'.repeat(64),
      teacher_call_log_hash: sha256Prefixed(cleanBuf),
      reinjection_log_hash: 'sha256:' + 'c'.repeat(64),
    },
    extra_files: [{ filename: 'teacher-call-log.jsonl', content: cleanBuf }],
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'PHI redactor receipt integrity');
  assert.ok(c, 'check #14 present');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /bundled teacher-call-log\.jsonl re-hashed and scanned/);
  assert.match(c.detail, /0 raw identifiers detected/);
});

test('check #14: fails when bundled log sha256 does not match training.teacher_call_log_hash', async () => {
  const realLog = Buffer.from(JSON.stringify({ redacted_input: 'Hi [PHI_NAME_1].' }) + '\n', 'utf8');
  // Manifest claims a DIFFERENT hash than the bundled file's actual sha256.
  const bogusHash = 'sha256:' + 'f'.repeat(64);
  const built = await buildAndZip(baseSpec({
    training_stats: {
      distilled_pairs: 1, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      redact_class: 'phi',
      redaction_map_hash: 'sha256:' + 'a'.repeat(64),
      teacher_call_log_hash: bogusHash,
      reinjection_log_hash: 'sha256:' + 'c'.repeat(64),
    },
    extra_files: [{ filename: 'teacher-call-log.jsonl', content: realLog }],
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'PHI redactor receipt integrity');
  assert.ok(c, 'check #14 present');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /sha256 does not match/);
});

test('check #14: fails when bundled log has raw PHI the redactor should have masked', async () => {
  // The "redacted_input" field still contains a raw email and SSN — the
  // redactor was not run, or was bypassed, or the log was tampered. Check #14
  // re-runs the redactor on every redacted_* field; any new tokens found =
  // leakage.
  const dirtyLog =
    JSON.stringify({ redacted_input: 'Hi [PHI_NAME_1], reach me at maria@example.com.', redacted_response: 'ok' }) + '\n' +
    JSON.stringify({ redacted_input: 'SSN: 123-45-6789.', redacted_response: 'logged' }) + '\n';
  const dirtyBuf = Buffer.from(dirtyLog, 'utf8');
  const built = await buildAndZip(baseSpec({
    training_stats: {
      distilled_pairs: 2, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      redact_class: 'phi',
      redaction_map_hash: 'sha256:' + 'a'.repeat(64),
      teacher_call_log_hash: sha256Prefixed(dirtyBuf),
      reinjection_log_hash: 'sha256:' + 'c'.repeat(64),
    },
    extra_files: [{ filename: 'teacher-call-log.jsonl', content: dirtyBuf }],
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'PHI redactor receipt integrity');
  assert.ok(c, 'check #14 present');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /raw identifier/);
  assert.match(c.detail, /tenant-boundary guarantee is broken/);
});

test('check #14: also fires for redact_class=pci and redact_class=multi', async () => {
  for (const cls of ['pci', 'multi', 'auto']) {
    const built = await buildAndZip(baseSpec({
      training_stats: {
        distilled_pairs: 5, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
        redact_class: cls,
        // Intentionally omit hashes so the check fails — proves the gate runs
        // for every non-'none' class, not only 'phi'.
      },
    }));
    const r = await buildBinder(built.outPath);
    const c = namedCheck(r.checks, 'PHI redactor receipt integrity');
    assert.ok(c, `check #14 must fire for redact_class=${cls}`);
    assert.equal(c.status, 'fail', `redact_class=${cls}: ${c.detail}`);
  }
});
