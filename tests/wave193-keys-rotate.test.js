// Wave 193: `kolm keys rotate` flow lock-in.
//
// Locks in the M+3 deliverable from the Wave 144 plan: a dedicated
// `kolm keys` verb that exposes the Ed25519 signing key rotation lifecycle
// (NIST SP 800-57 + SOC 2 CC6.1 + HIPAA 45 CFR 164.312(d) compliant). The
// previous /security wave (W189) shipped the documentation surface and
// amber-pilled the rotate verb as "wave 193 roadmap"; this wave wires the
// verb and flips the pill.
//
// Tests cover both the backend (src/keys.js) and the CLI substrate
// (cli/kolm.js dispatch + HELP + COMPLETION_VERBS) so a future wave that
// silently drops the verb or changes the rotation manifest shape fails
// loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  rotateKey,
  listKeys,
  exportKmsIntent,
  activeFingerprint,
  KMS_TARGETS,
  DEFAULT_OVERLAP_DAYS,
  KMS_API_STATUS_NOT_WIRED,
  KEY_STATUSES,
} from '../src/keys.js';

const HERE     = path.dirname(fileURLToPath(import.meta.url));
const REPO     = path.resolve(HERE, '..');
const CLI      = path.join(REPO, 'cli', 'kolm.js');
const SW       = path.join(REPO, 'public', 'sw.js');
const SECURITY = path.join(REPO, 'public', 'security.html');

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-keys-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
}

function runCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    timeout: 15_000,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', KOLM_AIRGAP: '1', ...extraEnv },
  });
}

test('1. rotateKey() returns a manifest with all 5 required fields', () => {
  const dir = tmpStore();
  try {
    const m = rotateKey({ kmsTarget: 'local', overlapDays: 30, storeDir: dir });
    assert.ok('old_key_fingerprint' in m, 'manifest must have old_key_fingerprint');
    assert.ok('new_key_fingerprint' in m, 'manifest must have new_key_fingerprint');
    assert.ok('rotated_at' in m,          'manifest must have rotated_at');
    assert.ok('overlap_until' in m,       'manifest must have overlap_until');
    assert.ok('kms_target' in m,          'manifest must have kms_target');
    assert.equal(typeof m.new_key_fingerprint, 'string');
    assert.ok(m.new_key_fingerprint.length >= 16, 'new fingerprint must be a real hash');
  } finally { cleanup(dir); }
});

test('2. rotateKey() supports all 4 hosted KMS targets + local', () => {
  for (const target of ['aws-kms', 'gcp-kms', 'azure-keyvault', 'vault', 'local']) {
    const dir = tmpStore();
    try {
      const m = rotateKey({ kmsTarget: target, overlapDays: 30, storeDir: dir });
      assert.equal(m.kms_target, target, `rotateKey must echo back kms_target=${target}`);
      assert.ok(KMS_TARGETS.includes(m.kms_target), `manifest kms_target must be in KMS_TARGETS`);
    } finally { cleanup(dir); }
  }
});

test('3. rotateKey() rejects unknown kms targets', () => {
  const dir = tmpStore();
  try {
    assert.throws(() => rotateKey({ kmsTarget: 'aws-fake', storeDir: dir }), /kmsTarget must be one of/);
  } finally { cleanup(dir); }
});

test('4. hosted KMS targets surface api_status=not_yet_wired in wrap_intent', () => {
  for (const target of ['aws-kms', 'gcp-kms', 'azure-keyvault', 'vault']) {
    const dir = tmpStore();
    try {
      const m = rotateKey({ kmsTarget: target, storeDir: dir });
      assert.equal(m.wrap_intent.api_status, KMS_API_STATUS_NOT_WIRED,
        `${target} wrap_intent.api_status must be ${KMS_API_STATUS_NOT_WIRED} (kolm emits intent, customer applies)`);
    } finally { cleanup(dir); }
  }
});

test('5. local KMS target writes new key to disk and reports applied status', () => {
  const dir = tmpStore();
  try {
    const m = rotateKey({ kmsTarget: 'local', storeDir: dir });
    assert.equal(m.wrap_intent.api_status, 'applied',
      'local target writes to disk immediately, status=applied');
    assert.ok(m.wrap_intent.new_key_path, 'local target must report new_key_path');
    assert.ok(fs.existsSync(m.wrap_intent.new_key_path),
      'local target must actually write the PEM to disk');
    const pem = fs.readFileSync(m.wrap_intent.new_key_path, 'utf8');
    assert.match(pem, /-----BEGIN PRIVATE KEY-----/, 'on-disk file must be a PEM private key');
  } finally { cleanup(dir); }
});

