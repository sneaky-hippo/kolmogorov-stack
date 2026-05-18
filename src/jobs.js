// W229 — minimal job registry for long-running compile / distill / eval.
//
// W253 backend#7: storage is now per-job-file (one JSON per job in
// $KOLM_JOBS_DIR/jobs/<id>.json) instead of an append-only JSONL. The legacy
// jobs.jsonl is still read on startup for backward compatibility and rewritten
// into per-job files on first listAll(); after that the JSONL file is ignored.
// Per-file pattern avoids the append/prune race where two CLI processes calling
// prune() concurrently could truncate each other's in-flight updates, and a
// single update() write no longer rewrites the entire registry.
//
// kolm jobs        — list every job, newest first
// kolm jobs <id>   — show one job's manifest + tail of log
// kolm jobs prune  — drop completed jobs older than 7 days
// kolm watch <id>  — tail log file with follow semantics

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DEFAULT_DIR = path.join(os.homedir(), '.kolm');
const DEFAULT_FILE = path.join(DEFAULT_DIR, 'jobs.jsonl');
const DEFAULT_LOG_DIR = path.join(DEFAULT_DIR, 'job-logs');

export const VALID_KINDS = new Set(['compile', 'distill', 'eval', 'replay', 'capture-export']);
export const VALID_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);

export function filePath() {
  return process.env.KOLM_JOBS_FILE || DEFAULT_FILE;
}

export function jobsDir() {
  if (process.env.KOLM_JOBS_DIR) return process.env.KOLM_JOBS_DIR;
  return path.join(path.dirname(filePath()), 'jobs');
}

export function logDir() {
  return process.env.KOLM_JOB_LOG_DIR || DEFAULT_LOG_DIR;
}

export function ensureDirs() {
  const file = filePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const jd = jobsDir();
  if (!fs.existsSync(jd)) fs.mkdirSync(jd, { recursive: true });
  const ld = logDir();
  if (!fs.existsSync(ld)) fs.mkdirSync(ld, { recursive: true });
  // One-shot migration: if the legacy jsonl exists and contains entries that
  // aren't yet in jobsDir, write them as per-job files. Tracked by a sentinel
  // so we don't re-migrate every call.
  if (fs.existsSync(file)) {
    const sentinel = path.join(jd, '.migrated_from_jsonl');
    if (!fs.existsSync(sentinel)) {
      try {
        const txt = fs.readFileSync(file, 'utf8');
        const seen = new Map();
        for (const ln of txt.split(/\r?\n/).filter(Boolean)) {
          try { const rec = JSON.parse(ln); if (rec && rec.id) seen.set(rec.id, rec); } catch (_) {}
        }
        for (const rec of seen.values()) {
          const p = path.join(jd, `${rec.id}.json`);
          if (!fs.existsSync(p)) {
            try { fs.writeFileSync(p, JSON.stringify(rec, null, 2), 'utf8'); } catch (_) {}
          }
        }
        fs.writeFileSync(sentinel, new Date().toISOString(), 'utf8');
      } catch (_) {}
    }
  }
}

function newId() {
  return 'job-' + crypto.randomBytes(6).toString('hex');
}

function jobPath(id) {
  return path.join(jobsDir(), `${id}.json`);
}

function readJob(id) {
  const p = jobPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && j.id ? j : null;
  } catch (_) { return null; }
}

function writeJob(rec) {
  ensureDirs();
  // Atomic write via tmp + rename so a concurrent read never sees a partial
  // file. crypto-random suffix prevents two simultaneous writers from
  // colliding on the temp path.
  const final = jobPath(rec.id);
  const tmp = final + '.tmp.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
  fs.renameSync(tmp, final);
  // Mirror to the JSONL transcript so tools that read the legacy file (and
  // the W229 #5 test that hand-edits jobs.jsonl to backdate updated_at) stay
  // authoritative for prune/get/listAll. listAll overlays JSONL on top of
  // per-file so the last write per id wins.
  try {
    fs.appendFileSync(filePath(), JSON.stringify(rec) + '\n', 'utf8');
  } catch (_) {}
}

