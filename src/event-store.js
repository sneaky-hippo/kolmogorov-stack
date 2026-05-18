// W369 — event-store: schema-validated wrapper over a local SQLite file.
//
// Storage layout: a single SQLite file at ~/.kolm/events/events.sqlite. We
// own the schema (one events table, JSON column) — separate from src/store.js
// which is the multi-purpose row store the server uses. We never want a
// rogue daemon-connector write to corrupt the rest of the kolm store.
//
// Driver selection:
//   - node:sqlite (built in to Node >= 22.5 / 20.x with --experimental-sqlite)
//   - falls back to a JSONL file (~/.kolm/events/events.jsonl) when sqlite
//     is unavailable. The fallback honors append-only semantics so partial
//     writes do not corrupt the whole log.
//
// Honors:
//   - KOLM_DATA_DIR (overrides ~/.kolm — used by tests with a temp HOME)
//   - KOLM_EVENT_STORE_PATH (point at any file; overrides KOLM_DATA_DIR)
//   - HOME (Linux/macOS), USERPROFILE (Windows)
//
// Public API: appendEvent, listEvents, getEvent, purgeEvents, streamEvents,
// exportEvents, countEvents, storeInfo, _resetForTests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { newEvent, validateEvent, canonicalize, EVENT_FIELDS } from './event-schema.js';

const require = createRequire(import.meta.url);

let _db = null;
let _driver = null; // 'sqlite' | 'jsonl'
let _eventsDir = null;
let _dbPath = null;
let _jsonlPath = null;
const _emitter = new EventEmitter();
_emitter.setMaxListeners(0);

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _ensureDirs() {
  if (_eventsDir && fs.existsSync(_eventsDir)) return;
  const base = process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
  _eventsDir = path.join(base, 'events');
  fs.mkdirSync(_eventsDir, { recursive: true });
  _dbPath = process.env.KOLM_EVENT_STORE_PATH
    ? path.resolve(process.env.KOLM_EVENT_STORE_PATH)
    : path.join(_eventsDir, 'events.sqlite');
  _jsonlPath = path.join(_eventsDir, 'events.jsonl');
}

