// Text extraction for .kolm pipelines.
//
// `kolm extract <file>` pulls text out of PDFs, HTML, plain text, JSON/JSONL,
// and (with --ocr or --vision) images and scanned PDFs.
//
// Design constraints:
//   - Pure JS for the base case. No native deps, no Python, no toolchain.
//   - PDF path: minimal stream parser that handles digitally-generated PDFs
//     (Word, LaTeX, browser print-to-PDF). It does NOT handle CID/ToUnicode
//     fonts, encrypted PDFs, or image-only/scanned PDFs.
//   - OCR path: shells out to `tesseract` if present (system install).
//     This is opt-in via --ocr so the base build never requires tesseract.
//   - Vision path: posts to Anthropic vision endpoint when --vision is set
//     AND ANTHROPIC_API_KEY is present. Also opt-in.
//
// The output is a normalized `{ kind, text, pages?, source, sha256, warnings[] }`
// shape so downstream tooling (seed bootstrap, doc-check, RAG ingest) can
// consume one schema regardless of input file type.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.tsv', '.log', '.text', '.rst']);
const HTML_EXTS = new Set(['.html', '.htm', '.xhtml', '.xml']);
const JSON_EXTS = new Set(['.json', '.jsonl', '.ndjson']);
const PDF_EXTS  = new Set(['.pdf']);
const IMG_EXTS  = new Set(['.png', '.jpg', '.jpeg', '.gif', '.tif', '.tiff', '.webp', '.bmp']);

export function classifyFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTS.has(ext)) return 'text';
  if (HTML_EXTS.has(ext)) return 'html';
  if (JSON_EXTS.has(ext)) return 'json';
  if (PDF_EXTS.has(ext))  return 'pdf';
  if (IMG_EXTS.has(ext))  return 'image';
  return 'unknown';
}

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// --------------------- text/HTML/JSON ---------------------

function stripHtml(s) {
  // Remove scripts/styles entirely (they aren't readable text).
  let out = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
             .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
             .replace(/<!--[\s\S]*?-->/g, ' ');
  // Convert block tags to newlines so paragraph structure survives.
  out = out.replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n')
           .replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<[^>]+>/g, ' ');
  out = out.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
           .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  return out.replace(/[ \t\f\v]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractJson(buf) {
  const text = buf.toString('utf-8').trim();
  if (!text) return '';
  // Try whole-doc JSON first; if that succeeds and the doc is a single
  // value (not a stream of values), use it.
  try { return stringifyAnyJson(JSON.parse(text)); }
  catch { /* fall through to JSONL */ }
  // JSONL/NDJSON: one JSON value per line. Accept only if every non-empty
  // line parses; otherwise return raw text.
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) return text;
  const parsed = [];
  for (const ln of lines) {
    try { parsed.push(JSON.parse(ln)); }
    catch { return text; }
  }
  return parsed.map(stringifyAnyJson).join('\n');
}

function stringifyAnyJson(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(stringifyAnyJson).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    const parts = [];
    for (const k of Object.keys(v)) {
      const child = stringifyAnyJson(v[k]);
      if (child) parts.push(`${k}: ${child}`);
    }
    return parts.join('\n');
  }
  return '';
}

// --------------------- PDF ---------------------

// Find every `stream`...`endstream` block in a PDF buffer. PDFs are mostly
// 7-bit ASCII with binary blobs in streams, so byte-wise indexOf is safe.
function findStreams(buf) {
  const streams = [];
  let i = 0;
  while (i < buf.length) {
    const startTok = buf.indexOf('stream', i);
    if (startTok < 0) break;
    // skip exactly one newline after `stream` (PDF spec: \r\n or \n).
    let dataStart = startTok + 'stream'.length;
    if (buf[dataStart] === 0x0d && buf[dataStart + 1] === 0x0a) dataStart += 2;
    else if (buf[dataStart] === 0x0a) dataStart += 1;
    else if (buf[dataStart] === 0x0d) dataStart += 1;
    const endTok = buf.indexOf('endstream', dataStart);
    if (endTok < 0) break;
    // trim trailing newline before endstream.
    let dataEnd = endTok;
    if (buf[dataEnd - 1] === 0x0a) dataEnd -= 1;
    if (buf[dataEnd - 1] === 0x0d) dataEnd -= 1;
    // peek backward for the preceding dict so we know the Filter.
    const dictEnd = startTok;
    const dictStart = lastIndexOfBytes(buf, '<<', dictEnd);
    const dictText = dictStart >= 0 ? buf.slice(dictStart, dictEnd).toString('latin1') : '';
    streams.push({ dictText, data: buf.slice(dataStart, dataEnd) });
    i = endTok + 'endstream'.length;
  }
  return streams;
}

