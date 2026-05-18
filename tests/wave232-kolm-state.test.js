// W232 — git-native .kolm-state directory + checkpoint/import-chat/merge.
// Behavior tests; uses a scratch project dir under os.tmpdir() so we never
// touch the real ~/.kolm/* or the repo's own .kolm-state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function modUrl(rel) {
  return pathToFileURL(path.join(ROOT, rel)).href;
}

function scratch() {
  const dir = path.join(os.tmpdir(), 'kolm-state-test-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('W232 module surface — exports expected names', async () => {
  const m = await import(modUrl('src/kolm-state.js'));
  for (const name of [
    'STATE_DIRNAME', 'SUBDIRS', 'VALID_SOURCES',
    'stateRoot', 'ensureState',
    'createCheckpoint', 'listCheckpoints', 'getCheckpoint',
    'importChat', 'mergeRecipes',
  ]) {
    assert.ok(name in m, `missing export ${name}`);
  }
  assert.equal(m.STATE_DIRNAME, '.kolm-state');
  assert.deepEqual(m.SUBDIRS, ['checkpoints', 'imports', 'merges']);
  assert.deepEqual(m.VALID_SOURCES, ['claude', 'chatgpt', 'jsonl']);
});

test('W232 ensureState creates layout under .kolm-state', async () => {
  const m = await import(modUrl('src/kolm-state.js'));
  const proj = scratch();
  m.ensureState(proj);
  for (const sub of m.SUBDIRS) {
    const p = path.join(proj, '.kolm-state', sub);
    assert.ok(fs.existsSync(p) && fs.statSync(p).isDirectory(), `missing ${sub}`);
  }
});

test('W232 checkpoint create snapshots .kolm artifacts at project root', async () => {
  const m = await import(modUrl('src/kolm-state.js'));
  const proj = scratch();
  fs.writeFileSync(path.join(proj, 'recipe-a.kolm'), 'hello world');
  fs.writeFileSync(path.join(proj, 'recipe-b.kolm'), 'second artifact');
  const manifest = m.createCheckpoint({ projectDir: proj, label: 'first' });
  assert.equal(manifest.items.length, 2);
  assert.ok(manifest.id.match(/^\d{8}T\d{6}Z-[0-9a-f]{12}$/), `bad id ${manifest.id}`);
  const head = fs.readFileSync(path.join(proj, '.kolm-state', 'HEAD'), 'utf8');
  assert.equal(head, manifest.id);
  const ckDir = path.join(proj, '.kolm-state', 'checkpoints', manifest.id);
  assert.ok(fs.existsSync(path.join(ckDir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(ckDir, 'artifacts.txt')));
});

test('W232 checkpoint hash is deterministic for identical state', async () => {
  const m = await import(modUrl('src/kolm-state.js'));
  const p1 = scratch();
  const p2 = scratch();
  fs.writeFileSync(path.join(p1, 'r.kolm'), 'same bytes');
  fs.writeFileSync(path.join(p2, 'r.kolm'), 'same bytes');
  const m1 = m.createCheckpoint({ projectDir: p1 });
  const m2 = m.createCheckpoint({ projectDir: p2 });
  // short hash segment (after the timestamp) should match
  const h1 = m1.id.split('-').pop();
  const h2 = m2.id.split('-').pop();
  assert.equal(h1, h2, `expected identical short hash, got ${h1} vs ${h2}`);
});

test('W232 listCheckpoints returns all checkpoints in id order', async () => {
  const m = await import(modUrl('src/kolm-state.js'));
  const proj = scratch();
  fs.writeFileSync(path.join(proj, 'a.kolm'), 'a');
  const m1 = m.createCheckpoint({ projectDir: proj });
  fs.writeFileSync(path.join(proj, 'b.kolm'), 'b');
  const m2 = m.createCheckpoint({ projectDir: proj });
  const all = m.listCheckpoints(proj);
  assert.equal(all.length, 2);
  const ids = all.map(x => x.id);
  assert.ok(ids.includes(m1.id) && ids.includes(m2.id));
});

test('W232 import-chat parses canonical jsonl format', async () => {
  const m = await import(modUrl('src/kolm-state.js'));
  const proj = scratch();
  const inFile = path.join(proj, 'seeds.jsonl');
  fs.writeFileSync(inFile,
    JSON.stringify({ prompt: 'hi', response: 'hello' }) + '\n' +
    JSON.stringify({ prompt: 'who?', response: 'kolm' }) + '\n',
    'utf8'
  );
  const r = m.importChat(inFile, { projectDir: proj, source: 'jsonl', namespace: 'demo' });
  assert.equal(r.pairs_imported, 2);
  assert.equal(r.source, 'jsonl');
  assert.equal(r.namespace, 'demo');
  assert.ok(fs.existsSync(r.file));
  const lines = fs.readFileSync(r.file, 'utf8').trim().split(/\n/);
  assert.equal(lines.length, 2);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.namespace, 'demo');
});

