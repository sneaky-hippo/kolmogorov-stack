// Pretokenization layer for .kolm artifacts.
//
// Pure-JS byte-level BPE tokenizer. No native deps, no Python, no model.
// Ships in the .kolm world as a standalone tokenizer.json that .kolm
// artifacts reference via training_stats.tokenizer = { sha256, type, vocab_size }.
//
// Why byte-level: every UTF-8 string round-trips losslessly through the
// initial 256-byte alphabet. No <unk> on emoji, no <unk> on CJK, no <unk>
// on arbitrary bytes from binary blobs. The tokenizer cannot fail to encode
// any input — worst case it falls back to 1-byte-per-token.
//
// Why BPE and not WordPiece/SentencePiece: BPE is the simplest greedy merge
// algorithm and it's what GPT-2/Llama/Qwen/DeepSeek use. Implementable in
// 200 lines without a C kernel.
//
// What this is NOT: a full HuggingFace tokenizer. No regex pre-tokenization
// patterns beyond whitespace+punct boundaries; no normalization; no added
// tokens beyond the four built-ins. The point is REPRODUCIBLE, SIGNABLE,
// EMBEDDABLE tokenization, not best-in-class compression.

import crypto from 'node:crypto';

export const SPEC = 'kolm-tokenizer-1';

// Special tokens are reserved at the bottom of the vocab so their IDs
// are stable across retraining.
export const SPECIAL_TOKENS = ['<pad>', '<unk>', '<s>', '</s>'];

// Pre-tokenization pattern: split on whitespace/punct boundaries while
// keeping the whitespace attached to the FOLLOWING token (GPT-2-ish).
// This is intentionally simple — the BPE merge step handles the rest.
const PRETOK_RE = /\s*[\p{L}\p{N}]+|\s*[^\s\p{L}\p{N}]+|\s+/gu;

function pretokenize(text) {
  if (typeof text !== 'string') throw new Error('pretokenize: text must be a string');
  const out = [];
  for (const m of text.matchAll(PRETOK_RE)) out.push(m[0]);
  return out;
}

function bytesOf(s) {
  // Convert string to byte-array (numbers 0..255).
  return Array.from(Buffer.from(s, 'utf-8'));
}

function pairKey(a, b) {
  return `${a},${b}`;
}

export class KolmTokenizer {
  constructor({ vocab, merges, vocab_size, type = 'byte-bpe' } = {}) {
    this.type = type;
    this.vocab = vocab || this._initVocab();
    this.merges = merges || [];
    this.vocab_size = vocab_size || this.vocab.length;
    this._rebuildIndexes();
  }

  _initVocab() {
    const v = [];
    for (let i = 0; i < SPECIAL_TOKENS.length; i++) v.push({ id: i, kind: 'special', value: SPECIAL_TOKENS[i] });
    for (let b = 0; b < 256; b++) v.push({ id: SPECIAL_TOKENS.length + b, kind: 'byte', value: b });
    return v;
  }

  _rebuildIndexes() {
    this._byteToId = new Map();
    this._specialToId = new Map();
    for (const t of this.vocab) {
      if (t.kind === 'byte') this._byteToId.set(t.value, t.id);
      else if (t.kind === 'special') this._specialToId.set(t.value, t.id);
    }
    this._mergeRank = new Map();
    this._mergeResult = new Map();
    for (let i = 0; i < this.merges.length; i++) {
      const m = this.merges[i];
      this._mergeRank.set(pairKey(m.a, m.b), i);
      this._mergeResult.set(pairKey(m.a, m.b), m.id);
    }
  }

  static specialId(name) {
    const i = SPECIAL_TOKENS.indexOf(name);
    if (i < 0) throw new Error(`unknown special token: ${name}`);
    return i;
  }

  encode(text) {
    const pieces = pretokenize(text);
    const out = [];
    for (const piece of pieces) {
      const bytes = bytesOf(piece);
      let ids = bytes.map((b) => this._byteToId.get(b));
      // Apply merges greedily by rank.
      while (ids.length >= 2) {
        let bestRank = Infinity;
        let bestIdx = -1;
        for (let i = 0; i < ids.length - 1; i++) {
          const rank = this._mergeRank.get(pairKey(ids[i], ids[i + 1]));
          if (rank !== undefined && rank < bestRank) {
            bestRank = rank;
            bestIdx = i;
          }
        }
        if (bestIdx < 0) break;
        const newId = this._mergeResult.get(pairKey(ids[bestIdx], ids[bestIdx + 1]));
        ids = ids.slice(0, bestIdx).concat([newId]).concat(ids.slice(bestIdx + 2));
      }
      for (const id of ids) out.push(id);
    }
    return out;
  }

