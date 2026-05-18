// W249 — cross-platform install + bootstrap validation.
// Assert install.sh (POSIX) and install.ps1 (Windows) are intact, post-W254
// rename targets are correct, and bootstrap reports the running platform.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SH = path.join(ROOT, 'scripts', 'install.sh');
const PS1 = path.join(ROOT, 'scripts', 'install.ps1');

test('W249 #1 - install.sh exists and is non-empty', () => {
  assert.ok(fs.existsSync(SH), 'install.sh missing');
  assert.ok(fs.statSync(SH).size > 1000, 'install.sh too small');
});

test('W249 #2 - install.ps1 exists and is non-empty', () => {
  assert.ok(fs.existsSync(PS1), 'install.ps1 missing');
  assert.ok(fs.statSync(PS1).size > 1000, 'install.ps1 too small');
});

test('W249 #3 - install.sh repo URL is kolm-stack (post-W254)', () => {
  const body = fs.readFileSync(SH, 'utf8');
  assert.match(body, /github\.com\/sneaky-hippo\/kolm-stack\.git/);
  assert.doesNotMatch(body, /kolmogorov-stack/);
  assert.doesNotMatch(body, /Kolmogorov/);
});

test('W249 #4 - install.ps1 repo URL is kolm-stack (post-W254)', () => {
  const body = fs.readFileSync(PS1, 'utf8');
  assert.match(body, /github\.com\/sneaky-hippo\/kolm-stack\.git/);
  assert.doesNotMatch(body, /kolmogorov-stack/);
  assert.doesNotMatch(body, /Kolmogorov/);
});

test('W249 #5 - install.sh detects macOS, Linux, WSL via uname', () => {
  const body = fs.readFileSync(SH, 'utf8');
  assert.match(body, /Darwin\) echo "macos"/);
  assert.match(body, /Linux\)\s+echo "linux"/);
  assert.match(body, /MINGW|MSYS|CYGWIN/);
});

test('W249 #6 - install.sh detects x86_64 + arm64', () => {
  const body = fs.readFileSync(SH, 'utf8');
  assert.match(body, /x86_64\|amd64/);
  assert.match(body, /arm64\|aarch64/);
});

test('W249 #7 - install.sh requires node >= 20', () => {
  const body = fs.readFileSync(SH, 'utf8');
  assert.match(body, /KOLM_REQUIRE_NODE_MAJOR:-20/);
});

test('W249 #8 - install.ps1 requires node >= 20', () => {
  const body = fs.readFileSync(PS1, 'utf8');
  assert.match(body, /20/);
  assert.match(body, /KOLM_REQUIRE_NODE_MAJOR/);
});

test('W249 #9 - install.ps1 writes .cmd shim and .ps1 shim', () => {
  const body = fs.readFileSync(PS1, 'utf8');
  assert.match(body, /kolm\.cmd/);
  assert.match(body, /kolm\.ps1/);
});

test('W249 #10 - cli/kolm.js uses cross-platform home detection', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.match(cli, /USERPROFILE|os\.homedir/);
});

test('W249 #11 - cli/kolm.js uses path.join heavily', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'kolm.js'), 'utf8');
  const joinUses = (cli.match(/path\.join\(/g) || []).length;
  assert.ok(joinUses > 50, `path.join uses too low: ${joinUses}`);
});

test('W249 #12 - kolm bootstrap reports current platform', () => {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'kolm.js'),
    'bootstrap', '--no-services', '--no-doctor', '--json'],
    { encoding: 'utf8', timeout: 15000 });
  assert.ok(out.stdout, `no stdout; stderr=${out.stderr}`);
  const m = JSON.parse(out.stdout);
  assert.ok(m.platform);
  assert.ok(m.platform.startsWith(process.platform));
  assert.ok(m.steps.find((s) => s.name === 'dirs' && s.status === 'ok'));
  assert.ok(m.steps.find((s) => s.name === 'runtime' && s.status === 'ok'));
});

test('W249 #13 - kolm version returns clean output', () => {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'kolm.js'), 'version'],
    { encoding: 'utf8', timeout: 10000 });
  assert.match(out.stdout, /kolm cli\s+v\d+\.\d+\.\d+/);
});

test('W249 #14 - install.sh next-steps mentions services + bootstrap + quickstart', () => {
  const body = fs.readFileSync(SH, 'utf8');
  assert.match(body, /kolm quickstart/);
  assert.match(body, /kolm services start/);
  assert.match(body, /kolm bootstrap/);
});

test('W249 #15 - install.ps1 next-steps mentions services + bootstrap + quickstart', () => {
  const body = fs.readFileSync(PS1, 'utf8');
  assert.match(body, /kolm quickstart/);
  assert.match(body, /kolm services start/);
  assert.match(body, /kolm bootstrap/);
});

test('W249 #16 - both installers warn about PATH', () => {
  const sh = fs.readFileSync(SH, 'utf8');
  const ps = fs.readFileSync(PS1, 'utf8');
  assert.match(sh, /is not on your PATH/);
  assert.match(ps, /is not on your User PATH|is not on your PATH/);
});

test('W249 #17 - sitemap.xml drops every W248-cut /vs-* page', () => {
  const sm = fs.readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');
  const vs = ['/vs-fine-tune', '/vs-hindsight', '/vs-langsmith', '/vs-mem0', '/vs-ollama',
    '/vs-openai-fine-tune', '/vs-openpipe', '/vs-predibase', '/vs-rag', '/vs-together'];
  for (const p of vs) {
    assert.doesNotMatch(sm, new RegExp(`<loc>https://kolm\\.ai${p.replace(/\//g, '\\/')}</loc>`),
      `sitemap still lists ${p}`);
  }
});

test('W249 #18 - sitemap.xml drops /docs/i18n/* thin translations', () => {
  const sm = fs.readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');
  assert.doesNotMatch(sm, /\/docs\/i18n\//);
});

test('W249 #19 - sitemap.xml keeps canonical surfaces', () => {
  const sm = fs.readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');
  for (const p of ['/', '/captures', '/quickstart', '/models', '/foundations', '/compare', '/what-is-an-ai-compiler']) {
    const re = p === '/' ?
      /<loc>https:\/\/kolm\.ai\/<\/loc>/ :
      new RegExp(`<loc>https://kolm\\.ai${p.replace(/\//g, '\\/')}</loc>`);
    assert.match(sm, re, `sitemap missing canonical ${p}`);
  }
});

test('W249 #20 - bootstrap manifest path uses platform separator', () => {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'kolm.js'),
    'bootstrap', '--no-services', '--no-doctor', '--json'],
    { encoding: 'utf8', timeout: 15000 });
  const m = JSON.parse(out.stdout);
  if (process.platform === 'win32') {
    assert.match(m.home, /\\\.kolm$/);
  } else {
    assert.match(m.home, /\/\.kolm$/);
  }
});
