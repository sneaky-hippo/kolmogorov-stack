// W350 — when seeded compile fails, the probe artifact (temp .kolm used for
// K-score probing) must NOT leak.
//
// Trial bug: a user reported `<job_id>.kolm` files left behind in the build
// dir after a compile that errored on the K-score ship gate. Root cause:
// src/artifact.js::buildAndZip writes the probe zip to outPath in Pass 1,
// then overwrites it in Pass 2 — but if anything between the two passes
// throws (ship-gate, Rekor pin, auditor cross-check), the half-baked Pass 1
// zip stays on disk.
//
// Fix: src/artifact.js wraps the two passes in try/finally with a cleanup
// registry. src/spec-compile.js wraps the post-buildAndZip steps similarly so
// the user-supplied --out partial copy is also rolled back. This test forces
// a failure and asserts no orphan .kolm in the build dir or tmpdir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compileSpec } from '../src/spec-compile.js';
import { buildAndZip } from '../src/artifact.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w350-'));
}

function listKolmFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.kolm'));
}

test('W350 #1 — buildAndZip ship-gate throw leaves no probe .kolm behind', async () => {
  const out = tmpDir();
  // Construct an artifact whose K-score will fall below the gate. easiest
  // way: pass training_stats with accuracy = 0.0 and a tiny eval set so
  // computeKScore emits ships=false; the build then throws at line ~222.
  const baseArgs = {
    job_id: 'job_w350_ship_gate_fail',
    task: 'force ship-gate failure',
    base_model: 'none',
    recipes: [{
      id: 'rcp_w350_fail_v1', name: 'always wrong', version_id: 'ver_w350_fail_001', tags: [], schema: null, params: null, source_hash: 'deadbeef',
      source: "function generate(input, lib) { return { wrong: true }; }",
    }],
    evals: { spec: 'rs-1-evals', n: 1, cases: [{ id: 'e1', input: {}, expected: { right: true } }], coverage: 1.0 },
    training_stats: { pass_rate_positive: 0.0, latency_p50_us: 50 },
    outDir: out,
    artifact_class: 'rule',
    // allow_below_gate left FALSE so the ship-gate throws.
  };
  let threw = false;
  try {
    await buildAndZip(baseArgs);
  } catch (e) {
    threw = true;
    assert.match(e.message, /ship gate|k_score|below/i, `unexpected error: ${e.message}`);
  }
  assert.ok(threw, 'expected buildAndZip to throw on ship-gate fail');
  const leftover = listKolmFiles(out);
  assert.deepStrictEqual(leftover, [], `probe artifact leaked to ${out}: ${leftover.join(', ')}`);
  fs.rmSync(out, { recursive: true, force: true });
});

test('W350 #2 — compileSpec failure cleans both outDir and user --out partial copy', async () => {
  const out = tmpDir();
  const userOut = path.join(out, 'user-named.kolm');
  // Same ship-gate failure path via compileSpec.
  const SPEC = {
    job_id: 'job_w350_compilespec_fail',
    task: 'force gate failure via compileSpec',
    base_model: 'none',
    target_device: 'any',
    recipes: [{
      id: 'rcp_w350_cs_v1', name: 'wrong',
      schema: { input: { type: 'object' }, output: { type: 'object' } },
      source: "function generate(input, lib) { return { wrong: true }; }",
    }],
    evals: {
      spec: 'rs-1-evals', n: 1, coverage: 1.0,
      cases: [{ id: 'e1', input: { text: 'x' }, expected: { right: true } }],
    },
    training_stats: { pass_rate_positive: 0.0, latency_p50_us: 50 },
  };
  let threw = false;
  try {
    await compileSpec(SPEC, { outDir: out, outPath: userOut, allowSeedAutoResolve: false });
  } catch (e) {
    threw = true;
  }
  assert.ok(threw, 'expected compileSpec to throw on ship-gate fail');
  const leftover = listKolmFiles(out);
  assert.deepStrictEqual(leftover, [], `compileSpec leaked .kolm to outDir ${out}: ${leftover.join(', ')}`);
  assert.ok(!fs.existsSync(userOut), `user --out partial copy leaked at ${userOut}`);
  fs.rmSync(out, { recursive: true, force: true });
});

