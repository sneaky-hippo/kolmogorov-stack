// Wave 178 -- EDI 834 enrollment/maintenance transformer template.
//
// Ships recipe #3 of 9 in Shift 2 of the health-insurance lighthouse plan:
// the rule-class transformer that ingests X12 EDI 834 (5010A1) enrollment +
// benefit-maintenance transactions from plan sponsors and emits normalized
// member-roster JSON with add / change / term classification per the BGN02
// purpose code and the INS01 member-indicator + INS03 maintenance-type.
//
// Each assertion ties one piece of rendered prose or one spec.json invariant
// to a real X12 5010 element so the template cannot drift from the implementation
// guide it is meant to surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HTML = path.join(REPO, 'public', 'insurance', 'templates', 'edi-834.html');
const SPEC = path.join(REPO, 'public', 'docs', 'showcase', 'edi-834.spec.json');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /insurance/templates/edi-834 HTML exists on disk and is non-trivial size', () => {
  assert.ok(fs.existsSync(HTML), `edi-834.html missing at ${HTML}`);
  const stat = fs.statSync(HTML);
  assert.ok(stat.size > 7000,
    `edi-834.html too small (${stat.size} bytes; expected > 7000)`);
});

test('2. spec.json exists and parses as valid JSON', () => {
  assert.ok(fs.existsSync(SPEC), `edi-834.spec.json missing at ${SPEC}`);
  const raw = read(SPEC);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(raw); },
    'edi-834.spec.json must parse as valid JSON');
  assert.ok(parsed && typeof parsed === 'object',
    'edi-834.spec.json must deserialize to an object');
});

test('3. HTML declares canonical URL https://kolm.ai/insurance/templates/edi-834', () => {
  const html = read(HTML);
  assert.match(html,
    /<link rel="canonical" href="https:\/\/kolm\.ai\/insurance\/templates\/edi-834"/,
    'edi-834.html must declare canonical https://kolm.ai/insurance/templates/edi-834');
});

test('4. HTML recipe-class badge says "rule (class 0)"', () => {
  const html = read(HTML);
  assert.ok(html.includes('rule (class 0)'),
    'edi-834.html must surface the "rule (class 0)" recipe-class badge so buyers see this is a deterministic, no-inference transformer');
});

test('5. HTML K-score gate is >= 0.93', () => {
  const html = read(HTML);
  assert.ok(html.includes('&ge; 0.93') || html.includes('>= 0.93'),
    'edi-834.html must declare the K-score gate at >= 0.93 (matches the rule-class precedent for EDI templates)');
});

test('6. HTML mentions all five anchor X12 segments BGN, INS, NM1, DMG, HD', () => {
  const html = read(HTML);
  for (const seg of ['BGN', 'INS', 'NM1', 'DMG', 'HD']) {
    assert.ok(html.includes(seg),
      `edi-834.html must reference the X12 segment "${seg}" so the implementation-guide reader can trust the parser`);
  }
});

test('7. HTML documents every member-action class: add / change / term / cancel / reinstate', () => {
  const html = read(HTML);
  for (const action of ['add', 'change', 'term', 'cancel', 'reinstate']) {
    assert.ok(html.includes(action),
      `edi-834.html must document the "${action}" member-action class so downstream enrollment systems know the full action vector`);
  }
});

test('8. HTML names the three roster parties: sponsor, insurer, and the member-roster output', () => {
  const html = read(HTML);
  for (const party of ['sponsor', 'insurer', 'member-roster']) {
    assert.ok(html.includes(party),
      `edi-834.html must name the "${party}" party/output so the 834 mental model is intact`);
  }
});

test('9. spec.json job_id is "job_edi_834_transformer_v1" and base_model is "none"', () => {
  const j = JSON.parse(read(SPEC));
  assert.equal(j.job_id, 'job_edi_834_transformer_v1',
    'spec.json job_id must be "job_edi_834_transformer_v1" so manifest binding lines up with the showcase index');
  assert.equal(j.base_model, 'none',
    'spec.json base_model must be "none" -- this is a pure rule-class recipe with no model inference');
});

