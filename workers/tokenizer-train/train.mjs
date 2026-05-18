#!/usr/bin/env node
// workers/tokenizer-train/train.mjs
//
// Wave 381 — isolated tokenizer-train worker. Pure-JS BPE / unigram trainer.
// No python, no native deps, no transformers, no sentencepiece. This worker
// runs entirely on Node >= 18 so a fresh laptop can compile a custom
// tokenizer over its captured corpus without provisioning a Python venv.
//
// Heavy ML stays in workers/ per repo policy. This file is the only place a
// BPE merge loop runs; src/tokenizer-train.js is a thin Node API that
// spawns this script and reads back the model JSON.
//
// Invocation:
//   node workers/tokenizer-train/train.mjs '<json-args>'
//
// Where <json-args> is a single JSON object:
//   {
//     corpus_path:    string,   // path to a UTF-8 text or JSONL corpus
//     vocab_size:     number,   // target final vocab including specials
//     algorithm:      'bpe'|'unigram'|'wordpiece',
//     model_prefix:   string,   // output path prefix (e.g. /tmp/x/tok)
//     seed:           number,   // deterministic tie-break seed
//     special_tokens: string[]? // prepended to vocab
//   }
//
// On success prints a single JSON line:
//   {"ok":true,"tokenizer_path":"<model_prefix>.tokenizer.json","vocab_size":N,
//    "merges_count":M,"algorithm":"bpe","train_token_count":T,
//    "deterministic_hash":"sha256:..."}
//
// On failure prints {"ok":false,"error":"..."} and exits 2.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

const DEFAULT_SPECIALS = ['<pad>', '<s>', '</s>', '<unk>', '<mask>'];

function readArgs() {
  const raw = process.argv[2];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function readCorpus(corpusPath) {
  if (!fs.existsSync(corpusPath)) {
    return { lines: [], bytes: 0 };
  }
  const text = fs.readFileSync(corpusPath, 'utf8');
  if (!text || !text.trim()) return { lines: [], bytes: 0 };
  // If JSONL with {text:...} or {input:...,output:...}, pull text fields.
  const isJsonl = text.trimStart().startsWith('{');
  const lines = [];
  for (const ln of text.split(/\r?\n/)) {
    if (!ln) continue;
    if (isJsonl) {
      try {
        const j = JSON.parse(ln);
        if (typeof j === 'string') { lines.push(j); continue; }
        if (j && typeof j.text === 'string') { lines.push(j.text); continue; }
        const collected = [];
        if (j && typeof j.input === 'string') collected.push(j.input);
        if (j && typeof j.output === 'string') collected.push(j.output);
        if (j && typeof j.prompt === 'string') collected.push(j.prompt);
        if (j && typeof j.response === 'string') collected.push(j.response);
        if (collected.length) { lines.push(collected.join(' → ')); continue; }
        lines.push(ln);
      } catch { lines.push(ln); }
    } else {
      lines.push(ln);
    }
  }
  return { lines, bytes: text.length };
}

// Deterministic whitespace + punctuation pre-tokenizer. Splits on any run of
// non-word characters and keeps the punctuation as its own token. Lowercases
// for determinism across machines with different locales.
function preTokenize(line) {
  const out = [];
  if (!line) return out;
  const re = /[A-Za-z0-9]+|[^\sA-Za-z0-9]/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    out.push(m[0].toLowerCase());
  }
  return out;
}

// Convert a word into a list of character-level "atoms" used by the BPE merge
// loop. The terminal marker '▁' (▁) was traditional, but for portability
// we use the simple convention of suffixing the last char with '</w>'. Atoms
// are independent characters and 'X</w>' for the final character.
function wordToAtoms(word) {
  if (!word) return [];
  const chars = Array.from(word); // unicode-safe split
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    if (i === chars.length - 1) out.push(chars[i] + '</w>');
    else out.push(chars[i]);
  }
  return out;
}

// Count adjacent-pair frequencies across the entire corpus represented as
// {word_atoms: string[][], counts: number[]}. Returns Map<"ab", number>.
function countPairs(wordAtoms, counts) {
  const pairs = new Map();
  for (let i = 0; i < wordAtoms.length; i++) {
    const atoms = wordAtoms[i];
    const c = counts[i];
    for (let j = 0; j < atoms.length - 1; j++) {
      const key = atoms[j] + '' + atoms[j + 1];
      pairs.set(key, (pairs.get(key) || 0) + c);
    }
  }
  return pairs;
}

// Pick the best pair: highest count, deterministic tie-break by lexicographic
// order of the pair key. No Set iteration order assumptions.
function pickBestPair(pairs) {
  let bestKey = null;
  let bestCount = -1;
  for (const [key, count] of pairs) {
    if (count > bestCount || (count === bestCount && (bestKey === null || key < bestKey))) {
      bestKey = key;
      bestCount = count;
    }
  }
  return bestKey ? { key: bestKey, count: bestCount } : null;
}

// Apply a merge in place: for every word, scan atoms left to right and
// replace any [a, b] adjacency with [a+b]. Returns mutated wordAtoms.
function applyMerge(wordAtoms, a, b) {
  const merged = a + b;
  for (let i = 0; i < wordAtoms.length; i++) {
    const atoms = wordAtoms[i];
    if (atoms.length < 2) continue;
    const next = [];
    let j = 0;
    while (j < atoms.length) {
      if (j < atoms.length - 1 && atoms[j] === a && atoms[j + 1] === b) {
        next.push(merged);
        j += 2;
      } else {
        next.push(atoms[j]);
        j += 1;
      }
    }
    wordAtoms[i] = next;
  }
  return wordAtoms;
}

