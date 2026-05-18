// W383 — agent-telemetry: per-agent + per-session analytics over event-store.
//
// Reads from src/event-store.js (W369). Groups events by app_id + session_id.
// Produces dashboards: "which model works best for codex on Rust code",
// "what failed yesterday on claude-code", "show me the loop where the user
// re-prompted 6 times then gave up". Powers /account/agent-telemetry.html.
//
// ─── ACCEPTANCE HEURISTIC: HONEST LIMITS ─────────────────────────────────────
// We do NOT have a ground-truth "did the user accept this answer?" signal in
// most cases — the canonical event schema (W369) has an `accepted` field, but
// agents rarely fill it (claude-code, codex, cursor all stream and forget).
// So we infer acceptance from temporal patterns within a session:
//
//   - If the user re-prompts within 90s on the SAME file_hint or with the SAME
//     template_signature, we mark the earlier event 'corrected' — they were
//     fixing what we gave them.
//   - If they wait 90s-300s before re-prompting (different file/template), we
//     mark 'pending' — they may have kept the answer, may have walked away.
//   - If gap > 300s or no next event in this session, we mark 'accepted' —
//     they moved on. Could mean "great answer" or "gave up entirely".
//
// This is best-effort. Confidence (0.0-1.0) reflects how clean the signal is:
// shorter gap + matching file => high correction confidence; long gap + no
// match => high acceptance confidence; ambiguous middle => low confidence.
//
// If event.accepted === true/false is explicitly set, we honor it and stamp
// confidence 1.0 (ground truth wins).
//
// The heuristic is documented here AND echoed back in the return shape via
// `_heuristic` so dashboards can show the methodology to users.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { listEvents } from './event-store.js';
import { templateSignature } from './event-schema.js';

// Default windows for the acceptance heuristic. Exposed for tuning.
export const WINDOWS = Object.freeze({
  acceptance_s: 90,
  correction_s: 300,
});

const INFERRED_SESSION_WINDOW_MS = 5 * 60 * 1000; // 5min window for null-session grouping

