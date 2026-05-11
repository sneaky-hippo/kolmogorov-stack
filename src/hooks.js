// kolm hooks dispatcher.
//
// Loads hooks.<EventName>: [...] from the nearest kolm.yaml (walks up from
// cwd) and runs each command, passing a JSON event on stdin. Exit 0 lets the
// pipeline continue; exit 2 hard-blocks; any other non-zero is logged and
// treated as advisory (the run continues). This mirrors claude-code-hooks so
// scripts written for that ecosystem work without modification.
//
// Events the CLI fires:
//   PreCompile  { command:"compile", spec?, cwd, artifact?: outPath }
//   PostCompile { command:"compile", cwd, artifact, k_score, sha256 }
//   PreRun      { command:"run",  cwd, artifact, input }
//   PostRun     { command:"run",  cwd, artifact, latency_us, k_score, output_truncated }
//   PreBench    { command:"bench", cwd, artifact, runs }
//   PostBench   { command:"bench", cwd, artifact, runs, report }
//
// Each hook spec in kolm.yaml is one of:
//   ./path/to/script.sh             # shell script (POSIX); cmd /c on win32
//   "node ./scripts/lint-spec.js"   # full command line (split on whitespace)
//   { command: "...", timeout_ms: 5000 }
//   { type: "command", command: "...", timeout_ms: 5000 }
//
// Discovery: walks up from cwd looking for kolm.yaml. Returns silently if no
// project file is present — hooks are opt-in. Each hook is spawned with the
// project root as cwd so relative scripts ("./scripts/...") just work.
//
// The dispatcher never throws on hook failure unless exit code is exactly 2.
// Exit 2 is the agreed "block this operation" signal; the caller surfaces a
// HOOK_BLOCKED error and exits non-zero. Anything else is best-effort.
//
// Set KOLM_HOOKS_OFF=1 to disable all hooks (useful in CI snapshots).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const VALID_EVENTS = new Set([
  'PreCompile', 'PostCompile',
  'PreRun',     'PostRun',
  'PreBench',   'PostBench',
]);

const DEFAULT_TIMEOUT_MS = 30_000;

