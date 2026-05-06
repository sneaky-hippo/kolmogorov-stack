// JSON-backed persistent store. One directory, one file per table.
// Atomic writes via tmp+rename. Sufficient for single-node demos and small scale.
// Swap for Postgres/SQLite when N(concepts) > 100k.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// On Vercel/Lambda the deploy bundle is read-only; only /tmp is writable
// and is shared across warm invocations of the same function. We seed
// /tmp/data from the bundled ./data directory on cold start so seed
// rows (registry concepts, etc.) survive — writes are warm-only.
const ON_VERCEL = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const BUNDLED_DATA_DIR = path.resolve('data');
const DATA_DIR = ON_VERCEL ? '/tmp/data' : BUNDLED_DATA_DIR;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'cache'), { recursive: true });

if (ON_VERCEL && fs.existsSync(BUNDLED_DATA_DIR) && BUNDLED_DATA_DIR !== DATA_DIR) {
  for (const f of fs.readdirSync(BUNDLED_DATA_DIR)) {
    const src = path.join(BUNDLED_DATA_DIR, f);
    const dst = path.join(DATA_DIR, f);
    if (fs.existsSync(dst)) continue;
    try {
      const stat = fs.statSync(src);
      if (stat.isFile()) fs.copyFileSync(src, dst);
    } catch { /* best-effort seed; safe to skip */ }
  }
}

const tables = new Map();

function tablePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function loadTable(name) {
  if (tables.has(name)) return tables.get(name);
  const p = tablePath(name);
  let rows = [];
  if (fs.existsSync(p)) {
    try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { rows = []; }
  }
  tables.set(name, rows);
  return rows;
}

function flushTable(name) {
  const rows = tables.get(name) || [];
  const p = tablePath(name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, p);
}

export function id(prefix = 'id') {
  const r = crypto.randomBytes(8).toString('hex');
  return `${prefix}_${Date.now().toString(36)}${r}`;
}

export function insert(table, row) {
  const rows = loadTable(table);
  rows.push(row);
  flushTable(table);
  return row;
}

export function update(table, predicate, patch) {
  const rows = loadTable(table);
  let n = 0;
  for (const row of rows) {
    if (predicate(row)) { Object.assign(row, patch); n++; }
  }
  flushTable(table);
  return n;
}

export function find(table, predicate = () => true) {
  return loadTable(table).filter(predicate);
}

export function findOne(table, predicate) {
  return loadTable(table).find(predicate) || null;
}

export function remove(table, predicate) {
  const rows = loadTable(table);
  const kept = rows.filter(r => !predicate(r));
  tables.set(table, kept);
  flushTable(table);
  return rows.length - kept.length;
}

export function all(table) { return loadTable(table); }

export function reset() {
  for (const t of tables.keys()) {
    tables.set(t, []);
    flushTable(t);
  }
}

export function stats() {
  const out = {};
  for (const t of ['concepts', 'versions', 'syntheses', 'invocations', 'tenants']) {
    out[t] = loadTable(t).length;
  }
  return out;
}
