// Capture-row durable store router.
//
// W212 fix for the Pablo receipt: previously router.js:3959 was
// `try { insert('observations', obs); } catch (_) {}` — a silent swallow.
// If the DB write failed (or /tmp was already recycled on Vercel) the
// customer still received 200 + x-kolm-capture-id for a row that was
// never stored. This module replaces that path with:
//
//   - async insertCapture(row) → throws on failure; caller returns 503
//   - async listCaptures(tenant, namespace, limit) → reads from same backend
//   - countCaptures(tenant, namespace) → for threshold alerts
//   - isDurable() → honest answer about whether the next insert will persist
//   - driverName() → 'vercel_postgres' | 'vercel_kv' | 'sqlite' | 'json'
//
// Driver selection (precedence high → low):
//   1. KOLM_CAPTURE_DRIVER explicit override
//   2. KOLM_STORE_DRIVER if set to vercel_postgres / vercel_kv
//   3. Legacy synchronous store (./store.js) — durable when KOLM_DATA_DIR
//      points outside /tmp, ephemeral otherwise (e.g. default Vercel /tmp).

import * as store from './store.js';

const ON_VERCEL = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

let driverPromise = null;
let cachedDriver = null;
let cachedDriverName = null;

function pickDriverName() {
  const explicit = (process.env.KOLM_CAPTURE_DRIVER || '').toLowerCase();
  if (explicit) return explicit;
  const store = (process.env.KOLM_STORE_DRIVER || '').toLowerCase();
  if (store === 'vercel_postgres' || store === 'vercel_kv') return store;
  return 'legacy';
}

async function loadDriver() {
  if (cachedDriver !== null) return cachedDriver;
  if (driverPromise) return driverPromise;
  const name = pickDriverName();
  cachedDriverName = name;
  driverPromise = (async () => {
    if (name === 'vercel_postgres') {
      const mod = await import('./store-drivers/vercel-postgres.js');
      cachedDriver = mod;
      return mod;
    }
    if (name === 'vercel_kv') {
      const mod = await import('./store-drivers/vercel-kv.js');
      cachedDriver = mod;
      return mod;
    }
    cachedDriver = null; // legacy synchronous fallback
    return null;
  })();
  return driverPromise;
}

// Reset for tests; safe to call between unit tests that switch env vars.
export function _resetDriverCache() {
  driverPromise = null;
  cachedDriver = null;
  cachedDriverName = null;
}

export function driverName() {
  if (cachedDriverName) return cachedDriverName;
  return pickDriverName();
}

// `true` when the next insertCapture call will persist beyond a single
// lambda invocation. Honest answer — used by both the response header
// and the /captures dashboard hero copy.
export function isDurable() {
  const name = pickDriverName();
  if (name === 'vercel_postgres' || name === 'vercel_kv') return true;
  // Legacy synchronous store: durable when writes land on a real disk.
  if (!ON_VERCEL) return true;
  const info = store.backendInfo();
  const dir = String(info.data_dir || '');
  // /tmp is per-invocation ephemeral on Vercel/Lambda.
  if (dir.startsWith('/tmp') || dir === '/tmp') return false;
  return true;
}

// Throws on write failure so the caller returns 503. The Pablo W211
// silent-swallow pattern is structurally impossible from here.
export async function insertCapture(row) {
  if (!row || typeof row !== 'object') {
    throw new Error('insertCapture: row must be an object');
  }
  const driver = await loadDriver();
  if (driver) {
    await driver.insert('observations', row);
    return row;
  }
  // Legacy path: refuse to silently lose data when the deploy is on
  // ephemeral /tmp without a durable driver opt-in.
  if (!isDurable()) {
    const err = new Error(
      'capture_store_ephemeral: this deployment writes captures to /tmp ' +
      'which does not survive lambda recycling. Set KOLM_STORE_DRIVER=' +
      'vercel_postgres (recommended) or KOLM_DATA_DIR to a persistent path.'
    );
    err.code = 'CAPTURE_STORE_EPHEMERAL';
    throw err;
  }
  // Synchronous insert may throw (disk full, permission, JSON parse) —
  // we propagate instead of swallowing.
  store.insert('observations', row);
  return row;
}

export async function listCaptures(tenant, namespace, limit = 10000, opts = {}) {
  const includeDiscarded = !!opts.includeDiscarded;
  const driver = await loadDriver();
  if (driver && driver.findByTenantNamespace) {
    const rows = await driver.findByTenantNamespace('observations', tenant, namespace, limit);
    return includeDiscarded ? rows : rows.filter((o) => !o.discarded);
  }
  // Legacy: synchronous filter on in-memory rows.
  const rows = store.all('observations');
  return rows.filter((o) =>
    o.tenant === tenant
    && (o.corpus_namespace === namespace || (namespace === 'default' && !o.corpus_namespace))
    && (includeDiscarded || !o.discarded)
  ).slice(0, limit);
}

// All observations rows for a tenant (across every namespace). Used by
// /v1/account/export and the customer-visible audit feed so the same
// rows captured via the proxy show up in the bundle the customer downloads.
export async function allCapturesForTenant(tenant, limit = 50000) {
  const driver = await loadDriver();
  if (driver && driver.all) {
    const rows = await driver.all('observations');
    return rows.filter((o) => o && (
      o.tenant === tenant
      || o.tenant_id === tenant
    )).slice(0, limit);
  }
  const rows = store.all('observations');
  return rows.filter((o) => o && (
    o.tenant === tenant
    || o.tenant_id === tenant
  )).slice(0, limit);
}

export async function countCaptures(tenant, namespace) {
  const driver = await loadDriver();
  if (driver && driver.count) {
    return driver.count('observations', { tenant, namespace });
  }
  const rows = store.all('observations');
  return rows.filter((o) =>
    o.tenant === tenant
    && (o.corpus_namespace === namespace || (namespace === 'default' && !o.corpus_namespace))
  ).length;
}

export async function health() {
  const driver = await loadDriver();
  if (driver && driver.health) return driver.health();
  return {
    driver: cachedDriverName || pickDriverName(),
    ok: true,
    legacy: true,
    durable: isDurable(),
    data_dir: store.backendInfo().data_dir,
  };
}
