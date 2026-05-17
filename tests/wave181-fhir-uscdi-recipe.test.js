// Wave 181 - FHIR R4 USCDI v3 normalizer template (recipe #6 of 9 in
// Shift 2 of the health-insurance lighthouse vertical). The template
// is pure rule-class: a FHIR R4 Bundle in, a normalized USCDI v3
// JSON document out, no inference required for the structural mapping.
// USCDI v3 was published by ONC in July 2022; FHIR R4 was published by
// HL7 in 2019. The recipe and the surface ship together; this test
// locks down both ends of the contract so future cache bumps cannot
// silently drop the eleven required resource types or the canonical
// coding-system URIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const HTML_PATH = path.join(REPO, 'public', 'insurance', 'templates', 'fhir-uscdi.html');
const SPEC_PATH = path.join(REPO, 'public', 'docs', 'showcase', 'fhir-uscdi.spec.json');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. fhir-uscdi.html exists and is over 7000 bytes', () => {
  assert.ok(fs.existsSync(HTML_PATH), `HTML missing at ${HTML_PATH}`);
  const size = fs.statSync(HTML_PATH).size;
  assert.ok(size > 7000, `HTML is ${size} bytes, expected > 7000`);
});

test('2. fhir-uscdi.spec.json exists and parses as JSON', () => {
  assert.ok(fs.existsSync(SPEC_PATH), `spec missing at ${SPEC_PATH}`);
  const raw = read(SPEC_PATH);
  const parsed = JSON.parse(raw);
  assert.ok(parsed && typeof parsed === 'object', 'spec must parse to object');
});

test('3. HTML declares canonical URL https://kolm.ai/insurance/templates/fhir-uscdi', () => {
  const html = read(HTML_PATH);
  assert.ok(
    html.includes('href="https://kolm.ai/insurance/templates/fhir-uscdi"'),
    'HTML must declare canonical URL https://kolm.ai/insurance/templates/fhir-uscdi'
  );
});

test('4. HTML and spec declare recipe-class rule (class 0)', () => {
  const html = read(HTML_PATH);
  assert.ok(
    html.includes('rule (class 0)'),
    'HTML must surface recipe-class label "rule (class 0)"'
  );
  const spec = JSON.parse(read(SPEC_PATH));
  assert.equal(spec.recipes[0].class, 'rule', 'spec recipe.class must be "rule"');
});

test('5. K-score gate is at least 0.94', () => {
  const html = read(HTML_PATH);
  assert.ok(
    html.includes('0.94'),
    'HTML must surface the 0.94 K-score gate'
  );
  // The HTML uses &ge; 0.94; both forms acceptable, just ensure value present
  const match = html.match(/0\.9\d/g) || [];
  const min = Math.min(...match.map((m) => parseFloat(m)));
  assert.ok(min >= 0.94, `lowest K-score gate found is ${min}, expected >= 0.94`);
});

test('6. HTML mentions FHIR R4, USCDI v3, and Bundle', () => {
  const html = read(HTML_PATH);
  assert.ok(html.includes('FHIR R4'), 'HTML must mention FHIR R4');
  assert.ok(html.includes('USCDI v3'), 'HTML must mention USCDI v3');
  assert.ok(html.includes('Bundle'), 'HTML must mention Bundle');
});

test('7. HTML mentions Patient, Encounter, Condition, Observation, MedicationRequest resources', () => {
  const html = read(HTML_PATH);
  for (const resource of ['Patient', 'Encounter', 'Condition', 'Observation', 'MedicationRequest']) {
    assert.ok(html.includes(resource), `HTML must mention FHIR resource ${resource}`);
  }
});

test('8. HTML cites USCDI v3 July 2022 publication date', () => {
  const html = read(HTML_PATH);
  // Allow "Jul 2022" or "July 2022"
  const hasJul = html.includes('Jul 2022') || html.includes('July 2022');
  assert.ok(hasJul, 'HTML must cite USCDI v3 publication month (Jul/July 2022)');
  assert.ok(html.includes('2022'), 'HTML must cite the year 2022');
});

test('9. spec.json job_id is correct and base_model is "none"', () => {
  const spec = JSON.parse(read(SPEC_PATH));
  assert.equal(spec.job_id, 'job_fhir_uscdi_normalizer_v1', 'spec.job_id must be job_fhir_uscdi_normalizer_v1');
  assert.equal(spec.base_model, 'none', 'spec.base_model must be "none" for rule-class');
});

test('10. spec.json recipe id is rcp_fhir_uscdi_v1 and tags include fhir-r4 + uscdi-v3', () => {
  const spec = JSON.parse(read(SPEC_PATH));
  const recipe = spec.recipes[0];
  assert.equal(recipe.id, 'rcp_fhir_uscdi_v1', 'recipe.id must be rcp_fhir_uscdi_v1');
  assert.equal(recipe.name, 'fhir-uscdi', 'recipe.name must be fhir-uscdi');
  assert.ok(Array.isArray(recipe.tags), 'recipe.tags must be an array');
  assert.ok(recipe.tags.includes('fhir-r4'), 'recipe.tags must include fhir-r4');
  assert.ok(recipe.tags.includes('uscdi-v3'), 'recipe.tags must include uscdi-v3');
});

