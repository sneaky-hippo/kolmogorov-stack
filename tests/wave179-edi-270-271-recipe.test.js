// Wave 179 - EDI 270/271 eligibility pair (Shift 2 recipe #4 of 9).
//
// One symmetric transformer covers both sides of the X12 5010A1 eligibility
// loop: the 270 inquiry from provider to payer and the 271 response back.
// Direction auto-detected from ST01 (270 inquiry / 271 response).
//
// These tests lock in:
//   - the HTML template surface lives at /insurance/templates/edi-270-271
//   - the spec.json carries job_id, recipe id, and base_model "none" verbatim
//   - the pack.rules dictionaries are real X12 5010 code values, not fabricated
//   - both 270 and 271 cases are represented in evals
//   - the related-templates grid points at the five sibling EDI/FHIR templates
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HTML = path.join(REPO, 'public', 'insurance', 'templates', 'edi-270-271.html');
const SPEC = path.join(REPO, 'public', 'docs', 'showcase', 'edi-270-271.spec.json');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. HTML template exists and is non-trivial size (> 7000 bytes)', () => {
  assert.ok(fs.existsSync(HTML), `HTML missing at ${HTML}`);
  const stat = fs.statSync(HTML);
  assert.ok(stat.size > 7000,
    `edi-270-271.html too small (${stat.size} bytes; expected > 7000)`);
});

test('2. spec.json exists and is valid JSON', () => {
  assert.ok(fs.existsSync(SPEC), `spec.json missing at ${SPEC}`);
  const raw = read(SPEC);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(raw); },
    'edi-270-271.spec.json must be valid JSON');
  assert.ok(parsed && typeof parsed === 'object', 'spec must parse to an object');
});

test('3. HTML declares canonical https://kolm.ai/insurance/templates/edi-270-271', () => {
  const html = read(HTML);
  assert.match(html,
    /<link rel="canonical" href="https:\/\/kolm\.ai\/insurance\/templates\/edi-270-271"/,
    'HTML must declare canonical URL https://kolm.ai/insurance/templates/edi-270-271');
});

test('4. HTML declares recipe class rule (class 0)', () => {
  const html = read(HTML);
  assert.ok(html.includes('rule (class 0)'),
    'HTML must declare recipe class as "rule (class 0)"');
});

test('5. HTML declares K-score gate >= 0.94', () => {
  const html = read(HTML);
  // Either &ge; 0.94 (display entity) or >= 0.94 (literal) or ">= 0.94" (HTML escaped) - require any form citing 0.94.
  assert.ok(/&ge;\s*0\.94|>=\s*0\.94|gate\s+0\.94/i.test(html),
    'HTML must declare K-score gate >= 0.94 for the eligibility-pair template');
});

test('6. HTML mentions BHT, HL, EQ, EB, AAA segments by name', () => {
  const html = read(HTML);
  for (const seg of ['BHT', 'HL', 'NM1', 'EQ', 'EB', 'AAA']) {
    assert.ok(html.includes(seg),
      `HTML must mention X12 segment ${seg} (load-bearing for the 270/271 loop)`);
  }
});

test('7. HTML names both 270 inquiry and 271 response sides of the loop', () => {
  const html = read(HTML);
  assert.ok(html.includes('270'), 'HTML must reference the 270 transaction');
  assert.ok(html.includes('271'), 'HTML must reference the 271 transaction');
  assert.ok(/inquiry/i.test(html), 'HTML must reference the inquiry direction');
  assert.ok(/response/i.test(html), 'HTML must reference the response direction');
});

test('8. HTML names service-type-code semantics (EQ01 / EB03)', () => {
  const html = read(HTML);
  assert.ok(/service[\s-]?type[\s-]?code/i.test(html),
    'HTML must name the service-type-code concept (load-bearing for 270 EQ01 / 271 EB03)');
  // At least one real X12 service-type-code label should appear in prose.
  assert.ok(
    html.includes('Health Benefit Plan Coverage') ||
    html.includes('Professional (Physician) Visit - Office') ||
    html.includes('Hospital'),
    'HTML must surface at least one real X12 EQ01/EB03 service-type-code label');
});

test('9. spec.json job_id is correct and base_model is "none"', () => {
  const spec = JSON.parse(read(SPEC));
  assert.equal(spec.job_id, 'job_edi_270_271_pair_v1',
    'spec.job_id must be "job_edi_270_271_pair_v1"');
  assert.equal(spec.base_model, 'none',
    'spec.base_model must be "none" (rule-class recipe, no model inference)');
  assert.equal(spec.license, 'LicenseRef-kolm-default-1.0',
    'spec.license must be LicenseRef-kolm-default-1.0');
});

test('10. spec.json recipe id is correct and tags include eligibility + "270" + "271"', () => {
  const spec = JSON.parse(read(SPEC));
  assert.ok(Array.isArray(spec.recipes) && spec.recipes.length === 1,
    'spec.recipes must be a single-entry array (one symmetric transformer covers the pair)');
  const r = spec.recipes[0];
  assert.equal(r.id, 'rcp_edi_270_271_v1',
    'recipe.id must be "rcp_edi_270_271_v1"');
  assert.equal(r.name, 'edi-270-271',
    'recipe.name must be "edi-270-271"');
  assert.ok(Array.isArray(r.tags), 'recipe.tags must be an array');
  for (const t of ['eligibility', '270', '271']) {
    assert.ok(r.tags.includes(t),
      `recipe.tags must include "${t}" (got: ${r.tags.join(', ')})`);
  }
});

