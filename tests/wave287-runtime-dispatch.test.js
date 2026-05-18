// Wave 287 — runtime dispatch layer.
//
// The .kolm format used to assume every artifact was JS-only (the runner
// compiled a recipe via compileJs and ran it in node:vm). W287 adds a
// runtime dispatch table so a .kolm can declare manifest.runtime_target =
// 'js' | 'wasm' | 'native' | 'gguf' | 'onnx' and the runner picks the matching
// per-target runner. Behavior assertions:
//
//   1. dispatchRuntime routes 'js' to the historical recipe-loop path.
//   2. dispatchRuntime throws KOLM_E_UNSUPPORTED_RUNTIME for unknown targets.
//   3. runtimeAvailable is the structural probe used by the binder so a
//      missing dep surfaces as a clean panel, not a thrown error at run time.
//   4. runWasmTarget reads target.wasm from bundle.entries; missing entry
//      throws KOLM_E_TARGET_MISSING.
//   5. runNativeTarget extracts + spawns a binary; node itself is used as
//      the "native" binary to keep the test self-contained.
//   6. runGgufTarget throws KOLM_E_GGUF_RUNTIME_MISSING when llama.cpp is
//      not on PATH and LLAMA_CPP_BIN is unset.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  dispatchRuntime,
  runtimeAvailable,
  SUPPORTED_RUNTIME_TARGETS,
} from '../src/artifact-runner.js';
import { runWasmTarget } from '../src/runners/wasm-runner.js';
import { runNativeTarget } from '../src/runners/native-runner.js';
import { runGgufTarget, detectLlamaCppBin } from '../src/runners/gguf-runner.js';

// ---------------------------------------------------------------------------
// 1. dispatchRuntime routes js -> the JS recipe-loop path.
// ---------------------------------------------------------------------------
test('dispatchRuntime routes runtime_target=js to the JS recipe path', async () => {
  const bundle = {
    manifest: { runtime_target: 'js', k_score: null },
    recipes: {
      recipes: [
        {
          id: 'rcp_upper',
          name: 'upper',
          source: 'function generate(input, lib){ return { upper: String(input.text || "").toUpperCase() }; }',
        },
      ],
    },
    pack: null,
    index: null,
    entries: {},
  };
  const r = await dispatchRuntime(bundle, { text: 'hi' });
  assert.equal(r.runtime, 'js');
  assert.equal(r.output.upper, 'HI');
  assert.equal(r.recipe_id, 'rcp_upper');
  assert.ok(typeof r.latency_us === 'number');
});

test('dispatchRuntime treats missing runtime_target as js (back-compat)', async () => {
  const bundle = {
    manifest: { k_score: null }, // no runtime_target -> default 'js'
    recipes: {
      recipes: [
        { id: 'r', name: 'r', source: 'function generate(input, lib){ return { echoed: input }; }' },
      ],
    },
    pack: null,
    index: null,
    entries: {},
  };
  const r = await dispatchRuntime(bundle, { hi: 1 });
  assert.equal(r.runtime, 'js');
  assert.deepEqual(r.output.echoed, { hi: 1 });
});

// ---------------------------------------------------------------------------
// 2. dispatchRuntime throws on unknown runtime_target.
// ---------------------------------------------------------------------------
test('dispatchRuntime throws KOLM_E_UNSUPPORTED_RUNTIME for unknown target', async () => {
  const bundle = {
    manifest: { runtime_target: 'fortran' },
    recipes: { recipes: [] },
    pack: null, index: null, entries: {},
  };
  let err = null;
  try { await dispatchRuntime(bundle, {}); } catch (e) { err = e; }
  assert.ok(err, 'must throw');
  assert.equal(err.code, 'KOLM_E_UNSUPPORTED_RUNTIME');
  assert.match(err.message, /fortran/);
});

test('SUPPORTED_RUNTIME_TARGETS lists exactly the five targets', () => {
  assert.deepEqual([...SUPPORTED_RUNTIME_TARGETS].sort(), ['gguf', 'js', 'native', 'onnx', 'wasm']);
});

// ---------------------------------------------------------------------------
// 3. runtimeAvailable structural probe.
// ---------------------------------------------------------------------------
test('runtimeAvailable js -> ok:true', () => {
  assert.deepEqual(runtimeAvailable({ runtime_target: 'js' }), { ok: true });
});

test('runtimeAvailable default (no field) -> ok:true (back-compat)', () => {
  assert.deepEqual(runtimeAvailable({}), { ok: true });
});

