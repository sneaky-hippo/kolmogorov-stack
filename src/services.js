// W240 — service registry + lifecycle for the 3-process split.
//
// kolm previously ran every concern (redactor, compiler, proxy) as one
// monolithic Express app inside the api server. This let small footguns
// (one rogue route handler) take down the whole surface and made it hard
// to scale a hot path independently (e.g. capture proxy gets 100× the
// throughput of compile so it deserves its own process).
//
// Three services ship today:
//
//   redactor — HTTP wrapper around src/phi-redactor.js. Pure CPU. Default
//              port 7401. Stateless.
//   compiler — HTTP wrapper around src/compile.js + workers/*. Default
//              port 7402. Stateful (jobs + artifacts).
//   proxy    — capture-and-forward HTTP proxy in front of an upstream
//              teacher API (OpenAI / Anthropic / vLLM). Default port
//              7403. Persists captures via src/capture-store.js.
//
// Each service is its own Node entry-point under src/services/<name>.js
// so it can be exec'd directly with `node src/services/redactor.js
// --port=7401` without going through cli/kolm.js. That's important for
// container deployments (one image per service) and for the
// `kolm services start` CLI verb.
//
// State lives in ~/.kolm/services/<name>.json with:
//   { name, pid, port, host, started_at, log_path, status, version }
//
// `status` is one of: 'running' | 'stopped' | 'crashed' | 'unknown'.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DIR = path.join(os.homedir(), '.kolm', 'services');
const DEFAULT_LOG_DIR = path.join(os.homedir(), '.kolm', 'service-logs');

export const SERVICES = Object.freeze({
  redactor: {
    name: 'redactor',
    description: 'PHI/PII redactor HTTP wrapper',
    default_port: 7401,
    entry: path.join(__dirname, 'services', 'redactor.js'),
  },
  compiler: {
    name: 'compiler',
    description: 'compile + distill orchestrator HTTP wrapper',
    default_port: 7402,
    entry: path.join(__dirname, 'services', 'compiler.js'),
  },
  proxy: {
    name: 'proxy',
    description: 'capture-and-forward upstream-API proxy',
    default_port: 7403,
    entry: path.join(__dirname, 'services', 'proxy.js'),
  },
});

export const VALID_NAMES = new Set(Object.keys(SERVICES));

export function dir() {
  return process.env.KOLM_SERVICES_DIR || DEFAULT_DIR;
}

export function logDir() {
  return process.env.KOLM_SERVICE_LOG_DIR || DEFAULT_LOG_DIR;
}

export function ensureDirs() {
  for (const d of [dir(), logDir()]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

export function recordPath(name) {
  return path.join(dir(), `${name}.json`);
}

export function readRecord(name) {
  const p = recordPath(name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function writeRecord(rec) {
  ensureDirs();
  fs.writeFileSync(recordPath(rec.name), JSON.stringify(rec, null, 2), 'utf8');
}

export function deleteRecord(name) {
  const p = recordPath(name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// Is the process with this pid still alive? Cross-platform.
export function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours; still alive
  }
}

// Refresh status field on a record by reconciling with OS.
export function reconcile(rec) {
  if (!rec) return rec;
  if (rec.status === 'stopped') return rec;
  const alive = pidAlive(rec.pid);
  if (rec.status === 'running' && !alive) {
    return { ...rec, status: 'crashed' };
  }
  return rec;
}

export function listAll() {
  ensureDirs();
  const files = fs.readdirSync(dir()).filter((f) => f.endsWith('.json'));
  const recs = [];
  for (const f of files) {
    const name = f.replace(/\.json$/, '');
    const rec = readRecord(name);
    if (rec) recs.push(reconcile(rec));
  }
  return recs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// Spawn a service as a detached child process. Returns the record.
// `extra` is an object map {namespace: 'foo', redact: 'auto'} that translates
// to --namespace=foo --redact=auto flags appended to the child argv. This is
// how kolm proxy start --upstream=URL --namespace=NS reaches src/services/proxy.js.
export function start(name, { port, host = '127.0.0.1', env = {}, extraArgs = [], extra = {} } = {}) {
  if (!VALID_NAMES.has(name)) {
    throw new Error(`unknown service: ${name} (valid: ${[...VALID_NAMES].join(', ')})`);
  }
  const existing = readRecord(name);
  if (existing && existing.status === 'running' && pidAlive(existing.pid)) {
    throw new Error(`service ${name} already running (pid=${existing.pid}, port=${existing.port})`);
  }
  ensureDirs();
  const def = SERVICES[name];
  const p = Number(port) || def.default_port;
  const log_path = path.join(logDir(), `${name}.log`);
  const out = fs.openSync(log_path, 'a');
  const err = fs.openSync(log_path, 'a');
  const node = process.env.KOLM_NODE || process.execPath;
  const extraFlags = Object.entries(extra || {}).map(([k, v]) => `--${k}=${v}`);
  const args = [def.entry, `--port=${p}`, `--host=${host}`, ...extraFlags, ...extraArgs];
  const child = child_process.spawn(node, args, {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, ...env, KOLM_SERVICE_NAME: name, KOLM_SERVICE_PORT: String(p) },
    windowsHide: true,
  });
  child.unref();
  const rec = {
    name,
    pid: child.pid,
    port: p,
    host,
    started_at: new Date().toISOString(),
    log_path,
    status: 'running',
    version: 'w240',
  };
  writeRecord(rec);
  return rec;
}

// Send a stop signal. Returns the updated record.
export function stop(name, { signal = 'SIGTERM' } = {}) {
  const rec = readRecord(name);
  if (!rec) throw new Error(`service ${name} not registered`);
  if (!pidAlive(rec.pid)) {
    const next = { ...rec, status: 'stopped', stopped_at: new Date().toISOString() };
    writeRecord(next);
    return next;
  }
  try {
    process.kill(rec.pid, signal);
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
  const next = { ...rec, status: 'stopped', stopped_at: new Date().toISOString() };
  writeRecord(next);
  return next;
}

// Convenience for the test suite — synchronously kill + delete.
export function purge(name) {
  const rec = readRecord(name);
  if (rec && pidAlive(rec.pid)) {
    try { process.kill(rec.pid, 'SIGKILL'); } catch (_) {}
  }
  deleteRecord(name);
}

// Resolve the on-disk entry path for a service. Useful for tests that
// spawn the service themselves.
export function entryPath(name) {
  if (!VALID_NAMES.has(name)) return null;
  return SERVICES[name].entry;
}

// Used by service entry-points to parse their argv and find their port.
export function parseServiceArgv(argv = process.argv.slice(2)) {
  const out = { port: null, host: '127.0.0.1', extra: {} };
  for (const a of argv) {
    if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a.startsWith('--host=')) out.host = a.slice(7);
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out.extra[a.slice(2, eq)] = a.slice(eq + 1);
      else out.extra[a.slice(2)] = true;
    }
  }
  if (!out.port) {
    const envPort = Number(process.env.KOLM_SERVICE_PORT);
    if (envPort > 0) out.port = envPort;
  }
  return out;
}
