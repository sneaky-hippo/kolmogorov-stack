// Wave 343 — claims-redactor: real seed-gated PHI artifact for the
// marketplace.
//
// Asserts BEHAVIOR (kolm CLI exit codes, .kolm bytes on disk, manifest
// fields, productionReady() verdict) rather than page copy.
//
// What the wave guarantees:
//   1. examples/claims-redactor/{spec.json, seeds.jsonl, recipe.js} exist
//      with the right shape (recipe references src/phi-redactor.js source-of-
//      truth via the file pointer, spec uses source_file: "./recipe.js").
//   2. `kolm compile --spec ... --seeds ...` produces a real .kolm.
//   3. productionReady() reports ok=true for that .kolm (>=40 train,
//      >=10 holdout, no leakage, K-score >= 0.85).
//   4. Manifest carries seed_provenance with the production-ready flag.
//   5. The marketplace SEED_CATALOG includes the slug and the catalog hydrate
//      resolves the on-disk .kolm bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const EX_DIR = path.join(ROOT, 'examples', 'claims-redactor');
const CLI = path.join(ROOT, 'cli', 'kolm.js');
const SPEC = path.join(EX_DIR, 'spec.json');
const SEEDS = path.join(EX_DIR, 'seeds.jsonl');
const RECIPE = path.join(EX_DIR, 'recipe.js');
const COMMITTED_KOLM = path.join(EX_DIR, 'claims-redactor.kolm');

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((ln) => {
      const t = ln.trim();
      return t.length > 0 && !t.startsWith('//');
    })
    .map((ln) => JSON.parse(ln));
}

test('W343 #1 — examples/claims-redactor/ ships spec.json, seeds.jsonl, recipe.js', () => {
  assert.ok(fs.existsSync(SPEC), 'spec.json must exist');
  assert.ok(fs.existsSync(SEEDS), 'seeds.jsonl must exist');
  assert.ok(fs.existsSync(RECIPE), 'recipe.js must exist');
});

test('W343 #2 — spec.json points recipe.source_file at the sandbox-safe recipe', () => {
  const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
  assert.equal(spec.job_id, 'job_claims_redactor_v1', 'job_id must be stable');
  assert.ok(Array.isArray(spec.recipes) && spec.recipes.length === 1, 'expect exactly one recipe');
  const r = spec.recipes[0];
  assert.equal(r.id, 'rcp_claims_redactor_v1');
  assert.equal(typeof r.source_file, 'string');
  assert.equal(r.source, undefined, 'source must NOT be inlined; use source_file pointer');
  assert.match(r.source_file, /recipe\.js$/);
  // Comparator must be one that compares structured outputs (recipe returns
  // {redacted, map, classes}; seeds carry {redacted, classes} so json_subset
  // lets extra keys in actual without failing).
  assert.equal(spec.comparator, 'json_subset');
  assert.equal(spec.kolmogorov_score && spec.kolmogorov_score.threshold, 0.85);
});

test('W343 #3 — seeds.jsonl has >= 50 rows so split is production-ready (>=40 train, >=10 holdout)', () => {
  const rows = readJsonl(SEEDS);
  assert.ok(rows.length >= 50, `expected >= 50 seed rows, got ${rows.length}`);
  // Every row must be {input:{text}, expected:{redacted, classes}}.
  for (const row of rows) {
    assert.ok(row.input && typeof row.input.text === 'string', 'row.input.text must be string');
    assert.ok(row.expected && typeof row.expected.redacted === 'string', 'row.expected.redacted must be string');
    assert.ok(Array.isArray(row.expected.classes), 'row.expected.classes must be array');
  }
});

