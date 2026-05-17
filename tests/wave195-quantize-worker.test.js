// Wave 195: `kolm quantize` via the isolated quantize worker.
//
// Locks in the Q+5 closure from the Wave 144 plan: a dedicated `kolm
// quantize` verb backed by an isolated @kolmogorov/quantize-worker
// package. The pattern mirrors workers/distill/: heavy Python ML deps
// (bitsandbytes, torch, auto-gptq, optimum, accelerate) live ONLY inside
// the worker package; the root kolm install stays light.
//
// Tests cover:
//   * workers/quantize/ package shape (package.json + README.md +
//     quantize.mjs + requirements.txt all present and correctly typed)
//   * root package.json does NOT pick up torch / bitsandbytes when the
//     worker package is introduced
//   * CLI substrate (dispatch, HELP, COMPLETION_VERBS)
//   * Honest scope: without --local-worker the verb prints scaffolding
//     and exits 0 (no work done)
//   * Doctor mode invokes the worker and exits 0 or 1 based on toolchain

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE     = path.dirname(fileURLToPath(import.meta.url));
const REPO     = path.resolve(HERE, '..');
const CLI      = path.join(REPO, 'cli', 'kolm.js');
const SW       = path.join(REPO, 'public', 'sw.js');
const WORKER   = path.join(REPO, 'workers', 'quantize');
const ROOT_PKG = path.join(REPO, 'package.json');

function runCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    timeout: 20_000,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', KOLM_AIRGAP: '1', ...extraEnv },
  });
}

test('1. workers/quantize/ directory exists', () => {
  assert.ok(fs.existsSync(WORKER), `workers/quantize/ must exist at ${WORKER}`);
  assert.ok(fs.statSync(WORKER).isDirectory(), 'workers/quantize/ must be a directory');
});

test('2. workers/quantize/package.json declares @kolmogorov/quantize-worker private package', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(WORKER, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@kolmogorov/quantize-worker',
    'worker package must be named @kolmogorov/quantize-worker');
  assert.equal(pkg.private, true, 'worker package must be private:true');
  assert.equal(pkg.license, 'Apache-2.0', 'worker package must declare Apache-2.0 license');
  assert.equal(pkg.type, 'module',  'worker package must be type:module');
});

test('3. workers/quantize/package.json declares torch + bitsandbytes under python.requires (NOT under dependencies)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(WORKER, 'package.json'), 'utf8'));
  // python.requires must list the heavy deps
  assert.ok(pkg.python, 'worker package must have a python block');
  assert.ok(Array.isArray(pkg.python.requires), 'python.requires must be an array');
  const all = pkg.python.requires.join(' ');
  for (const dep of ['bitsandbytes', 'torch', 'auto-gptq']) {
    assert.match(all, new RegExp(dep), `python.requires must list ${dep}`);
  }
  // dependencies + optionalDependencies MUST NOT carry these heavy ML deps
  const flat = JSON.stringify(pkg.dependencies || {}) + JSON.stringify(pkg.optionalDependencies || {});
  for (const dep of ['bitsandbytes', 'torch', 'auto-gptq']) {
    assert.ok(!flat.includes(dep), `npm dependencies must NOT list ${dep} (it belongs in python.requires only)`);
  }
});

test('4. workers/quantize/quantize.mjs entrypoint exists and parses --doctor', () => {
  const mjs = path.join(WORKER, 'quantize.mjs');
  assert.ok(fs.existsSync(mjs), 'workers/quantize/quantize.mjs must exist');
  const src = fs.readFileSync(mjs, 'utf8');
  // Must parse the --doctor flag
  assert.match(src, /args\.doctor/, 'quantize.mjs must parse the --doctor flag');
  // Must reference all 4 methods
  for (const method of ['int4', 'int8', 'gptq', 'awq']) {
    assert.match(src, new RegExp(method), `quantize.mjs must reference method "${method}"`);
  }
});

