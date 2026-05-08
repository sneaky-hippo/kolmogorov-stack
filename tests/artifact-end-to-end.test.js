// End-to-end test for the four public .kolm fixtures:
//   - test/fixtures/sample.kolm        (uppercase reference fixture)
//   - test/fixtures/redactor.kolm      (identifier redactor)
//   - test/fixtures/extractor.kolm     (structured-field extractor)
//   - test/fixtures/classifier.kolm    (rule-based classifier)
//
// For each: load, verify signature, run every embedded eval case, run a
// short benchmark (target 0 egress, 100% pass), inspect, exercise tenant
// params, exercise the audit-sink callback.
//
// Anyone running this test on a clean checkout reproduces the same output
// shapes byte-for-byte (signed content is byte-stable; zip-wrapper bytes
// are not — that is documented in docs/benchmark-results-v0.1.0.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArtifact, runArtifact, evalArtifact, inspectArtifact } from '../src/artifact-runner.js';
import { benchmarkArtifact } from '../src/benchmark.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '..', 'test', 'fixtures');

const ARTIFACTS = [
  { name: 'sample',     file: 'sample.kolm',     pack: false, index: false, evals: 4 },
  { name: 'redactor',   file: 'redactor.kolm',   pack: true,  index: true,  evals: 6 },
  { name: 'extractor',  file: 'extractor.kolm',  pack: true,  index: true,  evals: 5 },
  { name: 'classifier', file: 'classifier.kolm', pack: true,  index: true,  evals: 5 },
];

// Each fixture must be a real signed artifact whose signature verifies under
// the public RECIPE_RECEIPT_SECRET ("kolm-public-fixture-v0-1-0"). If you see
// this fail, the secret is wrong or the fixture was not regenerated.
process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-public-fixture-v0-1-0';

for (const a of ARTIFACTS) {
  test(`load + verify signature: ${a.name}`, () => {
    const p = path.join(FIXTURES, a.file);
    const bundle = loadArtifact(p);
    assert.equal(bundle.signature_valid, true, `${a.name} signature must verify`);
    assert.ok(bundle.manifest, 'manifest present');
    assert.ok(bundle.recipes?.recipes?.length > 0, 'at least one recipe');
    assert.ok(bundle.evals?.cases?.length > 0, 'at least one eval case');
    assert.ok(bundle.receipt, 'receipt present');
    assert.equal(Array.isArray(bundle.receipt.chain), true, 'receipt has chain');
    assert.equal(bundle.receipt.chain.length, 5, 'receipt chain has 5 steps');
    if (a.pack) assert.ok(bundle.pack, `${a.name} should have a pack`);
    else assert.equal(bundle.pack, null, `${a.name} should not have a pack`);
    if (a.index) assert.ok(bundle.index, `${a.name} should have an index`);
    else assert.equal(bundle.index, null, `${a.name} should not have an index`);
  });

  test(`inspect: ${a.name}`, () => {
    const i = inspectArtifact(path.join(FIXTURES, a.file));
    assert.equal(i.tier, 'recipe');
    assert.equal(i.signature_valid, true);
    assert.equal(i.evals_n, a.evals);
    assert.equal(i.pack_present, a.pack);
    assert.equal(i.index_present, a.index);
    assert.ok(i.recipes_n > 0);
  });

  test(`evalArtifact 100% pass: ${a.name}`, async () => {
    const r = await evalArtifact(path.join(FIXTURES, a.file));
    assert.equal(r.n, a.evals, `eval count mismatch for ${a.name}`);
    assert.equal(r.passed, a.evals, `${a.name} must pass all evals (got ${r.passed}/${a.evals}; errors: ${JSON.stringify(r.errors)})`);
    assert.equal(r.accuracy, 1.0);
    assert.ok(r.p50_latency_us > 0);
  });

  test(`benchmark 0 egress + 100% pass: ${a.name}`, async () => {
    const report = await benchmarkArtifact(path.join(FIXTURES, a.file), {
      runs: 2,
      target: 'test',
      device: 'ci',
    });
    assert.equal(report.spec, 'kolm-benchmark-1');
    assert.equal(report.privacy.runtime_egress_attempts, 0, `${a.name} must not attempt egress`);
    assert.equal(report.privacy.blocked, false);
    assert.equal(report.evals.accuracy, 1.0, `${a.name} benchmark accuracy must be 1.0; errors: ${JSON.stringify(report.errors)}`);
    assert.equal(report.evals.passed, report.evals.graded);
    assert.equal(report.integrity.signature_valid, true);
    assert.equal(report.integrity.receipt_present, true);
    assert.equal(report.integrity.receipt_chain_steps, 5);
    assert.ok(report.latency_us.p50 > 0);
    assert.ok(report.latency_us.p95 >= report.latency_us.p50);
    assert.ok(report.k_score > 0);
  });
}

