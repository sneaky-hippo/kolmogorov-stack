// Wave 177 - EDI 835 ERA transformer recipe.
//
// Recipe #2 of 9 in Shift 2 (Doc 3 health-insurance vertical). Locks the
// public template page at /insurance/templates/edi-835 plus its companion
// spec at /docs/showcase/edi-835.spec.json against the contract spelled
// out in the wave plan: rule-class (class 0) deterministic transformer,
// K-score gate >= 0.94, real X12 5010A1 CLP02 status codes + CAS01 group
// codes, balance-check semantics, and a related-templates grid pointing
// at the other 5 EDI / FHIR siblings.
//
// Same lock-in style as tests/wave175-quickstart-integration.test.js:
// every claim on the page maps to a constant the recipe loads at run
// time, so the page cannot drift away from the spec it documents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HTML = path.join(REPO, 'public', 'insurance', 'templates', 'edi-835.html');
const SPEC = path.join(REPO, 'public', 'docs', 'showcase', 'edi-835.spec.json');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /insurance/templates/edi-835 HTML exists and is > 7000 bytes', () => {
  assert.ok(fs.existsSync(HTML), `edi-835.html missing at ${HTML}`);
  const stat = fs.statSync(HTML);
  assert.ok(stat.size > 7000,
    `edi-835.html too small (${stat.size} bytes; expected > 7000)`);
});

test('2. /docs/showcase/edi-835.spec.json exists and is valid JSON', () => {
  assert.ok(fs.existsSync(SPEC), `edi-835.spec.json missing at ${SPEC}`);
  const raw = read(SPEC);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(raw); },
    'edi-835.spec.json must be valid JSON');
  assert.equal(typeof parsed, 'object');
});

test('3. HTML declares canonical https://kolm.ai/insurance/templates/edi-835', () => {
  const html = read(HTML);
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/insurance\/templates\/edi-835"/,
    'edi-835.html must declare canonical https://kolm.ai/insurance/templates/edi-835');
});

test('4. HTML surfaces recipe class "rule (class 0)"', () => {
  const html = read(HTML);
  // Must appear at least once in the badges or meta strip so the
  // class commitment is visible to a reader scanning the page.
  const occurrences = (html.match(/rule \(class 0\)/g) || []).length;
  assert.ok(occurrences >= 1,
    `edi-835.html must surface "rule (class 0)" at least once (found ${occurrences})`);
});

test('5. HTML advertises K-score gate >= 0.94', () => {
  const html = read(HTML);
  // 0.94 is the published gate for this template; higher than the 0.95
  // claims-adjudication gate is fine but the published value must be 0.94.
  assert.match(html, /0\.94/, 'edi-835.html must publish the 0.94 K-score gate');
  assert.match(html, /k-score gate/i, 'edi-835.html must label the gate');
});

test('6. HTML names the load-bearing 835 segments: BPR, TRN, CLP, SVC, PLB', () => {
  const html = read(HTML);
  for (const seg of ['BPR', 'TRN', 'CLP', 'SVC', 'PLB']) {
    assert.ok(html.includes(seg),
      `edi-835.html must name the ${seg} segment so the page matches the parser`);
  }
});

test('7. HTML names the 5010A1 ERA loop coverage', () => {
  const html = read(HTML);
  assert.ok(html.includes('5010A1'),
    'edi-835.html must name the 5010A1 implementation guide it covers');
  assert.match(html, /ERA/, 'edi-835.html must mention ERA (Electronic Remittance Advice)');
});

test('8. HTML explains balance-check semantics (computed vs declared, BPR vs CLP+PLB)', () => {
  const html = read(HTML);
  assert.match(html, /balance[\s-]?check/i,
    'edi-835.html must discuss balance-check');
  for (const key of ['computed_total', 'declared_total', 'balanced']) {
    assert.ok(html.includes(key),
      `edi-835.html must show the ${key} field in the balance-check output`);
  }
  // BPR is the declared total source; the equation must surface that.
  assert.match(html, /BPR/, 'balance-check explanation must reference BPR');
});

