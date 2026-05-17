// Wave 199: `kolm seeds new "<brief>"` brief-route lock-in.
//
// Shift 5 of W196-W201. Adds the data-creation companion to the W197 NL
// recipe scaffolder: user types `kolm seeds new "teach me about denial
// codes"` and gets `count` deterministic candidate {input,output,tags}
// rows from a per-class library, tagged synthesized:true. The networked
// teacher path is NOT YET WIRED today (same air-gap-first contract as
// W197) and the test suite locks both branches.
//
// Tests lock both the CLI substrate (dispatch table reaches the brief
// route, help text mentions candidates + scaffold + split) and the
// backend (`seedsNewFromBrief` export from src/synthesis.js with
// stable output shape across the 4 recipe classes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'cli', 'kolm.js');
const SYNTH = path.join(REPO, 'src', 'synthesis.js');

const ENV = {
  ...process.env,
  KOLM_AIRGAP: '1',
  NO_COLOR: '1',
};

const RECIPE_CLASSES = ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'];

function execSeedsNew(args, env = ENV) {
  return spawnSync(process.execPath, [CLI, 'seeds', 'new', ...args], {
    timeout: 10_000,
    encoding: 'utf8',
    env,
  });
}

function execKolm(args, env = ENV) {
  return spawnSync(process.execPath, [CLI, ...args], {
    timeout: 10_000,
    encoding: 'utf8',
    env,
  });
}

test('1. seedsNewFromBrief is importable from src/synthesis.js as a function', async () => {
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  assert.equal(typeof mod.seedsNewFromBrief, 'function',
    'src/synthesis.js must export seedsNewFromBrief as a function');
});

test('2. Air-gap call returns exactly `count` candidates (default 10)', async () => {
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  const r = mod.seedsNewFromBrief({ brief: 'teach me about denial codes', airGap: true });
  assert.equal(r.ok, true, 'seedsNewFromBrief must return ok:true under airGap:true');
  assert.ok(Array.isArray(r.candidates), 'candidates must be an array');
  assert.equal(r.candidates.length, 10, `default count is 10; got ${r.candidates.length}`);
});

test('3. Each candidate has {input, output, tags} shape with synthesized:true tag', async () => {
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  const r = mod.seedsNewFromBrief({ brief: 'parse EDI 837 claims', airGap: true });
  for (let i = 0; i < r.candidates.length; i++) {
    const c = r.candidates[i];
    assert.ok(typeof c.input === 'string' && c.input.length > 0, `candidate ${i} must have non-empty input`);
    assert.ok(c.output !== undefined && c.output !== null && String(c.output).length > 0,
      `candidate ${i} must have non-empty output`);
    assert.ok(Array.isArray(c.tags), `candidate ${i}.tags must be an array`);
    assert.ok(c.tags.includes('synthesized'),
      `candidate ${i}.tags must include "synthesized" (got: ${JSON.stringify(c.tags)})`);
    assert.equal(c.synthesized, true, `candidate ${i}.synthesized must be true`);
  }
});

test('4. Air-gap call has network_status: "air_gap" (not not_yet_wired)', async () => {
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  const r = mod.seedsNewFromBrief({ brief: 'parse EDI 837 claims', airGap: true });
  assert.equal(r.network_status, 'air_gap',
    `airGap:true must yield network_status:"air_gap"; got ${r.network_status}`);
});

test('5. No-air-gap call returns network_status: "not_yet_wired" with sentinel row', async () => {
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  const r = mod.seedsNewFromBrief({ brief: 'parse EDI 837 claims', airGap: false });
  assert.equal(r.network_status, 'not_yet_wired',
    `airGap:false must yield network_status:"not_yet_wired"; got ${r.network_status}`);
  assert.ok(Array.isArray(r.candidates) && r.candidates.length >= 1,
    'sentinel must include at least one row explaining the situation');
  assert.match(JSON.stringify(r.candidates[0]), /not yet wired|air-gap|NOT YET WIRED/i,
    'sentinel row must say NOT YET WIRED so caller cannot mistake it for real teacher output');
});

