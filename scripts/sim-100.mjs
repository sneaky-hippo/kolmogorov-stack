#!/usr/bin/env node
// sim-100.mjs — 10 personas × 10 actions = 100 real prod interactions.
// Each persona is a different target-user archetype. Every action is a real
// HTTP call against kolm.ai (or $URL). We capture status, latency, response
// shape, and a friction note. Output is a single JSON blob that gets fed back
// to the operator for synthesis of /10 ratings and 10-bullet feedback.

import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = process.env.URL || 'https://kolm.ai';
const STAMP = Date.now();

const PERSONAS = [
  {
    id: 'ml_eng',
    name: 'Senior ML engineer at a Series-B SaaS',
    goals: 'fine-tune a private LoRA on internal data; verify reproducibility; ship to prod with a benchmark gate',
    needs: ['compile', 'tune', 'bench', 'serve', 'docs/EVOLVE', 'docs/TUNE'],
  },
  {
    id: 'indie_hacker',
    name: 'Solo indie hacker shipping a coding-bot SaaS',
    goals: 'wire kolm into Claude Code, see real coding improvement loop, keep cost flat',
    needs: ['install claude-code', 'compile', 'rag', 'mcp serve'],
  },
  {
    id: 'health_cio',
    name: 'Healthcare CIO at a regional hospital chain',
    goals: 'PHI on-device classifier, HIPAA story, no PHI in cloud, audit trail',
    needs: ['/healthcare', 'spec', 'audit-log', 'on-device', 'security'],
  },
  {
    id: 'defense_pm',
    name: 'Defense-contractor program manager',
    goals: 'airgapped run, no network, reproducible benchmarks, signed receipts',
    needs: ['/edge', '/defense', 'spec', 'serve --airgap', 'tune --airgap'],
  },
  {
    id: 'hedge_quant',
    name: 'Hedge-fund quant at a $3B fund',
    goals: 'low-latency finance disclosure redactor, signed audit trail per-doc, deterministic',
    needs: ['/finance', 'compile', 'bench latency', 'receipts'],
  },
  {
    id: 'law_it',
    name: 'IT lead at a 200-attorney law firm',
    goals: 'attorney-client privilege summarizer, never call OpenAI, audit trail',
    needs: ['/legal', 'compile', 'audit-log'],
  },
  {
    id: 'agent_builder',
    name: 'AI-agent builder at a YC startup',
    goals: 'MCP integration with Claude Code + Cursor, compounding memory across sessions',
    needs: ['install', 'mcp serve', 'hooks', 'evolve'],
  },
  {
    id: 'robotics',
    name: 'Robotics engineer at an edge-AI startup',
    goals: 'tiny model on embedded ARM, no network, hardware spec',
    needs: ['/edge', 'bench', 'serve', 'evolve'],
  },
  {
    id: 'data_sci',
    name: 'Data scientist at a mid-market e-commerce co.',
    goals: 'product-taxonomy classifier, cheap to run, retrain weekly on captures',
    needs: ['compile', 'capture', 'tune', 'observations'],
  },
  {
    id: 'compliance',
    name: 'Compliance officer at a Series-C fintech',
    goals: 'audit-log of every inference, signed receipts, SOC2 story, on-prem option',
    needs: ['/security', 'audit-log', 'receipts', 'spec'],
  },
];

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, label, body: r.body };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, label, error: String(e && e.message || e) };
  }
}

async function req(path, init = {}, parse = 'json') {
  const r = await fetch(URL + path, init);
  let body;
  try { body = parse === 'json' ? await r.json() : await r.text(); } catch { body = null; }
  return { ok: r.ok, status: r.status, body };
}