test('5. workers/quantize/README.md exists and names install path + honest scope', () => {
  const readme = path.join(WORKER, 'README.md');
  assert.ok(fs.existsSync(readme), 'workers/quantize/README.md must exist');
  const text = fs.readFileSync(readme, 'utf8');
  // Install path
  assert.match(text, /cd workers\/quantize/i, 'README must name the cd install path');
  assert.match(text, /npm install/, 'README must mention npm install');
  assert.match(text, /pip install/, 'README must mention pip install');
  // Honest scope
  assert.match(text, /honest scope|opt-in|isolated/i,
    'README must declare honest scope (opt-in / isolated worker pattern)');
});

test('6. workers/quantize/requirements.txt names bitsandbytes + torch', () => {
  const req = path.join(WORKER, 'requirements.txt');
  assert.ok(fs.existsSync(req), 'workers/quantize/requirements.txt must exist');
  const text = fs.readFileSync(req, 'utf8');
  assert.match(text, /bitsandbytes/, 'requirements.txt must list bitsandbytes');
  assert.match(text, /torch/,        'requirements.txt must list torch');
});

test('7. Root package.json does NOT pick up torch / bitsandbytes / auto-gptq', () => {
  const pkg = JSON.parse(fs.readFileSync(ROOT_PKG, 'utf8'));
  const flat = JSON.stringify(pkg.dependencies || {}) +
               JSON.stringify(pkg.devDependencies || {}) +
               JSON.stringify(pkg.optionalDependencies || {});
  for (const dep of ['bitsandbytes', 'auto-gptq', 'torch']) {
    assert.ok(!flat.includes(dep),
      `root package.json must NOT carry ${dep} (lives in worker python.requires)`);
  }
});

test('8. CLI `kolm quantize --help` exits 0 and mentions --local-worker', () => {
  const r = runCli(['quantize', '--help']);
  assert.equal(r.status, 0, `kolm quantize --help exited ${r.status}: ${r.stderr?.slice(0, 200)}`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /kolm quantize/, 'help must reference the verb');
  assert.match(out, /--local-worker/, 'help must name --local-worker flag');
  // All 4 methods must surface
  for (const method of ['int4', 'int8', 'gptq', 'awq']) {
    assert.ok(out.includes(method), `help must name method "${method}"`);
  }
});

test('9. CLI `kolm quantize` (no --local-worker) prints scaffolding message + exits 0', () => {
  const r = runCli(['quantize']);
  assert.equal(r.status, 0, `bare kolm quantize must exit 0 (honest scaffold); got ${r.status}`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /--local-worker/, 'bare kolm quantize must instruct user to use --local-worker');
  assert.match(out, /workers\/quantize/, 'bare kolm quantize must point to the worker path');
});

test('10. CLI `kolm quantize --local-worker --doctor` invokes the worker (exit 0 or 1)', () => {
  const r = runCli(['quantize', '--local-worker', '--doctor']);
  // The worker exits 0 when python+torch+bitsandbytes all importable, 1 otherwise.
  // Both are acceptable; the test verifies the spawn happened.
  assert.ok(r.status === 0 || r.status === 1,
    `quantize --doctor must exit 0 or 1; got ${r.status}: ${r.stderr?.slice(0, 200)}`);
  const out = (r.stdout || '') + (r.stderr || '');
  // Worker output must surface, either doctor report or quantize-worker name
  assert.match(out, /quantize|doctor/i, `expected worker output to mention quantize or doctor; got: ${out.slice(0, 300)}`);
});

test('11. cli/kolm.js dispatch case includes "quantize"', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.match(src, /case 'quantize':\s*await withErrorContext\('quantize'/,
    'cli/kolm.js verb switch must include case for "quantize"');
});

test('12. COMPLETION_VERBS contains "quantize"', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  const m = src.match(/const COMPLETION_VERBS = \[[^\]]+\]/);
  assert.ok(m, 'COMPLETION_VERBS array must exist');
  assert.match(m[0], /'quantize'/, 'COMPLETION_VERBS must contain "quantize"');
});

