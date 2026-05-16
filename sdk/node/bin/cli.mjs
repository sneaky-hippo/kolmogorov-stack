#!/usr/bin/env node
// `recipe` CLI — autonomous-friendly. Robots/agents can run any command without
// signing up; the CLI auto-bootstraps an anonymous workspace on first use and
// stores the token at ~/.recipe/auth.json. `recipe claim --email ...` upgrades
// to a permanent account when ready.
//
// Auth precedence (first match wins):
//   1. KOLM_API_KEY env (preferred; also RECIPE_API_KEY, KOLMOGOROV_API_KEY)
//   2. ~/.recipe/auth.json (managed by `recipe init` / `recipe claim`)
//   3. auto-bootstrap an anonymous workspace + persist to ~/.recipe/auth.json

import RecipeClient from '../index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SDK_VERSION = '0.2.0';
const args = process.argv.slice(2);
const cmd = args[0];

const AUTH_DIR = path.join(os.homedir(), '.recipe');
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');

// ---------- auth helpers ----------
function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); }
  catch { return null; }
}
function saveAuth(rec) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(rec, null, 2), { mode: 0o600 });
}
function clearAuth() {
  try { fs.unlinkSync(AUTH_FILE); } catch {}
}
function envKey() {
  return (
    process.env.KOLM_API_KEY ||
    process.env.RECIPE_API_KEY ||
    process.env.KOLMOGOROV_API_KEY ||
    null
  );
}
function envBase() {
  return process.env.KOLM_BASE_URL || process.env.RECIPE_BASE_URL || null;
}

async function ensureKey({ allowBootstrap = true } = {}) {
  if (envKey()) return { key: envKey(), source: 'env' };
  const rec = loadAuth();
  if (rec && rec.api_key) {
    if (rec.kind === 'anon' && rec.expires_at && new Date(rec.expires_at) < new Date()) {
      console.error('your anonymous workspace expired. run `recipe claim --email you@co.com` or delete ~/.recipe/auth.json to start fresh.');
      process.exit(1);
    }
    return { key: rec.api_key, source: 'file', record: rec };
  }
  if (!allowBootstrap) return { key: null };
  // Auto-bootstrap an anonymous tenant — silent, single line of feedback.
  const c = new RecipeClient();
  try {
    const r = await c.bootstrapAnonymous({ hostname: os.hostname(), user_agent: `recipe-cli/${SDK_VERSION}` });
    const rec = {
      api_key: r.anon_token,
      kind: 'anon',
      tenant_id: r.tenant_id,
      expires_at: r.expires_at,
      created_at: new Date().toISOString(),
      base_url: c.baseUrl,
    };
    saveAuth(rec);
    if (cmd !== 'init' && cmd !== '--quiet-bootstrap') {
      console.error(`✓ bootstrapped anonymous workspace (expires ${r.expires_at.slice(0, 10)})`);
      console.error(`  to keep your work permanently: \`recipe claim --email you@co.com\``);
    }
    return { key: r.anon_token, source: 'bootstrap', record: rec };
  } catch (e) {
    console.error('failed to bootstrap anonymous workspace:', e?.message || e);
    process.exit(1);
  }
}

function makeClient(key) {
  const rec = loadAuth();
  return new RecipeClient({ apiKey: key, baseUrl: envBase() || rec?.base_url });
}

// ---------- usage / flags ----------
function usage(code = 0) {
  console.log(`recipe — Recipe CLI (v${SDK_VERSION})

  zero-friction: any command auto-bootstraps an anonymous workspace.
  no signup required to start. claim later with \`recipe claim --email ...\`.

usage:
  recipe init                                 (force bootstrap; print where the key lives)
  recipe whoami                               (show current key + tenant + expiry)
  recipe claim --email you@co.com [--name X]  (upgrade anon workspace → real account)
  recipe logout                               (remove ~/.recipe/auth.json)

  recipe synthesize <examples.json>           (mint a recipe from local examples)
  recipe run <recipe-name|recipe-id> "<input>"
  recipe list [--tag x] [--q text]
  recipe get <recipe-id>
  recipe stats <recipe-id>
  recipe search "<query>" [--k 5]
  recipe featured
  recipe compose "<query>" "<input>" [--k 3] [--strategy attention]
  recipe label <recipe-id> <rows.json|hf:dataset> [--max 1000]

  recipe observe                              (paste prompts from stdin → autopilot clusters)
  recipe suggest                              (show autopilot's replacement candidates)

  recipe waitlist <email> "<task>"
  recipe specialists [list|<id>]
  recipe account
  recipe health

env:
  KOLM_API_KEY       bearer token (preferred; also RECIPE_API_KEY, KOLMOGOROV_API_KEY)
  KOLM_BASE_URL      override the API base (also RECIPE_BASE_URL); default: https://kolm.ai
`);
  process.exit(code);
}

if (!cmd || cmd === '-h' || cmd === '--help') usage(0);

