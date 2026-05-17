// Wave 183 — Shift 2 recipe #8/9 for the health-insurance lighthouse:
// two MODEL-CLASS (class 3) letter-generator recipes — denial-appeal-letter
// and prior-auth-letter. Lock-in tests for the four user-facing files:
//   public/insurance/templates/denial-appeal-letter.html
//   public/insurance/templates/prior-auth-letter.html
//   public/docs/showcase/denial-appeal-letter.spec.json
//   public/docs/showcase/prior-auth-letter.spec.json
//
// Same shape conventions as the W178-W182 EDI/HEDIS sibling tests: assert
// the page + spec exist; the recipe class is honestly badged as model-class
// (class 3) and the base model is Qwen2.5-7B-Instruct (a real, public,
// Apache-2.0 open-weight model); the K-score gate is 0.92; the related-
// templates grid links to the five sibling templates spelled out in the
// brief; and the pack.rules carry the closed sets named in the spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

const DENIAL_HTML = path.join(PUBLIC, 'insurance', 'templates', 'denial-appeal-letter.html');
const DENIAL_SPEC = path.join(PUBLIC, 'docs', 'showcase', 'denial-appeal-letter.spec.json');
const PA_HTML = path.join(PUBLIC, 'insurance', 'templates', 'prior-auth-letter.html');
const PA_SPEC = path.join(PUBLIC, 'docs', 'showcase', 'prior-auth-letter.spec.json');

const readFile = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// The five sibling templates each page must cross-link to (per brief).
const DENIAL_SIBLINGS = ['prior-auth-letter', 'edi-278', 'prior-auth-review', 'claims-adjudication', 'member-support-triage'];
const PA_SIBLINGS = ['denial-appeal-letter', 'edi-278', 'prior-auth-review', 'claims-adjudication', 'member-support-triage'];

// ---------------------------------------------------------------------------
// 1-2. File existence + size floor (both HTMLs > 7000 bytes, both specs valid)
// ---------------------------------------------------------------------------

test('1. denial-appeal-letter.html exists and is > 7000 bytes', () => {
  assert.ok(fs.existsSync(DENIAL_HTML), `missing ${DENIAL_HTML}`);
  const size = fs.statSync(DENIAL_HTML).size;
  assert.ok(size > 7000, `denial-appeal-letter.html too small (${size} bytes; expected > 7000)`);
});

test('2. prior-auth-letter.html exists and is > 7000 bytes', () => {
  assert.ok(fs.existsSync(PA_HTML), `missing ${PA_HTML}`);
  const size = fs.statSync(PA_HTML).size;
  assert.ok(size > 7000, `prior-auth-letter.html too small (${size} bytes; expected > 7000)`);
});

test('3. denial-appeal-letter.spec.json exists and is valid JSON', () => {
  assert.ok(fs.existsSync(DENIAL_SPEC), `missing ${DENIAL_SPEC}`);
  const spec = readJson(DENIAL_SPEC);
  assert.ok(spec && typeof spec === 'object', 'spec must parse to an object');
});

test('4. prior-auth-letter.spec.json exists and is valid JSON', () => {
  assert.ok(fs.existsSync(PA_SPEC), `missing ${PA_SPEC}`);
  const spec = readJson(PA_SPEC);
  assert.ok(spec && typeof spec === 'object', 'spec must parse to an object');
});

// ---------------------------------------------------------------------------
// 5-6. Canonical URLs
// ---------------------------------------------------------------------------

test('5. denial-appeal-letter.html declares the canonical kolm.ai/insurance/templates/denial-appeal-letter URL', () => {
  const html = readFile(DENIAL_HTML);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/kolm\.ai\/insurance\/templates\/denial-appeal-letter"/,
    'canonical link must point at https://kolm.ai/insurance/templates/denial-appeal-letter'
  );
});

test('6. prior-auth-letter.html declares the canonical kolm.ai/insurance/templates/prior-auth-letter URL', () => {
  const html = readFile(PA_HTML);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/kolm\.ai\/insurance\/templates\/prior-auth-letter"/,
    'canonical link must point at https://kolm.ai/insurance/templates/prior-auth-letter'
  );
});

// ---------------------------------------------------------------------------
// 7. Both HTMLs honestly badge model-class (class 3) — distinguishes them
//    from rule-class (class 0) EDI templates and synthesized-rule (class 1)
//    HEDIS templates. This is the load-bearing taxonomy guard from
//    src/recipe-class.js.
// ---------------------------------------------------------------------------

test('7. both HTMLs badge the recipe as model-class (class 3) in the recipe-class meta strip', () => {
  for (const [name, p] of [['denial-appeal-letter', DENIAL_HTML], ['prior-auth-letter', PA_HTML]]) {
    const html = readFile(p);
    assert.match(html, /model-class \(class 3\)/, `${name} must badge recipe class as "model-class (class 3)"`);
  }
});