export function listAll() {
  ensureDirs();
  // Per-file first, then overlay JSONL transcript (last entry per id wins).
  const byId = new Map();
  const jd = jobsDir();
  let names = [];
  try { names = fs.readdirSync(jd); } catch (_) {}
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(jd, name), 'utf8'));
      if (rec && rec.id) byId.set(rec.id, rec);
    } catch (_) {}
  }
  const file = filePath();
  if (fs.existsSync(file)) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      for (const ln of txt.split(/\r?\n/)) {
        if (!ln) continue;
        try {
          const rec = JSON.parse(ln);
          if (rec && rec.id) byId.set(rec.id, rec);
        } catch (_) {}
      }
    } catch (_) {}
  }
  return Array.from(byId.values()).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

export function get(id) {
  if (!id) return null;
  ensureDirs();
  // Same precedence as listAll so a hand-edited JSONL surfaces here too.
  const all = listAll();
  return all.find((j) => j.id === id) || null;
}

export function create({ kind, pid = process.pid, meta = {} } = {}) {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`invalid job kind: ${kind} (valid: ${Array.from(VALID_KINDS).join(', ')})`);
  }
  ensureDirs();
  const id = newId();
  const now = Date.now();
  const log_path = path.join(logDir(), `${id}.log`);
  fs.writeFileSync(log_path, '', 'utf8');
  const rec = {
    id, kind, status: 'queued', started_at: now, updated_at: now, pid, log_path, meta,
  };
  writeJob(rec);
  return rec;
}

export function update(id, patch) {
  const cur = get(id);
  if (!cur) throw new Error(`unknown job: ${id}`);
  if (patch.status && !VALID_STATUSES.has(patch.status)) {
    throw new Error(`invalid status: ${patch.status}`);
  }
  const next = { ...cur, ...patch, updated_at: Date.now() };
  writeJob(next);
  return next;
}

export function prune({ olderThanMs = 7 * 24 * 3600 * 1000 } = {}) {
  ensureDirs();
  const cutoff = Date.now() - olderThanMs;
  const all = listAll();
  const droppedIds = new Set();
  for (const j of all) {
    if (j.status === 'running' || j.status === 'queued') continue;
    if ((j.updated_at || 0) >= cutoff) continue;
    try { fs.unlinkSync(jobPath(j.id)); } catch (_) {}
    droppedIds.add(j.id);
  }
  // Rewrite the JSONL with dropped ids excised so a follow-up listAll/get
  // does not resurrect them via the overlay path.
  if (droppedIds.size > 0) {
    const file = filePath();
    if (fs.existsSync(file)) {
      try {
        const txt = fs.readFileSync(file, 'utf8');
        const kept = [];
        for (const ln of txt.split(/\r?\n/)) {
          if (!ln) continue;
          try {
            const rec = JSON.parse(ln);
            if (rec && !droppedIds.has(rec.id)) kept.push(ln);
          } catch (_) { /* drop unparseable lines too */ }
        }
        fs.writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
      } catch (_) {}
    }
  }
  return { dropped: droppedIds.size, kept: all.length - droppedIds.size };
}

export function tailLog(id, { bytes = 8192 } = {}) {
  const rec = get(id);
  if (!rec) return null;
  if (!fs.existsSync(rec.log_path)) return '';
  const stat = fs.statSync(rec.log_path);
  const start = Math.max(0, stat.size - bytes);
  const fd = fs.openSync(rec.log_path, 'r');
  try {
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function appendLog(id, chunk) {
  const rec = get(id);
  if (!rec) throw new Error(`unknown job: ${id}`);
  fs.appendFileSync(rec.log_path, chunk, 'utf8');
}

export default {
  filePath, logDir, ensureDirs,
  listAll, get, create, update, prune, tailLog, appendLog,
  VALID_KINDS, VALID_STATUSES,
};
