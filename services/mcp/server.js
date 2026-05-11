// kolm serve --mcp — Model Context Protocol server.
//
// Reads ~/.kolm/artifacts/*.kolm, exposes each as an MCP tool. Frontier
// agents (Claude Desktop, Cursor, Codex, etc.) configure stdio entries
// pointing at `kolm serve --mcp` and from then on can:
//
//   tools/list              → discover every locally-compiled skill
//   tools/call name=x args  → run skill x against args, get receipt
//
// Two transports:
//   stdio (default)   — JSON-RPC over stdin/stdout. Standard for MCP clients.
//   http (--http)     — JSON-RPC POST /mcp endpoint. For network agents.
//
// The tool name is the artifact filename minus .kolm; description is
// manifest.task; the input schema is { input: any } in Sprint 1 (we don't
// yet know what shape any given recipe expects, so we accept-anything and
// let the runner dispatch).

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { runArtifact, inspectArtifact } from '../../src/artifact-runner.js';
import { findProjectConfig, resolveArtifactPaths } from '../../src/project.js';

const PROTOCOL_VERSION = '2024-11-05';

function listArtifactsInDir(artifactsDir) {
  if (!fs.existsSync(artifactsDir)) return [];
  return fs.readdirSync(artifactsDir)
    .filter(f => f.endsWith('.kolm'))
    .map(f => path.join(artifactsDir, f));
}

function safeName(filename) {
  return path.basename(filename, '.kolm').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// Source = a discovery root: either the user-global artifacts dir or a
// project-scoped one. Each source can specify a k_min floor and a project
// name that becomes the MCP tool prefix (mcp__<project>__<artifact>).
//
// Discovery order:
//   1) global ~/.kolm/artifacts (always present, no project prefix)
//   2) any kolm.yaml at cwd: its declared artifacts[] globs + k_min
function discoverSources(ctx) {
  const sources = [];
  if (ctx.artifactsDir) {
    sources.push({
      dir: ctx.artifactsDir,
      files: listArtifactsInDir(ctx.artifactsDir),
      project: null,
      k_min: 0,
      meta: {},
    });
  }
  const proj = findProjectConfig(ctx.projectCwd || process.cwd());
  if (proj && proj.config) {
    const cfg = proj.config;
    const seen = new Set();
    const items = cfg.artifacts && cfg.artifacts.length ? cfg.artifacts : [
      { path: './.kolm/artifacts/*.kolm', name: cfg.name, description: cfg.description, k_min: cfg.k_min },
    ];
    for (const entry of items) {
      if (!entry || !entry.path) continue;
      const files = resolveArtifactPaths(entry.path, proj.root);
      for (const f of files) {
        if (seen.has(f)) continue;
        seen.add(f);
      }
      sources.push({
        dir: path.dirname(path.resolve(proj.root, entry.path.replace(/\*.*$/, ''))) || proj.root,
        files: [...seen].filter(f => files.includes(f)),
        project: cfg.name,
        k_min: Math.max(cfg.k_min || 0, entry.k_min || 0),
        meta: {
          description: entry.description || cfg.description || '',
          paths: entry.paths || [],
          allowed_tools: entry.allowed_tools || [],
        },
      });
    }
  }
  return sources;
}

function listTools(ctx) {
  const sources = discoverSources(ctx);
  const out = [];
  const seen = new Set();
  for (const src of sources) {
    for (const ap of src.files) {
      if (seen.has(ap)) continue;
      seen.add(ap);
      let info;
      try { info = inspectArtifact(ap); } catch { continue; }
      const k = info.k_score?.composite;
      if (src.k_min > 0 && typeof k === 'number' && k < src.k_min) continue;
      const baseName = safeName(ap);
      const toolName = src.project ? `mcp__${src.project}__${baseName}` : baseName;
      const desc = src.meta.description
        ? `${src.meta.description} — k=${k ?? '?'}, ${info.signature_valid ? 'signed' : 'UNSIGNED'}`
        : `${info.task || 'compiled kolm skill'} — k=${k ?? '?'}, recipes=${info.recipes_n}, ${info.signature_valid ? 'signed' : 'UNSIGNED'}`;
      out.push({
        name: toolName,
        description: desc,
        inputSchema: {
          type: 'object',
          properties: {
            input: { description: 'whatever the recipe expects (string, number, object, array)' },
            params: { type: 'object', description: 'optional tenant-runtime config (extra patterns, vertical-specific rules) — never re-signed into the artifact' },
          },
          required: ['input'],
        },
        _kolm: {
          artifact_path: ap,
          k_score: info.k_score,
          tier: info.tier,
          pack_present: info.pack_present,
          index_present: info.index_present,
          job_id: info.job_id,
          project: src.project,
          paths: src.meta.paths,
        },
      });
    }
  }
  return out;
}

function findArtifactByToolName(ctx, name) {
  const tools = listTools(ctx);
  const hit = tools.find(t => t.name === name);
  return hit ? hit._kolm.artifact_path : null;
}

async function handleRpc(req, ctx) {
  const id = req.id ?? null;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail  = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'kolm', version: '0.1.0', description: 'compiler cache for intelligence' },
      });

    case 'tools/list': {
      const tools = listTools(ctx).map(t => {
        // Strip _kolm metadata before sending to the wire — MCP clients
        // ignore unknown keys but the spec is cleaner without them.
        const { _kolm, ...wire } = t;
        return wire;
      });
      return reply({ tools });
    }

    case 'tools/call': {
      const { name, arguments: args } = req.params || {};
      if (!name) return fail(-32602, 'name required');
      const ap = findArtifactByToolName(ctx, name);
      if (!ap) return fail(-32602, 'no such tool: ' + name);
      try {
        const r = await runArtifact(ap, args?.input, { params: args?.params });
        return reply({
          content: [{
            type: 'text',
            text: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
          }],
          _kolm: {
            recipe_id: r.recipe_id,
            recipe_name: r.recipe_name,
            latency_us: r.latency_us,
            k_score: r.k_score,
            receipt: r.receipt,
            audit: r.audit,
          },
        });
      } catch (e) {
        return fail(-32000, `kolm run failed${e.code ? ` [${e.code}]` : ''}: ` + (e.message || String(e)));
      }
    }

    case 'ping':
      return reply({});

    default:
      return fail(-32601, 'method not found: ' + req.method);
  }
}

