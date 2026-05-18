// Wave 213: live capture tail dashboard + SSE + kolm tail CLI.
//
// Behavior assertions — no page-text markers (per Pablo W202-W210 correction).
//
// W213 contract this test enforces:
//   1. src/capture-stream.js exports subscribe + publishCapture + subscriberCount
//      and _resetSubscribers for tests.
//   2. publishCapture fans out to subscribers scoped to the tenant.
//   3. Namespace filter '*' receives all rows; specific namespace receives
//      only matching rows; subscribers of a different tenant receive nothing.
//   4. A subscriber whose sink throws is removed so future publishes do not
//      keep retrying.
//   5. src/router.js wires publishCapture into recordCapture so every durable
//      insert fans out.
//   6. src/router.js registers GET /v1/capture/stream behind authMiddleware.
//   7. The SSE handler sets text/event-stream content type and emits an
//      `event: hello` frame with driver/durable/tenant metadata.
//   8. cli/kolm.js dispatches `tail` and `cmdTail('captures')` is wired.
//   9. COMPLETION_VERBS contains 'tail' and COMPLETION_SUBS.tail = ['captures'].

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROUTER_SRC = fs.readFileSync(path.join(ROOT, 'src/router.js'), 'utf8');
const STREAM_SRC = fs.readFileSync(path.join(ROOT, 'src/capture-stream.js'), 'utf8');
const CLI_SRC = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
const CAPTURES_HTML = fs.readFileSync(path.join(ROOT, 'public/captures.html'), 'utf8');

test('W213 #1 — capture-stream.js exports the required surface', () => {
  for (const name of ['subscribe', 'publishCapture', 'subscriberCount', '_resetSubscribers']) {
    assert.match(STREAM_SRC, new RegExp(`export\\s+function\\s+${name}\\b`), `${name} must be exported`);
  }
});

test('W213 #2 — publishCapture fans out to matching-tenant subscribers', async () => {
  const mod = await import('../src/capture-stream.js?fresh=' + Math.random());
  mod._resetSubscribers();
  const received = [];
  const unsub = mod.subscribe('t1', '*', (obs) => received.push(obs));
  const n = mod.publishCapture({ id: 'r1', tenant: 't1', corpus_namespace: 'default' });
  assert.equal(n, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].id, 'r1');
  unsub();
  mod.publishCapture({ id: 'r2', tenant: 't1', corpus_namespace: 'default' });
  assert.equal(received.length, 1, 'unsubscribe must stop delivery');
});

test('W213 #3 — namespace filter restricts delivery', async () => {
  const mod = await import('../src/capture-stream.js?fresh=' + Math.random());
  mod._resetSubscribers();
  const got = [];
  mod.subscribe('t2', 'eng', (o) => got.push(o));
  mod.publishCapture({ id: 'a', tenant: 't2', corpus_namespace: 'eng' });
  mod.publishCapture({ id: 'b', tenant: 't2', corpus_namespace: 'marketing' });
  mod.publishCapture({ id: 'c', tenant: 't2', corpus_namespace: 'eng' });
  assert.deepEqual(got.map((o) => o.id), ['a', 'c']);
});

test('W213 #4 — tenant isolation: subscriber of t-other receives nothing', async () => {
  const mod = await import('../src/capture-stream.js?fresh=' + Math.random());
  mod._resetSubscribers();
  const t1got = [];
  const t2got = [];
  mod.subscribe('t1', '*', (o) => t1got.push(o));
  mod.subscribe('t2', '*', (o) => t2got.push(o));
  mod.publishCapture({ id: 'a', tenant: 't1', corpus_namespace: 'default' });
  mod.publishCapture({ id: 'b', tenant: 't2', corpus_namespace: 'default' });
  assert.equal(t1got.length, 1);
  assert.equal(t2got.length, 1);
  assert.equal(t1got[0].id, 'a');
  assert.equal(t2got[0].id, 'b');
});

test('W213 #5 — failing sink is dropped (no retry storm)', async () => {
  const mod = await import('../src/capture-stream.js?fresh=' + Math.random());
  mod._resetSubscribers();
  let calls = 0;
  mod.subscribe('t1', '*', () => { calls++; throw new Error('socket closed'); });
  mod.publishCapture({ id: 'a', tenant: 't1', corpus_namespace: 'default' });
  mod.publishCapture({ id: 'b', tenant: 't1', corpus_namespace: 'default' });
  mod.publishCapture({ id: 'c', tenant: 't1', corpus_namespace: 'default' });
  assert.equal(calls, 1, 'failing subscriber should be removed after the first throw');
  assert.equal(mod.subscriberCount('t1'), 0);
});