test('13. Root HELP._root mentions the quantize verb', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  // The root help block has a per-verb line. Search for "quantize" in HELP._root.
  const rootStart = src.indexOf('_root: `kolm v');
  assert.ok(rootStart >= 0, 'HELP._root must exist');
  const rootEnd = src.indexOf("`,", rootStart);
  const rootSlice = src.slice(rootStart, rootEnd);
  assert.match(rootSlice, /quantize/, 'HELP._root must include a quantize line');
});

test('14. HELP.quantize text declares the opt-in / isolated-worker honest scope', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  const helpStart = src.indexOf("quantize: `kolm quantize");
  assert.ok(helpStart >= 0, 'HELP.quantize block must exist');
  const helpEnd = src.indexOf("`,", helpStart);
  const helpSlice = src.slice(helpStart, helpEnd);
  assert.match(helpSlice, /opt-in|isolated/i,
    'HELP.quantize must declare opt-in or isolated-worker positioning');
  assert.match(helpSlice, /workers\/quantize/,
    'HELP.quantize must reference the workers/quantize/ path');
});

test('15. sw.js CACHE wave segment >= 195 (wave-floor regex, not literal)', () => {
  const sw = fs.readFileSync(SW, 'utf8');
  const m = sw.match(/const CACHE = 'kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(parseInt(m[1], 10) >= 195,
    `sw.js CACHE wave segment must be >= 195 (saw wave${m[1]})`);
});

test('16. Worker package.json mirrors workers/distill/package.json shape', () => {
  const distillPkg  = JSON.parse(fs.readFileSync(path.join(REPO, 'workers', 'distill', 'package.json'), 'utf8'));
  const quantizePkg = JSON.parse(fs.readFileSync(path.join(WORKER, 'package.json'), 'utf8'));
  // Both must be private:true, type:module, Apache-2.0, with a python.requires block
  assert.equal(quantizePkg.private, distillPkg.private,    'private flag must match distill worker');
  assert.equal(quantizePkg.type,    distillPkg.type,       'type must match distill worker');
  assert.equal(quantizePkg.license, distillPkg.license,    'license must match distill worker');
  assert.ok(quantizePkg.python && quantizePkg.python.requires,
    'quantize worker must declare python.requires (mirrors distill worker shape)');
});

test('17. Worker doctor mode is callable directly (node quantize.mjs --doctor)', () => {
  const r = spawnSync(process.execPath, [path.join(WORKER, 'quantize.mjs'), '--doctor'], {
    timeout: 15_000,
    encoding: 'utf8',
  });
  // Either 0 (ready) or 1 (deps missing), both acceptable; test verifies spawn worked.
  assert.ok(r.status === 0 || r.status === 1,
    `worker --doctor must exit 0 or 1; got ${r.status}: ${r.stderr?.slice(0, 200)}`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /node_version|python_ok|bitsandbytes/i,
    'doctor output must include toolchain readiness markers');
});

test('18. cmdQuantize handler exists in cli/kolm.js', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.match(src, /async function cmdQuantize\(/,
    'cli/kolm.js must export an async function cmdQuantize handler');
  assert.match(src, /async function cmdQuantizeLocalWorker\(/,
    'cli/kolm.js must export an async function cmdQuantizeLocalWorker handler');
});

test('19. CLI without --local-worker does not error; it returns a polite scaffold message', () => {
  // Wave 195 contract: the verb is opt-in. Today it returns a scaffolding message
  // and exits 0; tomorrow when the worker is enabled it routes through the worker.
  const r = runCli(['quantize']);
  assert.equal(r.status, 0, 'bare quantize must exit 0 (scaffold path)');
  const out = (r.stdout || '') + (r.stderr || '');
  // Honest scope language must appear
  assert.match(out, /scaffolding|opt-in|requires.*--local-worker/i,
    'bare quantize output must declare scaffold / opt-in status');
});
