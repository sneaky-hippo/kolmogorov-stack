// W294 — review gate. Only events whose latest review_decision is
// `approved` are flattened into seeds. Before this wave, exportSeeds()
// returned every POSITIVE/CORRECTION event regardless of whether anyone
// had ever reviewed it. That meant a single typo on the capture path
// would silently land in the next training set with no audit trail.
//
// W294 closes the gap:
//   1. exportSeeds(team) DEFAULTS to only_approved = true (was: no filter).
//   2. Each exported seed carries `review_decision_hash` provenance so a
//      downstream verifier can prove the approval link from the seed back
//      to the chained event log.
//   3. `include_pending: true` is the explicit escape hatch for the audit /
//      debug path (`kolm team events dump --include-pending`). It still
//      excludes rejected.
//   4. `review_decision` events never themselves export as seeds — they
//      describe a decision, they are not training data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  append,
  setReview,
  exportSeeds,
  _resetForTest,
} from '../src/team-events.js';

process.env.NODE_ENV = 'test';

const T = 'w294-test-team';

test('W294 exportSeeds DEFAULT excludes pending events', async () => {
  await _resetForTest(T);
  await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'i1', output: 'o1' } });
  const seeds = await exportSeeds(T);
  assert.equal(seeds.length, 0, 'pending events must not export by default');
});

test('W294 exportSeeds includes approved positive events', async () => {
  await _resetForTest(T);
  const e = await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'iX', output: 'oX' } });
  await setReview(T, { event_hash: e.hash, state: 'approved', reviewer: 'lead' });
  const seeds = await exportSeeds(T);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].input, 'iX');
  assert.equal(seeds[0].output, 'oX');
});

test('W294 exportSeeds excludes rejected', async () => {
  await _resetForTest(T);
  const e = await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'iY', output: 'oY' } });
  await setReview(T, { event_hash: e.hash, state: 'rejected', reviewer: 'lead' });
  const seeds = await exportSeeds(T);
  assert.equal(seeds.length, 0);
});

test('W294 exportSeeds excludes needs_revision', async () => {
  await _resetForTest(T);
  const e = await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'iR', output: 'oR' } });
  await setReview(T, { event_hash: e.hash, state: 'needs_revision', reviewer: 'lead' });
  const seeds = await exportSeeds(T);
  assert.equal(seeds.length, 0);
});

test('W294 exportSeeds for correction emits good_output (not bad_output)', async () => {
  await _resetForTest(T);
  const e = await append(T, {
    kind: 'correction',
    actor: 'a',
    artifact_version: 'v1',
    payload: { input: 'qC', bad_output: 'b', good_output: 'g' },
  });
  await setReview(T, { event_hash: e.hash, state: 'approved', reviewer: 'lead' });
  const seeds = await exportSeeds(T);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].input, 'qC');
  assert.equal(seeds[0].output, 'g');
});

test('W294 exportSeeds {include_pending:true} keeps pending but still drops rejected', async () => {
  await _resetForTest(T);
  await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'iP', output: 'oP' } });
  const rejected = await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'iZ', output: 'oZ' } });
  await setReview(T, { event_hash: rejected.hash, state: 'rejected', reviewer: 'lead' });
  const seeds = await exportSeeds(T, { include_pending: true });
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].input, 'iP');
});

test('W294 seeds carry review_decision_hash provenance', async () => {
  await _resetForTest(T);
  const e = await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'iZ', output: 'oZ' } });
  const r = await setReview(T, { event_hash: e.hash, state: 'approved', reviewer: 'lead' });
  const seeds = await exportSeeds(T);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].review_decision_hash, r.hash);
  assert.equal(seeds[0].source_event_hash, e.hash);
});

test('W294 review_decision events themselves are never exported as seeds', async () => {
  await _resetForTest(T);
  const e = await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'iN', output: 'oN' } });
  await setReview(T, { event_hash: e.hash, state: 'approved', reviewer: 'lead' });
  const seeds = await exportSeeds(T);
  assert.equal(seeds.length, 1, 'review_decision must not also export as a separate seed row');
});

test('W294 review-after-export: changing approved->rejected drops the seed on next export', async () => {
  await _resetForTest(T);
  const e = await append(T, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'iAR', output: 'oAR' } });
  await setReview(T, { event_hash: e.hash, state: 'approved', reviewer: 'lead' });
  assert.equal((await exportSeeds(T)).length, 1);
  await setReview(T, { event_hash: e.hash, state: 'rejected', reviewer: 'manager' });
  assert.equal((await exportSeeds(T)).length, 0, 'last-write-wins must propagate to seed export');
});