  decode(ids) {
    // Expand each id back to its byte sequence.
    const bytes = [];
    const expand = (id) => {
      const t = this.vocab[id];
      if (!t) { bytes.push(this._byteToId.get('?'.charCodeAt(0))); return; }
      if (t.kind === 'byte') { bytes.push(t.value); return; }
      if (t.kind === 'special') {
        // Specials don't render — they're metadata. Caller should filter
        // before decode if they want pure text.
        return;
      }
      if (t.kind === 'merge') {
        expand(t.a);
        expand(t.b);
      }
    };
    for (const id of ids) expand(id);
    return Buffer.from(bytes).toString('utf-8');
  }

  toJSON() {
    return {
      spec: SPEC,
      type: this.type,
      vocab_size: this.vocab_size,
      vocab: this.vocab,
      merges: this.merges,
    };
  }

  static fromJSON(obj) {
    if (!obj || obj.spec !== SPEC) throw new Error(`tokenizer.json: expected spec=${SPEC}`);
    return new KolmTokenizer({
      vocab: obj.vocab,
      merges: obj.merges,
      vocab_size: obj.vocab_size,
      type: obj.type,
    });
  }

  sha256() {
    const canonical = JSON.stringify(this.toJSON());
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }
}

// Train a byte-level BPE tokenizer from a corpus of strings.
//
// Returns a KolmTokenizer. Vocab is special-tokens (4) + byte alphabet
// (256) + learned merges. Target vocab_size is the upper bound; if the
// corpus has fewer learnable pairs the tokenizer comes out smaller.
export function trainTokenizer(corpus, { vocab_size = 8192 } = {}) {
  if (!Array.isArray(corpus) || corpus.length === 0) throw new Error('trainTokenizer: corpus must be a non-empty array of strings');
  const baseVocabSize = SPECIAL_TOKENS.length + 256;
  const target = Math.max(baseVocabSize + 1, Math.min(vocab_size, baseVocabSize + 200_000));
  const numMerges = target - baseVocabSize;

  // Convert each corpus string into a sequence of byte-id arrays,
  // one per pre-token piece. Merges happen WITHIN a piece, not across.
  const t = new KolmTokenizer();
  const pieces = [];
  const pieceCounts = new Map();
  for (const text of corpus) {
    for (const piece of pretokenize(text)) {
      const key = piece;
      pieceCounts.set(key, (pieceCounts.get(key) || 0) + 1);
    }
  }
  for (const [piece, count] of pieceCounts) {
    const ids = bytesOf(piece).map((b) => t._byteToId.get(b));
    if (ids.length >= 2) pieces.push({ ids, count });
  }

  const merges = [];
  let nextId = baseVocabSize;

  for (let step = 0; step < numMerges; step++) {
    // Count all adjacent pairs across all pieces, weighted by count.
    const pairCounts = new Map();
    for (const p of pieces) {
      for (let i = 0; i < p.ids.length - 1; i++) {
        const k = pairKey(p.ids[i], p.ids[i + 1]);
        pairCounts.set(k, (pairCounts.get(k) || 0) + p.count);
      }
    }
    if (pairCounts.size === 0) break;
    // Find the most frequent pair. Ties broken by lexicographic key for
    // determinism.
    let bestKey = null;
    let bestCount = 0;
    for (const [k, c] of pairCounts) {
      if (c > bestCount || (c === bestCount && bestKey !== null && k < bestKey)) {
        bestKey = k;
        bestCount = c;
      }
    }
    if (!bestKey || bestCount < 2) break;
    const [aStr, bStr] = bestKey.split(',');
    const a = Number(aStr);
    const b = Number(bStr);
    const newId = nextId++;
    merges.push({ a, b, id: newId, count: bestCount });
    // Replace (a,b) with newId in every piece.
    for (const p of pieces) {
      const out = [];
      let i = 0;
      while (i < p.ids.length) {
        if (i < p.ids.length - 1 && p.ids[i] === a && p.ids[i + 1] === b) {
          out.push(newId);
          i += 2;
        } else {
          out.push(p.ids[i]);
          i++;
        }
      }
      p.ids = out;
    }
  }

  const vocab = t.vocab.slice();
  for (const m of merges) {
    vocab.push({ id: m.id, kind: 'merge', a: m.a, b: m.b, count: m.count });
  }
  return new KolmTokenizer({ vocab, merges, vocab_size: vocab.length });
}

// Lightweight summary for `kolm tokenize inspect`.
export function summarizeTokenizer(tok) {
  const byKind = { special: 0, byte: 0, merge: 0 };
  for (const t of tok.vocab) byKind[t.kind] = (byKind[t.kind] || 0) + 1;
  return {
    spec: SPEC,
    type: tok.type,
    vocab_size: tok.vocab_size,
    by_kind: byKind,
    merges_count: tok.merges.length,
    sha256: tok.sha256(),
    specials: SPECIAL_TOKENS,
  };
}