test('6. classHint override forces the requested recipe class', async () => {
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  // "draft an appeal letter" alone infers distilled_model. Force rule.
  const r = mod.seedsNewFromBrief({
    brief: 'draft an appeal letter for a denial',
    classHint: 'rule',
    airGap: true,
  });
  assert.equal(r.class, 'rule',
    `classHint must override keyword inference; got ${r.class} (basis: ${r.class_inference_basis})`);
  assert.equal(r.class_inference_basis, 'class_hint',
    `class_inference_basis must indicate the hint won; got ${r.class_inference_basis}`);
});

test('7. Keyword inference: "denial appeal" -> distilled_model', async () => {
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  const r = mod.seedsNewFromBrief({ brief: 'draft a denial appeal letter', airGap: true });
  assert.equal(r.class, 'distilled_model',
    `"denial appeal letter" should map to distilled_model; got ${r.class} (basis: ${r.class_inference_basis})`);
});

test('8. Keyword inference: "EDI 837" -> rule', async () => {
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  const r = mod.seedsNewFromBrief({ brief: 'parse EDI 837 claim segments', airGap: true });
  assert.equal(r.class, 'rule',
    `"EDI 837 parser" should map to rule; got ${r.class} (basis: ${r.class_inference_basis})`);
});

test('9. Keyword inference: "HEDIS measure" -> synthesized_rule', async () => {
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  const r = mod.seedsNewFromBrief({ brief: 'compute HEDIS CBP measure for a cohort', airGap: true });
  assert.equal(r.class, 'synthesized_rule',
    `"HEDIS measure" should map to synthesized_rule; got ${r.class} (basis: ${r.class_inference_basis})`);
});

test('10. Gate suggestion matches per-class default (rule=0.88, synth=0.90, compiled=0.92, distilled=0.85)', async () => {
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  const expected = {
    rule: 0.88,
    synthesized_rule: 0.90,
    compiled_rule: 0.92,
    distilled_model: 0.85,
  };
  for (const klass of RECIPE_CLASSES) {
    const r = mod.seedsNewFromBrief({ brief: 'some brief', classHint: klass, airGap: true });
    assert.equal(r.gate_suggestion, expected[klass],
      `class ${klass} must suggest gate ${expected[klass]}; got ${r.gate_suggestion}`);
  }
});

test('11. `kolm seeds new "test brief"` returns exit 0 under KOLM_AIRGAP=1', () => {
  const r = execSeedsNew(['teach me about denial codes 50 ways']);
  assert.equal(r.status, 0,
    `kolm seeds new "<brief>" exited ${r.status} (stderr: ${r.stderr?.slice(0, 300)})`);
});

test('12. `kolm seeds new --help` returns exit 0 and includes "candidates", "scaffold", "kolm seeds split"', () => {
  const r = execSeedsNew(['--help']);
  assert.equal(r.status, 0, `kolm seeds new --help exited ${r.status}`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /candidate/i, 'help must mention "candidate" (honest scope language)');
  assert.match(out, /scaffold/i, 'help must mention "scaffold"');
  assert.match(out, /kolm seeds split/, 'help must reference `kolm seeds split` as the next step');
});

test('13. `kolm seeds new "<brief>" --json` returns valid JSON with all 5 top-level keys', () => {
  const r = execSeedsNew(['teach me about denial codes', '--json']);
  assert.equal(r.status, 0, `--json exited ${r.status} (stderr: ${r.stderr?.slice(0, 200)})`);
  const parsed = JSON.parse(r.stdout);
  for (const key of ['class', 'candidates', 'gate_suggestion', 'next_steps', 'network_status']) {
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, key),
      `--json output must include top-level key "${key}" (got keys: ${Object.keys(parsed).join(', ')})`);
  }
});

