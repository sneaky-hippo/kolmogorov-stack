// Wave 354 — seeds mining behavior tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  mineFromDir,
  mineFromChat,
  extractPairsFromText,
  parseCsv,
  stripHtml,
  writeRowsJsonl,
} from '../src/seeds-mining.js';

const TMP = path.join(os.tmpdir(), 'kolm-w354-' + crypto.randomBytes(4).toString('hex'));

async function setup() {
  await fs.mkdir(TMP, { recursive: true });
}
async function teardown() {
  try { await fs.rm(TMP, { recursive: true, force: true }); } catch {}
}

test.before(setup);
test.after(teardown);

test('extractPairsFromText: Q:/A: prefix pairs', () => {
  const text = `Q: What is HIPAA?
A: A US law protecting health info.

Q: What is PHI?
A: Protected health information.`;
  const rows = extractPairsFromText(text, 'demo.md');
  assert.equal(rows.length, 2);
  assert.match(rows[0].input, /HIPAA/);
  assert.match(rows[0].output, /US law/);
  assert.match(rows[0].source, /^demo\.md:\d+$/);
});

test('extractPairsFromText: Input/Output pairs and Before/After pairs', () => {
  const text = `Input: hello world
Output: HELLO WORLD

Before: SSN 123-45-6789
After: SSN [PHI_SSN_1]`;
  const rows = extractPairsFromText(text, 'demo.md');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].input, 'hello world');
  assert.equal(rows[0].output, 'HELLO WORLD');
  assert.match(rows[1].input, /123-45-6789/);
});

test('extractPairsFromText: ## Example with paired code blocks', () => {
  const text = '## Example\n\n```\nfoo bar\n```\n\n```\nbaz qux\n```\n';
  const rows = extractPairsFromText(text, 'doc.md');
  assert.ok(rows.length >= 1, 'expected at least one pair');
  assert.equal(rows[0].input, 'foo bar');
  assert.equal(rows[0].output, 'baz qux');
});

test('parseCsv: quoted fields with embedded commas and newlines', () => {
  const csv = `input,output
"hello, world","line1\nline2"
plain,simple`;
  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0], 'hello, world');
  assert.equal(rows[1][1], 'line1\nline2');
  assert.equal(rows[2][0], 'plain');
});

test('stripHtml removes tags and decodes entities', () => {
  const html = '<p>hello <b>world</b></p>&amp;&nbsp;more';
  const t = stripHtml(html);
  assert.match(t, /hello/);
  assert.match(t, /world/);
  assert.match(t, /&/);
  assert.doesNotMatch(t, /<[a-z]+/i);
});

test('mineFromDir: walks .md + .txt + .jsonl + .csv', async () => {
  const dir = path.join(TMP, 'docs');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'notes.md'),
    'Q: What is kolm?\nA: A private AI compiler.\n\nQ: Why?\nA: Compile your task once.\n');
  await fs.writeFile(path.join(dir, 'pairs.jsonl'),
    JSON.stringify({ input: 'translate hi', output: 'hola' }) + '\n' +
    JSON.stringify({ prompt: 'translate cat', completion: 'gato' }) + '\n');
  await fs.writeFile(path.join(dir, 'pairs.csv'),
    'input,output\n"foo bar","FOO BAR"\nhello,HELLO\n');
  await fs.writeFile(path.join(dir, 'nested.txt'),
    'Input: alpha\nOutput: ALPHA\n');
  // Subdir
  const sub = path.join(dir, 'sub');
  await fs.mkdir(sub, { recursive: true });
  await fs.writeFile(path.join(sub, 'sub.md'),
    'Before: secret 99\nAfter: [REDACTED]\n');

  const rows = await mineFromDir(dir);
  assert.ok(rows.length >= 6, `expected >=6 rows, got ${rows.length}`);
  const inputs = rows.map(r => r.input);
  assert.ok(inputs.some(i => /kolm/i.test(i)));
  assert.ok(inputs.some(i => /translate/i.test(i)));
  assert.ok(inputs.some(i => /alpha/i.test(i)));
  // Every row has a source field.
  for (const r of rows) {
    assert.ok(r.source, 'row missing source');
    assert.ok(r.input != null && r.output != null);
  }
});

