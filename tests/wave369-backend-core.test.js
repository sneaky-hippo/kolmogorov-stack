// W369 — data plane backend-core tests.
//
// Behavior assertions against the 6 source modules (event-schema, event-store,
// lake, opportunity-engine, dataset-workbench, label-queue). Uses a temp HOME
// + KOLM_DATA_DIR so the tests never touch the real ~/.kolm.
//
// HARD INVARIANT: train_ids and holdout_ids are disjoint after splitDataset.
//
// No fetch, no network, no fixtures on disk. Each test seeds events in
// memory, exercises a module, asserts the contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Isolate every test run from the user's ~/.kolm.
const TMP_HOME = path.join(os.tmpdir(), 'kolm-w369-' + process.pid + '-' + Math.random().toString(36).slice(2));
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.KOLM_DATA_DIR = path.join(TMP_HOME, '.kolm');
fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });

const { newEvent, canonicalize, validateEvent, templateSignature, EVENT_FIELDS, REQUIRED_FIELDS } = await import('../src/event-schema.js');
const eventStore = await import('../src/event-store.js');
const lake = await import('../src/lake.js');
const opp = await import('../src/opportunity-engine.js');
const dsw = await import('../src/dataset-workbench.js');
const labelQ = await import('../src/label-queue.js');

// reset store driver so module-scope cached path picks up our KOLM_DATA_DIR
eventStore._resetForTests();

function _seed(partial = {}) {
  return newEvent({
    tenant_id: 'test-tenant',
    namespace: 'test-ns',
    provider: 'openai',
    model: 'gpt-4o-mini',
    prompt_redacted: 'classify this support ticket as: billing, bug, feature',
    response_redacted: 'billing',
    prompt_tokens: 120,
    completion_tokens: 8,
    estimated_cost_usd: 0.0012,
    latency_ms: 420,
    request_hash: 'rh_' + Math.random().toString(36).slice(2),
    ...partial,
  });
}

test('W369 #1 — canonical event schema round-trip (newEvent -> canonicalize -> validate)', () => {
  const ev = newEvent({
    tenant_id: 't-1',
    namespace: 'ns-1',
    provider: 'openai',
    model: 'gpt-4o-mini',
    prompt_redacted: 'hello',
    extra_garbage_field: 'should be dropped',
  });
  const canon = canonicalize(ev);
  const result = validateEvent(canon);
  assert.equal(result.ok, true, 'canonical event must pass validation');
  assert.deepEqual(result.missing, [], 'no required fields missing');
  assert.deepEqual(result.errors, [], 'no type errors');
  // canonicalize must be idempotent
  assert.deepEqual(canonicalize(canon), canon, 'canonicalize is idempotent');
  // every required field present
  for (const f of REQUIRED_FIELDS) {
    assert.ok(canon[f], 'required field ' + f + ' must be present');
  }
  // canonicalize must NOT carry over fields outside EVENT_FIELDS
  const allowed = new Set(EVENT_FIELDS);
  for (const k of Object.keys(canon)) {
    assert.ok(allowed.has(k), 'canonical key ' + k + ' must be in EVENT_FIELDS');
  }
});

test('W369 #2 — appendEvent + getEvent round-trip', async () => {
  eventStore._resetForTests();
  const ev = await eventStore.appendEvent(_seed({ event_id: 'evt_w369_2_aaa', namespace: 'rt-ns' }));
  const got = await eventStore.getEvent('evt_w369_2_aaa');
  assert.ok(got, 'getEvent must return the row');
  assert.equal(got.event_id, 'evt_w369_2_aaa');
  assert.equal(got.namespace, 'rt-ns');
  assert.equal(got.model, ev.model);
  assert.equal(got.provider, 'openai');
});

test('W369 #3 — listEvents honors namespace filter', async () => {
  eventStore._resetForTests();
  await eventStore.appendEvent(_seed({ namespace: 'ns-a', event_id: 'evt_w369_3_a1' }));
  await eventStore.appendEvent(_seed({ namespace: 'ns-a', event_id: 'evt_w369_3_a2' }));
  await eventStore.appendEvent(_seed({ namespace: 'ns-b', event_id: 'evt_w369_3_b1' }));
  const a = await eventStore.listEvents({ namespace: 'ns-a' });
  const b = await eventStore.listEvents({ namespace: 'ns-b' });
  const aIds = a.map(e => e.event_id);
  const bIds = b.map(e => e.event_id);
  assert.ok(aIds.includes('evt_w369_3_a1'));
  assert.ok(aIds.includes('evt_w369_3_a2'));
  assert.ok(!aIds.includes('evt_w369_3_b1'), 'ns-a must not leak ns-b rows');
  assert.ok(bIds.includes('evt_w369_3_b1'));
  assert.ok(!bIds.includes('evt_w369_3_a1'), 'ns-b must not leak ns-a rows');
});

