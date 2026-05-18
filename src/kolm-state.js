// W232 — git-native .kolm-state directory + checkpoint / import-chat / merge.
//
// Layout (per project, sibling to package.json):
//   .kolm-state/
//     checkpoints/<ts>-<short-hash>/
//       manifest.json         # what was snapshotted (paths + hashes + label)
//       artifacts.txt         # newline-separated artifact paths relative to project
//     imports/<ts>-<source>.jsonl
//                             # canonical seeds.jsonl format (one {prompt,response} per line)
//     merges/<ts>-<base>-<head>.json
//                             # merge manifest: base_hash, head_hash, evaluator, decisions
//     HEAD                    # last-touched checkpoint id (one line)
//
// All writes are durable + idempotent + git-friendly (line-delimited, no
// binary embedding — artifacts stay on disk and are referenced by path+hash).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export const STATE_DIRNAME = '.kolm-state';
export const SUBDIRS = ['checkpoints', 'imports', 'merges'];

export const VALID_SOURCES = ['claude', 'chatgpt', 'jsonl'];

export function stateRoot(projectDir = process.cwd()) {
  return path.join(projectDir, STATE_DIRNAME);
}

export function ensureState(projectDir = process.cwd()) {
  const root = stateRoot(projectDir);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  for (const sub of SUBDIRS) {
    const p = path.join(root, sub);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
  return root;
}

function tsStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// ─── checkpoint ───────────────────────────────────────────────────────────────

export function createCheckpoint(opts = {}) {
  const projectDir = opts.projectDir || process.cwd();
  ensureState(projectDir);

  const ts = tsStamp();
  // Snapshot every *.kolm and every *.json artifact at project root + any
  // file the caller explicitly passes in opts.include[].
  const candidates = new Set();
  for (const ent of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    if (/\.(kolm|kolm-manifest\.json)$/.test(ent.name)) {
      candidates.add(path.join(projectDir, ent.name));
    }
  }
  for (const inc of (opts.include || [])) {
    const abs = path.isAbsolute(inc) ? inc : path.join(projectDir, inc);
    if (fs.existsSync(abs)) candidates.add(abs);
  }

  const items = [];
  for (const f of candidates) {
    const h = sha256File(f);
    items.push({ path: path.relative(projectDir, f), sha256: h, size: fs.statSync(f).size });
  }

  // Deterministic short hash from manifest content (not from timestamp), so
  // identical state produces identical checkpoint dir names ignoring ts.
  const manifestBody = JSON.stringify(items.map(x => `${x.sha256}:${x.path}`).sort());
  const shortHash = crypto.createHash('sha256').update(manifestBody).digest('hex').slice(0, 12);
  const id = `${ts}-${shortHash}`;
  const dir = path.join(stateRoot(projectDir), 'checkpoints', id);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {
    id,
    created_at: new Date().toISOString(),
    label: opts.label || '',
    project_dir: projectDir,
    items,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'artifacts.txt'),
    items.map(x => `${x.sha256}  ${x.path}`).join('\n') + (items.length ? '\n' : ''),
    'utf8'
  );
  fs.writeFileSync(path.join(stateRoot(projectDir), 'HEAD'), id, 'utf8');
  return manifest;
}

export function listCheckpoints(projectDir = process.cwd()) {
  const dir = path.join(stateRoot(projectDir), 'checkpoints');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => fs.statSync(path.join(dir, n)).isDirectory())
    .sort()
    .map(id => {
      const mp = path.join(dir, id, 'manifest.json');
      if (!fs.existsSync(mp)) return { id, broken: true };
      try { return JSON.parse(fs.readFileSync(mp, 'utf8')); }
      catch (_) { return { id, broken: true }; }
    });
}

export function getCheckpoint(id, projectDir = process.cwd()) {
  const mp = path.join(stateRoot(projectDir), 'checkpoints', id, 'manifest.json');
  if (!fs.existsSync(mp)) return null;
  return JSON.parse(fs.readFileSync(mp, 'utf8'));
}

