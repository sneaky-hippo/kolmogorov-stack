// Wave 358 — seeds score behavior tests.

import test from 'node:test';
import assert from 'node:assert/strict';

import { score } from '../src/seeds-score.js';

test('score: diverse PHI rows -> high uniqueness, phi-redactor domain, coverage map', () => {
  const rows = [
    { input: 'Patient John Smith arrived', expected: 'Patient [PHI_NAME_1] arrived' },
    { input: 'Call Maria Garcia at 555-867-5309', expected: 'Call [PHI_NAME_1] at [PHI_PHONE_1]' },
    { input: 'DOB 01/15/1980 for chart review', expected: 'DOB [PHI_DATE_1] for chart review' },
    { input: 'SSN: 123-45-6789 verified', expected: 'SSN: [PHI_SSN_1] verified' },
    { input: 'Email: hi@example.com on file', expected: 'Email: [PHI_EMAIL_1] on file' },
    { input: 'MRN: M1234567 for review', expected: 'MRN: [PHI_MRN_1] for review' },
    { input: 'NPI: 1234567890 in directory', expected: 'NPI: [PHI_NPI_1] in directory' },
    { input: 'Member ID: HP9988', expected: 'Member ID: [PHI_HPID_1]' },
  ];
  const r = score(rows);
  assert.ok(r.uniqueness > 0.5, `expected uniqueness > 0.5, got ${r.uniqueness}`);
  assert.equal(r.coverage.domain, 'phi-redactor');
  assert.ok(Array.isArray(r.coverage.present));
  assert.ok(Array.isArray(r.coverage.missing));
  assert.ok(r.coverage.present.length >= 5, `expected >=5 PHI classes hit, got ${r.coverage.present.length}`);
  assert.ok(r.label_quality > 0.5);
  assert.ok(Array.isArray(r.recommendations));
  assert.ok(r.recommendations.length > 0);
});

test('score: duplicate-heavy rows -> low uniqueness', () => {
  const rows = Array.from({ length: 20 }, () => ({ input: 'identical row', output: 'X' }));
  const r = score(rows);
  assert.ok(r.uniqueness < 0.3, `expected uniqueness < 0.3, got ${r.uniqueness}`);
});

test('score: missing PHI classes flagged in recommendations', () => {
  const rows = [
    { input: 'Patient John Smith', expected: 'Patient [PHI_NAME_1]' },
    { input: 'Patient Jane Doe', expected: 'Patient [PHI_NAME_1]' },
  ];
  const r = score(rows);
  assert.equal(r.coverage.domain, 'phi-redactor');
  assert.ok(r.coverage.missing.length > 5, `expected many missing PHI classes, got ${r.coverage.missing.length}`);
  const text = r.recommendations.join(' | ');
  assert.match(text, /missing|coverage/i);
});

test('score: generic domain when no PHI tokens present', () => {
  const rows = [
    { input: 'translate hello to spanish', output: 'hola' },
    { input: 'translate cat to spanish', output: 'gato' },
    { input: 'translate dog to spanish', output: 'perro' },
    { input: 'translate water to spanish', output: 'agua' },
  ];
  const r = score(rows);
  assert.equal(r.coverage.domain, 'generic');
  assert.ok(Array.isArray(r.coverage.present));
});

test('score: empty rows return 0 row_count and not NaN', () => {
  const r = score([]);
  assert.equal(r.row_count, 0);
  assert.ok(typeof r.uniqueness === 'number');
  assert.ok(typeof r.label_quality === 'number');
  assert.ok(!Number.isNaN(r.uniqueness));
  assert.ok(!Number.isNaN(r.label_quality));
});

test('score: label_quality penalizes empty / runaway outputs', () => {
  const good = [
    { input: 'a', output: 'one' },
    { input: 'b', output: 'two' },
    { input: 'c', output: 'three' },
  ];
  const bad = [
    { input: 'a', output: '' },
    { input: 'b', output: 'b' }, // output == input
    { input: 'c', output: 'three' },
  ];
  const g = score(good);
  const b = score(bad);
  assert.ok(g.label_quality > b.label_quality);
});
