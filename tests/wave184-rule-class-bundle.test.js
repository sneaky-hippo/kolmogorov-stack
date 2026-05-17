// Wave 184 - Rule-class bundle: 4 health-insurance lighthouse templates
// shipped together as recipe #9 of 9 in Shift 2. The bundle closes the
// procurement gap to >=24/30 workflows by adding the rule-class lookups
// and calculators that every health plan needs:
//   1. mlr-rebate            -- PPACA section 2718 MLR + rebate (rule)
//   2. cms-star              -- Medicare Advantage Part C/D contributor
//                               extractor with CMS 2025+ weighting
//                               (synthesized-rule)
//   3. npi-directory         -- NPI Luhn-mod-10 validator with NPPES v2
//                               schema normalization (rule)
//   4. icd10-cpt-crosswalk   -- Bidirectional ICD-10-CM <-> CPT lookup
//                               (rule)
// Lock-in tests assert page + spec exist and parse, canonical URLs are
// pinned, recipe-class badges match the requested class, the K-score
// gates surface on the page, the pack.rules tables carry the verified
// real regulatory constants, and the related-templates grids cross-link
// across all four siblings + their named companions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

const TEMPLATES = ['mlr-rebate', 'cms-star', 'npi-directory', 'icd10-cpt-crosswalk'];

function htmlPath(slug) { return path.join(PUBLIC, 'insurance', 'templates', slug + '.html'); }
function specPath(slug) { return path.join(PUBLIC, 'docs', 'showcase', slug + '.spec.json'); }
function readHtml(slug) { return fs.readFileSync(htmlPath(slug), 'utf8'); }
function readSpec(slug) { return JSON.parse(fs.readFileSync(specPath(slug), 'utf8')); }

// --- per-template existence + JSON validity ---------------------------

test('1. all four template HTML files exist and are over 7000 bytes', () => {
  for (const slug of TEMPLATES) {
    const p = htmlPath(slug);
    assert.ok(fs.existsSync(p), `missing HTML for ${slug} at ${p}`);
    const size = fs.statSync(p).size;
    assert.ok(size > 7000, `${slug}.html is ${size} bytes; expected > 7000`);
  }
});

test('2. all four spec.json files exist and parse as valid JSON', () => {
  for (const slug of TEMPLATES) {
    const p = specPath(slug);
    assert.ok(fs.existsSync(p), `missing spec for ${slug} at ${p}`);
    const spec = readSpec(slug);
    assert.ok(spec && typeof spec === 'object', `${slug}.spec.json must parse to an object`);
  }
});

test('3. each HTML declares the canonical https://kolm.ai/insurance/templates/<slug> URL', () => {
  for (const slug of TEMPLATES) {
    const html = readHtml(slug);
    const want = `href="https://kolm.ai/insurance/templates/${slug}"`;
    assert.ok(html.includes(want), `${slug}.html must declare canonical ${want}`);
  }
});

test('4. each related-templates grid links to its five named siblings', () => {
  const expectations = {
    'mlr-rebate':           ['cms-star', 'npi-directory', 'icd10-cpt-crosswalk', 'claims-adjudication', 'edi-835'],
    'cms-star':             ['mlr-rebate', 'npi-directory', 'icd10-cpt-crosswalk', 'hedis-cbp', 'claims-adjudication'],
    'npi-directory':        ['mlr-rebate', 'cms-star', 'icd10-cpt-crosswalk', 'provider-credentialing', 'edi-837'],
    'icd10-cpt-crosswalk':  ['mlr-rebate', 'cms-star', 'npi-directory', 'claims-adjudication', 'prior-auth-letter']
  };
  for (const slug of TEMPLATES) {
    const html = readHtml(slug);
    for (const sib of expectations[slug]) {
      assert.ok(
        html.includes(`/insurance/templates/${sib}`),
        `${slug}.html related grid must link to /insurance/templates/${sib}`
      );
    }
  }
});

// --- mlr-rebate -------------------------------------------------------

