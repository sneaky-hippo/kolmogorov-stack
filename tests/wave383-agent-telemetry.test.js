// W383 — agent-telemetry behavior tests.
//
// Exercises src/agent-telemetry.js end-to-end against a seeded event-store
// in an isolated KOLM_DATA_DIR. No fetch, no network. Every test seeds the
// rows it needs and asserts the analytics contract.
//
// Round 2 will wire CLI verb + /v1/* route + /account/agent-telemetry.html
// — this suite locks in the math + the heuristic so those wires are safe.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate every test run from the user's ~/.kolm BEFORE importing the modules.
const TMP_HOME = path.join(os.tmpdir(), 'kolm-w383-' + process.pid + '-' + Math.random().toString(36).slice(2));
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.KOLM_DATA_DIR = path.join(TMP_HOME, '.kolm');
fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });

const { newEvent } = await import('../src/event-schema.js');
const eventStore = await import('../src/event-store.js');
const tele = await import('../src/agent-telemetry.js');

eventStore._resetForTests();

// Helpers --------------------------------------------------------------------

let _counter = 0;
function _eid(tag) {
  _counter += 1;
  return 'evt_w383_' + tag + '_' + _counter + '_' + Math.random().toString(36).slice(2, 8);
}

function _seed(partial = {}) {
  return newEvent({
    tenant_id: 'test-tenant',
    namespace: 'w383-' + (partial._ns_suffix || 'ns'),
    provider: partial.provider || 'openai',
    model: partial.model || 'gpt-4o-mini',
    prompt_redacted: 'classify ticket as billing, bug, feature',
    response_redacted: 'billing',
    prompt_tokens: 100,
    completion_tokens: 8,
    estimated_cost_usd: 0.001,
    latency_ms: 320,
    request_hash: 'rh_' + Math.random().toString(36).slice(2),
    ...partial,
  });
}

async function _reset() {
  eventStore._resetForTests();
  // Wipe disk between tests so each one starts clean.
  const dir = path.join(process.env.KOLM_DATA_DIR, 'events');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });
}

