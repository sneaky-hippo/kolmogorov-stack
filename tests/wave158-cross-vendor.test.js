// Wave 158 (Q+3b) — Cross-vendor distillation flags + license matrix.
//
// Covers:
//   1. catalog.mjs allow-list helpers (isKnownVendor, isKnownModelFor,
//      isKnownStudentBase, isKnownDistillationMethod, studentBaseEntry).
//   2. parseTeacherSpec strict-mode validation against the vendor catalog.
//   3. Worker rejects unknown teacher vendor:model + unknown student-base
//      (and accepts unknown student-base under --allow-unknown-student-base).
//   4. Worker rejects unknown --distillation-method.
//   5. Worker --list-catalog dumps the catalog + exits zero.
//   6. Stub-mode manifest carries the new student-base catalog metadata
//      (student_base_repo / student_base_origin / student_base_license)
//      and the explicit student_base_revision pin when supplied.
//   7. distill-provenance.js round-trip threads the new fields through.
//   8. Binder check #15 (Cross-vendor distillation provenance):
//      a. absent when manifest.lineage.source !== 'distillation'
//      b. fail when distillation lineage missing any of the four required
//         fields (teacher_vendor / teacher_model / student_base /
//         distillation_method)
//      c. pass with self-describing detail when all four present
//      d. detail surfaces the student_base_license tag (or '(unspecified)'
//         when the slug carries no license).
//   9. CLI surfaces both `--key value` and `--key=value` for the new flags
//      (parity with the wave-157 dual-form precedent).

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
import { buildLineage } from '../src/artifact-lineage.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER = path.resolve(__dirname, '..', 'workers', 'distill', 'distill.mjs');
const CLI = path.resolve(__dirname, '..', 'cli', 'kolm.js');

process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';

