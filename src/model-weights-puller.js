// W386 — model-weights puller.
//
// Streaming download of GGUF / safetensors files from HuggingFace, with:
//   - resumable Range requests (re-pulls a partial file from byte N)
//   - sha256 verification when the manifest row provides one
//   - HEAD/Range bytes=0-1023 reachability probe (fail-fast on 404/403)
//   - parallel-by-variant prefetch with a hard concurrency cap
//   - on-disk cache index at ~/.kolm/models/index.json so list/clear works
//     without re-walking the directory tree
//
// W305/W348 lesson — DO NOT use global fetch(). Streaming over many MB on
// Windows with the undici keep-alive pool crashes libuv on process.exit
// with STATUS_STACK_BUFFER_OVERRUN. Everything here is node:https request
// → IncomingMessage stream → fs.WriteStream. No fetch, no AbortController,
// no dispatcher.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';

import { ALL_VARIANTS, getVariant, hfResolveUrl, fmtBytes, variantsFor, listVariantsByTier } from './model-weights-manifest.js';

const DEFAULT_USER_AGENT = 'kolm.ai/W386-model-prefetch';
const DEFAULT_TIMEOUT_MS = 60_000;

export function defaultCacheDir() {
  return process.env.KOLM_MODELS_DIR || path.join(os.homedir(), '.kolm', 'models');
}

export function ensureCacheDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Disk index — single JSON file at <cacheDir>/index.json. Each entry keys on
// `${model_id}::${variant}::${file_path}` and records bytes + downloaded_at +
// sha256 (or null if unverified). Light enough to rewrite atomically on each
// successful pull.
export function indexPath(cacheDir) {
  return path.join(cacheDir, 'index.json');
}

export function loadIndex(cacheDir) {
  const p = indexPath(cacheDir);
  if (!fs.existsSync(p)) return { entries: {}, version: 1 };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const idx = JSON.parse(raw);
    if (!idx || typeof idx !== 'object') return { entries: {}, version: 1 };
    if (!idx.entries) idx.entries = {};
    return idx;
  } catch (_) {
    return { entries: {}, version: 1 };
  }
}

export function saveIndex(cacheDir, idx) {
  const p = indexPath(cacheDir);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, p);
}

export function cacheKey(model_id, variant, file_path) {
  return `${model_id}::${variant}::${file_path}`;
}

// Local on-disk path for a manifest file. We slugify the repo so different
// fallback repos for the same model_id don't stomp.
export function localPathFor(cacheDir, row, file) {
  const slug = (row.model_id + '__' + row.variant).replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(cacheDir, slug, path.basename(file.path));
}

// ---------------------------------------------------------------------------
// Network primitives — all node:https / node:http. Follows redirects (HF
// resolve URLs 302 to a signed S3/cdn-lfs URL).
// ---------------------------------------------------------------------------

function pickLib(urlStr) {
  return urlStr.startsWith('https:') ? https : http;
}

// One request. Resolves with { statusCode, headers, res }. Caller drains `res`.
// Caller is responsible for handling redirects.
function request(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = pickLib(urlStr);
    const headers = { 'User-Agent': DEFAULT_USER_AGENT, ...(opts.headers || {}) };
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: opts.method || 'GET',
      headers,
    }, (res) => {
      resolve({ statusCode: res.statusCode || 0, headers: res.headers, res });
    });
    req.setTimeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS, () => {
      try { req.destroy(new Error('timeout')); } catch (_) {}
    });
    req.on('error', reject);
    req.end();
  });
}

// Follow up to N redirects. Returns the final {statusCode, headers, res}
// with res positioned to read the body.
export async function requestFollow(urlStr, opts = {}, maxHops = 5) {
  let url = urlStr;
  for (let i = 0; i <= maxHops; i++) {
    const r = await request(url, opts);
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      // Drain the redirect body and continue.
      r.res.resume();
      const next = new URL(r.headers.location, url).toString();
      url = next;
      continue;
    }
    return r;
  }
  throw new Error(`too many redirects from ${urlStr}`);
}

