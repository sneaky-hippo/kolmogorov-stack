// Vercel Postgres durable-storage driver for capture rows.
//
// Used when KOLM_STORE_DRIVER=vercel_postgres (or KOLM_DURABLE_DRIVER=
// vercel_postgres). All inserts are awaited; a failed write surfaces as a
// thrown error so the caller can return 503 to the client instead of
// pretending the row landed (the Pablo W211 receipt fix).
//
// Schema (one shared table, JSONB body, lazy-created on first insert):
//
//   CREATE TABLE kolm_rows (
//     id           BIGSERIAL PRIMARY KEY,
//     table_name   TEXT NOT NULL,
//     row_id       TEXT,            -- application-level row.id when present
//     tenant       TEXT,            -- denormalized for fast list-by-tenant
//     namespace    TEXT,            -- denormalized for fast list-by-namespace
//     json         JSONB NOT NULL,
//     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   );
//   CREATE INDEX ON kolm_rows (table_name, id);
//   CREATE INDEX ON kolm_rows (table_name, tenant, namespace, id);
//
// Requires:
//   - @vercel/postgres package present (dynamic require; absent → actionable error)
//   - POSTGRES_URL env var (auto-set by Vercel Postgres integration)

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let sqlClient = null;
let tableEnsured = false;

function loadClient() {
  if (sqlClient) return sqlClient;
  let pg;
  try {
    pg = require('@vercel/postgres');
  } catch (err) {
    const e = new Error(
      'KOLM_STORE_DRIVER=vercel_postgres requires the `@vercel/postgres` package. ' +
      'Install with `npm install @vercel/postgres` and ensure POSTGRES_URL is set.'
    );
    e.cause = err;
    e.code = 'DRIVER_PACKAGE_MISSING';
    throw e;
  }
  if (!process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL && !process.env.POSTGRES_URL_NON_POOLING) {
    const e = new Error(
      'KOLM_STORE_DRIVER=vercel_postgres requires POSTGRES_URL env var. ' +
      'Run `vercel env pull` after attaching a Vercel Postgres database.'
    );
    e.code = 'DRIVER_ENV_MISSING';
    throw e;
  }
  sqlClient = pg.sql;
  return sqlClient;
}

async function ensureSchema() {
  if (tableEnsured) return;
  const sql = loadClient();
  await sql`
    CREATE TABLE IF NOT EXISTS kolm_rows (
      id BIGSERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      row_id TEXT,
      tenant TEXT,
      namespace TEXT,
      json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_kolm_rows_tbl_id ON kolm_rows (table_name, id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_kolm_rows_tbl_tenant_ns ON kolm_rows (table_name, tenant, namespace, id)`;
  tableEnsured = true;
}

function validateTable(name) {
  if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]{0,63}$/i.test(name)) {
    throw new Error(`invalid table name: ${name}`);
  }
}

export async function insert(table, row) {
  validateTable(table);
  await ensureSchema();
  const sql = loadClient();
  const rowId = row && typeof row === 'object' ? (row.id || null) : null;
  const tenant = row && typeof row === 'object' ? (row.tenant || null) : null;
  const ns = row && typeof row === 'object' ? (row.corpus_namespace || row.namespace || null) : null;
  const json = JSON.stringify(row);
  await sql`
    INSERT INTO kolm_rows (table_name, row_id, tenant, namespace, json)
    VALUES (${table}, ${rowId}, ${tenant}, ${ns}, ${json}::jsonb)
  `;
  return row;
}

export async function all(table) {
  validateTable(table);
  await ensureSchema();
  const sql = loadClient();
  const res = await sql`SELECT json FROM kolm_rows WHERE table_name = ${table} ORDER BY id`;
  return res.rows.map((r) => r.json);
}

export async function findByTenantNamespace(table, tenant, namespace, limit = 10000) {
  validateTable(table);
  await ensureSchema();
  const sql = loadClient();
  const res = await sql`
    SELECT json FROM kolm_rows
    WHERE table_name = ${table} AND tenant = ${tenant} AND namespace = ${namespace}
    ORDER BY id
    LIMIT ${limit}
  `;
  return res.rows.map((r) => r.json);
}

export async function count(table, predicate) {
  validateTable(table);
  await ensureSchema();
  const sql = loadClient();
  if (predicate && predicate.tenant && predicate.namespace) {
    const res = await sql`
      SELECT COUNT(*)::int AS n FROM kolm_rows
      WHERE table_name = ${table} AND tenant = ${predicate.tenant} AND namespace = ${predicate.namespace}
    `;
    return res.rows[0].n;
  }
  if (predicate && predicate.tenant) {
    const res = await sql`
      SELECT COUNT(*)::int AS n FROM kolm_rows
      WHERE table_name = ${table} AND tenant = ${predicate.tenant}
    `;
    return res.rows[0].n;
  }
  const res = await sql`SELECT COUNT(*)::int AS n FROM kolm_rows WHERE table_name = ${table}`;
  return res.rows[0].n;
}

export async function health() {
  try {
    const sql = loadClient();
    await sql`SELECT 1 AS ok`;
    return { driver: 'vercel_postgres', ok: true };
  } catch (err) {
    return { driver: 'vercel_postgres', ok: false, error: err.message, code: err.code };
  }
}

export const DRIVER_NAME = 'vercel_postgres';
export const IS_DURABLE = true;