test('6. DEFAULT_OVERLAP_DAYS is 30 (NIST SP 800-57 high-assurance recommendation)', () => {
  assert.equal(DEFAULT_OVERLAP_DAYS, 30, 'default overlap window must be 30 days');
});

test('7. rotateKey() defaults to 30-day overlap when overlapDays omitted', () => {
  const dir = tmpStore();
  try {
    const m = rotateKey({ kmsTarget: 'local', storeDir: dir });
    assert.equal(m.overlap_days, 30, 'default overlap_days must be 30');
    const rotated = new Date(m.rotated_at).getTime();
    const overlap = new Date(m.overlap_until).getTime();
    const days = Math.round((overlap - rotated) / (24 * 60 * 60 * 1000));
    assert.equal(days, 30, `overlap_until must be 30 days after rotated_at (got ${days})`);
  } finally { cleanup(dir); }
});

test('8. listKeys() returns array; entries carry {key_fingerprint, status, created_at}', () => {
  const dir = tmpStore();
  try {
    assert.deepEqual(listKeys({ path: dir }), [], 'empty store returns empty array');
    rotateKey({ kmsTarget: 'local', storeDir: dir });
    const keys = listKeys({ path: dir });
    assert.equal(keys.length, 1, 'one rotation yields one key entry');
    assert.ok(keys[0].key_fingerprint, 'entry must carry key_fingerprint');
    assert.ok(keys[0].created_at,      'entry must carry created_at');
    assert.ok(KEY_STATUSES.includes(keys[0].status), 'status must be one of KEY_STATUSES');
    assert.equal(keys[0].status, 'active', 'first key after rotation is active');
  } finally { cleanup(dir); }
});

test('9. Second rotation marks prior key rotated and adds new active key', () => {
  const dir = tmpStore();
  try {
    const m1 = rotateKey({ kmsTarget: 'local', storeDir: dir });
    const m2 = rotateKey({ kmsTarget: 'local', storeDir: dir, oldKeyId: m1.new_key_fingerprint });
    const keys = listKeys({ path: dir });
    assert.equal(keys.length, 2, 'after two rotations the state must have 2 entries');
    const active  = keys.find((k) => k.status === 'active');
    const rotated = keys.find((k) => k.status === 'rotated');
    assert.ok(active && rotated, 'must have one active + one rotated key');
    assert.equal(active.key_fingerprint, m2.new_key_fingerprint);
    assert.equal(rotated.key_fingerprint, m1.new_key_fingerprint);
    assert.ok(rotated.rotated_at,    'rotated entry must carry rotated_at');
    assert.ok(rotated.overlap_until, 'rotated entry must carry overlap_until');
  } finally { cleanup(dir); }
});

test('10. exportKmsIntent() emits not_yet_wired for hosted KMS, applied for local', () => {
  for (const target of ['aws-kms', 'gcp-kms', 'azure-keyvault', 'vault']) {
    const intent = exportKmsIntent({ kmsTarget: target });
    assert.equal(intent.api_status, KMS_API_STATUS_NOT_WIRED);
    assert.equal(intent.kms_target, target);
    assert.ok(intent.import_format, 'must name import_format');
    assert.ok(intent.native_api,    'must name native_api');
  }
  const local = exportKmsIntent({ kmsTarget: 'local' });
  assert.equal(local.api_status, 'applied');
});

test('11. activeFingerprint() returns null on empty store, fingerprint after rotation', () => {
  const dir = tmpStore();
  try {
    assert.equal(activeFingerprint({ storeDir: dir }), null);
    const m = rotateKey({ kmsTarget: 'local', storeDir: dir });
    assert.equal(activeFingerprint({ storeDir: dir }), m.new_key_fingerprint);
  } finally { cleanup(dir); }
});

test('12. CLI `kolm keys --help` exits 0 and names all 4 subcommands', () => {
  const r = runCli(['keys', '--help']);
  assert.equal(r.status, 0, `kolm keys --help exited ${r.status}: ${r.stderr?.slice(0, 200)}`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /kolm keys/, 'help text must reference the verb');
  for (const sub of ['list', 'rotate', 'fingerprint', 'export']) {
    assert.ok(out.includes(sub), `help must name subcommand "${sub}"`);
  }
});

test('13. CLI `kolm keys list` works against an empty tmp store', () => {
  const dir = tmpStore();
  try {
    const r = runCli(['keys', 'list'], { KOLM_ED25519_KEY_STORE: dir });
    assert.equal(r.status, 0, `kolm keys list exited ${r.status}: ${r.stderr?.slice(0, 200)}`);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /no keys|rotation state/, 'empty store path should advertise the no-keys path');
  } finally { cleanup(dir); }
});