function runWorker(args, opts = {}) {
  const res = spawnSync(process.execPath, [WORKER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30000,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
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

const TMP = path.join(os.tmpdir(), 'kolm-wave158-' + crypto.randomBytes(3).toString('hex'));
fs.mkdirSync(TMP, { recursive: true });

function baseSpec(overrides = {}) {
  return {
    job_id: 'job_w158_' + crypto.randomBytes(3).toString('hex'),
    task: 'wave158_cross_vendor',
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
// 1. Catalog allow-list helpers
// ---------------------------------------------------------------------------
test('catalog: isKnownVendor accepts the five canonical vendors', async () => {
  const { isKnownVendor, VENDORS } = await import('../workers/distill/catalog.mjs');
  for (const v of ['anthropic', 'openai', 'google', 'xai', 'local']) {
    assert.equal(isKnownVendor(v), true, `vendor=${v}`);
  }
  assert.equal(isKnownVendor('cohere'), false);
  assert.equal(isKnownVendor(''), false);
  assert.equal(VENDORS.length, 5);
});

test('catalog: isKnownModelFor enforces vendor model allow-list (local accepts any)', async () => {
  const { isKnownModelFor } = await import('../workers/distill/catalog.mjs');
  assert.equal(isKnownModelFor('anthropic', 'claude-opus-4-7'), true);
  assert.equal(isKnownModelFor('anthropic', 'claude-bogus-v0'), false);
  assert.equal(isKnownModelFor('openai', 'gpt-5'), true);
  assert.equal(isKnownModelFor('openai', 'gpt-9000'), false);
  assert.equal(isKnownModelFor('google', 'gemini-2.5-pro'), true);
  assert.equal(isKnownModelFor('xai', 'grok-3'), true);
  assert.equal(isKnownModelFor('local', 'whatever-the-tenant-runs'), true);
  assert.equal(isKnownModelFor('nope', 'x'), false);
});

test('catalog: student-base catalog covers both western + chinese origins', async () => {
  const { STUDENT_BASES, studentBaseEntry, isKnownStudentBase } = await import('../workers/distill/catalog.mjs');
  // Spot-check a western and a chinese entry to confirm metadata shape.
  const sm = studentBaseEntry('smollm2-360m');
  assert.equal(sm.origin, 'western');
  assert.equal(sm.license, 'Apache-2.0');
  assert.equal(sm.verify_before_ship, false);
  const qw = studentBaseEntry('qwen2.5-0.5b');
  assert.equal(qw.origin, 'chinese');
  assert.equal(qw.license, 'Apache-2.0');
  // Both origins represented in the full catalog.
  const origins = new Set(Object.values(STUDENT_BASES).map(e => e.origin));
  assert.ok(origins.has('western'));
  assert.ok(origins.has('chinese'));
  assert.equal(isKnownStudentBase('totally-fake-base'), false);
});

test('catalog: distillation methods are the four canonical ones', async () => {
  const { DISTILLATION_METHODS, isKnownDistillationMethod } = await import('../workers/distill/catalog.mjs');
  assert.deepEqual([...DISTILLATION_METHODS].sort(),
    ['full-ft', 'lora', 'prompt-distill', 'qlora']);
  assert.equal(isKnownDistillationMethod('lora'), true);
  assert.equal(isKnownDistillationMethod('rlhf'), false);
});

// ---------------------------------------------------------------------------
// 2. parseTeacherSpec strict-mode validation
// ---------------------------------------------------------------------------
test('parseTeacherSpec: strict mode accepts known vendor:model', async () => {
  const { parseTeacherSpec } = await import('../workers/distill/teacher-bridge.mjs');
  const r = parseTeacherSpec('anthropic:claude-opus-4-7');
  assert.equal(r.vendor, 'anthropic');
  assert.equal(r.model, 'claude-opus-4-7');
});

test('parseTeacherSpec: strict mode rejects unknown vendor with hint', async () => {
  const { parseTeacherSpec } = await import('../workers/distill/teacher-bridge.mjs');
  assert.throws(() => parseTeacherSpec('cohere:command-r'),
    /unknown teacher vendor "cohere"/);
});

test('parseTeacherSpec: strict mode rejects unknown model with vendor model list hint', async () => {
  const { parseTeacherSpec } = await import('../workers/distill/teacher-bridge.mjs');
  assert.throws(() => parseTeacherSpec('anthropic:claude-bogus-v0'),
    /unknown model "claude-bogus-v0" for vendor "anthropic"/);
});

test('parseTeacherSpec: non-strict mode parses bypassing catalog', async () => {
  const { parseTeacherSpec } = await import('../workers/distill/teacher-bridge.mjs');
  const r = parseTeacherSpec('experimental:x-0.0.1', { strict: false });
  assert.equal(r.vendor, 'experimental');
  assert.equal(r.model, 'x-0.0.1');
});

test('parseTeacherSpec: local vendor accepts any model id', async () => {
  const { parseTeacherSpec } = await import('../workers/distill/teacher-bridge.mjs');
  const r = parseTeacherSpec('local:whatever-the-tenant-runs');
  assert.equal(r.vendor, 'local');
  assert.equal(r.model, 'whatever-the-tenant-runs');
});

// ---------------------------------------------------------------------------
// 3. Worker rejection paths
// ---------------------------------------------------------------------------
test('worker: --teacher=cohere:command-r rejected at parse time', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w158-vendor-'));
  try {
    writeSpec(tmp, {});
    writeSeeds(tmp, [{ input: 'a', output: 'A' }, { input: 'b', output: 'B' }]);
    const r = runWorker(['--mode=collect',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${path.join(tmp, 'out')}`,
      '--teacher=cohere:command-r']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown teacher vendor/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('worker: --student-base=brand-new-base rejected by catalog', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w158-sbase-'));
  try {
    writeSpec(tmp, {});
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' },
    ]);
    const r = runWorker(['--mode=stub',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${path.join(tmp, 'out')}`,
      '--student-base=brand-new-base']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown --student-base/);
    assert.match(r.stderr, /--allow-unknown-student-base/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('worker: --allow-unknown-student-base permits arbitrary slug', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w158-sbase-ok-'));
  try {
    writeSpec(tmp, {});
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' },
    ]);
    const out = path.join(tmp, 'out');
    const r = runWorker(['--mode=stub',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${out}`,
      '--student-base=brand-new-base',
      '--allow-unknown-student-base']);
    assert.equal(r.status, 0, r.stderr);
    const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(mf.student_base, 'brand-new-base');
    // Out-of-catalog slug → catalog metadata fields stay null.
    assert.equal(mf.student_base_repo, null);
    assert.equal(mf.student_base_origin, null);
    assert.equal(mf.student_base_license, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('worker: --distillation-method=rlhf rejected by allow-list', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w158-method-'));
  try {
    writeSpec(tmp, {});
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' },
    ]);
    const r = runWorker(['--mode=stub',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${path.join(tmp, 'out')}`,
      '--distillation-method=rlhf']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown --distillation-method/);
    assert.match(r.stderr, /lora.*qlora.*full-ft.*prompt-distill/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. --list-catalog dump
// ---------------------------------------------------------------------------
test('worker: --list-catalog prints vendors + student bases + methods + exits 0', () => {
  const r = runWorker(['--list-catalog']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /teacher vendors \+ models/);
  assert.match(r.stdout, /anthropic:/);
  assert.match(r.stdout, /claude-opus-4-7/);
  assert.match(r.stdout, /student bases/);
  assert.match(r.stdout, /qwen2\.5-0\.5b/);
  assert.match(r.stdout, /distillation methods:/);
  assert.match(r.stdout, /lora.*qlora.*full-ft.*prompt-distill/);
});

test('cli: kolm distill --local-worker --list-catalog dumps catalog + exits 0', () => {
  const r = runCli(['distill', '--local-worker', '--list-catalog']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /teacher vendors/);
  assert.match(r.stdout, /student bases/);
});

// ---------------------------------------------------------------------------
// 5. Stub-mode manifest carries the new fields
// ---------------------------------------------------------------------------
test('worker stub mode: known student-base populates catalog metadata', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w158-stubmeta-'));
  try {
    writeSpec(tmp, {});
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' },
    ]);
    const out = path.join(tmp, 'out');
    const r = runWorker(['--mode=stub',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${out}`,
      '--student-base=qwen2.5-0.5b',
      '--student-base-revision=abc1234']);
    assert.equal(r.status, 0, r.stderr);
    const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(mf.student_base, 'qwen2.5-0.5b');
    assert.equal(mf.student_base_repo, 'Qwen/Qwen2.5-0.5B');
    assert.equal(mf.student_base_origin, 'chinese');
    assert.equal(mf.student_base_license, 'Apache-2.0');
    assert.equal(mf.student_base_revision, 'abc1234');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. distill-provenance round-trip
// ---------------------------------------------------------------------------
test('loadDistillProvenance: threads student_base_* + distillation_method through', async () => {
  const { loadDistillProvenance } = await import('../src/distill-provenance.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w158-prov-'));
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
      `--out=${out}`,
      '--student-base=smollm2-360m',
      '--student-base-revision=def5678']);
    const prov = await loadDistillProvenance(out);
    assert.equal(prov.student_base, 'smollm2-360m');
    assert.equal(prov.student_base_repo, 'HuggingFaceTB/SmolLM2-360M');
    assert.equal(prov.student_base_origin, 'western');
    assert.equal(prov.student_base_license, 'Apache-2.0');
    assert.equal(prov.student_base_revision, 'def5678');
    // Stub mode: distillation_method derived from ml_pipeline_run=false →
    // 'prompt-distill' fallback (per src/distill-provenance.js wave 158 logic).
    assert.equal(prov.distillation_method, 'prompt-distill');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Binder check #15: cross-vendor distillation provenance
// ---------------------------------------------------------------------------
test('check #15: absent when no distillation lineage', async () => {
  const built = await buildAndZip(baseSpec());
  const r = await buildBinder(built.outPath);
  assert.equal(namedCheck(r.checks, 'Cross-vendor distillation provenance'), undefined,
    'check #15 should not fire on a non-distillation artifact');
});

test('check #15: absent when lineage source is rebuild (not distillation)', async () => {
  const lineage = buildLineage({
    source: 'rebuild',
    notes: 'test: non-distillation lineage',
  });
  const built = await buildAndZip(baseSpec({ lineage }));
  const r = await buildBinder(built.outPath);
  assert.equal(namedCheck(r.checks, 'Cross-vendor distillation provenance'), undefined,
    'check #15 should only fire when lineage.source=distillation');
});

test('check #15: fails when distillation lineage is missing required fields', async () => {
  // Distillation lineage block claims source=distillation, but the training
  // stats omit teacher_vendor + teacher_model + student_base + distillation_method.
  const lineage = buildLineage({
    source: 'distillation',
    teacher: { vendor: 'anthropic', model: 'claude-opus-4-7' },
    student_base: { repo: 'Qwen/Qwen2.5-0.5B' },
    distillation_method: 'lora',
  });
  const built = await buildAndZip(baseSpec({
    lineage,
    training_stats: {
      distilled_pairs: 5, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      // intentionally NOT setting teacher_vendor / teacher_model / student_base /
      // distillation_method here so check #15 fires on the missing fields.
    },
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Cross-vendor distillation provenance');
  assert.ok(c, 'check #15 present');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /teacher_vendor/);
  assert.match(c.detail, /teacher_model/);
  assert.match(c.detail, /student_base/);
  assert.match(c.detail, /distillation_method/);
});

test('check #15: passes with self-describing detail when all four fields present', async () => {
  const lineage = buildLineage({
    source: 'distillation',
    teacher: { vendor: 'anthropic', model: 'claude-opus-4-7' },
    student_base: { repo: 'Qwen/Qwen2.5-0.5B', revision: 'abc1234' },
    distillation_method: 'lora',
  });
  const built = await buildAndZip(baseSpec({
    lineage,
    training_stats: {
      distilled_pairs: 5, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      teacher_vendor: 'anthropic',
      teacher_model: 'claude-opus-4-7',
      teacher_version: '2026-05-17',
      student_base: 'qwen2.5-0.5b',
      student_base_repo: 'Qwen/Qwen2.5-0.5B',
      student_base_origin: 'chinese',
      student_base_license: 'Apache-2.0',
      student_base_revision: 'abc1234',
      distillation_method: 'lora',
    },
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Cross-vendor distillation provenance');
  assert.ok(c, 'check #15 present');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /teacher=anthropic:claude-opus-4-7@2026-05-17/);
  assert.match(c.detail, /student=qwen2\.5-0\.5b@abc1234/);
  assert.match(c.detail, /method=lora/);
  assert.match(c.detail, /student_base_license=Apache-2\.0/);
});

test('check #15: license note shows "(unspecified)" when student_base_license missing', async () => {
  const lineage = buildLineage({
    source: 'distillation',
    teacher: { vendor: 'openai', model: 'gpt-5' },
    student_base: { repo: 'fictional/private-base' },
    distillation_method: 'qlora',
  });
  const built = await buildAndZip(baseSpec({
    lineage,
    training_stats: {
      distilled_pairs: 5, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0,
      teacher_vendor: 'openai',
      teacher_model: 'gpt-5',
      student_base: 'fictional/private-base',
      // student_base_license intentionally omitted (out-of-catalog).
      distillation_method: 'qlora',
    },
  }));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Cross-vendor distillation provenance');
  assert.ok(c, 'check #15 present');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /student_base_license=\(unspecified\)/);
});

// ---------------------------------------------------------------------------
// 8. CLI dual-form arg parsing parity (--key value AND --key=value)
// ---------------------------------------------------------------------------
test('cli: --distillation-method=rlhf rejected at CLI before worker spawn', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w158-cli-method-'));
  try {
    writeSpec(tmp, {});
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' },
    ]);
    const r = runCli(['distill', '--local-worker', '--mode=stub',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${path.join(tmp, 'out')}`,
      '--distillation-method=rlhf']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--distillation-method must be one of/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli: --student-base-revision flag flows through to worker manifest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w158-cli-rev-'));
  try {
    writeSpec(tmp, {});
    writeSeeds(tmp, [
      { input: 'a', output: 'A' }, { input: 'b', output: 'B' },
      { input: 'c', output: 'C' }, { input: 'd', output: 'D' },
      { input: 'e', output: 'E' },
    ]);
    const out = path.join(tmp, 'out');
    const r = runCli(['distill', '--local-worker', '--mode=stub',
      `--spec=${path.join(tmp, 'spec.json')}`,
      `--seeds=${path.join(tmp, 'seeds.jsonl')}`,
      `--out=${out}`,
      '--student-base=qwen2.5-0.5b',
      '--student-base-revision=cli-rev-xyz']);
    assert.equal(r.status, 0, r.stderr);
    const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(mf.student_base_revision, 'cli-rev-xyz');
    assert.equal(mf.student_base_repo, 'Qwen/Qwen2.5-0.5B');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