test('W369 #4 — lakeStats returns the expected shape on seeded events', async () => {
  eventStore._resetForTests();
  for (let i = 0; i < 8; i++) {
    await eventStore.appendEvent(_seed({
      namespace: 'lake-ns',
      event_id: 'evt_w369_4_' + i,
      provider: i % 2 === 0 ? 'openai' : 'anthropic',
      model: i % 2 === 0 ? 'gpt-4o-mini' : 'claude-haiku',
      estimated_cost_usd: 0.001 + i * 0.0001,
      latency_ms: 200 + i * 10,
      sensitive_data_detected: i === 3,
      sensitive_classes: i === 3 ? ['email'] : [],
    }));
  }
  const stats = await lake.lakeStats({ namespace: 'lake-ns', since: '30d' });
  assert.ok(stats.total_calls >= 8, 'total_calls must reflect seeded rows');
  assert.ok(stats.total_spend_usd > 0, 'total_spend_usd must aggregate cost');
  assert.ok(typeof stats.providers === 'object');
  assert.ok(stats.providers.openai, 'providers.openai must be present');
  assert.ok(stats.providers.anthropic, 'providers.anthropic must be present');
  assert.ok(typeof stats.models === 'object');
  assert.ok(Array.isArray(stats.repeated_clusters), 'repeated_clusters must be an array');
  assert.equal(stats.sensitive_events, 1, 'one event marked sensitive');
  assert.ok(stats.redactions_by_class.email >= 1, 'email class must be tallied');
  assert.ok(stats.storage && stats.storage.driver, 'storage.driver must be reported');
});

test('W369 #5 — clusterRepeatedPrompts groups same-signature prompts', async () => {
  // identical template (modulo quoted-string token) -> identical signature -> single cluster
  const ev1 = _seed({ event_id: 'evt_w369_5_a', prompt_redacted: 'translate "hello" to spanish', model: 'gpt-4o-mini' });
  const ev2 = _seed({ event_id: 'evt_w369_5_b', prompt_redacted: 'translate "world" to spanish', model: 'gpt-4o-mini' });
  const ev3 = _seed({ event_id: 'evt_w369_5_c', prompt_redacted: 'summarize this report briefly', model: 'gpt-4o-mini' });
  const ev4 = _seed({ event_id: 'evt_w369_5_d', prompt_redacted: 'translate "foo" to spanish', model: 'gpt-4o-mini' });
  const clusters = await lake.clusterRepeatedPrompts([ev1, ev2, ev3, ev4]);
  assert.ok(Array.isArray(clusters));
  // the three translate-to-spanish prompts share a template signature
  const big = clusters.find(c => c.count >= 3);
  assert.ok(big, 'must find a cluster with >=3 same-signature prompts');
  assert.ok(big.normalized.includes('translate'), 'normalized form must keep template prefix');
  assert.ok(big.sample_event_ids.length >= 3);
});

test('W369 #6 — findOpportunities returns local_replacement_candidate when 100+ same-signature events', async () => {
  eventStore._resetForTests();
  // Seed 110 events with the same template signature, modest cost each, so
  // monthly spend exceeds the $10 floor.
  for (let i = 0; i < 110; i++) {
    await eventStore.appendEvent(_seed({
      event_id: 'evt_w369_6_' + i,
      namespace: 'opp-ns',
      prompt_redacted: 'classify support ticket: ' + i,
      response_redacted: 'billing',
      model: 'gpt-4o-mini',
      provider: 'openai',
      estimated_cost_usd: 0.01,
      request_hash: 'rh_uniq_' + i,
    }));
  }
  const opps = await opp.findOpportunities({ namespace: 'opp-ns' });
  assert.ok(Array.isArray(opps), 'findOpportunities returns array');
  const lrc = opps.find(o => o.type === 'local_replacement_candidate');
  assert.ok(lrc, 'must detect local_replacement_candidate for 110 same-signature events');
  assert.ok(lrc.call_count >= 100, 'cluster count must reflect seeded volume');
  assert.equal(lrc.namespace, 'opp-ns');
  assert.ok(lrc.suggested_action, 'must include a suggested_action');
  assert.ok(lrc.estimated_savings_usd >= 0, 'savings must be a number');
  assert.equal(lrc.status, 'open', 'fresh opportunity defaults to open');
});

