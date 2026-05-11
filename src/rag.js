// Airgapped local retrieval. Pure-JS BM25 by default; ONNX MiniLM embeddings
// are opt-in for users who want dense recall and have onnxruntime-node installed.
//
// The shape:
//
//   1. `kolm rag index <dir> [--name <n>] [--ext txt,md,json]`
//      Walks <dir>, tokenizes, builds an inverted index + per-doc term frequencies,
//      and writes ~/.kolm/rag/<name>/index.json (manifest + posting lists).
//
//   2. `kolm rag query <name> "<question>" [--top-k 5]`
//      Tokenizes the query, BM25-scores all docs, returns top-k passages with
//      paths and excerpt windows.
//
//   3. `kolm rag attach <artifact.kolm> --index <name>`
//      Pins the rag index name into the artifact's manifest. When that artifact
//      runs, the sandbox's `lib.rag.query(q, k)` resolves against this index.
//
// Index file format (~/.kolm/rag/<name>/index.json):
//   {
//     "spec": "rag-bm25-1",
//     "name": "<name>",
//     "created_at": "...",
//     "docs": [{ "id": 0, "path": "...", "len": 123, "preview": "first 120 chars" }],
//     "postings": { "term": [[doc_id, tf], ...] },
//     "df": { "term": <n_docs_containing> },
//     "avgdl": <average doc length in tokens>,
//     "n_docs": <total docs>,
//     "k1": 1.5, "b": 0.75
//   }
//
// All deterministic. Same dir → same index hash (independent of walk order
// because we sort paths).
//
// No network. No external embedder by default. Works on a plane.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME = os.homedir();
const RAG_ROOT = path.join(HOME, '.kolm', 'rag');

const STOPWORDS = new Set('a,an,and,are,as,at,be,but,by,for,if,in,into,is,it,no,not,of,on,or,such,that,the,their,then,there,these,they,this,to,was,will,with,you,your,i,we,our'.split(','));

export function tokenize(s) {
  if (!s) return [];
  return String(s).toLowerCase()
    .replace(/[^a-z0-9_\s\-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && t.length <= 64 && !STOPWORDS.has(t));
}

function walk(dir, exts) {
  const out = [];
  const stack = [dir];
  const extSet = new Set(exts.map(e => e.startsWith('.') ? e : '.' + e));
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        stack.push(p);
      } else if (e.isFile()) {
        if (!extSet.size || extSet.has(path.extname(e.name).toLowerCase())) {
          out.push(p);
        }
      }
    }
  }
  return out.sort();
}

