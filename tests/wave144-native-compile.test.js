// Wave 144 / Wave G — optional native compilation tests.
//
// Two phases under test:
//   1. *No-op safety.* compileSpec with no compileNative flag must produce
//      a manifest identical (in compiled_targets shape) to Wave F output —
//      proving the new module is fully opt-in. compileNative=true with both
//      toolchains absent must NOT throw — it records `native_skipped` and
//      ships source-only.
//   2. *Compile path.* When a real cc / rustc exists on the host, the
//      bundled binary must (a) appear in the zip, (b) re-hash equal to
//      manifest.compiled_targets.recipes[rid].{c,rust}.bin.bin_hash, (c)
//      execute and produce the same output as the JS-rule reference.
//
// Phase 2 uses runtime toolchain detection. On a host without cc/rustc the
// individual asserts are skipped via t.skip() — the test reports green and
// records *which* paths were exercised, so the CI dashboard distinguishes
// "tested + passed" from "skipped because no toolchain".

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import AdmZip from 'adm-zip';

import {
  detectCCompiler,
  detectRustCompiler,
  detectWasmCompiler,
  detectToolchains,
  hostTriple,
  compileNativeTargets,
  NATIVE_SPEC,
  _internals,
} from '../src/native-compile.js';
import { emitCompiledTargets, DSL_SPEC } from '../src/dsl.js';
import { compileSpec } from '../src/spec-compile.js';
import { buildBinder } from '../src/binder.js';

process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-wave144-native-test-secret';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wave144-native-'));
const T = detectToolchains();
const HAS_CC = !!T.c;
const HAS_RUSTC = !!T.rust;
const HAS_WASM = !!T.wasm;

// Echo recipe written in rule-dsl-v1 so emitCompiledTargets has something to
// chew on. The DSL: take input.text (or input if it's a string), wrap in a
// JSON object { echo: <text> }.
function echoDsl() {
  return {
    type: DSL_SPEC,
    output: {
      op: 'object',
      fields: {
        echo: { op: 'input' },
      },
    },
  };
}

// Minimal spec for compileSpec.
function echoSpec(jobId) {
  return {
    job_id: jobId,
    task: 'wave144 native compile echo',
    base_model: 'none',
    artifact_class: 'compiled_rule',
    recipes: [{
      id: 'rcp_echo',
      name: 'echo',
      dsl: echoDsl(),
      tags: [],
    }],
    evals: { spec: 'rs-1-evals', n: 0, cases: [] },
    training_stats: {
      distilled_pairs: 0,
      pass_rate_positive: 1,
      latency_p50_us: 50,
      cost_usd_per_call: 0,
    },
  };
}

// ─── toolchain detection ──────────────────────────────────────────────────

test('detectToolchains: returns the expected shape', () => {
  const r = detectToolchains();
  assert.ok('c' in r);
  assert.ok('rust' in r);
  assert.ok('wasm' in r);
  if (r.c) {
    assert.ok(typeof r.c.compiler === 'string');
    assert.ok(typeof r.c.version === 'string');
  }
  if (r.rust) {
    assert.equal(r.rust.compiler, 'rustc');
    assert.ok(typeof r.rust.version === 'string');
  }
  if (r.wasm) {
    assert.ok(['rust', 'c'].includes(r.wasm.source_kind));
    assert.ok(['rustc', 'clang'].includes(r.wasm.compiler));
    assert.ok(typeof r.wasm.version === 'string');
  }
});

test('hostTriple: returns "<arch>-<platform>"', () => {
  const t = hostTriple();
  assert.match(t, new RegExp(`^${process.arch}-${process.platform}$`));
});

// ─── compileNativeTargets — pure unit, no spec-compile ────────────────────

test('compileNativeTargets: requires a compiled_targets bundle', () => {
  assert.throws(() => compileNativeTargets(null), /requires a compiled_targets bundle/);
  assert.throws(() => compileNativeTargets({}), /requires a compiled_targets bundle/);
});

test('compileNativeTargets: with both toolchains forced absent, returns skipped reasons and zero files', () => {
  const t = emitCompiledTargets(echoDsl(), { recipeName: 'rcp_echo' });
  const bundle = {
    spec: DSL_SPEC,
    single_recipe: true,
    targets: ['c', 'rust'],
    recipes: { rcp_echo: { c: t.c, rust: t.rust } },
  };
  const r = compileNativeTargets(bundle, { toolchains: { c: null, rust: null, wasm: null } });
  assert.equal(r.bundle.spec, NATIVE_SPEC);
  assert.equal(r.bundle.recipes.rcp_echo.c, null);
  assert.equal(r.bundle.recipes.rcp_echo.rust, null);
  assert.equal(r.bundle.recipes.rcp_echo.wasm, undefined, 'wasm key absent when wasm tool absent + not opted-in');
  assert.match(r.bundle.skipped.c, /no C compiler detected/);
  assert.match(r.bundle.skipped.rust, /no Rust compiler detected/);
  assert.match(r.bundle.skipped.wasm, /WASM compilation disabled/);
  assert.equal(r.files.length, 0);
});

