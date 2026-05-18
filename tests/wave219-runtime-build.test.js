// Wave 219: llama.cpp-from-source track. `kolm runtime build-from-source
// --target=<slug>` delegates to the isolated workers/runtime-build/ worker,
// which knows pinned-commit + per-target cmake flags + toolchain check.
// Tests assert function semantics + module shape, not page-byte markers.
//
// Contract:
//   1. workers/runtime-build/build.mjs exports TARGETS, listTargets,
//      describeTarget, emitCmakeArgs, checkToolchain — and 10 named targets.
//   2. emitCmakeArgs round-trips: every target's flags appear in the emitted
//      cmake arg list (no flag is silently dropped).
//   3. describeTarget returns shape {slug, arch, vendor, cmake, sdk, sdk_min,
//      notes} for every named target, null for unknown.
//   4. checkToolchain returns {ok, missing, target} with deterministic shape
//      regardless of whether the SDK is present (test-host independent).
//   5. cli/kolm.js wires `runtime` into the dispatch + cmdRuntime + COMPLETION
//      tables, and forwards build-from-source to the worker via spawnSync.
//   6. workers/runtime-build/package.json declares heavy SDKs under
//      system_requires (NOT under dependencies — root install stays light).
//   7. public/runtimes.html surfaces all 10 target slugs.
//   8. vercel.json has the /runtimes rewrite.
//   9. sw.js CACHE wave-floor >= 219.
//  10. Pinned-commit constant exists in the worker so future runs are
//      reproducible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI_SRC = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const RUNTIMES_HTML = fs.readFileSync(path.join(ROOT, 'public/runtimes.html'), 'utf8');
const WORKER_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'workers/runtime-build/package.json'), 'utf8'));
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'workers/runtime-build/build.mjs'), 'utf8');

const NAMED_TARGETS = [
  'cuda-89', 'cuda-90', 'cuda-100', 'cuda-120',
  'rocm-gfx1100', 'rocm-gfx942',
  'vulkan', 'metal',
  'cpu-avx2', 'cpu-avx512',
];

test('W219 #1 - worker exports TARGETS + helpers, 10 named targets present', async () => {
  const W = await import(pathToFileURL(path.join(ROOT, 'workers/runtime-build/build.mjs')).href);
  for (const fn of ['TARGETS', 'listTargets', 'describeTarget', 'emitCmakeArgs', 'checkToolchain']) {
    assert.ok(W[fn], `export ${fn} missing`);
  }
  const slugs = Object.keys(W.TARGETS);
  for (const named of NAMED_TARGETS) {
    assert.ok(slugs.includes(named), `target ${named} missing from TARGETS`);
  }
  assert.equal(W.listTargets().length, slugs.length, 'listTargets must enumerate every TARGET');
});

test('W219 #2 - emitCmakeArgs round-trips every per-target flag', async () => {
  const W = await import(pathToFileURL(path.join(ROOT, 'workers/runtime-build/build.mjs')).href);
  for (const slug of NAMED_TARGETS) {
    const args = W.emitCmakeArgs(slug, { build_type: 'Release', install_prefix: '/tmp/x' });
    const flags = W.TARGETS[slug].cmake;
    for (const f of flags) {
      assert.ok(args.includes(f), `emitCmakeArgs(${slug}) missing flag ${f}`);
    }
    assert.ok(args.includes('-G'), 'must specify generator');
    assert.ok(args.includes('Ninja'), 'must use Ninja');
    assert.ok(args.some(a => a.startsWith('-DCMAKE_BUILD_TYPE=')), 'must set CMAKE_BUILD_TYPE');
    assert.ok(args.some(a => a.startsWith('-DCMAKE_INSTALL_PREFIX=')), 'must set INSTALL_PREFIX');
  }
  assert.throws(() => W.emitCmakeArgs('not-a-target'), /unknown target/);
});

test('W219 #3 - describeTarget returns shape for every named target, null on unknown', async () => {
  const W = await import(pathToFileURL(path.join(ROOT, 'workers/runtime-build/build.mjs')).href);
  for (const slug of NAMED_TARGETS) {
    const t = W.describeTarget(slug);
    assert.ok(t, `describeTarget(${slug}) returned null`);
    assert.equal(t.slug, slug);
    assert.ok(typeof t.arch === 'string' && t.arch.length > 0);
    assert.ok(typeof t.vendor === 'string' && t.vendor.length > 0);
    assert.ok(Array.isArray(t.cmake) && t.cmake.length > 0);
    assert.ok('sdk' in t, 'sdk field required');
    assert.ok('notes' in t, 'notes field required');
  }
  assert.equal(W.describeTarget('not-a-target'), null);
});

test('W219 #4 - checkToolchain returns stable shape regardless of host SDK', async () => {
  const W = await import(pathToFileURL(path.join(ROOT, 'workers/runtime-build/build.mjs')).href);
  for (const slug of NAMED_TARGETS) {
    const r = W.checkToolchain(slug);
    assert.ok('ok' in r, 'ok field required');
    assert.equal(typeof r.ok, 'boolean');
    if (!r.ok) {
      assert.ok(Array.isArray(r.missing), 'missing must be array when !ok');
    }
  }
  // Unknown target should not throw — returns ok:false with reason.
  const bad = W.checkToolchain('not-a-target');
  assert.equal(bad.ok, false);
});

