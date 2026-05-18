// src/seeds-mining.js
//
// Wave 354 — Seed mining.
//
// Three importers that turn pre-existing customer artifacts into normalized
// (input, output) training rows. Every row carries a `source` field for
// provenance ("file:line", "chat:conversation-id", "capture:row-id"), and
// the array is deduplicated by sha256(input) before return.
//
// Exports:
//   mineFromDir(dir, opts)        — walk dir for .md/.txt/.json/.jsonl/.csv/.html
//   mineFromChat(jsonPath, opts)  — parse ChatGPT / Claude / generic chat export
//   mineFromCaptures(ns, opts)    — tenant-scoped capture rows -> (prompt, response)
//
// No new npm deps. Pure node:fs + tiny RFC4180 CSV parser inline.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const TEXT_EXTS = new Set(['.md', '.txt']);
const JSON_EXTS = new Set(['.json', '.jsonl', '.ndjson']);
const CSV_EXTS = new Set(['.csv', '.tsv']);
const HTML_EXTS = new Set(['.html', '.htm']);

function sha256(s) {
  return crypto.createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');
}

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || r.input == null || r.output == null) continue;
    const key = sha256(typeof r.input === 'string' ? r.input : JSON.stringify(r.input));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function walkDir(dir) {
  const out = [];
  async function recurse(d) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
        await recurse(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  await recurse(dir);
  return out;
}

// Heuristic paragraph-pair extractor for plain text / markdown.
// Looks for Q:/A:, Input:/Output:, Before:/After:, ##Example sections,
// code-block-paired // in / // out comments, and bullet-list pairs.
export function extractPairsFromText(text, filename) {
  const rows = [];
  const lines = String(text).split(/\r?\n/);

  // Pattern A: explicit prefix pairs. Greedy: prefix runs until blank or
  // until the next prefix word appears.
  const PAIR_PREFIXES = [
    [/^\s*(?:Q|Question)\s*[:\-]\s*/i, /^\s*(?:A|Answer)\s*[:\-]\s*/i],
    [/^\s*Input\s*[:\-]\s*/i, /^\s*Output\s*[:\-]\s*/i],
    [/^\s*Before\s*[:\-]\s*/i, /^\s*After\s*[:\-]\s*/i],
    [/^\s*Prompt\s*[:\-]\s*/i, /^\s*(?:Response|Completion|Reply)\s*[:\-]\s*/i],
    [/^\s*User\s*[:\-]\s*/i, /^\s*(?:Assistant|Bot|AI)\s*[:\-]\s*/i],
    [/^\s*Source\s*[:\-]\s*/i, /^\s*(?:Redacted|Target|Expected)\s*[:\-]\s*/i],
  ];

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    for (const [reIn, reOut] of PAIR_PREFIXES) {
      const mIn = ln.match(reIn);
      if (!mIn) continue;
      // Collect input lines until blank or matching output prefix found.
      let input = ln.slice(mIn[0].length);
      let j = i + 1;
      while (j < lines.length && !reOut.test(lines[j]) && lines[j].trim() !== '') {
        if (PAIR_PREFIXES.some(([p]) => p.test(lines[j]))) break;
        input += '\n' + lines[j];
        j++;
      }
      // Skip blank lines.
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j >= lines.length) break;
      const mOut = lines[j].match(reOut);
      if (!mOut) continue;
      let output = lines[j].slice(mOut[0].length);
      let k = j + 1;
      while (k < lines.length && !PAIR_PREFIXES.some(([p]) => p.test(lines[k])) && lines[k].trim() !== '') {
        output += '\n' + lines[k];
        k++;
      }
      input = input.trim();
      output = output.trim();
      if (input && output) {
        rows.push({ input, output, source: `${filename}:${i + 1}` });
      }
      i = k - 1;
      break;
    }
  }

  // Pattern B: markdown ## Example sections with paired code blocks.
  // "## Example" followed by two ```...``` fences = input then output.
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{1,4}\s*(?:Example|Sample|Test)\b/i.test(lines[i])) continue;
    const blocks = [];
    let j = i + 1;
    while (j < lines.length && blocks.length < 2 && !/^#{1,4}\s/.test(lines[j])) {
      if (/^```/.test(lines[j])) {
        const start = j + 1;
        let end = start;
        while (end < lines.length && !/^```/.test(lines[end])) end++;
        blocks.push({ start, body: lines.slice(start, end).join('\n') });
        j = end + 1;
      } else {
        j++;
      }
    }
    if (blocks.length >= 2) {
      rows.push({
        input: blocks[0].body.trim(),
        output: blocks[1].body.trim(),
        source: `${filename}:${blocks[0].start}`,
      });
      i = j - 1;
    }
  }

  // Pattern C: // in / // out comments inside a fenced code block.
  for (let i = 0; i < lines.length; i++) {
    if (!/^```/.test(lines[i])) continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && !/^```/.test(lines[end])) end++;
    const body = lines.slice(start, end);
    const inIdx = body.findIndex(l => /^\s*(?:\/\/|#)\s*in(?:put)?\s*[:\-]?/i.test(l));
    const outIdx = body.findIndex(l => /^\s*(?:\/\/|#)\s*out(?:put)?\s*[:\-]?/i.test(l));
    if (inIdx >= 0 && outIdx > inIdx) {
      const input = body.slice(inIdx + 1, outIdx).join('\n').trim();
      const output = body.slice(outIdx + 1).join('\n').trim();
      if (input && output) {
        rows.push({ input, output, source: `${filename}:${start + inIdx + 1}` });
      }
    }
    i = end;
  }

  return rows;
}

// Tiny RFC4180 CSV parser. Handles quoted fields, escaped quotes, embedded
// newlines, configurable delimiter.
export function parseCsv(text, opts = {}) {
  const delim = opts.delimiter || ',';
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 0 && !(r.length === 1 && r[0] === ''));
}

// Strip HTML tags and decode the most-common entities. Good enough for text
// mining; not a sanitizer.
export function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n');
}

// Extract rows from a JSON or JSONL file. JSON arrays of objects, single
// objects with an obvious wrapper key (rows/data/items), or one-object-per-line
// JSONL all work. Each row must contain a recognized (input, output) pair.
export function extractPairsFromJsonObjects(parsed, filename, baseLine = 1) {
  const rows = [];
  let list = [];
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.rows)) list = parsed.rows;
    else if (Array.isArray(parsed.data)) list = parsed.data;
    else if (Array.isArray(parsed.items)) list = parsed.items;
    else if (Array.isArray(parsed.examples)) list = parsed.examples;
    else if (Array.isArray(parsed.seeds)) list = parsed.seeds;
    else list = [parsed];
  }
  list.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    let input, output;
    if (r.input != null && (r.output != null || r.expected != null)) {
      input = r.input;
      output = r.output != null ? r.output : r.expected;
    } else if (r.prompt != null && r.completion != null) {
      input = r.prompt;
      output = r.completion;
    } else if (r.question != null && r.answer != null) {
      input = r.question;
      output = r.answer;
    } else if (r.before != null && r.after != null) {
      input = r.before;
      output = r.after;
    } else if (r.source != null && r.target != null) {
      input = r.source;
      output = r.target;
    } else {
      return;
    }
    rows.push({
      input: typeof input === 'string' ? input : input,
      output: typeof output === 'string' ? output : output,
      source: `${filename}:${baseLine + i}`,
    });
  });
  return rows;
}

