// Wave 144 — MoE composer tests.
//
// Builds tiny expert .kolm artifacts on-the-fly and confirms that:
//   - `composeMoe()` produces a valid composite .kolm
//   - The composite runs through the existing artifact-runner unchanged
//   - The router dispatches to the right expert per input
//   - Provenance (each expert's sha256 + recipe source hash) lives in
//     manifest.training.moe and can be re-read via readMoeBlock()
//   - Validation errors fire on bad router specs and missing experts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compileSpec } from '../src/spec-compile.js';
import { composeMoe, loadExperts, generateRouterSource, readMoeBlock } from '../src/moe.js';
import { runArtifact } from '../src/artifact-runner.js';

const SECRET = 'kolm-public-fixture-v0-1-0';

function withSecret(fn) {
  return async () => {
    const before = process.env.RECIPE_RECEIPT_SECRET;
    process.env.RECIPE_RECEIPT_SECRET = SECRET;
    try { return await fn(); }
    finally {
      if (before === undefined) delete process.env.RECIPE_RECEIPT_SECRET;
      else process.env.RECIPE_RECEIPT_SECRET = before;
    }
  };
}

async function buildExpert(dir, id, name, source, evalCases) {
  const spec = {
    job_id: `job_${id}`,
    task: `expert: ${name}`,
    base_model: 'none',
    recipes: [{
      id: `rcp_${id}`,
      name,
      schema: { input: { text: 'string' }, output: { type: 'object' } },
      source,
    }],
    evals: { spec: 'rs-1-evals', cases: evalCases, coverage: 1.0 },
  };
  const out = path.join(dir, `${id}.kolm`);
  await compileSpec(spec, { outPath: out, allowSeedAutoResolve: false });
  return out;
}