test('compileNativeTargets: deterministic shim hashes — embedded constants do not drift between runs', () => {
  // The shim is part of the verified bytes the verifier hashes. If it
  // changes between Node restarts (e.g., a tooling refactor injects a date)
  // every existing artifact's bin_hash breaks. Lock the hash here.
  assert.match(_internals.C_SHIM_HASH, /^[0-9a-f]{64}$/);
  assert.match(_internals.RS_SHIM_HASH, /^[0-9a-f]{64}$/);
  // Re-hash from the published shim text — must be identical.
  assert.equal(_internals.sha256(_internals.C_MAIN_SHIM), _internals.C_SHIM_HASH);
  assert.equal(_internals.sha256(_internals.RS_MAIN_SHIM), _internals.RS_SHIM_HASH);
});

// ─── wave 153 — toolchain pin / version hash unit tests ───────────────────

test('wave 153: toolchainVersionHash is deterministic and order-sensitive', () => {
  const inA = { compiler: 'rustc', compiler_version: 'rustc 1.78.0', flags: '-O', shim_hash: 'a'.repeat(64) };
  const inB = { compiler: 'rustc', compiler_version: 'rustc 1.78.0', flags: '-O', shim_hash: 'a'.repeat(64) };
  const inDifferent = { ...inA, compiler_version: 'rustc 1.79.0' };
  const hA = _internals.toolchainVersionHash(inA);
  const hB = _internals.toolchainVersionHash(inB);
  const hC = _internals.toolchainVersionHash(inDifferent);
  assert.match(hA, /^[0-9a-f]{64}$/);
  assert.equal(hA, hB, 'same inputs -> same hash');
  assert.notEqual(hA, hC, 'different compiler_version -> different hash');
});

test('wave 153: DETERMINISTIC_ENV pins SOURCE_DATE_EPOCH=0', () => {
  assert.equal(_internals.DETERMINISTIC_ENV.SOURCE_DATE_EPOCH, '0');
});

// ─── compileSpec round-trip — opt-out default ─────────────────────────────

test('compileSpec without compileNative: manifest has no .native sub-block (back-compat with Wave F)', async () => {
  const spec = echoSpec('job_native_optout_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, { outDir: TMP, outPath: out });
  const zip = new AdmZip(built.outPath);
  const manifest = JSON.parse(zip.getEntries().find(e => e.entryName === 'manifest.json').getData().toString('utf8'));
  assert.equal(manifest.artifact_class, 'compiled_rule');
  assert.ok(manifest.compiled_targets);
  assert.ok(manifest.compiled_targets.recipes.rcp_echo.c.source_hash);
  assert.ok(manifest.compiled_targets.recipes.rcp_echo.rust.source_hash);
  // No native sub-block.
  assert.equal(manifest.compiled_targets.native_spec, undefined);
  assert.equal(manifest.compiled_targets.host_triple, undefined);
  assert.equal(manifest.compiled_targets.recipes.rcp_echo.c.bin, undefined);
  assert.equal(manifest.compiled_targets.recipes.rcp_echo.rust.bin, undefined);
  // Zip contains the source files, no .bin files.
  const names = zip.getEntries().map(e => e.entryName);
  assert.ok(names.includes('native.c'));
  assert.ok(names.includes('native.rs'));
  assert.ok(!names.some(n => n.endsWith('.bin')));
});

// ─── compileSpec round-trip — opt-in with toolchains forced absent ────────

test('compileSpec with compileNative=true and no toolchains: ships source-only with native_skipped recorded', async () => {
  const spec = echoSpec('job_native_optin_noop_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    compileNative: true,
    toolchains: { c: null, rust: null },
  });
  const zip = new AdmZip(built.outPath);
  const manifest = JSON.parse(zip.getEntries().find(e => e.entryName === 'manifest.json').getData().toString('utf8'));
  assert.equal(manifest.compiled_targets.native_spec, NATIVE_SPEC);
  assert.match(manifest.compiled_targets.host_triple, new RegExp(`^${process.arch}-${process.platform}$`));
  assert.match(manifest.compiled_targets.native_skipped.c, /no C compiler/);
  assert.match(manifest.compiled_targets.native_skipped.rust, /no Rust compiler/);
  // No bin files in the zip.
  const names = zip.getEntries().map(e => e.entryName);
  assert.ok(!names.some(n => n.endsWith('.bin')));

  // Binder runs cleanly. Native binary integrity check does NOT fire when
  // there are no .bin claims (it's a no-op pass-through).
  const r = await buildBinder(built.outPath);
  const nativeCheck = r.checks.find(c => c.name === 'Native binary integrity');
  assert.equal(nativeCheck, undefined, 'no native check when no .bin claimed');
});

// ─── compileSpec round-trip — actual compile (conditional) ─────────────────

