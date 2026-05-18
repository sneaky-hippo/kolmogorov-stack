// Wave 367 — `kolm build <name>` uses the curated recipe baseline when
// <name> matches an example shipped under examples/<slug>/.
//
// Behavior under test:
//   1. `kolm build claims-redactor --yes` (in a fresh cwd) writes a spec
//      that references the curated recipe.js and copies the curated
//      seeds.jsonl, then compiles to a .kolm that PASSES the K-score gate
//      (>= 0.85) and productionReady() ok=true. The pre-fix path produced
//      K=0.559 on the generic redactor stub — this test pins the curated
//      override.
//   2. The spec written to cwd carries `source_file` pointing at the curated
//      recipe (absolutized) and job_id keyed off the build name.
//   3. Backward compat: `kolm build my-redactor --from redactor --yes` does
//      NOT pick up the curated baseline (explicit --from wins) and falls
//      back to the generic stub path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');

function freshDir(label) {
  const d = path.join(os.tmpdir(), `kolm-w367-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function runBuild(cwd, args) {
  const env = { ...process.env, KOLM_AUTO_YES: '1' };
  // Strip ANTHROPIC_API_KEY so the synth path stays deterministic.
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  const r = spawnSync(process.execPath, [CLI, 'build', ...args], {
    cwd, env, encoding: 'utf8', timeout: 120_000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('W367 #1 — `kolm build claims-redactor` uses curated baseline and passes K gate', () => {
  const cwd = freshDir('curated');
  const r = runBuild(cwd, ['claims-redactor', '--yes']);
  const out = r.stdout + '\n' + r.stderr;

  assert.equal(r.code, 0, `expected exit 0, got ${r.code}. tail:\n${out.slice(-1500)}`);
  assert.ok(/template: curated \(examples\/claims-redactor\/\)/.test(out),
    `expected curated template banner, got tail:\n${out.slice(-800)}`);
  assert.ok(/production_ready: true/.test(out),
    `expected production_ready: true, got tail:\n${out.slice(-800)}`);

  // K-score line is "K-score for claims-redactor.kolm: 0.XYZ (gate ...)"
  const kMatch = out.match(/K-score for claims-redactor\.kolm:\s*([0-9.]+)/);
  assert.ok(kMatch, `expected K-score line, got tail:\n${out.slice(-800)}`);
  const k = Number(kMatch[1]);
  assert.ok(k >= 0.85, `K-score ${k} must clear ship gate 0.85`);
  // Honesty bar from the bug report: curated path should clear 0.95.
  assert.ok(k >= 0.95, `K-score ${k} must clear curated quality bar 0.95`);

  // The .kolm artifact lands in cwd.
  const artPath = path.join(cwd, 'claims-redactor.kolm');
  assert.ok(fs.existsSync(artPath), `artifact missing at ${artPath}`);
  assert.ok(fs.statSync(artPath).size > 1000, 'artifact byte size suspicious');
});

test('W367 #2 — curated spec references curated recipe.js by absolute path + tenant-scoped job_id', () => {
  const cwd = freshDir('spec-shape');
  const r = runBuild(cwd, ['claims-redactor', '--yes']);
  assert.equal(r.code, 0, `build exit ${r.code}. tail:\n${(r.stdout + r.stderr).slice(-800)}`);

  const specPath = path.join(cwd, 'claims-redactor.spec.json');
  assert.ok(fs.existsSync(specPath), `spec missing at ${specPath}`);
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  assert.equal(spec.job_id, 'job_claims_redactor_v1', 'job_id should template off build name');
  assert.ok(Array.isArray(spec.recipes) && spec.recipes.length >= 1, 'spec.recipes missing');
  const r0 = spec.recipes[0];
  assert.equal(typeof r0.source_file, 'string', 'recipe[0].source_file must be a string path');
  assert.ok(path.isAbsolute(r0.source_file), `source_file must be absolute, got ${r0.source_file}`);
  assert.ok(/recipe\.js$/.test(r0.source_file), `source_file should end in recipe.js, got ${r0.source_file}`);
  assert.ok(fs.existsSync(r0.source_file), `source_file should resolve to a file, got ${r0.source_file}`);
});

test('W367 #3 — `kolm build my-redactor --from redactor` keeps generic stub (no curated override)', () => {
  const cwd = freshDir('explicit-from');
  const r = runBuild(cwd, ['my-redactor', '--from', 'redactor', '--yes']);
  const out = r.stdout + '\n' + r.stderr;

  // Generic redactor stub yields K~0.56 on the 5 placeholder seeds, so the
  // build fails the gate — which is expected behavior for the generic path.
  // What we PIN here is: no "curated" banner appeared (so explicit --from
  // was honored).
  assert.ok(!/template: curated/.test(out),
    `explicit --from redactor must NOT pick curated, got tail:\n${out.slice(-800)}`);
  assert.ok(/template: redactor/.test(out),
    `expected generic redactor template banner, got tail:\n${out.slice(-800)}`);
});
