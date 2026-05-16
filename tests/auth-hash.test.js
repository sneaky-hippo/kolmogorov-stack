import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('tenant API keys are hashed at rest and legacy raw keys migrate on use', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-auth-hash-'));
  const savedDataDir = process.env.KOLM_DATA_DIR;
  const savedDriver = process.env.KOLM_STORE_DRIVER;
  process.env.KOLM_DATA_DIR = dataDir;
  // .env defaults KOLM_STORE_DRIVER=sqlite; this assertion reads tenants.json directly,
  // so force JSON to keep the file-shape contract that the test verifies.
  process.env.KOLM_STORE_DRIVER = 'json';

  t.after(() => {
    if (savedDataDir === undefined) delete process.env.KOLM_DATA_DIR;
    else process.env.KOLM_DATA_DIR = savedDataDir;
    if (savedDriver === undefined) delete process.env.KOLM_STORE_DRIVER;
    else process.env.KOLM_STORE_DRIVER = savedDriver;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const auth = await import(`../src/auth.js?auth-hash=${Date.now()}`);
  const store = await import(`../src/store.js`);

  const tenant = auth.provisionTenant('hash-test', { email: 'hash@example.com' });
  assert.match(tenant.api_key, /^ks_[0-9a-f]{32}$/);

  let rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'tenants.json'), 'utf8'));
  assert.equal(rows[0].api_key, undefined);
  assert.match(rows[0].api_key_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(auth.findTenantByApiKey(tenant.api_key).id, tenant.id);

  const rotated = auth.rotateTenantKey(tenant.id);
  assert.match(rotated, /^ks_[0-9a-f]{32}$/);
  assert.equal(auth.findTenantByApiKey(rotated).id, tenant.id);
  assert.equal(auth.findTenantByApiKey(tenant.api_key), null);

  // Legacy plain-key migration: tenants minted before api_key_hash existed are
  // migrated by auth.migrateAllPlainKeysOnce(), which runs at module load and
  // is also callable explicitly to migrate rows inserted after startup.
  const legacyKey = 'ks_' + 'a'.repeat(32);
  store.insert('tenants', {
    id: 'tenant_legacy',
    name: 'legacy',
    api_key: legacyKey,
    kind: 'user',
    plan: 'free',
    quota: 10,
    used: 0,
  });

  auth.migrateAllPlainKeysOnce();

  rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'tenants.json'), 'utf8'));
  const legacy = rows.find(row => row.id === 'tenant_legacy');
  assert.equal(legacy.api_key, undefined);
  assert.match(legacy.api_key_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(auth.findTenantByApiKey(legacyKey).id, 'tenant_legacy');
});