test('9. spec.json job_id and base_model are correct', () => {
  const spec = JSON.parse(read(SPEC));
  assert.equal(spec.job_id, 'job_edi_835_transformer_v1',
    `job_id must be "job_edi_835_transformer_v1" (got "${spec.job_id}")`);
  assert.equal(spec.base_model, 'none',
    `base_model must be "none" for a rule-class recipe (got "${spec.base_model}")`);
  assert.equal(spec.license, 'LicenseRef-kolm-default-1.0',
    `license must default to "LicenseRef-kolm-default-1.0" (got "${spec.license}")`);
});

test('10. spec.json recipe id, name, and tags include "era" + "remittance"', () => {
  const spec = JSON.parse(read(SPEC));
  assert.equal(spec.recipes.length, 1, 'spec.json must define exactly one recipe');
  const r = spec.recipes[0];
  assert.equal(r.id, 'rcp_edi_835_v1',
    `recipe id must be "rcp_edi_835_v1" (got "${r.id}")`);
  assert.equal(r.name, 'edi-835',
    `recipe name must be "edi-835" (got "${r.name}")`);
  assert.ok(Array.isArray(r.tags), 'recipe.tags must be an array');
  for (const tag of ['era', 'remittance']) {
    assert.ok(r.tags.includes(tag),
      `recipe.tags must include "${tag}" (got ${JSON.stringify(r.tags)})`);
  }
});

test('11. spec.json pack.rules.claim_status_codes contains real X12 5010 codes 1, 2, 4, 22', () => {
  const spec = JSON.parse(read(SPEC));
  const codes = spec.pack && spec.pack.rules && spec.pack.rules.claim_status_codes;
  assert.ok(codes, 'spec.pack.rules.claim_status_codes must exist');
  // These four CLP02 codes are required because: 1 (primary, the common
  // case), 2 (secondary, COB), 4 (denied, fail-fast), 22 (reversal,
  // posting-system reversal handling). Each is a real X12 5010 value.
  for (const code of ['1', '2', '4', '22']) {
    assert.ok(Object.prototype.hasOwnProperty.call(codes, code),
      `claim_status_codes must define "${code}" (real X12 5010 CLP02 value)`);
    assert.ok(typeof codes[code] === 'string' && codes[code].length > 0,
      `claim_status_codes["${code}"] must be a non-empty label`);
  }
});

test('12. spec.json pack.rules.group_codes contains CARC groups CO, OA, PI, PR', () => {
  const spec = JSON.parse(read(SPEC));
  const groups = spec.pack && spec.pack.rules && spec.pack.rules.group_codes;
  assert.ok(groups, 'spec.pack.rules.group_codes must exist');
  for (const g of ['CO', 'OA', 'PI', 'PR']) {
    assert.ok(Object.prototype.hasOwnProperty.call(groups, g),
      `group_codes must define "${g}" (real CAS01 adjustment group qualifier)`);
    assert.ok(typeof groups[g] === 'string' && groups[g].length > 0,
      `group_codes["${g}"] must be a non-empty label`);
  }
});

test('13. spec.json evals.cases has >= 3 entries and coverage is 1.0', () => {
  const spec = JSON.parse(read(SPEC));
  const cases = spec.evals && spec.evals.cases;
  assert.ok(Array.isArray(cases), 'spec.evals.cases must be an array');
  assert.ok(cases.length >= 3,
    `spec.evals.cases must have >= 3 entries (got ${cases.length})`);
  assert.equal(spec.evals.coverage, 1.0,
    `spec.evals.coverage must be 1.0 (got ${spec.evals.coverage})`);
  // Each case must declare its expected balance_check.balanced boolean
  // so the eval can grade pass/fail deterministically.
  for (const c of cases) {
    assert.ok(c.expected && c.expected.balance_check &&
      typeof c.expected.balance_check.balanced === 'boolean',
      `eval case "${c.id}" must declare expected.balance_check.balanced as boolean`);
  }
});

test('14. HTML links to all 5 sibling EDI / FHIR templates in the related grid', () => {
  const html = read(HTML);
  const siblings = [
    'edi-837',
    'edi-834',
    'edi-270-271',
    'edi-278',
    'fhir-uscdi',
  ];
  for (const sib of siblings) {
    const re = new RegExp(`href="/insurance/templates/${sib}"`);
    assert.match(html, re,
      `edi-835.html related grid must link to /insurance/templates/${sib}`);
  }
});
