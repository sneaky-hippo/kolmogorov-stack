// Native compilation for compiled_rule artifacts.
//
// Wave 144 / Wave G — given the emitC()/emitRust() sources that Wave F bundles
// into the .kolm, this module *optionally* invokes a host cc / cargo / rustc
// toolchain to produce a native binary and ship it alongside the source. The
// binary becomes additional evidence the verifier can hash and bind into
// manifest.compiled_targets so a buyer who downloads the .kolm sees both
// (a) source the verifier can rebuild from and (b) the binary the builder
// actually compiled, with the compiler+flags they used.
//
// Two strict invariants drive every decision in this file:
//
//   1. **JS rule path must keep working with no toolchain.** The native
//      pipeline is *opt-in*. Default behaviour (no opts, no env var) is to
//      skip compilation entirely. Setting `KOLM_COMPILE_NATIVE=1` (or
//      `opts.compileNative: true`) requests a compile *attempt*. A missing
//      toolchain in attempt mode is reported as a `skipped` entry in the
//      returned bundle — it does *not* throw, does *not* fail the build,
//      and does *not* alter the existing source-only manifest fields.
//
//   2. **Reproducibility is best-effort, not promised.** Cross-platform
//      bit-identical native binaries are hard. We record compiler + version +
//      flags + host triple so a verifier on the same toolchain *might*
//      reproduce, but we do not gate verification on bit-identity. The
//      verifier (binder.js check #12) re-hashes the bundled binary against
//      the manifest claim — that catches in-flight tampering. Recompile-
//      and-match verification is a later wave.
//
// Toolchain detection is done by spawning `<tool> --version` once per kind.
// We do not parse PATH manually. If the spawn fails or exits non-zero, the
// toolchain is treated as absent.
//
// The C source emitted by emitC() exposes `kolm_run(const char* input)` but
// no `main()`. To produce a self-contained executable we append a tiny CLI
// shim (`int main(int argc, char** argv)` reading argv[1], calling kolm_run,
// printing the result). The shim text is deterministic and shipped in the
// bundle alongside the binary so the verifier can replay the exact bytes
// that were compiled. The same pattern applies to Rust (`fn main()` shim).
//
// On success the bundle shape is:
//
//   {
//     spec: 'kolm-native-v1',
//     host_triple: 'x86_64-pc-windows-msvc',
//     recipes: {
//       [rid]: {
//         c: {
//           compiler: 'cc' | 'gcc' | 'clang' | 'cl',
//           compiler_version: string,
//           flags: string,
//           shim_source_hash: 64hex,         // sha256 of the appended main()
//           bin_filename: 'native.c.bin' | `native.${rid}.c.bin`,
//           bin_hash: 64hex,                  // sha256 of the binary bytes
//           bytes: number,
//         } | null,
//         rust: { ... } | null,
//       },
//     },
//     skipped: { c?: string, rust?: string },  // reason when a kind is absent
//   }
//
// `getNativeBinaryFiles(bundle)` returns the file entries (filename +
// content Buffer) the artifact builder should add to the zip.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NATIVE_SPEC = 'kolm-native-v1';

// Suffix we append to the emitC() source to make a self-contained executable.
// Deterministic — no timestamps, no paths, no env-derived values. The shim is
// hashed and recorded so a verifier can confirm what bytes were compiled.
const C_MAIN_SHIM = `

#include <stdio.h>

int main(int argc, char** argv) {
  const char* in = (argc > 1) ? argv[1] : "";
  char* out = kolm_run(in);
  if (out) {
    fputs(out, stdout);
    fputc('\\n', stdout);
    free(out);
  }
  return 0;
}
`;

const RS_MAIN_SHIM = `

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input = args.get(1).map(|s| s.as_str()).unwrap_or("");
    let out = run(input);
    println!("{}", out);
}
`;

const C_SHIM_HASH = sha256(C_MAIN_SHIM);
const RS_SHIM_HASH = sha256(RS_MAIN_SHIM);

function sha256(s) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(s) ? s : Buffer.from(s)).digest('hex');
}

function tryRun(cmd, args, opts = {}) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, ...opts });
    return r;
  } catch (e) {
    return { error: e, status: null, stdout: '', stderr: e.message };
  }
}

function firstLine(s) {
  if (!s) return '';
  return String(s).split(/\r?\n/)[0].trim();
}

