// Wave 357 — seeds sanitize behavior tests.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitize } from '../src/seeds-sanitize.js';

test('sanitize: drops rows containing real PHI', async () => {
  const rows = [
    { input: 'Patient John Smith has SSN 123-45-6789, MRN 1234567, Phone 555-867-5309. Address: 123 Main St, Springfield 12345', output: 'classify: PHI' },
    { input: 'translate "hello" to spanish', output: 'hola' },
    { input: 'Dr. Maria Garcia called about Account #AB12345', output: 'classify: PHI' },
    { input: 'compile this typescript snippet', output: 'compile output' },
  ];
  const { kept, dropped } = await sanitize(rows);
  assert.ok(dropped.length >= 2, `expected at least 2 PHI drops, got ${dropped.length}`);
  assert.ok(kept.length >= 1, `expected at least 1 kept row, got ${kept.length}`);
  for (const d of dropped) {
    assert.match(d.reason, /phi_present|empty_input|malformed/);
  }
  for (const d of dropped.filter(x => x.reason === 'phi_present')) {
    assert.ok(d.mask_ratio > 0.05);
    assert.ok(Array.isArray(d.classes_found));
  }
});

test('sanitize: keeps redactor-style training rows (output IS the redacted input)', async () => {
  const { redact } = await import('../src/phi-redactor.js');
  const input = 'Patient John Smith has SSN 123-45-6789';
  const { redacted } = redact(input);
  const rows = [
    { input, expected: redacted },
    { input, output: redacted },
  ];
  const { kept, dropped } = await sanitize(rows);
  assert.equal(kept.length, 2, 'redactor training rows must be kept');
  assert.equal(dropped.length, 0);
});

test('sanitize: drops malformed and empty-input rows', async () => {
  const rows = [
    null,
    undefined,
    'a string',
    {},
    { input: '', output: 'something' },
    { input: 'real text', output: 'real label' },
  ];
  const { kept, dropped } = await sanitize(rows);
  assert.equal(kept.length, 1);
  assert.ok(dropped.length >= 4);
});

test('sanitize: maxMaskRatio override', async () => {
  const rows = [
    // A trickle of PHI (small ratio) — kept by default.
    { input: 'A long sentence with one SSN 123-45-6789 buried inside many other words here and there along the way', output: 'classify' },
  ];
  const lax = await sanitize(rows, { maxMaskRatio: 0.5 });
  assert.equal(lax.kept.length, 1);
  const strict = await sanitize(rows, { maxMaskRatio: 0.0 });
  assert.equal(strict.dropped.length, 1);
});

test('sanitize: returns counts that round-trip total', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    input: i % 3 === 0
      ? `Patient John Smith ${i}, SSN 111-22-${String(i).padStart(4, '0')}, MRN 999${i}, Phone 555-200-${String(i).padStart(4, '0')}, Address 100 Oak St ${i}`
      : `simple input ${i}`,
    output: `out ${i}`,
  }));
  const { kept, dropped } = await sanitize(rows);
  assert.equal(kept.length + dropped.length, rows.length);
  assert.ok(dropped.length >= 1, 'at least one row should be dropped');
});
