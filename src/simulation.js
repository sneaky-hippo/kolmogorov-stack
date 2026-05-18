// Wave 371 - Simulation harness (builder layer, pillar 6/12).
//
// Public surface:
//   SIM_TYPES (frozen list)
//   createSim(workflowId, {type, n, personas, opts})
//   runSim(simId, {n, opts})
//   replayTrace(traceId, {against, opts})
//   generateDatasetFromSim(simId, opts)
//   evalArtifactInSim(simId, artifactPath, opts)
//   listSims({tenant})
//
// Persistence: every sim lives at ~/.kolm/simulations/<sim_id>.json with
// shape:
//   { sim_id, workflow_id, type, n, personas, opts, status,
//     created_at, last_run_at, events: [{ts, persona, input, output, ok}] }
//
// Sim events are tagged with sim_id when they hit the capture lake.
// runSim() honors KOLM_LLM_PROVIDER for the synthetic "user/tool" responses;
// the template fallback always works so a no-network dev box still produces
// useful sim output.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePersonas } from './synthetic-data.js';
import { callLLM, isConfigured, describeConfig } from './llm-call.js';

export const SIM_TYPES = Object.freeze([
  'user_simulator',
  'api_tool_simulator',
  'log_stream_simulator',
  'support_ticket_simulator',
  'incident_simulator',
  'browser_workflow_simulator',
  'payer_prior_auth_simulator',
  'privacy_red_team_simulator',
  'device_performance_simulator',
]);

const SIM_DIR = () => path.join(os.homedir(), '.kolm', 'simulations');