test('5. mlr-rebate pack.rules.mlr_thresholds carries real PPACA percentages (80/80/85)', () => {
  const spec = readSpec('mlr-rebate');
  const t = spec.pack && spec.pack.rules && spec.pack.rules.mlr_thresholds;
  assert.ok(t, 'pack.rules.mlr_thresholds must exist');
  assert.equal(t.individual, 0.80, 'individual market threshold must be 0.80 per 45 CFR 158.211');
  assert.equal(t.small_group, 0.80, 'small_group market threshold must be 0.80 per 45 CFR 158.211');
  assert.equal(t.large_group, 0.85, 'large_group market threshold must be 0.85 per 45 CFR 158.211');
});

test('6. mlr-rebate HTML mentions PPACA section 2718 and 45 CFR section 158', () => {
  const html = readHtml('mlr-rebate');
  assert.match(html, /PPACA\s*&sect;\s*2718|PPACA\s*§\s*2718|PPACA\s*section\s*2718/i,
    'HTML must mention PPACA section 2718');
  assert.match(html, /45\s*CFR\s*&sect;\s*158|45\s*CFR\s*§\s*158|45\s*CFR\s*section\s*158/i,
    'HTML must mention 45 CFR section 158');
});

test('7. mlr-rebate spec carries realistic eval cases with the expected formula', () => {
  const spec = readSpec('mlr-rebate');
  const cases = spec.evals && spec.evals.cases;
  assert.ok(Array.isArray(cases) && cases.length >= 3, 'expected >= 3 eval cases');
  // The canonical "individual at threshold no rebate" case must have the
  // numbers from the spec doc: premium 50M, claims 38M, qi 800k, taxes 2M,
  // member_months 60k -> num 38_800_000, den 48_000_000, ratio ~0.808
  const c0 = cases[0];
  assert.equal(c0.input.premium_revenue, 50000000);
  assert.equal(c0.input.incurred_claims, 38000000);
  assert.equal(c0.input.quality_improvement_expense, 800000);
  assert.equal(c0.input.taxes_fees, 2000000);
  assert.equal(c0.input.member_months, 60000);
  assert.equal(c0.expected.threshold, 0.80);
  // Coverage gate
  assert.equal(spec.evals.coverage, 1.0, 'evals.coverage must be 1.0');
});

test('8. mlr-rebate HTML surfaces K-score gate 0.95 and badges recipe class rule (class 0)', () => {
  const html = readHtml('mlr-rebate');
  assert.match(html, /0\.95/, 'HTML must surface 0.95 K-score gate');
  assert.match(html, /rule\s*\(class\s*0\)/i, 'HTML must badge rule (class 0)');
});

// --- cms-star ---------------------------------------------------------

test('9. cms-star pack.rules.measure_categories carries CMS 2025+ weights (3/3/4/4/1/5)', () => {
  const spec = readSpec('cms-star');
  const c = spec.pack && spec.pack.rules && spec.pack.rules.measure_categories;
  assert.ok(c, 'pack.rules.measure_categories must exist');
  // Six categories with the documented weights
  assert.equal(c.outcome, 3, 'outcome weight must be 3');
  assert.equal(c.intermediate_outcome, 3, 'intermediate_outcome weight must be 3');
  assert.equal(c.patient_experience, 4, 'patient_experience weight must be 4');
  assert.equal(c.access, 4, 'access weight must be 4');
  assert.equal(c.process, 1, 'process weight must be 1');
  assert.equal(c.improvement, 5, 'improvement weight must be 5');
  // Exactly six entries
  assert.equal(Object.keys(c).length, 6, 'measure_categories must have exactly 6 categories');
});

test('10. cms-star part_c_top_measures includes C09 Controlling Blood Pressure (intermediate_outcome)', () => {
  const spec = readSpec('cms-star');
  const arr = spec.pack && spec.pack.rules && spec.pack.rules.part_c_top_measures;
  assert.ok(Array.isArray(arr), 'part_c_top_measures must be an array');
  const c09 = arr.find((m) => m.id === 'C09');
  assert.ok(c09, 'part_c_top_measures must include C09');
  assert.match(c09.name, /Controlling Blood Pressure/i, 'C09 must be named "Controlling Blood Pressure"');
  assert.equal(c09.category, 'intermediate_outcome', 'C09 category must be intermediate_outcome');
});