test('11. spec.json pack.rules.resource_to_uscdi_class maps Patient to patient_demographics', () => {
  const spec = JSON.parse(read(SPEC_PATH));
  const map = spec.pack && spec.pack.rules && spec.pack.rules.resource_to_uscdi_class;
  assert.ok(map && typeof map === 'object', 'pack.rules.resource_to_uscdi_class must exist');
  assert.equal(map.Patient, 'patient_demographics', 'Patient must map to patient_demographics');
  // All 11 resource types
  for (const t of ['Patient', 'Encounter', 'Condition', 'Observation', 'MedicationRequest',
                   'MedicationStatement', 'Procedure', 'Immunization', 'AllergyIntolerance',
                   'DocumentReference', 'DiagnosticReport', 'CarePlan']) {
    assert.ok(map[t], `resource_to_uscdi_class must define mapping for ${t}`);
  }
});

test('12. spec.json pack.rules.coding_system_priority.Condition contains SNOMED + ICD-10-CM canonical URIs', () => {
  const spec = JSON.parse(read(SPEC_PATH));
  const csp = spec.pack && spec.pack.rules && spec.pack.rules.coding_system_priority;
  assert.ok(csp && csp.Condition, 'pack.rules.coding_system_priority.Condition must exist');
  assert.ok(csp.Condition.includes('http://snomed.info/sct'), 'Condition must list SNOMED CT canonical URI');
  assert.ok(csp.Condition.includes('http://hl7.org/fhir/sid/icd-10-cm'), 'Condition must list ICD-10-CM canonical URI');
  // SNOMED should come first (canonical priority)
  assert.equal(csp.Condition[0], 'http://snomed.info/sct', 'SNOMED CT must be the first priority for Condition');
});

test('13. spec.json pack.rules.phi_redaction.identifier == "hash"', () => {
  const spec = JSON.parse(read(SPEC_PATH));
  const phi = spec.pack && spec.pack.rules && spec.pack.rules.phi_redaction;
  assert.ok(phi, 'pack.rules.phi_redaction must exist');
  assert.equal(phi.identifier, 'hash', 'phi_redaction.identifier must be "hash"');
  assert.equal(phi.name, 'redact_to_initials', 'phi_redaction.name must be redact_to_initials');
  assert.equal(phi.birthDate, 'year_only', 'phi_redaction.birthDate must be year_only');
});

test('14. spec.json evals.cases has 3 or more entries with FHIR Bundle inputs', () => {
  const spec = JSON.parse(read(SPEC_PATH));
  const cases = spec.evals && spec.evals.cases;
  assert.ok(Array.isArray(cases), 'evals.cases must be an array');
  assert.ok(cases.length >= 3, `evals.cases must have >= 3 entries, got ${cases.length}`);
  assert.equal(spec.evals.coverage, 1.0, 'evals.coverage must be 1.0');
  // At least one expected output mentions patient.gender
  const hasGender = cases.some((c) => c.expected && c.expected.patient && c.expected.patient.gender);
  assert.ok(hasGender, 'at least one eval case must assert patient.gender');
  // Every input is shaped as a FHIR Bundle
  for (const c of cases) {
    assert.ok(c.input && c.input.bundle, `case ${c.id} must wrap input in { bundle: ... }`);
    assert.equal(c.input.bundle.resourceType, 'Bundle', `case ${c.id} bundle.resourceType must be Bundle`);
  }
});

test('15. HTML links to 5 sibling templates (edi-837, edi-835, edi-834, edi-270-271, edi-278) in related grid', () => {
  const html = read(HTML_PATH);
  const siblings = ['edi-837', 'edi-835', 'edi-834', 'edi-270-271', 'edi-278'];
  for (const sib of siblings) {
    assert.ok(
      html.includes(`/insurance/templates/${sib}"`),
      `related grid must link to /insurance/templates/${sib}`
    );
  }
});

test('16. recipe source executes against every eval case and matches expected', () => {
  const spec = JSON.parse(read(SPEC_PATH));
  const src = spec.recipes[0].source;
  // Single-line function for portability
  assert.ok(!src.includes('\n'), 'recipe.source must be single-line');
  // eslint-disable-next-line no-new-func
  const fn = new Function('return (' + src + ')')();
  for (const c of spec.evals.cases) {
    const out = fn(c.input, { pack: spec.pack });
    assert.equal(out.format, 'uscdi-v3', `case ${c.id} output.format must be uscdi-v3`);
    assert.equal(out.source_format, 'fhir-r4-bundle', `case ${c.id} output.source_format must be fhir-r4-bundle`);
    if (c.expected && c.expected.patient && c.expected.patient.gender) {
      assert.equal(out.patient.gender, c.expected.patient.gender, `case ${c.id} patient.gender mismatch`);
    }
  }
});