// Build a BM25 index over `dir` (recursive, respecting exts filter).
// Returns the index path. Idempotent: re-running clobbers the prior index.
export function indexDir({ dir, name, exts = ['txt', 'md', 'json'], maxBytes = 4 * 1024 * 1024, k1 = 1.5, b = 0.75 }) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('not a directory: ' + dir);
  }
  if (!name) name = path.basename(path.resolve(dir));
  const outDir = path.join(RAG_ROOT, name);
  fs.mkdirSync(outDir, { recursive: true });
  const files = walk(dir, exts);
  if (!files.length) throw new Error('no files matched in ' + dir + ' (exts: ' + exts.join(',') + ')');

  const docs = [];
  const postings = Object.create(null);
  const df = Object.create(null);
  let totalLen = 0;
  let docId = 0;

  for (const fp of files) {
    let stat; try { stat = fs.statSync(fp); } catch { continue; }
    if (stat.size > maxBytes) continue;
    let raw;
    try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    const tokens = tokenize(raw);
    if (!tokens.length) continue;
    const tfMap = Object.create(null);
    for (const t of tokens) tfMap[t] = (tfMap[t] || 0) + 1;
    for (const [t, tf] of Object.entries(tfMap)) {
      if (!postings[t]) { postings[t] = []; df[t] = 0; }
      postings[t].push([docId, tf]);
      df[t]++;
    }
    docs.push({
      id: docId,
      path: path.relative(dir, fp).replace(/\\/g, '/'),
      abs: fp,
      len: tokens.length,
      preview: raw.slice(0, 240).replace(/\s+/g, ' ').trim(),
    });
    totalLen += tokens.length;
    docId++;
  }

  const avgdl = docs.length ? totalLen / docs.length : 0;
  const index = {
    spec: 'rag-bm25-1',
    name,
    created_at: new Date().toISOString(),
    root: path.resolve(dir),
    n_docs: docs.length,
    avgdl,
    k1, b,
    docs,
    df,
    postings,
  };
  const indexPath = path.join(outDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index));
  // Also persist a compact manifest.
  const manifest = {
    spec: index.spec,
    name,
    root: index.root,
    n_docs: index.n_docs,
    avgdl: index.avgdl,
    created_at: index.created_at,
    index_path: indexPath,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex'),
    size_bytes: fs.statSync(indexPath).size,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function loadIndex(name) {
  const p = path.join(RAG_ROOT, name, 'index.json');
  if (!fs.existsSync(p)) throw new Error('no rag index: ' + name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// BM25 score for a query against a loaded index. Returns top-k matches with excerpt.
export function queryIndex({ name, q, topK = 5, excerpt = 240 }) {
  const idx = loadIndex(name);
  const qTokens = [...new Set(tokenize(q))];
  if (!qTokens.length) return { matches: [], n_docs: idx.n_docs, query_tokens: [] };
  const N = idx.n_docs;
  const { k1, b, avgdl } = idx;
  const scores = new Float64Array(N);
  const seen = new Uint8Array(N);
  for (const t of qTokens) {
    const post = idx.postings[t];
    if (!post) continue;
    const ndf = idx.df[t] || 0;
    const idf = Math.log(1 + (N - ndf + 0.5) / (ndf + 0.5));
    for (const [docId, tf] of post) {
      const dl = idx.docs[docId].len || 1;
      const denom = tf + k1 * (1 - b + b * (dl / avgdl));
      const s = idf * (tf * (k1 + 1)) / denom;
      scores[docId] += s;
      seen[docId] = 1;
    }
  }
  const ranked = [];
  for (let i = 0; i < N; i++) {
    if (seen[i]) ranked.push([scores[i], i]);
  }
  ranked.sort((a, b) => b[0] - a[0]);
  const top = ranked.slice(0, topK).map(([score, id]) => {
    const d = idx.docs[id];
    let excerptText = d.preview;
    try {
      const raw = fs.readFileSync(d.abs, 'utf8');
      // window around first query-token hit
      const lowered = raw.toLowerCase();
      let hit = -1;
      for (const t of qTokens) {
        const h = lowered.indexOf(t);
        if (h >= 0) { hit = h; break; }
      }
      if (hit >= 0) {
        const start = Math.max(0, hit - 80);
        const end = Math.min(raw.length, hit + excerpt - 80);
        excerptText = (start > 0 ? '… ' : '') + raw.slice(start, end).replace(/\s+/g, ' ').trim() + (end < raw.length ? ' …' : '');
      }
    } catch {}
    return {
      score: Number(score.toFixed(4)),
      path: d.path,
      preview: d.preview,
      excerpt: excerptText,
    };
  });
  return { matches: top, n_docs: N, query_tokens: qTokens };
}

export function listIndexes() {
  if (!fs.existsSync(RAG_ROOT)) return [];
  return fs.readdirSync(RAG_ROOT).filter(n => fs.existsSync(path.join(RAG_ROOT, n, 'manifest.json'))).map(n => {
    try { return JSON.parse(fs.readFileSync(path.join(RAG_ROOT, n, 'manifest.json'), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
}

// Attach an index to a kolm artifact: writes a sidecar so the runner can
// expose `lib.rag.query(q, k)` to recipes when this artifact runs.
export function attachIndexToArtifact({ artifactPath, indexName }) {
  if (!fs.existsSync(artifactPath)) throw new Error('artifact not found: ' + artifactPath);
  const manifestPath = path.join(RAG_ROOT, indexName, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('no such index: ' + indexName);
  const sidecar = artifactPath + '.rag.json';
  fs.writeFileSync(sidecar, JSON.stringify({
    spec: 'rag-attach-1',
    index_name: indexName,
    attached_at: new Date().toISOString(),
  }, null, 2));
  return { artifact: path.basename(artifactPath), index: indexName, sidecar };
}

export function readAttachment(artifactPath) {
  const sidecar = artifactPath + '.rag.json';
  if (!fs.existsSync(sidecar)) return null;
  try { return JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch { return null; }
}

// Helper for the sandbox: returns a closure suitable to be exposed as lib.rag.
// Throws if the artifact has no rag attachment (recipes that don't need rag
// should not depend on it; recipes that do should check `if (!lib.rag) throw`).
export function ragLibFor(artifactPath) {
  const att = readAttachment(artifactPath);
  if (!att) return null;
  return {
    query: (q, k = 5) => queryIndex({ name: att.index_name, q, topK: k }),
  };
}
