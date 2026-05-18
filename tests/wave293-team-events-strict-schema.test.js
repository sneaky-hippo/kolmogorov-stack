// W293 — team events strict per-kind schema + review states.
//
// Before this wave src/team-events.js validated only top-level fields (kind,
// actor, artifact_version, payload as object). The payload itself was free
// shape. That meant a "positive" event could land with no input/output and
// a "correction" event could land with no good_output, and the downstream
// seed exporter would silently skip the malformed rows. W293 makes the
// schema strict: each EVENT_KIND now has a frozen schema in EVENT_SCHEMAS
// that lists required payload fields, and append() throws if any are
// missing.
//
// W293 also adds *review states* to every appended event. A real team's
// learning log carries both "the operator typed this" and "a reviewer
// looked at it and decided". Without a review state every event is treated
// as ground truth at compile time. W294 builds the gate that uses these
// states; W293 lays the foundation:
//   - every event lands with `review.state = 'pending'`
//   - REVIEW_STATES enumerates the legal transitions
//   - setReview(team, {event_hash, state, reviewer, note}) appends a
//     `review_decision` event that supersedes the prior decision
//   - getReview(team, event_hash) returns the latest decision
//   - last-write-wins per event_hash (the chain is the audit trail)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_KINDS,
  EVENT_SCHEMAS,
  REVIEW_STATES,
  append,
  setReview,
  getReview,
  _resetForTest,
} from '../src/team-events.js';

process.env.NODE_ENV = 'test';

const T = 'w293-test-team';

test('W293 EVENT_SCHEMAS frozen and one entry per EVENT_KIND', () => {
  assert.ok(EVENT_SCHEMAS && typeof EVENT_SCHEMAS === 'object');
  assert.ok(Object.isFrozen(EVENT_SCHEMAS));
  for (const kind of Object.values(EVENT_KINDS)) {
    assert.ok(EVENT_SCHEMAS[kind], `missing schema for kind ${kind}`);
    assert.ok(Array.isArray(EVENT_SCHEMAS[kind].required));
  }
});

test('W293 positive event requires payload.input + payload.output', async () => {
  await _resetForTest(T);
  await assert.rejects(
    append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: {} }),
    /input|output|required|missing/i,
  );
  await assert.rejects(
    append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'i' } }),
    /output|required|missing/i,
  );
  const e = await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'i', output: 'o' } });
  assert.ok(e.hash);
});

test('W293 correction event requires input + bad_output + good_output', async () => {
  await _resetForTest(T);
  await assert.rejects(
    append(T, { kind: 'correction', actor: 'a', artifact_version: 'v1', payload: { input: 'i', output: 'o' } }),
    /bad_output|good_output|required/i,
  );
  const e = await append(T, {
    kind: 'correction',
    actor: 'a',
    artifact_version: 'v1',
    payload: { input: 'i', bad_output: 'bad', good_output: 'good' },
  });
  assert.ok(e.hash);
});

test('W293 regression_flag event requires holdout_row_id', async () => {
  await _resetForTest(T);
  await assert.rejects(
    append(T, { kind: 'regression_flag', actor: 'a', artifact_version: 'v1', payload: { note: 'broke' } }),
    /holdout_row_id|required/i,
  );
  const e = await append(T, {
    kind: 'regression_flag',
    actor: 'a',
    artifact_version: 'v1',
    payload: { holdout_row_id: 'r-001', expected: 'x', got: 'y' },
  });
  assert.ok(e.hash);
});

test('W293 REVIEW_STATES enumerated and frozen', () => {
  assert.deepEqual([...REVIEW_STATES].sort(), ['approved', 'needs_revision', 'pending', 'rejected']);
  assert.ok(Object.isFrozen(REVIEW_STATES));
});

test('W293 newly appended event carries review.state = pending', async () => {
  await _resetForTest(T);
  const e = await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'i', output: 'o' } });
  assert.ok(e.review, 'event must have review block');
  assert.equal(e.review.state, 'pending');
  assert.ok(e.review.created_at);
});

test('W293 setReview appends review_decision event with the target hash', async () => {
  await _resetForTest(T);
  const e = await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'i', output: 'o' } });
  const r = await setReview(T, { event_hash: e.hash, state: 'approved', reviewer: 'lead', note: 'lgtm' });
  assert.equal(r.kind, 'review_decision');
  assert.equal(r.payload.event_hash, e.hash);
  assert.equal(r.payload.state, 'approved');
  assert.equal(r.payload.reviewer, 'lead');
  assert.equal(r.payload.note, 'lgtm');
});

test('W293 setReview throws on unknown state', async () => {
  await _resetForTest(T);
  const e = await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'i', output: 'o' } });
  await assert.rejects(
    setReview(T, { event_hash: e.hash, state: 'maybe', reviewer: 'lead' }),
    /unknown.*state|invalid.*state/i,
  );
});

test('W293 getReview returns latest decision (last-write-wins)', async () => {
  await _resetForTest(T);
  const e = await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'i', output: 'o' } });
  assert.equal((await getReview(T, e.hash)).state, 'pending');
  await setReview(T, { event_hash: e.hash, state: 'needs_revision', reviewer: 'lead' });
  assert.equal((await getReview(T, e.hash)).state, 'needs_revision');
  await setReview(T, { event_hash: e.hash, state: 'approved', reviewer: 'manager' });
  assert.equal((await getReview(T, e.hash)).state, 'approved');
});

test('W293 review_decision events also validate (need event_hash, state, reviewer)', async () => {
  await _resetForTest(T);
  await assert.rejects(
    append(T, { kind: 'review_decision', actor: 'a', artifact_version: 'v1', payload: { state: 'approved' } }),
    /event_hash|required/i,
  );
});