test('11. cms-star part_d_top_measures includes D08 Medication Adherence for Diabetes', () => {
  const spec = readSpec('cms-star');
  const arr = spec.pack && spec.pack.rules && spec.pack.rules.part_d_top_measures;
  assert.ok(Array.isArray(arr), 'part_d_top_measures must be an array');
  const d08 = arr.find((m) => m.id === 'D08');
  assert.ok(d08, 'part_d_top_measures must include D08');
  assert.match(d08.name, /Medication Adherence for Diabetes/i, 'D08 must be Medication Adherence for Diabetes');
  assert.equal(d08.category, 'intermediate_outcome', 'D08 category must be intermediate_outcome');
});

test('12. cms-star HTML badges synthesized-rule (class 1) and surfaces 0.93 K-score', () => {
  const html = readHtml('cms-star');
  assert.match(html, /synthesized-rule\s*\(class\s*1\)/i, 'HTML must badge synthesized-rule (class 1)');
  assert.match(html, /0\.93/, 'HTML must surface 0.93 K-score gate');
});

// --- npi-directory ----------------------------------------------------

test('13. npi-directory pack.rules.npi_prefix_for_luhn is the CMS-pinned "80840"', () => {
  const spec = readSpec('npi-directory');
  const r = spec.pack && spec.pack.rules;
  assert.ok(r, 'pack.rules must exist');
  assert.equal(r.npi_prefix_for_luhn, '80840', 'CMS-pinned NPI Luhn prefix must be "80840"');
});

test('14. npi-directory pack.rules.nppes_v2_endpoint is the real NPPES public API URL', () => {
  const spec = readSpec('npi-directory');
  const r = spec.pack && spec.pack.rules;
  assert.equal(r.nppes_v2_endpoint, 'https://npiregistry.cms.hhs.gov/api/?version=2.1',
    'nppes_v2_endpoint must be the real NPPES public API URL');
});

test('15. npi-directory pack.rules.entity_type_codes has both "1" individual and "2" organization', () => {
  const spec = readSpec('npi-directory');
  const e = spec.pack && spec.pack.rules && spec.pack.rules.entity_type_codes;
  assert.ok(e, 'entity_type_codes must exist');
  assert.equal(e['1'], 'individual', 'entity_type_codes["1"] must be individual');
  assert.equal(e['2'], 'organization', 'entity_type_codes["2"] must be organization');
});

test('16. npi-directory recipe Luhn check passes the known-valid test NPI 1234567893', () => {
  const spec = readSpec('npi-directory');
  const src = spec.recipes[0].source;
  assert.ok(!src.includes('\n'), 'recipe.source must be single-line');
  // eslint-disable-next-line no-new-func
  const fn = new Function('return (' + src + ')')();
  const valid = fn({ npi: '1234567893', resolver: 'nppes_v2', entity_type_code: '1' }, { pack: spec.pack });
  assert.equal(valid.valid_checksum, true, 'NPI 1234567893 must pass Luhn-mod-10 with 80840 prefix');
  const invalid = fn({ npi: '1234567892', resolver: 'nppes_v2', entity_type_code: '1' }, { pack: spec.pack });
  assert.equal(invalid.valid_checksum, false, 'off-by-one NPI 1234567892 must fail Luhn-mod-10');
});

// --- icd10-cpt-crosswalk ---------------------------------------------

test('17. icd10-cpt-crosswalk pack.rules.icd_to_cpt_seed has at least 10 entries', () => {
  const spec = readSpec('icd10-cpt-crosswalk');
  const seed = spec.pack && spec.pack.rules && spec.pack.rules.icd_to_cpt_seed;
  assert.ok(seed && typeof seed === 'object', 'icd_to_cpt_seed must exist');
  const keys = Object.keys(seed);
  assert.ok(keys.length >= 10, `icd_to_cpt_seed must have >= 10 entries, got ${keys.length}`);
});

test('18. icd10-cpt-crosswalk I10 mapping is present and includes CPT 99213 or 99214', () => {
  const spec = readSpec('icd10-cpt-crosswalk');
  const i10 = spec.pack.rules.icd_to_cpt_seed['I10'];
  assert.ok(Array.isArray(i10), 'I10 mapping must exist');
  const cpts = i10.map((m) => m.cpt);
  assert.ok(cpts.includes('99213') || cpts.includes('99214'),
    'I10 mapping must include CPT 99213 or 99214 (office visit)');
});

