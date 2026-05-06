// Hash-based bag-of-n-grams embedding. Deterministic, no API call.
// 256 dimensions, L2-normalized.
// Swap for a real embedding model (Voyage, OpenAI, sentence-transformers) when scaling.

import crypto from 'node:crypto';

const DIM = 256;

function ngrams(text, n) {
  const t = ' ' + text.toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
  const out = [];
  for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n));
  return out;
}

function tokens(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hashIndex(token, salt = '') {
  const h = crypto.createHash('sha1').update(salt + token).digest();
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}

function sign(token) {
  const h = crypto.createHash('sha1').update('sign:' + token).digest();
  return (h[0] & 1) ? 1 : -1;
}

function l2Normalize(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export function embed(text) {
  const v = new Array(DIM).fill(0);
  const toks = tokens(text);
  for (const t of toks) {
    const idx = hashIndex(t, 'unigram') % DIM;
    v[idx] += sign(t);
  }
  for (const g of ngrams(text, 3)) {
    const idx = hashIndex(g, 'tri') % DIM;
    v[idx] += sign(g) * 0.5;
  }
  for (const g of ngrams(text, 4)) {
    const idx = hashIndex(g, 'quad') % DIM;
    v[idx] += sign(g) * 0.3;
  }
  return l2Normalize(v);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function topK(query, items, k = 10, getVec = it => it.vector) {
  const scored = items.map(it => ({ item: it, score: cosine(query, getVec(it)) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export const DIMENSIONS = DIM;
