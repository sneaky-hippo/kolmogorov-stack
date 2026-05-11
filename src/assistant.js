// Natural-language entry point. Takes a free-text prompt from an authed user
// and parses it into one of a small set of intents. Deterministic, rule-based:
// no LLM round-trip required, no telemetry leaves the box. Lives inside auth
// so all reads/writes are scoped to req.tenant_record.
//
// Intents:
//   status      - account snapshot (plan, quota, used)
//   usage       - same as status but framed "how much have i used"
//   list        - list compiled concepts / artifacts for this tenant
//   compile     - kick off a compile from a free-text task description
//   run         - run a previously-compiled concept by id or name
//   tune        - explain how to start a local tune loop (airgap CLI verb)
//   evolve      - alias for tune
//   install     - explain `kolm install <harness>` for claude-code/cursor/etc.
//   upgrade     - start a plan-change to pro/teams/business/enterprise
//   help        - menu of what i can do
//   doctor      - return a health/config snapshot for this account
//
// Output is always:
//   { ok, intent, narration, data?, next_steps? }
// narration is short, plain text suitable for a chat bubble. data is the raw
// structured payload (artifact list, account record, billing url) so the UI
// can render cards alongside the bubble.

import { all, findOne } from './store.js';

const PRO_PLANS = new Set(['starter', 'pro', 'teams', 'business', 'enterprise']);

function lc(s) { return String(s || '').toLowerCase(); }
function trim(s) { return String(s || '').trim(); }

