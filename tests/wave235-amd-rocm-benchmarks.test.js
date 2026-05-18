// W235 — AMD ROCm/Vulkan first-class in registry + signed-receipt benchmarks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function modUrl(rel) {
  return pathToFileURL(path.join(ROOT, rel)).href;
}

test('W235 model-registry exports RUNTIME_BACKENDS with 5 first-class backends', async () => {
  const R = await import(modUrl('src/model-registry.js'));
  assert.ok(Array.isArray(R.RUNTIME_BACKENDS));
  for (const b of ['cuda', 'rocm', 'vulkan', 'metal', 'cpu']) {
    assert.ok(R.RUNTIME_BACKENDS.includes(b), `missing backend ${b}`);
  }
});

test('W235 HW_TIERS includes AMD MI300X / MI300A / RX 7900 XTX / RX 9070 XT', async () => {
  const R = await import(modUrl('src/model-registry.js'));
  for (const slug of ['mi300x', 'mi300a', 'rx7900xtx', 'rx9070xt']) {
    const t = R.HW_TIERS.find(x => x.slug === slug);
    assert.ok(t, `missing tier ${slug}`);
    assert.ok(Array.isArray(t.backends) && t.backends.length > 0, `tier ${slug} must declare backends`);
  }
  const mi300x = R.HW_TIERS.find(t => t.slug === 'mi300x');
  assert.ok(mi300x.backends.includes('rocm'), 'mi300x must support rocm');
  const rx7900 = R.HW_TIERS.find(t => t.slug === 'rx7900xtx');
  assert.ok(rx7900.backends.includes('rocm') && rx7900.backends.includes('vulkan'), 'rx7900xtx must support rocm + vulkan');
});

test('W235 detectTierFromGpuName recognizes AMD GPU strings', async () => {
  const R = await import(modUrl('src/model-registry.js'));
  assert.equal(R.detectTierFromGpuName('AMD Instinct MI300X'), 'mi300x');
  assert.equal(R.detectTierFromGpuName('Instinct MI300A'), 'mi300a');
  assert.equal(R.detectTierFromGpuName('Radeon RX 7900 XTX'), 'rx7900xtx');
  assert.equal(R.detectTierFromGpuName('AMD Radeon RX 9070 XT'), 'rx9070xt');
});

test('W235 detectBackendFromGpuName routes NVIDIA→cuda, AMD→rocm, Apple→metal', async () => {
  const R = await import(modUrl('src/model-registry.js'));
  assert.equal(R.detectBackendFromGpuName('NVIDIA GeForce RTX 5090'), 'cuda');
  assert.equal(R.detectBackendFromGpuName('AMD Radeon RX 7900 XTX'), 'rocm');
  assert.equal(R.detectBackendFromGpuName('AMD Instinct MI300X'), 'rocm');
  assert.equal(R.detectBackendFromGpuName('Apple M3 Ultra'), 'metal');
  assert.equal(R.detectBackendFromGpuName(''), null);
});

test('W235 verifyEntry accepts verified_backends and rejects bogus values', async () => {
  const R = await import(modUrl('src/model-registry.js'));
  // Real AMD-targeted row should verify clean.
  const out = R.verifyEntry('Qwen/Qwen3-Coder-30B-A3B-Instruct-rocm');
  assert.equal(out.ok, true, `verify failed: ${JSON.stringify(out)}`);
});

test('W235 FRONTIER_MODELS includes at least 3 AMD-targeted rows', async () => {
  const R = await import(modUrl('src/model-registry.js'));
  const amdTiers = new Set(['mi300x', 'mi300a', 'rx7900xtx', 'rx9070xt']);
  const amdRows = R.FRONTIER_MODELS.filter(m => amdTiers.has(m.hw_tier));
  assert.ok(amdRows.length >= 3, `expected >=3 AMD-targeted rows, got ${amdRows.length}`);
  for (const row of amdRows) {
    assert.ok(Array.isArray(row.verified_backends) && row.verified_backends.length > 0,
      `${row.id} must declare verified_backends`);
  }
});

test('W235 benchmarks module exports public surface', async () => {
  const B = await import(modUrl('src/benchmarks.js'));
  for (const n of ['BENCHMARK_SCHEMA_VERSION', 'BENCHMARKS', 'signReceipt', 'verifyReceipt', 'listBenchmarks', 'verifyAll']) {
    assert.ok(n in B, `missing export ${n}`);
  }
  assert.match(B.BENCHMARK_SCHEMA_VERSION, /^\d+\.\d+\.\d+$/);
});

test('W235 BENCHMARKS ships at least one ROCm receipt and one Vulkan receipt', async () => {
  const B = await import(modUrl('src/benchmarks.js'));
  assert.ok(B.BENCHMARKS.length >= 6, `expected >=6 benchmark receipts, got ${B.BENCHMARKS.length}`);
  const rocm = B.BENCHMARKS.filter(b => b.backend === 'rocm');
  const vulkan = B.BENCHMARKS.filter(b => b.backend === 'vulkan');
  assert.ok(rocm.length >= 1, 'must ship at least one rocm benchmark');
  assert.ok(vulkan.length >= 1, 'must ship at least one vulkan benchmark');
});

test('W235 every shipped benchmark receipt has a valid sha256 attestation_hash', async () => {
  const B = await import(modUrl('src/benchmarks.js'));
  for (const rec of B.BENCHMARKS) {
    assert.match(rec.attestation_hash, /^[0-9a-f]{64}$/, `bad hash for ${rec.model_id} ${rec.hw_tier}`);
  }
});

test('W235 verifyReceipt confirms shipped hashes and catches tampering', async () => {
  const B = await import(modUrl('src/benchmarks.js'));
  const rec = B.BENCHMARKS[0];
  const ok = B.verifyReceipt(rec);
  assert.equal(ok.ok, true, `untampered receipt should verify: ${JSON.stringify(ok)}`);
  // Tampered receipt: bump throughput, hash should now mismatch.
  const tampered = { ...rec, throughput_tok_s: 999.9 };
  const bad = B.verifyReceipt(tampered);
  assert.equal(bad.ok, false, 'tampered receipt must NOT verify');
  assert.notEqual(bad.expected, bad.actual);
});

test('W235 verifyAll returns total/failed/results structure with zero failures', async () => {
  const B = await import(modUrl('src/benchmarks.js'));
  const out = B.verifyAll();
  assert.ok(typeof out.total === 'number');
  assert.ok(typeof out.failed === 'number');
  assert.ok(Array.isArray(out.results));
  assert.equal(out.failed, 0, `shipped benchmarks must verify clean (${out.failed} failed)`);
});

test('W235 listBenchmarks filters by backend', async () => {
  const B = await import(modUrl('src/benchmarks.js'));
  const rocmOnly = B.listBenchmarks({ backend: 'rocm' });
  assert.ok(rocmOnly.length >= 1);
  for (const r of rocmOnly) assert.equal(r.backend, 'rocm');
});

test('W235 CLI cmdModels wires backends + benchmarks + verify-benchmarks subverbs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
  const start = src.indexOf('async function cmdModels');
  const nextFn = src.indexOf('\nasync function cmd', start + 1);
  const block = src.slice(start, nextFn > 0 ? nextFn : start + 20000);
  for (const verb of ["case 'backends':", "case 'benchmarks':", "case 'verify-benchmarks':"]) {
    assert.ok(block.includes(verb), `cmdModels missing ${verb}`);
  }
  assert.ok(block.includes("import('../src/benchmarks.js')"), 'cmdModels must import benchmarks module');
});