test('W369 #7 — createDataset + splitDataset -> train_ids and holdout_ids are DISJOINT', async () => {
  eventStore._resetForTests();
  for (let i = 0; i < 40; i++) {
    await eventStore.appendEvent(_seed({
      event_id: 'evt_w369_7_' + i,
      namespace: 'ds-ns',
      prompt_redacted: 'classify this ticket #' + i,
      response_redacted: 'billing',
    }));
  }
  const ds = await dsw.createDataset('ds-ns', { train_ratio: 0.8 });
  assert.ok(ds.dataset_id);
  assert.ok(ds.train_count > 0, 'train must have rows');
  assert.ok(ds.holdout_count > 0, 'holdout must have rows');
  assert.equal(ds.train_count + ds.holdout_count, ds.source_event_ids.length, 'split covers every source id');
  // re-run split and check disjointness explicitly
  const split = await dsw.splitDataset(ds.dataset_id, 0.8);
  const tset = new Set(split.train_ids);
  for (const h of split.holdout_ids) {
    assert.ok(!tset.has(h), 'HARD INVARIANT: ' + h + ' must not appear in both train and holdout');
  }
  // signature must be present and shaped like sha256:xxxx
  assert.match(split.split_signature, /^sha256:[a-f0-9]+$/, 'split_signature shape');
});

test('W369 #8 — approveEvent + nextToLabel skips already-approved events', async () => {
  eventStore._resetForTests();
  await eventStore.appendEvent(_seed({ namespace: 'lbl-ns', event_id: 'evt_w369_8_a', prompt_redacted: 'q1' }));
  await eventStore.appendEvent(_seed({ namespace: 'lbl-ns', event_id: 'evt_w369_8_b', prompt_redacted: 'q2' }));
  await eventStore.appendEvent(_seed({ namespace: 'lbl-ns', event_id: 'evt_w369_8_c', prompt_redacted: 'q3' }));
  // approve one
  await dsw.approveEvent('evt_w369_8_a', { reviewer: 'tester' });
  const next = await labelQ.nextToLabel({ namespace: 'lbl-ns', n: 5 });
  const ids = next.map(e => e.event_id);
  assert.ok(!ids.includes('evt_w369_8_a'), 'approved event must NOT appear in nextToLabel queue');
  assert.ok(ids.includes('evt_w369_8_b'), 'unapproved evt_b must appear');
  assert.ok(ids.includes('evt_w369_8_c'), 'unapproved evt_c must appear');
});

test('W369 #9 — privacy_leak opportunity surfaces when sensitive + allow policy', async () => {
  eventStore._resetForTests();
  for (let i = 0; i < 5; i++) {
    await eventStore.appendEvent(_seed({
      event_id: 'evt_w369_9_' + i,
      namespace: 'leak-ns',
      sensitive_data_detected: true,
      sensitive_classes: ['email', 'ssn'],
      redaction_policy: 'allow',
    }));
  }
  const opps = await opp.findOpportunities({ namespace: 'leak-ns' });
  const leak = opps.find(o => o.type === 'privacy_leak');
  assert.ok(leak, 'must detect privacy_leak when sensitive + allow policy');
  assert.equal(leak.risk, 'high', 'privacy_leak must be high risk');
  // privacy_leak sorts first
  assert.equal(opps[0].type, 'privacy_leak', 'privacy_leak is sorted to top');
});

test('W369 #10 — templateSignature is deterministic + ignores identifiers', () => {
  const a = templateSignature('Translate "hello" to spanish', 'gpt-4o-mini');
  const b = templateSignature('Translate "world" to spanish', 'gpt-4o-mini');
  const c = templateSignature('summarize this', 'gpt-4o-mini');
  assert.equal(a.hash, b.hash, 'quoted strings must be ignored');
  assert.notEqual(a.hash, c.hash, 'different templates must produce different signatures');
  // determinism
  assert.equal(templateSignature('translate to french', 'gpt-4o-mini').hash, templateSignature('translate to french', 'gpt-4o-mini').hash);
});
