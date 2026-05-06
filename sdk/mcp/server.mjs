#!/usr/bin/env node
// Recipe — Claude Code / MCP server.
// Exposes synthesis, run, search, label-corpus, and specialist tooling as MCP tools
// so agents can replace repeat LLM-as-judge calls with deterministic JS.
//
// Install: npm i -g @kolmogorov/recipe-mcp
// Add to .mcp.json:
//   { "mcpServers": { "recipe": { "command": "recipe-mcp" } } }
//
// Env:
//   RECIPE_API_KEY    bearer token (or KOLMOGOROV_API_KEY)
//   RECIPE_BASE_URL   override API base
//
// Implementation note: this server speaks the MCP stdio protocol directly
// (line-delimited JSON-RPC) so it has zero runtime dependencies beyond the
// Recipe SDK. If @modelcontextprotocol/sdk is installed, it will use that;
// otherwise it falls back to a hand-written JSON-RPC loop.

import { createInterface } from 'node:readline';
import RecipeClient from '@kolmogorov/recipe';

const client = new RecipeClient();
const SERVER_INFO = { name: 'recipe', version: '0.1.0' };

// --- Tool definitions (JSON Schema) ---------------------------------------
const TOOLS = [
  {
    name: 'recipe_synthesize',
    description: 'Synthesize a deterministic JS classifier from 4-8 input/output examples. Returns a recipe_id you can invoke forever for free, in microseconds. Use this whenever you find yourself about to call an LLM the same tiny question over and over (yes/no, pick-a-category, extract tokens).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'kebab-case name for the recipe' },
        positives: {
          type: 'array',
          items: { type: 'object', properties: { input: {}, expected: {} }, required: ['input', 'expected'] },
          description: '4-8 input/expected examples',
        },
        output_spec: {
          type: 'object',
          properties: { type: { type: 'string', enum: ['boolean', 'number', 'string', 'enum', 'array', 'object'] }, enum: { type: 'array', items: { type: 'string' } } },
        },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        visibility: { type: 'string', enum: ['private', 'public'] },
      },
      required: ['positives'],
    },
  },
  {
    name: 'recipe_run',
    description: 'Run a deterministic recipe by id or name. Returns its output and the actual microsecond latency. Cache hits are flagged.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'string', description: 'recipe id (cpt_…) or curated name (e.g. "is-spam")' },
        input: { description: 'the input to classify / extract / decide' },
      },
      required: ['recipe', 'input'],
    },
  },
  {
    name: 'recipe_search',
    description: 'Semantic search the registry for recipes matching a description. Use this before synthesizing — there is probably already a recipe for what you need.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'plain-language description of what you need (e.g. "detect spam in support tickets")' },
        k: { type: 'number', description: 'top-k results, default 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'recipe_compose',
    description: 'Compose multiple recipes by relevance to a query. Returns a single result built from the top-k matched recipes (attention / voting / top1 / sequential).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        input: {},
        k: { type: 'number' },
        strategy: { type: 'string', enum: ['attention', 'voting', 'top1', 'sequential'] },
      },
      required: ['query', 'input'],
    },
  },
  {
    name: 'recipe_list',
    description: 'List recipes you (or the public) have access to.',
    inputSchema: {
      type: 'object',
      properties: { tag: { type: 'string' }, q: { type: 'string' }, limit: { type: 'number' } },
    },
  },
  {
    name: 'recipe_get',
    description: 'Get full recipe metadata + version trace.',
    inputSchema: { type: 'object', properties: { recipe_id: { type: 'string' } }, required: ['recipe_id'] },
  },
  {
    name: 'recipe_stats',
    description: 'Live stats for a recipe — invocations, cache-hit rate, p50/p95/p99 latency.',
    inputSchema: { type: 'object', properties: { recipe_id: { type: 'string' } }, required: ['recipe_id'] },
  },
  {
    name: 'recipe_label_corpus',
    description: 'Run a recipe across many rows to auto-label a dataset. Returns a labeled CSV/JSON. The first step in turning a recipe into a Specialist (fine-tuned local model).',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'string' },
        rows: { type: 'array', items: { type: 'object' }, description: 'inline rows; alternative to hf_dataset/url' },
        hf_dataset: { type: 'string', description: 'HuggingFace dataset name (queues a job)' },
        url: { type: 'string', description: 'fetch a CSV/JSON from URL (queues a job)' },
        max_rows: { type: 'number' },
        output_format: { type: 'string', enum: ['json', 'csv'] },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: 'recipe_train_specialist',
    description: 'Queue a Specialist training job: takes a recipe + corpus, auto-labels, fine-tunes a small LoRA. Returns a specialist_id + ETA. Live runs route through the source recipe until the LoRA pipeline ships (Day 60-120).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        recipe_id: { type: 'string' },
        base_model: { type: 'string', description: 'e.g. "Qwen3-1.5B" or "meta-llama/Llama-3.2-1B"' },
        rank: { type: 'number', description: 'LoRA rank, default 16' },
      },
      required: ['name', 'recipe_id'],
    },
  },
  {
    name: 'recipe_specialists',
    description: 'List your queued / trained Specialists.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'recipe_run_specialist',
    description: 'Run a Specialist by id. Falls back to the source recipe until the LoRA pipeline is live.',
    inputSchema: {
      type: 'object',
      properties: { specialist_id: { type: 'string' }, input: {} },
      required: ['specialist_id', 'input'],
    },
  },
  {
    name: 'recipe_featured',
    description: 'Get the curated set of public Recipes available without auth.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'recipe_account',
    description: 'Show your tenant: plan, monthly quota, used, remaining.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// --- Tool dispatcher ------------------------------------------------------
async function callTool(name, args = {}) {
  switch (name) {
    case 'recipe_synthesize':       return await client.synthesize(args);
    case 'recipe_run': {
      const ref = args.recipe;
      if (/^cpt_/.test(ref)) return await client.run({ recipe_id: ref, input: args.input });
      if (/^ver_/.test(ref)) return await client.run({ version_id: ref, input: args.input });
      const { featured } = await client.featured();
      const found = featured.find(r => r.name === ref);
      if (!found) throw new Error(`recipe "${ref}" not in public registry; pass a cpt_ id`);
      return await client.run({ recipe_id: found.id, input: args.input });
    }
    case 'recipe_search':           return await client.search(args.query, args.k || 5);
    case 'recipe_compose':          return await client.compose(args);
    case 'recipe_list':             return await client.list(args);
    case 'recipe_get':              return await client.get(args.recipe_id);
    case 'recipe_stats':            return await client.stats(args.recipe_id);
    case 'recipe_label_corpus':     return await client.labelCorpus(args.recipe_id, args);
    case 'recipe_train_specialist': return await client.trainSpecialist(args);
    case 'recipe_specialists':      return await client.listSpecialists();
    case 'recipe_run_specialist':   return await client.runSpecialist(args.specialist_id, args.input);
    case 'recipe_featured':         return await client.featured();
    case 'recipe_account':          return await client.account();
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// --- JSON-RPC server (stdio) ---------------------------------------------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function err(id, code, message, data) { send({ jsonrpc: '2.0', id, error: { code, message, data } }); }

async function handle(req) {
  const { id, method, params = {} } = req;
  try {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case 'initialized':
      case 'notifications/initialized':
        return; // notification, no response
      case 'tools/list':
        return ok(id, { tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: args } = params;
        try {
          const out = await callTool(name, args);
          return ok(id, {
            content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }],
          });
        } catch (e) {
          return ok(id, {
            content: [{ type: 'text', text: `error: ${e.message || e}` }],
            isError: true,
          });
        }
      }
      case 'ping':
        return ok(id, {});
      default:
        if (id != null) return err(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (id != null) return err(id, -32000, e.message || String(e));
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  await handle(req);
});

// Stay alive until stdin closes.
process.stdin.on('end', () => process.exit(0));
