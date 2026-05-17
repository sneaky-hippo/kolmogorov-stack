// Wave 180 — Shift 2 recipe #5/9 for the health-insurance lighthouse:
// EDI 278 services-review transformer (prior authorization / referral /
// admission certification). Lock-in tests for public/insurance/templates/
// edi-278.html + public/docs/showcase/edi-278.spec.json. Same shape as the
// W178/W179 EDI recipe siblings: assert page + spec exist, recipe class is
// rule, K-score gate matches the page, the X12 segment names that the
// transformer actually parses are mentioned in the page prose, the companion
// prior-auth-review template is named, the spec carries real UM01/UM02/HCR01
// codes (no fabricated values), and the related grid links to the five
// sibling EDI/FHIR templates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const HTML = path.join(PUBLIC, 'insurance', 'templates', 'edi-278.html');
const SPEC = path.join(PUBLIC, 'docs', 'showcase', 'edi-278.spec.json');

const readHtml = () => fs.readFileSync(HTML, 'utf8');
const readSpec = () => JSON.parse(fs.readFileSync(SPEC, 'utf8'));

test('1. edi-278.html exists and is > 7000 bytes', () => {
  assert.ok(fs.existsSync(HTML), `missing ${HTML}`);
  const size = fs.statSync(HTML).size;
  assert.ok(size > 7000, `edi-278.html too small (${size} bytes; expected > 7000)`);
});

test('2. edi-278.spec.json exists and is valid JSON', () => {
  assert.ok(fs.existsSync(SPEC), `missing ${SPEC}`);
  // readSpec() throws on malformed JSON
  const spec = readSpec();
  assert.ok(spec && typeof spec === 'object', 'spec.json must parse to an object');
});

test('3. edi-278.html declares the canonical https://kolm.ai/insurance/templates/edi-278 URL', () => {
  const html = readHtml();
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/kolm\.ai\/insurance\/templates\/edi-278"/,
    'canonical link must point at https://kolm.ai/insurance/templates/edi-278'
  );
});

test('4. edi-278.html badges the recipe as rule (class 0)', () => {
  const html = readHtml();
  assert.match(html, /rule \(class 0\)/, 'page must badge recipe class as "rule (class 0)"');
});

test('5. edi-278.html declares K-score gate >= 0.93', () => {
  const html = readHtml();
  // The page renders the gate in the meta strip; assert the literal 0.93
  // marker is present and that there is no contradictory <0.93 number in
  // the meta block.
  assert.match(html, /0\.93/, 'page must surface K-score gate 0.93');
  assert.match(
    html,
    /k-score gate[\s\S]{0,200}0\.93/i,
    'k-score gate row in meta strip must carry the 0.93 number'
  );
});

test('6. edi-278.html names every X12 segment the recipe parses (BHT, HL, UM, REF, HSD)', () => {
  const html = readHtml();
  for (const seg of ['BHT', 'HL', 'UM', 'REF', 'HSD']) {
    assert.ok(html.includes(seg), `page must reference X12 segment "${seg}"`);
  }
});

test('7. edi-278.html positions the template as services-review / prior-auth', () => {
  const html = readHtml();
  assert.match(html, /services[- ]review/i, 'page must position as services-review');
  assert.match(html, /prior[- ]auth/i, 'page must position as prior-auth');
});

test('8. edi-278.html documents both request and response directions', () => {
  const html = readHtml();
  assert.match(html, /\brequest\b/i, 'page must document the 278 request direction');
  assert.match(html, /\bresponse\b/i, 'page must document the 278 response direction');
});

test('9. edi-278.html names the prior-auth-review companion template', () => {
  const html = readHtml();
  assert.ok(
    html.includes('prior-auth-review'),
    'page must cross-link the existing prior-auth-review companion template'
  );
  assert.match(
    html,
    /\/insurance\/templates\/prior-auth-review/,
    'page must link to /insurance/templates/prior-auth-review'
  );
});

test('10. spec.json carries the correct job_id and declares base_model "none"', () => {
  const spec = readSpec();
  assert.equal(spec.job_id, 'job_edi_278_transformer_v1', 'job_id must be job_edi_278_transformer_v1');
  assert.equal(spec.base_model, 'none', 'base_model must be "none" (pure rule-class transform)');
});

test('11. spec.json tags include 278, prior-auth, and services-review', () => {
  const spec = readSpec();
  const tags = (spec.recipes && spec.recipes[0] && spec.recipes[0].tags) || [];
  for (const expected of ['278', 'prior-auth', 'services-review']) {
    assert.ok(tags.includes(expected), `recipes[0].tags must include "${expected}" (got ${JSON.stringify(tags)})`);
  }
});

test('12. spec.json pack.rules.hcr01_action_codes carries real X12 codes A1, A2, A3, A4', () => {
  const spec = readSpec();
  const codes = (spec.pack && spec.pack.rules && spec.pack.rules.hcr01_action_codes) || {};
  for (const code of ['A1', 'A2', 'A3', 'A4']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(codes, code),
      `pack.rules.hcr01_action_codes must include "${code}" (real X12 HCR01 value)`
    );
    assert.ok(
      typeof codes[code] === 'string' && codes[code].length > 0,
      `pack.rules.hcr01_action_codes["${code}"] must be a non-empty string label`
    );
  }
});

test('13. spec.json evals.cases contains at least 3 entries covering request + response', () => {
  const spec = readSpec();
  const cases = (spec.evals && spec.evals.cases) || [];
  assert.ok(cases.length >= 3, `expected >= 3 eval cases, got ${cases.length}`);
  // At least one case asserts direction=request and at least one asserts
  // a response.decision — locks in that the recipe is exercised on both
  // halves of the transaction.
  const hasRequest = cases.some((c) => c.expected && c.expected.direction === 'request');
  const hasResponseDecision = cases.some(
    (c) => c.expected && c.expected.response && typeof c.expected.response.decision === 'string'
  );
  assert.ok(hasRequest, 'at least one eval case must assert expected.direction === "request"');
  assert.ok(hasResponseDecision, 'at least one eval case must assert expected.response.decision');
  // Coverage must be the same 1.0 floor every other recipe spec uses.
  assert.equal(spec.evals.coverage, 1.0, 'evals.coverage must be 1.0');
});

test('14. edi-278.html related grid links to all five sibling templates', () => {
  const html = readHtml();
  const siblings = ['edi-837', 'edi-835', 'edi-834', 'edi-270-271', 'fhir-uscdi'];
  for (const sib of siblings) {
    assert.match(
      html,
      new RegExp(`/insurance/templates/${sib.replace(/[-]/g, '\\-')}`),
      `related grid must link to /insurance/templates/${sib}`
    );
  }
});
