// Wave 144 / Wave F — rule-dsl-v1 codegen tests.
//
// Surfaces under test:
//   - validateDsl: accepts conforming DSL, rejects unknown ops, rejects
//     malformed args, rejects compiled-rule constructs that violate the
//     C/Rust restriction (nested field-of-anything-but-input).
//   - interpretDsl: every documented op evaluates to the same value the
//     spec promises for a canonical input.
//   - emitJs: the generated `function generate(input, lib) { ... }` string
//     compiles and produces the same outputs as interpretDsl over the same
//     fixtures (round-trip safety; this is the property the artifact-runner
//     leans on).
//   - emitC + emitRust: source is non-empty, contains the documented entry
//     points (`kolm_run`, `pub fn run`), and references the helper symbols
//     the DSL uses. Source-hash stability proven by running emitCompiledTargets
//     twice and comparing the hashes.
//   - compileSpec end-to-end (compiled_rule): produces a zip containing
//     native.c + native.rs whose contents match manifest.compiled_targets
//     hashes; recipes.json carries the original dsl block; manifest carries
//     compiled_targets metadata with bytes/source_hash for c + rust.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import AdmZip from 'adm-zip';

import {
  validateDsl,
  interpretDsl,
  emitJs,
  emitC,
  emitRust,
  emitCompiledTargets,
  DSL_OPS,
  DSL_SPEC,
} from '../src/dsl.js';
import { compileSpec } from '../src/spec-compile.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wave144-dsl-'));
process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-wave144-dsl-test-secret';

function writeJsonl(name, rows) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function loadArtifact(zipPath) {
  const zip = new AdmZip(zipPath);
  const out = { entries: {} };
  for (const e of zip.getEntries()) out.entries[e.entryName] = e.getData();
  out.manifest = JSON.parse(out.entries['manifest.json'].toString('utf8'));
  out.recipes = JSON.parse(out.entries['recipes.json'].toString('utf8'));
  return out;
}

// ---------------------------------------------------------------------------
// validateDsl
// ---------------------------------------------------------------------------

test('validateDsl: accepts a minimal lookup recipe', () => {
  const dsl = {
    type: DSL_SPEC,
    output: {
      op: 'lookup',
      key: { op: 'input' },
      cases: { hello: 'hi', goodbye: 'bye' },
      default: 'unknown',
    },
  };
  assert.equal(validateDsl(dsl), true);
});

test('validateDsl: rejects unknown op', () => {
  assert.throws(
    () => validateDsl({ type: DSL_SPEC, output: { op: 'banana', arg: { op: 'input' } } }),
    /unknown op/,
  );
});

test('validateDsl: rejects bad type string', () => {
  assert.throws(
    () => validateDsl({ type: 'not-the-spec', output: { op: 'input' } }),
    /dsl\.type/,
  );
});

test('validateDsl: rejects keep_chars with bad set', () => {
  assert.throws(
    () => validateDsl({ type: DSL_SPEC, output: { op: 'keep_chars', arg: { op: 'input' }, set: 'banana' } }),
    /keep_chars\.set/,
  );
});

test('validateDsl: rejects replace with empty find', () => {
  assert.throws(
    () => validateDsl({ type: DSL_SPEC, output: { op: 'replace', arg: { op: 'input' }, find: '', replace: 'X' } }),
    /replace\.find must be non-empty/,
  );
});

test('validateDsl: rejects substr with negative start', () => {
  assert.throws(
    () => validateDsl({ type: DSL_SPEC, output: { op: 'substr', arg: { op: 'input' }, start: -1, length: 5 } }),
    /substr\.start/,
  );
});

test('validateDsl: rejects nested field-of-non-input under C/Rust targets', () => {
  const dsl = {
    type: DSL_SPEC,
    output: {
      op: 'field',
      from: { op: 'field', from: { op: 'input' }, key: 'inner' },
      key: 'leaf',
    },
  };
  // JS-only validation passes.
  assert.equal(validateDsl(dsl), true);
  // Compiled-rule (C/Rust) target rejects.
  assert.throws(
    () => validateDsl(dsl, { targets: ['c'] }),
    /compiled-rule.*field-of-input/i,
  );
  assert.throws(
    () => validateDsl(dsl, { targets: ['rust'] }),
    /compiled-rule.*field-of-input/i,
  );
});

test('DSL_OPS contains the documented op set', () => {
  for (const op of ['lit', 'input', 'field', 'concat', 'lower', 'upper', 'trim', 'replace',
    'contains', 'keep_chars', 'strip_chars', 'substr', 'eq', 'len', 'lookup', 'if', 'object']) {
    assert.ok(DSL_OPS.includes(op), `op ${op} missing from DSL_OPS`);
  }
});

