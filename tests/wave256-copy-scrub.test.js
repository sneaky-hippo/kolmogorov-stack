// W256 — copy-scrub + verb-wire lockdown.
// Asserts that:
//   * the hedge markers we removed do not creep back in
//   * the verbs the docs now claim are actually dispatched in cli/kolm.js
//   * kolm extract --target=<entry> handles .kolm archives
//   * kolm migrate writes a v2-stamped spec
//   * the /v1/nl/scaffold server route exists with the same shape
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');
const PUBLIC = path.join(ROOT, 'public');

function readPage(rel) { return fs.readFileSync(path.join(PUBLIC, rel), 'utf8'); }
function readSrc(rel)  { return fs.readFileSync(path.join(ROOT, rel),  'utf8'); }

test('W256 #1 - migrate.html drops "verify before ship" disclosure', () => {
  const body = readPage('migrate.html');
  assert.doesNotMatch(body, /verify before ship/i);
  assert.doesNotMatch(body, /not yet wired/i);
});

test('W256 #2 - public/format/v2.html drops all hedge pills', () => {
  const body = readPage('format/v2.html');
  assert.doesNotMatch(body, /verify before ship/i);
  assert.doesNotMatch(body, /not yet wired/i);
});

test('W256 #3 - migrate/*.html drops "today: jq|unzip" hedge', () => {
  for (const f of ['predibase.html', 'openpipe.html', 'lorax.html', 'diy.html']) {
    const body = readPage(`migrate/${f}`);
    assert.doesNotMatch(body, /verify before ship/i, `${f} still hedges`);
    assert.doesNotMatch(body, /today: (jq|unzip)/, `${f} still says "today: jq|unzip"`);
  }
});

test('W256 #4 - public/quickstart/nl.html drops NOT YET WIRED', () => {
  const body = readPage('quickstart/nl.html');
  assert.doesNotMatch(body, /NOT YET WIRED/);
  assert.doesNotMatch(body, /not yet wired/);
  assert.match(body, /--network/);
});

test('W256 #5 - public/docs/cli/nl.md describes --network', () => {
  const body = fs.readFileSync(path.join(PUBLIC, 'docs', 'cli', 'nl.md'), 'utf8');
  assert.doesNotMatch(body, /not yet wired/i);
  assert.match(body, /--network/);
});

test('W256 #6 - cli/kolm.js dispatches kolm migrate / wrap / import', () => {
  const cli = readSrc('cli/kolm.js');
  assert.match(cli, /case 'migrate':\s+await withErrorContext\('migrate'/);
  assert.match(cli, /case 'wrap':\s+await withErrorContext\('wrap'/);
  assert.match(cli, /case 'import':\s*\n\s*case 'import-chat'/);
});

test('W256 #7 - cli/kolm.js dispatches --gate-cve-policy / --k-min / --gate-stability', () => {
  const cli = readSrc('cli/kolm.js');
  assert.match(cli, /--gate-cve-policy/);
  assert.match(cli, /--gate-stability/);
  assert.match(cli, /--gate-latency-budget/);
  assert.match(cli, /--k-min/);
});

test('W256 #8 - cli/kolm.js wires kolm nl --network', () => {
  const cli = readSrc('cli/kolm.js');
  assert.match(cli, /args\.includes\('--network'\)/);
  assert.match(cli, /\/v1\/nl\/scaffold/);
});

test('W256 #9 - src/router.js exposes /v1/nl/scaffold', () => {
  const r = readSrc('src/router.js');
  assert.match(r, /\/v1\/nl\/scaffold/);
  assert.match(r, /x-kolm-nl-source/);
});

test('W256 #10 - kolm migrate produces v2-stamped spec', () => {
  const tmp  = path.join(ROOT, '.tmp-w256');
  fs.mkdirSync(tmp, { recursive: true });
  const inp  = path.join(tmp, 'legacy.kolm.spec.json');
  const out  = path.join(tmp, 'legacy.v2.kolm.spec.json');
  fs.writeFileSync(inp, JSON.stringify({ spec: { schema: 'rs-1', version: '1.0', name: 'acme' } }));
  const res = spawnSync(process.execPath, [CLI, 'migrate', inp, '--out', out],
    { encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(res.status, 0, `stderr=${res.stderr}`);
  const out_spec = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(out_spec.version, '2.0');
  assert.strictEqual(out_spec.schema, 'rs-1');
  assert.ok(out_spec.migrated_from?.sha256);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('W256 #11 - kolm wrap detects axolotl backend from JSON config', () => {
  const tmp = path.join(ROOT, '.tmp-w256-wrap');
  fs.mkdirSync(tmp, { recursive: true });
  const cfg = path.join(tmp, 'axolotl.json');
  const out = path.join(tmp, 'axolotl.kolm.spec.json');
  fs.writeFileSync(cfg, JSON.stringify({ adapter: 'lora', base_model: 'Qwen/Qwen2.5-1.5B' }));
  const res = spawnSync(process.execPath, [CLI, 'wrap', cfg, '--out', out],
    { encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(res.status, 0, `stderr=${res.stderr}`);
  const w = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(w.wrap.backend, 'axolotl');
  assert.ok(w.wrap.source_hash);
  assert.strictEqual(w.spec_class, 'wrap');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('W256 #12 - kolm extract --target reads from a .kolm archive', async () => {
  const AdmZip = (await import('adm-zip')).default;
  const tmp = path.join(ROOT, '.tmp-w256-extract');
  fs.mkdirSync(tmp, { recursive: true });
  const kolm = path.join(tmp, 'sample.kolm');
  const zip = new AdmZip();
  zip.addFile('training-config.yaml', Buffer.from('model: qwen\nlr: 1e-4\n'));
  zip.addFile('manifest.json', Buffer.from('{"name":"sample"}'));
  zip.writeZip(kolm);
  const out = path.join(tmp, 'train.yaml');
  const res = spawnSync(process.execPath, [CLI, 'extract', kolm, '--target=training-config', '--out', out],
    { encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(res.status, 0, `stderr=${res.stderr}`);
  assert.match(fs.readFileSync(out, 'utf8'), /lr: 1e-4/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('W256 #13 - completion verbs include migrate/wrap/import', () => {
  const cli = readSrc('cli/kolm.js');
  assert.match(cli, /'migrate'/);
  assert.match(cli, /'wrap'/);
  // 'import' should be a top-level alias for import-chat
  assert.match(cli, /'import'.*'wrap'.*'migrate'/);
});

test('W256 #14 - kolm nl air-gap path still produces a recipe scaffold', () => {
  const res = spawnSync(process.execPath, [CLI, 'nl', 'redact PHI from clinical notes', '--no-network', '--json'],
    { encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(res.status, 0, `stderr=${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.ok(out.recipe_class);
  assert.ok(out.suggested_k_score_gate);
});

test('W256 #15 - training/data-sources.html re-labels hedge to "legal review"', () => {
  const body = readPage('training/data-sources.html');
  assert.doesNotMatch(body, /pill warn">verify before ship/);
  assert.match(body, /pill warn">legal review/);
});

test('W256 #16 - cve-in-kscore.html drops "verify before ship" hedge', () => {
  const body = readPage('docs/cve-in-kscore.html');
  assert.doesNotMatch(body, /verify before ship/i);
});

test('W256 #17 - k-score-methodology.html drops the amber hedge on flags', () => {
  const body = readPage('docs/k-score-methodology.html');
  assert.doesNotMatch(body, /verify before ship: run.*kolm compile --help/i);
});
