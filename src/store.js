// Persistent store facade.
//
// Development defaults to durable JSON files for zero-dependency local use.
// Production can opt into the SQLite backend with KOLM_STORE_DRIVER=sqlite,
// giving us transactional writes and a real database file without adding a
// runtime package dependency on modern Node builds.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ON_VERCEL = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const BUNDLED_DATA_DIR = path.resolve('data');
const DATA_DIR = process.env.KOLM_DATA_DIR
  ? path.resolve(process.env.KOLM_DATA_DIR)
  : (ON_VERCEL ? '/tmp/data' : BUNDLED_DATA_DIR);
const STORE_DRIVER = (process.env.KOLM_STORE_DRIVER || 'json').toLowerCase();
const SQLITE_PATH = process.env.KOLM_DB_PATH
  ? path.resolve(process.env.KOLM_DB_PATH)
  : path.join(DATA_DIR, 'kolm.sqlite');

if (!['json', 'sqlite'].includes(STORE_DRIVER)) {
  throw new Error(`Unsupported KOLM_STORE_DRIVER "${STORE_DRIVER}". Use "json" or "sqlite".`);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'cache'), { recursive: true });
if (STORE_DRIVER === 'sqlite') fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });

if (ON_VERCEL && fs.existsSync(BUNDLED_DATA_DIR) && BUNDLED_DATA_DIR !== DATA_DIR) {
  for (const f of fs.readdirSync(BUNDLED_DATA_DIR)) {
    const src = path.join(BUNDLED_DATA_DIR, f);
    const dst = path.join(DATA_DIR, f);
    if (fs.existsSync(dst)) continue;
    try {
      const stat = fs.statSync(src);
      if (stat.isFile()) fs.copyFileSync(src, dst);
    } catch {
      // Best-effort seed; safe to skip.
    }
  }
}

const jsonTables = new Map();
const sqliteTables = new Set();
let sqliteDb = null;

function tablePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function backupPath(name) {
  return tablePath(name) + '.bak';
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Directory fsync is best-effort and not uniformly supported on Windows.
  }
}

function writeFileDurably(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    fsyncDir(path.dirname(file));
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

function assertRowsArray(name, rows) {
  if (!Array.isArray(rows)) {
    throw new Error(`Store table "${name}" must be a JSON array`);
  }
}

function readRowsFile(name, file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertRowsArray(name, parsed);
  return parsed;
}

function quarantineCorruptFile(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.corrupt-${stamp}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.renameSync(file, dest);
    return dest;
  } catch {
    try {
      fs.copyFileSync(file, dest);
      return dest;
    } catch {
      return null;
    }
  }
}

function loadJsonTable(name) {
  if (jsonTables.has(name)) return jsonTables.get(name);
  const p = tablePath(name);
  let rows = [];
  if (fs.existsSync(p)) {
    try {
      rows = readRowsFile(name, p);
    } catch (primaryErr) {
      const corruptPrimary = quarantineCorruptFile(p);
      const bak = backupPath(name);
      if (fs.existsSync(bak)) {
        try {
          rows = readRowsFile(name, bak);
          writeFileDurably(p, JSON.stringify(rows, null, 2));
          console.error(`[store] recovered ${name}.json from backup after read failure`);
        } catch (backupErr) {
          const corruptBackup = quarantineCorruptFile(bak);
          throw new Error(
            `Cannot load store table "${name}": primary JSON is invalid` +
            `${corruptPrimary ? `; quarantined at ${corruptPrimary}` : ''}; ` +
            `backup is invalid${corruptBackup ? `; quarantined at ${corruptBackup}` : ''}: ${backupErr.message}`,
          );
        }
      } else {
        throw new Error(
          `Cannot load store table "${name}": primary JSON is invalid` +
          `${corruptPrimary ? `; quarantined at ${corruptPrimary}` : ''}: ${primaryErr.message}`,
        );
      }
    }
  }
  jsonTables.set(name, rows);
  return rows;
}

function flushJsonTable(name) {
  const rows = jsonTables.get(name) || [];
  assertRowsArray(name, rows);
  const p = tablePath(name);
  const json = JSON.stringify(rows, null, 2);
  writeFileDurably(p, json);
  try {
    writeFileDurably(backupPath(name), json);
  } catch (err) {
    console.error(`[store] warning: failed to refresh backup for ${name}.json: ${err.message}`);
  }
}

