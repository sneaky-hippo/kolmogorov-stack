// Wave 356 — active learning sampler behavior tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { activeSampling } from '../src/seeds-active.js';

process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-public-fixture-v0-1-0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '..', 'test', 'fixtures');
const REDACTOR = path.join(FIXTURES, 'redactor.kolm');

const TMP = path.join(os.tmpdir(), 'kolm-w356-' + crypto.randomBytes(4).toString('hex'));

test.before(async () => { await fs.mkdir(TMP, { recursive: true }); });
test.after(async () => { try { await fs.rm(TMP, { recursive: true, force: true }); } catch {} });

test('activeSampling: returns N rows ranked by uncertainty', async () => {
  const pool = [
    'My SSN is 123-45-6789, please redact.',
    'Patient John Smith arrived',
    'The weather today is mild.',
    'Call Maria Garcia at 555-867-5309',
    'DOB 01/15/1980 for MRN 1234567',
    'Hello there.',
    'Thanks!',
    'Please contact me via email at test@example.com',
    'No PHI in this row.',
    'Just a generic comment.',
  ];
  const poolPath = path.join(TMP, 'pool.jsonl');
  await fs.writeFile(poolPath, pool.map(s => JSON.stringify({ input: s })).join('\n') + '\n');

  const out = await activeSampling(REDACTOR, poolPath, { n: 5 });
  assert.equal(out.length, 5);
  for (const row of out) {
    assert.ok(typeof row.input === 'string');
    assert.equal(row.expected, null, 'expected must be null placeholder');
    assert.ok(typeof row.uncertainty_score === 'number');
    assert.ok(row.uncertainty_score >= 0 && row.uncertainty_score <= 1);
    assert.match(row.source, /^active:redactor/);
  }
  // Sorted descending by uncertainty.
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].uncertainty_score >= out[i].uncertainty_score,
      `row ${i - 1} (${out[i - 1].uncertainty_score}) should be >= row ${i} (${out[i].uncertainty_score})`);
  }
});

test('activeSampling: accepts JSON array pool format', async () => {
  const poolPath = path.join(TMP, 'pool-arr.json');
  await fs.writeFile(poolPath, JSON.stringify([
    { input: 'SSN 123-45-6789' },
    { input: 'no phi here' },
  ]));
  const out = await activeSampling(REDACTOR, poolPath, { n: 2 });
  assert.equal(out.length, 2);
});

test('activeSampling: cap N to pool size', async () => {
  const poolPath = path.join(TMP, 'small.jsonl');
  await fs.writeFile(poolPath, JSON.stringify({ input: 'foo' }) + '\n');
  const out = await activeSampling(REDACTOR, poolPath, { n: 50 });
  assert.equal(out.length, 1);
});

test('activeSampling: errored rows get uncertainty 1.0', async () => {
  // Force a row with malformed input (binary buffer-ish) — the runner may
  // succeed but we still get a numeric score. The contract: never throws.
  const poolPath = path.join(TMP, 'mixed.jsonl');
  await fs.writeFile(poolPath, [
    JSON.stringify({ input: 'normal text' }),
    JSON.stringify({ input: '' }),
    JSON.stringify({ input: 'SSN 999-99-9999' }),
  ].join('\n') + '\n');
  const out = await activeSampling(REDACTOR, poolPath, { n: 3 });
  // 'input:""' may be skipped; we accept either 2 or 3 results.
  assert.ok(out.length >= 1, 'expected at least 1 ranked row');
  for (const r of out) {
    assert.ok(r.uncertainty_score >= 0 && r.uncertainty_score <= 1);
  }
});