function detectIntent(prompt) {
  const p = lc(prompt);
  if (!p) return 'help';
  // Order matters: more specific first.
  if (/^(help|hi|hello|hey|what can you do|what do you do)\b/.test(p)) return 'help';
  if (/\b(doctor|debug|why( is| 's|s) it broken|whats wrong|health check)\b/.test(p)) return 'doctor';
  if (/\b(usage|how much (have i|did i)|left in (my )?quota|consumed|burning)\b/.test(p)) return 'usage';
  if (/\b(status|account|where am i|am i on|what plan)\b/.test(p)) return 'status';
  if (/\b(list|show|all my|what (have i|did i) (build|compile|ship))\b/.test(p)) return 'list';
  if (/\b(upgrade|go pro|move to pro|switch to|change plan)\b/.test(p)) return 'upgrade';
  if (/\b(install|wire up|hook up|claude code|cursor|continue|cline)\b/.test(p)) return 'install';
  if (/\b(tune|train|evolve|fine ?tune|fine ?tuning)\b/.test(p)) return 'tune';
  if (/\b(run|execute|invoke|call)\b/.test(p)) return 'run';
  if (/\b(compile|build|make|create|new)\b/.test(p)) return 'compile';
  return 'help';
}

function extractTask(prompt) {
  // Strip leading verb fragments to get the actual task. "compile a recipe
  // that redacts secrets" -> "redacts secrets".
  return trim(prompt)
    .replace(/^(please\s+)?(compile|build|make|create|new)\s+(me\s+)?(a\s+|an\s+)?(recipe\s+|concept\s+|artifact\s+|kolm\s+)?(that\s+|to\s+|for\s+|which\s+)?/i, '')
    .replace(/^[a-z\- ]{1,20}\s+to\s+/i, '');
}

function extractTargetPlan(prompt) {
  const p = lc(prompt);
  for (const plan of ['enterprise', 'business', 'teams', 'pro', 'starter']) {
    if (p.includes(plan)) return plan;
  }
  return 'pro';
}

function extractHarness(prompt) {
  const p = lc(prompt);
  for (const h of ['claude-code', 'claude code', 'cursor', 'continue', 'cline']) {
    if (p.includes(h)) return h.replace(' ', '-');
  }
  return null;
}

function extractConcept(prompt) {
  // pick the last token that looks like an id or name
  const tokens = trim(prompt).split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (!last) return null;
  if (/^cpt_/.test(last)) return last;
  if (last.length >= 3 && last.length <= 64) return last;
  return null;
}

function listConcepts(tenantId) {
  const c = all('concepts');
  return c
    .filter(x => !x._deleted && x.tenant_id === tenantId)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, 30)
    .map(x => ({
      id: x.id,
      name: x.name,
      created_at: x.created_at,
      k_score: x.k_score ?? null,
      pass_rate: x.pass_rate_positive ?? null,
      latency_p50_us: x.latency_p50_us ?? null,
    }));
}

export async function handleAssistant(req, _res, deps) {
  const tenant = req.tenant_record;
  const prompt = String((req.body || {}).prompt || '').slice(0, 2000);
  const intent = detectIntent(prompt);

  switch (intent) {
    case 'help':
      return {
        ok: true,
        intent,
        narration: 'I can manage your local builds without leaving this page. Try one of: "what is my status", "show my builds", "compile a recipe that redacts secrets", "run cpt_xxx hello", "tune", "install claude-code", "upgrade to pro".',
        next_steps: [
          { label: 'status',  prompt: 'show my status' },
          { label: 'list',    prompt: 'show my builds' },
          { label: 'compile', prompt: 'compile a recipe that redacts secrets' },
          { label: 'install', prompt: 'install claude-code' },
          { label: 'tune',    prompt: 'start tune loop' },
          { label: 'upgrade', prompt: 'upgrade to pro' },
        ],
      };

    case 'status':
    case 'usage':
      return {
        ok: true,
        intent,
        narration: `You're on the ${tenant.plan || 'free'} plan. ${tenant.used || 0} of ${tenant.quota || 0} units used this period. ${Math.max(0, (tenant.quota || 0) - (tenant.used || 0))} remaining.`,
        data: {
          plan: tenant.plan,
          quota: tenant.quota,
          used: tenant.used,
          remaining: Math.max(0, (tenant.quota || 0) - (tenant.used || 0)),
          tenant_id: tenant.id,
          email: tenant.email,
        },
      };

    case 'list': {
      const items = listConcepts(tenant.id);
      const narration = items.length === 0
        ? 'No builds yet. Try "compile a recipe that does <task>" to create your first one.'
        : `${items.length} build${items.length === 1 ? '' : 's'}. Most recent first.`;
      return { ok: true, intent, narration, data: { items } };
    }

    case 'compile': {
      const task = extractTask(prompt);
      if (!task || task.length < 4) {
        return {
          ok: false,
          intent,
          narration: 'Tell me what the recipe should do. Example: "compile a recipe that classifies support tickets by urgency".',
        };
      }
      // Compile is multi-step (positives/negatives, K-score gate) so the
      // assistant guides — it does not silently kick off a job. Returns the
      // exact curl + a /compile link with the task pre-filled.
      const out = await deps.synthesize({ task });
      return {
        ok: true,
        intent,
        narration: `Got it. Open the guided builder at /compile (pre-filled), or paste the curl below to compile from your terminal.`,
        data: out,
        next_steps: [
          { label: 'open /compile', href: out.compile_link },
          { label: 'show curl', prompt: 'help' },
        ],
      };
    }

    case 'run': {
      const cid = extractConcept(prompt);
      if (!cid) {
        return { ok: false, intent, narration: 'Tell me which concept to run. Example: "run cpt_xxx hello world".' };
      }
      const concept = findOne('concepts', x => x.id === cid && x.tenant_id === tenant.id);
      if (!concept) {
        return { ok: false, intent, narration: `Concept ${cid} not found in your account. Try "show my builds".` };
      }
      // Use the prompt tail (everything after the concept id) as input.
      const idx = prompt.toLowerCase().indexOf(cid.toLowerCase());
      const input = idx >= 0 ? trim(prompt.slice(idx + cid.length)) : 'hello';
      const r = await deps.run({ tenant, concept_id: cid, input: input || 'hello' });
      return {
        ok: !!r?.output,
        intent,
        narration: r?.output
          ? `Output: ${String(r.output).slice(0, 280)}${r.cache === 'hit' ? ' (cache hit)' : ''}`
          : 'Run failed. Open /run for the guided runner.',
        data: r,
      };
    }

    case 'tune':
    case 'evolve':
      return {
        ok: true,
        intent: 'tune',
        narration: 'Tune is a local CLI loop — the trainer never leaves your laptop. Run: kolm tune init && kolm tune capture-on && kolm tune step --airgap. The dashboard shows promoted revisions when you push them back. See /evolve for the full pipeline.',
        next_steps: [
          { label: 'open /evolve', href: '/evolve' },
          { label: 'docs/TUNE.md', href: '/docs' },
        ],
      };

    case 'install': {
      const h = extractHarness(prompt);
      if (!h) {
        return {
          ok: true,
          intent,
          narration: 'Which harness? Supported: claude-code, cursor, continue, cline. Run: kolm install <harness> --apply',
          next_steps: [
            { label: 'claude-code', prompt: 'install claude-code' },
            { label: 'cursor',      prompt: 'install cursor' },
            { label: 'continue',    prompt: 'install continue' },
            { label: 'cline',       prompt: 'install cline' },
          ],
        };
      }
      return {
        ok: true,
        intent,
        narration: `Run: kolm install ${h} --apply. That writes the hooks + MCP config so ${h} discovers your .kolm artifacts automatically. See /docs for what gets written.`,
        data: { harness: h, command: `kolm install ${h} --apply` },
      };
    }

    case 'upgrade': {
      const target = extractTargetPlan(prompt);
      const billing = await deps.changePlan({ tenant, target });
      return {
        ok: true,
        intent,
        narration: billing?.billing_url
          ? `Open the secure billing link to switch to ${target}. Plan flips when payment clears.`
          : billing?.error === 'billing_not_configured'
            ? `${target} billing is not yet wired in. Mail founders@kolm.ai and we'll set you up directly.`
            : `Plan changed to ${billing?.plan || target}.`,
        data: billing,
      };
    }

    case 'doctor': {
      const items = listConcepts(tenant.id);
      const lines = [];
      lines.push(`plan: ${tenant.plan || 'free'}`);
      lines.push(`builds: ${items.length}`);
      lines.push(`used / quota: ${tenant.used || 0} / ${tenant.quota || 0}`);
      lines.push(`receipts: signed via rs-1`);
      lines.push(`local CLI: see /docs (kolm doctor)`);
      return {
        ok: true,
        intent,
        narration: lines.join('\n'),
        data: { plan: tenant.plan, builds: items.length, used: tenant.used, quota: tenant.quota },
      };
    }

    default:
      return { ok: true, intent: 'help', narration: 'I am not sure what you meant. Try "help".' };
  }
}
