// W378 — cloud-sync behavior tests.
//
// Exercises src/cloud-sync.js end-to-end:
//   - 4-state machine (disabled / metadata_only / redacted_only / raw_enabled)
//   - per-privacy-class blocklist
//   - state persistence (~/.kolm/sync/state.json)
//   - audit log (~/.kolm/sync/audit.jsonl)
//   - HTTP push against a fake node:http server (no fetch)
//   - failure modes (unreachable, 500, bad JSON)
//
// Every test gets a fresh KOLM_DATA_DIR + a freshly bound 127.0.0.1:<random>
// fake cloud server so tests can run in parallel.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

// ===================== Isolation helpers =====================

function freshDataDir() {
  const d = path.join(
    os.tmpdir(),
    'kolm-w378-' + process.pid + '-' + Math.random().toString(36).slice(2),
  );
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// IMPORTANT: We share ONE module instance of both cloud-sync and event-store
// across tests. cloud-sync's static import of event-store is bound at first
// load — if we cache-bust cloud-sync we get a DIFFERENT event-store reference
// than `loadEventStore()` returns, and the two views diverge silently
// (seed writes one DB, push reads another). Resetting + per-test KOLM_DATA_DIR
// + KOLM_EVENT_STORE_PATH is enough to isolate state.
async function loadCloudSync() {
  const cs = await import('../src/cloud-sync.js');
  cs._resetForTests();
  return cs;
}

async function loadEventStore() {
  const es = await import('../src/event-store.js');
  es._resetForTests();
  return es;
}

function startFakeCloud(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (body) {
          try { parsed = JSON.parse(body); } catch {}
        }
        handler(req, res, { body, parsed });
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ srv, port, base: 'http://127.0.0.1:' + port });
    });
  });
}

function stopFakeCloud(handle) {
  return new Promise((resolve) => {
    if (!handle || !handle.srv) return resolve();
    try { handle.srv.close(() => resolve()); }
    catch { resolve(); }
  });
}

async function seedEvents(eventStore, ns, rows) {
  const out = [];
  for (const r of rows) {
    const ev = await eventStore.appendEvent({
      tenant_id: 'test-tenant',
      namespace: ns,
      provider: r.provider || 'openai',
      model: r.model || 'gpt-4o-mini',
      prompt_redacted: r.prompt_redacted == null ? 'hello [PHI_NAME_1]' : r.prompt_redacted,
      response_redacted: r.response_redacted == null ? 'hi there' : r.response_redacted,
      raw_prompt_path: r.raw_prompt_path == null ? '/raw/p_' + crypto.randomBytes(4).toString('hex') : r.raw_prompt_path,
      raw_response_path: r.raw_response_path == null ? '/raw/r_' + crypto.randomBytes(4).toString('hex') : r.raw_response_path,
      prompt_tokens: r.prompt_tokens || 10,
      completion_tokens: r.completion_tokens || 4,
      estimated_cost_usd: r.estimated_cost_usd || 0.0001,
      latency_ms: r.latency_ms || 220,
      sensitive_classes: r.sensitive_classes || [],
      sensitive_data_detected: (r.sensitive_classes || []).length > 0,
      redaction_count: (r.sensitive_classes || []).length,
      event_id: r.event_id,
    });
    out.push(ev);
  }
  return out;
}

