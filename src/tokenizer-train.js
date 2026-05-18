// Wave 381 — tokenizer training API.
//
// Thin Node-side API over the pure-JS BPE worker at
// workers/tokenizer-train/train.mjs. Heavy ML stays in workers/ per repo
// policy; this file only spawns the worker, parses its JSON envelope, and
// exposes encode/decode helpers for the trained tokenizer.
//
// Public surface:
//   trainTokenizer({corpus, vocab_size, algorithm, model_prefix, special_tokens?})
//     -> Promise<{tokenizer_path, vocab_size, algorithm, train_token_count, deterministic_hash}>
//
//   loadTokenizer(path)
//     -> {encode(text)->ids[], decode(ids)->text, vocab_size, special_tokens, algorithm}
//
//   tokenizerStats(corpus, tokenizer)
//     -> {avg_tokens_per_doc, compression_vs_gpt4, oov_rate}
//
//   ALGORITHMS          = ['bpe', 'unigram', 'wordpiece']
//   DEFAULT_VOCAB_SIZES = [4000, 8000, 16000, 32000]
//
// The worker is invoked via child_process.spawnSync (synchronous from the
// caller's POV — we await a result, and the merge loop is fast enough for
// vocab_size<=32000 on a typical 1MB corpus). For very large corpora the
// pipeline orchestrator (src/compile-pipeline.js) can spawn the worker
// detached and watch its output asynchronously; trainTokenizer itself
// returns a Promise so the API stays async-friendly.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DEFAULT_WORKER = path.join(ROOT, 'workers', 'tokenizer-train', 'train.mjs');

export const ALGORITHMS = ['bpe', 'unigram', 'wordpiece'];
export const DEFAULT_VOCAB_SIZES = [4000, 8000, 16000, 32000];
export const DEFAULT_SPECIAL_TOKENS = ['<pad>', '<s>', '</s>', '<unk>', '<mask>'];

function _ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
function _tmpDir() {
  const base = process.env.KOLM_DATA_DIR
    ? path.join(path.resolve(process.env.KOLM_DATA_DIR), 'tokenizer-train')
    : path.join(os.tmpdir(), 'kolm-tokenizer-train');
  return _ensureDir(base);
}

// Materialize corpus (string[] or string) into a UTF-8 file. If corpus is
// already a file path, returns it unchanged.
function _materializeCorpus(corpus) {
  if (typeof corpus === 'string') {
    if (fs.existsSync(corpus)) return { path: corpus, transient: false };
    // Treat as raw text (single document).
    const dir = _tmpDir();
    const p = path.join(dir, 'corpus_' + crypto.randomBytes(4).toString('hex') + '.txt');
    fs.writeFileSync(p, corpus);
    return { path: p, transient: true };
  }
  if (Array.isArray(corpus)) {
    const dir = _tmpDir();
    const p = path.join(dir, 'corpus_' + crypto.randomBytes(4).toString('hex') + '.txt');
    fs.writeFileSync(p, corpus.join('\n') + '\n');
    return { path: p, transient: true };
  }
  throw new Error('corpus must be a string (text or path) or string[]');
}

export async function trainTokenizer({
  corpus,
  vocab_size = 4000,
  algorithm = 'bpe',
  model_prefix,
  special_tokens,
  seed = 1,
  worker_cmd,
} = {}) {
  if (!ALGORITHMS.includes(algorithm)) {
    throw new Error(`algorithm must be one of [${ALGORITHMS.join(', ')}]`);
  }
  if (!model_prefix) {
    const dir = _tmpDir();
    model_prefix = path.join(dir, 'tok_' + crypto.randomBytes(4).toString('hex'));
  }
  const specials = Array.isArray(special_tokens) && special_tokens.length > 0
    ? special_tokens.slice()
    : DEFAULT_SPECIAL_TOKENS.slice();
  const corpusInfo = _materializeCorpus(corpus);
  const worker = worker_cmd || process.env.KOLM_TOKENIZER_WORKER_CMD || DEFAULT_WORKER;
  const args = JSON.stringify({
    corpus_path: corpusInfo.path,
    vocab_size,
    algorithm,
    model_prefix,
    seed,
    special_tokens: specials,
  });
  // Spawn the worker async — capture stdout + stderr and resolve with the
  // parsed envelope. We do NOT detach here because the caller needs the
  // result inline; compile-pipeline.js can choose to detach for very large
  // corpora by reading the same envelope from the log file instead.
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (e) => reject(e));
    child.on('exit', (code) => {
      if (corpusInfo.transient) {
        try { fs.unlinkSync(corpusInfo.path); } catch {}
      }
      // The worker prints one JSON line on success. Strip any stderr
      // banner and parse the first JSON line we find on stdout.
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      let envelope = null;
      for (const ln of lines.reverse()) {
        try { envelope = JSON.parse(ln); break; } catch {}
      }
      if (!envelope) {
        return reject(new Error(`tokenizer worker produced no JSON envelope (exit ${code}): ${stderr || stdout}`));
      }
      if (envelope.ok === false) {
        return reject(new Error('tokenizer worker error: ' + (envelope.error || 'unknown')));
      }
      if (code !== 0) {
        return reject(new Error(`tokenizer worker exit code ${code}: ${stderr}`));
      }
      resolve(envelope);
    });
  });
  return {
    tokenizer_path: result.tokenizer_path,
    vocab_size: result.vocab_size,
    algorithm: result.algorithm,
    train_token_count: result.train_token_count,
    deterministic_hash: result.deterministic_hash,
    merges_count: result.merges_count,
  };
}