function lastIndexOfBytes(buf, needle, beforeIndex) {
  const needleBuf = Buffer.from(needle, 'latin1');
  let pos = -1;
  let from = 0;
  while (true) {
    const idx = buf.indexOf(needleBuf, from);
    if (idx < 0 || idx >= beforeIndex) break;
    pos = idx;
    from = idx + 1;
  }
  return pos;
}

function inflateOrPass(data, dictText) {
  const flate = /\/(FlateDecode|Fl)\b/.test(dictText);
  if (!flate) return data;
  try { return zlib.inflateSync(data); }
  catch { return null; }
}

// Decode a PDF literal string `(...)` or hex string `<...>`. Returns Buffer.
function decodePdfString(s) {
  if (s.length >= 2 && s[0] === '<' && s[s.length - 1] === '>') {
    let hex = s.slice(1, -1).replace(/\s+/g, '');
    if (hex.length % 2 === 1) hex += '0';
    const out = Buffer.alloc(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) out[i >> 1] = parseInt(hex.slice(i, i + 2), 16);
    return out;
  }
  if (s.length >= 2 && s[0] === '(' && s[s.length - 1] === ')') {
    const body = s.slice(1, -1);
    const out = [];
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '\\') {
        const n = body[i + 1];
        if (n === 'n') { out.push(0x0a); i++; }
        else if (n === 'r') { out.push(0x0d); i++; }
        else if (n === 't') { out.push(0x09); i++; }
        else if (n === 'b') { out.push(0x08); i++; }
        else if (n === 'f') { out.push(0x0c); i++; }
        else if (n === '(') { out.push(0x28); i++; }
        else if (n === ')') { out.push(0x29); i++; }
        else if (n === '\\') { out.push(0x5c); i++; }
        else if (n >= '0' && n <= '7') {
          let oct = n; i++;
          if (body[i + 1] >= '0' && body[i + 1] <= '7') { oct += body[i + 1]; i++; }
          if (body[i + 1] >= '0' && body[i + 1] <= '7') { oct += body[i + 1]; i++; }
          out.push(parseInt(oct, 8) & 0xff);
        } else { /* unknown escape: drop backslash */ }
      } else {
        out.push(c.charCodeAt(0) & 0xff);
      }
    }
    return Buffer.from(out);
  }
  return Buffer.alloc(0);
}

// Walk a content stream looking for `(...)Tj`, `[...]TJ`, `(...) '`, `(...) "`.
function extractTextFromContentStream(buf) {
  const text = buf.toString('latin1');
  const out = [];
  // Single regex catches both literal `(...)` and hex `<...>` operands as
  // well as TJ arrays. We then post-filter to keep only Tj/TJ/'/" operators.
  // Match operands then look ahead for the operator.
  const opRe = /(\([^)\\]*(?:\\.[^)\\]*)*\)|<[0-9A-Fa-f\s]*>|\[(?:[^\[\]\\]|\\.)*\])\s*(Tj|TJ|'|")/g;
  let m;
  while ((m = opRe.exec(text)) !== null) {
    const operand = m[1];
    const op = m[2];
    if (operand[0] === '[') {
      // TJ array: collect strings, ignore numbers (kerning adjusts).
      const inner = operand.slice(1, -1);
      const strRe = /(\([^)\\]*(?:\\.[^)\\]*)*\)|<[0-9A-Fa-f\s]*>)/g;
      let s;
      while ((s = strRe.exec(inner)) !== null) {
        out.push(decodePdfString(s[1]).toString('latin1'));
      }
    } else {
      out.push(decodePdfString(operand).toString('latin1'));
      if (op === "'" || op === '"') out.push('\n');
    }
  }
  return out.join('');
}