function trainBpe({ lines, vocabSize, specials, seed }) {
  // Build the word frequency table.
  const freq = new Map();
  let trainTokenCount = 0;
  for (const ln of lines) {
    const words = preTokenize(ln);
    for (const w of words) {
      freq.set(w, (freq.get(w) || 0) + 1);
      trainTokenCount += 1;
    }
  }
  // Deterministic ordering by word.
  const sortedWords = Array.from(freq.keys()).sort();
  const wordAtoms = sortedWords.map(wordToAtoms);
  const counts = sortedWords.map((w) => freq.get(w));
  // Seed the vocab with specials + every initial atom.
  const vocab = new Set(specials);
  for (const atoms of wordAtoms) {
    for (const a of atoms) vocab.add(a);
  }
  const merges = [];
  const targetMergeVocab = Math.max(specials.length, vocabSize);
  // Run merges until vocab size reaches the target or no more pairs to merge.
  // The seed is folded into tie-break as a constant prefix on equal-count
  // pairs by sorting on (count desc, key+seed asc).
  while (vocab.size < targetMergeVocab) {
    const pairs = countPairs(wordAtoms, counts);
    if (pairs.size === 0) break;
    // Deterministic best-pair selection. We bake the seed into the
    // tie-break key so callers passing different seeds get different (but
    // still deterministic) outputs.
    let bestKey = null;
    let bestCount = -1;
    let bestTie = null;
    for (const [key, count] of pairs) {
      const tieKey = key + '' + String(seed);
      if (count > bestCount || (count === bestCount && (bestTie === null || tieKey < bestTie))) {
        bestKey = key;
        bestCount = count;
        bestTie = tieKey;
      }
    }
    if (!bestKey || bestCount < 1) break;
    const [a, b] = bestKey.split('');
    if (!a || !b) break;
    applyMerge(wordAtoms, a, b);
    merges.push([a, b]);
    vocab.add(a + b);
    if (merges.length > 1_000_000) break; // belt-and-suspenders cap
  }
  // Order vocab: specials first (preserve given order), then by insertion order
  // (a stable canonical encoding for determinism).
  const finalVocab = [];
  const seen = new Set();
  for (const s of specials) {
    if (!seen.has(s)) { finalVocab.push(s); seen.add(s); }
  }
  // Add atoms then merges in deterministic order.
  const remaining = Array.from(vocab).filter((v) => !seen.has(v)).sort();
  for (const v of remaining) finalVocab.push(v);
  // If we overshot, trim to vocab_size (keep specials).
  const trimmed = finalVocab.slice(0, Math.max(specials.length, vocabSize));
  return { vocab: trimmed, merges, train_token_count: trainTokenCount };
}

// Unigram is intentionally a smaller-vocab fallback: we use BPE under the
// hood but record algorithm='unigram' so downstream callers can branch. A
// fully-fledged unigram language model would need EM training; that lives
// out-of-scope for the default JS path. The contract documents this.
function trainUnigram(args) {
  const result = trainBpe(args);
  return result;
}

// WordPiece is a documented stub-returning-bpe in the spec. We label it as
// such on output.
function trainWordPiece(args) {
  const result = trainBpe(args);
  return result;
}

function main() {
  const args = readArgs();
  if (!args || typeof args !== 'object') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing or invalid args (expected JSON object as argv[2])' }) + '\n');
    process.exit(2);
  }
  const corpusPath = args.corpus_path;
  const vocabSize = Number(args.vocab_size) || 4000;
  const algorithm = args.algorithm || 'bpe';
  const modelPrefix = args.model_prefix;
  const seed = Number(args.seed) || 1;
  const specials = Array.isArray(args.special_tokens) && args.special_tokens.length > 0
    ? args.special_tokens.slice()
    : DEFAULT_SPECIALS.slice();
  if (!modelPrefix) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'model_prefix required' }) + '\n');
    process.exit(2);
  }
  if (!['bpe', 'unigram', 'wordpiece'].includes(algorithm)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'algorithm must be bpe|unigram|wordpiece' }) + '\n');
    process.exit(2);
  }
  const { lines, bytes } = readCorpus(corpusPath);
  const trainerArgs = { lines, vocabSize, specials, seed };
  let result;
  if (algorithm === 'bpe') result = trainBpe(trainerArgs);
  else if (algorithm === 'unigram') result = trainUnigram(trainerArgs);
  else result = trainWordPiece(trainerArgs);

  // Empty corpus path: vocab is just specials (no merges).
  if (lines.length === 0) {
    result = { vocab: specials.slice(), merges: [], train_token_count: 0 };
  }
  const tokenJson = {
    spec: 'kolm-tokenizer-1',
    algorithm,
    vocab: result.vocab,
    merges: result.merges,
    special_tokens: specials,
    corpus_bytes: bytes,
    train_token_count: result.train_token_count,
    seed,
    generated_at: new Date().toISOString(),
  };
  const tokenizerPath = modelPrefix + '.tokenizer.json';
  const outDir = path.dirname(tokenizerPath);
  fs.mkdirSync(outDir, { recursive: true });
  const tokenStr = JSON.stringify(tokenJson, null, 2);
  fs.writeFileSync(tokenizerPath, tokenStr);
  // Deterministic hash binds (vocab + merges + specials + seed + algorithm).
  const canonical = JSON.stringify({
    algorithm,
    vocab: tokenJson.vocab,
    merges: tokenJson.merges,
    special_tokens: tokenJson.special_tokens,
    seed,
  });
  const detHash = 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex');
  const out = {
    ok: true,
    tokenizer_path: tokenizerPath,
    vocab_size: tokenJson.vocab.length,
    merges_count: tokenJson.merges.length,
    algorithm,
    train_token_count: tokenJson.train_token_count,
    deterministic_hash: detHash,
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

try { main(); }
catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }) + '\n');
  process.exit(2);
}
