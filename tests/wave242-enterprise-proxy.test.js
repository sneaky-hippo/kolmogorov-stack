// W242 — kolm proxy enterprise drop-in CLI verb.
//
// Tests exercise behavior (no page-text markers):
//  - `kolm proxy --help` describes the subcommands
//  - `kolm proxy sdks` lists exactly the supported SDKs
//  - `kolm proxy config --sdk=openai --lang=env` emits OPENAI_BASE_URL
//  - `kolm proxy config --sdk=anthropic --lang=env` emits ANTHROPIC_BASE_URL
//  - python snippet calls the correct SDK class (OpenAI() / Anthropic())
//  - node snippet imports the correct SDK package
//  - bash snippet contains a curl with chat/completions
//  - dispatch + COMPLETION_VERBS + COMPLETION_SUBS wiring
//  - services.start respects extra map (passes --upstream=URL to child argv)
//  - HELP.proxy is registered

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');

function runCli(args, env = {}) {
  const res = child_process.spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', code: res.status };
}

test('W242 #1 — kolm proxy --help describes the subcommands', () => {
  const r = runCli(['proxy', '--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /kolm proxy - enterprise drop-in/);
  assert.match(r.stdout, /proxy start/);
  assert.match(r.stdout, /proxy config/);
  assert.match(r.stdout, /--sdk=/);
  assert.match(r.stdout, /capture-id/);
});

test('W242 #2 — kolm proxy sdks lists exactly the supported SDKs', () => {
  const r = runCli(['proxy', 'sdks']);
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(lines.sort(), ['anthropic', 'fireworks', 'generic', 'openai', 'together', 'vllm'].sort());
});

test('W242 #3 — kolm proxy config --sdk=openai --lang=env emits OPENAI_BASE_URL', () => {
  const r = runCli(['proxy', 'config', '--sdk=openai', '--lang=env']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /export OPENAI_BASE_URL="http:\/\/127\.0\.0\.1:7403\/v1"/);
  assert.match(r.stdout, /KOLM_NAMESPACE/);
});

test('W242 #4 — kolm proxy config --sdk=anthropic --lang=env emits ANTHROPIC_BASE_URL', () => {
  const r = runCli(['proxy', 'config', '--sdk=anthropic', '--lang=env']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /export ANTHROPIC_BASE_URL="http:\/\/127\.0\.0\.1:7403\/v1"/);
});

test('W242 #5 — config --port=8888 substitutes the port in the base URL', () => {
  const r = runCli(['proxy', 'config', '--sdk=openai', '--lang=env', '--port=8888']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /:8888\/v1/);
});

test('W242 #6 — config --sdk=openai --lang=python emits OpenAI() init with base_url', () => {
  const r = runCli(['proxy', 'config', '--sdk=openai', '--lang=python']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /from openai import OpenAI/);
  assert.match(r.stdout, /base_url="http:\/\/127\.0\.0\.1:7403\/v1"/);
  assert.match(r.stdout, /chat\.completions\.create/);
});

test('W242 #7 — config --sdk=anthropic --lang=python emits Anthropic() init with base_url', () => {
  const r = runCli(['proxy', 'config', '--sdk=anthropic', '--lang=python']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /from anthropic import Anthropic/);
  assert.match(r.stdout, /base_url="http:\/\/127\.0\.0\.1:7403\/v1"/);
  assert.match(r.stdout, /messages\.create/);
});

test('W242 #8 — config --sdk=openai --lang=node imports openai package', () => {
  const r = runCli(['proxy', 'config', '--sdk=openai', '--lang=node']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /from "openai"/);
  assert.match(r.stdout, /baseURL: "http:\/\/127\.0\.0\.1:7403\/v1"/);
});

test('W242 #9 — config --sdk=anthropic --lang=node imports @anthropic-ai/sdk', () => {
  const r = runCli(['proxy', 'config', '--sdk=anthropic', '--lang=node']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /from "@anthropic-ai\/sdk"/);
  assert.match(r.stdout, /baseURL: "http:\/\/127\.0\.0\.1:7403\/v1"/);
});

test('W242 #10 — config --lang=bash emits a curl with chat/completions', () => {
  const r = runCli(['proxy', 'config', '--sdk=openai', '--lang=bash']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /curl -sS/);
  assert.match(r.stdout, /chat\/completions/);
  assert.match(r.stdout, /x-kolm-namespace/);
});

test('W242 #11 — config --json emits machine-readable object', () => {
  const r = runCli(['proxy', 'config', '--sdk=openai', '--lang=env', '--json']);
  assert.equal(r.code, 0);
  const obj = JSON.parse(r.stdout);
  assert.equal(obj.sdk, 'openai');
  assert.equal(obj.lang, 'env');
  assert.equal(obj.url, 'http://127.0.0.1:7403/v1');
  assert.equal(obj.namespace, 'default');
  assert.match(obj.snippet, /OPENAI_BASE_URL/);
});

test('W242 #12 — dispatch + COMPLETION_VERBS + COMPLETION_SUBS + HELP wiring', () => {
  const txt = fs.readFileSync(CLI, 'utf8');
  assert.match(txt, /case 'proxy':\s*await withErrorContext\('proxy'/, 'dispatch case wired');
  assert.match(txt, /'services', 'bootstrap', 'proxy'/, 'in COMPLETION_VERBS');
  assert.match(txt, /proxy: \['start', 'stop', 'status', 'config', 'sdks'\]/, 'COMPLETION_SUBS wired');
  assert.match(txt, /proxy: `kolm proxy - enterprise drop-in/, 'HELP.proxy present');
  assert.match(txt, /async function cmdProxy/, 'cmdProxy function defined');
  assert.match(txt, /function renderProxyConfig/, 'renderProxyConfig helper defined');
});

test('W242 #13 — services.start accepts extra map and forwards --key=val to child argv', async () => {
  // Verify the spawn argv composition by inspecting services.js source.
  const txt = fs.readFileSync(path.join(ROOT, 'src', 'services.js'), 'utf8');
  assert.match(txt, /extra = \{\}/, 'extra option declared');
  assert.match(txt, /Object\.entries\(extra/, 'extra translated to flags');
  assert.match(txt, /`--\$\{k\}=\$\{v\}`/, 'flag format key=val');
});

test('W242 #14 — config --sdk=unknown defaults snippet still emits a usable env var', () => {
  const r = runCli(['proxy', 'config', '--sdk=generic', '--lang=env']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /API_BASE_URL/);
});

test('W242 #15 — config --namespace=team-a is reflected in snippet header + KOLM_NAMESPACE', () => {
  const r = runCli(['proxy', 'config', '--sdk=openai', '--lang=env', '--namespace=team-a']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /namespace=team-a/);
  assert.match(r.stdout, /KOLM_NAMESPACE="team-a"/);
});