// ---------------------------------------------------------------------------
// 8. Both specs declare base_model "Qwen/Qwen2.5-7B-Instruct" — a real,
//    public, Apache-2.0 licensed open-weight model. Brief explicitly
//    forbids inventing a different base model.
// ---------------------------------------------------------------------------

test('8. both specs declare base_model "Qwen/Qwen2.5-7B-Instruct"', () => {
  for (const [name, p] of [['denial-appeal-letter', DENIAL_SPEC], ['prior-auth-letter', PA_SPEC]]) {
    const spec = readJson(p);
    assert.equal(spec.base_model, 'Qwen/Qwen2.5-7B-Instruct', `${name} spec.base_model must be "Qwen/Qwen2.5-7B-Instruct"`);
  }
});

// ---------------------------------------------------------------------------
// 9. Both specs declare K-score gate >= 0.92, and both HTMLs surface 0.92.
// ---------------------------------------------------------------------------

test('9. both specs declare k_score_gate 0.92 and both HTMLs surface the 0.92 figure', () => {
  for (const [name, htmlPath, specPath] of [
    ['denial-appeal-letter', DENIAL_HTML, DENIAL_SPEC],
    ['prior-auth-letter', PA_HTML, PA_SPEC],
  ]) {
    const spec = readJson(specPath);
    assert.equal(spec.k_score_gate, 0.92, `${name} k_score_gate must equal 0.92`);
    const html = readFile(htmlPath);
    assert.match(html, /0\.92/, `${name} HTML must surface 0.92`);
    assert.match(html, /k-score gate[\s\S]{0,200}0\.92/i, `${name} HTML k-score-gate meta row must carry 0.92`);
  }
});

// ---------------------------------------------------------------------------
// 10. Both pages cross-link to all five sibling templates listed in the brief.
// ---------------------------------------------------------------------------

test('10. denial-appeal-letter.html related grid links to all five sibling templates', () => {
  const html = readFile(DENIAL_HTML);
  for (const sib of DENIAL_SIBLINGS) {
    assert.match(
      html,
      new RegExp(`/insurance/templates/${sib.replace(/[-]/g, '\\-')}`),
      `denial-appeal-letter related grid must link to /insurance/templates/${sib}`
    );
  }
});

test('11. prior-auth-letter.html related grid links to all five sibling templates', () => {
  const html = readFile(PA_HTML);
  for (const sib of PA_SIBLINGS) {
    assert.match(
      html,
      new RegExp(`/insurance/templates/${sib.replace(/[-]/g, '\\-')}`),
      `prior-auth-letter related grid must link to /insurance/templates/${sib}`
    );
  }
});

// ---------------------------------------------------------------------------
// 12. denial-appeal-letter pack.rules.regulatory_basis_by_state covers at
//     least CA + TX + NY (three states; brief allows dropping any unverifiable
//     statute reference but requires three states min).
// ---------------------------------------------------------------------------

test('12. denial-appeal-letter pack.rules.regulatory_basis_by_state contains CA + TX + NY with statute + days_to_respond', () => {
  const spec = readJson(DENIAL_SPEC);
  const states = (spec.pack && spec.pack.rules && spec.pack.rules.regulatory_basis_by_state) || {};
  for (const st of ['CA', 'TX', 'NY']) {
    assert.ok(states[st], `regulatory_basis_by_state.${st} must be present`);
    assert.ok(typeof states[st].statute === 'string' && states[st].statute.length > 0, `regulatory_basis_by_state.${st}.statute must be non-empty string`);
    assert.ok(Number.isInteger(states[st].days_to_respond) && states[st].days_to_respond > 0, `regulatory_basis_by_state.${st}.days_to_respond must be positive integer`);
  }
});

// ---------------------------------------------------------------------------
// 13. denial-appeal-letter K-score components include the custom
//     groundedness axis at weight 0.20.
// ---------------------------------------------------------------------------

test('13. denial-appeal-letter k_score_components.groundedness is 0.20', () => {
  const spec = readJson(DENIAL_SPEC);
  const comps = spec.k_score_components || {};
  assert.equal(comps.groundedness, 0.20, 'k_score_components.groundedness must equal 0.20');
});

// ---------------------------------------------------------------------------
// 14. prior-auth-letter pack.rules.medical_necessity_criteria has all four
//     framework criteria.
// ---------------------------------------------------------------------------

test('14. prior-auth-letter pack.rules.medical_necessity_criteria has the four framework criteria', () => {
  const spec = readJson(PA_SPEC);
  const criteria = (spec.pack && spec.pack.rules && spec.pack.rules.medical_necessity_criteria) || [];
  assert.ok(Array.isArray(criteria), 'medical_necessity_criteria must be an array');
  assert.equal(criteria.length, 4, `medical_necessity_criteria must have exactly 4 entries (got ${criteria.length})`);
  for (const expected of ['appropriate_diagnosis', 'evidence_based_guideline', 'prior_failed_conservative_therapy', 'clinical_urgency']) {
    assert.ok(criteria.includes(expected), `medical_necessity_criteria must include "${expected}"`);
  }
});