// ---------------------------------------------------------------------------
// interpretDsl
// ---------------------------------------------------------------------------

test('interpretDsl: lit + input + field', () => {
  assert.equal(interpretDsl({ type: DSL_SPEC, output: { op: 'lit', value: 'hello' } }, 'ignored'), 'hello');
  assert.equal(interpretDsl({ type: DSL_SPEC, output: { op: 'input' } }, 'ping'), 'ping');
  assert.equal(
    interpretDsl({ type: DSL_SPEC, output: { op: 'field', from: { op: 'input' }, key: 'name' } }, { name: 'Ada' }),
    'Ada',
  );
});

test('interpretDsl: lower / upper / trim / len', () => {
  const lower = { type: DSL_SPEC, output: { op: 'lower', arg: { op: 'input' } } };
  assert.equal(interpretDsl(lower, 'HeLLo'), 'hello');
  const upper = { type: DSL_SPEC, output: { op: 'upper', arg: { op: 'input' } } };
  assert.equal(interpretDsl(upper, 'HeLLo'), 'HELLO');
  const trim = { type: DSL_SPEC, output: { op: 'trim', arg: { op: 'input' } } };
  assert.equal(interpretDsl(trim, '   spacey   '), 'spacey');
  const len = { type: DSL_SPEC, output: { op: 'len', arg: { op: 'input' } } };
  assert.equal(interpretDsl(len, 'abcd'), 4);
});

test('interpretDsl: replace + contains + concat', () => {
  const repl = { type: DSL_SPEC, output: { op: 'replace', arg: { op: 'input' }, find: 'foo', replace: 'bar' } };
  assert.equal(interpretDsl(repl, 'foo foo foo'), 'bar bar bar');
  const has = { type: DSL_SPEC, output: { op: 'contains', arg: { op: 'input' }, find: 'cat' } };
  assert.equal(interpretDsl(has, 'concatenate'), true);
  assert.equal(interpretDsl(has, 'dog'), false);
  const concat = { type: DSL_SPEC, output: { op: 'concat', parts: [{ op: 'lit', value: 'hi ' }, { op: 'input' }] } };
  assert.equal(interpretDsl(concat, 'Maria'), 'hi Maria');
});

test('interpretDsl: keep_chars / strip_chars / substr', () => {
  const digits = { type: DSL_SPEC, output: { op: 'keep_chars', arg: { op: 'input' }, set: 'digits' } };
  assert.equal(interpretDsl(digits, '(415) 555-1212'), '4155551212');
  const strip = { type: DSL_SPEC, output: { op: 'strip_chars', arg: { op: 'input' }, chars: ' -()' } };
  assert.equal(interpretDsl(strip, '(415) 555-1212'), '4155551212');
  const sub = { type: DSL_SPEC, output: { op: 'substr', arg: { op: 'input' }, start: 2, length: 3 } };
  assert.equal(interpretDsl(sub, 'abcdef'), 'cde');
});

test('interpretDsl: lookup + if + object + eq', () => {
  const dsl = {
    type: DSL_SPEC,
    output: {
      op: 'object',
      fields: {
        greet: {
          op: 'lookup',
          key: { op: 'input' },
          cases: { en: 'hello', zh: '你好', es: 'hola' },
          default: 'hi',
        },
        is_english: { op: 'eq', a: { op: 'input' }, b: { op: 'lit', value: 'en' } },
      },
    },
  };
  assert.deepEqual(interpretDsl(dsl, 'en'), { greet: 'hello', is_english: true });
  assert.deepEqual(interpretDsl(dsl, 'zh'), { greet: '你好', is_english: false });
  const ifDsl = {
    type: DSL_SPEC,
    output: {
      op: 'if',
      cond: { op: 'eq', a: { op: 'lower', arg: { op: 'input' } }, b: { op: 'lit', value: 'yes' } },
      then: { op: 'lit', value: 'AFFIRMATIVE' },
      else: { op: 'lit', value: 'NO' },
    },
  };
  assert.equal(interpretDsl(ifDsl, 'YES'), 'AFFIRMATIVE');
  assert.equal(interpretDsl(ifDsl, 'meh'), 'NO');
});

// ---------------------------------------------------------------------------
// emitJs round-trip
// ---------------------------------------------------------------------------

function runEmittedJs(src, input) {
  const wrapped = `(function() { ${src} ; return generate; })()`;
  const fn = vm.runInNewContext(wrapped);
  return fn(input, {});
}