test('11. spec.json pack.rules.service_type_codes contains real X12 EQ01 codes ("30", "47", "98")', () => {
  const spec = JSON.parse(read(SPEC));
  const stc = spec.pack && spec.pack.rules && spec.pack.rules.service_type_codes;
  assert.ok(stc && typeof stc === 'object',
    'spec.pack.rules.service_type_codes must be an object');
  // Real X12 5010 EQ01 codes; these labels are load-bearing for downstream UI.
  assert.equal(stc['30'], 'Health Benefit Plan Coverage',
    'service_type_codes["30"] must be "Health Benefit Plan Coverage" (real X12 EQ01)');
  assert.equal(stc['47'], 'Hospital',
    'service_type_codes["47"] must be "Hospital" (real X12 EQ01)');
  assert.equal(stc['98'], 'Professional (Physician) Visit - Office',
    'service_type_codes["98"] must be "Professional (Physician) Visit - Office" (real X12 EQ01)');
});

test('12. spec.json pack.rules.eligibility_codes contains real X12 EB01 codes ("1", "6", "I")', () => {
  const spec = JSON.parse(read(SPEC));
  const ec = spec.pack && spec.pack.rules && spec.pack.rules.eligibility_codes;
  assert.ok(ec && typeof ec === 'object',
    'spec.pack.rules.eligibility_codes must be an object');
  assert.equal(ec['1'], 'Active Coverage',
    'eligibility_codes["1"] must be "Active Coverage" (real X12 EB01)');
  assert.equal(ec['6'], 'Inactive',
    'eligibility_codes["6"] must be "Inactive" (real X12 EB01)');
  assert.equal(ec['I'], 'Non-Covered',
    'eligibility_codes["I"] must be "Non-Covered" (real X12 EB01)');
});

test('13. spec.json pack.rules.aaa_reject_codes contains real X12 AAA codes ("72", "75")', () => {
  const spec = JSON.parse(read(SPEC));
  const ac = spec.pack && spec.pack.rules && spec.pack.rules.aaa_reject_codes;
  assert.ok(ac && typeof ac === 'object',
    'spec.pack.rules.aaa_reject_codes must be an object');
  assert.equal(ac['72'], 'Invalid/Missing Subscriber/Insured ID',
    'aaa_reject_codes["72"] must be "Invalid/Missing Subscriber/Insured ID" (real X12 AAA)');
  assert.equal(ac['75'], 'Subscriber/Insured Not Found',
    'aaa_reject_codes["75"] must be "Subscriber/Insured Not Found" (real X12 AAA)');
});

test('14. spec.json evals.cases has >= 3 cases and both 270 and 271 directions are represented', () => {
  const spec = JSON.parse(read(SPEC));
  const cases = spec.evals && spec.evals.cases;
  assert.ok(Array.isArray(cases), 'spec.evals.cases must be an array');
  assert.ok(cases.length >= 3,
    `spec.evals.cases must have >= 3 cases (got ${cases.length})`);
  assert.equal(spec.evals.coverage, 1.0,
    'spec.evals.coverage must equal 1.0');
  const dirs = new Set(cases.map((c) => c.expected && c.expected.direction));
  assert.ok(dirs.has('inquiry'),
    'evals must include at least one 270 inquiry case (expected.direction === "inquiry")');
  assert.ok(dirs.has('response'),
    'evals must include at least one 271 response case (expected.direction === "response")');
});

test('15. HTML related-templates grid links to 5 sibling templates', () => {
  const html = read(HTML);
  const siblings = [
    '/insurance/templates/edi-837',
    '/insurance/templates/edi-835',
    '/insurance/templates/edi-834',
    '/insurance/templates/edi-278',
    '/insurance/templates/fhir-uscdi',
  ];
  for (const href of siblings) {
    assert.ok(html.includes(`href="${href}"`),
      `HTML related-templates grid must link to ${href}`);
  }
});

test('16. spec.json recipe.source function actually parses 270 + 271 inputs (smoke test)', () => {
  // Sanity check: the source string is executable and produces the documented
  // shape. If a future edit breaks the parser, the test fails here loudly
  // instead of silently shipping a broken artifact.
  const spec = JSON.parse(read(SPEC));
  const src = spec.recipes[0].source;
  assert.ok(src.length < 1200,
    `recipe.source must be under 1200 chars (got ${src.length})`);
  // eslint-disable-next-line no-eval -- intentional: spec source IS executable JS
  const fn = eval('(' + src + ')');
  const lib = { pack: spec.pack };

  const inq = fn(spec.evals.cases.find((c) => c.expected.direction === 'inquiry').input, lib);
  assert.equal(inq.direction, 'inquiry', 'parser must auto-detect inquiry from ST01=270');
  assert.equal(inq.format, '270', 'parser must set format=270');
  assert.ok(inq.inquiry && Array.isArray(inq.inquiry.service_type_codes),
    'inquiry output must carry an EQ-derived service_type_codes array');

  const res = fn(spec.evals.cases.find((c) => c.expected.direction === 'response').input, lib);
  assert.equal(res.direction, 'response', 'parser must auto-detect response from ST01=271');
  assert.equal(res.format, '271', 'parser must set format=271');
  assert.ok(res.response && Array.isArray(res.response.benefits),
    'response output must carry an EB-derived benefits array');
});
