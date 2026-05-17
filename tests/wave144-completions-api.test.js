// Wave Y — tests for the OpenAI-compatible chat completions endpoint in
// src/completions-api.js. We don't need a real Anthropic or OpenAI key to
// test the bridging logic — we just verify (a) the kolm artifact bridge
// runs and produces the right OpenAI-shaped response with the kolm
// sub-block, (b) the model selector resolves kolm:, kolm-path:, and bare
// names correctly, (c) the upstream bridges 503 cleanly when keys are
// missing, and (d) handleListModels surfaces both kolm artifacts and the
// bridge targets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compileSpec } from '../src/spec-compile.js';
import { handleChatCompletion, handleListModels, streamChatCompletion } from '../src/completions-api.js';

const SECRET = 'kolm-public-fixture-v0-1-0';

function withSecret(fn) {
  return async () => {
    const before = process.env.RECIPE_RECEIPT_SECRET;
    process.env.RECIPE_RECEIPT_SECRET = SECRET;
    try { return await fn(); }
    finally {
      if (before === undefined) delete process.env.RECIPE_RECEIPT_SECRET;
      else process.env.RECIPE_RECEIPT_SECRET = before;
    }
  };
}

async function buildEchoArtifact(targetDir, name = 'echo') {
  const spec = {
    job_id: `job_completions_test_${name}`,
    task: 'echo the input text field',
    artifact_class: 'compiled_rule',
    recipes: [{
      id: 'rcp_echo',
      name: 'echo',
      schema: { input: { text: 'string' }, output: { echo: 'string' } },
      dsl: { type: 'rule-dsl-v1', output: { op: 'object', fields: {
        echo: { op: 'field', from: { op: 'input' }, key: 'text' },
      }}},
    }],
    evals: { spec: 'rs-1-evals', cases: [
      { id: 'a', input: { text: 'alpha' },   expected: { echo: 'alpha' } },
      { id: 'b', input: { text: 'bravo' },   expected: { echo: 'bravo' } },
      { id: 'c', input: { text: 'charlie' }, expected: { echo: 'charlie' } },
    ]},
  };
  const outPath = path.join(targetDir, `${name}.kolm`);
  await compileSpec(spec, { outPath });
  return outPath;
}