async function mineOneFile(file) {
  const ext = path.extname(file).toLowerCase();
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch { return []; }
  if (TEXT_EXTS.has(ext)) {
    return extractPairsFromText(text, file);
  }
  if (ext === '.jsonl' || ext === '.ndjson') {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (!ln || ln.startsWith('//')) continue;
      try {
        const parsed = JSON.parse(ln);
        out.push(...extractPairsFromJsonObjects([parsed], file, i + 1));
      } catch { /* skip bad line */ }
    }
    return out;
  }
  if (ext === '.json') {
    try {
      const parsed = JSON.parse(text);
      return extractPairsFromJsonObjects(parsed, file, 1);
    } catch { return []; }
  }
  if (CSV_EXTS.has(ext)) {
    const delim = ext === '.tsv' ? '\t' : ',';
    const grid = parseCsv(text, { delimiter: delim });
    if (grid.length < 2) return [];
    const header = grid[0].map(h => String(h).toLowerCase().trim());
    const inIdx = header.findIndex(h => ['input', 'prompt', 'question', 'before', 'source', 'text'].includes(h));
    const outIdx = header.findIndex(h => ['output', 'completion', 'answer', 'after', 'target', 'expected', 'label'].includes(h));
    if (inIdx < 0 || outIdx < 0) return [];
    const out = [];
    for (let i = 1; i < grid.length; i++) {
      const row = grid[i];
      if (!row || row.length <= Math.max(inIdx, outIdx)) continue;
      const input = (row[inIdx] || '').trim();
      const output = (row[outIdx] || '').trim();
      if (input && output) {
        out.push({ input, output, source: `${file}:${i + 1}` });
      }
    }
    return out;
  }
  if (HTML_EXTS.has(ext)) {
    return extractPairsFromText(stripHtml(text), file);
  }
  return [];
}