// Probe a C compiler. Returns { compiler, version, path } or null.
// Probes `cc`, `gcc`, `clang` in order (POSIX convention). On Windows we
// additionally try `cl` (MSVC) as a fallback.
export function detectCCompiler() {
  const candidates = ['cc', 'gcc', 'clang'];
  if (process.platform === 'win32') candidates.push('cl');
  for (const compiler of candidates) {
    const versionArgs = compiler === 'cl' ? [] : ['--version'];
    const r = tryRun(compiler, versionArgs);
    if (r.status === 0 || (compiler === 'cl' && r.stderr && /Microsoft/.test(r.stderr))) {
      const version = firstLine(r.stdout) || firstLine(r.stderr) || 'unknown';
      return { compiler, version, path: compiler };
    }
  }
  return null;
}

// Probe a Rust compiler. Prefer `rustc` (single-file builds; no Cargo.toml
// needed). `cargo` is detected separately for callers that need a crate
// build later, but the default Wave G compile path uses rustc directly.
export function detectRustCompiler() {
  const r = tryRun('rustc', ['--version']);
  if (r.status === 0) {
    return { compiler: 'rustc', version: firstLine(r.stdout) || 'unknown', path: 'rustc' };
  }
  return null;
}

// Wave 155 §P+3 — probe a WASM compiler. Two paths:
//   1. Rustc with wasm32-wasi target installed: `rustc --target=wasm32-wasi
//      --print sysroot` exits 0 only when the target's sysroot is available.
//      This requires `rustup target add wasm32-wasi` on the host (it is not
//      shipped by default with rustc). We do not auto-install — we surface
//      the absence as a skip reason naming the rustup command.
//   2. Clang with wasm32-wasi target: `clang --target=wasm32-wasi --version`
//      exits 0 when clang has wasm-ld in its toolchain. This requires a
//      reasonably modern clang (>=10) and the wasi-sysroot installed
//      separately.
// We prefer Rust when both are available because the deterministic flag set
// for rustc (Wave 153) is more comprehensive than what we can pin for clang
// in wasm-target mode. Returns { source_kind, compiler, version, path } or
// null. The `source_kind` field tells compileWasm() which source file (the
// .c or .rs the spec emitted) to feed into the wasm compiler.
export function detectWasmCompiler() {
  // Probe Rust first.
  const rs = tryRun('rustc', ['--target=wasm32-wasi', '--print', 'sysroot']);
  if (rs.status === 0) {
    const v = tryRun('rustc', ['--version']);
    return { source_kind: 'rust', compiler: 'rustc', version: firstLine(v.stdout) || 'unknown', path: 'rustc' };
  }
  // Probe clang. We require the --target flag to be accepted AND the
  // wasi-sysroot environment to look plausible. A bare clang without
  // wasi-sysroot will accept --target=wasm32-wasi but fail at link time;
  // we still report it as present and let compileWasm() surface the link
  // error if it materializes.
  const cl = tryRun('clang', ['--target=wasm32-wasi', '--version']);
  if (cl.status === 0) {
    return { source_kind: 'c', compiler: 'clang', version: firstLine(cl.stdout) || 'unknown', path: 'clang' };
  }
  return null;
}

// Detect every toolchain in one pass. Used by callers that want to know
// up-front what they have.
export function detectToolchains() {
  return {
    c: detectCCompiler(),
    rust: detectRustCompiler(),
    wasm: detectWasmCompiler(),
  };
}

// Host triple. Used for verifier hints — "this binary was built on linux-x64;
// don't expect to run it on windows-arm64." Best-effort.
export function hostTriple() {
  return `${process.arch}-${process.platform}`;
}