// _parseSince: '24h', '7d', ISO string. Returns ISO or null.
function _parseSince(spec) {
  if (!spec) return null;
  if (spec instanceof Date) return spec.toISOString();
  const s = String(spec);
  const m = s.match(/^(\d+)([smhdw])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const mult = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[unit];
    return new Date(Date.now() - n * mult).toISOString();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function _ts(ev) {
  return new Date(ev.created_at).getTime();
}

// extract a file hint if the agent has stashed one in feedback (JSON string).
// agents that don't fill this just get null and we fall back to template_signature.
function _fileHint(ev) {
  if (!ev) return null;
  if (ev.file_hint) return String(ev.file_hint);
  // some agents tuck file context in feedback as JSON
  if (typeof ev.feedback === 'string') {
    try {
      const j = JSON.parse(ev.feedback);
      if (j && typeof j.file_hint === 'string') return j.file_hint;
      if (j && typeof j.file === 'string') return j.file;
    } catch {}
  }
  return null;
}

function _sigOf(ev) {
  if (!ev) return null;
  try {
    return templateSignature(ev.prompt_redacted || '', ev.model || '').hash;
  } catch {
    return null;
  }
}

// Infer a session_id when the agent didn't supply one. We slot events from the
// same app_id into 5-minute buckets and hash app_id + bucket-start.
function _inferredSessionId(appId, ts) {
  const bucket = Math.floor(ts / INFERRED_SESSION_WINDOW_MS) * INFERRED_SESSION_WINDOW_MS;
  const h = crypto.createHash('sha256')
    .update(String(appId || 'unknown') + ':' + bucket)
    .digest('hex')
    .slice(0, 16);
  return 'inf_' + h;
}

// _annotateSession: attach session_id (real or inferred) to a list of events.
// Returns NEW array, never mutates input.
function _withSessionIds(events) {
  return events.map(ev => {
    if (ev.session_id) return { ...ev };
    return { ...ev, session_id: _inferredSessionId(ev.app_id, _ts(ev)) };
  });
}

function _groupBy(events, keyFn) {
  const out = new Map();
  for (const ev of events) {
    const k = keyFn(ev);
    if (k == null) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(ev);
  }
  return out;
}

// ─── inferAcceptance ────────────────────────────────────────────────────────
// For each event, walk forward in the same session and decide whether the user
// re-prompted (corrected) or moved on (accepted). Read-only — returns a new
// array of {...event, acceptance_signal, acceptance_confidence}.
export function inferAcceptance({
  events,
  acceptance_window_s = WINDOWS.acceptance_s,
  correction_window_s = WINDOWS.correction_s,
} = {}) {
  if (!Array.isArray(events) || !events.length) return [];

  const W_ACC = Math.max(1, Number(acceptance_window_s) || WINDOWS.acceptance_s);
  const W_CORR = Math.max(W_ACC, Number(correction_window_s) || WINDOWS.correction_s);

  // Group by session for forward-scan. Within each session, sort asc by time.
  const withSess = _withSessionIds(events);
  const bySession = _groupBy(withSess, ev => ev.session_id);
  for (const arr of bySession.values()) {
    arr.sort((a, b) => _ts(a) - _ts(b));
  }

  // Index by event_id so we can stitch the annotated result in the caller's
  // original order.
  const annotated = new Map();
  for (const [, arr] of bySession) {
    for (let i = 0; i < arr.length; i++) {
      const cur = arr[i];
      const nxt = arr[i + 1] || null;

      // 1) Honor explicit ground-truth if the agent bothered to set accepted.
      if (cur.accepted === true) {
        annotated.set(cur.event_id, {
          ...cur,
          acceptance_signal: 'accepted',
          acceptance_confidence: 1.0,
        });
        continue;
      }
      if (cur.accepted === false) {
        annotated.set(cur.event_id, {
          ...cur,
          acceptance_signal: 'corrected',
          acceptance_confidence: 1.0,
        });
        continue;
      }

      // 2) No follow-up event in this session => user moved on => accepted.
      if (!nxt) {
        annotated.set(cur.event_id, {
          ...cur,
          acceptance_signal: 'accepted',
          acceptance_confidence: 0.6, // moderate — could be "great" or "gave up"
        });
        continue;
      }

      const gapMs = _ts(nxt) - _ts(cur);
      const gapS = gapMs / 1000;

      const curFile = _fileHint(cur);
      const nxtFile = _fileHint(nxt);
      const sameFile = curFile && nxtFile && curFile === nxtFile;
      const curSig = _sigOf(cur);
      const nxtSig = _sigOf(nxt);
      const sameSig = curSig && nxtSig && curSig === nxtSig;
      const semanticMatch = sameFile || sameSig;

      // 3) Quick re-prompt on the same file/template => correction.
      if (gapS <= W_ACC && semanticMatch) {
        // Confidence inversely proportional to gap: 0s -> 0.95, W_ACC -> 0.7.
        const conf = 0.95 - (gapS / W_ACC) * 0.25;
        annotated.set(cur.event_id, {
          ...cur,
          acceptance_signal: 'corrected',
          acceptance_confidence: Math.max(0.7, Math.min(0.95, conf)),
        });
        continue;
      }

      // 4) Within correction window but no semantic match — ambiguous.
      if (gapS <= W_CORR) {
        annotated.set(cur.event_id, {
          ...cur,
          acceptance_signal: 'pending',
          acceptance_confidence: 0.4, // honestly unsure
        });
        continue;
      }

      // 5) Gap > correction window — user truly moved on.
      // Confidence climbs with the gap (capped 0.95).
      const conf = 0.7 + Math.min(0.25, (gapS - W_CORR) / (W_CORR * 4) * 0.25);
      annotated.set(cur.event_id, {
        ...cur,
        acceptance_signal: 'accepted',
        acceptance_confidence: Math.max(0.7, Math.min(0.95, conf)),
      });
    }
  }

  // Return in input order.
  return events.map(ev => {
    const a = annotated.get(ev.event_id);
    if (a) return a;
    return { ...ev, acceptance_signal: 'unknown', acceptance_confidence: 0.0 };
  });
}

// ─── listAgents ─────────────────────────────────────────────────────────────
// One entry per distinct app_id present in the event store. Sums cost+tokens,
// counts sessions+events, tracks first_seen + last_seen.
export async function listAgents(opts = {}) {
  const since = _parseSince(opts.since);
  const rows = await listEvents({ since, limit: 0, order: 'asc' });

  const withSess = _withSessionIds(rows);
  const byApp = _groupBy(withSess, ev => ev.app_id || 'unknown');

  const out = [];
  for (const [appId, evs] of byApp) {
    const sessions = new Set(evs.map(e => e.session_id).filter(Boolean));
    let cost = 0;
    let tokens = 0;
    let first = Infinity;
    let last = -Infinity;
    for (const ev of evs) {
      cost += Number(ev.estimated_cost_usd) || 0;
      tokens += (Number(ev.prompt_tokens) || 0) + (Number(ev.completion_tokens) || 0);
      const t = _ts(ev);
      if (t < first) first = t;
      if (t > last) last = t;
    }
    out.push({
      app_id: appId,
      sessions: sessions.size,
      events: evs.length,
      first_seen: first === Infinity ? null : new Date(first).toISOString(),
      last_seen: last === -Infinity ? null : new Date(last).toISOString(),
      total_cost_usd: Math.round(cost * 1e6) / 1e6,
      total_tokens: tokens,
    });
  }
  out.sort((a, b) => b.events - a.events);
  return out;
}

// ─── listSessions ───────────────────────────────────────────────────────────
// Per-session rollup. Optional app_id + since filter. Default limit 50.
export async function listSessions(opts = {}) {
  const appId = opts.app_id || null;
  const since = _parseSince(opts.since);
  const limit = opts.limit == null ? 50 : Math.max(1, Math.trunc(Number(opts.limit)));

  const rows = await listEvents({ since, limit: 0, order: 'asc' });
  const filtered = appId ? rows.filter(r => (r.app_id || 'unknown') === appId) : rows;
  const withSess = _withSessionIds(filtered);
  const bySession = _groupBy(withSess, ev => ev.session_id);

  // Annotate every session's events at once (cheaper than per-session call).
  const annotatedAll = inferAcceptance({ events: withSess });
  const annByEv = new Map(annotatedAll.map(e => [e.event_id, e]));

  const out = [];
  for (const [sid, evs] of bySession) {
    evs.sort((a, b) => _ts(a) - _ts(b));
    const started = _ts(evs[0]);
    const ended = _ts(evs[evs.length - 1]);
    let cost = 0;
    const models = new Set();
    let accepted = 0;
    let corrected = 0;
    const acceptanceLatencies = []; // ms from event to its 'accepted' decision
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      cost += Number(ev.estimated_cost_usd) || 0;
      if (ev.model) models.add(ev.model);
      const ann = annByEv.get(ev.event_id);
      if (!ann) continue;
      if (ann.acceptance_signal === 'accepted') {
        accepted++;
        const nxt = evs[i + 1];
        if (nxt) acceptanceLatencies.push(_ts(nxt) - _ts(ev));
      } else if (ann.acceptance_signal === 'corrected') {
        corrected++;
      }
    }
    const decided = accepted + corrected;
    const acceptanceRate = decided > 0 ? accepted / decided : 0;
    const avgTimeToAcceptanceS = acceptanceLatencies.length
      ? Math.round(acceptanceLatencies.reduce((a, b) => a + b, 0) / acceptanceLatencies.length / 1000 * 100) / 100
      : 0;

    out.push({
      session_id: sid,
      app_id: evs[0].app_id || 'unknown',
      started_at: new Date(started).toISOString(),
      ended_at: new Date(ended).toISOString(),
      event_count: evs.length,
      total_cost_usd: Math.round(cost * 1e6) / 1e6,
      models_used: [...models],
      accepted_count: accepted,
      corrected_count: corrected,
      acceptance_rate: Math.round(acceptanceRate * 1e4) / 1e4,
      avg_time_to_acceptance_s: avgTimeToAcceptanceS,
    });
  }
  out.sort((a, b) => new Date(b.ended_at).getTime() - new Date(a.ended_at).getTime());
  return out.slice(0, limit);
}

// ─── getSession ─────────────────────────────────────────────────────────────
// Full detail for one session: header + every event (annotated).
export async function getSession({ session_id } = {}) {
  if (!session_id) return null;
  const rows = await listEvents({ limit: 0, order: 'asc' });
  const withSess = _withSessionIds(rows);
  const evs = withSess.filter(e => e.session_id === session_id);
  if (!evs.length) return null;
  evs.sort((a, b) => _ts(a) - _ts(b));
  const annotated = inferAcceptance({ events: evs });
  let cost = 0;
  const models = new Set();
  for (const ev of evs) {
    cost += Number(ev.estimated_cost_usd) || 0;
    if (ev.model) models.add(ev.model);
  }
  return {
    session_id,
    app_id: evs[0].app_id || 'unknown',
    started_at: new Date(_ts(evs[0])).toISOString(),
    ended_at: new Date(_ts(evs[evs.length - 1])).toISOString(),
    event_count: evs.length,
    total_cost_usd: Math.round(cost * 1e6) / 1e6,
    models_used: [...models],
    events: annotated,
    _heuristic: {
      acceptance_window_s: WINDOWS.acceptance_s,
      correction_window_s: WINDOWS.correction_s,
      note: 'best-effort inference — see src/agent-telemetry.js header for limits',
    },
  };
}

// ─── recommendModel ─────────────────────────────────────────────────────────
// Pareto front of (acceptance_rate ↑, avg_cost ↓). When multiple candidates
// share the Pareto front, weighted score = 0.7 * acceptance_rate
// - 0.3 * normalized_cost picks the winner. Returns reason string so the
// dashboard can show "we picked X because Y".
export async function recommendModel(opts = {}) {
  const { app_id = null, codebase_hint = null, task_hint = null, since = null } = opts;
  const rows = await listEvents({ since: _parseSince(since), limit: 0, order: 'asc' });
  const filtered = (rows || []).filter(r => {
    if (app_id && (r.app_id || 'unknown') !== app_id) return false;
    if (!r.model) return false;
    return true;
  });

  if (!filtered.length) {
    return {
      recommended_model: null,
      score: 0,
      candidates: [],
      reason: 'no events match the filter — recommendation requires at least one event with a model field',
    };
  }

  const withSess = _withSessionIds(filtered);
  const annotated = inferAcceptance({ events: withSess });

  // Per-model rollup.
  const perModel = new Map();
  const sessionsPerModel = new Map(); // model -> Set<session_id>
  for (const ev of annotated) {
    const k = ev.model;
    if (!perModel.has(k)) perModel.set(k, { events: 0, accepted: 0, corrected: 0, cost: 0 });
    const m = perModel.get(k);
    m.events++;
    m.cost += Number(ev.estimated_cost_usd) || 0;
    if (ev.acceptance_signal === 'accepted') m.accepted++;
    if (ev.acceptance_signal === 'corrected') m.corrected++;
    if (!sessionsPerModel.has(k)) sessionsPerModel.set(k, new Set());
    sessionsPerModel.get(k).add(ev.session_id);
  }

  const candidates = [];
  let maxAvgCost = 0;
  for (const [model, m] of perModel) {
    const decided = m.accepted + m.corrected;
    const accRate = decided > 0 ? m.accepted / decided : 0;
    const sessions = sessionsPerModel.get(model).size;
    const avgCost = sessions > 0 ? m.cost / sessions : 0;
    if (avgCost > maxAvgCost) maxAvgCost = avgCost;
    candidates.push({
      model,
      acceptance_rate: Math.round(accRate * 1e4) / 1e4,
      avg_cost: Math.round(avgCost * 1e6) / 1e6,
      sessions,
      score: 0,
    });
  }

  // Pareto front: keep candidates not strictly dominated.
  // a dominates b iff a.acc >= b.acc AND a.cost <= b.cost AND (a.acc > b.acc OR a.cost < b.cost)
  const dominated = new Set();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      const a = candidates[j];
      const b = candidates[i];
      const dominatesB =
        a.acceptance_rate >= b.acceptance_rate &&
        a.avg_cost <= b.avg_cost &&
        (a.acceptance_rate > b.acceptance_rate || a.avg_cost < b.avg_cost);
      if (dominatesB) {
        dominated.add(i);
        break;
      }
    }
  }
  const front = candidates.filter((_, i) => !dominated.has(i));

  // Score every candidate (so callers can rank the whole list).
  for (const c of candidates) {
    const normCost = maxAvgCost > 0 ? c.avg_cost / maxAvgCost : 0;
    c.score = Math.round((0.7 * c.acceptance_rate - 0.3 * normCost) * 1e4) / 1e4;
  }
  candidates.sort((a, b) => b.score - a.score);

  // Pick winner from the Pareto front by weighted score.
  let winner = null;
  for (const c of candidates) {
    if (front.includes(c)) { winner = c; break; }
  }
  if (!winner) winner = candidates[0];

  let reason = `picked ${winner.model}: acceptance_rate=${winner.acceptance_rate} avg_cost=$${winner.avg_cost.toFixed(6)} over ${winner.sessions} session(s).`;
  if (front.length > 1) {
    reason += ` Pareto front had ${front.length} non-dominated candidates; weighted score = 0.7*acceptance - 0.3*normalized_cost broke the tie.`;
  } else if (front.length === 1) {
    reason += ' Single Pareto-optimal candidate (no other model is both as accurate and as cheap).';
  }
  if (codebase_hint) reason += ` (codebase_hint=${codebase_hint} — not yet a separate signal; logged for future routing.)`;
  if (task_hint) reason += ` (task_hint=${task_hint} — not yet a separate signal; logged for future routing.)`;

  return {
    recommended_model: winner.model,
    score: winner.score,
    candidates,
    reason,
  };
}