export async function mineFromDir(dir, opts = {}) {
  const abs = path.resolve(dir);
  const st = await fs.stat(abs).catch(() => null);
  if (!st) throw new Error(`mineFromDir: directory not found: ${abs}`);
  if (!st.isDirectory()) throw new Error(`mineFromDir: not a directory: ${abs}`);
  const files = await walkDir(abs);
  const all = [];
  for (const f of files) {
    const rows = await mineOneFile(f);
    all.push(...rows);
  }
  return dedupe(all);
}

// ChatGPT export shape:
//   [{ title, mapping: { id: { message: { author: {role}, content: {parts: [..]} }, parent, children } } }]
// Claude export shape (current shipping):
//   [{ uuid, name, chat_messages: [{sender: 'human'|'assistant', text}] }]
// Generic NDJSON / array shape:
//   [{ role: 'user'|'assistant', content: '...' }, ...]
function extractChatgptPairs(conversations, jsonPath) {
  const rows = [];
  if (!Array.isArray(conversations)) conversations = [conversations];
  for (const conv of conversations) {
    if (!conv || !conv.mapping) continue;
    // Topologically order nodes by walking from any root.
    const nodes = conv.mapping;
    const order = [];
    const visited = new Set();
    function walk(id) {
      if (visited.has(id) || !nodes[id]) return;
      visited.add(id);
      order.push(id);
      const n = nodes[id];
      const children = n.children || [];
      for (const c of children) walk(c);
    }
    for (const id of Object.keys(nodes)) walk(id);
    let pendingUser = null;
    for (const id of order) {
      const n = nodes[id];
      const m = n && n.message;
      if (!m || !m.author) continue;
      const role = m.author.role;
      const parts = (m.content && Array.isArray(m.content.parts)) ? m.content.parts : [];
      const text = parts
        .map(p => typeof p === 'string' ? p : (p && p.text) || '')
        .join('\n').trim();
      if (!text) continue;
      if (role === 'user' || role === 'human') {
        pendingUser = text;
      } else if ((role === 'assistant' || role === 'bot') && pendingUser) {
        rows.push({
          input: pendingUser,
          output: text,
          source: `${jsonPath}#${conv.id || conv.title || 'conv'}`,
        });
        pendingUser = null;
      }
    }
  }
  return rows;
}

function extractClaudePairs(conversations, jsonPath) {
  const rows = [];
  if (!Array.isArray(conversations)) conversations = [conversations];
  for (const conv of conversations) {
    const messages = conv && (conv.chat_messages || conv.messages || []);
    if (!Array.isArray(messages)) continue;
    let pendingUser = null;
    for (const m of messages) {
      const sender = m.sender || m.role || '';
      const text = m.text || m.content || '';
      const txt = typeof text === 'string' ? text : (Array.isArray(text) ? text.map(t => t.text || '').join('\n') : '');
      if (!txt.trim()) continue;
      if (sender === 'human' || sender === 'user') {
        pendingUser = txt.trim();
      } else if ((sender === 'assistant' || sender === 'bot') && pendingUser) {
        rows.push({
          input: pendingUser,
          output: txt.trim(),
          source: `${jsonPath}#${conv.uuid || conv.name || conv.id || 'conv'}`,
        });
        pendingUser = null;
      }
    }
  }
  return rows;
}

function extractGenericTurnPairs(arr, jsonPath) {
  const rows = [];
  if (!Array.isArray(arr)) return rows;
  let pendingUser = null;
  arr.forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    const role = m.role || m.sender || m.author;
    const content = m.content || m.text || m.message;
    const txt = typeof content === 'string' ? content.trim() : (content && content.text) || '';
    if (!txt) return;
    if (role === 'user' || role === 'human') pendingUser = txt;
    else if ((role === 'assistant' || role === 'bot' || role === 'ai') && pendingUser) {
      rows.push({ input: pendingUser, output: txt, source: `${jsonPath}#${i}` });
      pendingUser = null;
    }
  });
  return rows;
}

// Filter out greeting-only / refusal / meta-talk turns.
const SKIP_OUTPUT_PATTERNS = [
  /^(?:i can'?t|i cannot|i'?m unable|i'?m not able|i won'?t|sorry, but)/i,
  /^(?:as an ai|i'?m an ai|i'?m just an ai)/i,
  /^(?:hello|hi|hey|greetings)[\s!.,]{0,20}$/i,
];
const SKIP_INPUT_PATTERNS = [
  /^(?:hi|hello|hey|yo|howdy|thanks|thank you|ok|okay|cool|nice)[\s!.,]{0,10}$/i,
];

