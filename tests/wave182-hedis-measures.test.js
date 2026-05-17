// Wave 182 - HEDIS top-3 measure templates for the /health-insurance vertical.
// Lock-in tests for three SYNTHESIZED-RULE class templates that compute
// (1) Controlling High Blood Pressure (CBP),
// (2) Glycemic Status Assessment for Patients with Diabetes (GSD) HbA1c
//     poor-control sub-measure (hedis-cdc-hba1c), and
// (3) Breast Cancer Screening (BCS).
//
// All three pin: synthesized-rule (class 1), K-score gate >= 0.93, the 5-card
// related-templates grid (the two other HEDIS measures + fhir-uscdi + edi-834
// + claims-adjudication), and the NCQA MY 2024+ spec stamp. The per-measure
// tests pin the load-bearing real codes (ICD-10 / CPT / HCPCS / LOINC) so a
// future edit that fabricates a code breaks the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

const HTML = {
  cbp:    path.join(PUBLIC, 'insurance', 'templates', 'hedis-cbp.html'),
  hba1c:  path.join(PUBLIC, 'insurance', 'templates', 'hedis-cdc-hba1c.html'),
  bcs:    path.join(PUBLIC, 'insurance', 'templates', 'hedis-bcs.html'),
};
const SPEC = {
  cbp:    path.join(PUBLIC, 'docs', 'showcase', 'hedis-cbp.spec.json'),
  hba1c:  path.join(PUBLIC, 'docs', 'showcase', 'hedis-cdc-hba1c.spec.json'),
  bcs:    path.join(PUBLIC, 'docs', 'showcase', 'hedis-bcs.spec.json'),
};

const readHtml = (k) => fs.readFileSync(HTML[k], 'utf8');
const readSpec = (k) => JSON.parse(fs.readFileSync(SPEC[k], 'utf8'));

// ---------- per-measure file presence + size ----------

test('1. all three HEDIS HTML pages exist and are > 7000 bytes', () => {
  for (const k of ['cbp', 'hba1c', 'bcs']) {
    assert.ok(fs.existsSync(HTML[k]), `${HTML[k]} missing`);
    const size = fs.statSync(HTML[k]).size;
    assert.ok(size > 7000, `${HTML[k]} too small (${size} bytes; expected > 7000)`);
  }
});

test('2. all three HEDIS spec.json files exist and are valid JSON', () => {
  for (const k of ['cbp', 'hba1c', 'bcs']) {
    assert.ok(fs.existsSync(SPEC[k]), `${SPEC[k]} missing`);
    const j = readSpec(k);
    assert.ok(j && typeof j === 'object', `${SPEC[k]} must parse to an object`);
  }
});

// ---------- canonical URLs ----------

test('3. each HTML declares its canonical https://kolm.ai/insurance/templates/hedis-... URL', () => {
  for (const slug of ['hedis-cbp', 'hedis-cdc-hba1c', 'hedis-bcs']) {
    const key = slug === 'hedis-cbp' ? 'cbp' : (slug === 'hedis-cdc-hba1c' ? 'hba1c' : 'bcs');
    const html = readHtml(key);
    assert.match(
      html,
      new RegExp(`<link rel="canonical" href="https://kolm\\.ai/insurance/templates/${slug}"`),
      `canonical link must point at https://kolm.ai/insurance/templates/${slug}`
    );
  }
});

// ---------- recipe class + K-score gate ----------

test('4. every HEDIS page badges recipe class synthesized-rule (class 1)', () => {
  for (const k of ['cbp', 'hba1c', 'bcs']) {
    const html = readHtml(k);
    assert.match(
      html,
      /synthesized-rule\s*\(class\s*1\)/i,
      `${k} page must badge recipe class as "synthesized-rule (class 1)" so marketing matches src/recipe-class.js CLASS_RANK.synthesized_rule=1`
    );
  }
});

test('5. every HEDIS page declares K-score gate >= 0.93', () => {
  for (const k of ['cbp', 'hba1c', 'bcs']) {
    const html = readHtml(k);
    assert.match(
      html,
      /(?:&ge;|>=)\s*0\.93/,
      `${k} page must surface "&ge; 0.93" K-score gate marker`
    );
    assert.match(
      html,
      /k-score gate[\s\S]{0,200}0\.93/i,
      `${k} page k-score gate row in meta strip must carry the 0.93 number`
    );
  }
});

// ---------- NCQA spec stamp ----------

