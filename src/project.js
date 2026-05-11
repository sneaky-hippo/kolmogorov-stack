// Project-config loader for kolm.yaml v0.1.
//
// Hand-parses the small subset of kolm.yaml that the CLI / MCP server actually
// read at runtime (name, skills_dir, k_min, artifacts globs, mcp transport).
// A real YAML parser would be ~250kB of dep; the actual project file shape is
// flat enough that line-by-line is fine.
//
// The schema source of truth is /docs/kolm-yaml-v0.1.json. Update both when
// adding fields.

import fs from 'node:fs';
import path from 'node:path';

// Walk up looking for kolm.yaml. Returns { root, raw, config } or null.
export function findProjectConfig(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (let depth = 0; depth < 12; depth++) {
    const p = path.join(dir, 'kolm.yaml');
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        return { root: dir, path: p, raw, config: parseProjectYaml(raw, dir) };
      } catch { return null; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Extracts:
//   name             — project slug (defaults to dir basename)
//   version
//   description
//   skills_dir       — defaults to ./.kolm/skills
//   k_min            — project-level K-score gate (defaults to 0)
//   mcp.transport    — 'stdio' | 'http' | 'sse'
//   mcp.host / port
//   artifacts        — [{ path, name, description, k_min, paths[], allowed_tools[] }]
//
// Tolerant: malformed lines are skipped silently.
export function parseProjectYaml(text, rootDir) {
  const out = {
    name: rootDir ? path.basename(rootDir) : 'kolm',
    version: '0.1.0',
    description: '',
    skills_dir: './.kolm/skills',
    k_min: 0,
    mcp: { transport: 'stdio', host: '127.0.0.1', port: null },
    artifacts: [],
  };
  if (!text) return out;
  const lines = text.split(/\r?\n/);

  // Top-level scalars
  for (const line of lines) {
    let m;
    if ((m = line.match(/^name:\s*(\S+)/))) out.name = stripQuotes(m[1]);
    else if ((m = line.match(/^version:\s*(\S+)/))) out.version = stripQuotes(m[1]);
    else if ((m = line.match(/^description:\s*(.+)$/))) out.description = stripQuotes(m[1].trim());
    else if ((m = line.match(/^skills_dir:\s*(\S+)/))) out.skills_dir = stripQuotes(m[1]);
    else if ((m = line.match(/^k_min:\s*([0-9.]+)/))) out.k_min = Number(m[1]);
  }

  // mcp:
  const mcpBlock = extractBlock(lines, /^mcp:\s*(#.*)?$/);
  if (mcpBlock) {
    for (const l of mcpBlock.lines) {
      let m;
      if ((m = l.match(/^\s+transport:\s*(\S+)/))) out.mcp.transport = stripQuotes(m[1]);
      else if ((m = l.match(/^\s+host:\s*(\S+)/))) out.mcp.host = stripQuotes(m[1]);
      else if ((m = l.match(/^\s+port:\s*(\d+)/))) out.mcp.port = Number(m[1]);
    }
  }

  // artifacts: list of dash-prefixed objects.
  const artBlock = extractBlock(lines, /^artifacts:\s*(#.*)?$/);
  if (artBlock) {
    let cur = null;
    for (const l of artBlock.lines) {
      const trimmed = l.replace(/^\s*/, '');
      if (trimmed.startsWith('- ')) {
        if (cur) out.artifacts.push(cur);
        cur = { path: null, name: null, description: '', k_min: 0, paths: [], allowed_tools: [] };
        const rest = trimmed.slice(2).trim();
        const kv = rest.match(/^([a-z_]+):\s*(.*)$/);
        if (kv) assignArtifactField(cur, kv[1], kv[2]);
      } else if (cur) {
        const kv = trimmed.match(/^([a-z_-]+):\s*(.*)$/);
        if (kv) assignArtifactField(cur, kv[1].replace(/-/g, '_'), kv[2]);
      }
    }
    if (cur) out.artifacts.push(cur);
  }
  return out;
}

function assignArtifactField(art, key, raw) {
  const v = stripQuotes((raw || '').trim());
  if (key === 'path') art.path = v;
  else if (key === 'name') art.name = v;
  else if (key === 'description') art.description = v;
  else if (key === 'k_min') art.k_min = Number(v);
  else if (key === 'paths') art.paths = parseInlineList(v);
  else if (key === 'allowed_tools' || key === 'allowed-tools') art.allowed_tools = parseInlineList(v);
}

function parseInlineList(s) {
  if (!s) return [];
  if (!s.startsWith('[')) return [];
  const inner = s.replace(/^\[/, '').replace(/\][^\]]*$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map(x => stripQuotes(x.trim())).filter(Boolean);
}

function extractBlock(lines, headerRe) {
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx < 0) return null;
  let indent = -1;
  const block = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) { block.push(l); continue; }
    const m = l.match(/^(\s+)\S/);
    if (!m) break;
    if (indent < 0) indent = m[1].length;
    if (m[1].length < indent) break;
    block.push(l);
  }
  return { startIdx, lines: block };
}

function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// Resolve a kolm.yaml `artifacts[].path` (which may be a directory or a glob
// like `./.kolm/artifacts/*.kolm`) into an absolute list of .kolm files.
export function resolveArtifactPaths(globOrDir, projectRoot) {
  const abs = path.resolve(projectRoot, globOrDir);
  // Globs like *.kolm — directory + filter
  if (globOrDir.includes('*')) {
    const dir = path.dirname(abs);
    const pattern = path.basename(abs);
    if (!fs.existsSync(dir)) return [];
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return fs.readdirSync(dir).filter(f => re.test(f)).map(f => path.join(dir, f));
  }
  // Directory — return all .kolm
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return fs.readdirSync(abs).filter(f => f.endsWith('.kolm')).map(f => path.join(abs, f));
  }
  // Single file
  if (fs.existsSync(abs)) return [abs];
  return [];
}