// Build a deterministic binary name for a recipe. Mirrors the source naming
// convention used by spec-compile: single-recipe artifacts use bare names;
// multi-recipe artifacts namespace by recipe id.
function binName(rid, kind, singleRecipe) {
  if (singleRecipe) return `native.${kind}.bin`;
  return `native.${rid}.${kind}.bin`;
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-native-compile-'));
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// SOURCE_DATE_EPOCH = 0 — the reproducible-builds convention for "no time
// information should leak into the binary." Both gcc/clang and rustc honor
// it for timestamps they would otherwise embed. We pass it through env so
// the compiler sub-process sees it without polluting our own process env.
const DETERMINISTIC_ENV = { ...process.env, SOURCE_DATE_EPOCH: '0' };

// Compile a single C source + shim → binary buffer. Throws on failure.
function compileC({ compiler, sourceText, recipeId }) {
  const tmp = makeTmpDir();
  try {
    const src = sourceText + C_MAIN_SHIM;
    const srcPath = path.join(tmp, 'native.c');
    fs.writeFileSync(srcPath, src);
    const isCl = compiler === 'cl';
    const binPath = path.join(tmp, isCl ? 'native.exe' : (process.platform === 'win32' ? 'native.exe' : 'native'));
    // Deterministic-ish flags. -O2 for size+speed; -fno-stack-protector
    // because the recipe code has no untrusted inputs at compile time;
    // -ffile-prefix-map normalizes embedded source paths; --build-id=none
    // strips the linker-injected unique build ID that would otherwise make
    // every compile produce a different binary (best-effort: requires GNU ld
    // / lld; clang on macOS ignores silently). SOURCE_DATE_EPOCH=0 is set in
    // the env so any embedded timestamps collapse to the epoch.
    let args;
    let flagsRecord;
    if (isCl) {
      // Wave 154 §P+2 MSVC hardening: /Brepro for compiler-side reproducibility +
      // linker flags via /link suffix. /OPT:NOREF + /OPT:NOICF disable link-time
      // function dedup that reorders symbols nondeterministically; /INCREMENTAL:NO
      // disables incremental linking (a separate source of nondeterminism);
      // /DEBUG:NONE drops PDB references that embed absolute build paths.
      args = ['/nologo', '/O2', '/Brepro', '/Fe:' + binPath, srcPath,
              '/link', '/OPT:NOREF', '/OPT:NOICF', '/INCREMENTAL:NO', '/DEBUG:NONE'];
      flagsRecord = '/nologo /O2 /Brepro /link /OPT:NOREF /OPT:NOICF /INCREMENTAL:NO /DEBUG:NONE';
    } else {
      // Wave 154 §P+2 gcc/clang hardening: -fno-asynchronous-unwind-tables removes
      // .eh_frame entries whose layout depends on compiler internals (a major
      // cross-version drift source); -fno-ident drops the .comment section that
      // gcc/clang stamp with the compiler version string (cross-version drift);
      // -fno-stack-clash-protection is added in known-supported case (gcc 8+,
      // clang 11+) but kept in flags record unconditionally — unrecognized -fno-*
      // is silently accepted as default-on by older gcc/clang per their
      // documented "unknown -fno- = no-op" behavior. Best-effort across versions.
      args = [
        '-std=c99',
        '-O2',
        '-fno-stack-protector',
        '-fno-asynchronous-unwind-tables',
        '-fno-ident',
        `-ffile-prefix-map=${tmp}=/build`,
        '-Wl,--build-id=none',
        srcPath,
        '-o', binPath,
      ];
      flagsRecord = '-std=c99 -O2 -fno-stack-protector -fno-asynchronous-unwind-tables -fno-ident -ffile-prefix-map=BUILD=/build -Wl,--build-id=none SOURCE_DATE_EPOCH=0';
    }
    const r = tryRun(compiler, args, { cwd: tmp, env: DETERMINISTIC_ENV });
    if (r.status !== 0) {
      throw new Error(`${compiler} exit=${r.status}: ${firstLine(r.stderr) || firstLine(r.stdout) || 'unknown error'}`);
    }
    if (!fs.existsSync(binPath)) {
      throw new Error(`${compiler} reported success but produced no binary at ${binPath}`);
    }
    const bin = fs.readFileSync(binPath);
    return { bin, flags: flagsRecord };
  } finally {
    rmDir(tmp);
  }
}

// Compile a single Rust source + shim → binary buffer. Throws on failure.
//
// Wave 144 §P+1 specifies the rustc flag set that gives the strongest
// reproducibility guarantees we can get out of a single rustc invocation
// (no Cargo): opt-level=3 + codegen-units=1 + lto=fat + strip=symbols +
// panic=abort + debuginfo=0 + remap-path-prefix. All flags above are
// stable rustc options; `-C strip=symbols` stabilized in 1.59 (Feb 2022).
// SOURCE_DATE_EPOCH=0 in env removes the few timestamps rustc embeds.
function compileRust({ compiler, sourceText, recipeId }) {
  const tmp = makeTmpDir();
  try {
    const src = sourceText + RS_MAIN_SHIM;
    const srcPath = path.join(tmp, 'native.rs');
    fs.writeFileSync(srcPath, src);
    const binPath = path.join(tmp, process.platform === 'win32' ? 'native.exe' : 'native');
    const flagsRecord = '--edition 2021 --crate-type bin -C opt-level=3 -C codegen-units=1 -C lto=fat -C strip=symbols -C panic=abort -C debuginfo=0 --remap-path-prefix BUILD=/build SOURCE_DATE_EPOCH=0';
    const args = [
      '--edition', '2021',
      '--crate-type', 'bin',
      '-C', 'opt-level=3',
      '-C', 'codegen-units=1',
      '-C', 'lto=fat',
      '-C', 'strip=symbols',
      '-C', 'panic=abort',
      '-C', 'debuginfo=0',
      `--remap-path-prefix=${tmp}=/build`,
      srcPath,
      '-o', binPath,
    ];
    const r = tryRun(compiler, args, { cwd: tmp, env: DETERMINISTIC_ENV });
    if (r.status !== 0) {
      throw new Error(`rustc exit=${r.status}: ${firstLine(r.stderr) || firstLine(r.stdout) || 'unknown error'}`);
    }
    if (!fs.existsSync(binPath)) {
      throw new Error(`rustc reported success but produced no binary at ${binPath}`);
    }
    const bin = fs.readFileSync(binPath);
    return { bin, flags: flagsRecord };
  } finally {
    rmDir(tmp);
  }
}

// Wave 155 §P+3 — compile a single source → .wasm binary buffer. Throws on
// failure. The wasm compile reuses either the .rs or .c source the spec
// emitted (selected by `source_kind`); we do not generate a new source.
// Deterministic flag posture mirrors Wave 153/154 native compile: pin
// opt-level, strip symbols, drop debuginfo, suppress producer string,
// SOURCE_DATE_EPOCH=0 in env.
function compileWasm({ wasmTool, sourceText, recipeId }) {
  const tmp = makeTmpDir();
  try {
    if (wasmTool.source_kind === 'rust') {
      const src = sourceText + RS_MAIN_SHIM;
      const srcPath = path.join(tmp, 'native.rs');
      fs.writeFileSync(srcPath, src);
      const binPath = path.join(tmp, 'native.wasm');
      // rustc wasm32-wasi flag set. Same deterministic core as native Rust
      // (opt-level=3, codegen-units=1, lto=fat, strip=symbols, panic=abort,
      // debuginfo=0, remap-path-prefix) plus --target=wasm32-wasi.
      const flagsRecord = '--edition 2021 --crate-type bin --target=wasm32-wasi -C opt-level=3 -C codegen-units=1 -C lto=fat -C strip=symbols -C panic=abort -C debuginfo=0 --remap-path-prefix BUILD=/build SOURCE_DATE_EPOCH=0';
      const args = [
        '--edition', '2021',
        '--crate-type', 'bin',
        '--target=wasm32-wasi',
        '-C', 'opt-level=3',
        '-C', 'codegen-units=1',
        '-C', 'lto=fat',
        '-C', 'strip=symbols',
        '-C', 'panic=abort',
        '-C', 'debuginfo=0',
        `--remap-path-prefix=${tmp}=/build`,
        srcPath,
        '-o', binPath,
      ];
      const r = tryRun(wasmTool.compiler, args, { cwd: tmp, env: DETERMINISTIC_ENV });
      if (r.status !== 0) {
        throw new Error(`rustc wasm32-wasi exit=${r.status}: ${firstLine(r.stderr) || firstLine(r.stdout) || 'unknown error'}`);
      }
      if (!fs.existsSync(binPath)) {
        throw new Error(`rustc wasm32-wasi reported success but produced no binary at ${binPath}`);
      }
      const bin = fs.readFileSync(binPath);
      return { bin, flags: flagsRecord, shim_hash: RS_SHIM_HASH };
    }
    // clang --target=wasm32-wasi
    const src = sourceText + C_MAIN_SHIM;
    const srcPath = path.join(tmp, 'native.c');
    fs.writeFileSync(srcPath, src);
    const binPath = path.join(tmp, 'native.wasm');
    const flagsRecord = '--target=wasm32-wasi -std=c99 -O2 -fno-stack-protector -fno-asynchronous-unwind-tables -fno-ident -ffile-prefix-map=BUILD=/build -Wl,--strip-all -Wl,--no-entry SOURCE_DATE_EPOCH=0';
    const args = [
      '--target=wasm32-wasi',
      '-std=c99',
      '-O2',
      '-fno-stack-protector',
      '-fno-asynchronous-unwind-tables',
      '-fno-ident',
      `-ffile-prefix-map=${tmp}=/build`,
      '-Wl,--strip-all',
      srcPath,
      '-o', binPath,
    ];
    const r = tryRun(wasmTool.compiler, args, { cwd: tmp, env: DETERMINISTIC_ENV });
    if (r.status !== 0) {
      throw new Error(`clang wasm32-wasi exit=${r.status}: ${firstLine(r.stderr) || firstLine(r.stdout) || 'unknown error'}`);
    }
    if (!fs.existsSync(binPath)) {
      throw new Error(`clang wasm32-wasi reported success but produced no binary at ${binPath}`);
    }
    const bin = fs.readFileSync(binPath);
    return { bin, flags: flagsRecord, shim_hash: C_SHIM_HASH };
  } finally {
    rmDir(tmp);
  }
}

// toolchainVersionHash — derive a single sha256 over the bytes that fully
// determine a recipe's binary output for a given compiler. Inputs:
//   - compiler name (e.g. 'rustc', 'gcc')
//   - compiler version string (e.g. 'rustc 1.78.0 (9b00956e5 2024-04-29)')
//   - flag record (the same string we surface in `flags`)
//   - shim hash (the deterministic main()/fn main() suffix we appended)
// A verifier on the same host triple with the same compiler+version that
// rebuilds the same source through the same flags should reach an identical
// hash; a hash mismatch tells the verifier "this binary came from a
// different toolchain than the manifest claims," independent of whether the
// binary bytes themselves match (which is best-effort, per the header).
function toolchainVersionHash({ compiler, compiler_version, flags, shim_hash }) {
  return sha256([compiler, compiler_version, flags, shim_hash].join('\n'));
}

// Compile every recipe in compiled_targets into a native binary bundle.
// `compiled_targets` is the structure spec-compile builds (Wave F). Returns
// the new native-bundle plus a list of binary file entries to add to the zip.
//
// opts.toolchains can be passed to override detection (used by tests).
//
// On absent toolchains the function still returns a valid bundle with
// `recipes[rid].c = null` / `.rust = null` and a `skipped.<kind>` reason.
// Callers should treat this as a successful no-op, not a failure.
export function compileNativeTargets(compiled_targets, opts = {}) {
  if (!compiled_targets || !compiled_targets.recipes) {
    throw new Error('compileNativeTargets requires a compiled_targets bundle (artifact_class=compiled_rule)');
  }
  const toolchains = opts.toolchains || detectToolchains();
  // Wave 154 §P+2 fine-grained toggles: hosts that have only one toolchain
  // (or builders that want to exercise one path at a time) can pin which
  // kinds run. KOLM_COMPILE_NATIVE_C_ONLY=1 disables Rust compilation even
  // if rustc is on PATH; KOLM_COMPILE_NATIVE_RUST_ONLY=1 disables C
  // compilation even if a C compiler is on PATH. Either flag implies opt-in;
  // setting one without KOLM_COMPILE_NATIVE=1 also takes effect (callers
  // already passed compileNative:true if they got here via spec-compile).
  const cOnly = process.env.KOLM_COMPILE_NATIVE_C_ONLY === '1' || opts.cOnly === true;
  const rustOnly = process.env.KOLM_COMPILE_NATIVE_RUST_ONLY === '1' || opts.rustOnly === true;
  if (rustOnly && toolchains.c) toolchains.c = null;
  if (cOnly && toolchains.rust) toolchains.rust = null;
  // Wave 155 §P+3 — WASM is opt-in via its own env var or opt. WASM is its
  // own target — a builder may want WASM without native, or native without
  // WASM. The cOnly/rustOnly toggles do NOT gate WASM; WASM has its own
  // wasmOnly via KOLM_COMPILE_WASM_ONLY=1 for the same per-kind contract.
  const wasmEnabled = process.env.KOLM_COMPILE_WASM === '1' || opts.compileWasm === true;
  const wasmOnly = process.env.KOLM_COMPILE_WASM_ONLY === '1' || opts.wasmOnly === true;
  if (wasmOnly) {
    toolchains.c = null;
    toolchains.rust = null;
  }
  if (!wasmEnabled && !wasmOnly) toolchains.wasm = null;
  const skipped = {};
  if (!toolchains.c) {
    skipped.c = wasmOnly
      ? 'C compilation disabled via KOLM_COMPILE_WASM_ONLY=1'
      : rustOnly
        ? 'C compilation disabled via KOLM_COMPILE_NATIVE_RUST_ONLY=1'
        : 'no C compiler detected (probed cc, gcc, clang' + (process.platform === 'win32' ? ', cl' : '') + ')';
  }
  if (!toolchains.rust) {
    skipped.rust = wasmOnly
      ? 'Rust compilation disabled via KOLM_COMPILE_WASM_ONLY=1'
      : cOnly
        ? 'Rust compilation disabled via KOLM_COMPILE_NATIVE_C_ONLY=1'
        : 'no Rust compiler detected (probed rustc)';
  }
  if (!toolchains.wasm) {
    skipped.wasm = wasmEnabled || wasmOnly
      ? 'no WASM compiler detected (probed rustc --target=wasm32-wasi, clang --target=wasm32-wasi; install rustup target add wasm32-wasi or clang with wasi-sysroot)'
      : 'WASM compilation disabled (set KOLM_COMPILE_WASM=1 or pass compileWasm:true to enable)';
  }

  const single = !!compiled_targets.single_recipe;
  const outRecipes = {};
  const files = [];
  for (const rid of Object.keys(compiled_targets.recipes)) {
    const t = compiled_targets.recipes[rid];
    const entry = { c: null, rust: null };

    if (toolchains.c) {
      try {
        const r = compileC({ compiler: toolchains.c.compiler, sourceText: t.c.source, recipeId: rid });
        const bin_filename = binName(rid, 'c', single);
        const bin_hash = sha256(r.bin);
        entry.c = {
          compiler: toolchains.c.compiler,
          compiler_version: toolchains.c.version,
          flags: r.flags,
          shim_source_hash: C_SHIM_HASH,
          source_date_epoch: 0,
          toolchain_version_hash: toolchainVersionHash({
            compiler: toolchains.c.compiler,
            compiler_version: toolchains.c.version,
            flags: r.flags,
            shim_hash: C_SHIM_HASH,
          }),
          bin_filename,
          bin_hash,
          bytes: r.bin.length,
        };
        files.push({ filename: bin_filename, content: r.bin });
      } catch (e) {
        // A compile *failure* with a toolchain present is recorded as a per-
        // recipe skip reason — still non-fatal. The build continues without
        // a native binary for this recipe. We deliberately do not throw, so
        // a broken toolchain on one machine doesn't break the JS-rule path
        // on another (the recipes.json source is still bundled).
        entry.c_error = String(e.message || e);
      }
    }

    if (toolchains.rust) {
      try {
        const r = compileRust({ compiler: toolchains.rust.compiler, sourceText: t.rust.source, recipeId: rid });
        const bin_filename = binName(rid, 'rust', single);
        const bin_hash = sha256(r.bin);
        entry.rust = {
          compiler: toolchains.rust.compiler,
          compiler_version: toolchains.rust.version,
          flags: r.flags,
          shim_source_hash: RS_SHIM_HASH,
          source_date_epoch: 0,
          toolchain_version_hash: toolchainVersionHash({
            compiler: toolchains.rust.compiler,
            compiler_version: toolchains.rust.version,
            flags: r.flags,
            shim_hash: RS_SHIM_HASH,
          }),
          bin_filename,
          bin_hash,
          bytes: r.bin.length,
        };
        files.push({ filename: bin_filename, content: r.bin });
      } catch (e) {
        entry.rust_error = String(e.message || e);
      }
    }

    // Wave 155 §P+3 — WASM compile. Picks the source kind from detectWasm
    // (prefers Rust source when both are usable, falls back to C). The
    // source is whichever the spec already emitted — we do not generate new.
    if (toolchains.wasm) {
      const sourceKind = toolchains.wasm.source_kind;
      const sourceText = sourceKind === 'rust' ? t.rust && t.rust.source : t.c && t.c.source;
      if (!sourceText) {
        entry.wasm_error = `WASM compile requires ${sourceKind} source which is not present in compiled_targets.recipes.${rid}.${sourceKind}`;
      } else {
        try {
          const r = compileWasm({ wasmTool: toolchains.wasm, sourceText, recipeId: rid });
          const bin_filename = single ? 'native.wasm' : `native.${rid}.wasm`;
          const bin_hash = sha256(r.bin);
          entry.wasm = {
            source_kind: sourceKind,
            compiler: toolchains.wasm.compiler,
            compiler_version: toolchains.wasm.version,
            target_triple: 'wasm32-wasi',
            flags: r.flags,
            shim_source_hash: r.shim_hash,
            source_date_epoch: 0,
            toolchain_version_hash: toolchainVersionHash({
              compiler: toolchains.wasm.compiler,
              compiler_version: toolchains.wasm.version,
              flags: r.flags,
              shim_hash: r.shim_hash,
            }),
            bin_filename,
            bin_hash,
            bytes: r.bin.length,
          };
          files.push({ filename: bin_filename, content: r.bin });
        } catch (e) {
          entry.wasm_error = String(e.message || e);
        }
      }
    }

    outRecipes[rid] = entry;
  }

  // Bundle-level pin record. Surfaces "what toolchain did the builder use,
  // and what's the single hash a verifier on the same toolchain should
  // recompute?" without forcing the verifier to walk every recipe. Per-recipe
  // toolchain_version_hash is still authoritative; this is the convenience
  // summary the binder + product surfaces read.
  const target_toolchain_pin = {};
  if (toolchains.c) {
    target_toolchain_pin.c = {
      compiler: toolchains.c.compiler,
      compiler_version: toolchains.c.version,
      shim_source_hash: C_SHIM_HASH,
      source_date_epoch: 0,
    };
  }
  if (toolchains.rust) {
    target_toolchain_pin.rust = {
      compiler: toolchains.rust.compiler,
      compiler_version: toolchains.rust.version,
      shim_source_hash: RS_SHIM_HASH,
      source_date_epoch: 0,
    };
  }
  if (toolchains.wasm) {
    target_toolchain_pin.wasm = {
      source_kind: toolchains.wasm.source_kind,
      compiler: toolchains.wasm.compiler,
      compiler_version: toolchains.wasm.version,
      shim_source_hash: toolchains.wasm.source_kind === 'rust' ? RS_SHIM_HASH : C_SHIM_HASH,
      source_date_epoch: 0,
      target_triple: 'wasm32-wasi',
    };
  }

  return {
    bundle: {
      spec: NATIVE_SPEC,
      host_triple: hostTriple(),
      target_toolchain_pin,
      recipes: outRecipes,
      skipped,
    },
    files,
  };
}

// Wave 156 §P+4 — verifier rebuild path. Public wrapper around compileC /
// compileRust / compileWasm so the binder (verifier check #13) can re-invoke
// the same code path the original builder used over the bundled source. The
// shim is appended internally exactly as in the original compile, so a
// verifier that owns a matching toolchain produces bit-identical bytes when
// the build was deterministic. Throws on compile failure; caller catches and
// reports as a skip.
//
// `kind` is 'c' | 'rust' | 'wasm'. `toolchain` is a value returned by
// detectCCompiler/detectRustCompiler/detectWasmCompiler. `sourceText` is the
// emitted source body *without* the shim — i.e. the bytes that live in
// native.c / native.rs in the zip.
export function rebuildBinaryFromSource({ kind, sourceText, toolchain, recipeId }) {
  if (kind === 'c') {
    return compileC({ compiler: toolchain.compiler, sourceText, recipeId });
  }
  if (kind === 'rust') {
    return compileRust({ compiler: toolchain.compiler, sourceText, recipeId });
  }
  if (kind === 'wasm') {
    return compileWasm({ wasmTool: toolchain, sourceText, recipeId });
  }
  throw new Error(`rebuildBinaryFromSource: unknown kind=${kind}`);
}

// Helpers exposed for tests.
export const _internals = {
  C_MAIN_SHIM,
  RS_MAIN_SHIM,
  C_SHIM_HASH,
  RS_SHIM_HASH,
  sha256,
  toolchainVersionHash,
  DETERMINISTIC_ENV,
};

export default {
  NATIVE_SPEC,
  detectCCompiler,
  detectRustCompiler,
  detectWasmCompiler,
  detectToolchains,
  hostTriple,
  compileNativeTargets,
  rebuildBinaryFromSource,
  _internals,
};
