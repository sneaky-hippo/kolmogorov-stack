// W266 — native LoRA / INT4 / ONNX / GGUF compile targets surfaced
// end-to-end. W287-W290 wired the runtime DISPATCH (artifact-runner.js can
// route to js/wasm/native/gguf/onnx). What was missing: the *compile-time*
// catalog the CLI + manifest schema + UI agree on. Until now `kolm compile
// --target=gguf` had nothing to validate against and the manifest's
// `runtime_target` field could land mis-spelled with no error.
//
// W266 closes the gap with a single source-of-truth module:
//   - COMPILE_TARGETS — frozen array of canonical target slugs
//   - COMPILE_TARGET_INFO — per-target descriptor (family, runtime_target,
//     required_artifact_fields, typical_use_case, description)
//   - validateCompileTarget(target, manifest) — throws when target is
//     unknown OR when manifest is missing required fields for that target
//   - inferCompileTarget(manifest) — extracts target from a manifest's
//     runtime_target / quantization / weights_file hints
//   - describeCompileTarget(target) — UI-facing description (used by
//     /compile, /pricing, /docs)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPILE_TARGETS,
  COMPILE_TARGET_INFO,
  validateCompileTarget,
  inferCompileTarget,
  describeCompileTarget,
} from '../src/compile-targets.js';

test('W266 COMPILE_TARGETS frozen + canonical list', () => {
  assert.ok(Array.isArray(COMPILE_TARGETS));
  assert.ok(Object.isFrozen(COMPILE_TARGETS));
  for (const t of ['js', 'wasm', 'native', 'gguf', 'onnx', 'lora', 'int4']) {
    assert.ok(COMPILE_TARGETS.includes(t), `missing canonical target: ${t}`);
  }
});

test('W266 COMPILE_TARGET_INFO has one entry per target', () => {
  for (const t of COMPILE_TARGETS) {
    const info = COMPILE_TARGET_INFO[t];
    assert.ok(info, `missing info for target: ${t}`);
    assert.ok(typeof info.family === 'string', `${t}.family must be string`);
    assert.ok(typeof info.runtime_target === 'string', `${t}.runtime_target must be string`);
    assert.ok(Array.isArray(info.required_artifact_fields), `${t}.required_artifact_fields must be array`);
    assert.ok(typeof info.description === 'string' && info.description.length > 10);
    assert.ok(typeof info.typical_use_case === 'string');
  }
});

test('W266 every target maps to a runtime_target supported by the runner', () => {
  const validRuntimes = ['js', 'wasm', 'native', 'gguf', 'onnx'];
  for (const t of COMPILE_TARGETS) {
    const info = COMPILE_TARGET_INFO[t];
    assert.ok(validRuntimes.includes(info.runtime_target), `${t} maps to invalid runtime_target ${info.runtime_target}`);
  }
});

test('W266 validateCompileTarget throws on unknown target', () => {
  assert.throws(() => validateCompileTarget('python', {}), /unknown.*target|not.*supported/i);
  assert.throws(() => validateCompileTarget('', {}), /target.*required|missing/i);
});

test('W266 validateCompileTarget enforces required artifact fields for gguf', () => {
  assert.throws(
    () => validateCompileTarget('gguf', { runtime_target: 'gguf' }),
    /gguf_path|required/i,
  );
  assert.equal(
    validateCompileTarget('gguf', {
      runtime_target: 'gguf',
      runtime_target_config: { gguf_path: 'model.gguf' },
    }),
    true,
  );
});

test('W266 validateCompileTarget enforces required artifact fields for onnx', () => {
  assert.throws(
    () => validateCompileTarget('onnx', { runtime_target: 'onnx' }),
    /onnx_path|required/i,
  );
  assert.equal(
    validateCompileTarget('onnx', {
      runtime_target: 'onnx',
      runtime_target_config: { onnx_path: 'model.onnx' },
    }),
    true,
  );
});

test('W266 validateCompileTarget enforces required fields for lora', () => {
  assert.throws(() => validateCompileTarget('lora', {}), /lora|adapter|required/i);
  assert.equal(
    validateCompileTarget('lora', {
      lora_adapter: { path: 'adapter.safetensors', base_model: 'qwen-2.5-7b' },
    }),
    true,
  );
});

test('W266 validateCompileTarget enforces quantization for int4', () => {
  assert.throws(() => validateCompileTarget('int4', {}), /quantization|int4|required/i);
  assert.equal(
    validateCompileTarget('int4', { quantization: { method: 'int4', source_model: 'qwen' } }),
    true,
  );
});

test('W266 validateCompileTarget passes for js with no extra fields (back-compat)', () => {
  assert.equal(validateCompileTarget('js', {}), true);
});

test('W266 inferCompileTarget reads runtime_target', () => {
  assert.equal(inferCompileTarget({ runtime_target: 'gguf' }), 'gguf');
  assert.equal(inferCompileTarget({ runtime_target: 'onnx' }), 'onnx');
  assert.equal(inferCompileTarget({ runtime_target: 'wasm' }), 'wasm');
  assert.equal(inferCompileTarget({ runtime_target: 'native' }), 'native');
});

test('W266 inferCompileTarget reads quantization int4', () => {
  assert.equal(inferCompileTarget({ quantization: { method: 'int4' } }), 'int4');
});

test('W266 inferCompileTarget reads lora_adapter', () => {
  assert.equal(inferCompileTarget({ lora_adapter: { path: 'x' } }), 'lora');
});

test('W266 inferCompileTarget defaults to js for empty/legacy manifests', () => {
  assert.equal(inferCompileTarget({}), 'js');
  assert.equal(inferCompileTarget(null), 'js');
});

test('W266 describeCompileTarget returns the description from COMPILE_TARGET_INFO', () => {
  const d = describeCompileTarget('gguf');
  assert.ok(d && typeof d === 'object');
  assert.equal(d.id, 'gguf');
  assert.ok(d.description.length > 10);
  assert.ok(d.runtime_target);
});

test('W266 describeCompileTarget returns null for unknown target', () => {
  assert.equal(describeCompileTarget('nope'), null);
});