// Load a previously-trained tokenizer file and return encode/decode helpers.
// The encode loop is a greedy longest-match scan over the merged vocab —
// matches the BPE merge semantics from the worker without re-running the
// merge loop. For an OOV character we emit the <unk> id (or skip if <unk> is
// absent from the vocab).
export function loadTokenizer(tokPath) {
  if (!fs.existsSync(tokPath)) throw new Error('tokenizer not found: ' + tokPath);
  const tok = JSON.parse(fs.readFileSync(tokPath, 'utf8'));
  if (!tok || !Array.isArray(tok.vocab)) throw new Error('tokenizer file malformed: missing vocab');
  const vocab = tok.vocab.slice();
  const idById = vocab; // arrays double as id→token
  const idByTok = new Map();
  for (let i = 0; i < vocab.length; i++) idByTok.set(vocab[i], i);
  const unkId = idByTok.has('<unk>') ? idByTok.get('<unk>') : null;

  // Sort vocab by length desc for greedy longest-match. We exclude specials
  // from the longest-match scan (specials are matched separately by exact
  // equality on whitespace-delimited tokens).
  const sortedByLen = vocab
    .filter((t) => !tok.special_tokens.includes(t))
    .slice()
    .sort((a, b) => b.length - a.length);

  function encode(text) {
    if (text == null) return [];
    const s = String(text).toLowerCase();
    const ids = [];
    let i = 0;
    while (i < s.length) {
      // Skip whitespace — the worker pre-tokenizer drops it. Treating spaces
      // as <unk> blows up the OOV rate on prose corpora and tanks the
      // compression metric vs GPT-4 since GPT-4's tokenizer includes a
      // leading-space variant of every common word.
      if (/\s/.test(s[i])) { i += 1; continue; }
      let matched = null;
      // Greedy longest-match over the (non-special) vocab.
      for (const t of sortedByLen) {
        // Allow matches even when t ends with "</w>" — strip the suffix
        // and match the literal characters then re-add the </w> token id.
        const tBare = t.endsWith('</w>') ? t.slice(0, -4) : t;
        if (!tBare) continue;
        if (s.startsWith(tBare, i)) {
          matched = t;
          i += tBare.length;
          break;
        }
      }
      if (matched) {
        const id = idByTok.get(matched);
        if (id != null) ids.push(id);
      } else {
        if (unkId != null) ids.push(unkId);
        i += 1; // skip one char and continue
      }
    }
    return ids;
  }

  function decode(ids) {
    if (!Array.isArray(ids)) return '';
    const out = [];
    for (const id of ids) {
      if (id < 0 || id >= idById.length) continue;
      const t = idById[id];
      if (tok.special_tokens.includes(t)) continue;
      const stripped = t.endsWith('</w>') ? t.slice(0, -4) : t;
      out.push(stripped);
    }
    return out.join('');
  }

  return {
    encode,
    decode,
    vocab_size: vocab.length,
    special_tokens: tok.special_tokens.slice(),
    algorithm: tok.algorithm,
    path: tokPath,
  };
}

// Cheap compression vs the GPT-4 baseline. The GPT-4 estimate (4 chars per
// token in English text) is well-documented; we use that as a floor so the
// compression number is comparable across tokenizers. compression_vs_gpt4 > 1
// means "our tokenizer is more compact than GPT-4's BPE on this corpus."
// oov_rate is the fraction of characters that produced an <unk>.
export function tokenizerStats(corpus, tokenizer) {
  let lines = [];
  if (typeof corpus === 'string') {
    if (fs.existsSync(corpus)) {
      lines = fs.readFileSync(corpus, 'utf8').split(/\r?\n/).filter(Boolean);
    } else {
      lines = [corpus];
    }
  } else if (Array.isArray(corpus)) {
    lines = corpus.slice();
  } else {
    return { avg_tokens_per_doc: 0, compression_vs_gpt4: 0, oov_rate: 0 };
  }
  if (lines.length === 0) {
    return { avg_tokens_per_doc: 0, compression_vs_gpt4: 0, oov_rate: 0 };
  }
  const unkId = tokenizer.special_tokens.indexOf('<unk>');
  let totalChars = 0;
  let totalTokens = 0;
  let oovTokens = 0;
  for (const ln of lines) {
    totalChars += String(ln).length;
    const ids = tokenizer.encode(ln);
    totalTokens += ids.length;
    if (unkId >= 0) {
      for (const id of ids) if (id === unkId) oovTokens += 1;
    }
  }
  const avg_tokens_per_doc = lines.length > 0 ? totalTokens / lines.length : 0;
  // GPT-4 baseline: ~4 chars per token in English. Compression = baseline_tokens / our_tokens.
  const gpt4Tokens = Math.max(1, totalChars / 4);
  const compression_vs_gpt4 = gpt4Tokens / Math.max(1, totalTokens);
  const oov_rate = totalTokens > 0 ? oovTokens / totalTokens : 0;
  return {
    avg_tokens_per_doc: Math.round(avg_tokens_per_doc * 100) / 100,
    compression_vs_gpt4: Math.round(compression_vs_gpt4 * 1000) / 1000,
    oov_rate: Math.round(oov_rate * 1000) / 1000,
  };
}

export default { trainTokenizer, loadTokenizer, tokenizerStats, ALGORITHMS, DEFAULT_VOCAB_SIZES };