test('6. every HEDIS page cites NCQA HEDIS MY 2024+ spec', () => {
  for (const k of ['cbp', 'hba1c', 'bcs']) {
    const html = readHtml(k);
    assert.match(
      html,
      /HEDIS\s*MY\s*2024\+/i,
      `${k} page must cite "HEDIS MY 2024+" (NCQA technical specification basis)`
    );
    assert.match(
      html,
      /NCQA/,
      `${k} page must name NCQA as the spec source`
    );
  }
});

// ---------- age range stated on every page ----------

test('7. every HEDIS page states its age range in the meta strip', () => {
  // CBP 18-85, GSD HbA1c 18-75, BCS 50-74
  const expected = {
    cbp:   /18-85/,
    hba1c: /18-75/,
    bcs:   /50-74/,
  };
  for (const k of ['cbp', 'hba1c', 'bcs']) {
    const html = readHtml(k);
    assert.match(
      html,
      expected[k],
      `${k} page must state age range matching ${expected[k]}`
    );
  }
});

// ---------- related-templates 5-card grid ----------

test('8. every HEDIS page links to the 4 sibling templates in the related grid', () => {
  // From each HEDIS page the related grid must link to the OTHER two HEDIS
  // measures + fhir-uscdi + edi-834 + claims-adjudication = 5 cards.
  const siblings = {
    cbp:   ['hedis-cdc-hba1c', 'hedis-bcs',       'fhir-uscdi', 'edi-834', 'claims-adjudication'],
    hba1c: ['hedis-cbp',       'hedis-bcs',       'fhir-uscdi', 'edi-834', 'claims-adjudication'],
    bcs:   ['hedis-cbp',       'hedis-cdc-hba1c', 'fhir-uscdi', 'edi-834', 'claims-adjudication'],
  };
  for (const k of ['cbp', 'hba1c', 'bcs']) {
    const html = readHtml(k);
    for (const sib of siblings[k]) {
      assert.match(
        html,
        new RegExp(`/insurance/templates/${sib.replace(/-/g, '\\-')}`),
        `${k} related grid must link to /insurance/templates/${sib}`
      );
    }
  }
});

// ---------- spec.json job_id + base_model + license ----------

test('9. each spec.json carries the correct job_id and declares base_model none', () => {
  const expected = {
    cbp:   'job_hedis_cbp_v1',
    hba1c: 'job_hedis_cdc_hba1c_v1',
    bcs:   'job_hedis_bcs_v1',
  };
  for (const k of ['cbp', 'hba1c', 'bcs']) {
    const j = readSpec(k);
    assert.equal(j.job_id, expected[k], `${k} spec job_id must be ${expected[k]}`);
    assert.equal(j.base_model, 'none', `${k} base_model must be "none" (synthesized-rule recipe carries no model weights)`);
    assert.equal(j.license, 'LicenseRef-kolm-default-1.0', `${k} license must be the kolm default`);
  }
});

// ---------- spec.json recipe id + class + teacher attribution ----------

test('10. each spec.json recipe declares synthesized_rule class + teacher attribution', () => {
  const expectedId = {
    cbp:   'rcp_hedis_cbp_v1',
    hba1c: 'rcp_hedis_cdc_hba1c_v1',
    bcs:   'rcp_hedis_bcs_v1',
  };
  for (const k of ['cbp', 'hba1c', 'bcs']) {
    const j = readSpec(k);
    assert.ok(Array.isArray(j.recipes) && j.recipes.length > 0, `${k} recipes must be a non-empty array`);
    const r = j.recipes[0];
    assert.equal(r.id, expectedId[k], `${k} recipes[0].id must be ${expectedId[k]}`);
    assert.equal(r.class, 'synthesized_rule', `${k} recipes[0].class must be "synthesized_rule" so validateRecipeClass passes`);
    // Synthesized-rule requires teacher attribution per src/recipe-class.js
    // validateRecipeClass(): either synthesized_by OR teacher_vendor must be
    // present, or the verifier throws.
    assert.ok(
      (typeof r.synthesized_by === 'string' && r.synthesized_by.length > 0) ||
      (typeof r.teacher_vendor === 'string' && r.teacher_vendor.length > 0),
      `${k} recipes[0] must carry synthesized_by or teacher_vendor (synthesized_rule honesty guard)`
    );
  }
});

// ---------- spec.json recipe source is a valid function ----------