// ─── topFailingPromptShapes ─────────────────────────────────────────────────
// Ranks template_signature shapes by acceptance_rate ascending (worst first),
// then count descending (most painful shapes surface). Returns at most `limit`.
export async function topFailingPromptShapes(opts = {}) {
  const { app_id = null, since = null, limit = 10 } = opts;
  const rows = await listEvents({ since: _parseSince(since), limit: 0, order: 'asc' });
  const filtered = (rows || []).filter(r => {
    if (app_id && (r.app_id || 'unknown') !== app_id) return false;
    if (!r.prompt_redacted) return false;
    return true;
  });

  if (!filtered.length) return [];

  const withSess = _withSessionIds(filtered);
  const annotated = inferAcceptance({ events: withSess });

  const bySig = new Map(); // sig -> {sample_prompt, count, accepted, corrected}
  for (const ev of annotated) {
    const sig = _sigOf(ev);
    if (!sig) continue;
    if (!bySig.has(sig)) {
      bySig.set(sig, { sample_prompt: String(ev.prompt_redacted || '').slice(0, 240), count: 0, accepted: 0, corrected: 0 });
    }
    const b = bySig.get(sig);
    b.count++;
    if (ev.acceptance_signal === 'accepted') b.accepted++;
    if (ev.acceptance_signal === 'corrected') b.corrected++;
  }

  const out = [];
  for (const [sig, b] of bySig) {
    const decided = b.accepted + b.corrected;
    const accRate = decided > 0 ? b.accepted / decided : 0;
    out.push({
      template_signature: sig,
      sample_prompt: b.sample_prompt,
      count: b.count,
      acceptance_rate: Math.round(accRate * 1e4) / 1e4,
    });
  }
  // Worst first (lowest acceptance), then highest count.
  out.sort((a, b) => {
    if (a.acceptance_rate !== b.acceptance_rate) return a.acceptance_rate - b.acceptance_rate;
    return b.count - a.count;
  });
  return out.slice(0, Math.max(1, Math.trunc(Number(limit)) || 10));
}