function printClientConfig(ctx) {
  const { artifactsDir, http: isHttp, port } = ctx;
  const proj = findProjectConfig(ctx.projectCwd || process.cwd());
  const tools = listTools(ctx);
  console.error(`\n┌─ kolm MCP server ─────────────────────────────────────────`);
  console.error(`│  global:    ${artifactsDir}`);
  if (proj) {
    console.error(`│  project:   ${proj.config.name}  (${path.relative(process.cwd(), proj.path)})`);
    if ((proj.config.k_min || 0) > 0) {
      console.error(`│  k_min:     ${proj.config.k_min}  (refusing artifacts below this score)`);
    }
  }
  console.error(`│  tools:     ${tools.length}`);
  for (const t of tools.slice(0, 8)) {
    console.error(`│    • ${t.name} — ${t.description.slice(0, 60)}`);
  }
  if (tools.length > 8) console.error(`│    … and ${tools.length - 8} more`);
  console.error(`│`);
  if (isHttp) {
    console.error(`│  HTTP transport listening on http://127.0.0.1:${port}/mcp`);
  } else {
    console.error(`│  stdio transport active. Add to your MCP client config:`);
    console.error(`│`);
    const cfg = JSON.stringify({ kolm: { command: 'kolm', args: ['serve', '--mcp'] } }, null, 2)
      .split('\n').map(l => '│    ' + l).join('\n');
    console.error(cfg);
  }
  console.error(`└────────────────────────────────────────────────────────────\n`);
}

// stdio transport — read newline-delimited JSON from stdin, write to stdout.
function startStdio(ctx) {
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); } catch (e) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
        continue;
      }
      try {
        const out = await handleRpc(req, ctx);
        process.stdout.write(JSON.stringify(out) + '\n');
      } catch (e) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id ?? null, error: { code: -32000, message: String(e.message || e) } }) + '\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// HTTP transport — POST /mcp with a single JSON-RPC body, response in body.
function startHttp(ctx) {
  const srv = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, tools: listTools(ctx).length }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad json' })); return; }
      const out = await handleRpc(parsed, ctx);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  srv.listen(ctx.port, '127.0.0.1', () => {
    printClientConfig(ctx);
  });
}

export async function startMcpServer({ artifactsDir, http: useHttp = false, port = 8765, projectCwd = null }) {
  const ctx = { artifactsDir, http: useHttp, port, projectCwd: projectCwd || process.cwd() };
  if (useHttp) startHttp(ctx);
  else { printClientConfig(ctx); startStdio(ctx); }
}

// Allow direct node invocation (handy for tests). Cross-platform: normalize
// argv[1] to forward slashes and accept either a /mcp/server.js suffix or a
// matching file:// URL.
const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
if (import.meta.url.endsWith(argv1) || argv1.endsWith('/mcp/server.js')) {
  const args = process.argv.slice(2);
  const useHttp = args.includes('--http');
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8765;
  const dir = process.env.KOLM_ARTIFACTS_DIR || path.join(process.env.HOME || process.env.USERPROFILE, '.kolm', 'artifacts');
  startMcpServer({ artifactsDir: dir, http: useHttp, port });
}
