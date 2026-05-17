// Wave Y — smoke tests for the OpenAI-compatible HTTP server in
// scripts/completions-server.mjs. We spawn the server on a random port,
// hit it with raw http requests (no openai SDK), and verify the
// round-trip works end-to-end. This is the test that proves a tenant
// pointing the openai npm package at us will get a valid response.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';

import { compileSpec } from '../src/spec-compile.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'completions-server.mjs');
const SECRET = 'kolm-public-fixture-v0-1-0';

async function buildEchoArtifact(targetDir, name = 'echo') {
  const before = process.env.RECIPE_RECEIPT_SECRET;
  process.env.RECIPE_RECEIPT_SECRET = SECRET;
  try {
    const spec = {
      job_id: `job_completions_server_${name}`,
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
        { id: 'a', input: { text: 'alpha' }, expected: { echo: 'alpha' } },
        { id: 'b', input: { text: 'bravo' }, expected: { echo: 'bravo' } },
        { id: 'c', input: { text: 'charlie' }, expected: { echo: 'charlie' } },
      ]},
    };
    const outPath = path.join(targetDir, `${name}.kolm`);
    await compileSpec(spec, { outPath });
    return outPath;
  } finally {
    if (before === undefined) delete process.env.RECIPE_RECEIPT_SECRET;
    else process.env.RECIPE_RECEIPT_SECRET = before;
  }
}

// Spawn the server on an OS-picked port, return a handle with the chosen
// port + a kill() method. Resolves once `listening on http://...:PORT`
// shows up on stderr.
function spawnServer({ port, registry, apiKey } = {}) {
  return new Promise((resolve, reject) => {
    const argv = [SCRIPT];
    if (port != null) argv.push(`--port=${port}`);
    if (registry) argv.push(`--registry=${registry}`);
    if (apiKey) argv.push(`--api-key=${apiKey}`);
    const env = { ...process.env, RECIPE_RECEIPT_SECRET: SECRET };
    // Force kolm: prefix bridges not to call any real upstream during tests.
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    const proc = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`server did not announce within 5s; stderr=${stderr}`));
    }, 5000);
    proc.stderr.on('data', (b) => {
      stderr += b.toString();
      const m = stderr.match(/listening on http:\/\/[^:]+:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({
          proc,
          port: Number(m[1]),
          stderr: () => stderr,
          kill: () => new Promise((r) => { proc.once('close', r); proc.kill(); }),
        });
      }
    });
    proc.on('error', (e) => { clearTimeout(timeout); reject(e); });
    proc.on('close', (code) => {
      if (code != null && code !== 0) {
        // Don't reject if we've already resolved; this fires after kill() too.
        clearTimeout(timeout);
      }
    });
  });
}