// ─── agentTelemetryStats ────────────────────────────────────────────────────
// Top-level dashboard summary. Cheap one-call snapshot for the headline page.
export async function agentTelemetryStats(opts = {}) {
  const since = _parseSince(opts.since);
  const rows = await listEvents({ since, limit: 0, order: 'asc' });

  if (!rows.length) {
    return {
      total_agent_calls: 0,
      total_sessions: 0,
      by_app: {},
      top_workflows: [],
      cost_by_app: {},
      _heuristic: {
        acceptance_window_s: WINDOWS.acceptance_s,
        correction_window_s: WINDOWS.correction_s,
        note: 'best-effort inference — see src/agent-telemetry.js header for limits',
      },
    };
  }

  const withSess = _withSessionIds(rows);
  const annotated = inferAcceptance({ events: withSess });

  const allSessions = new Set();
  const by_app = {};
  const cost_by_app = {};
  const workflowCounts = new Map();

  for (const ev of annotated) {
    const app = ev.app_id || 'unknown';
    allSessions.add(ev.session_id);
    if (!by_app[app]) {
      by_app[app] = { events: 0, sessions: new Set(), accepted: 0, corrected: 0, models: new Set() };
      cost_by_app[app] = 0;
    }
    const a = by_app[app];
    a.events++;
    a.sessions.add(ev.session_id);
    if (ev.model) a.models.add(ev.model);
    if (ev.acceptance_signal === 'accepted') a.accepted++;
    if (ev.acceptance_signal === 'corrected') a.corrected++;
    cost_by_app[app] += Number(ev.estimated_cost_usd) || 0;
    if (ev.workflow_id) {
      workflowCounts.set(ev.workflow_id, (workflowCounts.get(ev.workflow_id) || 0) + 1);
    }
  }

  // Materialize sets/numbers for JSON-safe output.
  for (const k of Object.keys(by_app)) {
    const a = by_app[k];
    const decided = a.accepted + a.corrected;
    by_app[k] = {
      events: a.events,
      sessions: a.sessions.size,
      accepted: a.accepted,
      corrected: a.corrected,
      acceptance_rate: decided > 0 ? Math.round((a.accepted / decided) * 1e4) / 1e4 : 0,
      models: [...a.models],
    };
    cost_by_app[k] = Math.round(cost_by_app[k] * 1e6) / 1e6;
  }

  const top_workflows = [...workflowCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([workflow_id, count]) => ({ workflow_id, count }));

  return {
    total_agent_calls: rows.length,
    total_sessions: allSessions.size,
    by_app,
    top_workflows,
    cost_by_app,
    _heuristic: {
      acceptance_window_s: WINDOWS.acceptance_s,
      correction_window_s: WINDOWS.correction_s,
      note: 'best-effort inference — see src/agent-telemetry.js header for limits',
    },
  };
}
