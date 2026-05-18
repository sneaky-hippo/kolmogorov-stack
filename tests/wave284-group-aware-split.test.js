// W284 — group-aware split. Two rows about the same member_id / claim_id /
// case_id must end up in the same train/holdout partition. Otherwise a
// model trained on member_42's claim #1 has effectively seen the holdout
// when scored on member_42's claim #2.
//
// Asserts BEHAVIOR:
//   1) splitSeeds with no group_key splits row-by-row (existing behavior).
//   2) splitSeeds with group_key='member_id' groups rows sharing the same
//      metadata.member_id and routes them together.
//   3) The grouping respects deterministic bucket hashing — same group key
//      + same split_seed → same partition assignment across machines.
//   4) prepareSeedSplit accepts a group_key option and threads it down.
//   5) The leakage_report counts grouped_overlap_count = 0 when grouping
//      is enforced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { splitSeeds, prepareSeedSplit, hashSeeds } from '../src/seeds.js';

test('W284 splitSeeds without group_key keeps existing row-by-row behavior', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    input: 'row ' + i,
    expected: 'out ' + i,
    metadata: { tags: [] },
  }));
  const sp = splitSeeds(rows, { split_seed: 'test-seed-w284' });
  assert.equal(sp.train.length + sp.holdout.length, 50);
  assert.ok(sp.train.length > 0);
  assert.ok(sp.holdout.length > 0);
});

test('W284 splitSeeds with group_key=member_id groups rows together', () => {
  // Build 30 rows across 10 members (3 rows per member). With per-row hash
  // splitting some members would end up with rows in both partitions; with
  // group-aware split, every member's 3 rows must land in the same partition.
  const rows = [];
  for (let m = 0; m < 10; m++) {
    for (let k = 0; k < 3; k++) {
      rows.push({
        input: `member ${m} doc ${k}`,
        expected: 'out',
        metadata: { member_id: 'm' + m, tags: [] },
      });
    }
  }
  const sp = splitSeeds(rows, { split_seed: 's', holdout_ratio: 0.3, group_key: 'member_id' });
  // For each member, all rows must land in the same partition.
  const memberPartition = new Map();
  for (const r of sp.train) {
    const m = r.metadata.member_id;
    if (memberPartition.has(m) && memberPartition.get(m) !== 'train') {
      assert.fail(`member ${m} appears in both partitions — group-aware split failed`);
    }
    memberPartition.set(m, 'train');
  }
  for (const r of sp.holdout) {
    const m = r.metadata.member_id;
    if (memberPartition.has(m) && memberPartition.get(m) !== 'holdout') {
      assert.fail(`member ${m} appears in both partitions — group-aware split failed`);
    }
    memberPartition.set(m, 'holdout');
  }
  assert.equal(memberPartition.size, 10, 'all 10 members should be assigned');
});

test('W284 group split is deterministic across runs given same seed', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    input: `r${i}`,
    expected: 'x',
    metadata: { case_id: 'c' + (i % 6), tags: [] },
  }));
  const sp1 = splitSeeds(rows, { split_seed: 'fixed', holdout_ratio: 0.3, group_key: 'case_id' });
  const sp2 = splitSeeds(rows, { split_seed: 'fixed', holdout_ratio: 0.3, group_key: 'case_id' });
  const h1 = hashSeeds(sp1.train);
  const h2 = hashSeeds(sp2.train);
  assert.equal(h1, h2, 'identical inputs + split_seed + group_key should produce identical splits');
});

test('W284 prepareSeedSplit accepts group_key and surfaces it', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w284-'));
  const seedsPath = path.join(tmpDir, 'seeds.jsonl');
  const rows = [];
  for (let m = 0; m < 5; m++) {
    for (let k = 0; k < 4; k++) {
      rows.push({ input: `m${m}-doc-${k}`, expected: 'x', metadata: { claim_id: 'cl' + m } });
    }
  }
  fs.writeFileSync(seedsPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const res = prepareSeedSplit({ seedsPath, group_key: 'claim_id' });
  assert.ok(res);
  assert.equal(res.group_key, 'claim_id', 'group_key must be surfaced for the manifest');
  // No claim should straddle the split.
  const partition = new Map();
  for (const r of res.train) partition.set(r.metadata.claim_id, 'train');
  for (const r of res.holdout) {
    const cur = partition.get(r.metadata.claim_id);
    if (cur === 'train') {
      assert.fail(`claim ${r.metadata.claim_id} straddles train/holdout under group-aware split`);
    }
    partition.set(r.metadata.claim_id, 'holdout');
  }
});

test('W284 group split with metadata.tags member_id:42 fallback works', () => {
  // Real seed files often carry the group identifier in a `tags` array like
  // ["member_id:12345"] rather than a top-level metadata field. Verify the
  // split function reads from there as well.
  const rows = [];
  for (let m = 0; m < 8; m++) {
    for (let k = 0; k < 2; k++) {
      rows.push({
        input: `mem${m}-rec${k}`,
        expected: 'x',
        metadata: { tags: ['member_id:m' + m, 'channel:mail'] },
      });
    }
  }
  const sp = splitSeeds(rows, { split_seed: 's', holdout_ratio: 0.3, group_key: 'member_id' });
  const seen = new Map();
  for (const r of sp.train) {
    const tag = r.metadata.tags.find(t => t.startsWith('member_id:'));
    const v = tag.split(':')[1];
    if (seen.has(v) && seen.get(v) !== 'train') assert.fail(`member ${v} in both partitions`);
    seen.set(v, 'train');
  }
  for (const r of sp.holdout) {
    const tag = r.metadata.tags.find(t => t.startsWith('member_id:'));
    const v = tag.split(':')[1];
    if (seen.has(v) && seen.get(v) !== 'holdout') assert.fail(`member ${v} in both partitions`);
    seen.set(v, 'holdout');
  }
});

test('W284 prepareSeedSplit reports zero grouped_overlap when group_key set', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w284-'));
  const seedsPath = path.join(tmpDir, 'seeds.jsonl');
  const rows = [];
  for (let m = 0; m < 6; m++) {
    for (let k = 0; k < 3; k++) {
      rows.push({
        input: `case ${m}-${k}`,
        expected: 'x',
        tags: ['case_id:c' + m],
      });
    }
  }
  fs.writeFileSync(seedsPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const res = prepareSeedSplit({ seedsPath, group_key: 'case_id' });
  assert.ok(res);
  assert.equal(res.leakage_report.grouped_overlap_count, 0,
    'grouped_overlap_count must be 0 once group-aware split is enforced');
});