test('compileSpec with compileNative=true and real cc: bundles binary, verifier re-hashes pass', { skip: !HAS_CC && !HAS_RUSTC ? 'no cc/rustc on this host' : false }, async () => {
  if (!HAS_CC && !HAS_RUSTC) return; // belt-and-suspenders for skip
  const spec = echoSpec('job_native_real_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    compileNative: true,
  });
  const zip = new AdmZip(built.outPath);
  const manifest = JSON.parse(zip.getEntries().find(e => e.entryName === 'manifest.json').getData().toString('utf8'));
  const ct = manifest.compiled_targets;
  assert.equal(ct.native_spec, NATIVE_SPEC);

  const entriesByName = Object.fromEntries(zip.getEntries().map(e => [e.entryName, e]));

  if (HAS_CC) {
    const cb = ct.recipes.rcp_echo.c.bin;
    assert.ok(cb, 'c.bin block present when cc available');
    assert.equal(cb.bin_filename, 'native.c.bin');
    assert.match(cb.bin_hash, /^[0-9a-f]{64}$/);
    assert.ok(cb.bytes > 0);
    assert.ok(cb.compiler);
    assert.match(cb.flags, /-O2|-Fe/i);
    // Re-hash the bundled bytes; must match the manifest claim.
    const data = entriesByName['native.c.bin'].getData();
    const recomputed = crypto.createHash('sha256').update(data).digest('hex');
    assert.equal(recomputed, cb.bin_hash, 'bundled C binary hash matches manifest claim');
    // Wave 153: receipt-chain hardening fields.
    assert.equal(cb.source_date_epoch, 0);
    assert.match(cb.toolchain_version_hash, /^[0-9a-f]{64}$/);
  }

  if (HAS_RUSTC) {
    const rb = ct.recipes.rcp_echo.rust.bin;
    assert.ok(rb, 'rust.bin block present when rustc available');
    assert.equal(rb.bin_filename, 'native.rust.bin');
    assert.match(rb.bin_hash, /^[0-9a-f]{64}$/);
    assert.ok(rb.bytes > 0);
    assert.equal(rb.compiler, 'rustc');
    const data = entriesByName['native.rust.bin'].getData();
    const recomputed = crypto.createHash('sha256').update(data).digest('hex');
    assert.equal(recomputed, rb.bin_hash, 'bundled Rust binary hash matches manifest claim');
    // Wave 153: receipt-chain hardening fields.
    assert.equal(rb.source_date_epoch, 0);
    assert.match(rb.toolchain_version_hash, /^[0-9a-f]{64}$/);
    // Wave 153: stricter rustc flag set lands on the manifest verbatim.
    assert.match(rb.flags, /-C opt-level=3/);
    assert.match(rb.flags, /-C codegen-units=1/);
    assert.match(rb.flags, /-C lto=fat/);
    assert.match(rb.flags, /-C strip=symbols/);
    assert.match(rb.flags, /-C panic=abort/);
    assert.match(rb.flags, /SOURCE_DATE_EPOCH=0/);
  }

  // Wave 153: bundle-level target_toolchain_pin record surfaces both kinds
  // when present (per-kind absence is fine; we only assert the keys that
  // correspond to detected toolchains).
  if (HAS_CC || HAS_RUSTC) {
    assert.ok(ct.target_toolchain_pin, 'target_toolchain_pin emitted when any toolchain succeeded');
    if (HAS_CC) {
      assert.ok(ct.target_toolchain_pin.c);
      assert.equal(ct.target_toolchain_pin.c.source_date_epoch, 0);
      assert.equal(ct.target_toolchain_pin.c.shim_source_hash, _internals.C_SHIM_HASH);
    }
    if (HAS_RUSTC) {
      assert.ok(ct.target_toolchain_pin.rust);
      assert.equal(ct.target_toolchain_pin.rust.compiler, 'rustc');
      assert.equal(ct.target_toolchain_pin.rust.source_date_epoch, 0);
      assert.equal(ct.target_toolchain_pin.rust.shim_source_hash, _internals.RS_SHIM_HASH);
    }
  }

  // Binder produces a Native binary integrity = pass check.
  const r = await buildBinder(built.outPath);
  const nativeCheck = r.checks.find(c => c.name === 'Native binary integrity');
  assert.ok(nativeCheck, 'native check fires when .bin claims exist');
  assert.equal(nativeCheck.status, 'pass', nativeCheck.detail);
});

test('binder #12: fails when bundled binary has been tampered after seal', { skip: !HAS_CC && !HAS_RUSTC ? 'no cc/rustc on this host' : false }, async () => {
  if (!HAS_CC && !HAS_RUSTC) return;
  const spec = echoSpec('job_native_tamper_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    compileNative: true,
  });

  // Tamper with one of the bundled binaries. Use archiver to rewrite (same
  // strategy as wave144-verifier-states.test.js — AdmZip.writeZip is not
  // compatible with the artifact reader's CRC expectations). We do NOT
  // re-sign the manifest — we want the per-binary hash check to be what
  // catches the drift. The manifest signature is still valid because we
  // only touched a separate zip entry, not manifest.json.
  const archiver = (await import('archiver')).default;
  const zip = new AdmZip(built.outPath);
  const entries = new Map();
  for (const e of zip.getEntries()) entries.set(e.entryName, e.getData());
  // Pick whichever bin exists.
  const targetName = entries.has('native.c.bin') ? 'native.c.bin' : 'native.rust.bin';
  const original = entries.get(targetName);
  // Flip one byte deterministically. The result is still a "binary" — just
  // not the one whose hash the manifest claims.
  const tampered = Buffer.from(original);
  tampered[Math.min(8, tampered.length - 1)] ^= 0xff;
  entries.set(targetName, tampered);

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(built.outPath);
    const z = archiver('zip', { zlib: { level: 9 } });
    z.on('warning', (e) => { if (e.code !== 'ENOENT') reject(e); });
    z.on('error', reject);
    ws.on('close', resolve);
    z.pipe(ws);
    for (const [name, buf] of entries) z.append(buf, { name });
    z.finalize();
  });

  const r = await buildBinder(built.outPath);
  const nativeCheck = r.checks.find(c => c.name === 'Native binary integrity');
  assert.ok(nativeCheck);
  assert.equal(nativeCheck.status, 'fail', nativeCheck.detail);
  assert.match(nativeCheck.detail, /hash mismatch/);
});

