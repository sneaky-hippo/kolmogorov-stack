// Vercel KV (Upstash Redis) durable-storage driver for capture rows.
//
// Used when KOLM_STORE_DRIVER=vercel_kv. All inserts are awaited; a failed
// write surfaces as a thrown error so the caller can return 503.
//
// Key layout:
//   kolm:row:<table>:<id>      → JSON row
//   kolm:idx:<table>           → list of row IDs (sorted by insertion order)
//   kolm:idx:<table>:<tenant>:<namespace> → list of row IDs for fast filter
//
// Requires:
//   - @vercel/kv package present
//   - KV_URL + KV_REST_API_URL + KV_REST_API_TOKEN env vars
//
// KV is suitable for capture rows up to ~10k per tenant/namespace; for larger
// corpora prefer vercel_postgres which supports proper SQL filters.

import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

let kvClient = null;

function loadClient() {
  if (kvClient) return kvClient;
  let mod;
  try {
    mod = require('@vercel/kv');
  } catch (err) {
    const e = new Error(
      'KOLM_STORE_DRIVER=vercel_kv requires the `@vercel/kv` package. ' +
      'Install with `npm install @vercel/kv` and ensure KV_REST_API_URL + KV_REST_API_TOKEN are set.'
    );
    e.cause = err;
    e.code = 'DRIVER_PACKAGE_MISSING';
    throw e;
  }
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    const e = new Error(
      'KOLM_STORE_DRIVER=vercel_kv requires KV_REST_API_URL and KV_REST_API_TOKEN env vars. ' +
      'Run `vercel env pull` after attaching a Vercel KV database.'
    );
    e.code = 'DRIVER_ENV_MISSING';
    throw e;
  }
  kvClient = mod.kv;
  return kvClient;
}

function validateTable(name) {
  if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]{0,63}$/i.test(name)) {
    throw new Error(`invalid table name: ${name}`);
  }
}

function rowKey(table, id) {
  return `kolm:row:${table}:${id}`;
}

function tableIdxKey(table) {
  return `kolm:idx:${table}`;
}

function tenantNsIdxKey(table, tenant, namespace) {
  return `kolm:idx:${table}:${tenant}:${namespace}`;
}

export async function insert(table, row) {
  validateTable(table);
  const kv = loadClient();
  const id = row && typeof row === 'object' && row.id
    ? String(row.id)
    : 'kv_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  if (!row.id) row.id = id;
  const tenant = row.tenant || '';
  const namespace = row.corpus_namespace || row.namespace || '';
  // Multi-key write: row data + global index + per-tenant/namespace index.
  // If any step throws, the caller treats the whole capture as failed.
  await kv.set(rowKey(table, id), row);
  await kv.rpush(tableIdxKey(table), id);
  if (tenant && namespace) {
    await kv.rpush(tenantNsIdxKey(table, tenant, namespace), id);
  }
  return row;
}

export async function all(table) {
  validateTable(table);
  const kv = loadClient();
  const ids = await kv.lrange(tableIdxKey(table), 0, -1);
  if (!ids || ids.length === 0) return [];
  const rows = [];
  for (const id of ids) {
    const row = await kv.get(rowKey(table, id));
    if (row) rows.push(row);
  }
  return rows;
}

export async function findByTenantNamespace(table, tenant, namespace, limit = 10000) {
  validateTable(table);
  const kv = loadClient();
  const ids = await kv.lrange(tenantNsIdxKey(table, tenant, namespace), 0, limit - 1);
  if (!ids || ids.length === 0) return [];
  const rows = [];
  for (const id of ids) {
    const row = await kv.get(rowKey(table, id));
    if (row) rows.push(row);
  }
  return rows;
}

export async function count(table, predicate) {
  validateTable(table);
  const kv = loadClient();
  if (predicate && predicate.tenant && predicate.namespace) {
    const n = await kv.llen(tenantNsIdxKey(table, predicate.tenant, predicate.namespace));
    return n || 0;
  }
  const n = await kv.llen(tableIdxKey(table));
  return n || 0;
}

export async function health() {
  try {
    const kv = loadClient();
    await kv.set('kolm:health-probe', String(Date.now()), { ex: 60 });
    return { driver: 'vercel_kv', ok: true };
  } catch (err) {
    return { driver: 'vercel_kv', ok: false, error: err.message, code: err.code };
  }
}

export const DRIVER_NAME = 'vercel_kv';
export const IS_DURABLE = true;
