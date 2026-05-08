import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function createDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-store-'));
  const saved = process.env.KOLM_DATA_DIR;
  process.env.KOLM_DATA_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.KOLM_DATA_DIR;
    else process.env.KOLM_DATA_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function corruptFiles(dir, prefix) {
  return fs.readdirSync(dir).filter(name => name.startsWith(prefix) && name.includes('.corrupt-'));
}

test('json store writes backups and recovers a corrupt primary table', async (t) => {
  const dir = createDataDir(t);
  const store = await import(`../src/store.js?store-backup=${Date.now()}`);

  store.insert('concepts', { id: 'first' });
  store.insert('concepts', { id: 'second' });

  const primary = path.join(dir, 'concepts.json');
  const backup = primary + '.bak';
  assert.deepEqual(JSON.parse(fs.readFileSync(primary, 'utf8')).map(row => row.id), ['first', 'second']);
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')).map(row => row.id), ['first', 'second']);

  fs.writeFileSync(primary, '{"partial"', 'utf8');
  const recoveredStore = await import(`../src/store.js?store-recover=${Date.now()}`);
  assert.deepEqual(recoveredStore.all('concepts').map(row => row.id), ['first', 'second']);
  assert.deepEqual(JSON.parse(fs.readFileSync(primary, 'utf8')).map(row => row.id), ['first', 'second']);
  assert.equal(corruptFiles(dir, 'concepts.json').length, 1);
});

test('json store fails closed when primary and backup are both invalid', async (t) => {
  const dir = createDataDir(t);
  fs.writeFileSync(path.join(dir, 'tenants.json'), '{"broken"', 'utf8');
  fs.writeFileSync(path.join(dir, 'tenants.json.bak'), '{"also-broken"', 'utf8');

  const store = await import(`../src/store.js?store-corrupt=${Date.now()}`);
  assert.throws(
    () => store.all('tenants'),
    /Cannot load store table "tenants": primary JSON is invalid/,
  );
  assert.equal(corruptFiles(dir, 'tenants.json').length, 2);
});

test('sqlite store imports JSON seed and persists updates transactionally', async (t) => {
  try {
    await import('node:sqlite');
  } catch {
    t.skip('node:sqlite is unavailable in this Node runtime');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-store-sqlite-'));
  const savedDataDir = process.env.KOLM_DATA_DIR;
  const savedDriver = process.env.KOLM_STORE_DRIVER;
  const savedDbPath = process.env.KOLM_DB_PATH;
  process.env.KOLM_DATA_DIR = dir;
  process.env.KOLM_STORE_DRIVER = 'sqlite';
  process.env.KOLM_DB_PATH = path.join(dir, 'store.sqlite');
  fs.writeFileSync(path.join(dir, 'concepts.json'), JSON.stringify([{ id: 'seed', n: 1 }]), 'utf8');

  let store;
  t.after(() => {
    try { store?.close(); } catch {}
    if (savedDriver === undefined) delete process.env.KOLM_STORE_DRIVER;
    else process.env.KOLM_STORE_DRIVER = savedDriver;
    if (savedDbPath === undefined) delete process.env.KOLM_DB_PATH;
    else process.env.KOLM_DB_PATH = savedDbPath;
    if (savedDataDir === undefined) delete process.env.KOLM_DATA_DIR;
    else process.env.KOLM_DATA_DIR = savedDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  store = await import(`../src/store.js?store-sqlite=${Date.now()}`);
  assert.equal(store.backendInfo().driver, 'sqlite');
  assert.deepEqual(store.all('concepts'), [{ id: 'seed', n: 1 }]);

  store.insert('concepts', { id: 'live', n: 2 });
  assert.equal(store.update('concepts', row => row.id === 'live', { n: 3 }), 1);
  assert.deepEqual(store.findOne('concepts', row => row.id === 'live'), { id: 'live', n: 3 });
  assert.equal(store.remove('concepts', row => row.id === 'seed'), 1);
  assert.deepEqual(store.all('concepts'), [{ id: 'live', n: 3 }]);
  assert.ok(fs.existsSync(process.env.KOLM_DB_PATH));
});