test('compiled C binary actually runs end-to-end (echoes input arg)', { skip: !HAS_CC ? 'no cc on this host' : false }, async () => {
  if (!HAS_CC) return;
  const spec = echoSpec('job_native_exec_c_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    compileNative: true,
    toolchains: { c: T.c, rust: null }, // C-only for this test
  });
  const zip = new AdmZip(built.outPath);
  const bin = zip.getEntries().find(e => e.entryName === 'native.c.bin');
  assert.ok(bin, 'native.c.bin present');
  // Write to a temp file with platform-appropriate extension + exec bit.
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binPath = path.join(TMP, `native-exec-c-${crypto.randomBytes(3).toString('hex')}${ext}`);
  fs.writeFileSync(binPath, bin.getData());
  if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
  const r = spawnSync(binPath, ['hello world'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, `binary exit code 0 (stderr=${r.stderr})`);
  // The dsl echoes input as { echo: <input> } — kolm_run emits JSON,
  // shim adds a newline. Strip trailing newline.
  const stdout = String(r.stdout || '').replace(/\r?\n$/, '');
  assert.equal(stdout, '{"echo":"hello world"}', `unexpected stdout: ${JSON.stringify(stdout)}`);
});

test('compiled Rust binary actually runs end-to-end (echoes input arg)', { skip: !HAS_RUSTC ? 'no rustc on this host' : false }, async () => {
  if (!HAS_RUSTC) return;
  const spec = echoSpec('job_native_exec_rs_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    compileNative: true,
    toolchains: { c: null, rust: T.rust }, // Rust-only for this test
  });
  const zip = new AdmZip(built.outPath);
  const bin = zip.getEntries().find(e => e.entryName === 'native.rust.bin');
  assert.ok(bin, 'native.rust.bin present');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binPath = path.join(TMP, `native-exec-rs-${crypto.randomBytes(3).toString('hex')}${ext}`);
  fs.writeFileSync(binPath, bin.getData());
  if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
  const r = spawnSync(binPath, ['hello world'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, `binary exit code 0 (stderr=${r.stderr})`);
  const stdout = String(r.stdout || '').replace(/\r?\n$/, '');
  assert.equal(stdout, '{"echo":"hello world"}', `unexpected stdout: ${JSON.stringify(stdout)}`);
});

// ─── meta — record what got exercised ────────────────────────────────────

test('wave G coverage summary: report which toolchains were available', () => {
  // Not a pass/fail — informational. The summary is logged to stdout for the
  // CI dashboard to ingest.
  const summary = {
    host_triple: hostTriple(),
    c_compiler: HAS_CC ? { compiler: T.c.compiler, version: T.c.version } : null,
    rust_compiler: HAS_RUSTC ? { compiler: T.rust.compiler, version: T.rust.version } : null,
  };
  console.log('# wave-G coverage:', JSON.stringify(summary));
  assert.ok(true);
});

// ─── wave 154 §P+2 — extended C/MSVC hardening + fine-grained toggles ─────

