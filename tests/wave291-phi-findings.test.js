// Wave 291 - Structured PHI findings + safe_to_send fail-closed signal.
//
// Behavior tests for the new redactPhi() / classifyPhi() / isValidNpi() /
// isValidSsn() surface added to src/phi-redactor.js. The legacy redact() and
// reinject() functions are untouched; they are exercised by wave144.
//
// Each test pins a requirement from the W291 spec:
//
//   - redactPhi returns {redacted_text, map, findings, safe_to_send}
//   - well-formed SSN: type 'ssn', safe_to_send:true, redacted
//   - space-separated SSN: type 'ssn_malformed', safe_to_send:true
//   - invalid SSN range (000-00-0000): type 'ssn_malformed',
//     reason 'invalid SSN range', safe_to_send:false
//   - isValidNpi: Luhn-mod-10 with 80840 prefix per NPI Final Rule
//   - NPI Luhn pass (1234567893): type 'npi', redacted
//   - NPI Luhn fail (1234567890): type 'npi_invalid', safe_to_send:false,
//     NOT redacted (the spec says redacted:false for npi_invalid)
//   - DOB ISO valid: type 'dob', redacted
//   - DOB malformed (9999-99-99): type 'dob_malformed', safe_to_send:true
//   - ZIP+4: type 'address_fragment'
//   - classifyPhi on clean text: empty findings, safe_to_send:true
//   - raw value is NEVER present in finding objects, only raw_hash

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  redact,
  redactPhi,
  classifyPhi,
  isValidNpi,
  isValidSsn,
} from '../src/phi-redactor.js';

// --------------------------------------------------------------------------
// 1. Return-shape contract
// --------------------------------------------------------------------------

test('redactPhi returns redacted_text + map + findings + safe_to_send', () => {
  const out = redactPhi('hello world');
  assert.ok(Object.hasOwn(out, 'redacted_text'), 'has redacted_text');
  assert.ok(Object.hasOwn(out, 'map'), 'has map');
  assert.ok(Object.hasOwn(out, 'findings'), 'has findings');
  assert.ok(Object.hasOwn(out, 'safe_to_send'), 'has safe_to_send');
  assert.equal(typeof out.redacted_text, 'string');
  assert.equal(typeof out.map, 'object');
  assert.ok(Array.isArray(out.findings));
  assert.equal(typeof out.safe_to_send, 'boolean');
});

test('redactPhi on clean text: empty findings, safe_to_send:true', () => {
  const out = redactPhi('the quick brown fox jumps over the lazy dog');
  assert.equal(out.findings.length, 0);
  assert.equal(out.safe_to_send, true);
  assert.equal(out.redacted_text, 'the quick brown fox jumps over the lazy dog');
});

test('legacy redact() return shape is unchanged (back-compat)', () => {
  const out = redact('Email: a@b.co');
  assert.ok(Object.hasOwn(out, 'redacted'));
  assert.ok(Object.hasOwn(out, 'map'));
  // The legacy function does NOT add findings/safe_to_send.
  assert.equal(Object.hasOwn(out, 'findings'), false);
  assert.equal(Object.hasOwn(out, 'safe_to_send'), false);
});

// --------------------------------------------------------------------------
// 2. SSN variants
// --------------------------------------------------------------------------