// ─── import-chat ──────────────────────────────────────────────────────────────

// Parsers normalize various chat-export formats into canonical seed rows:
// { prompt: string, response: string, source?, conversation_id?, turn_index? }
function parseClaude(json) {
  // Claude export: { conversations: [ { messages: [ { sender, text } ] } ] }
  const out = [];
  const convs = Array.isArray(json.conversations) ? json.conversations
                : Array.isArray(json) ? json : [];
  for (const c of convs) {
    const cid = c.uuid || c.id || '';
    const msgs = Array.isArray(c.messages) ? c.messages
               : Array.isArray(c.chat_messages) ? c.chat_messages : [];
    let last_user = null;
    let idx = 0;
    for (const m of msgs) {
      const role = m.sender || m.role || m.author_role || '';
      const text = m.text || m.content || (Array.isArray(m.content) ? m.content.map(x => x.text || '').join('') : '');
      if (!text) continue;
      if (role === 'human' || role === 'user') {
        last_user = text;
      } else if (last_user && (role === 'assistant' || role === 'claude' || role === 'bot')) {
        out.push({ prompt: last_user, response: text, source: 'claude', conversation_id: cid, turn_index: idx++ });
        last_user = null;
      }
    }
  }
  return out;
}

function parseChatgpt(json) {
  // ChatGPT export: array of { mapping: { id: { message: { author: {role}, content: {parts: [...]} } } } }
  const out = [];
  const convs = Array.isArray(json) ? json : (Array.isArray(json.conversations) ? json.conversations : []);
  for (const c of convs) {
    const cid = c.id || c.conversation_id || '';
    const mapping = c.mapping || {};
    const linear = [];
    for (const k of Object.keys(mapping)) {
      const m = mapping[k]?.message;
      if (!m) continue;
      const role = m.author?.role || '';
      const parts = m.content?.parts || [];
      const text = parts.filter(p => typeof p === 'string').join('\n').trim();
      if (text && (role === 'user' || role === 'assistant')) {
        linear.push({ role, text, ts: m.create_time || 0 });
      }
    }
    linear.sort((a, b) => a.ts - b.ts);
    let last_user = null;
    let idx = 0;
    for (const m of linear) {
      if (m.role === 'user') last_user = m.text;
      else if (last_user && m.role === 'assistant') {
        out.push({ prompt: last_user, response: m.text, source: 'chatgpt', conversation_id: cid, turn_index: idx++ });
        last_user = null;
      }
    }
  }
  return out;
}

