// Wave Z — tests for the chat TUI in src/tui-chat.js. The TUI mixes
// pure pieces (parseSlashCommand, wordWrap, renderFrame, formatKolmReceipt)
// with a side-effecting runTuiChat orchestrator. We cover both:
//   - pure functions: lots of corner cases, no IO
//   - runTuiChat:    drive it in non-TTY mode (PassThrough streams) so
//                    we can scripted-feed lines + assert behavior

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { compileSpec } from '../src/spec-compile.js';
import {
  parseSlashCommand,
  wordWrap,
  formatKolmReceipt,
  createSession,
  renderHeader,
  renderChat,
  renderComposer,
  renderFrame,
  COMMANDS,
  runTuiChat,
} from '../src/tui-chat.js';

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
    job_id: `job_tui_${name}`,
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
}

// ---------------------------------------------------------------------------
// Pure: parseSlashCommand
// ---------------------------------------------------------------------------
test('parseSlashCommand: bare text is a message', () => {
  assert.deepEqual(parseSlashCommand('hello there'), { kind: 'message', text: 'hello there' });
  assert.deepEqual(parseSlashCommand(''),           { kind: 'message', text: '' });
  assert.deepEqual(parseSlashCommand(null),         { kind: 'message', text: '' });
});

test('parseSlashCommand: lone slash command with no args', () => {
  const r = parseSlashCommand('/help');
  assert.equal(r.kind, 'command');
  assert.equal(r.name, 'help');
  assert.equal(r.args, '');
});

test('parseSlashCommand: command with args (trims, lowercases name)', () => {
  const r = parseSlashCommand('/MODEL  kolm:echo   ');
  assert.equal(r.kind, 'command');
  assert.equal(r.name, 'model');
  assert.equal(r.args, 'kolm:echo');
});

test('parseSlashCommand: command with multi-token args preserves internal spacing', () => {
  const r = parseSlashCommand('/system you are a careful assistant');
  assert.equal(r.name, 'system');
  assert.equal(r.args, 'you are a careful assistant');
});

// ---------------------------------------------------------------------------
// Pure: wordWrap
// ---------------------------------------------------------------------------
test('wordWrap: lines shorter than width pass through', () => {
  assert.deepEqual(wordWrap('hello', 10), ['hello']);
  assert.deepEqual(wordWrap('one two three', 30), ['one two three']);
});

test('wordWrap: long lines wrap on word boundaries', () => {
  const out = wordWrap('the quick brown fox jumped', 12);
  for (const ln of out) assert.ok(ln.length <= 12, `line "${ln}" exceeds 12: len=${ln.length}`);
  assert.equal(out.join(' ').replace(/\s+/g, ' ').trim(), 'the quick brown fox jumped');
});