function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function done(out) {
  if (typeof out === 'string') console.log(out);
  else console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

function fail(e) {
  console.error('error:', e?.message || e);
  if (e?.body) console.error(JSON.stringify(e.body, null, 2));
  process.exit(1);
}

async function main() {
  switch (cmd) {
    // ---------- auth surface ----------
    case 'init': {
      // Force a bootstrap (or no-op if a key already exists)
      const existing = envKey() || loadAuth()?.api_key;
      if (existing) {
        const rec = loadAuth();
        console.log(`already authenticated (${envKey() ? 'env' : (rec?.kind || 'user')}). key starts with: ${existing.slice(0, 7)}…`);
        if (rec?.kind === 'anon') console.log(`expires: ${rec.expires_at}. run \`recipe claim --email you@co.com\` to upgrade.`);
        return process.exit(0);
      }
      const r = await ensureKey({ allowBootstrap: true });
      console.log(`✓ anonymous workspace ready.`);
      console.log(`  token stored at: ${AUTH_FILE}`);
      console.log(`  starts with: ${r.key.slice(0, 7)}…`);
      console.log(`  expires: ${r.record.expires_at}`);
      console.log(``);
      console.log(`next: \`recipe synthesize examples.json\` to mint your first recipe.`);
      return process.exit(0);
    }

    case 'whoami': {
      const env = envKey();
      const rec = loadAuth();
      if (env) {
        const envVar = process.env.KOLM_API_KEY
          ? 'KOLM_API_KEY'
          : process.env.RECIPE_API_KEY
          ? 'RECIPE_API_KEY'
          : 'KOLMOGOROV_API_KEY';
        console.log(`source: env (${envVar})`);
        console.log(`key:    ${env.slice(0, 7)}…`);
        try {
          const c = makeClient(env);
          const a = await c.account();
          console.log(`tenant: ${a.id || a.tenant || '?'}`);
          console.log(`plan:   ${a.plan || (a.admin ? 'admin' : '?')}`);
          console.log(`used:   ${a.used ?? '?'} / ${a.quota ?? '?'}`);
        } catch (e) { console.log(`(could not fetch account: ${e.message})`); }
        return process.exit(0);
      }
      if (!rec) {
        console.log('not authenticated. run `recipe init` to bootstrap an anonymous workspace.');
        return process.exit(0);
      }
      console.log(`source:    file (${AUTH_FILE})`);
      console.log(`kind:      ${rec.kind}`);
      console.log(`key:       ${rec.api_key.slice(0, 7)}…`);
      if (rec.kind === 'anon') {
        const ms = new Date(rec.expires_at).getTime() - Date.now();
        const days = Math.max(0, Math.floor(ms / 86400000));
        console.log(`expires:   ${rec.expires_at} (${days} days left)`);
        console.log(``);
        console.log(`to keep your work: \`recipe claim --email you@co.com\``);
      }
      return process.exit(0);
    }

    case 'claim': {
      const email = flag('email');
      const name = flag('name');
      if (!email) { console.error('usage: recipe claim --email you@co.com [--name yourname]'); process.exit(1); }
      const rec = loadAuth();
      if (!rec || rec.kind !== 'anon') {
        console.error('no anonymous workspace to claim. run `recipe init` first, or this CLI is already on a real account.');
        process.exit(1);
      }
      try {
        const c = new RecipeClient({ apiKey: rec.api_key, baseUrl: rec.base_url });
        const r = await c.claimAnonymous(rec.api_key, email, name);
        const updated = {
          api_key: r.api_key,
          kind: 'user',
          tenant_id: r.tenant.id,
          email,
          name: r.tenant.name,
          plan: r.tenant.plan,
          quota: r.tenant.quota,
          claimed_at: new Date().toISOString(),
          base_url: rec.base_url,
        };
        saveAuth(updated);
        console.log(`✓ ${r.mode}.`);
        console.log(`  account:  ${r.tenant.name} (${r.tenant.plan})`);
        console.log(`  new key:  ${r.api_key.slice(0, 7)}…  (saved to ${AUTH_FILE})`);
        console.log(`  quota:    ${r.tenant.quota} calls/mo`);
        return process.exit(0);
      } catch (e) { fail(e); }
      break;
    }

    case 'logout': {
      clearAuth();
      console.log('removed ' + AUTH_FILE + '.');
      console.log('any recipes you minted under that workspace are still on the server until they expire.');
      return process.exit(0);
    }

    // ---------- core surface ----------
    case 'run': {
      const ref = args[1];
      const input = args.slice(2).filter(a => !a.startsWith('--')).join(' ');
      if (!ref || !input) usage(1);
      const { key } = await ensureKey();
      const c = makeClient(key);
      try {
        if (/^cpt_/.test(ref) || /^ver_/.test(ref)) {
          const r = ref.startsWith('ver_')
            ? await c.run({ version_id: ref, input })
            : await c.run({ recipe_id: ref, input });
          return done(r);
        }
        const { featured } = await c.featured();
        const found = featured.find(r => r.name === ref);
        if (!found) throw new Error(`recipe "${ref}" not in public registry`);
        return done(await c.run({ recipe_id: found.id, input }));
      } catch (e) { fail(e); }
      break;
    }

    case 'synthesize': {
      const file = args[1];
      if (!file) {
        console.error('usage: recipe synthesize <examples.json>');
        console.error('');
        console.error('examples.json format:');
        console.error('{');
        console.error('  "name": "is-spam",');
        console.error('  "positives": [{"input":"WIN free Bitcoin","expected":true}, ...],');
        console.error('  "negatives": [{"input":"see you tomorrow","expected":false}, ...],');
        console.error('  "output_spec": {"type":"boolean"}');
        console.error('}');
        process.exit(1);
      }
      const { key } = await ensureKey();
      const c = makeClient(key);
      try {
        const body = JSON.parse(fs.readFileSync(file, 'utf8'));
        return done(await c.synthesize(body));
      } catch (e) { fail(e); }
      break;
    }

    case 'list': {
      const { key } = await ensureKey();
      const c = makeClient(key);
      try { return done(await c.list({ tag: flag('tag'), q: flag('q'), limit: flag('limit') ? +flag('limit') : undefined })); }
      catch (e) { fail(e); }
      break;
    }

    case 'get': {
      if (!args[1]) usage(1);
      const { key } = await ensureKey();
      const c = makeClient(key);
      try { return done(await c.get(args[1])); } catch (e) { fail(e); }
      break;
    }

    case 'stats': {
      if (!args[1]) usage(1);
      const { key } = await ensureKey();
      const c = makeClient(key);
      try { return done(await c.stats(args[1])); } catch (e) { fail(e); }
      break;
    }

    case 'search': {
      if (!args[1]) usage(1);
      const { key } = await ensureKey();
      const c = makeClient(key);
      try { return done(await c.search(args[1], flag('k') ? +flag('k') : 5)); } catch (e) { fail(e); }
      break;
    }

    case 'featured': {
      const c = new RecipeClient(); // featured is public
      try { return done(await c.featured()); } catch (e) { fail(e); }
      break;
    }

    case 'compose': {
      if (!args[1] || !args[2]) usage(1);
      const { key } = await ensureKey();
      const c = makeClient(key);
      try {
        return done(await c.compose({
          query: args[1], input: args[2],
          k: flag('k') ? +flag('k') : 3,
          strategy: flag('strategy') || 'attention',
        }));
      } catch (e) { fail(e); }
      break;
    }

    case 'label': {
      const id = args[1]; const src = args[2];
      if (!id || !src) usage(1);
      const { key } = await ensureKey();
      const c = makeClient(key);
      try {
        if (src.startsWith('hf:')) {
          return done(await c.labelCorpus(id, { hf_dataset: src.slice(3), max_rows: flag('max') ? +flag('max') : 1000 }));
        }
        const rows = JSON.parse(fs.readFileSync(src, 'utf8'));
        return done(await c.labelCorpus(id, { rows, max_rows: rows.length }));
      } catch (e) { fail(e); }
      break;
    }

    // ---------- autopilot surface ----------
    case 'observe': {
      const { key } = await ensureKey();
      const c = makeClient(key);
      console.error('paste one prompt per line. ctrl-D when done.');
      const lines = [];
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) lines.push(...String(chunk).split('\n').filter(Boolean));
      try {
        for (const prompt of lines) {
          await c._req('POST', '/v1/bridges/observe', { prompt, model: 'cli', latency_ms: 0 });
        }
        console.error(`observed ${lines.length} prompts.`);
        return done(await c._req('GET', '/v1/bridges/suggestions'));
      } catch (e) { fail(e); }
      break;
    }

    case 'suggest': {
      const { key } = await ensureKey();
      const c = makeClient(key);
      try { return done(await c._req('GET', '/v1/bridges/suggestions')); }
      catch (e) { fail(e); }
      break;
    }

    case 'waitlist': {
      const email = args[1]; const task = args.slice(2).join(' ');
      if (!email || !task) usage(1);
      const c = new RecipeClient();
      try { return done(await c.waitlistSpecialist(email, task)); } catch (e) { fail(e); }
      break;
    }

    case 'specialists': {
      const { key } = await ensureKey();
      const c = makeClient(key);
      try {
        if (!args[1] || args[1] === 'list') return done(await c.listSpecialists());
        return done(await c.getSpecialist(args[1]));
      } catch (e) { fail(e); }
      break;
    }

    case 'account': {
      const { key } = await ensureKey();
      const c = makeClient(key);
      try { return done(await c.account()); } catch (e) { fail(e); }
      break;
    }

    case 'health': {
      const c = new RecipeClient();
      try { return done(await c.health()); } catch (e) { fail(e); }
      break;
    }

    default: usage(1);
  }
}

main();
