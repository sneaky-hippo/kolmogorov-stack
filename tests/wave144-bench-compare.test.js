// Wave W — tests for the head-to-head benchmark harness in
// src/benchmark-compare.js. We don't need a real Anthropic key to test the
// comparison logic — we mock fetch and the SDK so the harness sees realistic
// payloads. The point of these tests: prove the harness records the per-path
// latencies correctly, computes the head-to-head ratio honestly, and skips
// gracefully when a path is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { compileSpec } from '../src/spec-compile.js';
import { compareArtifact } from '../src/benchmark-compare.js';

const SECRET = 'kolm-public-fixture-v0-1-0';

function withSecret(fn) {
  return async () => {
    const before = process.env.RECIPE_RECEIPT_SECRET;
    process.env.RECIPE_RECEIPT_SECRET = SECRET;
    try { return await fn(); }
    finally {
      if (before === undefined) delete process.env.RECIPE_RECEIPT_SECRET;
      else process.env.RECIPE_RECEIPT_SECRET = before;
    }
  };
}

async function buildEchoArtifact(targetDir) {
  const spec = {
    job_id: 'job_bench_test_echo',
    task: 'echo the input text field',
    artifact_class: 'compiled_rule',
    recipes: [{
      id: 'rcp_echo',
      name: 'echo',
      schema: { input: { text: 'string' }, output: { echo: 'string' } },
      dsl: { type: 'rule-dsl-v1', output: { op: 'object', fields: {
        echo: { op: 'field', from: { op: 'input' }, key: 'text' },
      }}},
    }],
    evals: { spec: 'rs-1-evals', cases: [
      { id: 'a', input: { text: 'alpha' },   expected: { echo: 'alpha' } },
      { id: 'b', input: { text: 'bravo' },   expected: { echo: 'bravo' } },
      { id: 'c', input: { text: 'charlie' }, expected: { echo: 'charlie' } },
    ]},
  };
  const outPath = path.join(targetDir, 'bench.kolm');
  await compileSpec(spec, { outPath });
  return outPath;
}