test('mineFromDir: dedupes identical inputs', async () => {
  const dir = path.join(TMP, 'dupes');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'a.jsonl'),
    JSON.stringify({ input: 'dup', output: 'one' }) + '\n');
  await fs.writeFile(path.join(dir, 'b.jsonl'),
    JSON.stringify({ input: 'dup', output: 'two' }) + '\n');
  const rows = await mineFromDir(dir);
  assert.equal(rows.length, 1);
});

test('mineFromChat: parses ChatGPT-style export with mapping tree', async () => {
  const file = path.join(TMP, 'chatgpt.json');
  const conv = {
    id: 'c1', title: 'demo',
    mapping: {
      'root': { id: 'root', message: null, parent: null, children: ['m1'] },
      'm1':   { id: 'm1', message: { author: { role: 'user' }, content: { parts: ['What is kolm?'] } }, parent: 'root', children: ['m2'] },
      'm2':   { id: 'm2', message: { author: { role: 'assistant' }, content: { parts: ['A private AI compiler.'] } }, parent: 'm1', children: ['m3'] },
      'm3':   { id: 'm3', message: { author: { role: 'user' }, content: { parts: ['Why use it?'] } }, parent: 'm2', children: ['m4'] },
      'm4':   { id: 'm4', message: { author: { role: 'assistant' }, content: { parts: ['To compile your task once.'] } }, parent: 'm3', children: [] },
    },
  };
  await fs.writeFile(file, JSON.stringify([conv]));
  const rows = await mineFromChat(file);
  assert.equal(rows.length, 2);
  assert.match(rows[0].input, /What is kolm/);
  assert.match(rows[0].output, /private AI compiler/);
  assert.match(rows[1].input, /Why use/);
});

test('mineFromChat: parses generic ndjson role/content', async () => {
  const file = path.join(TMP, 'generic.json');
  const arr = [
    { role: 'user', content: 'translate hello' },
    { role: 'assistant', content: 'hola' },
    { role: 'user', content: 'translate cat' },
    { role: 'assistant', content: 'gato' },
  ];
  await fs.writeFile(file, JSON.stringify(arr));
  const rows = await mineFromChat(file);
  assert.equal(rows.length, 2);
  assert.match(rows[0].input, /hello/);
  assert.equal(rows[0].output, 'hola');
});

test('mineFromChat: filters greeting/refusal turns', async () => {
  const file = path.join(TMP, 'filter.json');
  const arr = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there!' },
    { role: 'user', content: 'How do I redact SSNs?' },
    { role: 'assistant', content: "I can't help with that." },
    { role: 'user', content: 'Translate "good morning" to Spanish' },
    { role: 'assistant', content: 'Buenos dias' },
  ];
  await fs.writeFile(file, JSON.stringify(arr));
  const rows = await mineFromChat(file);
  // Only the translate pair survives the filter.
  assert.equal(rows.length, 1);
  assert.match(rows[0].input, /Translate/);
});

test('writeRowsJsonl writes valid JSONL', async () => {
  const file = path.join(TMP, 'out.jsonl');
  await writeRowsJsonl(file, [
    { input: 'a', output: 'A', source: 'x:1' },
    { input: 'b', output: 'B', source: 'x:2', template_hash: 'abc', cluster_count: 3 },
  ]);
  const text = await fs.readFile(file, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  const r1 = JSON.parse(lines[1]);
  assert.equal(r1.input, 'b');
  assert.equal(r1.template_hash, 'abc');
  assert.equal(r1.cluster_count, 3);
});