// Probe a single file (Range bytes=0-1023). Returns:
//   { ok: true, statusCode, contentLength|null }
//   { ok: false, statusCode, reason }
export async function probeFile(urlStr, opts = {}) {
  try {
    const r = await requestFollow(urlStr, {
      method: 'GET',
      headers: { Range: 'bytes=0-1023', ...(opts.headers || {}) },
      timeoutMs: opts.timeoutMs || 15_000,
    });
    // Drain — we don't need the body.
    r.res.resume();
    const contentRange = r.headers['content-range'];
    let total = null;
    if (contentRange) {
      const m = /\/(\d+)\s*$/.exec(contentRange);
      if (m) total = Number(m[1]);
    }
    if (r.statusCode >= 200 && r.statusCode < 300) {
      return { ok: true, statusCode: r.statusCode, contentLength: total };
    }
    return { ok: false, statusCode: r.statusCode, reason: 'http_' + r.statusCode };
  } catch (e) {
    return { ok: false, statusCode: 0, reason: 'network:' + (e && e.message || 'unknown') };
  }
}

// Probe all files of a variant. Returns true if every file is reachable.
export async function probeVariant(row) {
  const results = [];
  for (const f of row.files) {
    const url = hfResolveUrl(row.hf_repo, row.hf_revision, f.path);
    const probe = await probeFile(url);
    results.push({ file: f.path, url, ...probe });
    if (!probe.ok) break;
  }
  const ok = results.every((r) => r.ok);
  return { ok, results };
}

// ---------------------------------------------------------------------------
// Streaming download. Supports resume via Range. Verifies sha256 if provided.
// Atomic: writes to <dest>.part, then renames to <dest> on success.
//
// onProgress({ bytes_done, bytes_total, file }) — called every ~256KB.
// ---------------------------------------------------------------------------
export async function pullFile({ row, file, cacheDir, onProgress, timeoutMs }) {
  const url = hfResolveUrl(row.hf_repo, row.hf_revision, file.path);
  const dest = localPathFor(cacheDir, row, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';

  // Already complete?
  if (fs.existsSync(dest)) {
    const sz = fs.statSync(dest).size;
    if (file.bytes && sz === file.bytes) {
      return { ok: true, bytes: sz, path: dest, resumed: false, already_cached: true };
    }
    // Size mismatch — re-download.
    try { fs.unlinkSync(dest); } catch (_) {}
  }

  // Resume?
  let already = 0;
  if (fs.existsSync(part)) {
    already = fs.statSync(part).size;
    if (file.bytes && already >= file.bytes) {
      // Treat as complete, just promote.
      fs.renameSync(part, dest);
      return { ok: true, bytes: already, path: dest, resumed: true, already_cached: false };
    }
  }

  const headers = {};
  if (already > 0) headers.Range = `bytes=${already}-`;
  const r = await requestFollow(url, { method: 'GET', headers, timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS });
  if (r.statusCode === 416) {
    // Range not satisfiable — server says we've already got the whole thing.
    fs.renameSync(part, dest);
    return { ok: true, bytes: already, path: dest, resumed: true, already_cached: false };
  }
  if (r.statusCode < 200 || r.statusCode >= 300) {
    r.res.resume();
    const err = new Error(`http_${r.statusCode} for ${url}`);
    err.statusCode = r.statusCode;
    throw err;
  }

  // Validate we got a partial-response if we asked for one.
  if (already > 0 && r.statusCode !== 206) {
    // Server ignored Range — start over.
    try { fs.unlinkSync(part); } catch (_) {}
    already = 0;
  }

  const totalLen = (() => {
    const cl = Number(r.headers['content-length'] || 0);
    if (r.statusCode === 206 && r.headers['content-range']) {
      const m = /\/(\d+)\s*$/.exec(r.headers['content-range']);
      if (m) return Number(m[1]);
    }
    return cl + already;
  })();

  return await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(part, { flags: already > 0 ? 'a' : 'w' });
    let bytesDone = already;
    let lastProgress = 0;
    const hash = crypto.createHash('sha256');
    // sha256 only verifiable when we DOWNLOADED the full file (not a resume).
    const verifySha = !!file.sha256 && already === 0;

    r.res.on('data', (chunk) => {
      if (verifySha) hash.update(chunk);
      bytesDone += chunk.length;
      const since = bytesDone - lastProgress;
      if (onProgress && since > 256 * 1024) {
        lastProgress = bytesDone;
        try { onProgress({ bytes_done: bytesDone, bytes_total: totalLen, file: file.path }); } catch (_) {}
      }
    });
    r.res.on('error', (e) => {
      try { ws.destroy(); } catch (_) {}
      reject(e);
    });
    r.res.pipe(ws);
    ws.on('finish', () => {
      if (onProgress) try { onProgress({ bytes_done: bytesDone, bytes_total: totalLen, file: file.path }); } catch (_) {}
      if (verifySha) {
        const actual = hash.digest('hex');
        if (actual !== file.sha256) {
          try { fs.unlinkSync(part); } catch (_) {}
          return reject(new Error(`sha256_mismatch expected=${file.sha256} actual=${actual}`));
        }
      }
      try { fs.renameSync(part, dest); } catch (e) { return reject(e); }
      resolve({ ok: true, bytes: bytesDone, path: dest, resumed: already > 0, already_cached: false });
    });
    ws.on('error', (e) => reject(e));
  });
}

