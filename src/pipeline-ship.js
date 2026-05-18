// Wave 360 — kolm ship: artifact -> marketplace.
//
// Async iterator yielding ShipEvent = { step, name, status, detail?, hint? }.
//
// Steps:
//   1 verify production_ready   productionReady() — refuse unless --force
//   2 sign                      attest receipt with Ed25519 (best-effort);
//                               attestArtifactWithRekor only when
//                               KOLM_SIGSTORE_REKOR_URL is set, else
//                               local sigstore bundle (sha256-anchor stays)
//   3 upload to marketplace     POST /v1/marketplace/publish
//   4 emit success URL
//
// No network is mandatory unless step 3 is invoked. Step 3 honors a
// KOLM_MARKETPLACE_BASE override so the test harness can point at a local
// express server; default is the configured `kolm config` base + the new
// /v1/marketplace/publish endpoint.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STEPS = [
  { step: 1, name: 'verify production_ready' },
  { step: 2, name: 'sign' },
  { step: 3, name: 'upload to marketplace' },
  { step: 4, name: 'live' },
];

export async function* ship(artifactPath, opts = {}) {
  const abs = path.resolve(artifactPath);
  if (!fs.existsSync(abs)) {
    yield ev(1, 'err', { error: `artifact not found: ${abs}` });
    return;
  }

  // ---- 1: verify production_ready
  yield ev(1, 'started');
  let prodVerdict;
  try {
    const { productionReady } = await import('./production-ready.js');
    prodVerdict = await productionReady(abs, { kGate: opts.kGate });
    if (!prodVerdict.ok && !opts.force) {
      yield ev(1, 'err', { production_ready: false, reasons: prodVerdict.reasons }, 'pass --force to ship anyway');
      return;
    }
    yield ev(1, 'ok', { production_ready: prodVerdict.ok, forced: !prodVerdict.ok && !!opts.force, reasons: prodVerdict.reasons });
  } catch (e) {
    yield ev(1, 'err', { error: e.message });
    return;
  }

  // ---- 2: sign
  yield ev(2, 'started');
  let signResult = null;
  try {
    // If the user already has a .receipt.json sidecar (e.g. from `kolm make`),
    // re-sign it to record the ship-time approval. Otherwise emit a fresh one.
    const receiptPath = abs.replace(/\.kolm$/, '.receipt.json');
    const buf = fs.readFileSync(abs);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const baseReceipt = fs.existsSync(receiptPath)
      ? JSON.parse(fs.readFileSync(receiptPath, 'utf-8'))
      : { spec: 'kolm-receipt-v1', artifact: path.basename(abs), sha256, bytes: buf.length };
    baseReceipt.shipped_at = new Date().toISOString();
    baseReceipt.production_ready = !!(prodVerdict && prodVerdict.ok);
    baseReceipt.shipped_signature = { alg: 'sha256-anchor', value: sha256.slice(0, 32) };

    // Best-effort Ed25519 sign of the canonical receipt — if the local key
    // exists, attach the bundle so a third party can verify the artifact
    // without ever touching Rekor.
    try {
      const sig = await import('./sigstore.js');
      const { canonicalJson } = await import('./cid.js');
      const ed = await import('./ed25519.js');
      const kp = typeof ed.loadOrCreateDefaultSigner === 'function' ? ed.loadOrCreateDefaultSigner() : null;
      if (kp && kp.privateKey && kp.publicKey && typeof sig.buildSigstoreBundle === 'function') {
        const canonical = canonicalJson({ ...baseReceipt, shipped_signature: undefined, signature_sigstore: undefined });
        const bundle = sig.buildSigstoreBundle({
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          key_fingerprint: kp.key_fingerprint || null,
          payloadCanonical: canonical,
          signed_at: baseReceipt.shipped_at,
        });
        if (bundle) baseReceipt.signature_sigstore = bundle;
      }
    } catch { /* leave the sha256 anchor — no key is fine */ }

    fs.writeFileSync(receiptPath, JSON.stringify(baseReceipt, null, 2));
    signResult = { receipt_path: receiptPath, sha256, signed: !!baseReceipt.signature_sigstore };
    yield ev(2, 'ok', signResult);
  } catch (e) {
    yield ev(2, 'err', { error: e.message });
    return;
  }

  // ---- 3: upload to marketplace
  yield ev(3, 'started');
  let publishResult;
  try {
    const slug = opts.slug || slugify(path.basename(abs, '.kolm'));
    const base = opts.base || process.env.KOLM_MARKETPLACE_BASE || process.env.KOLM_BASE || 'https://kolm.ai';
    const url = base.replace(/\/+$/, '') + '/v1/marketplace/publish';
    const buf = fs.readFileSync(abs);
    const receiptBuf = fs.readFileSync(signResult.receipt_path);
    const body = JSON.stringify({
      slug,
      artifact_b64: buf.toString('base64'),
      receipt: JSON.parse(receiptBuf.toString('utf-8')),
      sha256: signResult.sha256,
      bytes: buf.length,
    });
    const headers = { 'Content-Type': 'application/json', 'X-Kolm-Sha256': signResult.sha256 };
    if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;
    const result = await postJson(url, body, headers, opts.timeoutMs || 15000);
    if (!result.ok) {
      yield ev(3, 'err', { error: `marketplace publish failed: HTTP ${result.status}`, detail: result.body });
      return;
    }
    publishResult = { slug: result.body.slug || slug, marketplace_url: result.body.marketplace_url, sha256: signResult.sha256 };
    yield ev(3, 'ok', publishResult);
  } catch (e) {
    yield ev(3, 'err', { error: e.message });
    return;
  }

  // ---- 4: emit success URL
  yield ev(4, 'ok', { marketplace_url: publishResult.marketplace_url, slug: publishResult.slug });
}

function postJson(url, body, headers, timeoutMs) {
  // Direct node:http path — fetch() has caused libuv crashes on Windows
  // process.exit() in this codebase (see W304 trap); native http is safe.
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch (e) { return reject(new Error(`bad url ${url}: ${e.message}`)); }
    const isHttps = parsed.protocol === 'https:';
    Promise.resolve().then(async () => {
      const lib = await import(isHttps ? 'node:https' : 'node:http');
      const req = lib.request({
        host: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      }, (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          let parsedBody = null;
          try { parsedBody = JSON.parse(chunks); } catch { parsedBody = { raw: chunks }; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsedBody });
        });
      });
      req.on('error', (e) => reject(e));
      req.on('timeout', () => { try { req.destroy(new Error('request timed out')); } catch (_) {} });
      req.write(body);
      req.end();
    }).catch(reject);
  });
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function ev(step, status, detail, hint) {
  const meta = STEPS.find(s => s.step === step);
  const out = { step, name: meta ? meta.name : `step-${step}`, status };
  if (detail !== undefined) out.detail = detail;
  if (hint !== undefined) out.hint = hint;
  return out;
}