// ---------------------------------------------------------------------------
// 15. prior-auth-letter pack.rules.submission_routes contains all three
//     wire-formats named in the brief.
// ---------------------------------------------------------------------------

test('15. prior-auth-letter pack.rules.submission_routes contains "278", "portal", "fax"', () => {
  const spec = readJson(PA_SPEC);
  const routes = (spec.pack && spec.pack.rules && spec.pack.rules.submission_routes) || {};
  for (const route of ['278', 'portal', 'fax']) {
    assert.ok(Object.prototype.hasOwnProperty.call(routes, route), `submission_routes must include "${route}"`);
    assert.ok(typeof routes[route] === 'string' && routes[route].length > 0, `submission_routes["${route}"] must be a non-empty string label`);
  }
});

// ---------------------------------------------------------------------------
// 16. Both spec tags include "model-class" + "grounded-output" — the two
//     identifying tags that distinguish these from rule-class siblings.
// ---------------------------------------------------------------------------

test('16. both recipes carry tags "model-class" and "grounded-output"', () => {
  for (const [name, p] of [['denial-appeal-letter', DENIAL_SPEC], ['prior-auth-letter', PA_SPEC]]) {
    const spec = readJson(p);
    const tags = (spec.recipes && spec.recipes[0] && spec.recipes[0].tags) || [];
    for (const expected of ['model-class', 'grounded-output']) {
      assert.ok(tags.includes(expected), `${name} recipes[0].tags must include "${expected}" (got ${JSON.stringify(tags)})`);
    }
  }
});

// ---------------------------------------------------------------------------
// 17. Both specs declare exactly 3 epochs + the LoRA hyperparams the brief
//     specifies — locks in we did not invent training config drift.
// ---------------------------------------------------------------------------

test('17. both specs declare epochs 3 and the LoRA hyperparams from the brief', () => {
  for (const [name, p] of [['denial-appeal-letter', DENIAL_SPEC], ['prior-auth-letter', PA_SPEC]]) {
    const spec = readJson(p);
    assert.equal(spec.epochs, 3, `${name} epochs must be 3`);
    assert.equal(spec.lora_r, 16, `${name} lora_r must be 16`);
    assert.equal(spec.lora_alpha, 32, `${name} lora_alpha must be 32`);
    assert.equal(spec.lora_dropout, 0.05, `${name} lora_dropout must be 0.05`);
    assert.equal(spec.lr, 2e-4, `${name} lr must be 2e-4`);
    assert.equal(spec.max_seq_len, 4096, `${name} max_seq_len must be 4096`);
    assert.equal(spec.seeds_path, './seeds.jsonl', `${name} seeds_path must be ./seeds.jsonl`);
  }
});

// ---------------------------------------------------------------------------
// 18. Both spec evals contain at least 3 cases with coverage 1.0.
// ---------------------------------------------------------------------------

test('18. both specs ship >= 3 eval cases at coverage 1.0', () => {
  for (const [name, p] of [['denial-appeal-letter', DENIAL_SPEC], ['prior-auth-letter', PA_SPEC]]) {
    const spec = readJson(p);
    const cases = (spec.evals && spec.evals.cases) || [];
    assert.ok(cases.length >= 3, `${name} evals.cases must have >= 3 entries (got ${cases.length})`);
    assert.equal(spec.evals.coverage, 1.0, `${name} evals.coverage must be 1.0`);
  }
});

// ---------------------------------------------------------------------------
// 19. denial-appeal-letter spec carries the real CARC denial codes named in
//     the brief (50 + 197) in pack.rules.carc_reference.
// ---------------------------------------------------------------------------

test('19. denial-appeal-letter pack.rules.carc_reference carries CARC 50 and CARC 197', () => {
  const spec = readJson(DENIAL_SPEC);
  const carc = (spec.pack && spec.pack.rules && spec.pack.rules.carc_reference) || {};
  for (const code of ['50', '197']) {
    assert.ok(Object.prototype.hasOwnProperty.call(carc, code), `carc_reference must include CARC ${code}`);
    assert.ok(typeof carc[code] === 'string' && carc[code].length > 0, `carc_reference["${code}"] must be a non-empty string`);
  }
});

// ---------------------------------------------------------------------------
// 20. prior-auth-letter HTML names the four-criterion framework explicitly.
// ---------------------------------------------------------------------------

test('20. prior-auth-letter HTML names the four-criterion medical-necessity framework', () => {
  const html = readFile(PA_HTML);
  assert.match(html, /four[- ]criterion/i, 'page must reference the four-criterion framework');
  assert.match(html, /medical necessity/i, 'page must reference "medical necessity"');
  for (const crit of ['appropriate_diagnosis', 'evidence_based_guideline', 'prior_failed_conservative_therapy', 'clinical_urgency']) {
    assert.ok(html.includes(crit), `prior-auth-letter HTML must surface criterion "${crit}"`);
  }
});