test('handleChatCompletion: kolm-path: prefix runs an artifact and returns OpenAI shape + kolm sub-block', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-completions-'));
  try {
    const ap = await buildEchoArtifact(dir);
    const resp = await handleChatCompletion({
      model: `kolm-path:${ap}`,
      messages: [{ role: 'user', content: 'alpha' }],
    });
    assert.equal(resp.object, 'chat.completion');
    assert.match(resp.id, /^cmpl-[0-9a-f]+$/, 'id has cmpl- prefix');
    assert.ok(typeof resp.created === 'number', 'created is unix seconds');
    assert.equal(resp.model, `kolm-path:${ap}`);
    assert.ok(Array.isArray(resp.choices) && resp.choices.length === 1, 'one choice');
    assert.equal(resp.choices[0].index, 0);
    assert.equal(resp.choices[0].message.role, 'assistant');
    // echo recipe wraps the input text -> {echo:"alpha"} JSON-stringified.
    assert.match(resp.choices[0].message.content, /alpha/);
    assert.equal(resp.choices[0].finish_reason, 'stop');
    // Usage shape.
    assert.ok(resp.usage && typeof resp.usage.prompt_tokens === 'number');
    assert.ok(typeof resp.usage.completion_tokens === 'number');
    assert.equal(resp.usage.total_tokens, resp.usage.prompt_tokens + resp.usage.completion_tokens);
    // kolm sub-block — the auditable provenance receipt.
    assert.ok(resp.kolm, 'kolm sub-block present');
    assert.equal(resp.kolm.artifact, ap);
    assert.match(resp.kolm.artifact_sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(resp.kolm.recipe_id, 'rcp_echo');
    assert.equal(resp.kolm.recipe_name, 'echo');
    assert.ok(typeof resp.kolm.latency_us === 'number' && resp.kolm.latency_us >= 0);
    assert.ok(resp.kolm.receipt && resp.kolm.receipt.recipe_id === 'rcp_echo');
    assert.ok(resp.kolm.audit && resp.kolm.audit.spec === 'kolm-audit-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('handleChatCompletion: kolm: short-name prefix resolves via registryDirs', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-completions-'));
  try {
    const ap = await buildEchoArtifact(dir, 'echo');
    const resp = await handleChatCompletion(
      { model: 'kolm:echo', messages: [{ role: 'user', content: 'hello' }] },
      { registryDirs: [dir] }
    );
    assert.equal(resp.model, 'kolm:echo');
    assert.equal(resp.kolm.artifact, ap);
    assert.match(resp.choices[0].message.content, /hello/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('handleChatCompletion: bare-name model falls back to kolm registry lookup', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-completions-'));
  try {
    const ap = await buildEchoArtifact(dir, 'echo');
    const resp = await handleChatCompletion(
      { model: 'echo', messages: [{ role: 'user', content: 'world' }] },
      { registryDirs: [dir] }
    );
    // The resolved displayModel rewrites bare -> kolm:.
    assert.equal(resp.model, 'kolm:echo');
    assert.equal(resp.kolm.artifact, ap);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('handleChatCompletion: artifactByName map takes priority over registryDirs', withSecret(async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-completions-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-completions-b-'));
  try {
    const apA = await buildEchoArtifact(dirA, 'echo');
    const apB = await buildEchoArtifact(dirB, 'echo');
    // Even though dirA is on the registry path, the explicit map points at dirB.
    const resp = await handleChatCompletion(
      { model: 'kolm:echo', messages: [{ role: 'user', content: 'pick-b' }] },
      { registryDirs: [dirA], artifactByName: { echo: apB } }
    );
    assert.equal(resp.kolm.artifact, apB);
    assert.notEqual(resp.kolm.artifact, apA);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
}));

test('handleChatCompletion: 400 on missing model, missing messages, unknown bare model', withSecret(async () => {
  await assert.rejects(
    () => handleChatCompletion({ messages: [{ role: 'user', content: 'x' }] }),
    err => err.status === 400 && /model/.test(err.message)
  );
  await assert.rejects(
    () => handleChatCompletion({ model: 'kolm:does-not-exist', messages: [{ role: 'user', content: 'x' }] }, { registryDirs: [] }),
    err => err.status === 404 && err.code === 'artifact_not_found'
  );
  await assert.rejects(
    () => handleChatCompletion({ model: 'echo', messages: [] }, { registryDirs: [] }),
    err => err.status === 400 && /messages/.test(err.message)
  );
  await assert.rejects(
    () => handleChatCompletion({ model: 'totally-unknown-bare-name', messages: [{ role: 'user', content: 'x' }] }, { registryDirs: [] }),
    err => err.status === 400 && err.code === 'invalid_model'
  );
}));

test('handleChatCompletion: 404 on kolm-path: that does not exist', withSecret(async () => {
  await assert.rejects(
    () => handleChatCompletion({
      model: 'kolm-path:/no/such/file/anywhere.kolm',
      messages: [{ role: 'user', content: 'x' }],
    }),
    err => err.status === 404 && err.code === 'artifact_not_found'
  );
}));

test('handleChatCompletion: multi-part user content gets concatenated', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-completions-'));
  try {
    const ap = await buildEchoArtifact(dir);
    const resp = await handleChatCompletion({
      model: `kolm-path:${ap}`,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hello-' },
          { type: 'text', text: 'world' },
        ],
      }],
    });
    assert.match(resp.choices[0].message.content, /hello-world/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('handleChatCompletion: anthropic: prefix without ANTHROPIC_API_KEY returns 503 upstream_unavailable', withSecret(async () => {
  const beforeKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => handleChatCompletion({
        model: 'anthropic:claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      err => err.status === 503 && err.code === 'upstream_unavailable' && /ANTHROPIC_API_KEY/.test(err.message)
    );
    // The claude-* shortcut path should behave identically.
    await assert.rejects(
      () => handleChatCompletion({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      err => err.status === 503 && err.code === 'upstream_unavailable'
    );
  } finally {
    if (beforeKey !== undefined) process.env.ANTHROPIC_API_KEY = beforeKey;
  }
}));

test('handleChatCompletion: openai: prefix without OPENAI_API_KEY returns 503 upstream_unavailable', withSecret(async () => {
  const beforeKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      () => handleChatCompletion({
        model: 'openai:gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      err => err.status === 503 && err.code === 'upstream_unavailable' && /OPENAI_API_KEY/.test(err.message)
    );
    // The gpt-* shortcut path should behave identically.
    await assert.rejects(
      () => handleChatCompletion({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      err => err.status === 503 && err.code === 'upstream_unavailable'
    );
  } finally {
    if (beforeKey !== undefined) process.env.OPENAI_API_KEY = beforeKey;
  }
}));

test('handleListModels: lists kolm artifacts in registry + bridge targets', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-completions-'));
  try {
    await buildEchoArtifact(dir, 'echo');
    await buildEchoArtifact(dir, 'echo2');
    const out = await handleListModels({ registryDirs: [dir] });
    assert.equal(out.object, 'list');
    assert.ok(Array.isArray(out.data));
    const ids = out.data.map(m => m.id);
    assert.ok(ids.includes('kolm:echo'), 'kolm:echo listed');
    assert.ok(ids.includes('kolm:echo2'), 'kolm:echo2 listed');
    // Bridge targets always appear (the actual call will 503 if the key
    // is missing, but listing them lets a discovering client know they
    // exist).
    assert.ok(ids.includes('anthropic:claude-opus-4-7'), 'opus bridge listed');
    assert.ok(ids.includes('anthropic:claude-sonnet-4-6'), 'sonnet bridge listed');
    assert.ok(ids.includes('anthropic:claude-haiku-4-5'), 'haiku bridge listed');
    assert.ok(ids.includes('openai:gpt-5'), 'openai bridge listed');
    // Per-artifact metadata.
    const echoModel = out.data.find(m => m.id === 'kolm:echo');
    assert.equal(echoModel.owned_by, 'kolm');
    assert.match(echoModel.artifact_sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(echoModel.task, 'echo the input text field');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('streamChatCompletion: yields one delta + finish chunk + [DONE] for kolm path', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-completions-'));
  try {
    const ap = await buildEchoArtifact(dir);
    const chunks = [];
    for await (const chunk of streamChatCompletion({
      model: `kolm-path:${ap}`,
      messages: [{ role: 'user', content: 'streamtest' }],
      stream: true,
    })) {
      chunks.push(chunk);
    }
    assert.ok(chunks.length >= 3, 'at least delta + finish + [DONE]');
    assert.ok(chunks[chunks.length - 1] === 'data: [DONE]\n\n', 'terminator chunk');
    // First chunk should be a data: line that contains assistant content.
    assert.ok(chunks[0].startsWith('data: '), 'first chunk is SSE data line');
    const firstObj = JSON.parse(chunks[0].slice('data: '.length).trim());
    assert.equal(firstObj.object, 'chat.completion.chunk');
    assert.equal(firstObj.choices[0].delta.role, 'assistant');
    assert.match(firstObj.choices[0].delta.content, /streamtest/);
    // The kolm provenance hangs off the first chunk so streaming clients
    // see it without waiting for finish.
    assert.ok(firstObj.kolm && firstObj.kolm.artifact === ap);
    // Second chunk should carry the finish_reason + usage tally.
    const finishObj = JSON.parse(chunks[1].slice('data: '.length).trim());
    assert.equal(finishObj.choices[0].finish_reason, 'stop');
    assert.ok(finishObj.usage && finishObj.usage.total_tokens > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('handleChatCompletion: system messages are honored (joined separately, not fed to kolm input)', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-completions-'));
  try {
    const ap = await buildEchoArtifact(dir);
    const resp = await handleChatCompletion({
      model: `kolm-path:${ap}`,
      messages: [
        { role: 'system', content: 'you are a calm assistant' },
        { role: 'user', content: 'last-user-wins' },
        // The kolm bridge uses the LAST user message; an intervening
        // assistant message shouldn't change that.
        { role: 'assistant', content: 'sure' },
        { role: 'user', content: 'final-input' },
      ],
    });
    assert.match(resp.choices[0].message.content, /final-input/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));