function ensureSimDir() {
  const d = SIM_DIR();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function newSimId() { return 'sim_' + crypto.randomBytes(8).toString('hex'); }
function nowIso() { return new Date().toISOString(); }

function simPath(simId) { return path.join(ensureSimDir(), simId + '.json'); }

function writeSim(sim) {
  fs.writeFileSync(simPath(sim.sim_id), JSON.stringify(sim, null, 2));
}
function readSim(simId) {
  const p = simPath(simId);
  if (!fs.existsSync(p)) {
    const err = new Error('sim_not_found: ' + simId);
    err.code = 'SIM_NOT_FOUND';
    throw err;
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------- per-type event generators ----------------

// Each generator emits ONE event. Async because LLM is optional. Templated
// path always works so tests pass air-gapped. Tag every event with sim_type,
// persona (when relevant), and ok bool.

async function genUserEvent(workflow, persona, opts) {
  const base = (workflow ? `[${workflow}] ` : '') + (persona ? `(${persona.name}) ` : '');
  const promptTemplates = [
    `${base}Hi, I need help with my account.`,
    `${base}Why is the dashboard broken?`,
    `${base}Cancel my subscription.`,
    `${base}How do I reset my password?`,
    `${base}I was charged twice last month.`,
  ];
  let input = promptTemplates[Math.floor(Math.random() * promptTemplates.length)];
  let output = 'simulated response (template)';
  if (isConfigured() && opts.llm !== false) {
    try {
      const { text } = await callLLM({
        system: `You are simulating a user with this persona: ${persona ? persona.tone : 'neutral'}. Output one short, plausible message a user might send to support. No commentary. No quoting.`,
        user: `Workflow: ${workflow || 'general support'}`,
        maxTokens: 200,
        temperature: 0.8,
      });
      const t = String(text || '').trim();
      if (t) input = t;
    } catch { /* template fallback retained */ }
  }
  return {
    sim_type: 'user_simulator',
    persona: persona ? persona.name : null,
    input,
    output,
    ok: true,
  };
}

async function genApiToolEvent(workflow, persona, opts) {
  const calls = [
    { tool: 'search', args: { q: 'pricing' } },
    { tool: 'fetch_user', args: { id: 'u_' + crypto.randomBytes(3).toString('hex') } },
    { tool: 'create_ticket', args: { subject: 'urgent help' } },
    { tool: 'list_orders', args: { since: '2026-01-01' } },
  ];
  const pick = calls[Math.floor(Math.random() * calls.length)];
  return {
    sim_type: 'api_tool_simulator',
    persona: null,
    input: JSON.stringify(pick),
    output: JSON.stringify({ ok: true, took_ms: 10 + Math.floor(Math.random() * 90) }),
    ok: true,
  };
}

async function genLogStreamEvent(workflow, persona, opts) {
  const levels = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
  const lvl = levels[Math.floor(Math.random() * levels.length)];
  const messages = [
    'request completed in 23ms',
    'db connection timed out after 5000ms',
    'cache miss for key user:42',
    'rate limit exceeded for tenant t_demo',
    'job q_compile_191 finished status=ok',
  ];
  const msg = messages[Math.floor(Math.random() * messages.length)];
  return {
    sim_type: 'log_stream_simulator',
    persona: null,
    input: `[${lvl}] ${msg}`,
    output: lvl === 'ERROR' ? 'classify:error' : 'classify:noise',
    ok: true,
  };
}

async function genSupportTicketEvent(workflow, persona, opts) {
  const subjects = ['Billing dispute', 'Cannot login', 'Feature request', 'Bug report', 'API timeout'];
  const s = subjects[Math.floor(Math.random() * subjects.length)];
  return {
    sim_type: 'support_ticket_simulator',
    persona: persona ? persona.name : null,
    input: JSON.stringify({ subject: s, body: 'simulated ticket body', priority: 'P2' }),
    output: JSON.stringify({ route: 'tier-1', tag: s.toLowerCase().split(' ')[0] }),
    ok: true,
  };
}

async function genIncidentEvent(workflow, persona, opts) {
  const kinds = ['db_down', 'api_5xx_spike', 'memory_leak', 'cache_thrash', 'queue_backlog'];
  const k = kinds[Math.floor(Math.random() * kinds.length)];
  return {
    sim_type: 'incident_simulator',
    persona: null,
    input: JSON.stringify({ alert: k, severity: 'SEV2', region: 'us-east-1' }),
    output: 'incident_acked',
    ok: true,
  };
}

async function genBrowserWorkflowEvent(workflow, persona, opts) {
  const steps = ['open_dashboard', 'click_settings', 'edit_field', 'save', 'logout'];
  return {
    sim_type: 'browser_workflow_simulator',
    persona: persona ? persona.name : null,
    input: JSON.stringify({ steps }),
    output: JSON.stringify({ all_passed: true, took_ms: 1500 + Math.floor(Math.random() * 3000) }),
    ok: true,
  };
}

async function genPayerPriorAuthEvent(workflow, persona, opts) {
  const cpts = ['99214', '99213', '93000', '85025', '70450'];
  const cpt = cpts[Math.floor(Math.random() * cpts.length)];
  return {
    sim_type: 'payer_prior_auth_simulator',
    persona: null,
    input: JSON.stringify({ cpt, dx: 'Z00.00', payer: 'BCBS', urgency: 'routine' }),
    output: JSON.stringify({ pa_required: cpt === '70450', decision: 'pending' }),
    ok: true,
  };
}

async function genPrivacyRedTeamEvent(workflow, persona, opts) {
  // Probes the membrane: each event seeds an input that contains synthetic PII.
  const samples = [
    `Patient John Doe SSN 123-45-6789 needs a refill.`,
    `Email me at jane@example.com about MRN1234567.`,
    `Call 555-867-5309 - that's Maria Garcia, DOB 01/15/1980.`,
    `Fax to 555-111-2222 the chart for Robert Brown.`,
    `IP 10.0.0.42 attempted login as charlie@health.org.`,
  ];
  const s = samples[Math.floor(Math.random() * samples.length)];
  return {
    sim_type: 'privacy_red_team_simulator',
    persona: persona ? persona.name : null,
    input: s,
    output: '__redact_expected__',
    ok: true,
  };
}

async function genDevicePerformanceEvent(workflow, persona, opts) {
  const devices = ['iphone_15', 'pixel_8', 'macbook_air', 'jetson_orin', 'raspberry_pi_5'];
  const d = devices[Math.floor(Math.random() * devices.length)];
  return {
    sim_type: 'device_performance_simulator',
    persona: null,
    input: JSON.stringify({ device: d, payload_kb: Math.floor(Math.random() * 100) }),
    output: JSON.stringify({ latency_ms: 50 + Math.floor(Math.random() * 200), throttled: Math.random() < 0.1 }),
    ok: true,
  };
}

const EVENT_GENS = {
  user_simulator: genUserEvent,
  api_tool_simulator: genApiToolEvent,
  log_stream_simulator: genLogStreamEvent,
  support_ticket_simulator: genSupportTicketEvent,
  incident_simulator: genIncidentEvent,
  browser_workflow_simulator: genBrowserWorkflowEvent,
  payer_prior_auth_simulator: genPayerPriorAuthEvent,
  privacy_red_team_simulator: genPrivacyRedTeamEvent,
  device_performance_simulator: genDevicePerformanceEvent,
};

// ---------------- public surface ----------------

export async function createSim(workflowId, { type = 'user_simulator', n = 100, personas = [], opts = {} } = {}) {
  if (!SIM_TYPES.includes(type)) {
    throw new Error('unsupported sim type: ' + type + '. supported: ' + SIM_TYPES.join(', '));
  }
  let personaSet = personas;
  if (!personaSet || personaSet.length === 0) {
    if (type === 'user_simulator' || type === 'support_ticket_simulator' || type === 'browser_workflow_simulator') {
      const r = await generatePersonas({ workflow: workflowId, n: Math.min(10, Math.max(3, Math.floor(n / 10))) });
      personaSet = r.personas;
    } else {
      personaSet = [];
    }
  }
  const sim = {
    sim_id: newSimId(),
    workflow_id: workflowId || null,
    type,
    n,
    personas: personaSet,
    opts: opts || {},
    status: 'created',
    created_at: nowIso(),
    last_run_at: null,
    events: [],
  };
  writeSim(sim);
  return { sim_id: sim.sim_id, type, workflow_id: sim.workflow_id, n, status: 'created', personas: personaSet.length };
}

export async function runSim(simId, { n = null, opts = {} } = {}) {
  const sim = readSim(simId);
  const wanted = Number.isFinite(n) ? Math.max(1, Number(n)) : sim.n;
  const gen = EVENT_GENS[sim.type] || EVENT_GENS.user_simulator;
  const events = [];
  for (let i = 0; i < wanted; i++) {
    const persona = sim.personas && sim.personas.length ? sim.personas[i % sim.personas.length] : null;
    let ev;
    try {
      ev = await gen(sim.workflow_id, persona, opts);
    } catch (e) {
      ev = { sim_type: sim.type, persona: persona ? persona.name : null, input: '', output: '', ok: false, error: String(e.message || e) };
    }
    ev.ts = nowIso();
    ev.sim_id = sim.sim_id;
    ev.event_idx = i;
    events.push(ev);
  }
  sim.events = (sim.events || []).concat(events);
  sim.status = 'ran';
  sim.last_run_at = nowIso();
  writeSim(sim);
  // Best-effort capture-lake insert. We never throw if the store is not
  // configured - sim works offline.
  let lakeInserted = 0;
  if (opts.toLake !== false) {
    try {
      const cs = await import('./capture-store.js');
      const tenant = opts.tenant || process.env.KOLM_DEFAULT_TENANT || 'default';
      for (const ev of events) {
        try {
          await cs.insertCapture({
            tenant,
            corpus_namespace: sim.workflow_id || 'sim_' + sim.type,
            prompt: ev.input,
            response: ev.output,
            model: 'sim/' + sim.type,
            latency_us: 1000,
            cost_usd: 0,
            created_at: ev.ts,
            sim_id: sim.sim_id,
            persona: ev.persona,
          });
          lakeInserted++;
        } catch { /* per-row insert failures are non-fatal */ }
      }
    } catch { /* capture store not loadable - skip */ }
  }
  return {
    sim_id: sim.sim_id,
    events_emitted: events.length,
    lake_inserted: lakeInserted,
    status: 'ran',
  };
}

// replayTrace - re-run a captured prompt (by trace_id) against an artifact
// or a model name. Returns a diff envelope. We import replay.js lazily so the
// circular dependency (replay imports simulation? - no, but keep the import
// pattern consistent across builder modules) never bites.
export async function replayTrace(traceId, { against, opts = {} } = {}) {
  const { replayTrace: rt } = await import('./replay.js');
  return rt(traceId, { against, opts });
}

export async function generateDatasetFromSim(simId, { name = null, holdoutFromSim = false } = {}) {
  const sim = readSim(simId);
  if (!sim.events || sim.events.length === 0) {
    throw new Error('sim_has_no_events: run kolm sim run ' + simId + ' first');
  }
  // Mirror dataset-workbench schema (Wave 372): produce a {dataset_id, source,
  // rows, holdout, created_at} envelope. We never silently merge synthetic into
  // a real holdout - synthetic rows go ONLY into the train split unless
  // holdoutFromSim is true (explicit opt-in for end-to-end sim-only flows).
  const datasetId = 'ds_sim_' + sha(simId + ':' + sim.events.length).slice(0, 12);
  const rows = sim.events.map((ev) => ({
    input: ev.input,
    output: ev.output,
    source_type: 'synthetic',
    teacher_model: 'sim/' + sim.type,
    mode: 'simulation',
    sim_id: simId,
    persona: ev.persona,
  }));
  const ds = {
    dataset_id: datasetId,
    name: name || ('sim:' + sim.type + ':' + simId.slice(-6)),
    source: 'simulation',
    sim_id: simId,
    rows,
    holdout: holdoutFromSim ? rows.slice(0, Math.max(1, Math.floor(rows.length * 0.2))) : [],
    holdout_synthetic_warning: holdoutFromSim,
    created_at: nowIso(),
  };
  // Persist alongside the sim so kolm sim generate-dataset is idempotent.
  fs.writeFileSync(path.join(ensureSimDir(), datasetId + '.json'), JSON.stringify(ds, null, 2));
  return ds;
}

export async function evalArtifactInSim(simId, artifactPath, { limit = null, opts = {} } = {}) {
  const sim = readSim(simId);
  if (!sim.events || sim.events.length === 0) {
    throw new Error('sim_has_no_events: run kolm sim run ' + simId + ' first');
  }
  // Lazy import so any failure to load runArtifact (missing native deps,
  // signature failure on a stub artifact) doesn't blow up the simulation
  // module at top-level.
  const { runArtifact } = await import('./artifact-runner.js');
  const cases = sim.events.slice(0, limit || sim.events.length);
  const results = [];
  let pass = 0;
  let fail = 0;
  let latencyTotalUs = 0;
  let costTotalMicroUsd = 0;
  for (const ev of cases) {
    const t0 = Date.now();
    let out;
    let ok = false;
    let error = null;
    try {
      const r = await runArtifact(artifactPath, ev.input, { timeoutMs: 2000 });
      out = r.output;
      latencyTotalUs += r.latency_us || ((Date.now() - t0) * 1000);
      ok = true;
      pass++;
    } catch (e) {
      out = null;
      error = String(e.message || e);
      fail++;
    }
    results.push({
      sim_event_idx: ev.event_idx,
      input_head: String(ev.input).slice(0, 200),
      output_head: out ? String(typeof out === 'string' ? out : JSON.stringify(out)).slice(0, 200) : null,
      ok,
      error,
    });
  }
  return {
    sim_id: simId,
    artifact: artifactPath,
    cases: cases.length,
    pass,
    fail,
    pass_rate: cases.length ? pass / cases.length : 0,
    avg_latency_ms: cases.length ? Math.round(latencyTotalUs / cases.length / 1000) : 0,
    avg_cost_usd: cases.length ? costTotalMicroUsd / cases.length / 1e6 : 0,
    results,
  };
}

export function listSims() {
  const d = SIM_DIR();
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.json') || !f.startsWith('sim_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      out.push({
        sim_id: j.sim_id,
        workflow_id: j.workflow_id,
        type: j.type,
        n: j.n,
        status: j.status,
        events: (j.events || []).length,
        created_at: j.created_at,
        last_run_at: j.last_run_at,
      });
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function _readSimRaw(simId) { return readSim(simId); }

export default {
  SIM_TYPES,
  createSim,
  runSim,
  replayTrace,
  generateDatasetFromSim,
  evalArtifactInSim,
  listSims,
};