// Pull an entire variant (all files). Updates the on-disk cache index.
// Returns { ok, files: [...], total_bytes }.
export async function pullVariant({ row, cacheDir, onProgress, probe = true, timeoutMs }) {
  cacheDir = cacheDir || defaultCacheDir();
  ensureCacheDir(cacheDir);
  if (probe) {
    const p = await probeVariant(row);
    if (!p.ok) {
      const first = p.results.find((r) => !r.ok);
      return { ok: false, reason: 'probe_failed', detail: first };
    }
  }
  const files = [];
  let totalBytes = 0;
  for (const f of row.files) {
    try {
      const res = await pullFile({ row, file: f, cacheDir, onProgress, timeoutMs });
      files.push({ file: f.path, ok: true, bytes: res.bytes, already_cached: res.already_cached, path: res.path });
      totalBytes += res.bytes;
      // Re-read index just before write so we merge with any concurrent
      // worker's updates instead of clobbering them (prefetch concurrency=3+).
      const idx = loadIndex(cacheDir);
      idx.entries[cacheKey(row.model_id, row.variant, f.path)] = {
        model_id: row.model_id,
        variant: row.variant,
        file: f.path,
        bytes: res.bytes,
        path: res.path,
        sha256: f.sha256 || null,
        downloaded_at: new Date().toISOString(),
      };
      saveIndex(cacheDir, idx);
    } catch (e) {
      files.push({ file: f.path, ok: false, reason: String(e.message || e) });
      return { ok: false, files, total_bytes: totalBytes, reason: 'pull_failed', detail: e.message };
    }
  }
  return { ok: true, files, total_bytes: totalBytes };
}

// List what is on disk. Returns array of {key, model_id, variant, file, bytes,
// path, downloaded_at}.
export function listCache(cacheDir) {
  cacheDir = cacheDir || defaultCacheDir();
  if (!fs.existsSync(indexPath(cacheDir))) return [];
  const idx = loadIndex(cacheDir);
  return Object.entries(idx.entries).map(([key, e]) => ({ key, ...e }));
}

// Total cached bytes.
export function cacheTotalBytes(cacheDir) {
  return listCache(cacheDir).reduce((a, e) => a + (e.bytes || 0), 0);
}

