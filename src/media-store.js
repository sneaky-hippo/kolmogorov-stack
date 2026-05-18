// W377 — media-store: content-addressable blob storage for multimodal captures.
//
// Heavy bytes (PDFs, screenshots, audio clips, video frames, browser traces)
// do NOT live in the events SQLite/JSONL log. They live on disk at
//   ~/.kolm/events/raw/<sha256>.<ext>
// and the event row points at them with media_uri. This keeps the events
// table small + fast and lets the OCR / whisper / pdf-text workers process
// blobs out of band.
//
// Honors:
//   - KOLM_DATA_DIR (overrides ~/.kolm — same env var event-store.js reads)
//   - KOLM_MEDIA_DIR (overrides ~/.kolm/events/raw entirely)
//   - HOME / USERPROFILE
//
// Public API:
//   storeBlob(buffer, {mime, kind})   -> {uri, hash, bytes, mime, kind}
//   loadBlob(uri)                      -> Buffer
//   blobExists(uri)                    -> boolean
//   deleteBlob(uri)                    -> void (idempotent)
//   listBlobs()                        -> [{uri, hash, bytes, mime, ext}]
//   extToMime(ext)                     -> string
//   mimeToExt(mime)                    -> string
//
// Zero npm deps. Pure node:fs/promises + node:crypto + node:path.
// URI scheme: 'file:' + absolute-path (e.g. file:/home/u/.kolm/events/raw/abc.pdf
// on POSIX, file:C:/Users/u/.kolm/events/raw/abc.pdf on Windows). The same uri
// resolves both before AND after a process restart because the path is
// deterministic from sha256 + ext.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Minimal mime <-> ext table covering everything the multimodal schema knows
// about. The pairs below are the ones we actively persist; anything not in
// the table falls back to 'application/octet-stream' / '.bin' so we never
// crash on an unknown blob.
const MIME_TO_EXT = {
  // text / log / code / structured
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/jsonl': 'jsonl',
  'application/x-ndjson': 'jsonl',
  'application/xml': 'xml',
  'application/yaml': 'yaml',
  'text/x-yaml': 'yaml',
  // documents
  'application/pdf': 'pdf',
  // images
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'image/avif': 'avif',
  // audio
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'audio/flac': 'flac',
  // video
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  // traces / tool output
  'application/x-har': 'har',
  'application/har+json': 'har',
  'application/x-terminal-output': 'ansi',
  'application/x-tool-output': 'tool.json',
  'application/octet-stream': 'bin',
};

const EXT_TO_MIME = (() => {
  const out = {};
  for (const [mime, ext] of Object.entries(MIME_TO_EXT)) {
    // First-write wins so that e.g. 'wav' always maps to audio/wav not audio/x-wav.
    if (!out[ext]) out[ext] = mime;
  }
  // Common shorthand the table above might not list directly.
  out.jpeg = 'image/jpeg';
  out.txt = 'text/plain';
  out.md = 'text/markdown';
  out.html = 'text/html';
  out.csv = 'text/csv';
  return out;
})();

export function extToMime(ext) {
  if (!ext) return 'application/octet-stream';
  const e = String(ext).toLowerCase().replace(/^\./, '');
  return EXT_TO_MIME[e] || 'application/octet-stream';
}

export function mimeToExt(mime) {
  if (!mime) return 'bin';
  const m = String(mime).toLowerCase().split(';')[0].trim();
  return MIME_TO_EXT[m] || 'bin';
}

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

// Resolve the on-disk root for blobs. Honors KOLM_MEDIA_DIR > KOLM_DATA_DIR >
// ~/.kolm. We DON'T cache the result because tests rewrite KOLM_DATA_DIR per
// case via fs.mkdtempSync and need every call to land in the fresh dir.
function _mediaDir() {
  if (process.env.KOLM_MEDIA_DIR) return path.resolve(process.env.KOLM_MEDIA_DIR);
  const base = process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
  return path.join(base, 'events', 'raw');
}