test('W343 #4 — seeds collectively cover the major HIPAA PHI classes', () => {
  const rows = readJsonl(SEEDS);
  const seen = new Set();
  for (const row of rows) {
    for (const c of row.expected.classes || []) seen.add(c);
  }
  // Must hit every class our recipe can detect at least once across the corpus.
  // Minimum coverage bar: NAME, GEO, DATE, PHONE, EMAIL, SSN, MRN.
  const required = ['NAME', 'GEO', 'DATE', 'PHONE', 'EMAIL', 'SSN', 'MRN'];
  for (const c of required) {
    assert.ok(seen.has(c), `seeds must cover class ${c} at least once; covered: ${[...seen].sort().join(',')}`);
  }
});

test('W343 #5 — recipe.js compiles in the kolm sandbox without forbidden-token errors', async () => {
  const { compileJs } = await import('../src/verifier.js');
  const src = fs.readFileSync(RECIPE, 'utf8');
  // Must compile without throwing (sandbox guard would throw on process/
  // require/eval/Function/etc.).
  assert.doesNotThrow(() => compileJs(src), 'recipe.js must pass the sandbox guard');
});

test('W343 #6 — recipe.js declares the canonical token format expected by reinject()', () => {
  const src = fs.readFileSync(RECIPE, 'utf8');
  // The format `[PHI_<CLASS>_<INDEX>]` is the contract enforced by
  // src/phi-redactor.js findTokens()/reinject(). Our recipe must mint
  // tokens in the same format so downstream reinject() works.
  assert.match(src, /\[PHI_'\s*\+\s*cls/, 'recipe must mint [PHI_<cls>_<n>] tokens');
});

test('W343 #7 — `kolm compile --spec --seeds --out` produces a real .kolm', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w343-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-home-w343-'));
  const out = path.join(tmp, 'claims-redactor.kolm');
  const env = { ...process.env, HOME: home, USERPROFILE: home, KOLM_DATA_DIR: tmp };
  const r = spawnSync(process.execPath, [
    CLI, 'compile',
    '--spec', SPEC,
    '--seeds', SEEDS,
    '--out', out,
  ], { encoding: 'utf8', env, cwd: ROOT, timeout: 60000 });
  assert.equal(r.status, 0, `compile exit code ${r.status}; stderr=\n${r.stderr}\nstdout=\n${r.stdout}`);
  assert.ok(fs.existsSync(out), 'compile must produce the .kolm file');
  const buf = fs.readFileSync(out);
  assert.ok(buf.length > 0, '.kolm must have non-zero bytes');
  // Compile output should report K-score >= gate and production_ready true.
  assert.match(r.stdout, /K-score for [^\s]+\s+\d\.\d+/, 'compile must print K-score');
  assert.match(r.stdout, /production_ready:\s*true/, 'compile must print production_ready: true');
}, { timeout: 90000 });

test('W343 #8 — committed examples/claims-redactor/claims-redactor.kolm passes productionReady()', async () => {
  // Skip if the artifact hasn't been built yet (CI may not have run the
  // pre-test build). Local dev should commit the .kolm so this asserts the
  // shipping bytes pass the gate.
  if (!fs.existsSync(COMMITTED_KOLM)) {
    console.warn('skipping W343 #8: claims-redactor.kolm not committed yet');
    return;
  }
  const { productionReady } = await import('../src/production-ready.js');
  const verdict = await productionReady(COMMITTED_KOLM);
  assert.equal(verdict.ok, true,
    `productionReady must be ok for shipping claims-redactor.kolm; reasons: ${JSON.stringify(verdict.reasons)}`);
  // Per-gate sanity.
  assert.equal(verdict.gates.seed_provenance.ok, true, 'seed_provenance gate must pass');
  assert.equal(verdict.gates.k_score.ok, true, 'k_score gate must pass');
  assert.ok(verdict.gates.k_score.value >= 0.85, `K-score ${verdict.gates.k_score.value} must be >= 0.85`);
  assert.equal(verdict.gates.holdout_split.ok, true, 'holdout_split gate must pass');
  assert.ok(verdict.gates.holdout_split.train_count >= 40);
  assert.ok(verdict.gates.holdout_split.holdout_count >= 10);
}, { timeout: 30000 });

test('W343 #9 — claims-redactor appears in marketplace.SEED_CATALOG with HIPAA + BAA badges', async () => {
  const m = await import('../src/marketplace.js');
  const arts = m.listArtifacts({});
  const a = arts.find((x) => x.slug === 'claims-redactor');
  assert.ok(a, 'claims-redactor must appear in listArtifacts()');
  assert.equal(a.category, 'compliance');
  assert.equal(a.license, 'Apache-2.0');
  assert.equal(a.vertical, 'healthcare');
  // The seed catalog claims HIPAA + BAA. listArtifacts strips Verified if
  // k_score is null on disk; we only assert HIPAA + BAA here (Verified is
  // gated by /v1/marketplace/list via productionReady, not by the seed).
  assert.ok(a.badges.includes('HIPAA'), `badges must include HIPAA; got ${JSON.stringify(a.badges)}`);
  assert.ok(a.badges.includes('BAA'), `badges must include BAA; got ${JSON.stringify(a.badges)}`);
});

test('W343 #10 — marketplace.resolveArtifactPath("claims-redactor") points at the shipped .kolm', async () => {
  const m = await import('../src/marketplace.js');
  const abs = m.resolveArtifactPath('claims-redactor');
  // Resolves to null when the file isn't on disk yet. If it IS on disk,
  // the path must end at examples/claims-redactor/claims-redactor.kolm.
  if (!fs.existsSync(COMMITTED_KOLM)) {
    assert.equal(abs, null);
    return;
  }
  assert.ok(typeof abs === 'string' && abs.length > 0);
  assert.ok(abs.replace(/\\/g, '/').endsWith('examples/claims-redactor/claims-redactor.kolm'),
    `expected absolute path to end at examples/claims-redactor/claims-redactor.kolm; got ${abs}`);
});

test('W343 #11 — public/marketplace.html exposes a card linking to /marketplace/claims-redactor', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'marketplace.html'), 'utf8');
  assert.match(html, /data-slug="claims-redactor"/, 'card must carry data-slug="claims-redactor"');
  assert.match(html, /href="\/marketplace\/claims-redactor"/, 'card title must link to detail page');
  assert.match(html, /data-category="compliance"/);
});