function getSqliteDb() {
  if (sqliteDb) return sqliteDb;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (err) {
    throw new Error(`KOLM_STORE_DRIVER=sqlite requires Node with node:sqlite support: ${err.message}`);
  }
  sqliteDb = new DatabaseSync(SQLITE_PATH);
  sqliteDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS kolm_store_rows (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_kolm_store_rows_table_row_id
      ON kolm_store_rows(table_name, row_id);
    CREATE TABLE IF NOT EXISTS kolm_store_meta (
      table_name TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL
    );
  `);
  return sqliteDb;
}

function sqliteTableImported(db, name) {
  return !!db.prepare('SELECT 1 AS ok FROM kolm_store_meta WHERE table_name = ?').get(name);
}

function markSqliteTableImported(db, name) {
  db.prepare('INSERT OR IGNORE INTO kolm_store_meta (table_name, imported_at) VALUES (?, ?)').run(name, new Date().toISOString());
}

function importJsonSeedIntoSqlite(db, name) {
  if (sqliteTableImported(db, name)) return;
  const p = tablePath(name);
  const rows = fs.existsSync(p) ? readRowsFile(name, p) : [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const insertStmt = db.prepare('INSERT INTO kolm_store_rows (table_name, json) VALUES (?, ?)');
    for (const row of rows) insertStmt.run(name, JSON.stringify(row));
    markSqliteTableImported(db, name);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function sqliteRows(name) {
  const db = getSqliteDb();
  sqliteTables.add(name);
  importJsonSeedIntoSqlite(db, name);
  return db
    .prepare('SELECT row_id AS rowid, json FROM kolm_store_rows WHERE table_name = ? ORDER BY row_id')
    .all(name)
    .map(row => ({ rowid: row.rowid, value: JSON.parse(row.json) }));
}

function sqliteAll(name) {
  return sqliteRows(name).map(row => row.value);
}

function sqliteInsert(table, row) {
  const db = getSqliteDb();
  sqliteTables.add(table);
  importJsonSeedIntoSqlite(db, table);
  db.prepare('INSERT INTO kolm_store_rows (table_name, json) VALUES (?, ?)').run(table, JSON.stringify(row));
  return row;
}

function sqliteUpdate(table, predicate, patch) {
  const db = getSqliteDb();
  const rows = sqliteRows(table);
  const updateStmt = db.prepare('UPDATE kolm_store_rows SET json = ?, updated_at = CURRENT_TIMESTAMP WHERE rowid = ?');
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      if (!predicate(row.value)) continue;
      Object.assign(row.value, patch);
      updateStmt.run(JSON.stringify(row.value), row.rowid);
      n++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

function sqliteRemove(table, predicate) {
  const db = getSqliteDb();
  const rows = sqliteRows(table);
  const deleteStmt = db.prepare('DELETE FROM kolm_store_rows WHERE rowid = ?');
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      if (!predicate(row.value)) continue;
      deleteStmt.run(row.rowid);
      n++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

function sqliteReset() {
  const db = getSqliteDb();
  const names = [...sqliteTables];
  const deleteStmt = db.prepare('DELETE FROM kolm_store_rows WHERE table_name = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const name of names) {
      deleteStmt.run(name);
      markSqliteTableImported(db, name);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function id(prefix = 'id') {
  const r = crypto.randomBytes(8).toString('hex');
  return `${prefix}_${Date.now().toString(36)}${r}`;
}

export function insert(table, row) {
  if (STORE_DRIVER === 'sqlite') return sqliteInsert(table, row);
  const rows = loadJsonTable(table);
  rows.push(row);
  flushJsonTable(table);
  return row;
}

export function update(table, predicate, patch) {
  if (STORE_DRIVER === 'sqlite') return sqliteUpdate(table, predicate, patch);
  const rows = loadJsonTable(table);
  let n = 0;
  for (const row of rows) {
    if (predicate(row)) { Object.assign(row, patch); n++; }
  }
  flushJsonTable(table);
  return n;
}

export function find(table, predicate = () => true) {
  return all(table).filter(predicate);
}

export function findOne(table, predicate) {
  return all(table).find(predicate) || null;
}

export function remove(table, predicate) {
  if (STORE_DRIVER === 'sqlite') return sqliteRemove(table, predicate);
  const rows = loadJsonTable(table);
  const kept = rows.filter(r => !predicate(r));
  jsonTables.set(table, kept);
  flushJsonTable(table);
  return rows.length - kept.length;
}

export function all(table) {
  if (STORE_DRIVER === 'sqlite') return sqliteAll(table);
  return loadJsonTable(table);
}

export function reset() {
  if (STORE_DRIVER === 'sqlite') {
    sqliteReset();
    return;
  }
  for (const t of jsonTables.keys()) {
    jsonTables.set(t, []);
    flushJsonTable(t);
  }
}

export function stats() {
  const out = {};
  for (const t of ['concepts', 'versions', 'syntheses', 'invocations', 'tenants']) {
    out[t] = all(t).length;
  }
  return out;
}

export function backendInfo() {
  return {
    driver: STORE_DRIVER,
    data_dir: DATA_DIR,
    db_path: STORE_DRIVER === 'sqlite' ? SQLITE_PATH : null,
  };
}

export function close() {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
  jsonTables.clear();
  sqliteTables.clear();
}