test('W350 #3 — successful compileSpec still produces an artifact (regression guard)', async () => {
  const out = tmpDir();
  const userOut = path.join(out, 'happy.kolm');
  const HAPPY = {
    job_id: 'job_w350_happy_v1',
    task: 'happy path; artifact must remain on disk',
    base_model: 'none',
    target_device: 'any',
    recipes: [{
      id: 'rcp_w350_hap_v1', name: 'greeter',
      schema: { input: { type: 'object', properties: { text: { type: 'string' } } }, output: { type: 'object' } },
      source: "function generate(input, lib) { return { is_greeting: /hi|hello/.test(String((input && input.text) || '')) }; }",
    }],
    evals: {
      spec: 'rs-1-evals', n: 4, coverage: 1.0,
      cases: [
        { id: 'e1', input: { text: 'hi' },         expected: { is_greeting: true  } },
        { id: 'e2', input: { text: 'hello' },      expected: { is_greeting: true  } },
        { id: 'e3', input: { text: 'goodbye' },    expected: { is_greeting: false } },
        { id: 'e4', input: { text: 'where' },      expected: { is_greeting: false } },
      ],
    },
    training_stats: { pass_rate_positive: 1.0, verifier_accepted: true, latency_p50_us: 40 },
  };
  const r = await compileSpec(HAPPY, { outDir: out, outPath: userOut, allowSeedAutoResolve: false, allow_below_gate: true });
  assert.ok(fs.existsSync(userOut), 'happy-path artifact must exist at user --out');
  assert.ok(r.bytes > 500, 'artifact too small to be real');
  fs.rmSync(out, { recursive: true, force: true });
});

test('W350 #4 — buildAndZip happy path keeps the artifact on disk', async () => {
  const out = tmpDir();
  const happyArgs = {
    job_id: 'job_w350_buildhappy_v1',
    task: 'happy',
    base_model: 'none',
    recipes: [{
      id: 'rcp_w350_bh_v1', name: 'ok', version_id: 'ver_w350_bh_001', tags: [], schema: null, params: null, source_hash: 'cafebabe',
      source: "function generate(input, lib) { return { ok: true }; }",
    }],
    evals: { spec: 'rs-1-evals', n: 1, cases: [{ id: 'e1', input: {}, expected: { ok: true } }], coverage: 1.0 },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 50, verifier_accepted: true },
    outDir: out,
    artifact_class: 'rule',
  };
  const r = await buildAndZip(happyArgs);
  assert.ok(fs.existsSync(r.outPath), 'happy-path artifact must remain on disk');
  fs.rmSync(out, { recursive: true, force: true });
});

test('W350 #5 — no kolm-probe-* style temp files leak under tmpdir on failure', async () => {
  // Audit: any temp file pattern that compileSpec might create under os.tmpdir().
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(f => /^kolm-/i.test(f) && f.endsWith('.kolm')));
  const out = tmpDir();
  const SPEC = {
    job_id: 'job_w350_audit_v1',
    task: 'tmpdir leak audit',
    base_model: 'none',
    target_device: 'any',
    recipes: [{
      id: 'rcp_w350_aud_v1', name: 'wrong',
      schema: { input: { type: 'object' }, output: { type: 'object' } },
      source: "function generate(input, lib) { return { wrong: true }; }",
    }],
    evals: { spec: 'rs-1-evals', n: 1, coverage: 1.0, cases: [{ id: 'e1', input: {}, expected: { right: true } }] },
    training_stats: { pass_rate_positive: 0.0, latency_p50_us: 50 },
  };
  try { await compileSpec(SPEC, { outDir: out, allowSeedAutoResolve: false }); } catch {}
  const after = new Set(fs.readdirSync(os.tmpdir()).filter(f => /^kolm-/i.test(f) && f.endsWith('.kolm')));
  // Any NEW .kolm under tmpdir matching kolm-* is a leak.
  const leaked = [...after].filter(f => !before.has(f));
  assert.deepStrictEqual(leaked, [], `leaked tmp .kolm files: ${leaked.join(', ')}`);
  fs.rmSync(out, { recursive: true, force: true });
});
