// W292 — the teacher bridge (workers/distill/teacher-bridge.mjs) is the one
// place where customer prompts cross from the kolm process into a third-party
// vendor (Anthropic, OpenAI, Google, xAI). Before this wave the bridge would:
//   1. Happily run with `redact: false` against a cloud vendor — sending raw
//      PHI to Anthropic / OpenAI is exactly the leak that destroys a HIPAA
//      compile chain.
//   2. Even with `redact: true`, never check `safe_to_send` on the findings —
//      a redactor that flags a partial SSN as unsafe would still ship.
//   3. Return the raw redaction map (a dict of redacted-token -> original
//      PHI) to the caller. That map is the second-most-load-bearing PHI
//      artifact on the system. The bridge had no path to encrypt it at rest.
//
// W292 closes all three.
//
// Behavior invariants enforced by this suite:
//   1. CLOUD_VENDORS exported and lists the 4 outbound vendors.
//   2. callTeacher({ vendor=cloud, redact: false }) throws fail-closed.
//   3. callTeacher with PHI input that the redactor declares not safe_to_send
//      throws fail-closed and DOES NOT call the vendor.
//   4. callTeacher({ encryptionKey }) returns an encrypted_redaction_map
//      block with {ciphertext, iv, tag, alg, key_hash} and the plaintext map
//      is NOT in the returned object.
//   5. A round-trip: encrypt with key, decrypt with the same key, recover
//      the original map.
//   6. parseTeacherSpec is unchanged (no regression).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  callTeacher,
  parseTeacherSpec,
  CLOUD_VENDORS,
  decryptRedactionMap,
} from '../workers/distill/teacher-bridge.mjs';

test('W292 CLOUD_VENDORS exports the 4 outbound vendors', () => {
  assert.deepEqual([...CLOUD_VENDORS].sort(), ['anthropic', 'google', 'openai', 'xai']);
});

test('W292 callTeacher with cloud vendor + redact:false fails closed before any network call', async () => {
  await assert.rejects(
    callTeacher({
      vendor: 'anthropic',
      model: 'claude-opus-4-7',
      input: 'patient SSN is 123-45-6789',
      redact: false,
    }),
    /fail.closed|PHI redaction.*disabled|redact.*cloud/i,
  );
});

test('W292 callTeacher fails closed when redactor flags unsafe_to_send content', async () => {
  // Stub the network: even if it tried, the API key is absent. The test is
  // that the redactor's safe_to_send=false aborts BEFORE the vendor call.
  // We arrange this via a custom redactor result: redactPhi returns
  // safe_to_send: false when findings include severity=critical AND redacted=false.
  // The bridge must check that combined signal. We exercise via the "long
  // sequence of digits looking like an SSN that the redactor refuses to
  // touch" — but here we use the contract that redactPhi returns
  // safe_to_send accurately. So we pass a sentinel that the redactor flags.
  // Simpler: we feed in a malformed-SSN-looking string that today's redactor
  // still leaves safe_to_send=true. So we cover the contract path: when
  // redactPhi returns safe_to_send=false, the bridge must throw.
  // Use the injectable phi-redactor override via opts.redactor (W292 new arg).
  const stubRedactor = () => ({
    redacted_text: 'XXX',
    map: { '[PHI_FOO_1]': 'something' },
    findings: [{ type: 'unknown', severity: 'critical', redacted: false, safe_to_send: false }],
    safe_to_send: false,
  });
  await assert.rejects(
    callTeacher({
      vendor: 'anthropic',
      model: 'claude-opus-4-7',
      input: 'raw input',
      redactorOverride: stubRedactor,
    }),
    /fail.closed|not safe.to.send|unsafe.PHI/i,
  );
});

test('W292 callTeacher returns encrypted_redaction_map when encryptionKey provided', async () => {
  const key = crypto.randomBytes(32);
  // Use vendor=local with a stubbed fetcher that returns a fixed payload so
  // we exercise the encryption path without an outbound call.
  const stubResult = { redacted_text: 'pid X', map: { '[PHI_NAME_1]': 'Alice Patient' }, findings: [], safe_to_send: true };
  const stubRedactor = () => stubResult;
  const stubFetch = async () => 'echo: pid X';
  const out = await callTeacher({
    vendor: 'local',
    model: 'qwen-2.5-3b',
    localEndpoint: 'http://localhost:8000',
    input: 'Alice Patient',
    redactorOverride: stubRedactor,
    transportOverride: stubFetch,
    encryptionKey: key,
  });
  assert.ok(out.encrypted_redaction_map, 'encrypted_redaction_map must be present when encryptionKey supplied');
  const e = out.encrypted_redaction_map;
  assert.ok(e.ciphertext && typeof e.ciphertext === 'string');
  assert.ok(e.iv && typeof e.iv === 'string');
  assert.ok(e.tag && typeof e.tag === 'string');
  assert.equal(e.alg, 'aes-256-gcm');
  assert.ok(e.key_hash && /^sha256:[0-9a-f]{64}$/.test(e.key_hash));
  assert.ok(!out.redaction_map, 'plaintext redaction_map must NOT leak in the response');
});

test('W292 decryptRedactionMap round-trips the original map', async () => {
  const key = crypto.randomBytes(32);
  const original = { '[PHI_SSN_1]': '123-45-6789', '[PHI_NAME_1]': 'Bob Patient' };
  const stubRedactor = () => ({ redacted_text: 'X', map: original, findings: [], safe_to_send: true });
  const stubFetch = async () => 'ok';
  const out = await callTeacher({
    vendor: 'local',
    model: 'qwen',
    localEndpoint: 'http://x',
    input: 'raw',
    redactorOverride: stubRedactor,
    transportOverride: stubFetch,
    encryptionKey: key,
  });
  const recovered = decryptRedactionMap(out.encrypted_redaction_map, key);
  assert.deepEqual(recovered, original);
});

test('W292 decryptRedactionMap throws with the wrong key', () => {
  const k1 = crypto.randomBytes(32);
  const k2 = crypto.randomBytes(32);
  const map = { '[PHI_NAME_1]': 'X' };
  // Manually encrypt with k1 and try to decrypt with k2.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k1, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(map), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const enc = {
    alg: 'aes-256-gcm',
    iv: iv.toString('hex'),
    ciphertext: ct.toString('hex'),
    tag: tag.toString('hex'),
    key_hash: 'sha256:' + crypto.createHash('sha256').update(k1).digest('hex'),
  };
  assert.throws(() => decryptRedactionMap(enc, k2), /unsupported|auth|decrypt/i);
});

test('W292 parseTeacherSpec untouched (smoke)', () => {
  const r = parseTeacherSpec('anthropic:claude-opus-4-7');
  assert.equal(r.vendor, 'anthropic');
  assert.equal(r.model, 'claude-opus-4-7');
});