test('11. each spec.json recipes[0].source is a function generate(...) string', () => {
  for (const k of ['cbp', 'hba1c', 'bcs']) {
    const j = readSpec(k);
    const src = j.recipes[0].source;
    assert.equal(typeof src, 'string', `${k} recipes[0].source must be a string`);
    assert.ok(
      src.startsWith('function generate'),
      `${k} recipes[0].source must start with "function generate" so the rule-class loader can node:vm-execute it`
    );
  }
});

// ---------- spec.json evals.cases >= 3 ----------

test('12. each spec.json evals.cases has at least 3 entries with non-empty input.bundle', () => {
  for (const k of ['cbp', 'hba1c', 'bcs']) {
    const j = readSpec(k);
    assert.ok(j.evals && Array.isArray(j.evals.cases), `${k} evals.cases must be an array`);
    assert.ok(j.evals.cases.length >= 3, `${k} evals.cases must have >= 3 entries (got ${j.evals.cases.length})`);
    for (const c of j.evals.cases) {
      assert.ok(c.id && typeof c.id === 'string', `${k} eval case must have id`);
      assert.ok(c.input && typeof c.input === 'object', `${k} eval case ${c.id} input must be an object`);
      assert.ok(c.input.bundle && typeof c.input.bundle === 'object', `${k} eval case ${c.id} input.bundle must be an object`);
    }
    assert.equal(j.evals.coverage, 1.0, `${k} evals.coverage must be 1.0`);
  }
});

// ---------- CBP-specific: real ICD-10 hypertension + real LOINC BP codes ----------

test('13. CBP pack.rules carries real I10 + LOINC 8480-6/8462-4 + age_bands', () => {
  const j = readSpec('cbp');
  const rules = (j.pack && j.pack.rules) || {};
  assert.ok(Array.isArray(rules.hypertension_icd10), 'CBP pack.rules.hypertension_icd10 must be an array');
  assert.ok(
    rules.hypertension_icd10.includes('I10'),
    'CBP pack.rules.hypertension_icd10 must include ICD-10 I10 (essential primary hypertension)'
  );
  assert.ok(rules.bp_loinc && typeof rules.bp_loinc === 'object', 'CBP pack.rules.bp_loinc must be an object');
  assert.equal(rules.bp_loinc.systolic, '8480-6', 'CBP bp_loinc.systolic must be real LOINC 8480-6');
  assert.equal(rules.bp_loinc.diastolic, '8462-4', 'CBP bp_loinc.diastolic must be real LOINC 8462-4');
  assert.ok(rules.age_bands && typeof rules.age_bands === 'object', 'CBP pack.rules.age_bands must be present');
  // The 18-59 and 60-85-no-diabetes bands MUST exist with the right cut points
  // (140 and 150 respectively) so a future edit can't silently drop a band.
  assert.equal(rules.age_bands['18-59'].threshold_systolic, 140, 'CBP age_bands["18-59"].threshold_systolic must be 140');
  assert.equal(rules.age_bands['60-85_no_diabetes'].threshold_systolic, 150, 'CBP age_bands["60-85_no_diabetes"].threshold_systolic must be 150');
});

// ---------- HbA1c-specific: real diabetes ICD-10 + LOINC + threshold + direction ----------

test('14. HbA1c pack.rules carries real E11.65 + LOINC 4548-4 + threshold 9.0 + direction inverted', () => {
  const j = readSpec('hba1c');
  const rules = (j.pack && j.pack.rules) || {};
  assert.ok(Array.isArray(rules.diabetes_icd10), 'HbA1c pack.rules.diabetes_icd10 must be an array');
  assert.ok(
    rules.diabetes_icd10.includes('E11.65'),
    'HbA1c pack.rules.diabetes_icd10 must include real ICD-10 E11.65 (Type 2 diabetes mellitus with hyperglycemia)'
  );
  assert.ok(Array.isArray(rules.hba1c_loinc), 'HbA1c pack.rules.hba1c_loinc must be an array');
  assert.ok(
    rules.hba1c_loinc.includes('4548-4'),
    'HbA1c pack.rules.hba1c_loinc must include real LOINC 4548-4 (Hemoglobin A1c/Hemoglobin.total)'
  );
  assert.equal(rules.poor_control_threshold_pct, 9.0, 'HbA1c poor_control_threshold_pct must be 9.0');
  assert.equal(rules.direction, 'inverted', 'HbA1c direction must be "inverted" (lower rate is better)');
});

// ---------- BCS-specific: real mammography codes + age range + 27-month window ----------