export function extractPdfText(buf) {
  const streams = findStreams(buf);
  const warnings = [];
  let textOut = '';
  let pageCount = 0;
  for (const s of streams) {
    // Skip non-content streams (XRef, Metadata, Image).
    if (/\/(XObject|Image|XRef|Metadata|EmbeddedFile|JBIG2Decode|DCTDecode|CCITTFaxDecode|RunLengthDecode)\b/.test(s.dictText)) continue;
    const data = inflateOrPass(s.data, s.dictText);
    if (!data) { warnings.push('inflate_failed'); continue; }
    // Heuristic: only treat streams that contain `Tj`/`TJ` as content streams.
    const probe = data.length > 4096 ? data.slice(0, 4096).toString('latin1') : data.toString('latin1');
    if (!/\b(Tj|TJ)\b/.test(probe) && !/'|"/.test(probe)) continue;
    pageCount += 1;
    const piece = extractTextFromContentStream(data);
    if (piece) textOut += piece + '\n';
  }
  // Best-effort cleanup. Multiple spaces, runs of newlines, leading whitespace.
  textOut = textOut.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: textOut, pages: pageCount, warnings };
}

// --------------------- OCR (tesseract) ---------------------

export function tesseractAvailable() {
  const r = spawnSync('tesseract', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

export function ocrWithTesseract(filePath, opts = {}) {
  const lang = opts.lang || 'eng';
  const r = spawnSync('tesseract', [filePath, 'stdout', '-l', lang], { encoding: 'utf-8' });
  if (r.status !== 0) {
    const err = (r.stderr || '').trim() || `tesseract exited ${r.status}`;
    throw new Error(`tesseract failed: ${err}`);
  }
  return r.stdout.trim();
}

// --------------------- Vision (Anthropic) ---------------------

export async function ocrWithVision(filePath, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const bytes = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mime = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' })[ext] || 'application/octet-stream';
  const model = opts.model || 'claude-opus-4-7';
  const body = {
    model,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: mime === 'application/pdf' ? 'document' : 'image',
          source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } },
        { type: 'text', text: 'Transcribe all readable text from this file. Output plain text only, no commentary, preserving line breaks.' },
      ],
    }],
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return text;
}

// --------------------- top-level ---------------------

export async function extractFile(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`not found: ${filePath}`);
  const bytes = fs.readFileSync(filePath);
  const sha256 = sha256Bytes(bytes);
  const kind = classifyFile(filePath);
  const warnings = [];

  if (kind === 'text') {
    return { kind, text: bytes.toString('utf-8'), source: filePath, sha256, warnings };
  }
  if (kind === 'json') {
    return { kind, text: extractJson(bytes), source: filePath, sha256, warnings };
  }
  if (kind === 'html') {
    return { kind, text: stripHtml(bytes.toString('utf-8')), source: filePath, sha256, warnings };
  }
  if (kind === 'pdf') {
    const { text, pages, warnings: pwarn } = extractPdfText(bytes);
    warnings.push(...pwarn);
    if (text && text.length > 0) {
      return { kind, text, pages, source: filePath, sha256, warnings };
    }
    // Fall through to OCR if requested.
    if (opts.ocr) {
      if (!tesseractAvailable()) throw new Error('--ocr requested but `tesseract` is not on PATH');
      warnings.push('pdf_no_text_layer_using_ocr');
      const ocrText = ocrWithTesseract(filePath, opts);
      return { kind, text: ocrText, pages: 0, source: filePath, sha256, warnings };
    }
    if (opts.vision) {
      warnings.push('pdf_no_text_layer_using_vision');
      const vt = await ocrWithVision(filePath, opts);
      return { kind, text: vt, pages: 0, source: filePath, sha256, warnings };
    }
    warnings.push('pdf_no_text_layer');
    return { kind, text: '', pages: 0, source: filePath, sha256, warnings };
  }
  if (kind === 'image') {
    if (opts.ocr) {
      if (!tesseractAvailable()) throw new Error('--ocr requested but `tesseract` is not on PATH');
      const t = ocrWithTesseract(filePath, opts);
      return { kind, text: t, source: filePath, sha256, warnings };
    }
    if (opts.vision) {
      const t = await ocrWithVision(filePath, opts);
      return { kind, text: t, source: filePath, sha256, warnings };
    }
    throw new Error(`image extraction requires --ocr (tesseract) or --vision (Anthropic API)`);
  }
  // unknown: try text decode as last resort
  warnings.push('unknown_kind_treating_as_utf8');
  return { kind: 'unknown', text: bytes.toString('utf-8'), source: filePath, sha256, warnings };
}

export const __testing = { stripHtml, extractJson, decodePdfString, findStreams, extractTextFromContentStream };
