// W265 — usage analytics aggregator.
//
// The /dashboard page (public/dashboard.html) needs deterministic
// aggregation primitives over the three load-bearing tables in
// src/store.js: observations (captures), invocations (artifact runs),
// and team-events (drift_observation entries + regression_flags). This
// module owns those pure functions so the dashboard, the CLI
// (`kolm stats`), and the third-party-monitoring SDK all read from one
// source of truth.
//
// Design:
//   - All aggregators take an array as input. They do not touch the
//     store — callers pull rows themselves with whatever filter applies
//     (tenant, since, namespace). That makes them trivially testable.
//   - Latency percentiles are computed from `latency_us`; missing values
//     are skipped, NOT counted as zero.
//   - Error rate = rows with `error` truthy / total rows. Rows with
//     status >= 400 also count as errors.
//   - Day buckets are UTC YYYY-MM-DD strings derived from the row's
//     timestamp (`ts` or `timestamp` or `recorded_at`).
//   - Drift signal axes come from team-events with kind='drift_observation'
//     payload.signal — we tally counts per (axis) where axis is the
//     payload.signal.axis or payload.axis hint, falling back to 'unknown'.

function _percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function _ts(row) {
  return row.ts || row.timestamp || row.recorded_at || null;
}

function _day(iso) {
  if (!iso || typeof iso !== 'string') return null;
  return iso.slice(0, 10);
}

function _bucketBy(rows, keyFn) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// Captures table summary. Pass rows out of the `observations` table.
// Filters (since, namespace, tenant) are the caller's responsibility.
export function summarizeCaptures(rows = [], opts = {}) {
  const total = rows.length;
  const by_namespace = _bucketBy(rows, r => r.namespace);
  const by_runtime_target = _bucketBy(rows, r => r.runtime_target);
  const by_day = {};
  for (const r of rows) {
    const d = _day(_ts(r));
    if (d) by_day[d] = (by_day[d] || 0) + 1;
  }
  const latencies = rows
    .map(r => Number(r.latency_us))
    .filter(v => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const errors = rows.filter(r => {
    if (r.error) return true;
    const s = Number(r.status);
    return Number.isFinite(s) && s >= 400;
  }).length;
  const durable = rows.filter(r => r.x_kolm_capture_durable === true || r.durable === true).length;
  return {
    total,
    by_namespace,
    by_runtime_target,
    by_day,
    p50_latency_us: _percentile(latencies, 50),
    p95_latency_us: _percentile(latencies, 95),
    p99_latency_us: _percentile(latencies, 99),
    error_count: errors,
    error_rate: total > 0 ? errors / total : 0,
    durable_count: durable,
    durable_rate: total > 0 ? durable / total : 0,
    since: opts.since || null,
  };
}

// Invocations table summary. Pass rows out of `invocations`. Each row
// should carry version_id, concept_id, latency_us, error?, ts.
export function summarizeInvocations(rows = []) {
  const total = rows.length;
  const by_recipe = _bucketBy(rows, r => r.concept_id || r.recipe_id);
  const by_version = _bucketBy(rows, r => r.version_id);
  const cache_hits = rows.filter(r => r.cache_hit).length;
  const latencies = rows
    .map(r => Number(r.latency_us))
    .filter(v => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const errors = rows.filter(r => r.error).length;
  return {
    total,
    by_recipe,
    by_version,
    cache_hit_count: cache_hits,
    cache_hit_rate: total > 0 ? cache_hits / total : 0,
    p50_latency_us: _percentile(latencies, 50),
    p95_latency_us: _percentile(latencies, 95),
    error_count: errors,
    error_rate: total > 0 ? errors / total : 0,
  };
}

// Drift signal summary. Pass team-events rows with kind='drift_observation'
// or kind='regression_flag'. Returns counts by axis + last_observed.
export function summarizeDriftSignals(events = []) {
  const drift = events.filter(e => e.kind === 'drift_observation');
  const regr = events.filter(e => e.kind === 'regression_flag');
  const by_axis = {};
  for (const e of drift) {
    const axis = (e.payload && (e.payload.axis || (e.payload.signal && e.payload.signal.axis))) || 'unknown';
    by_axis[axis] = (by_axis[axis] || 0) + 1;
  }
  const all = [...drift, ...regr];
  const last_observed = all.length > 0
    ? all.map(e => e.timestamp).filter(Boolean).sort().slice(-1)[0]
    : null;
  return {
    drift_count: drift.length,
    regression_count: regr.length,
    total: drift.length + regr.length,
    by_axis,
    last_observed,
  };
}

// Composite dashboard summary. Takes pre-pulled rows and returns the
// full top-of-page summary the /dashboard renders.
export function dashboardSummary({ captures = [], invocations = [], driftEvents = [], since = null } = {}) {
  return {
    captures: summarizeCaptures(captures, { since }),
    invocations: summarizeInvocations(invocations),
    drift: summarizeDriftSignals(driftEvents),
    generated_at: new Date().toISOString(),
    window: { since },
  };
}

export default {
  summarizeCaptures,
  summarizeInvocations,
  summarizeDriftSignals,
  dashboardSummary,
};