test('19. icd10-cpt-crosswalk pack.rules.cpt_to_icd_seed has at least 10 entries', () => {
  const spec = readSpec('icd10-cpt-crosswalk');
  const seed = spec.pack && spec.pack.rules && spec.pack.rules.cpt_to_icd_seed;
  assert.ok(seed && typeof seed === 'object', 'cpt_to_icd_seed must exist');
  const keys = Object.keys(seed);
  assert.ok(keys.length >= 10, `cpt_to_icd_seed must have >= 10 entries, got ${keys.length}`);
});

test('20. icd10-cpt-crosswalk Z00.00 mapping includes preventive-visit CPT 99385/99386/99395/99396', () => {
  const spec = readSpec('icd10-cpt-crosswalk');
  const z = spec.pack.rules.icd_to_cpt_seed['Z00.00'];
  assert.ok(Array.isArray(z), 'Z00.00 mapping must exist');
  const cpts = z.map((m) => m.cpt);
  for (const c of ['99385', '99386', '99395', '99396']) {
    assert.ok(cpts.includes(c), `Z00.00 mapping must include real preventive-care CPT ${c}`);
  }
});

test('21. all four recipes are pure JS source strings under their byte limits and parse + execute', () => {
  const limits = { 'mlr-rebate': 1200, 'cms-star': 1500, 'npi-directory': 1200, 'icd10-cpt-crosswalk': 1200 };
  for (const slug of TEMPLATES) {
    const spec = readSpec(slug);
    const src = spec.recipes[0].source;
    assert.ok(typeof src === 'string', `${slug} recipe.source must be a string`);
    assert.ok(!src.includes('\n'), `${slug} recipe.source must be single-line`);
    assert.ok(src.length <= limits[slug],
      `${slug} recipe.source is ${src.length} chars, expected <= ${limits[slug]}`);
    // eslint-disable-next-line no-new-func
    const fn = new Function('return (' + src + ')')();
    assert.equal(typeof fn, 'function', `${slug} recipe.source must compile to a function`);
    // Exercise the first eval case
    const first = spec.evals.cases[0];
    const out = fn(first.input, { pack: spec.pack });
    assert.ok(out && typeof out === 'object', `${slug} first eval case must return an object`);
  }
});

test('22. all four recipes carry base_model "none" and the correct class badge', () => {
  const classes = { 'mlr-rebate': 'rule', 'cms-star': 'synthesized-rule', 'npi-directory': 'rule', 'icd10-cpt-crosswalk': 'rule' };
  for (const slug of TEMPLATES) {
    const spec = readSpec(slug);
    assert.equal(spec.base_model, 'none', `${slug} base_model must be "none"`);
    assert.equal(spec.recipes[0].class, classes[slug], `${slug} recipe.class must be "${classes[slug]}"`);
    assert.equal(spec.license, 'LicenseRef-kolm-default-1.0', `${slug} license must be LicenseRef-kolm-default-1.0`);
  }
});

test('23. all four spec job_ids match the wave-184 v1 naming convention', () => {
  const ids = {
    'mlr-rebate':           'job_mlr_rebate_calculator_v1',
    'cms-star':             'job_cms_star_contributor_v1',
    'npi-directory':        'job_npi_directory_lookup_v1',
    'icd10-cpt-crosswalk':  'job_icd10_cpt_crosswalk_v1'
  };
  for (const slug of TEMPLATES) {
    const spec = readSpec(slug);
    assert.equal(spec.job_id, ids[slug], `${slug} job_id must be ${ids[slug]}`);
  }
});

test('24. CTAs on every page link to /signup, mailto sales, and the spec.json download', () => {
  for (const slug of TEMPLATES) {
    const html = readHtml(slug);
    assert.ok(html.includes(`/signup?template=${slug}`), `${slug}.html must link /signup?template=${slug}`);
    assert.ok(html.includes('mailto:sales@kolm.ai'), `${slug}.html must include mailto:sales@kolm.ai`);
    assert.ok(html.includes(`/docs/showcase/${slug}.spec.json`), `${slug}.html must link to /docs/showcase/${slug}.spec.json`);
  }
});
