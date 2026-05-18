// W234 — chat templates + Qwen Thinking Mode preset embedded in .kolm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function modUrl(rel) {
  return pathToFileURL(path.join(ROOT, rel)).href;
}

test('W234 chat-templates module exports the public surface', async () => {
  const m = await import(modUrl('src/chat-templates.js'));
  for (const n of ['TEMPLATE_REGISTRY_VERSION', 'TEMPLATES', 'TEMPLATE_NAMES',
                   'pickTemplate', 'getTemplate', 'apply', 'manifestBlock']) {
    assert.ok(n in m, `missing export ${n}`);
  }
});

test('W234 registry contains the canonical templates', async () => {
  const m = await import(modUrl('src/chat-templates.js'));
  for (const n of ['chatml', 'qwen-3-thinking', 'llama-3', 'phi-3', 'deepseek-v4', 'plain']) {
    assert.ok(n in m.TEMPLATES, `missing template ${n}`);
    assert.ok(m.TEMPLATES[n].version_id, `template ${n} missing version_id`);
  }
});

test('W234 pickTemplate routes well-known base names to the right template', async () => {
  const m = await import(modUrl('src/chat-templates.js'));
  assert.equal(m.pickTemplate('Qwen/Qwen2.5-3B-Instruct').name, 'chatml');
  assert.equal(m.pickTemplate('meta-llama/Llama-3.1-8B-Instruct').name, 'llama-3');
  assert.equal(m.pickTemplate('microsoft/phi-3-mini').name, 'phi-3');
  assert.equal(m.pickTemplate('DeepSeek-V4-Flash-158B').name, 'deepseek-v4');
  assert.equal(m.pickTemplate('Qwen3-Thinking-30B').name, 'qwen-3-thinking');
  assert.equal(m.pickTemplate('unknown-model-xyz').name, 'plain');
});

test('W234 apply() produces the documented marker strings', async () => {
  const m = await import(modUrl('src/chat-templates.js'));
  const out = m.apply('chatml', [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hello' },
  ]);
  assert.ok(out.includes('<|im_start|>system'), 'chatml must include system marker');
  assert.ok(out.includes('<|im_start|>user'), 'chatml must include user marker');
  assert.ok(out.includes('<|im_start|>assistant'), 'chatml must end with assistant marker');
});

test('W234 qwen-3-thinking wraps the assistant turn with a <thinking> open tag', async () => {
  const m = await import(modUrl('src/chat-templates.js'));
  const out = m.apply('qwen-3-thinking', [{ role: 'user', content: 'why is the sky blue?' }]);
  assert.ok(out.includes('<thinking>'), 'qwen-3-thinking must open <thinking>');
  assert.ok(out.endsWith('<thinking>\n'), 'qwen-3-thinking must end at the thinking scratchpad');
});

test('W234 qwen-3-thinking extractAnswer strips the scratchpad', async () => {
  const m = await import(modUrl('src/chat-templates.js'));
  const t = m.getTemplate('qwen-3-thinking');
  const text = '<thinking>blue because of rayleigh</thinking>\nThe sky is blue.';
  assert.equal(t.extractAnswer(text), 'The sky is blue.');
  assert.equal(t.extractThinking(text), 'blue because of rayleigh');
});

test('W234 manifestBlock includes integrity hash + registry version', async () => {
  const m = await import(modUrl('src/chat-templates.js'));
  const block = m.manifestBlock('chatml');
  assert.equal(block.name, 'chatml');
  assert.equal(block.registry_version, m.TEMPLATE_REGISTRY_VERSION);
  assert.match(block.integrity_hash, /^[0-9a-f]{64}$/);
});

test('W234 manifestBlock honors explicit thinking override', async () => {
  const m = await import(modUrl('src/chat-templates.js'));
  const off = m.manifestBlock('qwen-3-thinking', { thinking: false });
  const on  = m.manifestBlock('qwen-3-thinking', { thinking: true });
  assert.equal(off.thinking, false);
  assert.equal(on.thinking, true);
  // Different content → different hash so verifier check #N catches the change.
  assert.notEqual(off.integrity_hash, on.integrity_hash);
});

test('W234 getTemplate throws on unknown name', async () => {
  const m = await import(modUrl('src/chat-templates.js'));
  assert.throws(() => m.getTemplate('nope'), /unknown chat template/);
});

test('W234 router /v1/compile validates chat_template enum', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/router.js'), 'utf8');
  assert.ok(src.includes('VALID_CHAT_TEMPLATES'), 'router must declare VALID_CHAT_TEMPLATES');
  for (const n of ['chatml', 'qwen-3-thinking', 'llama-3', 'phi-3', 'deepseek-v4', 'plain']) {
    assert.ok(src.includes(`'${n}'`), `router must list chat template ${n}`);
  }
  assert.ok(src.includes('thinking_mode'), 'router must accept thinking_mode');
});

test('W234 createJob signature accepts chat_template + thinking_mode', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/compile.js'), 'utf8');
  const idx = src.indexOf('export function createJob');
  const block = src.slice(idx, idx + 1500);
  assert.ok(block.includes('chat_template'), 'createJob must accept chat_template');
  assert.ok(block.includes('thinking_mode'), 'createJob must accept thinking_mode');
  assert.ok(block.includes('resolveChatTemplateBlock'), 'createJob must call resolveChatTemplateBlock');
});