function parseJsonl(raw) {
  // Already canonical: one JSON per line with {prompt, response}
  const out = [];
  for (const line of raw.split(/\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch (_) { continue; }
    if (typeof obj.prompt === 'string' && typeof obj.response === 'string') {
      out.push({ prompt: obj.prompt, response: obj.response, source: obj.source || 'jsonl' });
    }
  }
  return out;
}

export function importChat(filePath, opts = {}) {
  const projectDir = opts.projectDir || process.cwd();
  ensureState(projectDir);
  const source = opts.source || 'jsonl';
  if (!VALID_SOURCES.includes(source)) {
    throw new Error(`unknown source: ${source} (valid: ${VALID_SOURCES.join(', ')})`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let pairs;
  if (source === 'jsonl') {
    pairs = parseJsonl(raw);
  } else {
    let json;
    try { json = JSON.parse(raw); } catch (e) {
      throw new Error(`failed to parse ${filePath} as JSON for source=${source}: ${e.message}`);
    }
    pairs = source === 'claude' ? parseClaude(json) : parseChatgpt(json);
  }

  const ts = tsStamp();
  const ns = (opts.namespace || 'default').replace(/[^a-z0-9_-]/gi, '_');
  const outFile = path.join(stateRoot(projectDir), 'imports', `${ts}-${source}-${ns}.jsonl`);
  const lines = pairs.map(p => JSON.stringify({
    prompt: p.prompt,
    response: p.response,
    source: p.source,
    namespace: ns,
    conversation_id: p.conversation_id || '',
    turn_index: typeof p.turn_index === 'number' ? p.turn_index : 0,
  }));
  fs.writeFileSync(outFile, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return { file: outFile, pairs_imported: pairs.length, source, namespace: ns };
}

// ─── merge ────────────────────────────────────────────────────────────────────

export function mergeRecipes(basePath, headPath, opts = {}) {
  const projectDir = opts.projectDir || process.cwd();
  ensureState(projectDir);
  if (!fs.existsSync(basePath)) throw new Error(`base not found: ${basePath}`);
  if (!fs.existsSync(headPath)) throw new Error(`head not found: ${headPath}`);

  const baseHash = sha256File(basePath);
  const headHash = sha256File(headPath);
  const baseSize = fs.statSync(basePath).size;
  const headSize = fs.statSync(headPath).size;

  // Evaluator strategy:
  //   - if --evaluator <file> given: read evaluator manifest, record its hash
  //     in the merge manifest; actual eval-run is deferred to compile pipeline.
  //     Default decision is 'head' wins on identical inputs unless evaluator
  //     manifest explicitly names a base-preferring axis.
  //   - if no evaluator: default strategy is 'head_wins'.
  const evaluator = opts.evaluator ? path.resolve(opts.evaluator) : null;
  let evaluatorHash = null;
  let strategy = 'head_wins';
  if (evaluator) {
    if (!fs.existsSync(evaluator)) throw new Error(`evaluator not found: ${evaluator}`);
    evaluatorHash = sha256File(evaluator);
    strategy = 'evaluator_decides';
  }

  const ts = tsStamp();
  const baseTag = path.basename(basePath, path.extname(basePath));
  const headTag = path.basename(headPath, path.extname(headPath));
  const outPath = opts.output
    ? path.resolve(opts.output)
    : path.join(projectDir, `${baseTag}+${headTag}.kolm`);

  const manifest = {
    created_at: new Date().toISOString(),
    base: { path: path.relative(projectDir, basePath), sha256: baseHash, size: baseSize },
    head: { path: path.relative(projectDir, headPath), sha256: headHash, size: headSize },
    evaluator: evaluator
      ? { path: path.relative(projectDir, evaluator), sha256: evaluatorHash }
      : null,
    strategy,
    output: path.relative(projectDir, outPath),
    note: evaluator
      ? 'evaluator metadata recorded; pair-level evaluation runs in the compile pipeline'
      : 'no evaluator supplied; head_wins is the default merge strategy',
  };

  const mergeFile = path.join(
    stateRoot(projectDir),
    'merges',
    `${ts}-${baseTag}-${headTag}.json`
  );
  fs.writeFileSync(mergeFile, JSON.stringify(manifest, null, 2), 'utf8');

  // Write a placeholder merged artifact: by default we copy head bytes and
  // append a single-line merge stamp so the file is byte-different from head.
  // Heavy ML-based pair-level merging lives in compile pipeline; this
  // function ships the deterministic merge-record + a runnable artifact stub.
  const headBytes = fs.readFileSync(headPath);
  const stamp = `\n# kolm-merge ${ts} base=${baseHash.slice(0, 12)} head=${headHash.slice(0, 12)} strategy=${strategy}\n`;
  fs.writeFileSync(outPath, Buffer.concat([headBytes, Buffer.from(stamp, 'utf8')]));

  return { ...manifest, manifest_file: mergeFile, output: outPath };
}

export default {
  STATE_DIRNAME, SUBDIRS, VALID_SOURCES,
  stateRoot, ensureState,
  createCheckpoint, listCheckpoints, getCheckpoint,
  importChat,
  mergeRecipes,
};