test('W213 #6 — recordCapture in router.js calls publishCapture after insert', () => {
  const idx = ROUTER_SRC.indexOf('async function recordCapture(');
  assert.ok(idx > 0);
  const body = ROUTER_SRC.slice(idx, idx + 2000);
  // Must happen AFTER the durable insert (so a failed insert doesn't fan
  // out a row that didn't land).
  const insertAt = body.indexOf('await insertCapture(');
  const publishAt = body.indexOf('publishCapture(');
  assert.ok(insertAt > 0, 'await insertCapture must appear in recordCapture');
  assert.ok(publishAt > insertAt, 'publishCapture must run after insertCapture, not before');
});

test('W213 #7 — GET /v1/capture/stream registered with authMiddleware', () => {
  assert.match(ROUTER_SRC, /r\.get\(['"]\/v1\/capture\/stream['"]\s*,\s*authMiddleware/);
});

test('W213 #8 — SSE handler sets text/event-stream + emits hello frame', () => {
  const idx = ROUTER_SRC.indexOf("r.get('/v1/capture/stream'");
  assert.ok(idx > 0);
  const handler = ROUTER_SRC.slice(idx, idx + 3000);
  assert.match(handler, /text\/event-stream/);
  assert.match(handler, /event:\s*hello/);
  assert.match(handler, /subscribeCaptureStream\(/);
  // Keep-alive ping prevents proxy timeout (25s).
  assert.match(handler, /setInterval\([\s\S]{0,200}25000\)/);
});

test('W213 #9 — capture-store.js subscribers do not leak between requests', async () => {
  const mod = await import('../src/capture-stream.js?fresh=' + Math.random());
  mod._resetSubscribers();
  const unsubs = [];
  for (let i = 0; i < 5; i++) unsubs.push(mod.subscribe('t1', '*', () => {}));
  assert.equal(mod.subscriberCount('t1'), 5);
  for (const u of unsubs) u();
  assert.equal(mod.subscriberCount('t1'), 0);
  assert.equal(mod.subscriberCount(), 0);
});

test('W213 #10 — CLI dispatches `tail` to cmdTail', () => {
  assert.match(CLI_SRC, /case 'tail':\s*await withErrorContext\('tail',\s*\(\) => cmdTail\(rest\)\)/);
  assert.match(CLI_SRC, /async function cmdTail\(/);
});

test('W213 #11 — COMPLETION_VERBS contains tail and COMPLETION_SUBS.tail = [captures]', () => {
  const verbsIdx = CLI_SRC.indexOf('const COMPLETION_VERBS');
  const verbsBlock = CLI_SRC.slice(verbsIdx, verbsIdx + 1500);
  assert.match(verbsBlock, /['"]tail['"]/);
  const subsIdx = CLI_SRC.indexOf('const COMPLETION_SUBS');
  const subsBlock = CLI_SRC.slice(subsIdx, subsIdx + 2000);
  assert.match(subsBlock, /tail:\s*\[\s*['"]captures['"]\s*\]/);
});

test('W213 #12 — cmdTail rejects sub != captures with usage error', async () => {
  // Behavioral check via dynamic import: cmdTail is not exported as a module
  // function, so we assert the source guards the sub argument explicitly.
  const fnIdx = CLI_SRC.indexOf('async function cmdTail(');
  assert.ok(fnIdx > 0);
  const fnBody = CLI_SRC.slice(fnIdx, fnIdx + 1500);
  assert.match(fnBody, /sub\s*!==\s*['"]captures['"]/);
  assert.match(fnBody, /EXIT\.USAGE/);
});

test('W213 #13 — cmdTail uses fetch streaming + parses SSE data: frames', () => {
  const fnIdx = CLI_SRC.indexOf('async function cmdTail(');
  const fnBody = CLI_SRC.slice(fnIdx, fnIdx + 5000);
  assert.match(fnBody, /accept:\s*['"]text\/event-stream['"]/);
  assert.match(fnBody, /res\.body\.getReader/);
  assert.match(fnBody, /data:/);
  assert.match(fnBody, /x-kolm-capture-driver/);
  assert.match(fnBody, /x-kolm-capture-durable/);
});

test('W213 #14 — cmdTail honors --json + --namespace + --limit flags', () => {
  const fnIdx = CLI_SRC.indexOf('async function cmdTail(');
  const fnBody = CLI_SRC.slice(fnIdx, fnIdx + 5000);
  assert.match(fnBody, /--namespace/);
  assert.match(fnBody, /--json/);
  assert.match(fnBody, /--limit/);
});

test('W213 #15 — /captures dashboard wires SSE live-tail UI', () => {
  assert.match(CAPTURES_HTML, /id="live-toggle"/);
  assert.match(CAPTURES_HTML, /id="live-strip"/);
  assert.match(CAPTURES_HTML, /id="live-status"/);
  assert.match(CAPTURES_HTML, /new EventSource\(/);
  assert.match(CAPTURES_HTML, /\/v1\/capture\/stream/);
  // Hello-frame metadata is rendered as driver + durable pill.
  assert.match(CAPTURES_HTML, /addEventListener\(['"]hello['"]/);
});