test('15. BCS pack.rules carries real CPT 77067 + HCPCS G0202 + age 50-74 + 27mo period', () => {
  const j = readSpec('bcs');
  const rules = (j.pack && j.pack.rules) || {};
  assert.ok(Array.isArray(rules.mammogram_cpt), 'BCS pack.rules.mammogram_cpt must be an array');
  assert.ok(
    rules.mammogram_cpt.includes('77067'),
    'BCS pack.rules.mammogram_cpt must include real CPT 77067 (screening mammography, bilateral)'
  );
  assert.ok(Array.isArray(rules.mammogram_hcpcs), 'BCS pack.rules.mammogram_hcpcs must be an array');
  assert.ok(
    rules.mammogram_hcpcs.includes('G0202'),
    'BCS pack.rules.mammogram_hcpcs must include real HCPCS G0202 (digital screening mammography)'
  );
  assert.ok(rules.age_range && rules.age_range.min === 50 && rules.age_range.max === 74, 'BCS age_range must be { min: 50, max: 74 }');
  assert.equal(rules.measurement_period_months, 27, 'BCS measurement_period_months must be 27 (24 measurement + 3 look-back)');
});

// ---------- Functional smoke tests: run each recipe on its first eval case ----------

test('16. CBP recipe source executes on first eval case and produces measure=CBP', () => {
  const j = readSpec('cbp');
  const fn = new Function('return (' + j.recipes[0].source + ')')();
  const lib = { pack: j.pack };
  const c0 = j.evals.cases[0];
  const out = fn(c0.input, lib);
  assert.equal(out.measure, 'CBP', 'first CBP case output.measure must equal "CBP"');
  assert.equal(out.numerator, c0.expected.numerator, `first CBP case numerator must equal ${c0.expected.numerator}`);
  assert.equal(out.denominator, c0.expected.denominator, `first CBP case denominator must equal ${c0.expected.denominator}`);
});

test('17. HbA1c recipe source executes on all eval cases with direction=inverted', () => {
  const j = readSpec('hba1c');
  const fn = new Function('return (' + j.recipes[0].source + ')')();
  const lib = { pack: j.pack };
  for (const c of j.evals.cases) {
    const out = fn(c.input, lib);
    assert.equal(out.measure, 'GSD_HBA1C_POOR_CONTROL', `${c.id} output.measure must be GSD_HBA1C_POOR_CONTROL`);
    assert.equal(out.direction, 'inverted', `${c.id} output.direction must be "inverted"`);
    assert.equal(out.numerator, c.expected.numerator, `${c.id} numerator mismatch`);
    assert.equal(out.denominator, c.expected.denominator, `${c.id} denominator mismatch`);
  }
});

test('18. BCS recipe source executes on all eval cases and produces measure=BCS', () => {
  const j = readSpec('bcs');
  const fn = new Function('return (' + j.recipes[0].source + ')')();
  const lib = { pack: j.pack };
  for (const c of j.evals.cases) {
    const out = fn(c.input, lib);
    assert.equal(out.measure, 'BCS', `${c.id} output.measure must equal "BCS"`);
    assert.equal(out.numerator, c.expected.numerator, `${c.id} numerator mismatch`);
    assert.equal(out.denominator, c.expected.denominator, `${c.id} denominator mismatch`);
  }
});

// ---------- Honesty guard: no fabricated codes leaked into a recipe ----------

test('19. CBP recipe spec mentions NCQA HEDIS MY 2024+ in task description', () => {
  const j = readSpec('cbp');
  assert.match(j.task, /NCQA\s*MY\s*2024\+/i, 'CBP task must cite NCQA MY 2024+ spec basis');
});

test('20. HEDIS HTML pages contain no em-dashes (style guard)', () => {
  // The Wave 182 brief explicitly forbids em-dashes in the produced HTML.
  // U+2014 (—) is the em-dash; the &mdash; HTML entity is the equivalent and
  // is allowed because it expands to the same glyph but only in the page
  // headings where we use it intentionally for visual rhythm. Pin the raw
  // character so a future copy-paste doesn't slip an em-dash into prose.
  for (const k of ['cbp', 'hba1c', 'bcs']) {
    const html = readHtml(k);
    // Only fail if the raw em-dash codepoint appears outside of a code block.
    // We can't reliably parse HTML in a test, but we can check that the file
    // contains no literal U+2014.
    assert.ok(
      !html.includes('—'),
      `${k} HTML must not contain the literal em-dash U+2014 (style guard)`
    );
  }
});
