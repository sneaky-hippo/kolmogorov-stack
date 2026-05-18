// W369 — lake: pure-function analytics over the event-store.
//
// Reads events via src/event-store.js, returns deterministic aggregates.
// No HTTP / no fetch / no I/O beyond what event-store does. Pure JS so it
// can run inside the CLI (`kolm lake stats`) and the public dashboard (via
// SSR import) without diverging.

import { listEvents, countEvents, storeInfo, streamEvents } from './event-store.js';
import { templateSignature } from './event-schema.js';
import fs from 'node:fs';

function _parseSince(spec) {
  if (!spec) return null;
  const m = String(spec).match(/^(\d+)([smhdw])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const mult = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[unit];
    return new Date(Date.now() - n * mult).toISOString();
  }
  const d = new Date(spec);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function _avg(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += Number(x) || 0;
  return s / xs.length;
}

function _round(n, places = 2) {
  const p = Math.pow(10, places);
  return Math.round(n * p) / p;
}

function _diskUsed(filePath) {
  try {
    const s = fs.statSync(filePath);
    return s.size;
  } catch { return 0; }
}

// lakeStats({since, namespace}): structured snapshot of everything in the
// lake right now. Honest counts; never makes up numbers.
export async function lakeStats(opts = {}) {
  const since = _parseSince(opts.since) || _parseSince('30d');
  const rows = await listEvents({
    namespace: opts.namespace,
    since,
    limit: 0, // unlimited
    order: 'asc',
  });

  const total_calls = rows.length;
  let total_spend_usd = 0;
  let total_prompt_tokens = 0;
  let total_completion_tokens = 0;
  const latencies = [];
  const providers = {};
  const models = {};
  const workflows = {};
  const redactions_by_class = {};
  let sensitive_events = 0;

  for (const r of rows) {
    total_spend_usd += Number(r.estimated_cost_usd) || 0;
    total_prompt_tokens += Number(r.prompt_tokens) || 0;
    total_completion_tokens += Number(r.completion_tokens) || 0;
    if (Number.isFinite(r.latency_ms)) latencies.push(Number(r.latency_ms));

    if (r.provider) {
      providers[r.provider] = providers[r.provider] || { calls: 0, spend: 0, avg_latency: 0, _lats: [] };
      providers[r.provider].calls++;
      providers[r.provider].spend += Number(r.estimated_cost_usd) || 0;
      providers[r.provider]._lats.push(Number(r.latency_ms) || 0);
    }
    if (r.model) {
      models[r.model] = models[r.model] || { calls: 0, spend: 0, avg_latency: 0, _lats: [] };
      models[r.model].calls++;
      models[r.model].spend += Number(r.estimated_cost_usd) || 0;
      models[r.model]._lats.push(Number(r.latency_ms) || 0);
    }
    if (r.workflow_id) {
      workflows[r.workflow_id] = workflows[r.workflow_id] || { workflow_id: r.workflow_id, calls: 0, spend: 0 };
      workflows[r.workflow_id].calls++;
      workflows[r.workflow_id].spend += Number(r.estimated_cost_usd) || 0;
    }

    if (r.sensitive_data_detected) sensitive_events++;
    if (Array.isArray(r.sensitive_classes)) {
      for (const cls of r.sensitive_classes) {
        redactions_by_class[cls] = (redactions_by_class[cls] || 0) + 1;
      }
    }
  }

  for (const k of Object.keys(providers)) {
    providers[k].avg_latency = Math.round(_avg(providers[k]._lats));
    providers[k].spend = _round(providers[k].spend, 4);
    delete providers[k]._lats;
  }
  for (const k of Object.keys(models)) {
    models[k].avg_latency = Math.round(_avg(models[k]._lats));
    models[k].spend = _round(models[k].spend, 4);
    delete models[k]._lats;
  }

  const top_workflows = Object.values(workflows)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10)
    .map(w => ({ workflow_id: w.workflow_id, calls: w.calls, spend: _round(w.spend, 4) }));

  const repeated = await clusterRepeatedPrompts(rows);
  const repeated_clusters = repeated.slice(0, 10).map(c => ({
    pattern: c.normalized,
    count: c.count,
    signature: c.signature,
  }));

  const info = storeInfo();
  const disk_used_bytes = info.db_path ? _diskUsed(info.db_path) : _diskUsed(info.jsonl_path);
  const oldest_event = rows.length ? rows[0].created_at : null;
  const newest_event = rows.length ? rows[rows.length - 1].created_at : null;

  return {
    total_calls,
    total_spend_usd: _round(total_spend_usd, 4),
    total_tokens: { prompt: total_prompt_tokens, completion: total_completion_tokens },
    avg_latency_ms: Math.round(_avg(latencies)),
    providers,
    models,
    sensitive_events,
    redactions_by_class,
    repeated_clusters,
    top_workflows,
    storage: {
      driver: info.driver,
      path: info.db_path || info.jsonl_path,
      disk_used_bytes,
      oldest_event,
      newest_event,
    },
    window: { since, namespace: opts.namespace || null },
  };
}

// clusterRepeatedPrompts(events) -> [{signature, normalized, count, sample_event_ids, avg_cost, avg_latency, providers}].
// Groups events by templateSignature(prompt_redacted || request_hash, model).
// Returns clusters sorted by count desc.
export async function clusterRepeatedPrompts(events) {
  const groups = new Map();
  for (const ev of events || []) {
    const sigInput = ev.prompt_redacted || ev.request_hash || '';
    if (!sigInput) continue;
    const sig = templateSignature(sigInput, ev.model || '');
    const k = sig.hash;
    let g = groups.get(k);
    if (!g) {
      g = {
        signature: k,
        normalized: sig.normalized,
        count: 0,
        sample_event_ids: [],
        _cost: 0,
        _lat: 0,
        providers: new Set(),
        models: new Set(),
      };
      groups.set(k, g);
    }
    g.count++;
    g._cost += Number(ev.estimated_cost_usd) || 0;
    g._lat += Number(ev.latency_ms) || 0;
    if (g.sample_event_ids.length < 5) g.sample_event_ids.push(ev.event_id);
    if (ev.provider) g.providers.add(ev.provider);
    if (ev.model) g.models.add(ev.model);
  }
  const out = [];
  for (const g of groups.values()) {
    out.push({
      signature: g.signature,
      normalized: g.normalized,
      count: g.count,
      sample_event_ids: g.sample_event_ids,
      avg_cost: g.count > 0 ? _round(g._cost / g.count, 6) : 0,
      avg_latency: g.count > 0 ? Math.round(g._lat / g.count) : 0,
      providers: Array.from(g.providers),
      models: Array.from(g.models),
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

// tailEvents({namespace, follow}): async iterable of new events. When
// follow=false yields one batch of the most recent events and returns.
export async function* tailEvents(opts = {}) {
  const namespace = opts.namespace || null;
  const limit = opts.limit || 50;
  const follow = !!opts.follow;
  // 1) drain history first
  const hist = await listEvents({ namespace, limit, order: 'desc' });
  for (const ev of hist.reverse()) yield ev;
  if (!follow) return;
  // 2) live: subscribe and yield via a tiny queue.
  const queue = [];
  let resolveNext = null;
  const unsub = streamEvents((ev) => {
    if (namespace && ev.namespace !== namespace) return;
    queue.push(ev);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  });
  try {
    while (true) {
      if (queue.length === 0) await new Promise(r => { resolveNext = r; });
      while (queue.length) yield queue.shift();
    }
  } finally {
    unsub();
  }
}

export { countEvents };