// Walk up looking for kolm.yaml. Returns { root, raw, hooks } or null.
// hooks is a map { EventName -> [{command, timeout_ms}] }.
export function findKolmYamlWithHooks(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (let depth = 0; depth < 12; depth++) {
    const p = path.join(dir, 'kolm.yaml');
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        return { root: dir, raw, hooks: parseHooksBlock(raw) };
      } catch { return null; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Hand-parse the `hooks:` block. We only support the shapes documented above —
// arrays of strings, arrays of {command, timeout_ms} flow objects, and inline
// `Event: ["a", "b"]` syntax. Anything more exotic should use a YAML parser
// (we'll pull one in v0.2 if needed).
//
// This is intentionally permissive: a malformed hooks block returns {} rather
// than throwing so a broken kolm.yaml never blocks `kolm run`.
export function parseHooksBlock(text) {
  const out = {};
  if (!text) return out;

  // Find the `hooks:` line; everything indented under it is the block.
  const lines = text.split(/\r?\n/);
  let hooksLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^hooks:\s*(#.*)?$/.test(lines[i])) { hooksLineIdx = i; break; }
  }
  if (hooksLineIdx < 0) return out;

  // Determine the indent of the block by looking at the first non-blank,
  // non-comment line under `hooks:`.
  let blockIndent = -1;
  for (let i = hooksLineIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const m = l.match(/^(\s+)\S/);
    if (!m) { blockIndent = -1; break; }
    blockIndent = m[1].length;
    break;
  }
  if (blockIndent < 0) return out;

  let curEvent = null;
  for (let i = hooksLineIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    // End of block: a line at the same or lower indent that isn't part of hooks.
    const leadMatch = l.match(/^(\s*)\S/);
    if (!leadMatch) continue;
    const lead = leadMatch[1].length;
    if (lead < blockIndent) break;

    if (lead === blockIndent) {
      // `EventName:` or `EventName: [inline, list]`
      const m = l.trim().match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (!m) continue;
      const name = m[1];
      if (!VALID_EVENTS.has(name)) continue;
      const rest = m[2].trim();
      if (rest.startsWith('[')) {
        out[name] = parseInlineList(rest);
        curEvent = null;
      } else if (rest === '' || rest.startsWith('#')) {
        curEvent = name;
        out[name] = out[name] || [];
      } else {
        // Single inline scalar value like `PreCompile: "./script.sh"`
        out[name] = [normalizeHook(stripQuotes(rest))];
        curEvent = null;
      }
    } else if (lead > blockIndent && curEvent) {
      // `  - "command"` or `  - command: "..."` style.
      const item = l.trim();
      if (item.startsWith('- ')) {
        const v = item.slice(2).trim();
        if (v.startsWith('{')) {
          const norm = parseFlowObject(v);
          if (norm) out[curEvent].push(norm);
        } else {
          out[curEvent].push(normalizeHook(stripQuotes(v)));
        }
      }
    }
  }
  return out;
}

function parseInlineList(s) {
  // Matches `["a", "b"]` or `[a, b]`. Tolerant: splits on commas, strips
  // brackets+quotes. Good enough for the documented shape; we'll upgrade to
  // a real YAML parser if anyone needs nested objects in inline lists.
  const inner = s.replace(/^\[/, '').replace(/\][^\]]*$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map(x => normalizeHook(stripQuotes(x.trim()))).filter(Boolean);
}

function parseFlowObject(s) {
  // Match `{command: "...", timeout_ms: 5000}` — single-level only.
  const inner = s.replace(/^\{/, '').replace(/\}\s*$/, '');
  const obj = {};
  for (const part of inner.split(',')) {
    const m = part.split(':');
    if (m.length < 2) continue;
    const k = m[0].trim();
    const v = stripQuotes(m.slice(1).join(':').trim());
    obj[k] = v;
  }
  if (!obj.command && obj.type === 'command') return null;
  if (!obj.command) return null;
  return normalizeHook(obj);
}

function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function normalizeHook(v) {
  if (!v) return null;
  if (typeof v === 'string') return { command: v, timeout_ms: DEFAULT_TIMEOUT_MS };
  if (typeof v === 'object') {
    return {
      command: v.command,
      timeout_ms: Number(v.timeout_ms) > 0 ? Number(v.timeout_ms) : DEFAULT_TIMEOUT_MS,
    };
  }
  return null;
}

// Run all hooks for `event` and return { ok, blocked, results: [...] }.
// Caller decides whether to bail on `blocked`. `event` must be one of
// VALID_EVENTS; payload is the JSON object sent to each hook on stdin.
export async function runHooks(event, payload, opts = {}) {
  if (process.env.KOLM_HOOKS_OFF === '1') return { ok: true, blocked: false, results: [], skipped: 'KOLM_HOOKS_OFF' };
  if (!VALID_EVENTS.has(event)) throw new Error('unknown hook event: ' + event);
  const proj = findKolmYamlWithHooks(opts.cwd || process.cwd());
  if (!proj) return { ok: true, blocked: false, results: [] };
  const hooks = proj.hooks[event] || [];
  if (!hooks.length) return { ok: true, blocked: false, results: [] };

  const results = [];
  let blocked = false;
  for (const h of hooks) {
    if (!h || !h.command) continue;
    const res = await runOne(h, { event, ...payload, project_root: proj.root }, proj.root);
    results.push({ command: h.command, ...res });
    if (res.exitCode === 2) {
      blocked = true;
      break;
    }
  }
  return { ok: !blocked, blocked, results };
}

function runOne(hook, payload, cwd) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd' : '/bin/sh';
    const shArgs = isWin ? ['/c', hook.command] : ['-c', hook.command];
    const child = spawn(shell, shArgs, {
      cwd,
      env: { ...process.env, KOLM_HOOK_EVENT: payload.event },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (exitCode, error) => {
      if (done) return;
      done = true;
      resolve({
        exitCode,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 4000),
        error: error || null,
      });
    };
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (e) => finish(-1, e.message));
    child.on('close', (code) => finish(code == null ? -1 : code, null));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(124, `hook exceeded ${hook.timeout_ms}ms`);
    }, hook.timeout_ms);
    timer.unref?.();
    try {
      child.stdin.end(JSON.stringify(payload));
    } catch (e) {
      finish(-1, 'stdin write failed: ' + e.message);
    }
  });
}

// Convenience wrapper that prints results to stderr in `kolm run --verbose`
// style. Returns true if the operation should continue.
export async function dispatch(event, payload, { onResult } = {}) {
  const r = await runHooks(event, payload);
  if (onResult) onResult(r);
  return !r.blocked;
}