// Build chronologically-ordered events at known offsets from a base time.
function _at(baseMs, offsetS, extra = {}) {
  return _seed({
    created_at: new Date(baseMs + offsetS * 1000).toISOString(),
    event_id: _eid('t'),
    ...extra,
  });
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('W383 #1 — listAgents returns one entry per distinct app_id', async () => {
  await _reset();
  await eventStore.appendEvent(_seed({ event_id: _eid('1a'), app_id: 'codex' }));
  await eventStore.appendEvent(_seed({ event_id: _eid('1b'), app_id: 'claude-code' }));
  await eventStore.appendEvent(_seed({ event_id: _eid('1c'), app_id: 'codex' }));
  await eventStore.appendEvent(_seed({ event_id: _eid('1d'), app_id: 'cursor' }));
  const agents = await tele.listAgents();
  const appIds = agents.map(a => a.app_id).sort();
  assert.deepEqual(appIds, ['claude-code', 'codex', 'cursor']);
  const codex = agents.find(a => a.app_id === 'codex');
  assert.equal(codex.events, 2);
});

test('W383 #2 — listAgents sums cost + tokens correctly', async () => {
  await _reset();
  await eventStore.appendEvent(_seed({ event_id: _eid('2a'), app_id: 'codex', estimated_cost_usd: 0.0025, prompt_tokens: 100, completion_tokens: 50 }));
  await eventStore.appendEvent(_seed({ event_id: _eid('2b'), app_id: 'codex', estimated_cost_usd: 0.0050, prompt_tokens: 200, completion_tokens: 30 }));
  const agents = await tele.listAgents();
  const codex = agents.find(a => a.app_id === 'codex');
  assert.ok(Math.abs(codex.total_cost_usd - 0.0075) < 1e-9, 'cost ~ 0.0075, got ' + codex.total_cost_usd);
  assert.equal(codex.total_tokens, 100 + 50 + 200 + 30);
});

test('W383 #3 — listSessions filters by app_id', async () => {
  await _reset();
  await eventStore.appendEvent(_seed({ event_id: _eid('3a'), app_id: 'codex', session_id: 'sess-codex-1' }));
  await eventStore.appendEvent(_seed({ event_id: _eid('3b'), app_id: 'codex', session_id: 'sess-codex-1' }));
  await eventStore.appendEvent(_seed({ event_id: _eid('3c'), app_id: 'claude-code', session_id: 'sess-cc-1' }));
  const sessions = await tele.listSessions({ app_id: 'codex' });
  assert.equal(sessions.length, 1, 'one codex session');
  assert.equal(sessions[0].session_id, 'sess-codex-1');
  assert.equal(sessions[0].app_id, 'codex');
  // claude-code session must not appear
  for (const s of sessions) assert.notEqual(s.app_id, 'claude-code');
});

test('W383 #4 — listSessions returns acceptance_rate as a ratio 0..1', async () => {
  await _reset();
  const base = Date.now() - 24 * 3600 * 1000;
  // 4 events in a session: 2 corrected (close re-prompts), 2 accepted
  // (long-gap moves on).
  await eventStore.appendEvent(_at(base, 0, { app_id: 'codex', session_id: 'sess-r1', prompt_redacted: 'fix the bug in foo.py', feedback: JSON.stringify({ file_hint: 'foo.py' }) }));
  await eventStore.appendEvent(_at(base, 10, { app_id: 'codex', session_id: 'sess-r1', prompt_redacted: 'no, fix the bug in foo.py differently', feedback: JSON.stringify({ file_hint: 'foo.py' }) }));
  await eventStore.appendEvent(_at(base, 400, { app_id: 'codex', session_id: 'sess-r1', prompt_redacted: 'now write a test for bar.py', feedback: JSON.stringify({ file_hint: 'bar.py' }) }));
  await eventStore.appendEvent(_at(base, 1200, { app_id: 'codex', session_id: 'sess-r1', prompt_redacted: 'now write a doc for baz.md', feedback: JSON.stringify({ file_hint: 'baz.md' }) }));
  const sessions = await tele.listSessions({ app_id: 'codex' });
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.ok(s.acceptance_rate >= 0 && s.acceptance_rate <= 1, 'acceptance_rate in [0,1], got ' + s.acceptance_rate);
  assert.equal(s.event_count, 4);
});

test('W383 #5 — getSession returns full event detail', async () => {
  await _reset();
  await eventStore.appendEvent(_seed({ event_id: _eid('5a'), app_id: 'codex', session_id: 'sess-get-1', prompt_redacted: 'first prompt' }));
  await eventStore.appendEvent(_seed({ event_id: _eid('5b'), app_id: 'codex', session_id: 'sess-get-1', prompt_redacted: 'second prompt' }));
  const sess = await tele.getSession({ session_id: 'sess-get-1' });
  assert.ok(sess, 'session found');
  assert.equal(sess.session_id, 'sess-get-1');
  assert.equal(sess.event_count, 2);
  assert.equal(sess.events.length, 2);
  assert.ok(sess.events.every(e => 'acceptance_signal' in e), 'every event annotated');
  assert.ok(sess._heuristic && sess._heuristic.note, 'heuristic disclosure exposed');
});

test('W383 #6 — inferAcceptance: re-prompt within 90s same file => corrected', async () => {
  const base = Date.now() - 3600_000;
  const events = [
    _seed({ event_id: 'ev-corr-1', app_id: 'codex', session_id: 'sess-corr', created_at: new Date(base).toISOString(), prompt_redacted: 'fix bug', feedback: JSON.stringify({ file_hint: 'main.rs' }) }),
    _seed({ event_id: 'ev-corr-2', app_id: 'codex', session_id: 'sess-corr', created_at: new Date(base + 15_000).toISOString(), prompt_redacted: 'no fix it differently', feedback: JSON.stringify({ file_hint: 'main.rs' }) }),
  ];
  const out = tele.inferAcceptance({ events });
  const first = out.find(e => e.event_id === 'ev-corr-1');
  assert.equal(first.acceptance_signal, 'corrected', 'quick re-prompt same file => corrected');
});

test('W383 #7 — inferAcceptance: no follow-up within 300s => accepted', async () => {
  const base = Date.now() - 3600_000;
  const events = [
    _seed({ event_id: 'ev-acc-1', app_id: 'codex', session_id: 'sess-acc', created_at: new Date(base).toISOString(), prompt_redacted: 'first' }),
    _seed({ event_id: 'ev-acc-2', app_id: 'codex', session_id: 'sess-acc', created_at: new Date(base + 600_000).toISOString(), prompt_redacted: 'second much later' }),
  ];
  const out = tele.inferAcceptance({ events });
  const first = out.find(e => e.event_id === 'ev-acc-1');
  assert.equal(first.acceptance_signal, 'accepted', 'long gap => accepted');
  const last = out.find(e => e.event_id === 'ev-acc-2');
  assert.equal(last.acceptance_signal, 'accepted', 'last event in session => accepted');
});

test('W383 #8 — inferAcceptance confidence > 0.7 for clear cases', () => {
  const base = Date.now() - 3600_000;
  const clearCorrection = [
    _seed({ event_id: 'cc-1', app_id: 'codex', session_id: 'sess-clear', created_at: new Date(base).toISOString(), prompt_redacted: 'fix it', feedback: JSON.stringify({ file_hint: 'a.py' }) }),
    _seed({ event_id: 'cc-2', app_id: 'codex', session_id: 'sess-clear', created_at: new Date(base + 5_000).toISOString(), prompt_redacted: 'no fix it again', feedback: JSON.stringify({ file_hint: 'a.py' }) }),
  ];
  const out = tele.inferAcceptance({ events: clearCorrection });
  const first = out.find(e => e.event_id === 'cc-1');
  assert.ok(first.acceptance_confidence > 0.7, 'clear correction confidence > 0.7, got ' + first.acceptance_confidence);

  const clearAccept = [
    _seed({ event_id: 'ca-1', app_id: 'codex', session_id: 'sess-clear-a', created_at: new Date(base).toISOString(), prompt_redacted: 'solo' }),
    _seed({ event_id: 'ca-2', app_id: 'codex', session_id: 'sess-clear-a', created_at: new Date(base + 2000_000).toISOString(), prompt_redacted: 'much later' }),
  ];
  const out2 = tele.inferAcceptance({ events: clearAccept });
  const firstA = out2.find(e => e.event_id === 'ca-1');
  assert.ok(firstA.acceptance_confidence > 0.7, 'clear accept confidence > 0.7, got ' + firstA.acceptance_confidence);
});

test('W383 #9 — recommendModel picks higher-acceptance model when costs equal', async () => {
  await _reset();
  const base = Date.now() - 24 * 3600 * 1000;

  // Model A: high acceptance (long gaps => accepted)
  for (let i = 0; i < 5; i++) {
    await eventStore.appendEvent(_at(base + i * 3600_000, 0, {
      app_id: 'rec', model: 'model-A', session_id: 'sess-A-' + i,
      estimated_cost_usd: 0.001,
      prompt_redacted: 'A prompt ' + i,
    }));
    await eventStore.appendEvent(_at(base + i * 3600_000, 600, {
      app_id: 'rec', model: 'model-A', session_id: 'sess-A-' + i,
      estimated_cost_usd: 0.001,
      prompt_redacted: 'A follow ' + i,
    }));
  }
  // Model B: low acceptance (quick re-prompts on same file => corrected)
  for (let i = 0; i < 5; i++) {
    await eventStore.appendEvent(_at(base + (i + 10) * 3600_000, 0, {
      app_id: 'rec', model: 'model-B', session_id: 'sess-B-' + i,
      estimated_cost_usd: 0.001,
      prompt_redacted: 'B prompt ' + i,
      feedback: JSON.stringify({ file_hint: 'shared.py' }),
    }));
    await eventStore.appendEvent(_at(base + (i + 10) * 3600_000, 10, {
      app_id: 'rec', model: 'model-B', session_id: 'sess-B-' + i,
      estimated_cost_usd: 0.001,
      prompt_redacted: 'B fix ' + i,
      feedback: JSON.stringify({ file_hint: 'shared.py' }),
    }));
  }

  const rec = await tele.recommendModel({ app_id: 'rec' });
  assert.equal(rec.recommended_model, 'model-A', 'higher-acceptance model wins when cost equal');
  const a = rec.candidates.find(c => c.model === 'model-A');
  const b = rec.candidates.find(c => c.model === 'model-B');
  assert.ok(a.acceptance_rate > b.acceptance_rate, 'A acceptance > B acceptance');
});

test('W383 #10 — recommendModel picks lower-cost model when acceptances equal', async () => {
  await _reset();
  const base = Date.now() - 24 * 3600 * 1000;

  // Both models: long-gap sessions => both 100% accepted. Different cost.
  for (let i = 0; i < 4; i++) {
    await eventStore.appendEvent(_at(base + i * 3600_000, 0, {
      app_id: 'rec2', model: 'cheap-model', session_id: 'sess-c-' + i,
      estimated_cost_usd: 0.0001,
      prompt_redacted: 'cheap ' + i,
    }));
    await eventStore.appendEvent(_at(base + (i + 10) * 3600_000, 0, {
      app_id: 'rec2', model: 'pricey-model', session_id: 'sess-p-' + i,
      estimated_cost_usd: 0.01,
      prompt_redacted: 'pricey ' + i,
    }));
  }

  const rec = await tele.recommendModel({ app_id: 'rec2' });
  assert.equal(rec.recommended_model, 'cheap-model', 'lower-cost model wins when acceptance equal');
});

test('W383 #11 — recommendModel returns reason string explaining the choice', async () => {
  await _reset();
  const base = Date.now() - 24 * 3600 * 1000;
  await eventStore.appendEvent(_at(base, 0, {
    app_id: 'rec3', model: 'only-model', session_id: 'sess-only-1',
    prompt_redacted: 'only',
  }));
  const rec = await tele.recommendModel({ app_id: 'rec3' });
  assert.ok(typeof rec.reason === 'string', 'reason is a string');
  assert.ok(rec.reason.length > 20, 'reason is non-trivial');
  assert.ok(rec.reason.includes('only-model'), 'reason names the model');
});

test('W383 #12 — topFailingPromptShapes ranked by acceptance_rate ASC then count DESC', async () => {
  await _reset();
  const base = Date.now() - 24 * 3600 * 1000;

  // Shape X: 4 events, all quickly corrected (low acceptance)
  for (let i = 0; i < 4; i++) {
    const s = base + i * 3600_000;
    await eventStore.appendEvent(_at(s, 0, {
      app_id: 'fail', session_id: 'shape-x-' + i,
      prompt_redacted: 'render the report for company',
      feedback: JSON.stringify({ file_hint: 'report.tsx' }),
    }));
    await eventStore.appendEvent(_at(s, 10, {
      app_id: 'fail', session_id: 'shape-x-' + i,
      prompt_redacted: 'render the report for company',
      feedback: JSON.stringify({ file_hint: 'report.tsx' }),
    }));
  }
  // Shape Y: 2 events, all long-gap accepted (high acceptance)
  for (let i = 0; i < 2; i++) {
    const s = base + (i + 10) * 3600_000;
    await eventStore.appendEvent(_at(s, 0, {
      app_id: 'fail', session_id: 'shape-y-' + i,
      prompt_redacted: 'summarize the conversation log',
    }));
    await eventStore.appendEvent(_at(s, 1500, {
      app_id: 'fail', session_id: 'shape-y-' + i,
      prompt_redacted: 'next task entirely different',
    }));
  }

  const shapes = await tele.topFailingPromptShapes({ app_id: 'fail', limit: 10 });
  assert.ok(shapes.length >= 2, 'at least the two shapes appear');
  // First entry should have the LOWEST acceptance_rate.
  for (let i = 1; i < shapes.length; i++) {
    assert.ok(shapes[i].acceptance_rate >= shapes[i - 1].acceptance_rate, 'sorted asc by acceptance');
  }
  assert.ok(shapes[0].acceptance_rate <= shapes[shapes.length - 1].acceptance_rate);
});

test('W383 #13 — agentTelemetryStats by_app keyed correctly', async () => {
  await _reset();
  await eventStore.appendEvent(_seed({ event_id: _eid('13a'), app_id: 'codex', session_id: 'tsx1', estimated_cost_usd: 0.002 }));
  await eventStore.appendEvent(_seed({ event_id: _eid('13b'), app_id: 'claude-code', session_id: 'tsx2', estimated_cost_usd: 0.003 }));
  await eventStore.appendEvent(_seed({ event_id: _eid('13c'), app_id: 'codex', session_id: 'tsx1', estimated_cost_usd: 0.001 }));
  const stats = await tele.agentTelemetryStats();
  assert.equal(stats.total_agent_calls, 3);
  assert.ok(stats.by_app.codex, 'codex key present');
  assert.ok(stats.by_app['claude-code'], 'claude-code key present');
  assert.equal(stats.by_app.codex.events, 2);
  assert.equal(stats.by_app['claude-code'].events, 1);
  assert.ok(stats.cost_by_app.codex >= 0.0029, 'cost_by_app summed for codex');
  assert.ok(stats.cost_by_app['claude-code'] >= 0.0029, 'cost_by_app summed for claude-code');
});

test('W383 #14 — empty event store returns sane empty defaults (no crash)', async () => {
  await _reset();
  const agents = await tele.listAgents();
  const sessions = await tele.listSessions({});
  const session = await tele.getSession({ session_id: 'nope' });
  const rec = await tele.recommendModel({ app_id: 'nope' });
  const shapes = await tele.topFailingPromptShapes({});
  const stats = await tele.agentTelemetryStats();
  assert.deepEqual(agents, []);
  assert.deepEqual(sessions, []);
  assert.equal(session, null);
  assert.equal(rec.recommended_model, null);
  assert.deepEqual(rec.candidates, []);
  assert.ok(typeof rec.reason === 'string' && rec.reason.length > 0);
  assert.deepEqual(shapes, []);
  assert.equal(stats.total_agent_calls, 0);
  assert.equal(stats.total_sessions, 0);
  assert.deepEqual(stats.by_app, {});
  assert.deepEqual(stats.top_workflows, []);
});

test('W383 #15 — session_id inference: events from same app within 5min get grouped', async () => {
  await _reset();
  // Force the same 5-minute bucket by anchoring within the same window. Pick
  // a base aligned to the start of a 5-minute bucket so both timestamps share
  // the same `floor(ts / 5min) * 5min` value regardless of clock drift.
  const FIVE = 5 * 60 * 1000;
  const base = Math.floor((Date.now() - 24 * 3600 * 1000) / FIVE) * FIVE + 1000;
  await eventStore.appendEvent(_seed({ event_id: _eid('15a'), app_id: 'codex-noses', session_id: null, created_at: new Date(base).toISOString() }));
  await eventStore.appendEvent(_seed({ event_id: _eid('15b'), app_id: 'codex-noses', session_id: null, created_at: new Date(base + 60_000).toISOString() }));
  await eventStore.appendEvent(_seed({ event_id: _eid('15c'), app_id: 'codex-noses', session_id: null, created_at: new Date(base + 120_000).toISOString() }));
  const sessions = await tele.listSessions({ app_id: 'codex-noses' });
  assert.equal(sessions.length, 1, 'three events in same 5min window => 1 inferred session');
  assert.equal(sessions[0].event_count, 3);
  assert.ok(sessions[0].session_id.startsWith('inf_'), 'inferred session_id prefix inf_');
});

test('W383 #16 — cross-app events within same minute get DIFFERENT inferred sessions', async () => {
  await _reset();
  const base = Date.now() - 24 * 3600 * 1000;
  await eventStore.appendEvent(_seed({ event_id: _eid('16a'), app_id: 'codex', session_id: null, created_at: new Date(base).toISOString() }));
  await eventStore.appendEvent(_seed({ event_id: _eid('16b'), app_id: 'claude-code', session_id: null, created_at: new Date(base + 30_000).toISOString() }));
  const sessAll = await tele.listSessions({});
  // Codex and claude-code should each produce their own inferred session.
  const codexSess = sessAll.filter(s => s.app_id === 'codex');
  const ccSess = sessAll.filter(s => s.app_id === 'claude-code');
  assert.equal(codexSess.length, 1, 'one codex session');
  assert.equal(ccSess.length, 1, 'one claude-code session');
  assert.notEqual(codexSess[0].session_id, ccSess[0].session_id, 'different app_id => different inferred session_id');
});

test('W383 #17 — acceptance heuristic windows are tunable via opts', () => {
  const base = Date.now() - 3600_000;
  const events = [
    _seed({ event_id: 'tune-1', app_id: 'codex', session_id: 'sess-tune', created_at: new Date(base).toISOString(), prompt_redacted: 'thing', feedback: JSON.stringify({ file_hint: 'a.py' }) }),
    _seed({ event_id: 'tune-2', app_id: 'codex', session_id: 'sess-tune', created_at: new Date(base + 120_000).toISOString(), prompt_redacted: 'thing fix', feedback: JSON.stringify({ file_hint: 'a.py' }) }),
  ];
  // Default 90s window: 120s gap > 90s, same file but outside acceptance
  // window => falls into pending bucket (gap is 120s, between 90 and 300).
  const def = tele.inferAcceptance({ events });
  const defFirst = def.find(e => e.event_id === 'tune-1');
  assert.equal(defFirst.acceptance_signal, 'pending', 'default windows => pending');

  // With a 180s acceptance window the same 120s gap should classify as corrected.
  const tuned = tele.inferAcceptance({ events, acceptance_window_s: 180, correction_window_s: 600 });
  const tunedFirst = tuned.find(e => e.event_id === 'tune-1');
  assert.equal(tunedFirst.acceptance_signal, 'corrected', 'wider window => corrected');
});

test('W383 #18 — WINDOWS constant exposed and matches default', () => {
  assert.ok(tele.WINDOWS, 'WINDOWS exported');
  assert.equal(tele.WINDOWS.acceptance_s, 90);
  assert.equal(tele.WINDOWS.correction_s, 300);
  // Frozen so callers cannot accidentally mutate defaults.
  try {
    'use strict';
    tele.WINDOWS.acceptance_s = 999;
  } catch {}
  assert.equal(tele.WINDOWS.acceptance_s, 90, 'WINDOWS is effectively frozen');
});

test('W383 #19 — explicit accepted=true ground-truth wins over heuristic', () => {
  const base = Date.now() - 3600_000;
  const events = [
    _seed({ event_id: 'gt-1', app_id: 'codex', session_id: 'sess-gt', created_at: new Date(base).toISOString(), prompt_redacted: 'thing', feedback: JSON.stringify({ file_hint: 'a.py' }), accepted: true }),
    _seed({ event_id: 'gt-2', app_id: 'codex', session_id: 'sess-gt', created_at: new Date(base + 5_000).toISOString(), prompt_redacted: 'thing again', feedback: JSON.stringify({ file_hint: 'a.py' }) }),
  ];
  const out = tele.inferAcceptance({ events });
  const first = out.find(e => e.event_id === 'gt-1');
  assert.equal(first.acceptance_signal, 'accepted', 'explicit accepted=true honored');
  assert.equal(first.acceptance_confidence, 1.0, 'ground-truth confidence is 1.0');
});

test('W383 #20 — recommendModel exposes Pareto front + scores', async () => {
  await _reset();
  const base = Date.now() - 24 * 3600 * 1000;
  // Model X dominates Y (more acceptance, less cost). Model Z trades off
  // (highest acceptance but highest cost) — Pareto-optimal.
  for (let i = 0; i < 3; i++) {
    const s = base + i * 3600_000;
    await eventStore.appendEvent(_at(s, 0, { app_id: 'par', model: 'X', session_id: 'sx-' + i, estimated_cost_usd: 0.002, prompt_redacted: 'x ' + i }));
    await eventStore.appendEvent(_at(s + 600_000, 0, { app_id: 'par', model: 'Y', session_id: 'sy-' + i, estimated_cost_usd: 0.005, prompt_redacted: 'y ' + i, feedback: JSON.stringify({ file_hint: 'a.py' }) }));
    await eventStore.appendEvent(_at(s + 600_000, 10, { app_id: 'par', model: 'Y', session_id: 'sy-' + i, estimated_cost_usd: 0.005, prompt_redacted: 'y fix ' + i, feedback: JSON.stringify({ file_hint: 'a.py' }) }));
  }
  const rec = await tele.recommendModel({ app_id: 'par' });
  // X should be picked over Y since X is both higher acceptance AND lower cost.
  assert.equal(rec.recommended_model, 'X', 'X dominates Y => X wins');
  // Every candidate has a numeric score.
  for (const c of rec.candidates) {
    assert.equal(typeof c.score, 'number', 'candidate score is numeric');
  }
});