test('wave 154: gcc/clang flag set carries -fno-asynchronous-unwind-tables + -fno-ident', { skip: !HAS_CC || (T.c && T.c.compiler === 'cl') ? 'no gcc/clang on this host' : false }, async () => {
  if (!HAS_CC || T.c.compiler === 'cl') return;
  const spec = echoSpec('job_w154_c_flags_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, { outDir: TMP, outPath: out, compileNative: true });
  const zip = new AdmZip(built.outPath);
  const manifest = JSON.parse(zip.getEntries().find(e => e.entryName === 'manifest.json').getData().toString('utf8'));
  const cb = manifest.compiled_targets.recipes.rcp_echo.c.bin;
  assert.ok(cb);
  assert.match(cb.flags, /-fno-asynchronous-unwind-tables/);
  assert.match(cb.flags, /-fno-ident/);
  assert.match(cb.flags, /-Wl,--build-id=none/);
  assert.match(cb.flags, /SOURCE_DATE_EPOCH=0/);
});

test('wave 154: MSVC flag set carries /Brepro + /OPT:NOREF + /INCREMENTAL:NO + /DEBUG:NONE', { skip: !HAS_CC || !T.c || T.c.compiler !== 'cl' ? 'no MSVC cl on this host' : false }, async () => {
  if (!HAS_CC || T.c.compiler !== 'cl') return;
  const spec = echoSpec('job_w154_msvc_flags_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, { outDir: TMP, outPath: out, compileNative: true });
  const zip = new AdmZip(built.outPath);
  const manifest = JSON.parse(zip.getEntries().find(e => e.entryName === 'manifest.json').getData().toString('utf8'));
  const cb = manifest.compiled_targets.recipes.rcp_echo.c.bin;
  assert.ok(cb);
  assert.match(cb.flags, /\/Brepro/);
  assert.match(cb.flags, /\/OPT:NOREF/);
  assert.match(cb.flags, /\/OPT:NOICF/);
  assert.match(cb.flags, /\/INCREMENTAL:NO/);
  assert.match(cb.flags, /\/DEBUG:NONE/);
});

test('wave 154: KOLM_COMPILE_NATIVE_C_ONLY=1 disables Rust even when rustc is on PATH', async () => {
  // Force-fed toolchains so we can verify the gate without needing real
  // compilers. cOnly should null out rust regardless.
  const fakeToolchains = {
    c: { compiler: 'cc', version: 'cc fake 1.0', path: 'cc' },
    rust: { compiler: 'rustc', version: 'rustc fake 1.0', path: 'rustc' },
  };
  const ct = {
    spec: 'rule-dsl-v1',
    single_recipe: true,
    targets: ['c', 'rust'],
    recipes: { rcp_echo: { c: { source: 'int kolm_run(){return 0;}' }, rust: { source: 'fn run(){}' } } },
  };
  // Use cOnly opt directly (bypass env mutation that other parallel tests
  // would race on). Implementation honors either env or opt.
  // We're not really compiling — we're checking the gate logic. Stub out the
  // C compile so the test is fast and doesn't require a host toolchain.
  // Easiest path: invoke with both opts and assert skipped.rust message.
  const out = compileNativeTargets(ct, {
    toolchains: { c: null, rust: fakeToolchains.rust }, // simulate no-cc host but rust present
    cOnly: true,
  });
  assert.equal(out.bundle.recipes.rcp_echo.rust, null, 'rust nulled when cOnly=true');
  assert.match(out.bundle.skipped.rust, /KOLM_COMPILE_NATIVE_C_ONLY=1/);
});

test('wave 154: KOLM_COMPILE_NATIVE_RUST_ONLY=1 disables C even when a C compiler is on PATH', async () => {
  const fakeToolchains = {
    c: { compiler: 'cc', version: 'cc fake 1.0', path: 'cc' },
    rust: null,
  };
  const ct = {
    spec: 'rule-dsl-v1',
    single_recipe: true,
    targets: ['c', 'rust'],
    recipes: { rcp_echo: { c: { source: 'int kolm_run(){return 0;}' }, rust: { source: 'fn run(){}' } } },
  };
  const out = compileNativeTargets(ct, {
    toolchains: fakeToolchains,
    rustOnly: true,
  });
  assert.equal(out.bundle.recipes.rcp_echo.c, null, 'c nulled when rustOnly=true');
  assert.match(out.bundle.skipped.c, /KOLM_COMPILE_NATIVE_RUST_ONLY=1/);
});

// ─── wave 155 §P+3 — WASM target (wasm32-wasi) ────────────────────────────

test('wave 155: detectWasmCompiler returns null or { source_kind, compiler, version }', () => {
  const w = detectWasmCompiler();
  if (w === null) return; // host has neither rustc+wasm-target nor clang+wasi
  assert.ok(['rust', 'c'].includes(w.source_kind), 'source_kind is rust or c');
  assert.ok(['rustc', 'clang'].includes(w.compiler), 'compiler is rustc or clang');
  assert.ok(typeof w.version === 'string');
});

test('wave 155: WASM is opt-in — without KOLM_COMPILE_WASM=1 or opt, wasm toolchain is nulled even if present', async () => {
  const fakeWasm = { source_kind: 'rust', compiler: 'rustc', version: 'rustc fake', path: 'rustc' };
  const ct = {
    spec: 'rule-dsl-v1',
    single_recipe: true,
    targets: ['c', 'rust'],
    recipes: { rcp_echo: { c: { source: 'int kolm_run(){return 0;}' }, rust: { source: 'fn run(input: &str) -> String { String::new() }' } } },
  };
  const out = compileNativeTargets(ct, {
    toolchains: { c: null, rust: null, wasm: fakeWasm }, // wasm tool exists
    // compileWasm omitted — must default to disabled
  });
  assert.equal(out.bundle.recipes.rcp_echo.wasm, undefined, 'no wasm entry when opt-out');
  assert.match(out.bundle.skipped.wasm, /WASM compilation disabled/);
});

test('wave 155: KOLM_COMPILE_WASM_ONLY=1 disables both C and Rust native paths', async () => {
  const fakeToolchains = {
    c: { compiler: 'cc', version: 'cc fake 1.0', path: 'cc' },
    rust: { compiler: 'rustc', version: 'rustc fake 1.0', path: 'rustc' },
    wasm: null, // not detected — still want the gate-logic side-effect tested
  };
  const ct = {
    spec: 'rule-dsl-v1',
    single_recipe: true,
    targets: ['c', 'rust'],
    recipes: { rcp_echo: { c: { source: 'int kolm_run(){return 0;}' }, rust: { source: 'fn run(){}' } } },
  };
  const out = compileNativeTargets(ct, {
    toolchains: fakeToolchains,
    wasmOnly: true,
  });
  assert.equal(out.bundle.recipes.rcp_echo.c, null, 'c nulled when wasmOnly=true');
  assert.equal(out.bundle.recipes.rcp_echo.rust, null, 'rust nulled when wasmOnly=true');
  assert.match(out.bundle.skipped.c, /KOLM_COMPILE_WASM_ONLY=1/);
  assert.match(out.bundle.skipped.rust, /KOLM_COMPILE_WASM_ONLY=1/);
});

test('wave 155: compileWasm=true real toolchain — bundles .wasm + wasm32-wasi target_triple in manifest + bundle pin', { skip: !HAS_WASM ? 'no wasm32-wasi toolchain on this host' : false }, async () => {
  if (!HAS_WASM) return;
  const spec = echoSpec('job_wave155_wasm_real_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    compileWasm: true,
  });
  const zip = new AdmZip(built.outPath);
  const manifest = JSON.parse(zip.getEntries().find(e => e.entryName === 'manifest.json').getData().toString('utf8'));
  const ct = manifest.compiled_targets;
  const wb = ct.recipes.rcp_echo.wasm.bin;
  assert.ok(wb, 'wasm.bin block present when wasm toolchain available + opted-in');
  assert.equal(wb.bin_filename, 'native.wasm');
  assert.equal(wb.target_triple, 'wasm32-wasi');
  assert.ok(['rust', 'c'].includes(wb.source_kind));
  assert.match(wb.bin_hash, /^[0-9a-f]{64}$/);
  assert.ok(wb.bytes > 0);
  assert.equal(wb.source_date_epoch, 0);
  assert.match(wb.toolchain_version_hash, /^[0-9a-f]{64}$/);
  assert.match(wb.flags, /--target=wasm32-wasi/);
  // Bundle-level pin includes wasm.
  assert.ok(ct.target_toolchain_pin.wasm);
  assert.equal(ct.target_toolchain_pin.wasm.target_triple, 'wasm32-wasi');
  assert.equal(ct.target_toolchain_pin.wasm.source_date_epoch, 0);
  // Bundled bytes re-hash matches manifest claim.
  const bin = zip.getEntries().find(e => e.entryName === 'native.wasm');
  assert.ok(bin, 'native.wasm present in zip');
  const recomputed = crypto.createHash('sha256').update(bin.getData()).digest('hex');
  assert.equal(recomputed, wb.bin_hash);
  // WASM magic number 0x00 0x61 0x73 0x6D.
  const data = bin.getData();
  assert.equal(data[0], 0x00);
  assert.equal(data[1], 0x61);
  assert.equal(data[2], 0x73);
  assert.equal(data[3], 0x6D);
});

test('wave 155: WASM flags include strict deterministic posture matching Wave 153 native rustc set', { skip: !HAS_WASM || (T.wasm && T.wasm.source_kind !== 'rust') ? 'no rustc wasm32-wasi on this host' : false }, async () => {
  if (!HAS_WASM || T.wasm.source_kind !== 'rust') return;
  const spec = echoSpec('job_wave155_wasm_flags_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, { outDir: TMP, outPath: out, compileWasm: true });
  const zip = new AdmZip(built.outPath);
  const manifest = JSON.parse(zip.getEntries().find(e => e.entryName === 'manifest.json').getData().toString('utf8'));
  const wb = manifest.compiled_targets.recipes.rcp_echo.wasm.bin;
  assert.match(wb.flags, /-C opt-level=3/);
  assert.match(wb.flags, /-C codegen-units=1/);
  assert.match(wb.flags, /-C lto=fat/);
  assert.match(wb.flags, /-C strip=symbols/);
  assert.match(wb.flags, /-C panic=abort/);
  assert.match(wb.flags, /SOURCE_DATE_EPOCH=0/);
});

test('wave 155: in-process determinism — same source compiled to WASM twice yields identical bin_hash', { skip: !HAS_WASM ? 'no wasm toolchain on this host' : false }, async () => {
  if (!HAS_WASM) return;
  const baseCt = {
    spec: 'rule-dsl-v1',
    single_recipe: true,
    targets: ['c', 'rust'],
    recipes: {
      rcp_echo: {
        c: { source: 'char* kolm_run(const char* in){ static char buf[64]; snprintf(buf,sizeof buf,"{\\"echo\\":\\"%s\\"}",in?in:""); return buf; }' },
        rust: { source: 'fn run(input: &str) -> String { format!("{{\\"echo\\":\\"{}\\"}}", input) }' },
      },
    },
  };
  const ct1 = JSON.parse(JSON.stringify(baseCt));
  const ct2 = JSON.parse(JSON.stringify(baseCt));
  const a = compileNativeTargets(ct1, { compileWasm: true });
  const b = compileNativeTargets(ct2, { compileWasm: true });
  const ha = a.bundle.recipes.rcp_echo.wasm?.bin_hash;
  const hb = b.bundle.recipes.rcp_echo.wasm?.bin_hash;
  if (ha && hb) {
    assert.equal(ha, hb, 'WASM bin_hash deterministic across two in-process runs');
  }
});

test('wave 154: in-process determinism — same source compiled twice yields identical bin_hash', { skip: !HAS_CC && !HAS_RUSTC ? 'no cc/rustc on this host' : false }, async () => {
  if (!HAS_CC && !HAS_RUSTC) return;
  // Two independent compileNativeTargets runs with the same compiled_targets
  // input. Sources are identical bytes. Toolchain is identical. Flags pin
  // every reproducibility-affecting compiler option (Wave 153 + 154).
  // Therefore bin_hash should match across runs on the same machine.
  const baseCt = {
    spec: 'rule-dsl-v1',
    single_recipe: true,
    targets: ['c', 'rust'],
    recipes: {
      rcp_echo: {
        c: { source: 'char* kolm_run(const char* in){ static char buf[64]; snprintf(buf,sizeof buf,"{\\"echo\\":\\"%s\\"}",in?in:""); return buf; }' },
        rust: { source: 'fn run(input: &str) -> String { format!("{{\\"echo\\":\\"{}\\"}}", input) }' },
      },
    },
  };
  // We need to deep-clone between runs because compileNativeTargets reads
  // recipes[rid].{c,rust}.source — no mutation, but defensive.
  const ct1 = JSON.parse(JSON.stringify(baseCt));
  const ct2 = JSON.parse(JSON.stringify(baseCt));
  const a = compileNativeTargets(ct1);
  const b = compileNativeTargets(ct2);
  if (HAS_CC) {
    const ha = a.bundle.recipes.rcp_echo.c?.bin_hash;
    const hb = b.bundle.recipes.rcp_echo.c?.bin_hash;
    if (ha && hb) {
      assert.equal(ha, hb, 'C bin_hash deterministic across two in-process runs');
    }
  }
  if (HAS_RUSTC) {
    const ha = a.bundle.recipes.rcp_echo.rust?.bin_hash;
    const hb = b.bundle.recipes.rcp_echo.rust?.bin_hash;
    if (ha && hb) {
      assert.equal(ha, hb, 'Rust bin_hash deterministic across two in-process runs');
    }
  }
});

// ---------------------------------------------------------------------------
// Wave 156 §P+4 — verifier check #13 "Build reproducibility".
// `kolm verify` opts into deterministic rebuild via KOLM_VERIFY_REBUILD=1.
// Default behaviour stays fast: check #13 reports "warn — skipped" and the
// cheap bin_hash re-check in check #12 still runs.
// ---------------------------------------------------------------------------

test('wave 156: check #13 reports warn-skipped when KOLM_VERIFY_REBUILD is unset', { skip: !HAS_CC && !HAS_RUSTC ? 'no cc/rustc on this host' : false }, async () => {
  if (!HAS_CC && !HAS_RUSTC) return;
  const spec = echoSpec('job_wave156_default_skip_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, { outDir: TMP, outPath: out, compileNative: true });
  // Ensure opt-in is OFF for this test.
  const prior = process.env.KOLM_VERIFY_REBUILD;
  delete process.env.KOLM_VERIFY_REBUILD;
  try {
    const r = await buildBinder(built.outPath);
    const repro = r.checks.find(c => c.name === 'Build reproducibility');
    assert.ok(repro, 'check #13 fires when bin claims exist');
    assert.equal(repro.status, 'warn', repro.detail);
    assert.match(repro.detail, /skipped/);
    assert.match(repro.detail, /KOLM_VERIFY_REBUILD=1/);
  } finally {
    if (prior !== undefined) process.env.KOLM_VERIFY_REBUILD = prior;
  }
});

test('wave 156: check #13 absent when artifact has no native binaries', async () => {
  const spec = echoSpec('job_wave156_no_native_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  // No compileNative: artifact has source bodies but no .bin claims.
  const built = await compileSpec(spec, { outDir: TMP, outPath: out });
  const prior = process.env.KOLM_VERIFY_REBUILD;
  process.env.KOLM_VERIFY_REBUILD = '1';
  try {
    const r = await buildBinder(built.outPath);
    const repro = r.checks.find(c => c.name === 'Build reproducibility');
    assert.equal(repro, undefined, 'check #13 skipped when no bin claims exist');
  } finally {
    if (prior === undefined) delete process.env.KOLM_VERIFY_REBUILD;
    else process.env.KOLM_VERIFY_REBUILD = prior;
  }
});

test('wave 156: check #13 passes when KOLM_VERIFY_REBUILD=1 and bundled binary matches deterministic rebuild', { skip: !HAS_CC && !HAS_RUSTC ? 'no cc/rustc on this host' : false }, async () => {
  if (!HAS_CC && !HAS_RUSTC) return;
  const spec = echoSpec('job_wave156_pass_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, { outDir: TMP, outPath: out, compileNative: true });
  const prior = process.env.KOLM_VERIFY_REBUILD;
  process.env.KOLM_VERIFY_REBUILD = '1';
  try {
    const r = await buildBinder(built.outPath);
    const repro = r.checks.find(c => c.name === 'Build reproducibility');
    assert.ok(repro, 'check #13 fires when bin claims exist');
    assert.equal(repro.status, 'pass', repro.detail);
    assert.match(repro.detail, /rebuilt deterministically/);
  } finally {
    if (prior === undefined) delete process.env.KOLM_VERIFY_REBUILD;
    else process.env.KOLM_VERIFY_REBUILD = prior;
  }
});

test('wave 156: check #13 fails when KOLM_VERIFY_REBUILD=1 and bundled binary was tampered post-seal', { skip: !HAS_CC && !HAS_RUSTC ? 'no cc/rustc on this host' : false }, async () => {
  if (!HAS_CC && !HAS_RUSTC) return;
  const spec = echoSpec('job_wave156_fail_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, { outDir: TMP, outPath: out, compileNative: true });
  // Tamper the bundled binary so the rebuilt hash mismatches. Same rewrite
  // strategy as the check #12 tamper test.
  const archiver = (await import('archiver')).default;
  const zip = new AdmZip(built.outPath);
  const entries = new Map();
  for (const e of zip.getEntries()) entries.set(e.entryName, e.getData());
  const targetName = entries.has('native.c.bin') ? 'native.c.bin' : 'native.rust.bin';
  const original = entries.get(targetName);
  const tampered = Buffer.from(original);
  tampered[Math.min(8, tampered.length - 1)] ^= 0xff;
  entries.set(targetName, tampered);
  // Patch manifest.compiled_targets.recipes.rcp_echo.{c,rust}.bin.bin_hash so
  // the cheap check #12 *passes* with the new bytes — that isolates check #13
  // as the gate that catches the tamper. (Without this, check #12 fires first
  // and check #13 also fires; we want check #13 specifically.)
  const manifestEntry = entries.get('manifest.json');
  const manifest = JSON.parse(manifestEntry.toString('utf8'));
  const isC = targetName === 'native.c.bin';
  const newHash = crypto.createHash('sha256').update(tampered).digest('hex');
  if (isC) manifest.compiled_targets.recipes.rcp_echo.c.bin.bin_hash = newHash;
  else manifest.compiled_targets.recipes.rcp_echo.rust.bin.bin_hash = newHash;
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(built.outPath);
    const z = archiver('zip', { zlib: { level: 9 } });
    z.on('warning', (e) => { if (e.code !== 'ENOENT') reject(e); });
    z.on('error', reject);
    ws.on('close', resolve);
    z.pipe(ws);
    for (const [name, buf] of entries) z.append(buf, { name });
    z.finalize();
  });
  const prior = process.env.KOLM_VERIFY_REBUILD;
  process.env.KOLM_VERIFY_REBUILD = '1';
  try {
    const r = await buildBinder(built.outPath);
    const repro = r.checks.find(c => c.name === 'Build reproducibility');
    assert.ok(repro, 'check #13 fires when bin claims exist');
    assert.equal(repro.status, 'fail', repro.detail);
    assert.match(repro.detail, /rebuilt hash differs/);
  } finally {
    if (prior === undefined) delete process.env.KOLM_VERIFY_REBUILD;
    else process.env.KOLM_VERIFY_REBUILD = prior;
  }
});

test('wave 156: rebuildBinaryFromSource is exported and exercises C/Rust/WASM dispatch', { skip: !HAS_CC && !HAS_RUSTC && !HAS_WASM ? 'no toolchain on this host' : false }, async () => {
  if (!HAS_CC && !HAS_RUSTC && !HAS_WASM) return;
  const { rebuildBinaryFromSource } = await import('../src/native-compile.js');
  assert.equal(typeof rebuildBinaryFromSource, 'function', 'rebuildBinaryFromSource exported');
  // Unknown kind throws.
  assert.throws(() => rebuildBinaryFromSource({ kind: 'nope', sourceText: '', toolchain: { compiler: 'x' }, recipeId: 'r' }), /unknown kind/);
  // Smoke-exercise whichever path the host supports. We don't assert hash
  // equality here — the deterministic-rebuild assertion lives in check #13's
  // pass test above. We just confirm dispatch returns a buffer.
  if (HAS_CC) {
    const r = rebuildBinaryFromSource({
      kind: 'c',
      sourceText: 'char* kolm_run(const char* in){ static char buf[64]; snprintf(buf,sizeof buf,"{\\"echo\\":\\"%s\\"}",in?in:""); return buf; }',
      toolchain: T.c,
      recipeId: 'rcp_smoke',
    });
    assert.ok(Buffer.isBuffer(r.bin), 'C rebuild returns Buffer');
    assert.ok(r.bin.length > 0, 'C rebuild bin nonempty');
  }
  if (HAS_RUSTC) {
    const r = rebuildBinaryFromSource({
      kind: 'rust',
      sourceText: 'fn run(input: &str) -> String { format!("{{\\"echo\\":\\"{}\\"}}", input) }',
      toolchain: T.rust,
      recipeId: 'rcp_smoke',
    });
    assert.ok(Buffer.isBuffer(r.bin), 'Rust rebuild returns Buffer');
    assert.ok(r.bin.length > 0, 'Rust rebuild bin nonempty');
  }
});