test('14. CLI `kolm keys rotate --kms=local --json` returns a valid JSON rotation receipt', () => {
  const dir = tmpStore();
  try {
    const r = runCli(['keys', 'rotate', '--kms=local', '--overlap-days=7', '--json'],
                     { KOLM_ED25519_KEY_STORE: dir });
    assert.equal(r.status, 0, `kolm keys rotate exited ${r.status}: ${r.stderr?.slice(0, 200)}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true, 'rotation JSON must report ok:true');
    assert.ok(parsed.rotation, 'must carry a rotation block');
    assert.ok(parsed.rotation.new_key_fingerprint, 'rotation receipt must carry new_key_fingerprint');
    assert.equal(parsed.rotation.kms_target, 'local');
    assert.equal(parsed.rotation.overlap_days, 7);
    // Private PEM must NEVER bleed into the JSON receipt.
    assert.ok(!parsed.rotation.private_key_pem, 'rotation receipt must NOT carry the private PEM');
  } finally { cleanup(dir); }
});

test('15. CLI `kolm keys rotate` rejects unknown --kms target with non-zero exit', () => {
  const dir = tmpStore();
  try {
    const r = runCli(['keys', 'rotate', '--kms=aws-fake', '--json'],
                     { KOLM_ED25519_KEY_STORE: dir });
    assert.notEqual(r.status, 0, 'unknown --kms target must exit non-zero');
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /must be one of/i, 'error must list valid targets');
  } finally { cleanup(dir); }
});

test('16. CLI `kolm keys export --kms=vault --json` emits wrap-intent JSON', () => {
  const dir = tmpStore();
  try {
    rotateKey({ kmsTarget: 'local', storeDir: dir });
    const r = runCli(['keys', 'export', '--kms=vault', '--json'],
                     { KOLM_ED25519_KEY_STORE: dir });
    assert.equal(r.status, 0, `kolm keys export exited ${r.status}: ${r.stderr?.slice(0, 200)}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.export.kms_target, 'vault');
    assert.equal(parsed.export.api_status, KMS_API_STATUS_NOT_WIRED);
  } finally { cleanup(dir); }
});

test('17. CLI `kolm keys fingerprint` prints 32-char short fingerprint after rotation', () => {
  const dir = tmpStore();
  try {
    rotateKey({ kmsTarget: 'local', storeDir: dir });
    const r = runCli(['keys', 'fingerprint'], { KOLM_ED25519_KEY_STORE: dir });
    assert.equal(r.status, 0, `kolm keys fingerprint exited ${r.status}: ${r.stderr?.slice(0, 200)}`);
    const fp = r.stdout.trim();
    assert.equal(fp.length, 32, `fingerprint must be 32 hex chars; got "${fp}"`);
    assert.match(fp, /^[0-9a-f]+$/, 'fingerprint must be hex');
  } finally { cleanup(dir); }
});

test('18. cli/kolm.js dispatch case includes "keys"', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.match(src, /case 'keys':\s*await withErrorContext\('keys'/,
    'cli/kolm.js verb switch must include case for "keys"');
});

test('19. COMPLETION_VERBS contains "keys"', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  const m = src.match(/const COMPLETION_VERBS = \[[^\]]+\]/);
  assert.ok(m, 'COMPLETION_VERBS array must exist');
  assert.match(m[0], /'keys'/, 'COMPLETION_VERBS must contain "keys"');
});

test('20. sw.js CACHE wave segment >= 193 (wave-floor regex, not literal)', () => {
  const sw = fs.readFileSync(SW, 'utf8');
  const m = sw.match(/const CACHE = 'kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(parseInt(m[1], 10) >= 193,
    `sw.js CACHE wave segment must be >= 193 (saw wave${m[1]})`);
});

test('21. /security flipped: no more "wave 193 roadmap" amber framing for rotate', () => {
  const html = fs.readFileSync(SECURITY, 'utf8');
  // The W189-shipped page had: <span class="tier future">wave 193 roadmap</span>
  // After this wave, that exact future-tier label must be gone for the rotate verb.
  assert.ok(!html.includes('wave 193 roadmap'),
    'security.html must no longer carry "wave 193 roadmap" amber framing after rotate ships');
  // And "wave 193" must still appear, but as a shipped tag.
  assert.ok(html.includes('wave 193'),
    'security.html must still mention wave 193 (now as ship tag, not roadmap)');
  assert.ok(html.includes('shipped') && html.includes('wave 193'),
    'security.html must frame wave 193 as shipped now');
});

test('22. HELP.keys text declares the honest-scope sentence', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.match(src, /kolm emits[^']*rotation receipt[^']*customer KMS hook applies/i,
    'HELP.keys must declare the kolm-emits / customer-applies honest scope');
});