function httpRequest({ port, method, path: pth, body, headers }) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pth,
      headers: {
        'content-type': 'application/json',
        'content-length': data ? Buffer.byteLength(data) : 0,
        ...(headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { /* leave raw */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function httpStream({ port, method, path: pth, body }) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pth,
      headers: {
        'content-type': 'application/json',
        'content-length': data ? Buffer.byteLength(data) : 0,
        'accept': 'text/event-stream',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c.toString('utf8')));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: chunks.join('') });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('completions-server: /healthz returns ok JSON', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-srv-'));
  await buildEchoArtifact(tmp);
  const srv = await spawnServer({ port: 0, registry: tmp });
  try {
    const r = await httpRequest({ port: srv.port, method: 'GET', path: '/healthz' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(typeof r.json.ts === 'number');
  } finally {
    await srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('completions-server: GET /v1/models lists the kolm artifact in the registry', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-srv-'));
  await buildEchoArtifact(tmp, 'echo');
  const srv = await spawnServer({ port: 0, registry: tmp });
  try {
    const r = await httpRequest({ port: srv.port, method: 'GET', path: '/v1/models' });
    assert.equal(r.status, 200);
    assert.equal(r.json.object, 'list');
    const ids = r.json.data.map(m => m.id);
    assert.ok(ids.includes('kolm:echo'), 'kolm:echo listed by server');
    assert.ok(ids.includes('anthropic:claude-opus-4-7'));
    assert.ok(ids.includes('openai:gpt-5'));
  } finally {
    await srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('completions-server: POST /v1/chat/completions runs a kolm artifact end-to-end', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-srv-'));
  await buildEchoArtifact(tmp, 'echo');
  const srv = await spawnServer({ port: 0, registry: tmp });
  try {
    const r = await httpRequest({
      port: srv.port,
      method: 'POST',
      path: '/v1/chat/completions',
      body: { model: 'kolm:echo', messages: [{ role: 'user', content: 'roundtrip-ok' }] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.object, 'chat.completion');
    assert.equal(r.json.choices.length, 1);
    assert.match(r.json.choices[0].message.content, /roundtrip-ok/);
    assert.ok(r.json.kolm, 'kolm provenance present');
    assert.match(r.json.kolm.artifact_sha256, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('completions-server: stream=true returns SSE chunks ending in [DONE]', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-srv-'));
  await buildEchoArtifact(tmp, 'echo');
  const srv = await spawnServer({ port: 0, registry: tmp });
  try {
    const r = await httpStream({
      port: srv.port,
      method: 'POST',
      path: '/v1/chat/completions',
      body: { model: 'kolm:echo', messages: [{ role: 'user', content: 'streamy' }], stream: true },
    });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'] || '', /text\/event-stream/);
    assert.ok(r.body.includes('data: '), 'has at least one SSE data line');
    assert.ok(r.body.trim().endsWith('data: [DONE]'), 'ends with [DONE] terminator');
    // The first SSE chunk should JSON-parse and contain our content delta.
    const firstChunk = r.body.split('\n\n').find(b => b.startsWith('data: ') && !b.includes('[DONE]'));
    const obj = JSON.parse(firstChunk.slice('data: '.length));
    assert.equal(obj.object, 'chat.completion.chunk');
    assert.match(obj.choices[0].delta.content, /streamy/);
  } finally {
    await srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('completions-server: optional Bearer auth gates everything except /healthz', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-srv-'));
  await buildEchoArtifact(tmp, 'echo');
  const APIKEY = 'test-bearer-' + Math.random().toString(16).slice(2);
  const srv = await spawnServer({ port: 0, registry: tmp, apiKey: APIKEY });
  try {
    // /healthz always open.
    const h = await httpRequest({ port: srv.port, method: 'GET', path: '/healthz' });
    assert.equal(h.status, 200);
    // /v1/models without auth → 401.
    const r1 = await httpRequest({ port: srv.port, method: 'GET', path: '/v1/models' });
    assert.equal(r1.status, 401);
    assert.equal(r1.json.error.code, 'invalid_api_key');
    // /v1/models with WRONG auth → 401.
    const r2 = await httpRequest({ port: srv.port, method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer not-the-key' } });
    assert.equal(r2.status, 401);
    // /v1/models with right auth → 200.
    const r3 = await httpRequest({ port: srv.port, method: 'GET', path: '/v1/models', headers: { authorization: `Bearer ${APIKEY}` } });
    assert.equal(r3.status, 200);
  } finally {
    await srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('completions-server: 404 on unknown route, 400 on malformed JSON, 4xx on missing model', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-srv-'));
  const srv = await spawnServer({ port: 0, registry: tmp });
  try {
    const r1 = await httpRequest({ port: srv.port, method: 'GET', path: '/v1/nope' });
    assert.equal(r1.status, 404);
    assert.equal(r1.json.error.code, 'not_found');
    // Send raw bad JSON.
    const data = '{ not json';
    const badResp = await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port: srv.port, method: 'POST', path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
      });
      req.write(data); req.end();
    });
    assert.equal(badResp.status, 400);
    // Missing model field.
    const r2 = await httpRequest({
      port: srv.port, method: 'POST', path: '/v1/chat/completions',
      body: { messages: [{ role: 'user', content: 'x' }] },
    });
    assert.equal(r2.status, 400);
    assert.equal(r2.json.error.code, 'invalid_request');
  } finally {
    await srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
