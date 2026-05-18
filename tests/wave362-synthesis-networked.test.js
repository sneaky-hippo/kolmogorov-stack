// Wave 362 — synthesis.js networked teacher path.
//
// Closes the W199-W362 gap where seedsNewFromBrief({airGap:false}) returned a
// sentinel "NOT YET WIRED" row. The networked path now calls src/llm-call.js
// when KOLM_LLM_* env is configured, and falls back to a deterministic
// template+synonym augmentation when no key is available.
//
// Behavior tests:
//   1. airGap:true returns deterministic candidates with network_status='air_gap'.
//   2. networked path (no key) returns deterministic candidates with
//      network_status='networked_fallback'. No "NOT YET WIRED" string anywhere.
//   3. networked path with a mocked LLM (in-process HTTP server) returns
//      LLM rows with network_status='networked_llm' and tags include 'networked'.
//   4. The exported seedsNewFromBrief is async (returns a Promise).
//   5. src/synthesis.js no longer contains 'NOT YET WIRED' or 'not_yet_wired'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const SYNTH_PATH = path.join(ROOT, 'src/synthesis.js');

function freshImport() {
  // Append a cache-busting query string so each test gets a clean module
  // copy. seedsNewFromBrief reads env at call-time so this is paranoid;
  // it keeps later tests immune to module-level side-effects regardless.
  return import(pathToFileURL(SYNTH_PATH).href + '?t=' + Date.now());
}

function startMockOpenAI({ rows, failures = 0 }) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    if (calls <= failures) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'mock_transient' }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      const payload = {
        choices: [{
          message: {
            content: JSON.stringify(rows),
          },
        }],
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        getCalls: () => calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('W362 #1 — airGap:true returns deterministic air_gap rows', async () => {
  const { seedsNewFromBrief } = await freshImport();
  const result = await seedsNewFromBrief({
    brief: 'redact PHI from clinical notes',
    classHint: 'rule',
    count: 6,
    airGap: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.network_status, 'air_gap');
  assert.equal(result.class, 'rule');
  assert.equal(result.candidates.length, 6);
  for (const row of result.candidates) {
    assert.ok(row.input && row.output, 'each candidate must have input + output');
    assert.equal(row.synthesized, true);
    assert.ok(Array.isArray(row.tags));
  }
});

test('W362 #2 — networked path without a key falls through to deterministic fallback (no sentinel)', async () => {
  // Wipe any LLM env so isConfigured() is false in this test.
  const SAVED = {};
  for (const k of Object.keys(process.env)) {
    if (/^KOLM_LLM_/.test(k)) { SAVED[k] = process.env[k]; delete process.env[k]; }
  }
  try {
    const { seedsNewFromBrief } = await freshImport();
    const result = await seedsNewFromBrief({
      brief: 'parse EDI 837 claims',
      classHint: 'rule',
      count: 5,
      airGap: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.network_status, 'networked_fallback');
    assert.equal(result.candidates.length, 5);
    for (const row of result.candidates) {
      assert.equal(row.synthesized, true);
      // Sentinel strings from the pre-W362 implementation MUST NOT appear.
      assert.doesNotMatch(String(row.input), /NOT YET WIRED|not_yet_wired/);
      assert.doesNotMatch(String(row.output), /NOT YET WIRED|not_yet_wired/);
    }
  } finally {
    for (const [k, v] of Object.entries(SAVED)) process.env[k] = v;
  }
});

test('W362 #3 — networked path with a configured LLM returns networked_llm rows', async () => {
  const mockRows = [
    { input: 'mock input 1', output: 'mock output 1' },
    { input: 'mock input 2', output: 'mock output 2' },
    { input: 'mock input 3', output: 'mock output 3' },
    { input: 'mock input 4', output: 'mock output 4' },
  ];
  const mock = await startMockOpenAI({ rows: mockRows });
  const SAVED = { ...process.env };
  try {
    process.env.KOLM_LLM_PROVIDER = 'openai';
    process.env.KOLM_LLM_BASE_URL = mock.base;
    process.env.KOLM_LLM_KEY = 'sk-mock';
    process.env.KOLM_LLM_MODEL = 'mock-model';
    process.env.KOLM_LLM_TIMEOUT_MS = '4000';
    process.env.KOLM_LLM_RETRIES = '0';
    const { seedsNewFromBrief } = await freshImport();
    const result = await seedsNewFromBrief({
      brief: 'classify denial codes',
      classHint: 'rule',
      count: 4,
      airGap: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.network_status, 'networked_llm');
    assert.ok(result.candidates.length >= 1, 'expected at least 1 LLM-sourced row');
    assert.equal(result.candidates[0].source, 'networked-llm');
    assert.ok(result.candidates[0].tags.includes('networked'));
    assert.ok(mock.getCalls() >= 1, 'mock LLM must have been called');
  } finally {
    for (const k of Object.keys(process.env)) {
      if (/^KOLM_LLM_/.test(k)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(SAVED)) {
      if (/^KOLM_LLM_/.test(k)) process.env[k] = v;
    }
    await mock.close();
  }
});

test('W362 #4 — seedsNewFromBrief is async (returns a Promise)', async () => {
  const { seedsNewFromBrief } = await freshImport();
  const ret = seedsNewFromBrief({ brief: 'test', classHint: 'rule', count: 1, airGap: true });
  assert.equal(typeof ret.then, 'function', 'must return a thenable');
  await ret;
});

test('W362 #5 — synthesis.js no longer contains NOT YET WIRED / not_yet_wired sentinels', () => {
  const src = fs.readFileSync(SYNTH_PATH, 'utf8');
  assert.doesNotMatch(src, /NOT YET WIRED/);
  assert.doesNotMatch(src, /not_yet_wired/);
});
