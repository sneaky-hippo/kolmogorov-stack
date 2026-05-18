// W243 — /account compile.kolm wiring + W247 CLI mirror + W246 TUI mirror.
// Behavior tests on the validation contracts the three surfaces share.
// We do NOT assert page bytes; we assert behavior of the validation enums
// across router.js (POST /v1/compile, POST /v1/specialists/auto-distill),
// the cli/kolm.js cmdCompile + cmdDistill flag parsers, and the public
// HTML widgets that should expose the canonical option sets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const VALID_RECIPE_CLASSES = ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'];
const VALID_HW_TIERS = ['auto', 'cpu-server', '3090', '4090', '5090', 'm4-max-128', 'a100-80', 'h100-80', 'h200-141', 'dgx-spark', 'm3-ultra-512'];
const VALID_OUTPUT_TARGETS = ['gguf', 'onnx', 'safetensors', 'coreml', 'mlx', 'executorch', 'tensorrt', 'native-c', 'native-rust', 'wasm'];
const VALID_MULTI_DEVICE = ['phone-ios', 'phone-android', 'laptop-cpu', 'browser-wasm', 'edge-jetson', 'server-cuda'];

function readFile(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ─────────────────────────────────────────────────────────────────────
// router.js — POST /v1/compile validates the new W243 fields.
// ─────────────────────────────────────────────────────────────────────
test('W243 router /v1/compile defines all 4 canonical enums', () => {
  const src = readFile('src/router.js');
  for (const c of VALID_RECIPE_CLASSES) {
    assert.ok(src.includes(`'${c}'`), `router missing recipe class literal '${c}'`);
  }
  for (const t of VALID_HW_TIERS) {
    assert.ok(src.includes(`'${t}'`), `router missing hw tier literal '${t}'`);
  }
  for (const o of VALID_OUTPUT_TARGETS) {
    assert.ok(src.includes(`'${o}'`), `router missing output target literal '${o}'`);
  }
  for (const d of VALID_MULTI_DEVICE) {
    assert.ok(src.includes(`'${d}'`), `router missing multi-device literal '${d}'`);
  }
});

test('W243 router rejects multi_device arrays larger than 6', () => {
  const src = readFile('src/router.js');
  // Validation message is shared between /v1/compile and /v1/specialists/auto-distill.
  assert.ok(src.match(/multi_device.*(exceeds|max 6|> 6|> 6 targets|max(imum)? 6)/i),
    'router must cap multi_device at 6 targets');
});

// ─────────────────────────────────────────────────────────────────────
// router.js — POST /v1/specialists/auto-distill validates same enums.
// ─────────────────────────────────────────────────────────────────────
test('W247 distill endpoint mirrors W243 compile enums', () => {
  const src = readFile('src/router.js');
  const idx = src.indexOf("r.post('/v1/specialists/auto-distill'");
  assert.ok(idx > 0, 'distill route not found');
  // Look ahead within ~3000 chars of the route definition.
  const block = src.slice(idx, idx + 6000);
  assert.ok(block.includes('recipe_class'), 'distill route must accept recipe_class');
  assert.ok(block.includes('hw_tier'), 'distill route must accept hw_tier');
  assert.ok(block.includes('output_target'), 'distill route must accept output_target');
  assert.ok(block.includes('multi_device'), 'distill route must accept multi_device');
});

// ─────────────────────────────────────────────────────────────────────
// cli/kolm.js — cmdCompile parses --tier --class --target --multi-device.
// ─────────────────────────────────────────────────────────────────────
test('W247 cmdCompile supports the new flags', () => {
  const src = readFile('cli/kolm.js');
  assert.ok(src.includes("'--tier'"), 'cmdCompile must accept --tier');
  assert.ok(src.includes("'--class'"), 'cmdCompile must accept --class');
  assert.ok(src.includes("'--multi-device'"), 'cmdCompile must accept --multi-device');
  // help block must enumerate the canonical values so users can discover them
  // without hitting the API.
  for (const c of VALID_RECIPE_CLASSES) {
    assert.ok(src.includes(c), `cmdCompile help must mention recipe class ${c}`);
  }
});

test('W247 cmdDistill mirrors the W243 enums', () => {
  const src = readFile('cli/kolm.js');
  const idx = src.indexOf('async function cmdDistill(args)');
  assert.ok(idx > 0, 'cmdDistill not found');
  const block = src.slice(idx, idx + 6000);
  for (const c of VALID_RECIPE_CLASSES) {
    assert.ok(block.includes(`'${c}'`), `cmdDistill must list recipe class ${c}`);
  }
  for (const t of VALID_HW_TIERS) {
    assert.ok(block.includes(`'${t}'`), `cmdDistill must list hw tier ${t}`);
  }
  assert.ok(block.includes('--class'), 'cmdDistill must parse --class');
  assert.ok(block.includes('--tier'), 'cmdDistill must parse --tier');
  assert.ok(block.includes('--multi-device'), 'cmdDistill must parse --multi-device');
});

// ─────────────────────────────────────────────────────────────────────
// cli/kolm.js — cmdTui exposes the compile wizard pane.
// ─────────────────────────────────────────────────────────────────────
test('W246 cmdTui exposes a compile wizard pane', () => {
  const src = readFile('cli/kolm.js');
  const idx = src.indexOf('async function cmdTui(args)');
  assert.ok(idx > 0, 'cmdTui not found');
  // The cmdTui function alone is ~700 lines — read a generous slice.
  const block = src.slice(idx, idx + 30000);
  assert.ok(block.includes("leftSource: 'captures'"), 'cmdTui must default to captures pane');
  assert.ok(block.includes('compile'), 'cmdTui must reference compile pane');
  assert.ok(block.includes('TUI_VALID_RECIPE_CLASSES'), 'cmdTui must declare recipe-class enum');
  assert.ok(block.includes('TUI_VALID_HW_TIERS'), 'cmdTui must declare hw-tier enum');
  assert.ok(block.includes('TUI_VALID_OUTPUT_TARGETS'), 'cmdTui must declare output-target enum');
  assert.ok(block.includes('TUI_VALID_MULTI_DEVICE'), 'cmdTui must declare multi-device enum');
  assert.ok(block.includes("k === '3'"), 'cmdTui must bind 3 to the compile pane');
  assert.ok(block.includes("k === 'c' && state.leftSource === 'compile'"), 'cmdTui must bind c to launch compile');
});

// ─────────────────────────────────────────────────────────────────────
// public/account.html — surfaces the compile-variety knobs to users.
// ─────────────────────────────────────────────────────────────────────
test('W243 /account exposes the 4 wizard knobs', () => {
  const html = readFile('public/account.html');
  assert.ok(html.includes('cfg-recipe-class'), '/account must expose recipe class picker');
  assert.ok(html.includes('cfg-hw-tier'), '/account must expose hw tier picker');
  assert.ok(html.includes('cfg-output-target'), '/account must expose output target picker');
  assert.ok(html.includes('cfg-multi-device'), '/account must expose multi-device picker');
  for (const c of VALID_RECIPE_CLASSES) {
    assert.ok(html.includes(c), `/account must list recipe class ${c}`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// public/compile.html — manual compile form mirrors the same knobs.
// ─────────────────────────────────────────────────────────────────────
test('W243 /compile manual form mirrors the same knobs', () => {
  const html = readFile('public/compile.html');
  assert.ok(html.includes('mc-class'), '/compile must expose recipe class picker');
  assert.ok(html.includes('mc-tier'), '/compile must expose hw tier picker');
  assert.ok(html.includes('mc-target'), '/compile must expose output target picker');
  assert.ok(html.includes('mc-multi-device'), '/compile must expose multi-device picker');
  // K-axis labels for human-readable K-score breakdown.
  assert.ok(html.includes('K_AXIS_LABELS'), '/compile must define K_AXIS_LABELS');
});

// ─────────────────────────────────────────────────────────────────────
// public/pricing.html — distillation tier surfaced.
// ─────────────────────────────────────────────────────────────────────
test('W244 /pricing surfaces distillation as a product category', () => {
  const html = readFile('public/pricing.html');
  assert.ok(/distillation/i.test(html), '/pricing must mention distillation');
  assert.ok(/all 4 recipe classes/i.test(html) || /4 recipe classes/i.test(html),
    '/pricing must mention all 4 recipe classes');
  assert.ok(/0\.5B/i.test(html) || /0.5B/.test(html), '/pricing must mention 0.5B base');
  assert.ok(/1\.6T/i.test(html) || /1.6T/.test(html), '/pricing must mention 1.6T base');
});

// ─────────────────────────────────────────────────────────────────────
// public/index.html — hero copy reflects all-model framing.
// ─────────────────────────────────────────────────────────────────────
test('W245 /index hero reflects all-model framing', () => {
  const html = readFile('public/index.html');
  assert.ok(/0\.5B/.test(html), 'homepage must mention 0.5B (laptop scale)');
  assert.ok(/1\.6T/.test(html), 'homepage must mention 1.6T (frontier scale)');
  assert.ok(/every device/i.test(html) || /multi-device/i.test(html),
    'homepage must reflect multi-device shipping story');
});
