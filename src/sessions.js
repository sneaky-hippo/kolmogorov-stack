// W233 — detached-session layer on top of src/jobs.js.
//
// Three primitives the CLI consumes:
//
//   detach({ argv, kind, meta })
//     Respawn the current `kolm` invocation as a detached background process
//     with stdout+stderr redirected to a fresh job log. Returns the job record
//     synchronously. Parent should print the session id and exit; the child
//     re-enters main() with the --detach flag stripped from argv so the work
//     actually runs to completion. Honors KOLM_BIN to find the entry point so
//     tests can point at a stub.
//
//   resume({ id })
//     Tail the session's log file with follow semantics. Re-attachable from
//     any TTY, multiple tails OK. Returns when the job leaves the running
//     state. The caller is expected to print initial buffer + new chunks.
//
//   rescue({ pid })
//     Reptyr-style adoption of an orphaned PID. On Linux with `reptyr`
//     installed we shell out to it. Everywhere else we return an honest
//     amber-pill record listing the workaround so users aren't surprised.
//
// All session metadata is jobs.jsonl rows with kind='compile'|'distill'|...
// so `kolm jobs`, `kolm watch`, and the W232 .kolm-state surfaces all see
// detached sessions the same way they see foreground ones.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';
import * as jobs from './jobs.js';

const PLATFORM = process.platform;

export function isAttachableTTY() {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

// True when the host can actually rescue a foreign PID's stdio. reptyr is
// Linux/ptrace; macOS lacks an equivalent (lldb attach without rebroker is
// not the same thing); Windows has nothing close. Return reason as a string
// so the CLI can print the honest answer.
export function rescueSupport() {
  if (PLATFORM === 'linux') {
    try {
      const out = child_process.execSync('command -v reptyr || true', { encoding: 'utf8' }).trim();
      if (out) return { supported: true, tool: 'reptyr', path: out };
      return { supported: false, reason: 'reptyr not installed (apt install reptyr)' };
    } catch (_) {
      return { supported: false, reason: 'reptyr not installed (apt install reptyr)' };
    }
  }
  if (PLATFORM === 'darwin') {
    return { supported: false, reason: 'macOS has no reptyr equivalent — use `tmux pipe-pane` / `script -F /dev/fd/N`' };
  }
  if (PLATFORM === 'win32') {
    return { supported: false, reason: 'Windows has no reptyr equivalent — use `kolm watch <job-id>` to tail the log path' };
  }
  return { supported: false, reason: 'unknown platform: ' + PLATFORM };
}

// Strip the `--detach` flag from an argv slice so the child doesn't re-fork
// itself in an infinite loop. We keep the position of remaining args stable.
export function stripDetach(argv) {
  const out = [];
  for (const a of argv) {
    if (a === '--detach' || a === '--background' || a === '-d') continue;
    out.push(a);
  }
  return out;
}

// Spawn the current process as a detached child. argv should be the *full*
// argv array the user typed (process.argv.slice(2)). kind is one of the
// jobs.VALID_KINDS. Returns the created job record.
export function detach({ argv, kind = 'compile', meta = {}, binOverride = null } = {}) {
  if (!argv || !Array.isArray(argv)) throw new Error('detach: argv required');
  if (!jobs.VALID_KINDS.has(kind)) {
    throw new Error(`detach: invalid kind ${kind} (valid: ${[...jobs.VALID_KINDS].join(', ')})`);
  }
  jobs.ensureDirs();
  const cleanArgv = stripDetach(argv);
  const bin = binOverride || process.env.KOLM_BIN || path.resolve(
    path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
    '..', 'cli', 'kolm.js'
  );
  // Create the job record FIRST so we know the log path before spawning.
  const rec = jobs.create({ kind, pid: 0, meta: { ...meta, argv: cleanArgv, detached: true, host: os.hostname(), at: new Date().toISOString() } });
  const logFd = fs.openSync(rec.log_path, 'a');
  // Children of detached children survive their parent. stdio is fully
  // redirected so closing the launching shell does not SIGHUP the worker.
  const isWindows = PLATFORM === 'win32';
  const cmd = isWindows ? process.execPath : process.execPath;
  const cmdArgs = [bin, ...cleanArgv];
  const child = child_process.spawn(cmd, cmdArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, KOLM_JOB_ID: rec.id, KOLM_DETACHED: '1' },
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);
  // Patch the job with the real PID once the child is up.
  jobs.update(rec.id, { pid: child.pid, status: 'running' });
  return { ...rec, pid: child.pid, status: 'running' };
}

// Follow-mode log tail for a previously-detached session.
//
// Returns a stop() handle. Caller is responsible for writing chunks to
// stdout (we pass them through onChunk) and stopping the tail when the
// job leaves the running state.
export function resume({ id, onChunk, pollMs = 500 }) {
  const rec = jobs.get(id);
  if (!rec) throw new Error(`unknown session: ${id}`);
  if (!fs.existsSync(rec.log_path)) throw new Error(`session log missing: ${rec.log_path}`);
  let stopped = false;
  let lastSize = 0;
  // Emit the existing tail (most-recent ~64 KB) so the user picks up where
  // they left off; then poll for growth.
  const initial = jobs.tailLog(id, { bytes: 65536 }) || '';
  if (initial) {
    lastSize = fs.statSync(rec.log_path).size;
    onChunk && onChunk(initial);
  }
  const tick = () => {
    if (stopped) return;
    try {
      const cur = jobs.get(id);
      const stat = fs.statSync(rec.log_path);
      if (stat.size > lastSize) {
        const fd = fs.openSync(rec.log_path, 'r');
        try {
          const len = stat.size - lastSize;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, lastSize);
          onChunk && onChunk(buf.toString('utf8'));
        } finally {
          fs.closeSync(fd);
        }
        lastSize = stat.size;
      }
      if (cur && (cur.status === 'completed' || cur.status === 'failed' || cur.status === 'cancelled')) {
        stopped = true;
        onChunk && onChunk(`\n# session ${id} ${cur.status}${cur.exit_code != null ? ' (exit=' + cur.exit_code + ')' : ''}\n`);
        return;
      }
      setTimeout(tick, pollMs);
    } catch (_) {
      setTimeout(tick, pollMs);
    }
  };
  setTimeout(tick, pollMs);
  return { stop: () => { stopped = true; } };
}

// Honest rescue surface. On Linux+reptyr we exec; everywhere else we return
// the action + workaround as a record so the CLI can print it verbatim.
export function rescue({ pid }) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) throw new Error('rescue: pid must be a positive integer');
  const support = rescueSupport();
  if (!support.supported) {
    return { ok: false, pid: n, reason: support.reason, workaround: 'kolm watch <job-id>  (if the orphan was launched via `kolm <verb> --detach`)' };
  }
  // Linux + reptyr — hand control to reptyr so it owns the TTY swap.
  // We don't capture output; reptyr takes over stdin/stdout/stderr directly.
  child_process.spawnSync(support.path, [String(n)], { stdio: 'inherit' });
  return { ok: true, pid: n, tool: support.tool };
}

export default { detach, resume, rescue, rescueSupport, isAttachableTTY, stripDetach };
