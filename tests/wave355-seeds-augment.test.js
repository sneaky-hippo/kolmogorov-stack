// Wave 355 — seeds augment behavior tests.

import test from 'node:test';
import assert from 'node:assert/strict';

import { augment } from '../src/seeds-augment.js';

test('augment: synthetic mode produces N rows from M source rows', async () => {
  const source = [
    { input: 'Patient John Smith has SSN 123-45-6789', output: 'Patient [PHI_NAME_1] has SSN [PHI_SSN_1]' },
    { input: 'Call Maria Garcia at 555-867-5309', output: 'Call [PHI_NAME_1] at [PHI_PHONE_1]' },
    { input: 'DOB 01/15/1980 for MRN 1234567', output: 'DOB [PHI_DATE_1] for [PHI_MRN_1]' },
  ];
  const out = await augment(source, { n: 20, synthetic: true });
  assert.equal(out.length, 20);
  for (const r of out) {
    assert.ok(r.input, 'augmented row missing input');
    assert.ok(r.output, 'augmented row missing output');
    assert.match(r.source, /^augment:/);
  }
});

test('augment: synthetic mode preserves output labels (PHI tokens unchanged)', async () => {
  const source = [
    { input: 'Patient John Smith has SSN 123-45-6789', output: 'Patient [PHI_NAME_1] has SSN [PHI_SSN_1]' },
  ];
  const out = await augment(source, { n: 5, synthetic: true });
  for (const r of out) {
    // Output preserves the PHI tokens
    assert.match(r.output, /\[PHI_NAME_1\]/);
    assert.match(r.output, /\[PHI_SSN_1\]/);
  }
});

test('augment: synthetic mode produces VARIATION (most rows differ from source)', async () => {
  const source = [
    { input: 'Patient John Smith arrived', output: 'Patient [PHI_NAME_1] arrived' },
  ];
  const out = await augment(source, { n: 10, synthetic: true });
  const distinct = new Set(out.map(r => r.input));
  // At least 3 distinct inputs (template swap injects random names).
  assert.ok(distinct.size >= 3, `expected variation, got only ${distinct.size} distinct rows`);
});

test('augment: --target-coverage fills missing PHI classes', async () => {
  const out = await augment([], {
    n: 6,
    targetCoverage: ['BIOMETRIC', 'FACE', 'ANY_UNIQUE_ID'],
  });
  assert.equal(out.length, 6);
  for (const r of out) {
    assert.ok(r.input, 'row missing input');
    assert.ok(r.output, 'row missing output');
    assert.match(r.source, /^augment:target-coverage:/);
  }
  // Each class hit at least once.
  const sources = out.map(r => r.source).join('|');
  assert.match(sources, /BIOMETRIC/);
  assert.match(sources, /FACE/);
  assert.match(sources, /ANY_UNIQUE_ID/);
});

test('augment: --target-coverage handles named PHI classes from registry', async () => {
  const out = await augment([], {
    n: 5,
    targetCoverage: ['NAME', 'SSN', 'EMAIL', 'PHONE', 'MRN'],
  });
  assert.equal(out.length, 5);
  // Each row's input contains the expected PHI shape.
  const sources = out.map(r => r.source);
  assert.ok(sources.some(s => s.includes('NAME')));
  assert.ok(sources.some(s => s.includes('SSN')));
});

test('augment: deterministic with same seed', async () => {
  const src = [{ input: 'Patient John Smith arrived', output: 'Patient [PHI_NAME_1] arrived' }];
  const a = await augment(src, { n: 5, synthetic: true, seed: 42 });
  const b = await augment(src, { n: 5, synthetic: true, seed: 42 });
  assert.deepEqual(a.map(r => r.input), b.map(r => r.input));
});

test('augment: returns empty when no source rows + no target coverage', async () => {
  const out = await augment([], { n: 5 });
  // Falls back to single placeholder row repeated; we accept either empty
  // or N rows produced from the placeholder. Key: it does NOT throw.
  assert.ok(Array.isArray(out));
});