function isUsefulPair(row) {
  if (!row.input || !row.output) return false;
  const inS = String(row.input).trim();
  const outS = String(row.output).trim();
  if (inS.length < 3 || outS.length < 3) return false;
  if (SKIP_INPUT_PATTERNS.some(re => re.test(inS))) return false;
  if (SKIP_OUTPUT_PATTERNS.some(re => re.test(outS))) return false;
  return true;
}

export async function mineFromChat(jsonPath, opts = {}) {
  const abs = path.resolve(jsonPath);
  const text = await fs.readFile(abs, 'utf8');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    // Try NDJSON / JSONL parse.
    const arr = [];
    for (const ln of text.split(/\r?\n/)) {
      const t = ln.trim();
      if (!t) continue;
      try { arr.push(JSON.parse(t)); } catch {}
    }
    parsed = arr;
  }

  let rows = [];
  const sampleConv = Array.isArray(parsed) ? parsed[0] : parsed;
  if (sampleConv && sampleConv.mapping) {
    rows = extractChatgptPairs(parsed, abs);
  } else if (sampleConv && (sampleConv.chat_messages || sampleConv.uuid)) {
    rows = extractClaudePairs(parsed, abs);
  } else if (Array.isArray(parsed) && parsed.length && parsed[0] && (parsed[0].role || parsed[0].sender)) {
    rows = extractGenericTurnPairs(parsed, abs);
  } else if (Array.isArray(parsed)) {
    // Last-resort: maybe each item has nested `messages`.
    for (const conv of parsed) {
      if (conv && Array.isArray(conv.messages)) {
        rows.push(...extractGenericTurnPairs(conv.messages, abs));
      }
    }
  }

  if (opts.skipFilter) return dedupe(rows);
  return dedupe(rows.filter(isUsefulPair));
}

// Template clustering — same heuristic as router.js:templateSignature.
function templateSignature(prompt) {
  const raw = String(prompt || '').replace(/\s+/g, ' ').trim();
  const m = raw.match(/^(.{8,200}?[\?\.!:\n])(.*)$/);
  const head = m ? m[1].trim() : raw.slice(0, 80);
  return crypto.createHash('sha1')
    .update(head.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"<S>"').replace(/\b\d+(?:\.\d+)?\b/g, '<N>'))
    .digest('hex').slice(0, 16);
}

export async function mineFromCaptures(namespace, opts = {}) {
  const cs = await import('./capture-store.js');
  const tenant = opts.tenant || process.env.KOLM_DEFAULT_TENANT || 'default';
  const limit = opts.limit || 10000;
  let rows = await cs.listCaptures(tenant, namespace || 'default', limit);
  if (opts.sinceTs) {
    const cutoff = new Date(opts.sinceTs).getTime();
    rows = rows.filter(r => {
      const t = new Date(r.created_at || r.ts || 0).getTime();
      return t >= cutoff;
    });
  }
  // Template-cluster: pick first example per cluster + carry count.
  if (opts.cluster !== false) {
    const clusters = new Map();
    for (const r of rows) {
      const prompt = r.prompt || r.input || '';
      const resp = r.response || r.output || '';
      if (!prompt || resp === '') continue;
      const sig = r.template_hash || templateSignature(prompt);
      if (!clusters.has(sig)) {
        clusters.set(sig, {
          input: prompt,
          output: typeof resp === 'string' ? resp : JSON.stringify(resp),
          source: `capture:${r.id || sig}`,
          template_hash: sig,
          cluster_count: 1,
        });
      } else {
        clusters.get(sig).cluster_count++;
      }
    }
    return dedupe([...clusters.values()]);
  }
  // No clustering — direct pass-through.
  const out = [];
  for (const r of rows) {
    const prompt = r.prompt || r.input || '';
    const resp = r.response || r.output || '';
    if (!prompt || resp === '') continue;
    out.push({
      input: prompt,
      output: typeof resp === 'string' ? resp : JSON.stringify(resp),
      source: `capture:${r.id || ''}`,
    });
  }
  return dedupe(out);
}

// Helper used by both the CLI and tests to write rows to a JSONL file.
export async function writeRowsJsonl(filePath, rows) {
  const lines = rows.map(r => JSON.stringify({
    input: r.input,
    output: r.output,
    ...(r.source ? { source: r.source } : {}),
    ...(r.template_hash ? { template_hash: r.template_hash } : {}),
    ...(r.cluster_count ? { cluster_count: r.cluster_count } : {}),
  }));
  await fs.writeFile(filePath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return filePath;
}
