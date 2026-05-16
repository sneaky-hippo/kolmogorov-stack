// Cloudflare R2 client — uses Cloudflare REST API (Bearer api_token).
// No AWS SDK dependency; works with a single account-scoped api token that has R2 read/write.
//
// Env required at runtime (Vercel: cloudflare_account_id + Cloudflare_api_token):
//   CLOUDFLARE_ACCOUNT_ID   (alias: cloudflare_account_id)
//   CLOUDFLARE_API_TOKEN    (alias: Cloudflare_api_token)
//
// Reference: https://developers.cloudflare.com/api/operations/r2-list-buckets

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.cloudflare_account_id || '';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.Cloudflare_api_token || '';
const DEFAULT_BUCKET = process.env.R2_BUCKET || 'kolm-assets';
const PUBLIC_BASE = process.env.R2_PUBLIC_BASE || ''; // optional public.r2.dev or custom domain

function authHeaders(extra = {}) {
  if (!API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN not set');
  if (!ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_ID not set');
  return { Authorization: `Bearer ${API_TOKEN}`, ...extra };
}

function apiBase() {
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
}

export function r2Configured() {
  return Boolean(ACCOUNT_ID && API_TOKEN);
}

export async function listBuckets() {
  const r = await fetch(`${apiBase()}/r2/buckets`, { headers: authHeaders() });
  const j = await r.json();
  if (!j.success) throw new Error(`r2 listBuckets failed: ${JSON.stringify(j.errors)}`);
  return j.result?.buckets || [];
}

export async function createBucket(name = DEFAULT_BUCKET) {
  const r = await fetch(`${apiBase()}/r2/buckets`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name }),
  });
  const j = await r.json();
  if (!j.success && !String(j.errors?.[0]?.message || '').toLowerCase().includes('already')) {
    throw new Error(`r2 createBucket failed: ${JSON.stringify(j.errors)}`);
  }
  return j.result || { name };
}

export async function putObject(key, body, opts = {}) {
  const bucket = opts.bucket || DEFAULT_BUCKET;
  const contentType = opts.contentType || 'application/octet-stream';
  const url = `${apiBase()}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURI(key)}`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': contentType }),
    body,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`r2 putObject failed: ${r.status} ${t.slice(0, 200)}`);
  }
  return { bucket, key, size: typeof body === 'string' ? body.length : (body?.byteLength || body?.length || 0) };
}

export async function getObject(key, opts = {}) {
  const bucket = opts.bucket || DEFAULT_BUCKET;
  const url = `${apiBase()}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURI(key)}`;
  const r = await fetch(url, { headers: authHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`r2 getObject failed: ${r.status}`);
  return r;
}

export async function deleteObject(key, opts = {}) {
  const bucket = opts.bucket || DEFAULT_BUCKET;
  const url = `${apiBase()}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURI(key)}`;
  const r = await fetch(url, { method: 'DELETE', headers: authHeaders() });
  if (!r.ok && r.status !== 404) {
    const t = await r.text().catch(() => '');
    throw new Error(`r2 deleteObject failed: ${r.status} ${t.slice(0, 200)}`);
  }
  return { bucket, key, deleted: true };
}

export function publicUrl(key, opts = {}) {
  const bucket = opts.bucket || DEFAULT_BUCKET;
  if (PUBLIC_BASE) return `${PUBLIC_BASE.replace(/\/$/, '')}/${key}`;
  return `https://${bucket}.${ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`;
}

export { ACCOUNT_ID as accountId, DEFAULT_BUCKET as defaultBucket };