test('wordWrap: ultra-long word is hard-broken to width', () => {
  const out = wordWrap('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 8);
  for (const ln of out) assert.ok(ln.length <= 8);
});

test('wordWrap: preserves explicit blank lines', () => {
  const out = wordWrap('a\n\nb', 5);
  assert.deepEqual(out, ['a', '', 'b']);
});

// ---------------------------------------------------------------------------
// Pure: formatKolmReceipt
// ---------------------------------------------------------------------------
test('formatKolmReceipt: prints recipe + sha + latency + k_score', () => {
  const s = formatKolmReceipt({
    artifact_sha256: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    recipe_id: 'rcp_echo',
    latency_us: 123,
    k_score: { composite: 0.91 },
  });
  assert.match(s, /rcp_echo/);
  assert.match(s, /sha256:abcdef012345/);
  assert.match(s, /123µs/);
  assert.match(s, /k=0\.91/);
});

test('formatKolmReceipt: handles null/missing receipt cleanly', () => {
  assert.equal(formatKolmReceipt(null), '');
  assert.equal(formatKolmReceipt(undefined), '');
});

// ---------------------------------------------------------------------------
// Pure: renderHeader / renderChat / renderComposer
// ---------------------------------------------------------------------------
test('renderHeader: contains model + status', () => {
  const s = createSession({ model: 'kolm:echo' });
  const h = renderHeader(s, 80);
  assert.match(h, /kolm chat/);
  assert.match(h, /kolm:echo/);
  // The default state is ready.
  assert.match(h, /ready/);
});

test('renderHeader: surfaces research topic when active', () => {
  const s = createSession();
  s.research = { topic: 'pharmacy denials', file: '/tmp/x.jsonl' };
  const h = renderHeader(s, 100);
  assert.match(h, /research/);
  assert.match(h, /pharmacy denials/);
});

test('renderChat: empty history pads to height', () => {
  const s = createSession();
  const out = renderChat(s, 60, 5);
  assert.equal(out.split('\n').length, 5, 'always exactly height rows');
});

test('renderChat: renders user + assistant messages with kolm footer', () => {
  const s = createSession();
  s.messages.push({ role: 'user', content: 'hi' });
  s.messages.push({
    role: 'assistant',
    content: 'hello there',
    modelLabel: 'kolm:echo',
    kolm: { artifact_sha256: 'sha256:deadbeef'.padEnd(71, '0'), recipe_id: 'rcp_echo', latency_us: 12, k_score: 0.9 },
  });
  const out = renderChat(s, 60, 20);
  assert.match(out, /you/);
  assert.match(out, /hi/);
  assert.match(out, /assistant|kolm:echo/);
  assert.match(out, /hello there/);
  assert.match(out, /rcp_echo/);
  assert.match(out, /sha256:deadbeef/);
});

test('renderComposer: shows hint when buffer empty, message when busy/error', () => {
  const s = createSession();
  const c1 = renderComposer(s, 60);
  assert.match(c1, /\/help/);
  s.status.lastError = 'boom';
  const c2 = renderComposer(s, 60);
  assert.match(c2, /boom/);
});

test('renderFrame: composes to header + chat + composer', () => {
  const s = createSession();
  const f = renderFrame(s, 80, 24);
  assert.ok(f.includes('kolm chat'));
  assert.ok(f.includes('/help'));
});

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------
test('COMMANDS.help returns reply with command list', () => {
  const s = createSession();
  const r = COMMANDS.help(s, '');
  assert.match(r.reply, /\/model/);
  assert.match(r.reply, /\/quit/);
  assert.match(r.reply, /kolm-path:/);
});

test('COMMANDS.model with no args returns error', () => {
  const s = createSession();
  const r = COMMANDS.model(s, '');
  assert.ok(r.error);
});

test('COMMANDS.model switches the active model', () => {
  const s = createSession({ model: 'kolm:a' });
  const r = COMMANDS.model(s, 'kolm:b');
  assert.equal(s.model, 'kolm:b');
  assert.match(r.reply, /kolm:b/);
});

test('COMMANDS.open registers a real artifact', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-tui-'));
  try {
    const ap = await buildEchoArtifact(dir, 'echo');
    const s = createSession();
    const r = COMMANDS.open(s, ap);
    assert.match(r.reply, /loaded echo/);
    assert.equal(s.artifacts.echo, ap);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('COMMANDS.open errors when file missing', () => {
  const s = createSession();
  const r = COMMANDS.open(s, '/no/such/file.kolm');
  assert.ok(r.error);
});

test('COMMANDS.artifacts lists registered artifacts', () => {
  const s = createSession();
  s.artifacts['foo'] = '/tmp/foo.kolm';
  const r = COMMANDS.artifacts(s);
  assert.match(r.reply, /foo/);
});

test('COMMANDS.system sets / clears system prompt', () => {
  const s = createSession();
  COMMANDS.system(s, 'be cool');
  assert.equal(s.systemPrompt, 'be cool');
  COMMANDS.system(s, '');
  assert.equal(s.systemPrompt, '');
});

test('COMMANDS.clear empties history', () => {
  const s = createSession();
  s.messages.push({ role: 'user', content: 'x' });
  COMMANDS.clear(s);
  assert.equal(s.messages.length, 0);
});

test('COMMANDS.save writes JSONL', () => {
  const s = createSession();
  s.messages.push({ role: 'user', content: 'hi' });
  s.messages.push({ role: 'assistant', content: 'hello', modelLabel: 'kolm:x' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-tui-save-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    const r = COMMANDS.save(s, file);
    assert.match(r.reply, /saved 2 messages/);
    const text = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(text.length, 2);
    assert.equal(JSON.parse(text[0]).content, 'hi');
    assert.equal(JSON.parse(text[1]).content, 'hello');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('COMMANDS.research opens a file and records start event', () => {
  const s = createSession();
  const before = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-tui-research-'));
  try {
    process.chdir(dir);
    const r = COMMANDS.research(s, 'pharmacy denial rate study');
    assert.match(r.reply, /research mode on/);
    assert.ok(s.research && s.research.topic === 'pharmacy denial rate study');
    const text = fs.readFileSync(s.research.file, 'utf8');
    const evt = JSON.parse(text.split('\n').filter(Boolean)[0]);
    assert.equal(evt.event, 'research_start');
    assert.equal(evt.topic, 'pharmacy denial rate study');
  } finally {
    process.chdir(before);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('COMMANDS.quit returns quit flag', () => {
  const r = COMMANDS.quit();
  assert.equal(r.quit, true);
});

// ---------------------------------------------------------------------------
// Orchestrator: runTuiChat in non-TTY mode
//
// In non-TTY mode (which is what our PassThrough streams report), the TUI
// degrades to a plain prompt/reply loop. We can feed lines into stdin and
// scrape stdout for the assistant's reply text.
// ---------------------------------------------------------------------------
test('runTuiChat: round-trip /help then a kolm chat turn then /quit', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-tui-rt-'));
  try {
    const ap = await buildEchoArtifact(dir, 'echo');
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = '';
    output.on('data', (b) => { captured += b.toString('utf8'); });

    const done = runTuiChat({
      input, output,
      opts: { model: 'kolm:echo', registryDirs: [dir] },
    });

    const send = (s) => input.write(s + '\n');
    send('/help');
    send('hello kolm');
    // Wait a tick for the async run to land.
    await new Promise(r => setTimeout(r, 300));
    send('/quit');
    await done;

    // /help reply was rendered.
    assert.match(captured, /\/quit/);
    // The chat turn produced an echo reply.
    assert.match(captured, /hello kolm/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('runTuiChat: /open then /artifacts then /quit (no chat)', withSecret(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-tui-rt2-'));
  try {
    const ap = await buildEchoArtifact(dir, 'echo');
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = '';
    output.on('data', (b) => { captured += b.toString('utf8'); });

    const done = runTuiChat({
      input, output,
      opts: { model: 'kolm:echo', registryDirs: [dir] },
    });

    input.write(`/open ${ap}\n`);
    await new Promise(r => setTimeout(r, 50));
    input.write('/artifacts\n');
    await new Promise(r => setTimeout(r, 50));
    input.write('/quit\n');
    await done;

    assert.match(captured, /loaded echo/);
    assert.match(captured, /echo -> /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('runTuiChat: unknown command surfaces error', withSecret(async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let captured = '';
  output.on('data', (b) => { captured += b.toString('utf8'); });
  const done = runTuiChat({ input, output, opts: { model: 'kolm:echo' } });
  input.write('/blarg\n');
  await new Promise(r => setTimeout(r, 50));
  input.write('/quit\n');
  await done;
  assert.match(captured, /unknown command/);
}));