function _openSqlite() {
  if (_db) return _db;
  _ensureDirs();
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    _driver = 'jsonl';
    return null;
  }
  try {
    _db = new DatabaseSync(_dbPath);
    _db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 30000;
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        created_at TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        status TEXT,
        sensitive_data_detected INTEGER NOT NULL DEFAULT 0,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        request_hash TEXT,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        workflow_id TEXT,
        media_kind TEXT,
        media_uri TEXT,
        media_hash TEXT,
        media_bytes INTEGER,
        media_mime TEXT,
        media_extraction_status TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ns_ts ON events(namespace, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_tenant_ts ON events(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_request_hash ON events(request_hash);
      CREATE INDEX IF NOT EXISTS idx_events_workflow ON events(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_events_provider_model ON events(provider, model);
      CREATE INDEX IF NOT EXISTS idx_events_media_kind ON events(media_kind);
      CREATE INDEX IF NOT EXISTS idx_events_media_hash ON events(media_hash);
    `);
    // W377 — additive ALTER TABLE for older DBs that pre-date the media_*
    // columns. SQLite has no ADD COLUMN IF NOT EXISTS, so we read pragma
    // table_info and only add what is missing. Idempotent + crash-safe.
    try {
      const existing = new Set(_db.prepare('PRAGMA table_info(events)').all().map(r => r.name));
      const toAdd = [
        ['media_kind', 'TEXT'],
        ['media_uri', 'TEXT'],
        ['media_hash', 'TEXT'],
        ['media_bytes', 'INTEGER'],
        ['media_mime', 'TEXT'],
        ['media_extraction_status', 'TEXT'],
      ];
      for (const [col, type] of toAdd) {
        if (!existing.has(col)) {
          try { _db.exec(`ALTER TABLE events ADD COLUMN ${col} ${type}`); } catch {}
        }
      }
    } catch {}
    _driver = 'sqlite';
    return _db;
  } catch (e) {
    _db = null;
    _driver = 'jsonl';
    return null;
  }
}

// Lazily pick the driver and return its name.
function _ensureDriver() {
  if (_driver) return _driver;
  _openSqlite();
  if (!_driver) _driver = 'jsonl';
  return _driver;
}

// Reset module state — only for tests that switch HOME / KOLM_DATA_DIR.
export function _resetForTests() {
  try { if (_db) _db.close(); } catch {}
  _db = null;
  _driver = null;
  _eventsDir = null;
  _dbPath = null;
  _jsonlPath = null;
  _emitter.removeAllListeners();
}

export function storeInfo() {
  _ensureDriver();
  return {
    driver: _driver,
    events_dir: _eventsDir,
    db_path: _driver === 'sqlite' ? _dbPath : null,
    jsonl_path: _driver === 'jsonl' ? _jsonlPath : null,
  };
}

// appendEvent(partial): validate, canonicalize, write. Returns the persisted
// event. Throws on validation failure (with `.code = 'EVENT_INVALID'`) so the
// caller knows the row is rejected, not silently swallowed.
export async function appendEvent(partial = {}) {
  const ev = canonicalize(newEvent(partial));
  const v = validateEvent(ev);
  if (!v.ok) {
    const err = new Error('event_invalid: missing=' + v.missing.join(',') + ' errors=' + v.errors.join(','));
    err.code = 'EVENT_INVALID';
    err.missing = v.missing;
    err.errors = v.errors;
    throw err;
  }
  const drv = _ensureDriver();
  if (drv === 'sqlite') {
    const db = _openSqlite();
    db.prepare(
      `INSERT OR REPLACE INTO events (
        event_id, tenant_id, namespace, created_at, provider, model, status,
        sensitive_data_detected, cache_hit, request_hash, estimated_cost_usd,
        latency_ms, prompt_tokens, completion_tokens, workflow_id,
        media_kind, media_uri, media_hash, media_bytes, media_mime, media_extraction_status,
        json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      ev.event_id, ev.tenant_id, ev.namespace, ev.created_at,
      ev.provider, ev.model, ev.status,
      ev.sensitive_data_detected ? 1 : 0, ev.cache_hit ? 1 : 0,
      ev.request_hash, ev.estimated_cost_usd, ev.latency_ms,
      ev.prompt_tokens, ev.completion_tokens, ev.workflow_id,
      ev.media_kind, ev.media_uri, ev.media_hash, ev.media_bytes, ev.media_mime, ev.media_extraction_status,
      JSON.stringify(ev),
    );
  } else {
    _ensureDirs();
    fs.appendFileSync(_jsonlPath, JSON.stringify(ev) + '\n', 'utf8');
  }
  _emitter.emit('event', ev);
  return ev;
}

function _jsonlAll() {
  _ensureDirs();
  if (!fs.existsSync(_jsonlPath)) return [];
  const text = fs.readFileSync(_jsonlPath, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function _matchEvent(ev, q) {
  if (!ev) return false;
  if (q.namespace && ev.namespace !== q.namespace) return false;
  if (q.tenant_id && ev.tenant_id !== q.tenant_id) return false;
  if (q.provider && ev.provider !== q.provider) return false;
  if (q.model && ev.model !== q.model) return false;
  if (q.workflow_id && ev.workflow_id !== q.workflow_id) return false;
  if (q.media_kind && ev.media_kind !== q.media_kind) return false;
  if (q.since && new Date(ev.created_at).getTime() < new Date(q.since).getTime()) return false;
  if (q.until && new Date(ev.created_at).getTime() > new Date(q.until).getTime()) return false;
  if (q.filter && typeof q.filter === 'function' && !q.filter(ev)) return false;
  return true;
}

// listEvents({namespace, tenant_id, provider, model, workflow_id, since, until, limit, filter}).
// Returns an array of events (newest first by default). limit defaults to
// 1000; pass 0 for unlimited (sparingly).
export async function listEvents(query = {}) {
  const drv = _ensureDriver();
  const limit = query.limit == null ? 1000 : Math.max(0, Math.trunc(Number(query.limit)));
  const order = (query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  if (drv === 'sqlite') {
    const db = _openSqlite();
    const where = [];
    const args = [];
    if (query.namespace) { where.push('namespace = ?'); args.push(query.namespace); }
    if (query.tenant_id) { where.push('tenant_id = ?'); args.push(query.tenant_id); }
    if (query.provider) { where.push('provider = ?'); args.push(query.provider); }
    if (query.model) { where.push('model = ?'); args.push(query.model); }
    if (query.workflow_id) { where.push('workflow_id = ?'); args.push(query.workflow_id); }
    if (query.media_kind) { where.push('media_kind = ?'); args.push(query.media_kind); }
    if (query.since) { where.push('created_at >= ?'); args.push(new Date(query.since).toISOString()); }
    if (query.until) { where.push('created_at <= ?'); args.push(new Date(query.until).toISOString()); }
    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    const limSql = limit > 0 ? ('LIMIT ' + limit) : '';
    const sql = `SELECT json FROM events ${whereSql} ORDER BY created_at ${order} ${limSql}`;
    const rows = db.prepare(sql).all(...args).map(r => {
      try { return JSON.parse(r.json); } catch { return null; }
    }).filter(Boolean);
    if (query.filter) return rows.filter(query.filter);
    return rows;
  }
  let rows = _jsonlAll().filter(ev => _matchEvent(ev, query));
  rows.sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return order === 'ASC' ? (ta - tb) : (tb - ta);
  });
  if (limit > 0) rows = rows.slice(0, limit);
  return rows;
}

export async function getEvent(eventId) {
  if (!eventId) return null;
  const drv = _ensureDriver();
  if (drv === 'sqlite') {
    const db = _openSqlite();
    const r = db.prepare('SELECT json FROM events WHERE event_id = ?').get(eventId);
    if (!r) return null;
    try { return JSON.parse(r.json); } catch { return null; }
  }
  return _jsonlAll().find(ev => ev.event_id === eventId) || null;
}

// purgeEvents({before, namespace, dryRun}). Returns {deleted, would_delete}.
export async function purgeEvents(opts = {}) {
  const drv = _ensureDriver();
  const dryRun = !!opts.dryRun;
  const before = opts.before ? new Date(opts.before).toISOString() : null;
  if (drv === 'sqlite') {
    const db = _openSqlite();
    const where = [];
    const args = [];
    if (before) { where.push('created_at < ?'); args.push(before); }
    if (opts.namespace) { where.push('namespace = ?'); args.push(opts.namespace); }
    if (!where.length) return { deleted: 0, would_delete: 0 };
    const whereSql = 'WHERE ' + where.join(' AND ');
    const count = db.prepare(`SELECT COUNT(*) AS n FROM events ${whereSql}`).get(...args).n || 0;
    if (dryRun) return { deleted: 0, would_delete: count };
    db.prepare(`DELETE FROM events ${whereSql}`).run(...args);
    return { deleted: count, would_delete: count };
  }
  const all = _jsonlAll();
  const keep = [];
  let dropped = 0;
  for (const ev of all) {
    let drop = true;
    if (before && new Date(ev.created_at).getTime() >= new Date(before).getTime()) drop = false;
    if (opts.namespace && ev.namespace !== opts.namespace) drop = false;
    if (drop && (before || opts.namespace)) { dropped++; continue; }
    keep.push(ev);
  }
  if (dryRun) return { deleted: 0, would_delete: dropped };
  fs.writeFileSync(_jsonlPath, keep.map(e => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
  return { deleted: dropped, would_delete: dropped };
}

// streamEvents(cb): subscribe to live appendEvent emissions. Returns an
// unsubscribe function. The caller decides on namespace/tenant filtering.
export function streamEvents(cb) {
  if (typeof cb !== 'function') throw new Error('streamEvents requires a callback');
  _emitter.on('event', cb);
  return () => _emitter.off('event', cb);
}

// exportEvents({format, namespace, since, until, limit}).
//   format = 'jsonl' (default) | 'json' | 'csv'.
// Returns a string buffer.
export async function exportEvents(opts = {}) {
  const fmt = (opts.format || 'jsonl').toLowerCase();
  const rows = await listEvents({
    namespace: opts.namespace,
    since: opts.since,
    until: opts.until,
    limit: opts.limit == null ? 0 : opts.limit,
    order: 'asc',
  });
  if (fmt === 'jsonl') return rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  if (fmt === 'json') return JSON.stringify(rows, null, 2);
  if (fmt === 'csv') {
    const cols = EVENT_FIELDS;
    const head = cols.join(',');
    const lines = rows.map(r => cols.map(c => {
      const v = r[c];
      if (v == null) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }).join(','));
    return [head, ...lines].join('\n') + '\n';
  }
  throw new Error('unsupported export format: ' + fmt);
}

export async function countEvents(query = {}) {
  const drv = _ensureDriver();
  if (drv === 'sqlite') {
    const db = _openSqlite();
    const where = [];
    const args = [];
    if (query.namespace) { where.push('namespace = ?'); args.push(query.namespace); }
    if (query.tenant_id) { where.push('tenant_id = ?'); args.push(query.tenant_id); }
    if (query.media_kind) { where.push('media_kind = ?'); args.push(query.media_kind); }
    if (query.since) { where.push('created_at >= ?'); args.push(new Date(query.since).toISOString()); }
    if (query.until) { where.push('created_at <= ?'); args.push(new Date(query.until).toISOString()); }
    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    return db.prepare(`SELECT COUNT(*) AS n FROM events ${whereSql}`).get(...args).n || 0;
  }
  return (_jsonlAll().filter(ev => _matchEvent(ev, query))).length;
}

// W377 — filterByMediaKind({media_kind, namespace?, tenant_id?, limit?}).
// Convenience wrapper for the multimodal loaders that only care about, say,
// every 'pdf' or every 'audio' row. Forwards everything else to listEvents so
// you still get namespace + tenant + time-window filtering for free.
export async function filterByMediaKind(query = {}) {
  if (!query || !query.media_kind) {
    throw new Error('filterByMediaKind requires {media_kind}');
  }
  return listEvents(query);
}
