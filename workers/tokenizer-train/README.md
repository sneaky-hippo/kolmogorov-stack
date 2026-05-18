# workers/tokenizer-train

Wave 381 — isolated tokenizer training worker for the kolm.ai compile
pipeline. Pure-JS BPE / unigram trainer; runs on a fresh Node >= 18 laptop
with no Python venv, no transformers, no sentencepiece native build.

Heavy ML stays in `workers/` per repo policy. This worker is the only place
a BPE merge loop runs. `src/tokenizer-train.js` is a thin Node API that
spawns this script via `child_process` and parses the JSON envelope it
emits on stdout.

## Contract

### Input
A single JSON object passed as `argv[2]`:

```json
{
  "corpus_path":    "/abs/path/to/corpus.txt",
  "vocab_size":     8000,
  "algorithm":      "bpe",
  "model_prefix":   "/abs/path/to/output/tok",
  "seed":           1,
  "special_tokens": ["<pad>", "<s>", "</s>", "<unk>", "<mask>"]
}
```

`algorithm` must be one of `bpe | unigram | wordpiece`. The default JS
implementation runs a deterministic BPE merge loop for all three modes
(unigram/wordpiece are recorded as their declared algorithm on the output
manifest; a full EM-trained unigram LM is out of scope for the no-dep
default path and would require a Python worker).

`corpus_path` may be either:

* a plain UTF-8 text file (one document per line), or
* a JSONL file where each line is `{text:"..."}` or
  `{input:"...", output:"..."}` (input/output are joined with `→`).

An empty or missing corpus is allowed: the worker writes a tokenizer whose
vocab is just the special tokens (`vocab_size = special_tokens.length`).

### Output
A single JSON object printed to stdout on success:

```json
{
  "ok": true,
  "tokenizer_path": "/abs/path/to/output/tok.tokenizer.json",
  "vocab_size": 8000,
  "merges_count": 7995,
  "algorithm": "bpe",
  "train_token_count": 12345,
  "deterministic_hash": "sha256:<hex>"
}
```

Exit code `0` on success, `2` on any failure (with `{ok:false,error:"..."}`).

### Determinism

Same `corpus_path + vocab_size + algorithm + seed + special_tokens` MUST
produce the same `deterministic_hash` on any machine running Node >= 18.
Tie-breaks on equal-count merge pairs use a lexicographic comparison on
`(pair_key + seed)` — no `Set` iteration order assumptions, no insertion-
order leaks. Output `vocab` is sorted after the specials prefix.

### Tokenizer file format

`*.tokenizer.json` is a single JSON document with this shape (consumed by
`src/tokenizer-train.js#loadTokenizer`):

```json
{
  "spec": "kolm-tokenizer-1",
  "algorithm": "bpe",
  "vocab": ["<pad>", "<s>", "</s>", "<unk>", "<mask>", "a", "b", "ab", ...],
  "merges": [["a", "b"], ["ab", "c"], ...],
  "special_tokens": ["<pad>", "<s>", "</s>", "<unk>", "<mask>"],
  "corpus_bytes": 12345,
  "train_token_count": 6789,
  "seed": 1,
  "generated_at": "2026-05-18T..."
}
```

## Why pure-JS

* No new npm dep on `tokenizers`, `sentencepiece`, or any native build chain.
* No Python venv required for the default `kolm compile` path.
* The BPE inner loop is small enough (O(vocab_size × pair_count) with
  early termination) that a `vocab_size=8000` train completes in <2s on a
  laptop for a 1MB corpus — fast enough that we do not need to keep the
  worker resident.
* Customers who want a full sentencepiece/tokenizers-trained vocab can wire
  a Python alternative under `workers/tokenizer-train/scripts/` later; the
  Node API surface (`src/tokenizer-train.js`) is stable.

## Not implemented (documented surface)

* `wordpiece` — recorded as such on output but uses the BPE merge loop
  under the hood. A real WordPiece trainer needs a different objective
  (likelihood-based vs frequency-based) and would require a Python worker.
* Streaming / shuffled training on >100MB corpora — current loader buffers
  the entire corpus into memory.