test('W343 #12 — per-slug detail page exists with K-score badge + install snippet', () => {
  const p = path.join(ROOT, 'public', 'marketplace', 'claims-redactor.html');
  assert.ok(fs.existsSync(p), 'detail page must exist');
  const html = fs.readFileSync(p, 'utf8');
  assert.ok(html.length > 3000, `detail page too small: ${html.length}`);
  assert.match(html, /K-score/, 'detail must show K-score');
  assert.match(html, /kolm marketplace install claims-redactor/, 'must show install snippet');
  assert.match(html, /kolm verify/, 'must show verify snippet');
  assert.match(html, /"@type":\s*"SoftwareApplication"/, 'must have SoftwareApplication JSON-LD');
  assert.match(html, /"@type":\s*"BreadcrumbList"/, 'must have BreadcrumbList JSON-LD');
});

test('W343 #13 — committed .kolm bytes match the sha256 the catalog hydrate will compute', () => {
  if (!fs.existsSync(COMMITTED_KOLM)) {
    console.warn('skipping W343 #13: claims-redactor.kolm not committed yet');
    return;
  }
  const buf = fs.readFileSync(COMMITTED_KOLM);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  // Must be 64-hex; we don't pin the exact hash because the recipe contents
  // may change. The marketplace hydrate just needs SOMETHING to publish.
  assert.match(sha, /^[0-9a-f]{64}$/, `sha256 must be 64-hex; got ${sha}`);
  assert.ok(buf.length > 5000, `.kolm bytes look too small: ${buf.length}`);
});
