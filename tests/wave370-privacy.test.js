// tests/wave370-privacy.test.js
//
// W370 - Lock in the full 17-class privacy membrane behavior contract.
//
// Each test gets a fresh KOLM_DATA_DIR so policy + vault persistence
// state never leaks across cases. We re-import privacy-membrane.js
// inside each test that needs a clean cache (Node ESM caches modules
// by URL, so we use cache-busting query strings).

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODULE_PATH = path.resolve('src', 'privacy-membrane.js');
const MODULE_URL = pathToFileURL(MODULE_PATH).href;

let _idx = 0;
function mkTmpDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w370-${process.pid}-`));
  return dir;
}

async function freshImport() {
  // Cache-bust so policy module state resets between tests that need it.
  _idx += 1;
  return await import(`${MODULE_URL}?v=${_idx}-${Date.now()}-${Math.random()}`);
}

describe('W370 privacy membrane', () => {
  let prevDataDir;
  let prevCustPat;

  before(() => {
    prevDataDir = process.env.KOLM_DATA_DIR;
    prevCustPat = process.env.KOLM_CUSTOMER_ID_PATTERN;
  });
  after(() => {
    if (prevDataDir === undefined) delete process.env.KOLM_DATA_DIR;
    else process.env.KOLM_DATA_DIR = prevDataDir;
    if (prevCustPat === undefined) delete process.env.KOLM_CUSTOMER_ID_PATTERN;
    else process.env.KOLM_CUSTOMER_ID_PATTERN = prevCustPat;
  });

  beforeEach(() => {
    process.env.KOLM_DATA_DIR = mkTmpDataDir();
    delete process.env.KOLM_CUSTOMER_ID_PATTERN;
    delete process.env.KOLM_PRIVACY_POLICY;
  });

  // 1. Each of 17 classes detected on a positive sample
  it('detects all 17 classes on positive samples', async () => {
    const { scan } = await freshImport();

    // Seed proprietary terms so detector has data.
    const dir = path.join(process.env.KOLM_DATA_DIR, 'runtime');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'proprietary-terms.json'),
      JSON.stringify({ terms: ['Project Athena'] }),
      'utf-8'
    );

    const cases = {
      ssn:               'patient ssn is 123-45-6789 today',
      malformed_ssn:     'old chart shows 000-12-3456 invalid',
      email:             'send to alice@example.com please',
      phone:             'call (415) 555-1234 thanks',
      address:           'mail to 1600 Pennsylvania Avenue please',
      name:              'meet Sandra Pham at 9am',
      dob:              'born 1985-07-04 according to record',
      mrn:              'MRN: 0012345 admitted yesterday',
      account_number:    'wire to account 12345678 confirmed',
      api_key:           'set OPENAI_KEY=sk_test_abcdefghijklmnopqrst now',
      bearer_token:      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghij',
      private_key:       '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w\n-----END PRIVATE KEY-----',
      database_url:      'DATABASE_URL=postgres://user:pw@db.internal:5432/main',
      internal_hostname: 'curl http://api.acme.corp/v1 returned 200',
      customer_id:       'open ticket CUST-9876',
      proprietary_term:  'codename Project Athena ships next quarter',
      ip_address:        'edge node is 8.8.8.8 in the public zone',
    };

    for (const [cls, sample] of Object.entries(cases)) {
      const out = scan(sample);
      const got = new Set(out.matches.map((m) => m.class));
      assert.ok(got.has(cls), `expected class=${cls} in ${[...got].join(',') || '(none)'} for sample: ${sample}`);
    }
  });

  // 2. Negative case for SSN (000-12-3456 is invalid)
  it('rejects SSN with reserved 000 area as ssn (malformed instead)', async () => {
    const { scan } = await freshImport();
    const out = scan('000-12-3456 should not be a real ssn');
    const ssnHits = out.matches.filter((m) => m.class === 'ssn');
    assert.equal(ssnHits.length, 0, 'no canonical ssn hits');
    const malformed = out.matches.filter((m) => m.class === 'malformed_ssn');
    assert.equal(malformed.length, 1, 'one malformed hit');
    assert.ok(malformed[0].confidence <= 0.5, 'malformed confidence is low');
  });

  // 3. Deterministic VAR_ numbering across two scans of identical input
  it('produces deterministic VAR_ numbering across repeated redact calls', async () => {
    const { redact } = await freshImport();
    const text = 'first sk_aaaaaaaaaaaaaaaa second sk_bbbbbbbbbbbbbbbb third alice@example.com';
    const r1 = redact(text);
    const r2 = redact(text);
    assert.equal(r1.redacted, r2.redacted);
    assert.deepEqual(Object.keys(r1.vault).sort(), Object.keys(r2.vault).sort());
    assert.ok(r1.redacted.includes('VAR_API_KEY_1'));
    assert.ok(r1.redacted.includes('VAR_API_KEY_2'));
    assert.ok(r1.redacted.includes('VAR_EMAIL_1'));
  });

  // 4. redact + reinsert roundtrip equals input
  it('redact -> reinsert roundtrips losslessly', async () => {
    const { redact, reinsert } = await freshImport();
    const text =
      'Patient Sandra Pham (DOB 1985-07-04, MRN: 0099887) at alice@example.com ' +
      'called (415) 555-1234 from 10.0.0.42 with api key sk_test_abcdefghijklmnopqrst.';
    const r = redact(text);
    assert.notEqual(r.redacted, text, 'something was redacted');
    const restored = reinsert(r.redacted, r.vault);
    assert.equal(restored, text);
  });

  // 5. setPolicy persists to disk and reloads after re-import (fresh KOLM_DATA_DIR per test)
  it('setPolicy persists to disk and survives re-import', async () => {
    const dataDir = process.env.KOLM_DATA_DIR;
    const mod1 = await freshImport();
    mod1.setPolicy({ class: 'ssn', action: 'block' });
    mod1.setPolicy({ class: 'email', action: 'allow' });
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'runtime', 'policy.json'), 'utf-8')
    );
    assert.equal(onDisk.ssn, 'block');
    assert.equal(onDisk.email, 'allow');

    // Re-import with the same KOLM_DATA_DIR.
    const mod2 = await freshImport();
    assert.equal(mod2.policy('ssn'), 'block');
    assert.equal(mod2.policy('email'), 'allow');
  });

  // 6. policy 'block' throws PolicyBlockError with .class field
  it('redactWithPolicy throws PolicyBlockError with .class field', async () => {
    const mod = await freshImport();
    mod.setPolicy({ class: 'ssn', action: 'block' });
    let err;
    try {
      mod.redactWithPolicy('ssn 123-45-6789 here');
    } catch (e) { err = e; }
    assert.ok(err, 'threw an error');
    assert.ok(err instanceof mod.PolicyBlockError, 'is PolicyBlockError instance');
    assert.equal(err.class, 'ssn');
    assert.equal(err.code, 'POLICY_BLOCK');
  });

  // 7. policy 'allow' leaves text untouched
  it("policy 'allow' leaves matching classes untouched", async () => {
    const mod = await freshImport();
    // Allow everything that might match so the email stays in cleartext.
    for (const c of mod.ALL_CLASSES) mod.setPolicy({ class: c, action: 'allow' });
    const text = 'reach me at alice@example.com';
    const out = mod.redactWithPolicy(text);
    assert.equal(out.redacted, text);
    assert.deepEqual(out.vault, {});
    assert.ok(out.allowed_classes.includes('email'));
  });

  // 8. policy 'override' marks but doesn't redact
  it("policy 'override' marks but does not redact", async () => {
    const mod = await freshImport();
    // Avoid spurious other-class matches by allowing them.
    for (const c of mod.ALL_CLASSES) mod.setPolicy({ class: c, action: 'allow' });
    mod.setPolicy({ class: 'email', action: 'override' });
    const text = 'reach me at bob@example.com';
    const out = mod.redactWithPolicy(text);
    assert.ok(out.redacted.includes('bob@example.com'), 'original value still present');
    assert.ok(out.redacted.includes('[[OVERRIDE:email]]'), 'override marker injected');
    assert.deepEqual(out.vault, {});
    assert.ok(out.overridden_classes.includes('email'));
  });

  // 9. detector_version present in scan output
  it('detector_version present in scan and redact outputs', async () => {
    const { scan, redact, DETECTOR_VERSION } = await freshImport();
    const s = scan('hello world');
    assert.equal(s.detector_version, DETECTOR_VERSION);
    assert.ok(/^\d{4}-\d{2}-\d{2}/.test(DETECTOR_VERSION), 'looks like a date version');
    const r = redact('hello world');
    assert.equal(r.detector_version, DETECTOR_VERSION);
  });

  // 10. redactWithPolicy honors mixed policies (some classes redact, some block, some allow)
  it('redactWithPolicy honours mixed per-class policies', async () => {
    const mod = await freshImport();
    // Start from a baseline where everything redacts; flip a few.
    mod.setPolicy({ class: 'email', action: 'allow' });
    mod.setPolicy({ class: 'ssn', action: 'redact' });
    mod.setPolicy({ class: 'api_key', action: 'redact' });
    // Avoid name collisions etc.
    for (const c of ['name', 'phone', 'address', 'dob', 'mrn', 'account_number',
                     'bearer_token', 'private_key', 'database_url', 'internal_hostname',
                     'customer_id', 'proprietary_term', 'ip_address', 'malformed_ssn']) {
      mod.setPolicy({ class: c, action: 'allow' });
    }
    const text = 'email alice@example.com ssn 123-45-6789 key sk_test_abcdefghijklmnopqrst';
    const out = mod.redactWithPolicy(text);
    assert.ok(out.redacted.includes('alice@example.com'), 'email allowed through');
    assert.ok(!out.redacted.includes('123-45-6789'), 'ssn redacted');
    assert.ok(!out.redacted.includes('sk_test_abcdefghijklmnopqrst'), 'api_key redacted');
    assert.ok(out.redacted.includes('VAR_SSN_1'));
    assert.ok(out.redacted.includes('VAR_API_KEY_1'));
    assert.ok(out.classes_seen.includes('ssn'));
    assert.ok(out.classes_seen.includes('api_key'));
    assert.ok(out.allowed_classes.includes('email'));
  });

  // 11. Multi-class input: SSN + email + api_key all redacted in one pass
  it('redacts multiple classes in a single pass', async () => {
    const { redact, reinsert } = await freshImport();
    const text = 'ssn 123-45-6789, email alice@example.com, key sk_test_abcdefghijklmnopqrst.';
    const r = redact(text);
    const classes = new Set(r.classes_seen);
    assert.ok(classes.has('ssn'));
    assert.ok(classes.has('email'));
    assert.ok(classes.has('api_key'));
    assert.equal(reinsert(r.redacted, r.vault), text);
  });

  // 12. proprietary_term loaded from KOLM_DATA_DIR/runtime/proprietary-terms.json
  it('loads proprietary_term list from runtime/proprietary-terms.json', async () => {
    const dir = path.join(process.env.KOLM_DATA_DIR, 'runtime');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'proprietary-terms.json'),
      JSON.stringify({ terms: ['Falcon-9X', 'Project Mockingbird'] }),
      'utf-8'
    );
    const { scan } = await freshImport();
    const text = 'Tomorrow we demo Falcon-9X to investors and discuss Project Mockingbird.';
    const out = scan(text);
    const prop = out.matches.filter((m) => m.class === 'proprietary_term');
    const vals = prop.map((m) => m.value.toLowerCase());
    assert.ok(vals.includes('falcon-9x'));
    assert.ok(vals.includes('project mockingbird'));
  });

  // 13. Empty input returns empty results without crash
  it('handles empty / null input gracefully', async () => {
    const { scan, redact, reinsert } = await freshImport();
    for (const input of ['', null, undefined]) {
      const s = scan(input);
      assert.deepEqual(s.matches, []);
      assert.equal(s.sensitive, false);
      const r = redact(input);
      assert.equal(r.redacted, '');
      assert.deepEqual(r.vault, {});
    }
    assert.equal(reinsert('hello', null), 'hello');
    assert.equal(reinsert('hello', {}), 'hello');
  });

  // 14. Very long input (10KB) completes in <100ms
  it('scans a 10KB blob in under 100ms', async () => {
    const { scan } = await freshImport();
    const chunk = 'lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
    let blob = '';
    while (blob.length < 10_000) blob += chunk;
    // Sprinkle a couple of real hits so the detector path isn't a no-op.
    blob = blob + ' contact alice@example.com or sk_test_abcdefghijklmnopqrst.';
    assert.ok(blob.length >= 10_000);
    const t0 = process.hrtime.bigint();
    const out = scan(blob);
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    assert.ok(ms < 100, `expected <100ms, got ${ms.toFixed(2)}ms`);
    assert.ok(out.matches.length >= 2, 'still detected the sprinkled hits');
  });

  // 15. Vault persistence opt-in writes to ~/.kolm/redactions/
  it('persistVault opt-in writes vault to redactions/<event_id>.json', async () => {
    const { redact, statePaths } = await freshImport();
    const text = 'send to alice@example.com';
    const r = redact(text, { persistVault: true, eventId: 'ev-w370-test' });
    assert.ok(Object.keys(r.vault).length >= 1);
    const fp = path.join(statePaths().redactions, 'ev-w370-test.json');
    assert.ok(fs.existsSync(fp), `expected ${fp}`);
    const payload = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    assert.equal(payload.event_id, 'ev-w370-test');
    assert.deepEqual(payload.vault, r.vault);
    assert.ok(Array.isArray(payload.classes_seen));
  });

  // 16. Reinsert on tampered vault throws or skips gracefully
  it('reinsert skips tampered/garbage vault entries gracefully', async () => {
    const { redact, reinsert } = await freshImport();
    const text = 'hello alice@example.com world';
    const r = redact(text);
    const phName = Object.keys(r.vault)[0];
    // Tamper: replace string value with an object so reinsert must skip it.
    const tampered = { ...r.vault, [phName]: { malicious: true }, '__not_a_var__': 'shellcode' };
    let out;
    let threw = false;
    try { out = reinsert(r.redacted, tampered); } catch { threw = true; }
    // Spec: throws OR skips gracefully. Either way, no crash; if it did not
    // throw, the placeholder text must still appear (unredacted skip).
    if (!threw) {
      assert.ok(out.includes(phName), 'tampered entry skipped, placeholder still in text');
      assert.ok(!out.includes('shellcode'), 'invalid VAR_ name not substituted');
    }
  });

  // 17. Re-import after setPolicy returns same policy (durability)
  it('re-import after setPolicy yields same policy (durability)', async () => {
    const mod1 = await freshImport();
    mod1.setPolicy({ class: 'api_key', action: 'block' });
    mod1.setPolicy({ class: 'private_key', action: 'block' });
    mod1.setPolicy({ class: 'phone', action: 'override' });

    const mod2 = await freshImport();
    const full = mod2.getFullPolicy();
    assert.equal(full.api_key, 'block');
    assert.equal(full.private_key, 'block');
    assert.equal(full.phone, 'override');
    // Defaults preserved for untouched classes.
    assert.equal(full.ssn, 'redact');
  });

  // 18. IP private-range subclassification matches expected RFC1918
  it('IP detector tags RFC1918 ranges with subclass=rfc1918', async () => {
    const { scan } = await freshImport();
    const cases = [
      { ip: '10.0.0.1',      subclass: 'rfc1918' },
      { ip: '172.16.0.1',    subclass: 'rfc1918' },
      { ip: '172.31.255.254',subclass: 'rfc1918' },
      { ip: '192.168.1.1',   subclass: 'rfc1918' },
      { ip: '127.0.0.1',     subclass: 'loopback' },
      { ip: '169.254.1.1',   subclass: 'link_local' },
      { ip: '8.8.8.8',       subclass: 'public' },
      { ip: '224.0.0.1',     subclass: 'multicast' },
    ];
    for (const { ip, subclass } of cases) {
      const out = scan(`node ${ip} ok`);
      const hit = out.matches.find((m) => m.class === 'ip_address' && m.value === ip);
      assert.ok(hit, `expected IP ${ip} detected`);
      assert.equal(hit.subclass, subclass, `IP ${ip} subclass`);
      assert.equal(hit.family, 'ipv4');
    }

    // Bonus: 172.15 / 172.32 are NOT rfc1918.
    const edge = scan('try 172.15.0.1 and 172.32.0.1');
    const e1 = edge.matches.find((m) => m.value === '172.15.0.1');
    const e2 = edge.matches.find((m) => m.value === '172.32.0.1');
    assert.equal(e1?.subclass, 'public');
    assert.equal(e2?.subclass, 'public');
  });
});