test('W232 import-chat parses claude export format', async () => {
  const m = await import(modUrl('src/kolm-state.js'));
  const proj = scratch();
  const inFile = path.join(proj, 'claude.json');
  const exportObj = {
    conversations: [
      {
        uuid: 'c1',
        chat_messages: [
          { sender: 'human', text: 'what is kolm' },
          { sender: 'assistant', text: 'an AI compiler' },
          { sender: 'human', text: 'and the artifact' },
          { sender: 'assistant', text: 'a .kolm file' },
        ],
      },
    ],
  };
  fs.writeFileSync(inFile, JSON.stringify(exportObj), 'utf8');
  const r = m.importChat(inFile, { projectDir: proj, source: 'claude' });
  assert.equal(r.pairs_imported, 2);
});

test('W232 import-chat rejects unknown source', async () => {
  const m = await import(modUrl('src/kolm-state.js'));
  const proj = scratch();
  const inFile = path.join(proj, 'x.jsonl');
  fs.writeFileSync(inFile, '{}\n');
  assert.throws(() => m.importChat(inFile, { projectDir: proj, source: 'bogus' }),
    /unknown source/);
});

test('W232 merge with no evaluator records head_wins strategy', async () => {
  const m = await import(modUrl('src/kolm-state.js'));
  const proj = scratch();
  const a = path.join(proj, 'base.kolm'); fs.writeFileSync(a, 'AAA');
  const b = path.join(proj, 'head.kolm'); fs.writeFileSync(b, 'BBB');
  const r = m.mergeRecipes(a, b, { projectDir: proj });
  assert.equal(r.strategy, 'head_wins');
  assert.equal(r.evaluator, null);
  assert.ok(fs.existsSync(r.output), 'merge output file should exist');
  assert.ok(fs.existsSync(r.manifest_file), 'merge manifest should exist');
});

test('W232 merge with --evaluator switches strategy + records hash', async () => {
  const m = await import(modUrl('src/kolm-state.js'));
  const proj = scratch();
  const a = path.join(proj, 'base.kolm'); fs.writeFileSync(a, 'AAA');
  const b = path.join(proj, 'head.kolm'); fs.writeFileSync(b, 'BBB');
  const e = path.join(proj, 'eval.json'); fs.writeFileSync(e, JSON.stringify({ axes: ['accuracy'] }));
  const r = m.mergeRecipes(a, b, { projectDir: proj, evaluator: e });
  assert.equal(r.strategy, 'evaluator_decides');
  assert.ok(r.evaluator);
  assert.equal(r.evaluator.sha256.length, 64);
});

test('W232 merge writes byte-different output than head', async () => {
  const m = await import(modUrl('src/kolm-state.js'));
  const proj = scratch();
  const a = path.join(proj, 'base.kolm'); fs.writeFileSync(a, 'A');
  const b = path.join(proj, 'head.kolm'); fs.writeFileSync(b, 'BBBBB');
  const r = m.mergeRecipes(a, b, { projectDir: proj });
  const headBytes = fs.readFileSync(b);
  const outBytes = fs.readFileSync(r.output);
  assert.ok(outBytes.length > headBytes.length, 'output should append a stamp');
  assert.ok(outBytes.subarray(0, headBytes.length).equals(headBytes),
    'output should start with head bytes');
});

test('W232 CLI dispatcher routes checkpoint / import-chat / merge', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.match(cli, /case 'checkpoint':\s*await withErrorContext\('checkpoint',\s*\(\) => cmdCheckpoint/);
  assert.match(cli, /case 'import-chat':\s*await withErrorContext\('import-chat',\s*\(\) => cmdImportChat/);
  assert.match(cli, /case 'merge':\s*await withErrorContext\('merge',\s*\(\) => cmdMerge/);
});

test('W232 COMPLETION_VERBS includes checkpoint, import-chat, merge', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'kolm.js'), 'utf8');
  const m = cli.match(/const COMPLETION_VERBS = \[([\s\S]*?)\];/);
  const verbs = [...m[1].matchAll(/'([a-z-]+)'/g)].map(x => x[1]);
  for (const v of ['checkpoint', 'import-chat', 'merge']) {
    assert.ok(verbs.includes(v), `COMPLETION_VERBS missing ${v}`);
  }
});

test('W232 COMPLETION_SUBS.checkpoint has create/list/show', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'kolm.js'), 'utf8');
  const m = cli.match(/checkpoint:\s*\[([^\]]+)\]/);
  assert.ok(m, 'checkpoint subs not found');
  const subs = [...m[1].matchAll(/'([a-z-]+)'/g)].map(x => x[1]);
  for (const s of ['create', 'list', 'show']) {
    assert.ok(subs.includes(s), `checkpoint subs missing ${s}`);
  }
});