test('W219 #5 - cli/kolm.js wires runtime: dispatch + cmdRuntime + COMPLETION', () => {
  // The dispatch case must exist.
  assert.match(CLI_SRC, /case 'runtime':\s*await withErrorContext\('runtime'/, 'dispatch case missing');
  // cmdRuntime function definition must exist.
  assert.match(CLI_SRC, /async function cmdRuntime\(args\)/, 'cmdRuntime fn missing');
  // COMPLETION_VERBS must include 'runtime'.
  const verbsMatch = CLI_SRC.match(/const COMPLETION_VERBS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(verbsMatch, 'COMPLETION_VERBS array missing');
  assert.match(verbsMatch[1], /'runtime'/, "'runtime' missing from COMPLETION_VERBS");
  // COMPLETION_SUBS.runtime must enumerate the four subcommands.
  const subsMatch = CLI_SRC.match(/runtime:\s*\[([^\]]+)\]/);
  assert.ok(subsMatch, 'COMPLETION_SUBS.runtime missing');
  for (const sub of ['targets', 'info', 'doctor', 'build-from-source']) {
    assert.ok(subsMatch[1].includes(`'${sub}'`), `COMPLETION_SUBS.runtime missing ${sub}`);
  }
  // cmdRuntime should delegate build-from-source via spawnSync of the worker.
  // W380d: widened window — W372 policy ladder (start/status/policy/install/
  // decisions/stats) sits before build-from-source in cmdRuntime and pushed
  // the spawnSync call past the old 6000-char slice.
  const cmdIdx = CLI_SRC.indexOf('async function cmdRuntime(');
  const cmdBody = CLI_SRC.slice(cmdIdx, cmdIdx + 16000);
  assert.match(cmdBody, /build-from-source/);
  assert.match(cmdBody, /spawnSync/);
  assert.match(cmdBody, /workers[/\\]+runtime-build[/\\]+build\.mjs|workers.{1,10}runtime-build.{1,10}build\.mjs/);
});

test('W219 #6 - worker package.json keeps heavy SDKs out of root dependencies', () => {
  assert.equal(WORKER_PKG.name, '@kolm/runtime-build-worker');
  assert.equal(WORKER_PKG.private, true, 'worker must be private');
  // Heavy SDKs MUST be in system_requires (declarative-only), NOT in dependencies.
  const deps = WORKER_PKG.dependencies || {};
  const optDeps = WORKER_PKG.optionalDependencies || {};
  for (const heavy of ['cuda-toolkit', 'nvcc', 'rocm-hip-sdk', 'vulkan-sdk']) {
    assert.ok(!deps[heavy], `heavy SDK ${heavy} leaked into worker dependencies`);
    assert.ok(!optDeps[heavy], `heavy SDK ${heavy} leaked into worker optionalDependencies`);
  }
  // And the worker must declare them in system_requires so doctor + docs can list them.
  const sr = WORKER_PKG.system_requires || {};
  assert.ok(Array.isArray(sr.all) && sr.all.length > 0, 'system_requires.all required');
  assert.ok(Array.isArray(sr.cuda), 'system_requires.cuda required');
  assert.ok(Array.isArray(sr.rocm), 'system_requires.rocm required');
  assert.ok(Array.isArray(sr.vulkan), 'system_requires.vulkan required');
  // Root install must not depend on the worker either.
  const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const rootDeps = { ...(ROOT_PKG.dependencies || {}), ...(ROOT_PKG.optionalDependencies || {}) };
  for (const heavy of ['cuda-toolkit', 'nvcc', 'rocm-hip-sdk', 'vulkan-sdk', '@kolm/runtime-build-worker']) {
    assert.ok(!rootDeps[heavy], `root install must not pull ${heavy}`);
  }
});

test('W219 #7 - public/runtimes.html surfaces all 10 target slugs', () => {
  for (const slug of NAMED_TARGETS) {
    assert.ok(RUNTIMES_HTML.includes(slug), `runtimes.html missing target slug ${slug}`);
  }
  // Page must reference the worker location + receipt + CLI command shape.
  assert.match(RUNTIMES_HTML, /workers[/\\]+runtime-build/);
  assert.match(RUNTIMES_HTML, /build-receipt\.json/);
  assert.match(RUNTIMES_HTML, /kolm runtime build-from-source/);
});

test('W219 #8 - vercel.json has /runtimes rewrite', () => {
  const rewrites = VERCEL.rewrites || [];
  const hit = rewrites.find(r => r.source === '/runtimes' && r.destination === '/runtimes.html');
  assert.ok(hit, '/runtimes -> /runtimes.html rewrite missing in vercel.json');
});

test('W219 #9 - sw.js CACHE wave-floor >= 219', () => {
  const m = SW_JS.match(/const\s+CACHE\s*=\s*'kolm-v7-2026-05-\d+-wave(\d+)/);
  assert.ok(m, 'CACHE slug present');
  assert.ok(parseInt(m[1], 10) >= 219, 'CACHE wave >= 219 (got ' + m[1] + ')');
});

test('W219 #10 - worker pins a commit so build is reproducible', () => {
  // PINNED_COMMIT constant must exist in the worker source so future rebuilds
  // are deterministic — passing --commit overrides it but the default is fixed.
  assert.match(WORKER_SRC, /PINNED_COMMIT\s*=\s*['"][^'"]+['"]/);
  assert.match(WORKER_SRC, /DEFAULT_REPO\s*=\s*['"]https?:\/\/[^'"]+\.git['"]/);
  // And the receipt must carry receipt_kind so consumers can recognize it.
  assert.match(WORKER_SRC, /receipt_kind:\s*['"]kolm-runtime-build\/1['"]/);
});
