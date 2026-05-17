// Wave 144 — multimodal document completeness gate.
//
// Covers: built-in specs (denial-letter, claim-packet, pa-request, eob,
// appeal-letter), forbidden-pattern hits, custom JSON specs, score math,
// verdict thresholds, and the docspec validator.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkDocument, loadBuiltinSpec, BUILTIN_SPECS, DOCSPEC_SPEC } from '../src/doc-check.js';

test('BUILTIN_SPECS: every entry uses the right spec id and has required_patterns', () => {
  for (const [k, v] of Object.entries(BUILTIN_SPECS)) {
    assert.equal(v.spec, DOCSPEC_SPEC, `${k} must declare spec=${DOCSPEC_SPEC}`);
    assert.ok(Array.isArray(v.required_patterns) && v.required_patterns.length > 0, `${k} must have required_patterns`);
    assert.equal(v.name, k);
  }
});

test('loadBuiltinSpec: returns spec for known type, throws for unknown', () => {
  const s = loadBuiltinSpec('denial-letter');
  assert.equal(s.name, 'denial-letter');
  assert.throws(() => loadBuiltinSpec('does-not-exist'), /unknown built-in doc type/);
});

test('checkDocument: complete denial letter passes', () => {
  const text = `
    Dear Member ID 123456,
    We have reviewed your claim and the requested service is denied.
    The reason for this adverse benefit determination is that the procedure
    is not covered under your current plan.
    You may appeal this denial within 60 days by calling 800-555-1234
    or by mailing your appeal to the address above. We will reconsider
    upon receipt of a written grievance.
  `.repeat(2);
  const r = checkDocument(text, loadBuiltinSpec('denial-letter'));
  assert.equal(r.verdict, 'pass', `expected pass, got ${r.verdict} with errors=${r.counts.errors}`);
  assert.equal(r.counts.errors, 0);
  assert.ok(r.score >= 0.9);
});

test('checkDocument: denial letter missing appeal deadline fails', () => {
  const text = `
    Member ID: 123456 — your claim is denied. The reason is that the procedure
    is not covered. You may file an appeal or grievance.
    Contact 800-555-1234.
  `.repeat(5);
  const r = checkDocument(text, loadBuiltinSpec('denial-letter'));
  assert.equal(r.verdict, 'fail');
  const deadlineCheck = r.checks.find(c => c.name === 'appeal_deadline');
  assert.equal(deadlineCheck.passed, false);
  assert.equal(deadlineCheck.severity, 'error');
});

test('checkDocument: claim packet with full required fields passes', () => {
  const text = `
    Patient ID 7777
    NPI 1234567893
    Date of Service: 2026-03-01
    ICD-10 code: J45.909
    CPT code: 99213
    Total charges: $123.45
    Diagnosis: asthma
  `.repeat(3);
  const r = checkDocument(text, loadBuiltinSpec('claim-packet'));
  assert.equal(r.verdict, 'pass', `expected pass, got verdict=${r.verdict} score=${r.score} errors=${r.counts.errors}`);
});

test('checkDocument: appeal letter with placeholder fails on forbidden pattern', () => {
  const text = `
    Dear [insert] Reviewer,
    We are writing to appeal the denial dated [date].
    The medical necessity is established because of the patient's condition.
    Please reverse this determination and reconsider the claim.
    Sincerely,
    Provider
  `.repeat(2);
  const r = checkDocument(text, loadBuiltinSpec('appeal-letter'));
  const placeholder = r.checks.find(c => c.name === 'placeholder');
  assert.equal(placeholder.passed, false);
  assert.equal(r.verdict, 'fail');
});

test('checkDocument: appeal letter with TODO triggers warn but not fail', () => {
  const text = `
    Dear Reviewer,
    We are appealing the denial of claim 12345 because the requested service
    is medically necessary under the plan policy and the patient's documented
    condition. Please reverse the determination and reconsider this claim.
    TODO clean up
    Sincerely,
    Provider
  `.repeat(4);
  const r = checkDocument(text, loadBuiltinSpec('appeal-letter'));
  const todo = r.checks.find(c => c.name === 'todo');
  assert.equal(todo.passed, false);
  assert.equal(todo.severity, 'warn');
  // verdict can be warn (or pass if other warns dominate); the important
  // thing is the error counts: if no error-severity rules failed, no 'fail'.
  assert.notEqual(r.verdict, 'fail');
});

test('checkDocument: word-count gates fire correctly', () => {
  const text = 'one two three';
  const spec = { spec: DOCSPEC_SPEC, name: 'short', min_words: 10 };
  const r = checkDocument(text, spec);
  assert.equal(r.verdict, 'fail');
  const wc = r.checks.find(c => c.name === 'min_words');
  assert.equal(wc.passed, false);
  assert.equal(wc.detail.observed, 3);
  assert.equal(wc.detail.threshold, 10);
});

test('checkDocument: custom spec with required_sections', () => {
  const spec = {
    spec: DOCSPEC_SPEC,
    name: 'two-section',
    required_sections: [
      { name: 'header', heading_regex: '^Header', flags: 'm', severity: 'error' },
      { name: 'body',   heading_regex: '^Body',   flags: 'm', severity: 'error' },
    ],
  };
  const okText = 'Header\nstuff\nBody\nmore';
  const bad    = 'Header\nstuff only';
  assert.equal(checkDocument(okText, spec).verdict, 'pass');
  assert.equal(checkDocument(bad, spec).verdict, 'fail');
});

test('checkDocument: rejects spec with wrong spec id', () => {
  assert.throws(() => checkDocument('x', { spec: 'wrong', name: 'x' }),
    new RegExp(`expected spec=${DOCSPEC_SPEC}`));
});

test('checkDocument: score is in [0,1]', () => {
  const text = 'minimal';
  const spec = loadBuiltinSpec('eob');
  const r = checkDocument(text, spec);
  assert.ok(r.score >= 0 && r.score <= 1, `score must be in [0,1], got ${r.score}`);
});

test('checkDocument: PA request packet with all fields passes', () => {
  const text = `
    Patient John Doe member 7777
    Prior authorization request for arthroscopic knee surgery.
    Medical necessity: chronic pain unresponsive to conservative treatment.
    Provider NPI 1234567893
    ICD-10 diagnosis code: M17.11
    Prior treatments include physical therapy and NSAIDs.
  `.repeat(3);
  const r = checkDocument(text, loadBuiltinSpec('pa-request'));
  assert.equal(r.verdict, 'pass', `verdict=${r.verdict} errors=${r.counts.errors}`);
});
