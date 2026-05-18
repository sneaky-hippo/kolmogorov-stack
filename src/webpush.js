// Wave 215 - minimal WebPush sender. Native Node, no npm dep.
//
// Implements the VAPID JWT auth scheme (RFC 8292) using node:crypto's
// built-in ECDSA P-256 support. Payloads are sent in plaintext with
// Content-Encoding: aes128gcm OMITTED - we use the "tickle" form where the
// push body is empty and the service worker's push handler reads from its
// own cache. Browsers accept this and fire the push event with empty data;
// the SW's `event.waitUntil(showNotification(...))` then renders a generic
// "open /captures" notification.
//
// Config (set in Vercel env or .env):
//   VAPID_PUBLIC_KEY   - base64url-encoded uncompressed P-256 public key
//                        (the 65-byte X9.62 form, starting 0x04).
//   VAPID_PRIVATE_KEY  - base64url-encoded P-256 private key scalar (32 bytes).
//   VAPID_SUBJECT      - "mailto:ops@kolm.ai" (or https://kolm.ai).
//
// Generate a fresh pair with: openssl ecparam -name prime256v1 -genkey
// (then convert to raw 65/32 byte forms - see notes in tests).

import crypto from 'node:crypto';

export function vapidConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

export function vapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// Build VAPID JWT for the audience derived from the push endpoint.
// Audience is origin (scheme + host) of endpoint.
export function buildVapidHeader(endpoint) {
  if (!vapidConfigured()) throw new Error('VAPID not configured');
  const u = new URL(endpoint);
  const aud = `${u.protocol}//${u.host}`;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp, sub: process.env.VAPID_SUBJECT };
  const headerB64 = b64urlEncode(JSON.stringify(header));
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const unsigned = `${headerB64}.${payloadB64}`;
  const privateRaw = b64urlDecode(process.env.VAPID_PRIVATE_KEY);
  // Construct a PKCS#8 key from the raw 32-byte scalar so node:crypto.sign accepts it.
  const pkcs8 = rawPrivateToPkcs8(privateRaw);
  const keyObj = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const sigDer = crypto.sign('sha256', Buffer.from(unsigned), { key: keyObj, dsaEncoding: 'ieee-p1363' });
  const token = `${unsigned}.${b64urlEncode(sigDer)}`;
  return {
    Authorization: `vapid t=${token}, k=${process.env.VAPID_PUBLIC_KEY}`,
  };
}

// Wrap raw 32-byte P-256 private key scalar in the PKCS#8 DER envelope.
// Built by hand because node:crypto can't import a raw scalar directly.
// Format: PrivateKeyInfo with ecPrivateKey(SEQUENCE{ version=1, octetString, [0] params, [1] publicKey }).
// We only emit the minimum required: SEQUENCE { 1, OCTETSTRING(scalar) } inside an OCTETSTRING
// inside a PrivateKeyInfo with the prime256v1 OID.
function rawPrivateToPkcs8(scalar) {
  if (scalar.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be 32 raw bytes (base64url-encoded)');
  // ECPrivateKey(version=1, OCTETSTRING(scalar), [0] EXPLICIT OID prime256v1).
  const ecPrivKeyV1 = Buffer.concat([
    Buffer.from([0x02, 0x01, 0x01]), // INTEGER 1
    Buffer.from([0x04, 0x20]), scalar, // OCTET STRING(32)
    Buffer.from([0xa0, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]), // [0] OID prime256v1
  ]);
  const ecPrivKeyOuter = Buffer.concat([Buffer.from([0x30, ecPrivKeyV1.length]), ecPrivKeyV1]);
  // PrivateKeyInfo = SEQUENCE { version=0, AlgorithmId{ ecPublicKey, prime256v1 }, OCTETSTRING(ecPrivateKey) }
  const algId = Buffer.from([
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID id-ecPublicKey 1.2.840.10045.2.1
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID prime256v1
  ]);
  const privOctet = Buffer.concat([
    Buffer.from([0x04, ecPrivKeyOuter.length]),
    ecPrivKeyOuter,
  ]);
  const inner = Buffer.concat([Buffer.from([0x02, 0x01, 0x00]), algId, privOctet]); // version 0 + algid + octet
  return Buffer.concat([Buffer.from([0x30, 0x81, inner.length]), inner]);
}

// Send a tickle (empty payload) push to the subscription. Returns
// { ok, status }. 404 / 410 means the subscription is dead and the caller
// should remove it; other failures are best-effort retry candidates.
//
// The payload arg is currently informational (logged but not encrypted +
// shipped). Encrypting requires aes128gcm + ECDH which needs a heavier
// crypto path. The "tickle" approach is enough for the SW's
// "you have new captures, open /captures" notification.
export async function sendWebPush(subscription, _payload) {
  if (!vapidConfigured()) return { ok: false, status: 0, error: 'vapid_not_configured' };
  if (!subscription || !subscription.endpoint) return { ok: false, status: 0, error: 'no_endpoint' };
  try {
    const headers = {
      ...buildVapidHeader(subscription.endpoint),
      TTL: '86400',
    };
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers,
      body: '',
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: String(err.message || err) };
  }
}