test("redactPhi('SSN is 123-45-6789') -> one ssn finding, safe_to_send:true", () => {
  const out = redactPhi('SSN is 123-45-6789');
  const ssn = out.findings.find((f) => f.type === 'ssn');
  assert.ok(ssn, 'has a finding with type=ssn');
  assert.equal(ssn.safe_to_send, true);
  assert.equal(ssn.redacted, true);
  assert.equal(ssn.severity, 'critical');
  assert.equal(out.safe_to_send, true);
  assert.match(out.redacted_text, /\[PHI_SSN_/);
  assert.ok(!out.redacted_text.includes('123-45-6789'), 'raw SSN removed from redacted_text');
});

test("redactPhi('SSN is 123 45 6789') -> ssn_malformed, safe_to_send:true (still redacted)", () => {
  const out = redactPhi('SSN is 123 45 6789');
  const f = out.findings.find((x) => x.type === 'ssn_malformed');
  assert.ok(f, 'has a finding with type=ssn_malformed');
  assert.equal(f.safe_to_send, true);
  assert.equal(f.redacted, true);
  assert.equal(out.safe_to_send, true);
  assert.match(out.redacted_text, /\[PHI_SSN_/);
});

test("redactPhi('SSN is 000-00-0000') -> ssn_malformed with reason 'invalid SSN range', safe_to_send:false", () => {
  const out = redactPhi('SSN is 000-00-0000');
  const f = out.findings.find((x) => x.type === 'ssn_malformed');
  assert.ok(f, 'has a finding with type=ssn_malformed');
  assert.equal(f.reason, 'invalid SSN range');
  assert.equal(f.safe_to_send, false);
  assert.equal(out.safe_to_send, false, 'top-level safe_to_send AND-folds to false');
  // Still redacted even though malformed — spec wants the bytes removed.
  assert.equal(f.redacted, true);
});

test("dot-separated SSN '123.45.6789' -> ssn_malformed", () => {
  const out = redactPhi('SSN: 123.45.6789');
  const f = out.findings.find((x) => x.type === 'ssn_malformed');
  assert.ok(f);
  assert.equal(f.reason, 'dot-separated SSN');
});

// --------------------------------------------------------------------------
// 3. NPI Luhn
// --------------------------------------------------------------------------

test('isValidNpi: 1234567893 passes the NPI Luhn check', () => {
  // The wave144 test already uses 1234567893 as a "real" labeled NPI; it
  // satisfies Luhn-mod-10 with the 80840 prefix.
  assert.equal(isValidNpi('1234567893'), true);
});

test('isValidNpi: 1003000126 passes the NPI Luhn check', () => {
  assert.equal(isValidNpi('1003000126'), true);
});

test('isValidNpi: 1234567890 fails the NPI Luhn check', () => {
  assert.equal(isValidNpi('1234567890'), false);
});

test('isValidNpi: 9-digit and non-digit inputs reject', () => {
  assert.equal(isValidNpi('123456789'), false);
  assert.equal(isValidNpi('abcdefghij'), false);
  assert.equal(isValidNpi(''), false);
  assert.equal(isValidNpi(null), false);
});

test("redactPhi('NPI 1234567893') -> finding type 'npi'", () => {
  const out = redactPhi('NPI 1234567893');
  const f = out.findings.find((x) => x.type === 'npi');
  assert.ok(f, 'has a finding with type=npi');
  assert.equal(f.redacted, true);
  assert.equal(f.safe_to_send, true);
});

test("redactPhi('NPI 1234567890') -> finding type 'npi_invalid', safe_to_send:false", () => {
  const out = redactPhi('NPI 1234567890');
  const f = out.findings.find((x) => x.type === 'npi_invalid');
  assert.ok(f, 'has a finding with type=npi_invalid');
  assert.equal(f.redacted, false);
  assert.equal(f.safe_to_send, false);
  assert.equal(out.safe_to_send, false);
});

// --------------------------------------------------------------------------
// 4. SSN range validator
// --------------------------------------------------------------------------

test('isValidSsn: well-formed 123-45-6789 valid', () => {
  assert.equal(isValidSsn('123-45-6789'), true);
  assert.equal(isValidSsn('123456789'), true);
});

test('isValidSsn: area 000 / 666 / 900+ rejected', () => {
  assert.equal(isValidSsn('000-12-3456'), false);
  assert.equal(isValidSsn('666-12-3456'), false);
  assert.equal(isValidSsn('900-12-3456'), false);
});

test('isValidSsn: group 00 and serial 0000 rejected', () => {
  assert.equal(isValidSsn('123-00-1234'), false);
  assert.equal(isValidSsn('123-45-0000'), false);
});

// --------------------------------------------------------------------------
// 5. DOB detectors
// --------------------------------------------------------------------------

test("redactPhi('DOB 1985-05-12') -> finding type 'dob'", () => {
  const out = redactPhi('DOB 1985-05-12');
  const f = out.findings.find((x) => x.type === 'dob');
  assert.ok(f, 'has a finding with type=dob');
  assert.equal(f.redacted, true);
  assert.equal(f.safe_to_send, true);
  assert.match(out.redacted_text, /\[PHI_DATE_/);
});

test("redactPhi('Date 9999-99-99') -> finding type 'dob_malformed'", () => {
  const out = redactPhi('Date 9999-99-99');
  const f = out.findings.find((x) => x.type === 'dob_malformed');
  assert.ok(f, 'has a finding with type=dob_malformed');
  assert.equal(f.reason, 'impossible date');
  assert.equal(f.safe_to_send, true);
  assert.equal(f.redacted, false);
});

test('redactPhi: US date 04/19/2024 -> dob (well-formed)', () => {
  const out = redactPhi('Admitted 04/19/2024');
  const f = out.findings.find((x) => x.type === 'dob');
  assert.ok(f);
});

test('redactPhi: US date 13/40/2024 -> dob_malformed', () => {
  const out = redactPhi('Date 13/40/2024');
  const f = out.findings.find((x) => x.type === 'dob_malformed');
  assert.ok(f);
});

// --------------------------------------------------------------------------
// 6. Address fragment + MRN + account
// --------------------------------------------------------------------------

test("redactPhi('5-digit ZIP+4: 94103-1234') -> finding type 'address_fragment'", () => {
  const out = redactPhi('5-digit ZIP+4: 94103-1234');
  const f = out.findings.find((x) => x.type === 'address_fragment');
  assert.ok(f, 'has a finding with type=address_fragment');
  assert.equal(f.redacted, true);
  assert.equal(f.safe_to_send, true);
});

test("redactPhi('MRN: A1B2C3') -> finding type 'mrn'", () => {
  const out = redactPhi('MRN: A1B2C3');
  const f = out.findings.find((x) => x.type === 'mrn');
  assert.ok(f, 'has a finding with type=mrn');
  assert.equal(f.redacted, true);
});

test("redactPhi('Account 1234567890123') -> finding type 'account_no'", () => {
  const out = redactPhi('Account 1234567890123');
  const f = out.findings.find((x) => x.type === 'account_no');
  assert.ok(f, 'has a finding with type=account_no');
  assert.equal(f.redacted, true);
});

// --------------------------------------------------------------------------
// 7. classifyPhi (no-redaction)
// --------------------------------------------------------------------------

test("classifyPhi('plain text with no PHI') -> {findings:[], safe_to_send:true}", () => {
  const out = classifyPhi('plain text with no PHI');
  assert.deepEqual(out.findings, []);
  assert.equal(out.safe_to_send, true);
});

test('classifyPhi surfaces findings without rewriting input', () => {
  const out = classifyPhi('SSN is 123-45-6789');
  assert.ok(out.findings.find((f) => f.type === 'ssn'));
  assert.equal(out.safe_to_send, true);
  // classifyPhi has no redacted_text field by contract.
  assert.equal(Object.hasOwn(out, 'redacted_text'), false);
});

test('classifyPhi: fail-closed on malformed SSN', () => {
  const out = classifyPhi('SSN is 000-00-0000');
  assert.equal(out.safe_to_send, false);
});

// --------------------------------------------------------------------------
// 8. raw_hash hygiene — raw value MUST NOT appear in the finding object
// --------------------------------------------------------------------------

test('raw value never appears in the finding object; only raw_hash + optional normalized_candidate', () => {
  const out = redactPhi('SSN is 123-45-6789 and DOB 1985-05-12 and Email me at sensitive@example.com');
  for (const f of out.findings) {
    // raw_hash is the only field that carries the digest of the raw bytes.
    assert.match(f.raw_hash, /^sha256:[0-9a-f]{64}$/, `raw_hash well-formed for ${f.type}`);
    // The finding object itself MUST NOT carry the raw string anywhere.
    const json = JSON.stringify(f);
    // The original SSN must not leak through.
    assert.ok(!json.includes('123-45-6789') || f.normalized_candidate === '123-45-6789' && json.indexOf('123-45-6789') === json.indexOf(f.normalized_candidate),
      `raw SSN bytes only appear via normalized_candidate (if at all) for ${f.type}`);
    // The original email must not leak through verbatim.
    assert.ok(!json.includes('sensitive@example.com') || f.normalized_candidate === 'sensitive@example.com' && json.indexOf('sensitive@example.com') === json.indexOf(f.normalized_candidate),
      `raw email bytes only appear via normalized_candidate for ${f.type}`);
  }
});

test('raw_hash is deterministic sha256 of the raw matched substring', () => {
  const out = redactPhi('SSN is 123-45-6789');
  const ssn = out.findings.find((f) => f.type === 'ssn');
  const expected = 'sha256:' + crypto.createHash('sha256').update('123-45-6789').digest('hex');
  assert.equal(ssn.raw_hash, expected);
});

// --------------------------------------------------------------------------
// 9. safe_to_send fold semantics
// --------------------------------------------------------------------------

test('top-level safe_to_send is AND across findings: any false -> false', () => {
  const out = redactPhi('SSN is 123-45-6789 and a bad SSN 000-00-0000');
  // At least one well-formed ssn (safe), at least one malformed (unsafe).
  const sevs = out.findings.map((f) => f.safe_to_send);
  assert.ok(sevs.includes(true) && sevs.includes(false), 'mixed individual safety');
  assert.equal(out.safe_to_send, false);
});

test('span indices are non-negative integers within input bounds', () => {
  const input = 'SSN is 123-45-6789';
  const out = redactPhi(input);
  for (const f of out.findings) {
    assert.ok(Array.isArray(f.span) && f.span.length === 2);
    const [s, e] = f.span;
    assert.ok(Number.isInteger(s) && s >= 0, 'span start non-negative int');
    assert.ok(Number.isInteger(e) && e > s, 'span end is greater than start');
    assert.ok(e <= input.length, 'span end within input');
  }
});
