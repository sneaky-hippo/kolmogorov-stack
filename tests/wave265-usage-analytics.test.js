// W265 — usage analytics aggregator behavior tests.
//
// The /dashboard page already exists (public/dashboard.html, 2,360 lines)
// but until this wave there was no single pure-function module the
// dashboard, the CLI (`kolm stats`), and the third-party monitoring
// SDK could all read from. W265 adds src/usage-analytics.js with four
// load-bearing aggregators. These tests assert the math, not the page
// copy — per the W202-W210 anti-pattern correction Pablo flagged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeCaptures,
  summarizeInvocations,
  summarizeDriftSignals,
  dashboardSummary,
} from '../src/usage-analytics.js';

test('W265 summarizeCaptures: empty rows return zeroed summary', () => {
  const s = summarizeCaptures([]);
  assert.equal(s.total, 0);
  assert.equal(s.error_rate, 0);
  assert.equal(s.p50_latency_us, null);
});

test('W265 summarizeCaptures: buckets by namespace + runtime_target + day', () => {
  const rows = [
    { namespace: 'support', runtime_target: 'js', latency_us: 50, ts: '2026-05-18T10:00:00Z' },
    { namespace: 'support', runtime_target: 'js', latency_us: 100, ts: '2026-05-18T11:00:00Z' },
    { namespace: 'claims', runtime_target: 'gguf', latency_us: 500, ts: '2026-05-17T22:00:00Z' },
  ];
  const s = summarizeCaptures(rows);
  assert.equal(s.total, 3);
  assert.equal(s.by_namespace.support, 2);
  assert.equal(s.by_namespace.claims, 1);
  assert.equal(s.by_runtime_target.js, 2);
  assert.equal(s.by_runtime_target.gguf, 1);
  assert.equal(s.by_day['2026-05-18'], 2);
  assert.equal(s.by_day['2026-05-17'], 1);
});

test('W265 summarizeCaptures: p50/p95 latency from sorted values', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ latency_us: i + 1, ts: '2026-05-18T10:00:00Z' }));
  const s = summarizeCaptures(rows);
  assert.equal(s.p50_latency_us, 51);
  assert.equal(s.p95_latency_us, 96);
});

test('W265 summarizeCaptures: error_rate counts status >= 400 + error truthy', () => {
  const rows = [
    { status: 200, ts: '2026-05-18T10:00:00Z' },
    { status: 500, ts: '2026-05-18T10:00:00Z' },
    { status: 200, error: 'something', ts: '2026-05-18T10:00:00Z' },
    { status: 404, ts: '2026-05-18T10:00:00Z' },
  ];
  const s = summarizeCaptures(rows);
  assert.equal(s.error_count, 3);
  assert.equal(s.error_rate, 0.75);
});

test('W265 summarizeCaptures: durable_count tracks W212 x-kolm-capture-durable receipt', () => {
  const rows = [
    { x_kolm_capture_durable: true, ts: '2026-05-18T10:00:00Z' },
    { durable: true, ts: '2026-05-18T10:00:00Z' },
    { ts: '2026-05-18T10:00:00Z' },
  ];
  const s = summarizeCaptures(rows);
  assert.equal(s.durable_count, 2);
  assert.equal(s.total, 3);
  assert.ok(Math.abs(s.durable_rate - 2 / 3) < 1e-9);
});

test('W265 summarizeInvocations: cache_hit_rate + p50/p95', () => {
  const rows = [
    { concept_id: 'c1', version_id: 'v1', latency_us: 10, cache_hit: true },
    { concept_id: 'c1', version_id: 'v1', latency_us: 30, cache_hit: false },
    { concept_id: 'c2', version_id: 'v2', latency_us: 50, cache_hit: true },
    { concept_id: 'c2', version_id: 'v2', latency_us: 70, cache_hit: false, error: 'boom' },
  ];
  const s = summarizeInvocations(rows);
  assert.equal(s.total, 4);
  assert.equal(s.cache_hit_count, 2);
  assert.equal(s.cache_hit_rate, 0.5);
  assert.equal(s.error_count, 1);
  assert.equal(s.error_rate, 0.25);
  assert.equal(s.by_recipe.c1, 2);
  assert.equal(s.by_recipe.c2, 2);
  assert.equal(s.p50_latency_us, 50);
});

test('W265 summarizeDriftSignals: counts drift_observation by axis + tracks regression_flag', () => {
  const events = [
    { kind: 'drift_observation', payload: { axis: 'icd10' }, timestamp: '2026-05-18T10:00:00Z' },
    { kind: 'drift_observation', payload: { axis: 'icd10' }, timestamp: '2026-05-18T11:00:00Z' },
    { kind: 'drift_observation', payload: { axis: 'cpt' }, timestamp: '2026-05-18T12:00:00Z' },
    { kind: 'drift_observation', payload: {}, timestamp: '2026-05-18T13:00:00Z' },
    { kind: 'regression_flag', payload: { holdout_row_id: 'r1' }, timestamp: '2026-05-18T14:00:00Z' },
  ];
  const s = summarizeDriftSignals(events);
  assert.equal(s.drift_count, 4);
  assert.equal(s.regression_count, 1);
  assert.equal(s.total, 5);
  assert.equal(s.by_axis.icd10, 2);
  assert.equal(s.by_axis.cpt, 1);
  assert.equal(s.by_axis.unknown, 1);
  assert.equal(s.last_observed, '2026-05-18T14:00:00Z');
});

test('W265 dashboardSummary: composes all three sub-aggregators + carries window.since', () => {
  const captures = [{ namespace: 'a', latency_us: 1, ts: '2026-05-18T10:00:00Z' }];
  const invocations = [{ concept_id: 'c1', latency_us: 5 }];
  const driftEvents = [{ kind: 'drift_observation', payload: { axis: 'x' }, timestamp: '2026-05-18T10:00:00Z' }];
  const out = dashboardSummary({ captures, invocations, driftEvents, since: '2026-05-18T00:00:00Z' });
  assert.equal(out.captures.total, 1);
  assert.equal(out.invocations.total, 1);
  assert.equal(out.drift.drift_count, 1);
  assert.equal(out.window.since, '2026-05-18T00:00:00Z');
  assert.ok(out.generated_at);
});