// --- tenant-params behaviours: any buyer can pass per-call config ---

test('tenant params: redactor extra_patterns redacts EMP_ID', async () => {
  const r = await runArtifact(path.join(FIXTURES, 'redactor.kolm'),
    { text: 'employee 12-345 logged in' },
    { params: { extra_patterns: [{ name: 'EMP_ID', regex: '\\b\\d{2}-\\d{3}\\b', replacement: '[EMP_ID]' }] } });
  assert.equal(r.output.redacted, 'employee [EMP_ID] logged in');
  // JSON-roundtrip strips the cross-realm prototype the vm-sandboxed recipe returns
  assert.deepEqual(JSON.parse(JSON.stringify(r.output.hits)), [{ name: 'EMP_ID', count: 1 }]);
});

test('tenant params: redactor redact_words literal', async () => {
  const r = await runArtifact(path.join(FIXTURES, 'redactor.kolm'),
    { text: 'project rosebud is go' },
    { params: { redact_words: ['rosebud'] } });
  assert.equal(r.output.redacted, 'project [REDACTED] is go');
});

test('tenant params: extractor extra_rules extracts case_id', async () => {
  const r = await runArtifact(path.join(FIXTURES, 'extractor.kolm'),
    { text: 'CASE-2026-0042 priority high' },
    { params: { extra_rules: [{ name: 'case_id', regex: 'CASE-\\d{4}-\\d{4}' }] } });
  assert.equal(r.output.fields.case_id, 'CASE-2026-0042');
});

test('tenant params: classifier extra_categories classifies rma', async () => {
  const r = await runArtifact(path.join(FIXTURES, 'classifier.kolm'),
    { text: 'Hardware order DOA-1234 arrived dead' },
    { params: { extra_categories: [{ name: 'rma', keywords: ['doa', 'rma', 'dead on arrival'], weight: 2 }] } });
  assert.equal(r.output.label, 'rma');
  assert.equal(r.output.score, 2);
});

// --- audit-sink callback: SDK / MCP / CLI all rely on this hook ---

test('audit callback fires once per run with kolm-audit-1 entry', async () => {
  const calls = [];
  const audit = (entry) => { calls.push(entry); };
  const r = await runArtifact(path.join(FIXTURES, 'redactor.kolm'),
    { text: 'mail me at foo@example.com' },
    { audit });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].spec, 'kolm-audit-1');
  assert.equal(calls[0].ok, true);
  assert.equal(calls[0].recipe_id, r.recipe_id);
  assert.equal(typeof calls[0].input_sha256_prefix, 'string');
  assert.equal(typeof calls[0].latency_us, 'number');
  assert.equal(typeof calls[0].ran_at, 'string');
  assert.ok(calls[0].input_preview.includes('foo@example.com'));
});

// --- safety hard-limits: input size + recipe timeout ---

test('input-size cap rejects payloads over MAX_INPUT_BYTES', async () => {
  const big = 'a'.repeat(2 * 1024 * 1024);
  await assert.rejects(
    () => runArtifact(path.join(FIXTURES, 'sample.kolm'), { text: big }),
    (err) => err.code === 'KOLM_E_INPUT_TOO_LARGE',
    'must throw KOLM_E_INPUT_TOO_LARGE'
  );
});

// --- signature negative test: a tampered manifest rejects ---

test('signature: tampering manifest in zip is detected', async () => {
  const AdmZip = (await import('adm-zip')).default;
  const fs = await import('node:fs');
  const os = await import('node:os');
  const src = path.join(FIXTURES, 'sample.kolm');
  const tmp = path.join(os.tmpdir(), `kolm-tampered-${process.pid}-${Date.now()}.kolm`);
  // Build the tampered zip in-memory then write fresh — adm-zip's in-place
  // rewrite drops some descriptors; writing a brand-new file avoids that.
  const original = new AdmZip(src);
  const fresh = new AdmZip();
  for (const e of original.getEntries()) {
    if (e.entryName === 'manifest.json') {
      const json = JSON.parse(e.getData().toString('utf8'));
      json.task = 'tampered: drop all data';
      fresh.addFile(e.entryName, Buffer.from(JSON.stringify(json), 'utf8'));
    } else {
      fresh.addFile(e.entryName, e.getData());
    }
  }
  fresh.writeZip(tmp);
  assert.throws(
    () => loadArtifact(tmp),
    (err) => err.code === 'KOLM_E_SIGNATURE_INVALID',
    'tampered manifest must reject with KOLM_E_SIGNATURE_INVALID'
  );
  try { fs.unlinkSync(tmp); } catch {}
});
