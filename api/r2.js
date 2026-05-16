// Vercel serverless function for Cloudflare R2 admin ops.
// Runs in Vercel runtime where CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN are set.
// Gated by ADMIN_KEY (x-admin-key header).
//
// Routes (path determined by ?op= query):
//   GET  /api/r2?op=ping             — verify env + list buckets
//   POST /api/r2?op=bootstrap        — create primary buckets, smoke-test
//   GET  /api/r2?op=list&bucket=X    — list objects in a bucket
//   POST /api/r2?op=put&bucket=X&key=K  body=raw — upload an object
//   GET  /api/r2?op=get&bucket=X&key=K  — fetch an object (proxied)
//   DELETE /api/r2?op=del&bucket=X&key=K — delete an object
import * as R2 from '../src/r2.js';

const PRIMARY_BUCKETS = ['kolm-assets', 'kolm-receipts', 'kolm-artifacts', 'kolm-reports'];
const PUBLIC_BUCKETS = new Set(['kolm-assets']);

function requireAdmin(req, res) {
  const k = req.headers['x-admin-key'] || req.query?.admin_key;
  if (!k || k !== process.env.ADMIN_KEY) {
    res.status(403).json({ error: 'admin only' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  try {
    if (!R2.r2Configured()) {
      return res.status(500).json({
        error: 'r2 not configured',
        hint: 'set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars',
        have_account: !!(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.cloudflare_account_id),
        have_token: !!(process.env.CLOUDFLARE_API_TOKEN || process.env.Cloudflare_api_token),
      });
    }

    const op = String(req.query.op || 'ping');
    if (op === 'ping') {
      // ping doesn't require admin — useful for monitoring
      const buckets = await R2.listBuckets();
      return res.json({ ok: true, account: R2.accountId.slice(0, 8) + '…', buckets: buckets.map((b) => b.name) });
    }

    // Public read for kolm-assets bucket via /cdn/* rewrite. Other ops require admin.
    if (op === 'get' && PUBLIC_BUCKETS.has(String(req.query.bucket || ''))) {
      const bucket = String(req.query.bucket);
      const key = String(req.query.key || '');
      if (!key) return res.status(400).json({ error: 'key required' });
      const r = await R2.getObject(key, { bucket });
      if (!r) return res.status(404).json({ error: 'not found' });
      res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
      const buf = Buffer.from(await r.arrayBuffer());
      return res.end(buf);
    }

    if (!requireAdmin(req, res)) return;

    if (op === 'bootstrap') {
      const existing = await R2.listBuckets();
      const existingNames = new Set(existing.map((b) => b.name));
      const created = [];
      for (const name of PRIMARY_BUCKETS) {
        if (existingNames.has(name)) continue;
        await R2.createBucket(name);
        created.push(name);
      }
      // smoke test
      const key = `_smoke/${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      const body = `kolm r2 bootstrap ${new Date().toISOString()}`;
      await R2.putObject(key, body, { bucket: 'kolm-assets', contentType: 'text/plain' });
      const r = await R2.getObject(key, { bucket: 'kolm-assets' });
      const echoed = r ? await r.text() : null;
      await R2.deleteObject(key, { bucket: 'kolm-assets' });
      return res.json({
        ok: true,
        buckets_existing: existing.map((b) => b.name),
        buckets_created: created,
        smoke: { key, round_trip: echoed === body },
      });
    }

    if (op === 'list') {
      const bucket = String(req.query.bucket || R2.defaultBucket);
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${R2.accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects?per_page=1000`, {
        headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN || process.env.Cloudflare_api_token}` },
      });
      const j = await r.json();
      return res.json({ ok: !!j.success, objects: j.result || [], errors: j.errors });
    }

    if (op === 'put') {
      const bucket = String(req.query.bucket || R2.defaultBucket);
      const key = String(req.query.key || '');
      if (!key) return res.status(400).json({ error: 'key required' });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const result = await R2.putObject(key, body, { bucket, contentType: req.headers['content-type'] || 'application/octet-stream' });
      return res.json({ ok: true, ...result });
    }

    if (op === 'get') {
      const bucket = String(req.query.bucket || R2.defaultBucket);
      const key = String(req.query.key || '');
      const r = await R2.getObject(key, { bucket });
      if (!r) return res.status(404).json({ error: 'not found' });
      res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
      const buf = Buffer.from(await r.arrayBuffer());
      return res.end(buf);
    }

    if (op === 'del') {
      const bucket = String(req.query.bucket || R2.defaultBucket);
      const key = String(req.query.key || '');
      if (!key) return res.status(400).json({ error: 'key required' });
      const result = await R2.deleteObject(key, { bucket });
      return res.json({ ok: true, ...result });
    }

    return res.status(400).json({ error: `unknown op: ${op}` });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
