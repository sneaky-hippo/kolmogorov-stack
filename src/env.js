import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const DEV_RECEIPT_SECRET = 'ks_receipt_dev_secret_change_in_prod';

// In production-like hosts (Vercel/Railway/Lambda), KOLM_ARTIFACT_DIR and
// KOLM_DATA_DIR may be unset. /ready used to fail-closed 503 in that case.
// Instead, resolve sane writable defaults under os.tmpdir() and create them
// on demand so /ready is green out of the box. Operators can still override
// with explicit env vars when they wire durable storage.
function resolveDefaultDir(envKey, suffix) {
  const explicit = process.env[envKey];
  if (explicit && explicit.trim()) return explicit.trim();
  return path.join(os.tmpdir(), suffix);
}
function ensureDirSync(dir) {
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
export function resolveArtifactDir() {
  const dir = resolveDefaultDir('KOLM_ARTIFACT_DIR', 'kolm-artifacts');
  ensureDirSync(dir);
  return dir;
}
export function resolveDataDir() {
  const dir = resolveDefaultDir('KOLM_DATA_DIR', 'kolm-data');
  ensureDirSync(dir);
  return dir;
}

export function isProductionRuntime() {
  return process.env.NODE_ENV === 'production' ||
    !!process.env.RAILWAY_ENVIRONMENT ||
    !!process.env.VERCEL ||
    !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

export function effectiveReceiptSecret({ includeLegacyArtifactSecret = false } = {}) {
  const secret = process.env.RECIPE_RECEIPT_SECRET ||
    (includeLegacyArtifactSecret ? process.env.KOLM_ARTIFACT_SECRET : '');
  if (secret) {
    if (isProductionRuntime() && !receiptSecretLooksProductionSafe(secret)) return null;
    return secret;
  }
  return isProductionRuntime() ? null : DEV_RECEIPT_SECRET;
}

// Per-tenant receipt secret. If the tenant carries its own receipt_secret +
// receipt_key_id, return those. Otherwise fall back to the global secret with
// the implicit key_id "global". Callers should persist the key_id alongside
// every signed row so future verification can dispatch on it after a tenant
// rotates their key.
//
// Schema (tenants table): tenant.receipt_secret (string), tenant.receipt_key_id
// (string, e.g. "tk_<tenant>_<short-hex>"), tenant.receipt_rotated_at (iso).
// Rotation appends to tenant.previous_receipt_secrets[] so receipts signed
// with the previous key still verify until the operator chooses to drop them.
export function effectiveReceiptSecretForTenant(tenant, { includeLegacyArtifactSecret = false } = {}) {
  if (tenant && typeof tenant.receipt_secret === 'string' && tenant.receipt_secret.length >= 32) {
    return { secret: tenant.receipt_secret, key_id: tenant.receipt_key_id || `tk_${tenant.id || 'unknown'}_1` };
  }
  const globalSecret = effectiveReceiptSecret({ includeLegacyArtifactSecret });
  return { secret: globalSecret, key_id: 'global' };
}

// All known verification keys for a tenant — current + previous (for rotation).
// Verifiers walk this list and accept the first match.
export function tenantReceiptVerificationKeys(tenant) {
  const out = [];
  if (tenant && typeof tenant.receipt_secret === 'string' && tenant.receipt_secret.length >= 32) {
    out.push({ secret: tenant.receipt_secret, key_id: tenant.receipt_key_id || `tk_${tenant.id || 'unknown'}_1` });
  }
  if (tenant && Array.isArray(tenant.previous_receipt_secrets)) {
    for (const prev of tenant.previous_receipt_secrets) {
      if (prev && typeof prev.secret === 'string' && prev.secret.length >= 32) {
        out.push({ secret: prev.secret, key_id: prev.key_id || 'previous' });
      }
    }
  }
  const globalSecret = effectiveReceiptSecret({ includeLegacyArtifactSecret: true });
  if (globalSecret) out.push({ secret: globalSecret, key_id: 'global' });
  return out;
}

export function runtimeReadiness() {
  const productionLike = isProductionRuntime();
  const receiptSecret = process.env.RECIPE_RECEIPT_SECRET || '';
  const receiptSecretStrong = receiptSecretLooksProductionSafe(receiptSecret);
  const receiptSecretOk = !productionLike ||
    (!!receiptSecret && receiptSecretStrong);
  // Auto-bootstrap writable defaults so /ready does not fail-closed in a
  // production host where the operator hasn't pre-set KOLM_*_DIR. Explicit
  // env vars still win; this just removes the cold-start 503.
  const dataDir = resolveDataDir();
  const artifactDir = resolveArtifactDir();
  const storeDriver = configuredStoreDriver();
  const dataDirOk = !productionLike || directoryWritable(dataDir);
  const artifactDirOk = !productionLike || directoryWritable(artifactDir);
  const sqliteDir = path.dirname(path.resolve(process.env.KOLM_DB_PATH || path.join(dataDir || '.', 'kolm.sqlite')));
  const sqliteAvailable = storeDriver !== 'sqlite' || nodeSqliteAvailable();
  const sqlitePathOk = storeDriver !== 'sqlite' || directoryWritable(sqliteDir);
  const storeDriverOk = !productionLike ||
    (storeDriver === 'sqlite' && sqliteAvailable && sqlitePathOk) ||
    process.env.KOLM_ALLOW_JSON_STORE === 'true';

  const checks = [
    {
      name: 'receipt_secret',
      ok: receiptSecretOk,
      required: productionLike,
      public: 'receipt signing secret configured',
      hint: productionLike
        ? 'set RECIPE_RECEIPT_SECRET to a stable production-only value of at least 32 characters'
        : 'development uses an in-process fallback receipt secret',
    },
    {
      name: 'admin_key',
      ok: !productionLike || !!process.env.ADMIN_KEY,
      required: false,
      public: 'admin key configured',
      hint: productionLike
        ? 'set ADMIN_KEY if staff-only admin endpoints are needed'
        : 'development may use the fallback admin key',
    },
    {
      name: 'model_provider',
      ok: !!process.env.ANTHROPIC_API_KEY,
      required: false,
      public: 'frontier model provider configured',
      hint: 'set ANTHROPIC_API_KEY for verified inference and cloud teacher calls',
    },
    {
      name: 'store_driver',
      ok: storeDriverOk,
      required: productionLike,
      public: 'database-backed store configured',
      hint: productionLike
        ? 'set KOLM_STORE_DRIVER=sqlite and KOLM_DB_PATH, or explicitly set KOLM_ALLOW_JSON_STORE=true for a temporary single-node deployment'
        : `using ${storeDriver} store driver`,
    },
    {
      name: 'data_dir',
      ok: dataDirOk,
      required: productionLike,
      public: 'data directory writable',
      hint: productionLike
        ? (process.env.KOLM_DATA_DIR ? `KOLM_DATA_DIR=${process.env.KOLM_DATA_DIR}` : `auto-bootstrapped under ${dataDir} (override with KOLM_DATA_DIR for durable storage)`)
        : (process.env.KOLM_DATA_DIR ? 'KOLM_DATA_DIR is set' : 'using the default ./data directory'),
    },
    {
      name: 'artifact_dir',
      ok: artifactDirOk,
      required: productionLike,
      public: 'artifact directory writable',
      hint: productionLike
        ? (process.env.KOLM_ARTIFACT_DIR ? `KOLM_ARTIFACT_DIR=${process.env.KOLM_ARTIFACT_DIR}` : `auto-bootstrapped under ${artifactDir} (override with KOLM_ARTIFACT_DIR for durable storage)`)
        : (process.env.KOLM_ARTIFACT_DIR ? 'KOLM_ARTIFACT_DIR is set' : 'using temporary artifact output by default'),
    },
  ];

  const blocking = checks.filter(check => check.required && !check.ok);
  return {
    status: blocking.length ? 'not_ready' : 'ready',
    production_like: productionLike,
    checks,
  };
}

function configuredStoreDriver() {
  if (process.env.KOLM_STORE_DRIVER) {
    return process.env.KOLM_STORE_DRIVER.toLowerCase();
  }
  // Mirror src/store.js auto-detection: in production-like environments
  // SQLite is the default whenever node:sqlite is available.
  if (isProductionRuntime() && nodeSqliteAvailable()) return 'sqlite';
  return 'json';
}

function nodeSqliteAvailable() {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

function directoryWritable(dir) {
  if (!dir) return false;
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return false;
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function receiptSecretLooksProductionSafe(secret) {
  return typeof secret === 'string' &&
    secret.length >= 32 &&
    secret !== DEV_RECEIPT_SECRET &&
    !/^ks_receipt_(live|test|dev|change)/i.test(secret);
}