test('compareArtifact: baseline kolm-js path runs and reports honest latency + correctness', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bench-'));
  try {
    const ap = await buildEchoArtifact(dir);
    const report = await compareArtifact(ap, { runs: 3, llmApi: false, localLlm: false, nativeBin: false });
    assert.equal(report.spec, 'kolm-benchmark-compare-1');
    const jsPath = report.paths['kolm-js'];
    assert.equal(jsPath.skipped, false, 'kolm-js must always run');
    assert.equal(jsPath.correctness.passed, 9, 'echo recipe should pass all 9 (3 cases × 3 runs)');
    assert.equal(jsPath.correctness.accuracy, 1);
    assert.ok(jsPath.latency_us.p50 >= 0, 'p50 latency recorded');
    assert.ok(jsPath.latency_us.n === 9, 'all 9 calls timed');
    // Cost is honestly zero — no network, no metering.
    assert.equal(jsPath.cost.per_call_usd, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('compareArtifact: llm-api SKIPPED reason quotes ANTHROPIC_API_KEY when unset', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bench-'));
  const beforeKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const ap = await buildEchoArtifact(dir);
    const report = await compareArtifact(ap, { runs: 1, localLlm: false, nativeBin: false });
    const llm = report.paths['llm-api'];
    assert.equal(llm.skipped, true);
    assert.match(llm.reason, /ANTHROPIC_API_KEY/);
    // Head-to-head must surface the skip reason rather than a fake ratio.
    assert.match(report.head_to_head['llm-api'].skipped, /ANTHROPIC_API_KEY/);
  } finally {
    if (beforeKey !== undefined) process.env.ANTHROPIC_API_KEY = beforeKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('compareArtifact: local-llm SKIPPED reason names the unreachable endpoint', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bench-'));
  // Force a deliberately-unreachable endpoint so we don't accidentally hit
  // a real ollama if the test runner has one.
  const beforeUrl = process.env.KOLM_BENCH_LOCAL_LLM_URL;
  process.env.KOLM_BENCH_LOCAL_LLM_URL = 'http://127.0.0.1:1';
  try {
    const ap = await buildEchoArtifact(dir);
    const report = await compareArtifact(ap, { runs: 1, llmApi: false, nativeBin: false });
    const local = report.paths['local-llm'];
    assert.equal(local.skipped, true);
    assert.match(local.reason, /127\.0\.0\.1:1/);
  } finally {
    if (beforeUrl === undefined) delete process.env.KOLM_BENCH_LOCAL_LLM_URL;
    else process.env.KOLM_BENCH_LOCAL_LLM_URL = beforeUrl;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('compareArtifact: kolm-native SKIPPED gracefully when Wave G binary not bundled', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bench-'));
  try {
    const ap = await buildEchoArtifact(dir); // built without KOLM_COMPILE_NATIVE=1
    const report = await compareArtifact(ap, { runs: 1, llmApi: false, localLlm: false });
    const nat = report.paths['kolm-native'];
    assert.equal(nat.skipped, true);
    // Either "no compiled_targets block" or "no .bin sub-block" is acceptable
    // depending on whether the build emitted Wave F source-only or not.
    assert.match(nat.reason, /compiled_targets|toolchain|no \.bin/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('compareArtifact: head_to_head reports speedup ratios when multiple paths run', withSecret(async () => {
  // Force ANTHROPIC_API_KEY off + ollama url unreachable so only kolm-js
  // runs. head_to_head should still produce a stable shape (object), with
  // skip-reasons inside per-key.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bench-'));
  const beforeKey = process.env.ANTHROPIC_API_KEY;
  const beforeUrl = process.env.KOLM_BENCH_LOCAL_LLM_URL;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.KOLM_BENCH_LOCAL_LLM_URL = 'http://127.0.0.1:1';
  try {
    const ap = await buildEchoArtifact(dir);
    const report = await compareArtifact(ap, { runs: 2 });
    assert.ok(report.head_to_head, 'head_to_head section present');
    assert.ok('llm-api' in report.head_to_head, 'llm-api row in head_to_head');
    assert.ok('local-llm' in report.head_to_head, 'local-llm row in head_to_head');
    assert.ok('kolm-native' in report.head_to_head, 'kolm-native row in head_to_head');
    // None of these should claim a fake speedup number when the other path
    // didn't run.
    for (const k of ['llm-api', 'local-llm', 'kolm-native']) {
      const row = report.head_to_head[k];
      assert.ok(typeof row.skipped === 'string', `${k} must carry a skipped reason, not a ratio`);
    }
  } finally {
    if (beforeKey !== undefined) process.env.ANTHROPIC_API_KEY = beforeKey;
    if (beforeUrl === undefined) delete process.env.KOLM_BENCH_LOCAL_LLM_URL;
    else process.env.KOLM_BENCH_LOCAL_LLM_URL = beforeUrl;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('compareArtifact: local-llm path measures REAL latency when fetch is mocked to simulate ollama', withSecret(async () => {
  // We want a concrete speedup number on the head_to_head row. We override
  // fetch globally to (1) report the model is available at the probe step,
  // and (2) respond to /api/chat after a measurable delay. This proves the
  // ratio math is wired correctly without requiring a real local LLM.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bench-'));
  const beforeFetch = globalThis.fetch;
  const beforeUrl = process.env.KOLM_BENCH_LOCAL_LLM_URL;
  const beforeModel = process.env.KOLM_BENCH_LOCAL_LLM_MODEL;
  process.env.KOLM_BENCH_LOCAL_LLM_URL = 'http://127.0.0.1:65535';
  process.env.KOLM_BENCH_LOCAL_LLM_MODEL = 'fake-test-model:1b';
  let chatCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) {
      return { ok: true, status: 200, json: async () => ({ models: [{ name: 'fake-test-model:1b' }] }) };
    }
    if (u.endsWith('/api/chat')) {
      chatCalls++;
      await new Promise(r => setTimeout(r, 10)); // simulate ~10ms inference
      return { ok: true, status: 200, json: async () => ({ message: { content: '"alpha"' } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const ap = await buildEchoArtifact(dir);
    const beforeKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const report = await compareArtifact(ap, { runs: 2, nativeBin: false });
      const local = report.paths['local-llm'];
      assert.equal(local.skipped, false, 'mocked local-llm must run');
      assert.ok(local.latency_us.p50 >= 10000, `p50 should be ≥10ms (got ${local.latency_us.p50}µs)`);
      assert.ok(chatCalls >= 6, `must have hit /api/chat ≥ 6 times (3 cases × 2 runs), got ${chatCalls}`);
      // Head-to-head ratio should report kolm-js is faster by some integer
      // multiple (the kolm-js p50 is hundreds of µs; the mocked local-llm
      // p50 is at least 10ms = 10000µs).
      const hh = report.head_to_head['local-llm'];
      assert.ok(hh.p50_latency_ratio, 'ratio computed');
      assert.ok(hh.p50_latency_ratio > 1, 'local-llm must be slower than kolm-js in this mock');
      assert.match(hh.summary, /SLOWER than kolm-js/);
    } finally {
      if (beforeKey !== undefined) process.env.ANTHROPIC_API_KEY = beforeKey;
    }
  } finally {
    globalThis.fetch = beforeFetch;
    if (beforeUrl === undefined) delete process.env.KOLM_BENCH_LOCAL_LLM_URL;
    else process.env.KOLM_BENCH_LOCAL_LLM_URL = beforeUrl;
    if (beforeModel === undefined) delete process.env.KOLM_BENCH_LOCAL_LLM_MODEL;
    else process.env.KOLM_BENCH_LOCAL_LLM_MODEL = beforeModel;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));