// Rebuild the index from what is actually on disk. Useful after a crash or a
// stale-index race condition: walks the cache dir, matches each `{slug}/{file}`
// against the manifest, and rebuilds index.json so listCache() reflects truth.
// Returns { added, removed, total_bytes }.
export function rescanCache(cacheDir) {
  cacheDir = cacheDir || defaultCacheDir();
  if (!fs.existsSync(cacheDir)) return { added: 0, removed: 0, total_bytes: 0 };
  const added = [];
  const removed = [];
  const newEntries = {};
  // Build a lookup: slug -> row
  const slugIdx = new Map();
  for (const r of ALL_VARIANTS) {
    const slug = (r.model_id + '__' + r.variant).replace(/[^a-zA-Z0-9_.-]+/g, '_');
    slugIdx.set(slug, r);
  }
  for (const dirent of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const slug = dirent.name;
    const row = slugIdx.get(slug);
    if (!row) continue;
    const dirPath = path.join(cacheDir, slug);
    for (const f of row.files) {
      const dest = path.join(dirPath, f.path);
      if (!fs.existsSync(dest)) continue;
      const stat = fs.statSync(dest);
      const key = cacheKey(row.model_id, row.variant, f.path);
      newEntries[key] = {
        model_id: row.model_id,
        variant: row.variant,
        file: f.path,
        bytes: stat.size,
        path: dest,
        sha256: f.sha256 || null,
        downloaded_at: stat.mtime.toISOString(),
      };
      added.push(key);
    }
  }
  // Compare with old to compute removed.
  const prev = fs.existsSync(indexPath(cacheDir)) ? loadIndex(cacheDir) : { version: 1, entries: {} };
  for (const k of Object.keys(prev.entries)) {
    if (!newEntries[k]) removed.push(k);
  }
  saveIndex(cacheDir, { version: 1, entries: newEntries });
  const total_bytes = Object.values(newEntries).reduce((a, e) => a + (e.bytes || 0), 0);
  return { added: added.length, removed: removed.length, total_bytes, entries: Object.keys(newEntries).length };
}

// Remove a single model's cached files, or everything.
export function clearCache(cacheDir, modelId) {
  cacheDir = cacheDir || defaultCacheDir();
  const idx = loadIndex(cacheDir);
  const removed = [];
  for (const [key, e] of Object.entries(idx.entries)) {
    if (modelId && e.model_id !== modelId) continue;
    try { if (fs.existsSync(e.path)) fs.unlinkSync(e.path); } catch (_) {}
    // Remove the slug directory if empty.
    try {
      const dir = path.dirname(e.path);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch (_) {}
    delete idx.entries[key];
    removed.push(key);
  }
  saveIndex(cacheDir, idx);
  return { removed, count: removed.length };
}

// Prefetch a whole tier with concurrency. Skips variants already cached.
// onVariantStart({ row }) + onVariantDone({ row, result }) are optional.
// Returns { variants: [...], total_bytes_downloaded, failures: [...] }.
export async function prefetchTier({ tier, cacheDir, concurrency = 3, onVariantStart, onVariantDone, onProgress, probe = true, timeoutMs }) {
  cacheDir = cacheDir || defaultCacheDir();
  ensureCacheDir(cacheDir);
  const rows = listVariantsByTier(tier);
  const queue = rows.slice();
  const results = [];
  const failures = [];
  let totalBytesDownloaded = 0;

  async function worker() {
    while (queue.length > 0) {
      const row = queue.shift();
      if (!row) return;
      // Skip if all files already cached for this variant.
      const allCached = row.files.every((f) => {
        const dest = localPathFor(cacheDir, row, f);
        return fs.existsSync(dest) && (!f.bytes || fs.statSync(dest).size === f.bytes);
      });
      if (allCached) {
        const skipped = { ok: true, skipped: true, total_bytes: 0 };
        results.push({ row, result: skipped });
        if (onVariantDone) try { onVariantDone({ row, result: skipped }); } catch (_) {}
        continue;
      }
      if (onVariantStart) try { onVariantStart({ row }); } catch (_) {}
      try {
        const result = await pullVariant({ row, cacheDir, onProgress, probe, timeoutMs });
        results.push({ row, result });
        if (result.ok) totalBytesDownloaded += result.total_bytes;
        else failures.push({ row, result });
        if (onVariantDone) try { onVariantDone({ row, result }); } catch (_) {}
      } catch (e) {
        const result = { ok: false, reason: 'exception', detail: String(e.message || e) };
        results.push({ row, result });
        failures.push({ row, result });
        if (onVariantDone) try { onVariantDone({ row, result }); } catch (_) {}
      }
    }
  }
  const workers = [];
  const n = Math.max(1, Math.min(concurrency, rows.length));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return { variants: results, total_bytes_downloaded: totalBytesDownloaded, failures };
}

export default {
  DEFAULT_USER_AGENT,
  defaultCacheDir,
  ensureCacheDir,
  loadIndex,
  saveIndex,
  indexPath,
  cacheKey,
  localPathFor,
  requestFollow,
  probeFile,
  probeVariant,
  pullFile,
  pullVariant,
  listCache,
  cacheTotalBytes,
  clearCache,
  rescanCache,
  prefetchTier,
};
