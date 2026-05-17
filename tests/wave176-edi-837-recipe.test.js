// Wave 176 - EDI 837 (claims submission) recipe for /health-insurance vertical.
// Locks in the canonical pattern shape established by claims-adjudication +
// the wave-176-specific facts: rule-class artifact, 5010A1/A2 loop coverage,
// real X12 qualifier codes (BJ/BK/PR), and the 5-sibling related-template
// grid that the rest of this batch (edi-835/834/270-271/278/fhir-uscdi) will
// match against in their own lock-in tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HTML = path.join(REPO, 'public', 'insurance', 'templates', 'edi-837.html');
const SPEC = path.join(REPO, 'public', 'docs', 'showcase', 'edi-837.spec.json');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /insurance/templates/edi-837.html exists and is non-trivial size', () => {
  assert.ok(fs.existsSync(HTML), `edi-837.html missing at ${HTML}`);
  const stat = fs.statSync(HTML);
  assert.ok(stat.size > 7000, `edi-837.html too small (${stat.size} bytes; expected > 7000)`);
});

test('2. /docs/showcase/edi-837.spec.json exists and parses as valid JSON', () => {
  assert.ok(fs.existsSync(SPEC), `edi-837.spec.json missing at ${SPEC}`);
  const raw = read(SPEC);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'spec.json must parse as valid JSON');
  assert.ok(parsed && typeof parsed === 'object', 'parsed spec must be an object');
});

test('3. edi-837.html declares canonical https://kolm.ai/insurance/templates/edi-837', () => {
  const html = read(HTML);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/kolm\.ai\/insurance\/templates\/edi-837"/,
    'canonical link tag must point at https://kolm.ai/insurance/templates/edi-837'
  );
});

test('4. edi-837.html declares recipe class as rule (class 0)', () => {
  const html = read(HTML);
  assert.match(
    html,
    /recipe class/i,
    'metadata grid must include a "recipe class" cell'
  );
  assert.match(
    html,
    /rule\s*\(class\s*0\)/i,
    'metadata grid must surface "rule (class 0)" so the marketing language matches src/recipe-class.js CLASS_RANK.rule=0'
  );
});

test('5. edi-837.html declares K-score gate >= 0.92', () => {
  const html = read(HTML);
  // Match either &ge;0.92 or >= 0.92 with optional whitespace and HTML entity.
  assert.match(
    html,
    /(?:&ge;|>=)\s*0\.92/,
    'k-score gate cell must read ">= 0.92" (rule-class gate, lower than the 0.95 model-class gate)'
  );
});

test('6. edi-837.html mentions both 837P and 837I (professional + institutional)', () => {
  const html = read(HTML);
  assert.ok(html.includes('837P'), 'page must mention 837P (professional)');
  assert.ok(html.includes('837I'), 'page must mention 837I (institutional)');
});

test('7. edi-837.html mentions 5010A1 and 5010A2', () => {
  const html = read(HTML);
  assert.ok(html.includes('5010A1'), 'page must cite 5010A1 implementation guide');
  assert.ok(html.includes('5010A2'), 'page must cite 5010A2 implementation guide');
});

test('8. edi-837.html input section shows ISA/GS/ST/BHT/NM1/HL/CLM/SV1 segments', () => {
  const html = read(HTML);
  for (const seg of ['ISA', 'GS', 'ST', 'BHT', 'NM1', 'HL', 'CLM', 'SV1']) {
    assert.ok(
      html.includes(seg),
      `input example must include X12 segment "${seg}" so readers can pattern-match against their own 837 envelopes`
    );
  }
});

test('9. spec.json has job_id, base_model=none, and default kolm license', () => {
  const j = JSON.parse(read(SPEC));
  assert.equal(j.job_id, 'job_edi_837_transformer_v1', 'job_id must be job_edi_837_transformer_v1');
  assert.equal(j.base_model, 'none', 'base_model must be "none" because rule-class recipes carry no weights');
  assert.equal(j.license, 'LicenseRef-kolm-default-1.0', 'license tag must be the kolm default');
});

