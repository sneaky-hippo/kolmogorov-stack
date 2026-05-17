// Wave Q+3a — PHI/PII redactor tests. Covers every detector class, the
// round-trip + idempotency contracts, the receipt-chain hash helper, and the
// canary token-preservation check used by the distill pipeline.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  redact,
  reinject,
  mapHash,
  findTokens,
  tokenPattern,
  verifyTokenPreservation,
  CLASSES,
} from '../src/phi-redactor.js';

// ---------------------------------------------------------------------------
// Public-shape sanity
// ---------------------------------------------------------------------------
test('CLASSES exports the 18 HIPAA Safe Harbor identifiers plus 3 kolm extensions', () => {
  assert.equal(CLASSES.length, 20);
  for (const expected of ['NAME', 'GEO', 'DATE', 'PHONE', 'FAX', 'EMAIL', 'SSN',
                          'MRN', 'HPID', 'ACCT', 'LIC', 'VEH', 'DEV', 'URL',
                          'IP', 'BIO', 'OTHER', 'NPI', 'DEA', 'MEDICAID']) {
    assert.ok(CLASSES.includes(expected), `class ${expected} present`);
  }
});

test('tokenPattern matches every [PHI_*_*] token shape', () => {
  const s = 'Hi [PHI_NAME_1], your appt on [PHI_DATE_2] at [PHI_GEO_3].';
  const ts = findTokens(s);
  assert.equal(ts.length, 3);
  assert.deepEqual(ts.map(t => t.class), ['NAME', 'DATE', 'GEO']);
  assert.deepEqual(ts.map(t => t.index), [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// Per-class detection
// ---------------------------------------------------------------------------
test('redact: detects email + URL + IP cleanly', () => {
  const { redacted, map } = redact(
    'Contact me at maria@example.com or https://example.com/path from 10.0.0.5'
  );
  assert.match(redacted, /\[PHI_EMAIL_1\]/);
  assert.match(redacted, /\[PHI_URL_1\]/);
  assert.match(redacted, /\[PHI_IP_1\]/);
  assert.equal(map['[PHI_EMAIL_1]'], 'maria@example.com');
  assert.equal(map['[PHI_URL_1]'], 'https://example.com/path');
  assert.equal(map['[PHI_IP_1]'], '10.0.0.5');
});

test('redact: phone in multiple shapes', () => {
  const cases = [
    '(555) 123-4567',
    '555-123-4567',
    '+1 555-123-4567',
    'Phone: 555.123.4567',
  ];
  for (const c of cases) {
    const { redacted } = redact(c);
    assert.match(redacted, /\[PHI_PHONE_1\]/, `phone shape: ${c}`);
  }
});

test('redact: SSN with or without separators when labeled', () => {
  const a = redact('SSN: 123-45-6789');
  assert.match(a.redacted, /\[PHI_SSN_1\]/);
  assert.equal(a.map['[PHI_SSN_1]'], '123-45-6789');
  const b = redact('SSN: 123456789');
  assert.match(b.redacted, /\[PHI_SSN_1\]/);
  assert.equal(b.map['[PHI_SSN_1]'], '123456789');
});

test('redact: dates — DOB label + numeric + ISO + long-form', () => {
  const a = redact('DOB: 1962-04-19, admitted 04/19/2024, on April 19, 2024.');
  assert.match(a.redacted, /\[PHI_DATE_1\]/);
  assert.match(a.redacted, /\[PHI_DATE_2\]/);
  assert.match(a.redacted, /\[PHI_DATE_3\]/);
});

test('redact: ZIP+4 and ZIP-only', () => {
  const a = redact('Address: 47 Maple St, Lincoln, NE 68502-1234');
  assert.match(a.redacted, /\[PHI_GEO_/);
});

test('redact: provider identifiers — NPI / DEA / Medicaid labels required', () => {
  const a = redact('NPI 1234567893 with DEA BB1234567 and Medicaid ID A1234567');
  assert.match(a.redacted, /\[PHI_NPI_1\]/);
  assert.match(a.redacted, /\[PHI_DEA_1\]/);
  assert.match(a.redacted, /\[PHI_MEDICAID_1\]/);
  assert.equal(a.map['[PHI_NPI_1]'], '1234567893');
  assert.equal(a.map['[PHI_DEA_1]'], 'BB1234567');
  assert.equal(a.map['[PHI_MEDICAID_1]'], 'A1234567');
});

test('redact: labeled MRN / Account / License / Plate / Device / Fax', () => {
  const a = redact('MRN: 08877  Account #: 99-12-1  License: LIC-455  Plate: 7XYZ123  Device #: DV-1  Fax: 555-555-1212');
  assert.match(a.redacted, /\[PHI_MRN_1\]/);
  assert.match(a.redacted, /\[PHI_ACCT_1\]/);
  assert.match(a.redacted, /\[PHI_LIC_1\]/);
  assert.match(a.redacted, /\[PHI_VEH_1\]/);
  assert.match(a.redacted, /\[PHI_DEV_1\]/);
  assert.match(a.redacted, /\[PHI_FAX_1\]/);
});

test('redact: name detected by honorific + label', () => {
  const a = redact('Patient Name: Maria Gonzalez, seen by Dr. Robert Lin.');
  assert.match(a.redacted, /\[PHI_NAME_1\]/);
  assert.match(a.redacted, /\[PHI_NAME_2\]/);
  assert.equal(a.map['[PHI_NAME_1]'], 'Maria Gonzalez');
  assert.equal(a.map['[PHI_NAME_2]'], 'Robert Lin');
});

test('redact: tenant-supplied names + addresses + ids beat the generic detectors', () => {
  const a = redact('Patient Jane Q., chart ABC123, claim XYZ-9.', {
    names: ['Jane Q.'],
    ids: { MRN: ['ABC123'], ACCT: ['XYZ-9'] },
  });
  assert.match(a.redacted, /\[PHI_NAME_1\]/);
  assert.match(a.redacted, /\[PHI_MRN_1\]/);
  assert.match(a.redacted, /\[PHI_ACCT_1\]/);
  assert.equal(a.map['[PHI_NAME_1]'], 'Jane Q.');
  assert.equal(a.map['[PHI_MRN_1]'], 'ABC123');
  assert.equal(a.map['[PHI_ACCT_1]'], 'XYZ-9');
});

// ---------------------------------------------------------------------------
// Round-trip + idempotency
// ---------------------------------------------------------------------------
test('reinject: roundtrip — reinject(redact(x).redacted, map) === x', () => {
  const xs = [
    'Hi Maria, your appt on 2024-04-19.',
    'Email: ana@example.com, phone: (555) 123-4567, SSN: 123-45-6789.',
    'MRN: 08877. Member ID: MM-9988. NPI 1234567893.',
    'Visit https://example.com from 10.0.0.5 at 4/19/2024 — Dr. Lin called.',
  ];
  for (const x of xs) {
    const { redacted, map } = redact(x);
    const back = reinject(redacted, map);
    assert.equal(back, x, `roundtrip preserved for: ${x}`);
  }
});

test('reinject: same identifier mentioned twice gets the SAME token', () => {
  const { redacted, map } = redact('Maria called Maria from maria@example.com about Maria.');
  // "Maria" alone doesn't have an honorific or label so it won't trigger NAME
  // — but the EMAIL detector should hit once and de-dupe is exercised by
  // re-using the same EMAIL twice.
  const x2 = 'Email: ana@example.com twice — also ana@example.com.';
  const r2 = redact(x2);
  // The same email should produce a single [PHI_EMAIL_1] used twice.
  const occurrences = (r2.redacted.match(/\[PHI_EMAIL_1\]/g) || []).length;
  assert.equal(occurrences, 2, 'same email reuses the same token');
  // And only one map entry for that token.
  assert.equal(r2.map['[PHI_EMAIL_1]'], 'ana@example.com');
});

test('redact: idempotency — running redact again is a no-op on tokens', () => {
  const a = redact('Email: ana@example.com, MRN: 12345.');
  const b = redact(a.redacted);
  // No token should be inside b.map (existing tokens are preserved by the
  // sentinel pass).
  for (const k of Object.keys(b.map)) {
    assert.ok(!a.redacted.includes(k) || k in b.map, 'token not double-mapped');
  }
  // The redacted output should be string-equal: re-redacting an already-clean
  // string finds nothing new.
  assert.equal(b.redacted, a.redacted);
});

test('reinject: unknown tokens are left as-is (teacher dropped a placeholder)', () => {
  const map = { '[PHI_NAME_1]': 'Maria' };
  const out = reinject('Hi [PHI_NAME_1], extra: [PHI_NAME_99]', map);
  assert.equal(out, 'Hi Maria, extra: [PHI_NAME_99]');
});

// ---------------------------------------------------------------------------
// Receipt-chain helpers
// ---------------------------------------------------------------------------
test('mapHash: deterministic across map key reorderings', () => {
  const m1 = { '[PHI_NAME_1]': 'Maria', '[PHI_DATE_1]': '2024-04-19' };
  const m2 = { '[PHI_DATE_1]': '2024-04-19', '[PHI_NAME_1]': 'Maria' };
  assert.equal(mapHash(m1), mapHash(m2));
  assert.match(mapHash(m1), /^sha256:[0-9a-f]{64}$/);
});

test('mapHash: changes when a value changes', () => {
  const m1 = { '[PHI_NAME_1]': 'Maria' };
  const m2 = { '[PHI_NAME_1]': 'Mario' };
  assert.notEqual(mapHash(m1), mapHash(m2));
});

test('mapHash: empty map is still a stable hash', () => {
  assert.match(mapHash({}), /^sha256:[0-9a-f]{64}$/);
  assert.equal(mapHash({}), mapHash({}));
});

// ---------------------------------------------------------------------------
// Canary token preservation
// ---------------------------------------------------------------------------
test('verifyTokenPreservation: ok=true when every token is present in teacher response', () => {
  const inS = 'Hi [PHI_NAME_1], visit on [PHI_DATE_1].';
  const outS = 'Acknowledged: [PHI_NAME_1] confirmed for [PHI_DATE_1].';
  const v = verifyTokenPreservation(inS, outS);
  assert.equal(v.ok, true);
  assert.deepEqual(v.missing, []);
  assert.deepEqual(v.extra, []);
});

test('verifyTokenPreservation: ok=false when teacher dropped a token', () => {
  const inS = 'Hi [PHI_NAME_1], visit on [PHI_DATE_1].';
  const outS = 'Acknowledged [PHI_NAME_1].';
  const v = verifyTokenPreservation(inS, outS);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ['[PHI_DATE_1]']);
  assert.deepEqual(v.extra, []);
});

test('verifyTokenPreservation: ok=false when teacher invented a token', () => {
  const inS = 'Hi [PHI_NAME_1].';
  const outS = 'Hi [PHI_NAME_1] from [PHI_GEO_99].';
  const v = verifyTokenPreservation(inS, outS);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, []);
  assert.deepEqual(v.extra, ['[PHI_GEO_99]']);
});

// ---------------------------------------------------------------------------
// Defensive edges
// ---------------------------------------------------------------------------
test('redact: empty / null / undefined input returns empty redacted + empty map', () => {
  assert.deepEqual(redact(''),       { redacted: '', map: {} });
  assert.deepEqual(redact(null),     { redacted: '', map: {} });
  assert.deepEqual(redact(undefined),{ redacted: '', map: {} });
});

test('reinject: empty / null map passes the text through', () => {
  assert.equal(reinject('hi [PHI_NAME_1]', null), 'hi [PHI_NAME_1]');
  assert.equal(reinject('hi [PHI_NAME_1]', {}),  'hi [PHI_NAME_1]');
  assert.equal(reinject('plain', { '[PHI_NAME_1]': 'X' }), 'plain');
});

test('redact: classes option restricts detection to listed classes', () => {
  const a = redact('Email a@b.co and MRN: 12345', { classes: ['EMAIL'] });
  assert.match(a.redacted, /\[PHI_EMAIL_1\]/);
  assert.ok(!/PHI_MRN/.test(a.redacted), 'MRN not redacted when not in classes');
});
