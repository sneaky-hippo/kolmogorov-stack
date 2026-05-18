// W241 — kolm bootstrap installer.
//
// Tests exercise behavior:
//  - scripts/install.sh exists, is executable, contains require_node check
//  - scripts/install.ps1 exists, contains Test-Node check
//  - cmdBootstrap registered in cli/kolm.js dispatch + completion + HELP
//  - kolm bootstrap --json runs end-to-end against a tmp KOLM_HOME,
//    writes manifest, creates expected dirs, persists a default profile
//  - --no-services and --no-doctor flags skip those steps
//  - re-running is idempotent (does not overwrite profile without --force)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');

function runCli(args, env = {}) {
  const res = child_process.spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', code: res.status };
}

test('W241 #1 — scripts/install.sh exists with require_node + clone logic', () => {
  const p = path.join(ROOT, 'scripts', 'install.sh');
  assert.ok(fs.existsSync(p), 'install.sh present');
  const txt = fs.readFileSync(p, 'utf8');
  assert.match(txt, /^#!\/usr\/bin\/env sh/, 'sh shebang');
  assert.match(txt, /require_node/, 'has require_node');
  assert.match(txt, /KOLM_INSTALL_DIR/, 'has KOLM_INSTALL_DIR env var');
  assert.match(txt, /git clone/, 'clones the repo');
  assert.match(txt, /KOLM_REQUIRE_NODE_MAJOR/, 'enforces node major');
});

test('W241 #2 — scripts/install.ps1 exists with Test-Node + Test-Git checks', () => {
  const p = path.join(ROOT, 'scripts', 'install.ps1');
  assert.ok(fs.existsSync(p), 'install.ps1 present');
  const txt = fs.readFileSync(p, 'utf8');
  assert.match(txt, /Test-Node/, 'has Test-Node');
  assert.match(txt, /Test-Git/, 'has Test-Git');
  assert.match(txt, /KolmInstallDir/, 'has KolmInstallDir');
  assert.match(txt, /kolm\.cmd/, 'writes cmd shim');
  assert.match(txt, /kolm\.ps1/, 'writes ps1 shim');
});

test('W241 #3 — cli/kolm.js wires bootstrap dispatch + completion + HELP', () => {
  const txt = fs.readFileSync(CLI, 'utf8');
  assert.match(txt, /case 'bootstrap':\s*await withErrorContext/, 'dispatch case wired');
  assert.match(txt, /'services',\s*'bootstrap'/, 'in COMPLETION_VERBS array');
  assert.match(txt, /bootstrap:\s*`kolm bootstrap - one-shot post-install setup/, 'HELP.bootstrap present');
  assert.match(txt, /async function cmdBootstrap/, 'cmdBootstrap function defined');
});

test('W241 #4 — kolm bootstrap --help prints usage and exits 0', () => {
  const r = runCli(['bootstrap', '--help']);
  assert.equal(r.code, 0, 'help exits 0');
  assert.match(r.stdout, /kolm bootstrap/, 'prints help heading');
  assert.match(r.stdout, /--no-services/, 'lists --no-services flag');
  assert.match(r.stdout, /--no-doctor/, 'lists --no-doctor flag');
});

test('W241 #5 — kolm bootstrap --json --no-services --no-doctor creates dirs + profile + manifest', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w241-'));
  const env = { USERPROFILE: tmpHome, HOME: tmpHome };
  const r = runCli(['bootstrap', '--json', '--no-services', '--no-doctor'], env);
  // Even if doctor step is skipped, manifest write should succeed.
  if (r.code !== 0) {
    // Surface stderr for debugging.
    throw new Error(`bootstrap exited ${r.code}: ${r.stderr || r.stdout}`);
  }
  // Manifest written.
  const manifestPath = path.join(tmpHome, '.kolm', 'state', 'bootstrap.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest written');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.version, 'w241-bootstrap-1.0.0', 'manifest version slug');
  assert.equal(manifest.profile, 'default', 'default profile');
  assert.ok(Array.isArray(manifest.steps) && manifest.steps.length >= 4, '4+ steps recorded');
  const stepNames = manifest.steps.map((s) => s.name);
  assert.ok(stepNames.includes('dirs'), 'dirs step present');
  assert.ok(stepNames.includes('runtime'), 'runtime step present');
  assert.ok(stepNames.includes('profile'), 'profile step present');
  // services step skipped via --no-services -> status=skip
  const svc = manifest.steps.find((s) => s.name === 'services');
  assert.equal(svc.status, 'skip', 'services skipped');
  // Profile file exists.
  const profPath = path.join(tmpHome, '.kolm', 'profiles', 'default.json');
  assert.ok(fs.existsSync(profPath), 'default profile written');
  const prof = JSON.parse(fs.readFileSync(profPath, 'utf8'));
  assert.equal(prof.name, 'default');
  assert.equal(prof.services.redactor.port, 7401);
  assert.equal(prof.services.compiler.port, 7402);
  assert.equal(prof.services.proxy.port, 7403);
});

test('W241 #6 — re-running bootstrap is idempotent (skips existing profile without --force)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w241-'));
  const env = { USERPROFILE: tmpHome, HOME: tmpHome };
  const r1 = runCli(['bootstrap', '--json', '--no-services', '--no-doctor'], env);
  assert.equal(r1.code, 0, 'first run ok');
  const m1 = JSON.parse(fs.readFileSync(path.join(tmpHome, '.kolm', 'state', 'bootstrap.json'), 'utf8'));
  const prof1 = m1.steps.find((s) => s.name === 'profile');
  assert.equal(prof1.status, 'ok', 'first run writes profile');

  const r2 = runCli(['bootstrap', '--json', '--no-services', '--no-doctor'], env);
  assert.equal(r2.code, 0, 'second run ok');
  const m2 = JSON.parse(fs.readFileSync(path.join(tmpHome, '.kolm', 'state', 'bootstrap.json'), 'utf8'));
  const prof2 = m2.steps.find((s) => s.name === 'profile');
  assert.equal(prof2.status, 'skip', 'second run skips profile (idempotent)');
});

test('W241 #7 — --profile=team-a writes team-a.json not default.json', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w241-'));
  const env = { USERPROFILE: tmpHome, HOME: tmpHome };
  const r = runCli(['bootstrap', '--json', '--no-services', '--no-doctor', '--profile', 'team-a'], env);
  assert.equal(r.code, 0);
  const teamA = path.join(tmpHome, '.kolm', 'profiles', 'team-a.json');
  const defP = path.join(tmpHome, '.kolm', 'profiles', 'default.json');
  assert.ok(fs.existsSync(teamA), 'team-a.json written');
  assert.ok(!fs.existsSync(defP), 'default.json not written');
  const prof = JSON.parse(fs.readFileSync(teamA, 'utf8'));
  assert.equal(prof.name, 'team-a');
});

test('W241 #8 — install.sh and install.ps1 advertise the same KOLM_REQUIRE_NODE_MAJOR default', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8');
  const ps = fs.readFileSync(path.join(ROOT, 'scripts', 'install.ps1'), 'utf8');
  // sh default is :-20, ps default is else { 20 }
  assert.match(sh, /KOLM_REQUIRE_NODE_MAJOR:-20/, 'sh defaults to 20');
  assert.match(ps, /KolmRequireNode.*else \{ 20 \}/, 'ps1 defaults to 20');
});

test('W241 #9 — bootstrap manifest captures platform + node version for audit', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w241-'));
  const env = { USERPROFILE: tmpHome, HOME: tmpHome };
  const r = runCli(['bootstrap', '--json', '--no-services', '--no-doctor'], env);
  assert.equal(r.code, 0);
  const m = JSON.parse(fs.readFileSync(path.join(tmpHome, '.kolm', 'state', 'bootstrap.json'), 'utf8'));
  assert.match(m.platform, /^(win32|darwin|linux)\/(x64|arm64|x32)$/, 'platform format');
  assert.match(m.node, /^\d+\.\d+\.\d+/, 'node semver');
  assert.match(m.at, /^\d{4}-\d{2}-\d{2}T/, 'iso timestamp');
});

test('W241 #10 — bootstrap creates all expected ~/.kolm subdirectories', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w241-'));
  const env = { USERPROFILE: tmpHome, HOME: tmpHome };
  const r = runCli(['bootstrap', '--json', '--no-services', '--no-doctor'], env);
  assert.equal(r.code, 0);
  for (const sub of ['captures', 'services', 'service-logs', 'state', 'profiles', 'recipes', 'artifacts']) {
    const p = path.join(tmpHome, '.kolm', sub);
    assert.ok(fs.existsSync(p), `${sub} dir created`);
  }
});