test('10. spec.json recipe id "rcp_edi_834_v1" with enrollment + benefit-maintenance tags', () => {
  const j = JSON.parse(read(SPEC));
  assert.ok(Array.isArray(j.recipes) && j.recipes.length === 1,
    'spec.json must declare exactly one recipe');
  assert.equal(j.recipes[0].id, 'rcp_edi_834_v1',
    'spec.json recipe id must be "rcp_edi_834_v1"');
  assert.equal(j.recipes[0].name, 'edi-834',
    'spec.json recipe name must be "edi-834"');
  const tags = j.recipes[0].tags || [];
  for (const tag of ['enrollment', 'benefit-maintenance']) {
    assert.ok(tags.includes(tag),
      `spec.json recipe tags must include "${tag}" so the showcase index can route procurement queries to this template`);
  }
});

test('11. spec.json pack.rules.bgn02_purpose_codes contains real BGN02 values 00, 15, 22', () => {
  const j = JSON.parse(read(SPEC));
  const codes = (j.pack && j.pack.rules && j.pack.rules.bgn02_purpose_codes) || {};
  for (const code of ['00', '15', '22']) {
    assert.ok(Object.prototype.hasOwnProperty.call(codes, code),
      `pack.rules.bgn02_purpose_codes must include real X12 5010 BGN02 value "${code}" (Original / Re-Submission / Information Copy)`);
  }
});

test('12. spec.json pack.rules.relationship_codes contains real INS02 values 01, 18, 19', () => {
  const j = JSON.parse(read(SPEC));
  const rels = (j.pack && j.pack.rules && j.pack.rules.relationship_codes) || {};
  for (const code of ['01', '18', '19']) {
    assert.ok(Object.prototype.hasOwnProperty.call(rels, code),
      `pack.rules.relationship_codes must include real X12 INS02 value "${code}" (Spouse / Self / Child)`);
  }
});

test('13. spec.json evals.cases is at least 3 (rule-class coverage floor)', () => {
  const j = JSON.parse(read(SPEC));
  const cases = (j.evals && j.evals.cases) || [];
  assert.ok(cases.length >= 3,
    `spec.json must ship at least 3 eval cases for the rule-class transformer (got ${cases.length})`);
  assert.equal(j.evals.coverage, 1.0,
    'spec.json evals.coverage must be 1.0 since rule-class recipes are deterministic');
});

test('14. HTML related-templates grid links to all 5 sibling templates', () => {
  const html = read(HTML);
  const SIBLINGS = ['edi-837', 'edi-835', 'edi-270-271', 'edi-278', 'fhir-uscdi'];
  for (const sibling of SIBLINGS) {
    assert.ok(html.includes(`/insurance/templates/${sibling}`),
      `edi-834.html related-templates grid must link to /insurance/templates/${sibling}`);
  }
});

test('15. spec.json recipe source actually parses the four eval cases to the expected actions', () => {
  // Round-trip integrity: the source function string in spec.json must, when
  // executed, produce outputs that satisfy every eval case's `expected` block.
  // This locks the recipe source to the eval contract so a future edit cannot
  // silently break the shipping spec.
  const j = JSON.parse(read(SPEC));
  const src = j.recipes[0].source;
  const fn = new Function('return ' + src)();
  for (const c of j.evals.cases) {
    const out = fn(c.input, j);
    if (c.expected.members && c.expected.members[0] && c.expected.members[0].action) {
      assert.equal(out.members[0].action, c.expected.members[0].action,
        `eval case "${c.id}" expected members[0].action="${c.expected.members[0].action}" but got "${out.members[0] && out.members[0].action}"`);
    }
    if (c.expected.summary && typeof c.expected.summary.total === 'number') {
      assert.equal(out.summary.total, c.expected.summary.total,
        `eval case "${c.id}" expected summary.total=${c.expected.summary.total} but got ${out.summary.total}`);
    }
    if (c.expected.purpose) {
      assert.equal(out.purpose, c.expected.purpose,
        `eval case "${c.id}" expected purpose="${c.expected.purpose}" but got "${out.purpose}"`);
    }
  }
});