test('composeMoe: keyword router dispatches to the right expert per input', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-moe-'));
  try {
    const billingSource = `function generate(input, lib) {
      const t = (input && input.text) || String(input || '');
      return { kind: 'billing', text: t };
    }`;
    const shippingSource = `function generate(input, lib) {
      const t = (input && input.text) || String(input || '');
      return { kind: 'shipping', text: t };
    }`;
    const generalSource = `function generate(input, lib) {
      const t = (input && input.text) || String(input || '');
      return { kind: 'general', text: t };
    }`;
    const billingExpert = await buildExpert(dir, 'billing', 'billing', billingSource,
      [{ id: 'b1', input: { text: 'refund please' }, expected: { kind: 'billing', text: 'refund please' } }]);
    const shippingExpert = await buildExpert(dir, 'shipping', 'shipping', shippingSource,
      [{ id: 's1', input: { text: 'where is my order' }, expected: { kind: 'shipping', text: 'where is my order' } }]);
    const generalExpert = await buildExpert(dir, 'general', 'general', generalSource,
      [{ id: 'g1', input: { text: 'hello' }, expected: { kind: 'general', text: 'hello' } }]);

    const router = {
      type: 'keyword',
      rules: [
        { regex: '\\b(refund|cancel|billing)\\b', expert: 'rcp_billing' },
        { regex: '\\b(track|ship|deliver|order)\\b', expert: 'rcp_shipping' },
      ],
      default: 'rcp_general',
    };
    const out = path.join(dir, 'composite.kolm');
    const result = await composeMoe({
      experts: [billingExpert, shippingExpert, generalExpert],
      router, outPath: out,
    });
    assert.equal(result.outPath, out);
    assert.equal(result.moe.experts.length, 3);

    // Run against billing-flavored input → billing expert wins.
    const r1 = await runArtifact(out, { text: 'I want a refund' });
    assert.equal(r1.output.kind, 'billing');
    assert.equal(r1.output.__moe?.dispatched, 'rcp_billing');

    // Run against shipping-flavored input → shipping wins.
    const r2 = await runArtifact(out, { text: 'where is my order #1234' });
    assert.equal(r2.output.kind, 'shipping');
    assert.equal(r2.output.__moe?.dispatched, 'rcp_shipping');

    // Unmatched → default expert.
    const r3 = await runArtifact(out, { text: 'just saying hi' });
    assert.equal(r3.output.kind, 'general');
    assert.equal(r3.output.__moe?.dispatched, 'rcp_general');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('composeMoe: intent_field router dispatches via input.intent', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-moe-'));
  try {
    const aSrc = `function generate(input, lib) { return { from: 'a' }; }`;
    const bSrc = `function generate(input, lib) { return { from: 'b' }; }`;
    const aExpert = await buildExpert(dir, 'a', 'a', aSrc,
      [{ id: 'a1', input: { text: 'x' }, expected: { from: 'a' } }]);
    const bExpert = await buildExpert(dir, 'b', 'b', bSrc,
      [{ id: 'b1', input: { text: 'y' }, expected: { from: 'b' } }]);
    const out = path.join(dir, 'composite.kolm');
    await composeMoe({
      experts: [aExpert, bExpert],
      router: { type: 'intent_field', field: 'intent', default: 'rcp_a' },
      outPath: out,
    });
    const r1 = await runArtifact(out, { intent: 'rcp_a', text: 'x' });
    assert.equal(r1.output.from, 'a');
    assert.equal(r1.output.__moe?.dispatched, 'rcp_a');
    const r2 = await runArtifact(out, { intent: 'rcp_b', text: 'y' });
    assert.equal(r2.output.from, 'b');
    assert.equal(r2.output.__moe?.dispatched, 'rcp_b');
    const r3 = await runArtifact(out, { intent: 'missing', text: 'z' });
    assert.equal(r3.output.from, 'a', 'unknown intent falls back to default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('composeMoe: first_match router falls through expert errors', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-moe-'));
  try {
    const throwSrc = `function generate(input, lib) { throw new Error('not me'); }`;
    const okSrc = `function generate(input, lib) { return { picked: true }; }`;
    const a = await buildExpert(dir, 'thrower', 'thrower', throwSrc,
      [{ id: 't1', input: { text: 'x' }, expected: { picked: true } }]);
    const b = await buildExpert(dir, 'ok', 'ok', okSrc,
      [{ id: 'o1', input: { text: 'x' }, expected: { picked: true } }]);
    const out = path.join(dir, 'composite.kolm');
    await composeMoe({
      experts: [a, b],
      router: { type: 'first_match' },
      outPath: out,
    });
    const r = await runArtifact(out, { text: 'anything' });
    assert.equal(r.output.picked, true);
    assert.equal(r.output.__moe?.dispatched, 'rcp_ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('composeMoe: readMoeBlock recovers provenance from composite', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-moe-'));
  try {
    const src = `function generate(input, lib) { return { ok: true }; }`;
    const a = await buildExpert(dir, 'one', 'one', src,
      [{ id: 'o1', input: { text: 'x' }, expected: { ok: true } }]);
    const b = await buildExpert(dir, 'two', 'two', src,
      [{ id: 't1', input: { text: 'x' }, expected: { ok: true } }]);
    const out = path.join(dir, 'composite.kolm');
    await composeMoe({
      experts: [a, b],
      router: { type: 'first_match' },
      outPath: out,
    });
    const moe = readMoeBlock(out);
    assert.ok(moe, 'moe block present');
    assert.equal(moe.spec, 'kolm-moe-1');
    assert.equal(moe.experts.length, 2);
    assert.ok(/^[0-9a-f]{64}$/.test(moe.experts[0].artifact_sha256), 'sha256 of source artifact recorded');
    assert.ok(/^[0-9a-f]{64}$/.test(moe.experts[0].recipe_source_hash));
    assert.equal(moe.router.type, 'first_match');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('composeMoe: validation rejects single-expert composition', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-moe-'));
  try {
    const src = `function generate(input, lib) { return { ok: true }; }`;
    const a = await buildExpert(dir, 'only', 'only', src,
      [{ id: 'x', input: { text: 'x' }, expected: { ok: true } }]);
    await assert.rejects(
      () => composeMoe({ experts: [a], router: { type: 'first_match' }, outPath: path.join(dir, 'bad.kolm') }),
      /at least 2 experts/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('composeMoe: validation rejects keyword router referencing unknown expert', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-moe-'));
  try {
    const src = `function generate(input, lib) { return { ok: true }; }`;
    const a = await buildExpert(dir, 'a', 'a', src, [{ id: 'x', input: { text: 'x' }, expected: { ok: true } }]);
    const b = await buildExpert(dir, 'b', 'b', src, [{ id: 'y', input: { text: 'y' }, expected: { ok: true } }]);
    await assert.rejects(
      () => composeMoe({
        experts: [a, b],
        router: { type: 'keyword', rules: [{ regex: 'x', expert: 'rcp_notreal' }], default: 'rcp_a' },
        outPath: path.join(dir, 'bad.kolm'),
      }),
      /unknown expert/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('composeMoe: validation rejects invalid router type', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-moe-'));
  try {
    const src = `function generate(input, lib) { return { ok: true }; }`;
    const a = await buildExpert(dir, 'a', 'a', src, [{ id: 'x', input: { text: 'x' }, expected: { ok: true } }]);
    const b = await buildExpert(dir, 'b', 'b', src, [{ id: 'y', input: { text: 'y' }, expected: { ok: true } }]);
    await assert.rejects(
      () => composeMoe({
        experts: [a, b],
        router: { type: 'embedding' },
        outPath: path.join(dir, 'bad.kolm'),
      }),
      /router\.type must be one of/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('generateRouterSource: keyword router emits compilable JS with isolated expert scopes', () => {
  const experts = [
    { id: 'rcp_a', name: 'a', recipe_source: `function generate(input) { function pick() { return 'a'; } return { who: pick() }; }`, artifact_sha256: 'x', recipe_source_hash: 'x' },
    { id: 'rcp_b', name: 'b', recipe_source: `function generate(input) { function pick() { return 'b'; } return { who: pick() }; }`, artifact_sha256: 'x', recipe_source_hash: 'x' },
  ];
  const src = generateRouterSource(experts, {
    type: 'keyword',
    rules: [{ regex: 'foo', expert: 'rcp_a' }],
    default: 'rcp_b',
  });
  // The generated source must define a single top-level `generate` function.
  assert.match(src, /^function generate\(input, lib\)/);
  // Each expert lives inside its own IIFE so the `pick` helpers don't collide.
  assert.match(src, /const expert_rcp_a = \(function\(\) \{/);
  assert.match(src, /const expert_rcp_b = \(function\(\) \{/);
  // Sanity-check that the source actually compiles + runs.
  // eslint-disable-next-line no-new-func
  const fn = new Function('input', 'lib', `${src}\nreturn generate(input, lib);`);
  const r1 = fn({ text: 'foo bar' }, {});
  assert.equal(r1.who, 'a');
  assert.equal(r1.__moe.dispatched, 'rcp_a');
  const r2 = fn({ text: 'baz' }, {});
  assert.equal(r2.who, 'b');
  assert.equal(r2.__moe.dispatched, 'rcp_b');
});