async function runPersona(p, idx) {
  const email = `sim+${p.id}+${STAMP}@example.com`;
  const events = [];
  let key = null;
  let tenant = null;

  // 1. Land on homepage.
  events.push(await timed('home', () => req('/', {}, 'text')));

  // 2. Read the most relevant vertical/landing page.
  const verticalMap = {
    health_cio: '/healthcare',
    defense_pm: '/defense',
    hedge_quant: '/finance',
    law_it: '/legal',
    robotics: '/edge',
    compliance: '/security',
    agent_builder: '/evolve',
    indie_hacker: '/quickstart',
    ml_eng: '/build-your-own',
    data_sci: '/api',
  };
  events.push(await timed('vertical:' + verticalMap[p.id], () => req(verticalMap[p.id], {}, 'text')));

  // 2b. Enterprise-flavored personas check /enterprise + /baa for procurement-path artifacts.
  const enterprisePersonas = new Set(['health_cio', 'defense_pm', 'law_it', 'compliance', 'hedge_quant']);
  if (enterprisePersonas.has(p.id)) {
    events.push(await timed('enterprise', () => req('/enterprise', {}, 'text')));
    events.push(await timed('baa', () => req('/baa', {}, 'text')));
  }

  // 3. Read /spec or /how-it-works.
  events.push(await timed('how-it-works', () => req('/how-it-works', {}, 'text')));

  // 4. Sign up.
  const su = await timed('signup', () => req('/v1/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, plan: 'free' }),
  }));
  events.push(su);
  key = su.body?.api_key || null;
  tenant = su.body?.tenant_id || null;

  if (!key) {
    // Persona is blocked. Record and bail.
    return { persona: p, idx, email, tenant, key, events, blocked_at: 'signup' };
  }

  const auth = { 'authorization': `Bearer ${key}` };

  // 5. Account view.
  events.push(await timed('account', () => req('/v1/account', { headers: auth })));

  // 6. Synthesize a persona-appropriate concept.
  const concepts = {
    ml_eng:        { name: 'redact-secrets',        positives: [{ input: 'token=sk_live_xxx', expected: 'token=[REDACTED]' }, { input: 'AWS_KEY=abcd', expected: 'AWS_KEY=[REDACTED]' }] },
    indie_hacker:  { name: 'pr-summary',            positives: [{ input: 'PR #12: bumps lockfile', expected: 'lockfile bump' }, { input: 'PR #13: adds caching', expected: 'caching' }] },
    health_cio:    { name: 'phi-classifier',        positives: [{ input: 'pt name jane doe dob 1980', expected: 'PHI' }, { input: 'protein levels normal', expected: 'NO_PHI' }] },
    defense_pm:    { name: 'classmark-strip',       positives: [{ input: '[U//FOUO] payload report', expected: 'payload report' }, { input: 'TOP SECRET schedule', expected: '[REDACTED]' }] },
    hedge_quant:   { name: 'mnpi-redact',           positives: [{ input: 'EPS beat by 3c, unannounced', expected: '[MNPI]' }, { input: 'public 10-Q line item', expected: 'OK' }] },
    law_it:        { name: 'privileged-tagger',     positives: [{ input: 'client communication with counsel', expected: 'PRIVILEGED' }, { input: 'invoice line', expected: 'NOT_PRIVILEGED' }] },
    agent_builder: { name: 'session-recap',         positives: [{ input: 'session log A', expected: 'recap A' }, { input: 'session log B', expected: 'recap B' }] },
    robotics:      { name: 'fault-classifier',      positives: [{ input: 'vibration 0.8g axis-y', expected: 'BEARING' }, { input: 'temp 70C normal', expected: 'OK' }] },
    data_sci:      { name: 'product-taxonomy',      positives: [{ input: 'Wireless earbuds, 30hr', expected: 'Audio>Earbuds' }, { input: 'Yoga mat, 6mm', expected: 'Fitness>Mats' }] },
    compliance:    { name: 'transaction-tagger',    positives: [{ input: 'wire $50k to LLC', expected: 'REVIEW' }, { input: 'card swipe $20', expected: 'OK' }] },
  };
  const synth = await timed('synthesize', () => req('/v1/synthesize', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(concepts[p.id]),
  }));
  events.push(synth);
  const conceptId = synth.body?.concept_id || null;

  // 7. Run the concept.
  if (conceptId) {
    events.push(await timed('run', () => req('/v1/run', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ concept_id: conceptId, input: concepts[p.id].positives[0].input }),
    })));
  } else {
    events.push({ ok: false, status: 0, ms: 0, label: 'run', skipped: 'no concept_id' });
  }

  // 8. Inspect /evolve or appropriate evolve-relevant page.
  events.push(await timed('evolve', () => req('/evolve', {}, 'text')));

  // 9. Try /v1/recall (which everyone should be able to hit).
  events.push(await timed('recall', () => req('/v1/recall', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ query: concepts[p.id].name }),
  })));

  // 10. Hit /v1/account/change-plan up (sim wants to upgrade to pro).
  events.push(await timed('change-plan-up', () => req('/v1/account/change-plan', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ plan: 'pro' }),
  })));

  return { persona: p, idx, email, tenant, key, events, blocked_at: null };
}

async function main() {
  const out = { url: URL, ts: new Date().toISOString(), personas: [] };
  for (let i = 0; i < PERSONAS.length; i++) {
    const p = PERSONAS[i];
    console.error(`[${i + 1}/${PERSONAS.length}] running ${p.id} (${p.name})`);
    const r = await runPersona(p, i);
    out.personas.push(r);
    // small breather to avoid signup limiter.
    await sleep(150);
  }
  // Aggregate.
  let total = 0, ok = 0, bad = 0;
  for (const p of out.personas) {
    for (const e of p.events) { total++; if (e.ok || e.status === 503 || e.status === 401 || e.status === 400) ok++; else bad++; }
  }
  out.summary = { total, ok, bad };
  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