test('runtimeAvailable wasm -> ok:true (bytes probed at run time)', () => {
  assert.deepEqual(runtimeAvailable({ runtime_target: 'wasm' }), { ok: true });
});

test('runtimeAvailable native without entrypoint.binary -> ok:false', () => {
  const r = runtimeAvailable({ runtime_target: 'native' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /entrypoint\.binary/);
});

test('runtimeAvailable gguf without gguf_path -> ok:false', () => {
  const r = runtimeAvailable({ runtime_target: 'gguf', runtime_target_config: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /gguf_path/);
});

test('runtimeAvailable onnx without onnx_path -> ok:false', () => {
  const r = runtimeAvailable({ runtime_target: 'onnx', runtime_target_config: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /onnx_path/);
});

test('runtimeAvailable unknown -> ok:false', () => {
  const r = runtimeAvailable({ runtime_target: 'cobol' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsupported/);
});

test('runtimeAvailable missing manifest -> ok:false', () => {
  assert.deepEqual(runtimeAvailable(null), { ok: false, reason: 'manifest missing' });
});

// ---------------------------------------------------------------------------
// 4. runWasmTarget — missing target.wasm path.
// ---------------------------------------------------------------------------
test('runWasmTarget throws KOLM_E_TARGET_MISSING when target.wasm absent', async () => {
  const bundle = {
    manifest: { runtime_target: 'wasm' },
    entries: {}, // no target.wasm
  };
  let err = null;
  try { await runWasmTarget(bundle, { x: 1 }); } catch (e) { err = e; }
  assert.ok(err, 'must throw');
  assert.equal(err.code, 'KOLM_E_TARGET_MISSING');
});

test('runWasmTarget throws KOLM_E_TARGET_MISSING when target.wasm is empty buffer', async () => {
  const bundle = {
    manifest: { runtime_target: 'wasm' },
    entries: { 'target.wasm': Buffer.alloc(0) },
  };
  let err = null;
  try { await runWasmTarget(bundle, {}); } catch (e) { err = e; }
  assert.ok(err, 'must throw');
  assert.equal(err.code, 'KOLM_E_TARGET_MISSING');
});

// ---------------------------------------------------------------------------
// 5. runNativeTarget — uses node itself as the "native" binary so the test
//    is self-contained on every host.
// ---------------------------------------------------------------------------
test('runNativeTarget spawns binary, round-trips stdin -> stdout JSON', async () => {
  // The "native binary" is a tiny JS file that we invoke via process.execPath.
  // Since we can't put node into the .kolm zip, we instead make the .kolm
  // entry be the JS script itself and use a tiny shim binary that delegates
  // to node. On non-Windows we can just write a shell script; on Windows we
  // need a .bat or to skip. Cleaner: write the script as the entry and use
  // entrypoint.binary to point at it, then wrap the runner call so the
  // spawned binary path is node + arg. But the runner API expects to spawn
  // exactly one binary. So we cheat by writing a wrapper script that is
  // itself executable.
  //
  // On POSIX: write a shebang script `#!/usr/bin/env node\n<src>` and chmod 0755.
  // On Windows: extension must be .exe per the runner's Windows guard. Since
  // we can't easily produce a Windows exe, we test via the cmd-script path:
  // the runner refuses non-.exe on Windows, so on Windows we test the
  // refusal path and trust the POSIX path for the round-trip behavior.
  if (process.platform === 'win32') {
    // Test the platform refusal: a script without .exe must reject.
    const bundle = {
      manifest: { runtime_target: 'native', entrypoint: { binary: 'recipe.sh' } },
      entries: { 'recipe.sh': Buffer.from('#!/bin/sh\necho {}\n', 'utf8') },
    };
    let err = null;
    try { await runNativeTarget(bundle, {}); } catch (e) { err = e; }
    assert.ok(err, 'must throw on Windows for non-.exe binary');
    assert.equal(err.code, 'KOLM_E_NATIVE_PLATFORM');
    return;
  }
  // POSIX: ship a node shebang script as the "native" binary.
  const scriptSrc = '#!/usr/bin/env node\n' +
    'let buf = "";\n' +
    'process.stdin.on("data", b => buf += b.toString("utf8"));\n' +
    'process.stdin.on("end", () => {\n' +
    '  const input = buf.trim() ? JSON.parse(buf) : null;\n' +
    '  process.stdout.write(JSON.stringify({ echoed: input, pid_was_zero: false }) + "\\n");\n' +
    '});\n';
  const bundle = {
    manifest: { runtime_target: 'native', entrypoint: { binary: 'target/posix/recipe' } },
    entries: { 'target/posix/recipe': Buffer.from(scriptSrc, 'utf8') },
  };
  const r = await runNativeTarget(bundle, { hello: 'world' });
  assert.equal(r.runtime, 'native');
  assert.deepEqual(r.output.echoed, { hello: 'world' });
  assert.ok(r.binary_sha256 && r.binary_sha256.length === 64);
  assert.ok(typeof r.latency_us === 'number');
});

test('runNativeTarget throws KOLM_E_TARGET_MISSING when entrypoint.binary missing', async () => {
  const bundle = { manifest: { runtime_target: 'native' }, entries: {} };
  let err = null;
  try { await runNativeTarget(bundle, {}); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.code, 'KOLM_E_TARGET_MISSING');
});

test('runNativeTarget throws KOLM_E_TARGET_MISSING when binary entry absent', async () => {
  const bundle = {
    manifest: { runtime_target: 'native', entrypoint: { binary: process.platform === 'win32' ? 'missing.exe' : 'missing' } },
    entries: {}, // entry not present
  };
  let err = null;
  try { await runNativeTarget(bundle, {}); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.code, 'KOLM_E_TARGET_MISSING');
});

// ---------------------------------------------------------------------------
// 6. runGgufTarget — KOLM_E_GGUF_RUNTIME_MISSING when llama.cpp absent.
// ---------------------------------------------------------------------------
test('runGgufTarget throws KOLM_E_GGUF_RUNTIME_MISSING when llama.cpp absent', async () => {
  // Skip if the host actually has llama.cpp installed — then the runner
  // would (correctly) try to spawn it. We're only testing the missing-binary
  // path here.
  const prevEnv = process.env.LLAMA_CPP_BIN;
  delete process.env.LLAMA_CPP_BIN;
  try {
    const detected = detectLlamaCppBin();
    if (detected) {
      // Host has llama-cli; we cannot reliably force-miss without altering
      // PATH globally. Assert that the detection at least returned a string
      // and skip the missing-binary assertion.
      assert.ok(typeof detected === 'string');
      return;
    }
    const bundle = {
      manifest: {
        runtime_target: 'gguf',
        runtime_target_config: { gguf_path: 'model.gguf' },
      },
      entries: { 'model.gguf': Buffer.from('GGUF\x00fake-model-bytes-for-test', 'utf8') },
    };
    let err = null;
    try { await runGgufTarget(bundle, 'hello'); } catch (e) { err = e; }
    assert.ok(err, 'must throw');
    assert.equal(err.code, 'KOLM_E_GGUF_RUNTIME_MISSING');
    assert.match(err.message, /llama/i);
  } finally {
    if (prevEnv !== undefined) process.env.LLAMA_CPP_BIN = prevEnv;
  }
});

test('runGgufTarget throws KOLM_E_TARGET_MISSING when gguf_path missing', async () => {
  const bundle = {
    manifest: { runtime_target: 'gguf', runtime_target_config: {} },
    entries: {},
  };
  let err = null;
  try { await runGgufTarget(bundle, 'x'); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.code, 'KOLM_E_TARGET_MISSING');
});

test('runGgufTarget throws KOLM_E_TARGET_MISSING when gguf file bytes absent', async () => {
  const bundle = {
    manifest: { runtime_target: 'gguf', runtime_target_config: { gguf_path: 'model.gguf' } },
    entries: {},
  };
  let err = null;
  try { await runGgufTarget(bundle, 'x'); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.code, 'KOLM_E_TARGET_MISSING');
});

// ---------------------------------------------------------------------------
// dispatchRuntime end-to-end with non-js: unsupported runtime via the missing
// dep path surfaces as KOLM_E_UNSUPPORTED_RUNTIME at the dispatcher (not the
// raw runner code) because dispatch gates on runtimeAvailable first.
// ---------------------------------------------------------------------------
test('dispatchRuntime gates non-js targets on runtimeAvailable', async () => {
  const bundle = {
    manifest: { runtime_target: 'gguf', runtime_target_config: {} }, // no gguf_path
    entries: {},
  };
  let err = null;
  try { await dispatchRuntime(bundle, 'x'); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.code, 'KOLM_E_UNSUPPORTED_RUNTIME');
  assert.match(err.message, /gguf_path/);
});