test('emitJs: round-trip matches interpretDsl across fixtures', () => {
  const fixtures = [
    [{ type: DSL_SPEC, output: { op: 'input' } }, 'hello'],
    [
      {
        type: DSL_SPEC,
        output: {
          op: 'concat',
          parts: [{ op: 'lit', value: 'hi ' }, { op: 'upper', arg: { op: 'input' } }],
        },
      },
      'maria',
    ],
    [
      {
        type: DSL_SPEC,
        output: {
          op: 'lookup',
          key: { op: 'lower', arg: { op: 'input' } },
          cases: { en: 'hello', zh: '你好' },
          default: 'unknown',
        },
      },
      'EN',
    ],
    [
      {
        type: DSL_SPEC,
        output: {
          op: 'object',
          fields: {
            digits: { op: 'keep_chars', arg: { op: 'input' }, set: 'digits' },
            length: { op: 'len', arg: { op: 'input' } },
            trimmed: { op: 'trim', arg: { op: 'input' } },
          },
        },
      },
      '  (415) 555-1212  ',
    ],
  ];
  for (const [dsl, input] of fixtures) {
    const interp = interpretDsl(dsl, input);
    const emitted = runEmittedJs(emitJs(dsl), input);
    // The emitted JS runs inside a `vm.runInNewContext` realm; its Object
    // prototype is not the host realm's, so deepStrictEqual would reject
    // structurally-equal-but-cross-realm objects. Compare via JSON for value
    // equality.
    assert.equal(
      JSON.stringify(emitted),
      JSON.stringify(interp),
      `mismatch for ${JSON.stringify(dsl)} on ${JSON.stringify(input)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// emitC + emitRust shape
// ---------------------------------------------------------------------------

function zhGreeterDsl() {
  return {
    type: DSL_SPEC,
    output: {
      op: 'lookup',
      key: { op: 'lower', arg: { op: 'input' } },
      cases: { hello: '你好', goodbye: '再见', thanks: '谢谢' },
      default: '?',
    },
  };
}

test('emitC: emits self-contained C with kolm_run entry point', () => {
  const src = emitC(zhGreeterDsl(), { recipeName: 'rcp_zh_greeter' });
  assert.match(src, /char\* kolm_run\(const char\* input\)/);
  assert.match(src, /kolm_recipe_name/);
  assert.match(src, /kolm_recipe_spec/);
  assert.match(src, /k_lower/);
  assert.match(src, /strdup/);
  assert.ok(!src.includes('static_assert'), 'native.c must not use C11 static_assert in C99 codegen');
});

test('emitRust: emits self-contained Rust with pub fn run', () => {
  const src = emitRust(zhGreeterDsl(), { recipeName: 'rcp_zh_greeter' });
  assert.match(src, /pub fn run\(input: &str\) -> String/);
  assert.match(src, /pub fn recipe_name\(\) -> &'static str/);
  assert.match(src, /k_lower/);
  assert.match(src, /LOOKUP_/);
});

test('emitCompiledTargets: source_hashes match sha256 of source bytes', () => {
  const out = emitCompiledTargets(zhGreeterDsl(), { recipeName: 'rcp_zh_greeter' });
  const cHash = crypto.createHash('sha256').update(out.c.source).digest('hex');
  const rsHash = crypto.createHash('sha256').update(out.rust.source).digest('hex');
  assert.equal(out.c.source_hash, cHash);
  assert.equal(out.rust.source_hash, rsHash);
  // Deterministic on second call.
  const out2 = emitCompiledTargets(zhGreeterDsl(), { recipeName: 'rcp_zh_greeter' });
  assert.equal(out2.c.source_hash, out.c.source_hash);
  assert.equal(out2.rust.source_hash, out.rust.source_hash);
});

// ---------------------------------------------------------------------------
// end-to-end compileSpec with compiled_rule artifact_class
// ---------------------------------------------------------------------------

test('compileSpec: compiled_rule artifact ships native.c + native.rs whose contents match manifest hashes', async () => {
  const seedsPath = writeJsonl('compiled-e2e.jsonl', [
    { input: 'hello', output: '你好' },
    { input: 'goodbye', output: '再见' },
    { input: 'thanks', output: '谢谢' },
    { input: 'HELLO', output: '你好' },
    { input: 'Hello', output: '你好' },
    { input: 'GOODBYE', output: '再见' },
    { input: 'Goodbye', output: '再见' },
    { input: 'Thanks', output: '谢谢' },
    { input: 'THANKS', output: '谢谢' },
    { input: 'farewell', output: '?' },
    { input: 'hola', output: '?' },
    { input: 'foo', output: '?' },
  ]);
  const spec = {
    job_id: 'job_wave144_compiled_e2e',
    task: 'Wave 144 / F end-to-end compiled_rule smoke',
    base_model: 'none',
    artifact_class: 'compiled_rule',
    recipes: [
      {
        id: 'rcp_zh_greeter',
        name: 'ZH Greeter compiled',
        dsl: zhGreeterDsl(),
      },
    ],
  };
  const outPath = path.join(TMP, 'compiled-e2e.kolm');
  await compileSpec(spec, {
    seedsPath,
    comparator: 'exact',
    artifactClass: 'compiled_rule',
    outDir: TMP,
    outPath,
  });
  const art = loadArtifact(outPath);
  assert.equal(art.manifest.artifact_class, 'compiled_rule');
  assert.ok(art.manifest.compiled_targets, 'manifest.compiled_targets exists');
  assert.equal(art.manifest.compiled_targets.spec, DSL_SPEC);
  assert.equal(art.manifest.compiled_targets.single_recipe, true);
  const entry = art.manifest.compiled_targets.recipes['rcp_zh_greeter'];
  assert.ok(entry, 'rcp_zh_greeter entry present in compiled_targets');
  assert.equal(entry.c.filename, 'native.c');
  assert.equal(entry.rust.filename, 'native.rs');

  // native.c + native.rs must actually live inside the zip.
  const cBytes = art.entries['native.c'];
  const rsBytes = art.entries['native.rs'];
  assert.ok(cBytes && cBytes.length > 0, 'native.c present in zip');
  assert.ok(rsBytes && rsBytes.length > 0, 'native.rs present in zip');

  // Hashes recorded in the manifest must match the bytes on disk.
  const cHash = crypto.createHash('sha256').update(cBytes).digest('hex');
  const rsHash = crypto.createHash('sha256').update(rsBytes).digest('hex');
  assert.equal(cHash, entry.c.source_hash, 'native.c content hash matches manifest');
  assert.equal(rsHash, entry.rust.source_hash, 'native.rs content hash matches manifest');
  assert.equal(entry.c.bytes, cBytes.length, 'native.c bytes count matches manifest');
  assert.equal(entry.rust.bytes, rsBytes.length, 'native.rs bytes count matches manifest');

  // The verifier rebuilds compiled_targets from recipes.json.dsl. Confirm
  // every recipe in recipes.json carries its dsl block so this is feasible.
  const r = art.recipes.recipes[0];
  assert.equal(r.id, 'rcp_zh_greeter');
  assert.ok(r.dsl && r.dsl.type === DSL_SPEC, 'recipes.json carries dsl block');
});

test('compileSpec: compiled_rule rejects when no dsl is supplied', async () => {
  const seedsPath = writeJsonl('no-dsl.jsonl', [
    { input: 'hello', output: '你好' },
    { input: 'goodbye', output: '再见' },
    { input: 'thanks', output: '谢谢' },
    { input: 'farewell', output: '?' },
    { input: 'unknown', output: '?' },
  ]);
  const spec = {
    job_id: 'job_wave144_compiled_no_dsl',
    task: 'Wave 144 / F missing-dsl smoke',
    base_model: 'none',
    artifact_class: 'compiled_rule',
    recipes: [
      {
        id: 'rcp_e2e',
        name: 'JS-only recipe',
        source: 'function generate(input, lib) { return input; }',
      },
    ],
  };
  await assert.rejects(
    () => compileSpec(spec, {
      seedsPath,
      comparator: 'exact',
      artifactClass: 'compiled_rule',
      outDir: TMP,
      outPath: path.join(TMP, 'no-dsl.kolm'),
    }),
    /compiled_rule.*dsl/i,
  );
});

test('compileSpec: rule-class with dsl still ships and does NOT emit native sources', async () => {
  const seedsPath = writeJsonl('rule-with-dsl.jsonl', Array.from({ length: 20 }, (_, i) => ({
    input: 'hello', output: '你好',
  })));
  const spec = {
    job_id: 'job_wave144_rule_with_dsl',
    task: 'rule artifact authored via dsl',
    base_model: 'none',
    artifact_class: 'rule',
    recipes: [
      {
        id: 'rcp_zh_greeter_rule',
        name: 'rule-class greeter authored via dsl',
        dsl: zhGreeterDsl(),
      },
    ],
  };
  const outPath = path.join(TMP, 'rule-with-dsl.kolm');
  await compileSpec(spec, {
    seedsPath,
    comparator: 'exact',
    outDir: TMP,
    outPath,
  });
  const art = loadArtifact(outPath);
  assert.equal(art.manifest.artifact_class, 'rule');
  assert.equal(art.manifest.compiled_targets, null, 'rule class does NOT emit compiled_targets');
  assert.ok(!art.entries['native.c'], 'rule class does NOT ship native.c');
  assert.ok(!art.entries['native.rs'], 'rule class does NOT ship native.rs');
  // recipes.json still preserves dsl for downstream tooling.
  assert.ok(art.recipes.recipes[0].dsl, 'rule artifact authored from dsl still ships dsl in recipes.json');
});