// Per-test isolation: every test sets its own KOLM_DATA_DIR + HOME before
// importing modules. We DON'T install a global beforeEach because each test
// needs its own dir bound before its dynamic imports.
function withIsolatedEnv() {
  const dir = freshDataDir();
  const prev = {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_API_KEY: process.env.KOLM_API_KEY,
    KOLM_EVENT_STORE_PATH: process.env.KOLM_EVENT_STORE_PATH,
  };
  process.env.KOLM_DATA_DIR = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.KOLM_API_KEY;
  // pin event store to a per-test file so parallel SQLite-WAL doesn't collide
  process.env.KOLM_EVENT_STORE_PATH = path.join(dir, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  return {
    dir,
    restore() {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

// ===================== Tests =====================

test('W378 #1 — default state is "disabled" and shouldSync returns false for any event', async () => {
  const env = withIsolatedEnv();
  try {
    const cs = await loadCloudSync();
    const st = cs.getSyncState();
    assert.equal(st.state, 'disabled');
    assert.equal(st.last_push_at, null);
    assert.equal(st.last_pull_at, null);
    assert.equal(st.namespace, 'default');
    assert.deepEqual(st.classes_blocked_from_sync, []);
    const decision = cs.shouldSync({ sensitive_classes: [] }, st.state, st.classes_blocked_from_sync);
    assert.equal(decision.sync, false);
    assert.equal(decision.reason, 'disabled');
  } finally {
    env.restore();
  }
});

test('W378 #2 — setSyncState validates state enum (rejects "foo")', async () => {
  const env = withIsolatedEnv();
  try {
    const cs = await loadCloudSync();
    assert.throws(
      () => cs.setSyncState({ state: 'foo' }),
      (err) => err instanceof cs.CloudSyncError && /invalid_state/.test(err.message),
      'must throw CloudSyncError on invalid state enum',
    );
    // valid value persists
    const after = cs.setSyncState({ state: 'metadata_only' });
    assert.equal(after.state, 'metadata_only');
  } finally {
    env.restore();
  }
});

test('W378 #3 — setSyncState persists and re-imports cleanly', async () => {
  const env = withIsolatedEnv();
  try {
    const cs = await loadCloudSync();
    cs.setSyncState({
      state: 'redacted_only',
      cloud_base: 'http://127.0.0.1:9999',
      namespace: 'team-shared',
      classes_blocked_from_sync: ['ssn', 'api_key'],
    });
    // Read back getSyncState() — which goes to disk on every call — to confirm
    // round-trip. (We can't re-import via loadCloudSync since that resets the
    // disk; instead we just re-read after the set.)
    const st = cs.getSyncState();
    assert.equal(st.state, 'redacted_only');
    assert.equal(st.cloud_base, 'http://127.0.0.1:9999');
    assert.equal(st.namespace, 'team-shared');
    assert.deepEqual(st.classes_blocked_from_sync.sort(), ['api_key', 'ssn']);
    // And confirm the state.json file actually exists on disk
    const statePath = path.join(env.dir, 'sync', 'state.json');
    assert.ok(fs.existsSync(statePath));
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.state, 'redacted_only');
    assert.deepEqual(onDisk.classes_blocked_from_sync.sort(), ['api_key', 'ssn']);
  } finally {
    env.restore();
  }
});

test('W378 #4 — state=metadata_only strips prompt_redacted/response_redacted from upload', async () => {
  const env = withIsolatedEnv();
  let cloud;
  try {
    let lastPayload = null;
    cloud = await startFakeCloud((req, res, ctx) => {
      lastPayload = ctx.parsed;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    const cs = await loadCloudSync();
    const es = await loadEventStore();
    es._resetForTests();
    cs.setSyncState({ state: 'metadata_only', cloud_base: cloud.base, namespace: 'm-ns' });
    await seedEvents(es, 'm-ns', [{ event_id: 'evt_w378_4_a' }]);
    const result = await cs.pushEvents({ limit: 10 });
    assert.equal(result.pushed, 1);
    assert.ok(lastPayload && Array.isArray(lastPayload.events) && lastPayload.events.length === 1);
    const ev = lastPayload.events[0];
    assert.equal(ev.event_id, 'evt_w378_4_a');
    assert.equal(ev.provider, 'openai');
    assert.equal(ev.prompt_redacted, undefined, 'metadata_only must NOT include prompt_redacted');
    assert.equal(ev.response_redacted, undefined, 'metadata_only must NOT include response_redacted');
    assert.equal(ev.raw_prompt_path, undefined, 'metadata_only must NOT include raw paths');
    assert.equal(ev.sensitive_classes, undefined, 'metadata_only must NOT include sensitive_classes');
  } finally {
    await stopFakeCloud(cloud);
    env.restore();
  }
});

test('W378 #5 — state=redacted_only includes prompt_redacted but NOT raw_prompt_path', async () => {
  const env = withIsolatedEnv();
  let cloud;
  try {
    let lastPayload = null;
    cloud = await startFakeCloud((req, res, ctx) => {
      lastPayload = ctx.parsed;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    const cs = await loadCloudSync();
    const es = await loadEventStore();
    es._resetForTests();
    cs.setSyncState({ state: 'redacted_only', cloud_base: cloud.base, namespace: 'r-ns' });
    await seedEvents(es, 'r-ns', [{
      event_id: 'evt_w378_5_a',
      prompt_redacted: 'patient [PHI_NAME_1] needs MRI',
      response_redacted: 'schedule with [PHI_NAME_1]',
      raw_prompt_path: '/raw/secret-prompt',
      raw_response_path: '/raw/secret-response',
      sensitive_classes: ['name'],
    }]);
    const result = await cs.pushEvents({ limit: 10 });
    assert.equal(result.pushed, 1);
    const ev = lastPayload.events[0];
    assert.equal(ev.prompt_redacted, 'patient [PHI_NAME_1] needs MRI');
    assert.equal(ev.response_redacted, 'schedule with [PHI_NAME_1]');
    assert.deepEqual(ev.sensitive_classes, ['name']);
    assert.equal(ev.raw_prompt_path, undefined, 'redacted_only must NOT include raw_prompt_path');
    assert.equal(ev.raw_response_path, undefined, 'redacted_only must NOT include raw_response_path');
  } finally {
    await stopFakeCloud(cloud);
    env.restore();
  }
});

test('W378 #6 — state=raw_enabled includes raw fields (raw_prompt_path)', async () => {
  const env = withIsolatedEnv();
  let cloud;
  try {
    let lastPayload = null;
    cloud = await startFakeCloud((req, res, ctx) => {
      lastPayload = ctx.parsed;
      res.writeHead(200);
      res.end('{"ok":true}');
    });
    const cs = await loadCloudSync();
    const es = await loadEventStore();
    es._resetForTests();
    cs.setSyncState({ state: 'raw_enabled', cloud_base: cloud.base, namespace: 'raw-ns' });
    await seedEvents(es, 'raw-ns', [{
      event_id: 'evt_w378_6_a',
      raw_prompt_path: '/raw/full-prompt-here',
      raw_response_path: '/raw/full-response-here',
      sensitive_classes: [],
    }]);
    const result = await cs.pushEvents({ limit: 10 });
    assert.equal(result.pushed, 1);
    const ev = lastPayload.events[0];
    assert.equal(ev.raw_prompt_path, '/raw/full-prompt-here', 'raw_enabled must include raw_prompt_path');
    assert.equal(ev.raw_response_path, '/raw/full-response-here', 'raw_enabled must include raw_response_path');
    assert.ok(ev.prompt_redacted, 'raw_enabled also keeps redacted form');
    assert.ok(ev.tenant_id, 'raw_enabled passes through tenant_id');
  } finally {
    await stopFakeCloud(cloud);
    env.restore();
  }
});

test('W378 #7 — classes_blocked_from_sync prevents events with that class from upload', async () => {
  const env = withIsolatedEnv();
  let cloud;
  try {
    let lastPayload = null;
    cloud = await startFakeCloud((req, res, ctx) => {
      lastPayload = ctx.parsed;
      res.writeHead(200);
      res.end('{"ok":true}');
    });
    const cs = await loadCloudSync();
    const es = await loadEventStore();
    es._resetForTests();
    cs.setSyncState({
      state: 'redacted_only',
      cloud_base: cloud.base,
      namespace: 'b-ns',
      classes_blocked_from_sync: ['ssn'],
    });
    await seedEvents(es, 'b-ns', [
      { event_id: 'evt_w378_7_clean', sensitive_classes: ['email'] },
      { event_id: 'evt_w378_7_blocked', sensitive_classes: ['ssn'] },
      { event_id: 'evt_w378_7_mixed', sensitive_classes: ['email', 'ssn'] },
    ]);
    const result = await cs.pushEvents({ limit: 10 });
    assert.equal(result.pushed, 1, 'only the clean event uploads');
    assert.equal(result.blocked, 2, 'both SSN-touching events are blocked');
    const ids = lastPayload.events.map((e) => e.event_id);
    assert.deepEqual(ids, ['evt_w378_7_clean']);
    assert.ok(result.reasons['class_blocked:ssn'] >= 2, 'reasons map records the blocked class twice');
  } finally {
    await stopFakeCloud(cloud);
    env.restore();
  }
});

test('W378 #8 — validateClass accepts every one of the canonical privacy classes', async () => {
  const env = withIsolatedEnv();
  try {
    const cs = await loadCloudSync();
    assert.ok(Array.isArray(cs.PRIVACY_CLASSES));
    assert.equal(cs.PRIVACY_CLASSES.length, 17, 'PRIVACY_CLASSES must have 17 entries');
    for (const cls of cs.PRIVACY_CLASSES) {
      assert.equal(cs.validateClass(cls), true, 'validateClass must accept ' + cls);
    }
  } finally {
    env.restore();
  }
});

test('W378 #9 — validateClass rejects "foo" (unknown class)', async () => {
  const env = withIsolatedEnv();
  try {
    const cs = await loadCloudSync();
    assert.equal(cs.validateClass('foo'), false);
    assert.equal(cs.validateClass(''), false);
    assert.equal(cs.validateClass(null), false);
    assert.equal(cs.validateClass(123), false);
    // setSyncState should also reject unknown classes
    assert.throws(
      () => cs.setSyncState({ classes_blocked_from_sync: ['foo'] }),
      (err) => err instanceof cs.CloudSyncError && /invalid_class/.test(err.message),
    );
  } finally {
    env.restore();
  }
});

test('W378 #10 — pushEvents dryRun returns counts without HTTP call', async () => {
  const env = withIsolatedEnv();
  let cloud;
  try {
    let hits = 0;
    cloud = await startFakeCloud((req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end('{}');
    });
    const cs = await loadCloudSync();
    const es = await loadEventStore();
    es._resetForTests();
    cs.setSyncState({ state: 'redacted_only', cloud_base: cloud.base, namespace: 'dry-ns' });
    await seedEvents(es, 'dry-ns', [
      { event_id: 'evt_w378_10_a' },
      { event_id: 'evt_w378_10_b' },
    ]);
    const result = await cs.pushEvents({ limit: 10, dryRun: true });
    assert.equal(result.pushed, 2, 'dryRun still counts what WOULD ship');
    assert.equal(result.skipped, 0);
    assert.equal(result.blocked, 0);
    assert.equal(hits, 0, 'dryRun must NOT hit the network');
    assert.ok(result.audit_id && result.audit_id.startsWith('aud_'));
  } finally {
    await stopFakeCloud(cloud);
    env.restore();
  }
});

test('W378 #11 — pushEvents writes audit.jsonl row per push', async () => {
  const env = withIsolatedEnv();
  let cloud;
  try {
    cloud = await startFakeCloud((req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    const cs = await loadCloudSync();
    const es = await loadEventStore();
    es._resetForTests();
    cs.setSyncState({ state: 'metadata_only', cloud_base: cloud.base, namespace: 'audit-ns' });
    await seedEvents(es, 'audit-ns', [{ event_id: 'evt_w378_11_a' }]);
    const r1 = await cs.pushEvents({ limit: 10 });
    const r2 = await cs.pushEvents({ limit: 10, dryRun: true });
    const r3 = await cs.pushEvents({ limit: 10 });
    const auditPath = path.join(env.dir, 'sync', 'audit.jsonl');
    assert.ok(fs.existsSync(auditPath), 'audit.jsonl must exist');
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, '3 pushes -> 3 audit rows');
    const ids = lines.map((l) => JSON.parse(l).audit_id);
    assert.deepEqual(
      [...new Set(ids)].length,
      3,
      'audit_ids must be unique per call',
    );
    assert.ok(ids.includes(r1.audit_id));
    assert.ok(ids.includes(r2.audit_id));
    assert.ok(ids.includes(r3.audit_id));
    // every row must record op + state + count
    for (const l of lines) {
      const row = JSON.parse(l);
      assert.equal(row.op, 'push');
      assert.equal(row.state, 'metadata_only');
      assert.ok(typeof row.ts === 'string');
    }
  } finally {
    await stopFakeCloud(cloud);
    env.restore();
  }
});

test('W378 #12 — pushEvents with cloud unreachable throws CloudSyncError', async () => {
  const env = withIsolatedEnv();
  try {
    const cs = await loadCloudSync();
    const es = await loadEventStore();
    es._resetForTests();
    // Point at a port nobody is listening on. 127.0.0.1:1 reliably refuses.
    cs.setSyncState({
      state: 'metadata_only',
      cloud_base: 'http://127.0.0.1:1',
      namespace: 'unreach-ns',
    });
    await seedEvents(es, 'unreach-ns', [{ event_id: 'evt_w378_12_a' }]);
    let caught = null;
    try { await cs.pushEvents({ limit: 10 }); }
    catch (e) { caught = e; }
    assert.ok(caught, 'must throw when cloud is unreachable');
    assert.ok(caught instanceof cs.CloudSyncError, 'must be CloudSyncError');
    assert.equal(caught.code, 'cloud_unreachable');
    // audit row was still written for the failed attempt
    const auditPath = path.join(env.dir, 'sync', 'audit.jsonl');
    assert.ok(fs.existsSync(auditPath));
    const row = JSON.parse(fs.readFileSync(auditPath, 'utf8').trim().split('\n').pop());
    assert.equal(row.op, 'push');
    assert.ok(row.reasons.transport_error >= 1);
  } finally {
    env.restore();
  }
});

test('W378 #13 — pushEvents with HTTP 500 throws CloudSyncError with status', async () => {
  const env = withIsolatedEnv();
  let cloud;
  try {
    cloud = await startFakeCloud((req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom: inbox overflow');
    });
    const cs = await loadCloudSync();
    const es = await loadEventStore();
    es._resetForTests();
    cs.setSyncState({ state: 'metadata_only', cloud_base: cloud.base, namespace: '500-ns' });
    await seedEvents(es, '500-ns', [{ event_id: 'evt_w378_13_a' }]);
    let caught = null;
    try { await cs.pushEvents({ limit: 10 }); }
    catch (e) { caught = e; }
    assert.ok(caught instanceof cs.CloudSyncError);
    assert.equal(caught.status, 500);
    assert.equal(caught.code, 'cloud_http_error');
    assert.ok(/boom: inbox overflow/.test(caught.body || caught.message));
  } finally {
    await stopFakeCloud(cloud);
    env.restore();
  }
});

test('W378 #14 — auditLog returns recent rows in reverse-chrono order', async () => {
  const env = withIsolatedEnv();
  let cloud;
  try {
    cloud = await startFakeCloud((req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    const cs = await loadCloudSync();
    const es = await loadEventStore();
    es._resetForTests();
    cs.setSyncState({ state: 'metadata_only', cloud_base: cloud.base, namespace: 'log-ns' });
    await seedEvents(es, 'log-ns', [{ event_id: 'evt_w378_14_a' }]);
    // Three pushes with a 5ms gap so timestamps are monotone-increasing.
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await cs.pushEvents({ limit: 10, dryRun: true });
      ids.push(r.audit_id);
      await new Promise((res) => setTimeout(res, 5));
    }
    const log = cs.auditLog({ limit: 10 });
    assert.ok(log.length >= 3);
    // newest first: log[0] should be the LAST push we made
    assert.equal(log[0].audit_id, ids[2], 'newest entry first');
    assert.equal(log[1].audit_id, ids[1]);
    assert.equal(log[2].audit_id, ids[0]);
    // limit honored
    const log1 = cs.auditLog({ limit: 1 });
    assert.equal(log1.length, 1);
    assert.equal(log1[0].audit_id, ids[2]);
  } finally {
    await stopFakeCloud(cloud);
    env.restore();
  }
});

test('W378 #15 — end-to-end: 3 events (1 metadata-shape / 1 redacted / 1 blocked) -> server receives correct projections', async () => {
  const env = withIsolatedEnv();
  let cloud;
  try {
    let captured = null;
    cloud = await startFakeCloud((req, res, ctx) => {
      captured = ctx.parsed;
      res.writeHead(200);
      res.end('{"ok":true}');
    });
    const cs = await loadCloudSync();
    const es = await loadEventStore();
    es._resetForTests();
    // We exercise redacted_only since it's the most likely real-world setting
    // (sends metadata + redacted text, blocks raw + per-class).
    cs.setSyncState({
      state: 'redacted_only',
      cloud_base: cloud.base,
      namespace: 'e2e-ns',
      classes_blocked_from_sync: ['ssn'],
    });
    await seedEvents(es, 'e2e-ns', [
      { event_id: 'evt_w378_15_clean1', sensitive_classes: [], prompt_redacted: 'p1', response_redacted: 'r1' },
      { event_id: 'evt_w378_15_clean2', sensitive_classes: ['email'], prompt_redacted: 'p2', response_redacted: 'r2' },
      { event_id: 'evt_w378_15_blocked', sensitive_classes: ['ssn'], prompt_redacted: 'p3', response_redacted: 'r3' },
    ]);
    const result = await cs.pushEvents({ limit: 10 });
    assert.equal(result.pushed, 2);
    assert.equal(result.blocked, 1);
    assert.ok(captured.events.length === 2);
    const sent = captured.events.map((e) => e.event_id).sort();
    assert.deepEqual(sent, ['evt_w378_15_clean1', 'evt_w378_15_clean2']);
    // Every uploaded event must include redacted text + metadata, never raw paths.
    for (const ev of captured.events) {
      assert.ok(ev.prompt_redacted, 'redacted_only includes prompt_redacted');
      assert.ok(ev.response_redacted, 'redacted_only includes response_redacted');
      assert.ok(typeof ev.estimated_cost_usd === 'number');
      assert.equal(ev.raw_prompt_path, undefined, 'never raw');
      assert.equal(ev.raw_response_path, undefined, 'never raw');
    }
    // Envelope sanity: namespace + source_device_id must be present.
    assert.equal(captured.namespace, 'e2e-ns');
    assert.ok(captured.source_device_id && /^dev_/.test(captured.source_device_id));
    assert.equal(captured.state, 'redacted_only');
    // last_push_at advanced
    const st = cs.getSyncState();
    assert.ok(st.last_push_at, 'last_push_at must update after successful push');
    // audit row records pushed/blocked/skipped counts
    const log = cs.auditLog({ limit: 5 });
    const last = log[0];
    assert.equal(last.op, 'push');
    assert.equal(last.pushed, 2);
    assert.equal(last.blocked, 1);
  } finally {
    await stopFakeCloud(cloud);
    env.restore();
  }
});
