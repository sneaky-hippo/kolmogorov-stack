// Wave 144 — `kolm extract` text extraction.
//
// Covers:
//   - plain text passthrough
//   - JSON / JSONL flatten to key: value lines
//   - HTML tag strip preserves paragraph breaks
//   - pure-JS PDF text-layer extractor on a synthesized digital PDF
//   - image extraction without --ocr/--vision fails cleanly
//   - extractFile returns the normalized { kind, text, sha256, warnings } shape

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { extractFile, classifyFile, extractPdfText, __testing } from '../src/extract.js';

const { stripHtml, extractJson, decodePdfString, findStreams } = __testing;

function tmpFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-extract-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return { path: p, dir };
}

// Build a minimal PDF with a single page that draws one Tj string. The
// content stream is FlateDecode-compressed so the extractor exercises its
// zlib path. xref offsets are computed at the byte level so the file is a
// valid PDF that any spec-conformant reader will open.
function buildDigitalPdf(visibleText) {
  const content = `BT /F1 12 Tf 100 700 Td (${visibleText.replace(/\(/g, '\\(').replace(/\)/g, '\\)')}) Tj ET\n`;
  const compressed = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const objects = [];
  const add = (body) => objects.push(body);
  add(`<< /Type /Catalog /Pages 2 0 R >>`);
  add(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`);
  // object 4: the compressed content stream (built specially because the body is bytes).
  add({ stream: true, dict: `<< /Length ${compressed.length} /Filter /FlateDecode >>`, data: compressed });
  add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  const parts = [];
  parts.push(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    const off = parts.reduce((a, b) => a + b.length, 0);
    offsets.push(off);
    const o = objects[i];
    if (typeof o === 'string') {
      parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1'));
    } else {
      parts.push(Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'));
      parts.push(o.data);
      parts.push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    }
  }
  const xrefOffset = parts.reduce((a, b) => a + b.length, 0);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  parts.push(Buffer.from(xref, 'latin1'));
  parts.push(Buffer.from(`trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

test('classifyFile: recognises common extensions', () => {
  assert.equal(classifyFile('a.txt'), 'text');
  assert.equal(classifyFile('a.md'), 'text');
  assert.equal(classifyFile('a.json'), 'json');
  assert.equal(classifyFile('a.jsonl'), 'json');
  assert.equal(classifyFile('a.html'), 'html');
  assert.equal(classifyFile('a.pdf'), 'pdf');
  assert.equal(classifyFile('a.png'), 'image');
  assert.equal(classifyFile('a.jpeg'), 'image');
  assert.equal(classifyFile('a.bin'), 'unknown');
});

test('extractFile: plain text passes through unchanged', async () => {
  const { path: p, dir } = tmpFile('a.txt', 'hello world\nsecond line\n');
  try {
    const r = await extractFile(p);
    assert.equal(r.kind, 'text');
    assert.equal(r.text, 'hello world\nsecond line\n');
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(r.warnings, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('extractFile: JSON flattens to key: value lines', async () => {
  const obj = { task: 'denial-letter', patient: { name: 'Jane Doe', mrn: 'MRN-1' } };
  const { path: p, dir } = tmpFile('a.json', JSON.stringify(obj));
  try {
    const r = await extractFile(p);
    assert.equal(r.kind, 'json');
    assert.match(r.text, /task: denial-letter/);
    assert.match(r.text, /name: Jane Doe/);
    assert.match(r.text, /mrn: MRN-1/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('extractFile: JSONL emits one flattened block per line', async () => {
  const jsonl = '{"input":"hi"}\n{"input":"there","tags":["a","b"]}\n';
  const { path: p, dir } = tmpFile('a.jsonl', jsonl);
  try {
    const r = await extractFile(p);
    assert.equal(r.kind, 'json');
    assert.match(r.text, /input: hi/);
    assert.match(r.text, /input: there/);
    assert.match(r.text, /tags: a\nb/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('extractFile: HTML strips tags + decodes entities + keeps paragraph breaks', async () => {
  const html = '<html><body><h1>Title</h1><p>First &amp; only.</p><script>alert(1)</script><p>Second.</p></body></html>';
  const { path: p, dir } = tmpFile('a.html', html);
  try {
    const r = await extractFile(p);
    assert.equal(r.kind, 'html');
    assert.match(r.text, /Title/);
    assert.match(r.text, /First & only\./);
    assert.match(r.text, /Second\./);
    assert.ok(!/alert\(1\)/.test(r.text), 'script body must be dropped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stripHtml: numeric and hex entities decode', () => {
  assert.equal(stripHtml('<p>&#65;&#x42;C</p>'), 'ABC');
});

test('decodePdfString: literal escapes + octal + hex strings', () => {
  assert.equal(decodePdfString('(hello)').toString('latin1'), 'hello');
  assert.equal(decodePdfString('(line1\\nline2)').toString('latin1'), 'line1\nline2');
  assert.equal(decodePdfString('(\\101\\102C)').toString('latin1'), 'ABC');
  assert.equal(decodePdfString('<48656c6c6f>').toString('latin1'), 'Hello');
});

test('findStreams: locates the content stream in a synthetic PDF', () => {
  const pdf = buildDigitalPdf('hello world');
  const streams = findStreams(pdf);
  assert.ok(streams.length >= 1, 'expected at least one stream');
  assert.match(streams[0].dictText, /\/FlateDecode/);
});

test('extractPdfText: pulls visible text from a flate-compressed content stream', () => {
  const pdf = buildDigitalPdf('Health insurance claim 12345');
  const { text, pages, warnings } = extractPdfText(pdf);
  assert.match(text, /Health insurance claim 12345/);
  assert.equal(pages, 1);
  assert.deepEqual(warnings, []);
});

test('extractFile: image without --ocr or --vision throws a clear error', async () => {
  // 1x1 transparent PNG.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082', 'hex');
  const { path: p, dir } = tmpFile('pixel.png', png);
  try {
    await assert.rejects(() => extractFile(p), /--ocr.*--vision/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('extractFile: extracts text from a built PDF end-to-end', async () => {
  const pdf = buildDigitalPdf('Patient appeal letter draft.');
  const { path: p, dir } = tmpFile('appeal.pdf', pdf);
  try {
    const r = await extractFile(p);
    assert.equal(r.kind, 'pdf');
    assert.match(r.text, /Patient appeal letter draft\./);
    assert.equal(r.pages, 1);
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('extractJson: malformed JSON falls back to raw utf-8', () => {
  const t = extractJson(Buffer.from('this is not json'));
  assert.equal(t, 'this is not json');
});

test('extractFile: unknown extension returns kind=unknown with warning', async () => {
  const { path: p, dir } = tmpFile('mystery.bin', Buffer.from('some bytes'));
  try {
    const r = await extractFile(p);
    assert.equal(r.kind, 'unknown');
    assert.equal(r.text, 'some bytes');
    assert.ok(r.warnings.includes('unknown_kind_treating_as_utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