test('10. spec.json recipes[0] id=rcp_edi_837_v1 with health-insurance/edi/837 tags', () => {
  const j = JSON.parse(read(SPEC));
  assert.ok(Array.isArray(j.recipes) && j.recipes.length > 0, 'recipes must be a non-empty array');
  const r = j.recipes[0];
  assert.equal(r.id, 'rcp_edi_837_v1', 'recipe id must be rcp_edi_837_v1');
  assert.ok(Array.isArray(r.tags), 'recipe.tags must be an array');
  for (const tag of ['health-insurance', 'edi', '837']) {
    assert.ok(r.tags.includes(tag), `recipe.tags must include "${tag}"`);
  }
});

test('11. spec.json evals.cases length >= 3 and every case has non-empty input.edi_text', () => {
  const j = JSON.parse(read(SPEC));
  assert.ok(j.evals && Array.isArray(j.evals.cases), 'evals.cases must be an array');
  assert.ok(j.evals.cases.length >= 3, `evals.cases must have >= 3 entries (got ${j.evals.cases.length})`);
  for (const c of j.evals.cases) {
    assert.ok(c.id && typeof c.id === 'string', `every eval case must have an id (got ${JSON.stringify(c.id)})`);
    assert.ok(
      c.input && typeof c.input.edi_text === 'string' && c.input.edi_text.length > 0,
      `every eval case input.edi_text must be a non-empty string (case ${c.id})`
    );
  }
});

test('12. spec.json pack.rules.qualifiers contains real X12 5010 codes BJ + BK + PR', () => {
  const j = JSON.parse(read(SPEC));
  assert.ok(j.pack && j.pack.rules && j.pack.rules.qualifiers, 'pack.rules.qualifiers must exist');
  const q = j.pack.rules.qualifiers;
  // BJ = Professional, BK = Institutional, PR = Insurance Company - all real
  // X12 5010 qualifier codes. The honesty guard for this wave was "no
  // fabricated qualifier codes"; this test pins the three the spec says are
  // load-bearing.
  assert.equal(q.BJ, 'Professional', 'BJ must map to "Professional" (real X12 5010 code)');
  assert.equal(q.BK, 'Institutional', 'BK must map to "Institutional" (real X12 5010 code)');
  assert.equal(q.PR, 'Insurance Company', 'PR must map to "Insurance Company" (real X12 5010 code)');
});

test('13. spec.json recipes[0].source is a string starting with "function generate"', () => {
  const j = JSON.parse(read(SPEC));
  const src = j.recipes[0].source;
  assert.equal(typeof src, 'string', 'recipes[0].source must be a string (rule-class recipe body)');
  assert.ok(
    src.startsWith('function generate'),
    `recipes[0].source must start with "function generate" so the rule-class loader can node:vm-execute it (got prefix ${JSON.stringify(src.slice(0, 40))})`
  );
});

test('14. edi-837.html links to all 5 sibling templates in the related grid', () => {
  const html = read(HTML);
  const siblings = ['edi-835', 'edi-834', 'edi-270-271', 'edi-278', 'fhir-uscdi'];
  for (const sib of siblings) {
    assert.match(
      html,
      new RegExp(`href="/insurance/templates/${sib.replace(/[-]/g, '\\-')}"`),
      `related-templates grid must link to /insurance/templates/${sib} (sibling being built in same wave batch)`
    );
  }
});

test('15. spec.json recipes[0].source produces format=837P + balance_check=true on first eval case', () => {
  // Functional smoke test: the rule actually runs and produces the expected
  // shape. If somebody later edits the source and breaks it, this catches it
  // before the artifact ever ships.
  const j = JSON.parse(read(SPEC));
  const fn = new Function('return (' + j.recipes[0].source + ')')();
  const lib = { pack: j.pack };
  const first = j.evals.cases[0];
  const out = fn(first.input, lib);
  assert.equal(out.format, '837P', 'first case must parse as 837P');
  assert.equal(out.validation.balance_check, true, 'first case SV1 sum must equal CLM total (balance_check=true)');
  assert.equal(out.validation.loops_valid, true, 'first case must have loops_valid=true (all required envelopes present)');
});