test('14. `kolm seeds new "<brief>" --out=<tmpfile>` writes valid JSONL (one JSON per line)', () => {
  const tmp = path.join(os.tmpdir(), `wave199-seeds-out-${Date.now()}.jsonl`);
  try {
    const r = execSeedsNew(['parse EDI 837 claims', '--out', tmp]);
    assert.equal(r.status, 0, `--out exited ${r.status} (stderr: ${r.stderr?.slice(0, 200)})`);
    assert.ok(fs.existsSync(tmp), `--out should have written ${tmp}`);
    const content = fs.readFileSync(tmp, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length >= 1, 'JSONL must have at least one line');
    for (let i = 0; i < lines.length; i++) {
      let parsed;
      try { parsed = JSON.parse(lines[i]); }
      catch (e) {
        assert.fail(`JSONL line ${i + 1} is not valid JSON: ${e.message}\n  line: ${lines[i].slice(0, 200)}`);
      }
      assert.equal(parsed.synthesized, true, `line ${i + 1} must carry synthesized:true tag`);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('15. `kolm seeds new "<brief>" --count=5` returns exactly 5 candidates', () => {
  const r = execSeedsNew(['parse EDI 837 claims', '--count', '5', '--json']);
  assert.equal(r.status, 0, `--count 5 exited ${r.status}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.candidates.length, 5,
    `--count 5 must return exactly 5 candidates; got ${parsed.candidates.length}`);
});

test('16. `seeds` dispatch in cli/kolm.js accepts `new` subcommand (grep dispatch table)', () => {
  const cli = fs.readFileSync(CLI, 'utf8');
  assert.match(cli, /sub === ['"`]new['"`]\s*\)\s*return\s+cmdSeedsNew/,
    "cli/kolm.js seeds dispatch must route 'new' to cmdSeedsNew");
  assert.match(cli, /async function cmdSeedsNewFromBrief\s*\(/,
    'cli/kolm.js must define async function cmdSeedsNewFromBrief(args) (Wave 199 brief route)');
});

test('17. Two consecutive air-gap calls with same brief produce identical candidates (determinism)', () => {
  const a = execSeedsNew(['teach me about denial codes', '--json']);
  const b = execSeedsNew(['teach me about denial codes', '--json']);
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.equal(a.stdout, b.stdout,
    'air-gap mode must be deterministic: same brief must produce same output across two invocations');
});

test('18. Honest scope: human output mentions "candidate" or "scaffold" AND K-score gate (not "label")', () => {
  const r = execSeedsNew(['parse EDI 837 claims']);
  assert.equal(r.status, 0);
  const out = r.stdout || '';
  assert.match(out, /candidate|scaffold/i,
    'human output must mention "candidate" or "scaffold" (honest scope language)');
  assert.match(out, /k-score|gate/i,
    'human output must mention K-score gate so user knows candidates need validation');
});

test('19. seedsNewFromBrief({airGap:true}) completes in < 300ms (no network)', async () => {
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  const start = Date.now();
  const r = mod.seedsNewFromBrief({ brief: 'parse EDI 837 claims', airGap: true });
  const dt = Date.now() - start;
  assert.equal(r.ok, true);
  assert.ok(dt < 300,
    `air-gap path must complete in < 300ms (took ${dt}ms): any network call would blow this budget`);
});

test('20. `seeds new` line present in `kolm --help` (root help)', () => {
  const r = execKolm(['--help']);
  assert.equal(r.status, 0);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /seeds new/,
    'root `kolm --help` must mention `seeds new` so the brief route is discoverable');
});

test('21. CARC denial codes 50/197/204/16 appear in the rule-class library', async () => {
  // The W199 plan explicitly calls for the air-gap library to use real
  // CARC codes from W183. This locks the domain choice so a future
  // refactor cannot silently swap in generic stubs.
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  const r = mod.seedsNewFromBrief({ brief: 'classify denial codes', classHint: 'rule', airGap: true, count: 10 });
  // Search the raw input/output text of the candidates (NOT the stringified
  // form, where inner quotes get escaped). Each CARC code must literally
  // appear in the row text so a future refactor cannot silently swap in
  // generic stubs.
  const blob = r.candidates.map(c => `${c.input} ${c.output}`).join(' \n ');
  for (const code of ['50', '197', '204', '16']) {
    assert.ok(blob.includes(`"${code}"`),
      `rule-class library must include CARC ${code} (W183 alignment); searched blob: ${blob.slice(0, 400)}`);
  }
});

test('22. Brief route output has note field calling rows "CANDIDATES, not labels"', async () => {
  const mod = await import('file://' + SYNTH.replace(/\\/g, '/'));
  const r = mod.seedsNewFromBrief({ brief: 'parse EDI 837 claims', airGap: true });
  assert.ok(typeof r.note === 'string' && r.note.length > 0, 'result must carry a note field');
  assert.match(r.note, /CANDIDATES|candidates/,
    `note field must call rows "CANDIDATES" so callers cannot misframe; got: ${r.note}`);
});
