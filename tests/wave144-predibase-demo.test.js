// Wave 144 — bench-compare harness unit tests (corpus loader + markdown renderer).
// Demo-integration intentionally omitted: a 1000-row keyword router is table
// stakes, not differentiation. The harness lives, the demo doesn't need a
// per-artifact integration test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCorpusJsonl } from '../src/benchmark-compare.js';
import { renderMarkdownReport } from '../src/bench-report-md.js';

test('readCorpusJsonl: canonical {input,output} normalizes to {id,input,expected}', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-corpus-'));
  const p = path.join(tmp, 'canonical.jsonl');
  try {
    fs.writeFileSync(p, [
      JSON.stringify({ input: { text: 'a' }, output: { label: 'refund' } }),
      JSON.stringify({ input: { text: 'b' }, output: { label: 'cancel' } }),
    ].join('\n') + '\n');
    const rows = readCorpusJsonl(p);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { id: 'corpus-1', input: { text: 'a' }, expected: { label: 'refund' }, params: undefined });
    assert.deepEqual(rows[1].expected, { label: 'cancel' });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('readCorpusJsonl: legacy {prompt,completion} normalizes the same way', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-corpus-'));
  const p = path.join(tmp, 'legacy.jsonl');
  try {
    fs.writeFileSync(p, [
      JSON.stringify({ prompt: 'hello', completion: 'world' }),
      JSON.stringify({ id: 'custom', prompt: 'foo', completion: 'bar' }),
    ].join('\n') + '\n');
    const rows = readCorpusJsonl(p);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].input, 'hello');
    assert.equal(rows[0].expected, 'world');
    assert.equal(rows[1].id, 'custom');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('readCorpusJsonl: malformed lines are skipped; valid rows still load', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-corpus-'));
  const p = path.join(tmp, 'mixed.jsonl');
  try {
    fs.writeFileSync(p, [
      JSON.stringify({ input: 'good-1', output: 'a' }),
      'this is not json',
      JSON.stringify({ input: 'good-2', output: 'b' }),
      JSON.stringify({ output: 'no-input' }),
      JSON.stringify({ input: 'good-3', expected: 'c' }),
    ].join('\n') + '\n');
    const rows = readCorpusJsonl(p);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r.input), ['good-1', 'good-2', 'good-3']);
    assert.equal(rows[2].expected, 'c');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

function mockReport() {
  return {
    spec: 'kolm-benchmark-compare-1',
    started_at: '2026-05-16T20:00:00.000Z',
    finished_at: '2026-05-16T20:00:01.000Z',
    artifact: 'C:\\tmp\\demo.kolm',
    artifact_sha256: 'sha256:deadbeef',
    task: 'mock task for renderer test',
    cases: 10, llm_sample_n: 5, runs_per_case: 1,
    host: { platform: 'win32', arch: 'x64', node: 'v24.14.0', hostname: 'TESTHOST' },
    paths: {
      'kolm-js': {
        skipped: false,
        latency_us: { n: 10, min: 100, p50: 200, p95: 400, p99: 800, max: 1000 },
        correctness: { graded: 10, passed: 9, accuracy: 0.9, failures: [
          { id: 'r-1', expected: { intent: 'refund' }, got: { intent: 'cancel' } },
        ]},
        cost: { model: '$/call=0', per_call_usd: 0, per_million_calls_usd: 0 },
      },
      'kolm-native': { skipped: true, reason: 'artifact has no compiled_targets block' },
      'llm-api':     { skipped: true, reason: 'ANTHROPIC_API_KEY not set' },
      'local-llm':   { skipped: true, reason: 'http://127.0.0.1:11434 unreachable' },
    },
    head_to_head: {
      'kolm-native': { skipped: 'artifact has no compiled_targets block' },
      'llm-api':     { skipped: 'ANTHROPIC_API_KEY not set' },
      'local-llm':   { skipped: 'http://127.0.0.1:11434 unreachable' },
    },
  };
}

test('renderMarkdownReport: header + Corpus/Latency/Correctness/Head-to-head/Cost sections present', () => {
  const md = renderMarkdownReport(mockReport());
  assert.match(md, /# Kolm vs\. LLM/);
  assert.match(md, /## Corpus/);
  assert.match(md, /## Latency/);
  assert.match(md, /## Correctness/);
  assert.match(md, /## Head-to-head/);
  assert.match(md, /## Cost/);
  assert.match(md, /\| kolm-js \| 10 \| 100 \| 200 \| 400 \| 800 \| 1,000 \|/);
});

test('renderMarkdownReport: skipped paths render as table rows with inline reason', () => {
  const md = renderMarkdownReport(mockReport());
  assert.match(md, /\| kolm-native \|.*compiled_targets/);
  assert.match(md, /\| llm-api \|.*ANTHROPIC_API_KEY/);
  assert.match(md, /\| local-llm \|.*11434/);
});

test('renderMarkdownReport: surfaces sample failures inline', () => {
  const md = renderMarkdownReport(mockReport());
  assert.match(md, /## Sample failures/);
  assert.match(md, /r-1/);
  assert.match(md, /expected `\{"intent":"refund"\}`/);
  assert.match(md, /got `\{"intent":"cancel"\}`/);
});

test('renderMarkdownReport: header carries artifact sha + host + task', () => {
  const md = renderMarkdownReport(mockReport());
  assert.match(md, /sha256:deadbeef/);
  assert.match(md, /win32\/x64, Node v24\.14\.0/);
  assert.match(md, /mock task for renderer test/);
});