async function _ensureDir() {
  const dir = _mediaDir();
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function _sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Translate a 'file:<abs-path>' URI back into an absolute filesystem path.
// We accept both 'file:/...' (no host) and bare absolute paths so callers that
// have the path already don't have to round-trip through new URL().
function _uriToPath(uri) {
  if (!uri) throw new Error('uri required');
  const s = String(uri);
  if (s.startsWith('file:')) return s.slice('file:'.length);
  return s;
}

function _pathToUri(p) {
  return 'file:' + p;
}

// storeBlob(buffer, {mime, kind}) — content-addressable write. Writes to
// <mediaDir>/<sha256>.<ext>. If the file already exists (same content) we
// skip the write and just return the same descriptor — deterministic by
// design. kind is echoed back so callers can stash it on the event row
// without a second lookup; we do NOT persist it on disk because the event
// table already owns the kind field.
export async function storeBlob(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer)) {
    if (typeof buffer === 'string') buffer = Buffer.from(buffer, 'utf8');
    else if (buffer instanceof Uint8Array) buffer = Buffer.from(buffer);
    else throw new Error('storeBlob: buffer must be a Buffer / Uint8Array / string');
  }
  const mime = opts.mime || 'application/octet-stream';
  const kind = opts.kind || null;
  const ext = mimeToExt(mime);
  const hash = _sha256(buffer);
  const dir = await _ensureDir();
  const filename = hash + '.' + ext;
  const abs = path.join(dir, filename);
  // Skip the write if we already have this byte sequence on disk.
  let already = false;
  try { await fsp.stat(abs); already = true; } catch {}
  if (!already) {
    // writeFile is atomic enough for our purposes — single fs.write under the
    // hood — and idempotent on retry because the filename is content-addressed.
    await fsp.writeFile(abs, buffer);
  }
  return {
    uri: _pathToUri(abs),
    hash,
    bytes: buffer.length,
    mime,
    kind,
    ext,
  };
}

export async function loadBlob(uri) {
  const p = _uriToPath(uri);
  return fsp.readFile(p);
}

export function blobExists(uri) {
  try {
    const p = _uriToPath(uri);
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export async function deleteBlob(uri) {
  try {
    const p = _uriToPath(uri);
    await fsp.unlink(p);
  } catch (e) {
    // Idempotent: ENOENT is a no-op. Any other error surfaces.
    if (!e || e.code !== 'ENOENT') {
      // Swallow the error rather than throw — the caller asked for delete,
      // and a missing file is "already deleted" semantically.
      if (e && e.code !== 'ENOENT') return;
    }
  }
}

// listBlobs() — enumerate everything currently in the media dir. Returns one
// row per file with {uri, hash, bytes, mime, ext}. The hash is parsed from
// the filename rather than recomputed so listing is O(files), not O(bytes).
export async function listBlobs() {
  let entries = [];
  try {
    entries = await fsp.readdir(_mediaDir());
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of entries) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) continue;
    // Composite extensions like 'tool.json' need a 2-segment match.
    let ext = name.slice(dot + 1).toLowerCase();
    let hash = name.slice(0, dot);
    // Re-check for composite ext (tool.json — two-segment).
    const compositeDot = hash.lastIndexOf('.');
    if (compositeDot > 0) {
      const composite = hash.slice(compositeDot + 1) + '.' + ext;
      if (EXT_TO_MIME[composite]) {
        ext = composite;
        hash = hash.slice(0, compositeDot);
      }
    }
    const abs = path.join(_mediaDir(), name);
    let bytes = 0;
    try { bytes = (await fsp.stat(abs)).size; } catch { continue; }
    out.push({
      uri: _pathToUri(abs),
      hash,
      bytes,
      mime: extToMime(ext),
      ext,
    });
  }
  return out;
}
