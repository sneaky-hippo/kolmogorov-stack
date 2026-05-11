# RAG — airgapped local lookup for `kolm` recipes

> Make local knowledge queryable from inside a recipe sandbox. Pure-JS BM25.
> No external embedder. No network. No daemons.

---

## Why this exists

A locally-tuned model still needs to look things up. Some facts change too often
to bake into weights:

- policies (HIPAA, PCI, internal compliance rules)
- prices, schemas, contracts, runbooks
- the team wiki, last month's incident reports, the SOPs PDF

The conventional answer is "use a vector DB." That answer drags in an embedder
(at least 22 MB ONNX, or a network call), a similarity index, an upgrade
treadmill, and an operational surface that defeats the airgap.

`kolm rag` ships the simplest thing that actually works: a deterministic,
single-file BM25 index built in pure JavaScript. No external model. No network
at index time, query time, or attach time. The whole subsystem fits in
~250 lines of code in `src/rag.js`.

For users who want denser-than-BM25 recall, the design has a clean seam to
plug in a local ONNX MiniLM embedder; that lands in a later kolm release. v7.6
ships BM25 first to keep the install zero-deps.

---

## Verb reference

### `kolm rag index <dir>`

**Purpose.** Walk a directory, tokenize files, build an inverted index. Write
the index to `~/.kolm/rag/<name>/`.

**Usage.**
```
kolm rag index <dir> [--name <slug>] [--ext txt,md,json,html] [--max-bytes 4194304]
```

**Flags.**

| Flag           | Default                  | Meaning                                                                            |
|----------------|--------------------------|------------------------------------------------------------------------------------|
| `<dir>`        | —                        | Required positional. The root directory to index. Recursive.                       |
| `--name`       | basename of `<dir>`      | Index slug. Used by `kolm rag query` and `kolm rag attach`.                        |
| `--ext`        | `txt,md,json,html`       | Comma-separated extensions to include. Other files are skipped.                    |
| `--max-bytes`  | 4 MB                     | Per-file size cap. Bigger files are skipped (logged, not indexed).                 |

**Walked.** Recursively, sorted by path (deterministic). `node_modules/` and
dotfile dirs are skipped.

**Tokenization.** Lowercase, strip non-alphanumeric/non-hyphen/non-underscore,
split on whitespace, drop tokens shorter than 2 chars or longer than 64,
filter ~30 common English stopwords. (See `src/rag.js:tokenize`.)

**BM25 parameters.** `k1 = 1.5`, `b = 0.75` — standard. Configurable via the
JS API (`indexDir({ ..., k1, b })`) but not yet via CLI flag.

**Output.**
```
ok  indexed 247 docs
    name:    internal-docs
    root:    /home/me/notes
    avgdl:   1195 tokens/doc
    size:    115.8 KB
    sha256:  39ad2f33d12958b5…
    next:    kolm rag query internal-docs "<question>"
```

**Files written.**
- `~/.kolm/rag/<name>/index.json` — the index (postings, df, doc list).
- `~/.kolm/rag/<name>/manifest.json` — compact summary (name, root, n_docs,
  sha256, size_bytes, created_at). Used by `kolm rag list` and by the runner.

**Idempotency.** Re-running `kolm rag index <dir>` clobbers the prior index.
The sha256 in the manifest changes if and only if the indexed content changes.

---

### `kolm rag query <name> "<question>"`

**Purpose.** BM25-score every doc against the question, return the top-k.

**Usage.**
```
kolm rag query <name> "<question>" [--top-k 5] [--json]
```

**Flags.**

| Flag        | Default | Meaning                                          |
|-------------|---------|--------------------------------------------------|
| `--top-k`   | 5       | Number of matches to return.                     |
| `--json`    | off     | Emit machine-readable JSON instead of pretty text. |

**Pretty output.**
```
# query: how does the K-score gate work
# index: internal-docs (247 docs)
# tokens: how does k-score gate work

[1] score=5.9632  PRODUCT.md
    … gate (default 0.85). The gate runs at compile-time, at install-time, and
    at serve-time. Three layers, same number. …

[2] score=5.1177  SOTA-amendments-2026-05-11.md
    … the K-score gate refuses to expose low-K artifacts via MCP. Same number,
    enforced three places. …
```

**Excerpt window.** 240 chars centered on the first query-token hit; if no
hit (which shouldn't happen if the doc scored), falls back to the first 240
chars of the file.

---

### `kolm rag attach <art.kolm> --index <name>`

**Purpose.** Pin a rag index to an artifact so the runner exposes `lib.rag`
inside the recipe sandbox.

**Usage.**
```
kolm rag attach <art.kolm> --index <name>
```

**Writes.** `<art.kolm>.rag.json` (sidecar next to the artifact):
```json
{
  "spec": "rag-attach-1",
  "index_name": "internal-docs",
  "attached_at": "2026-05-11T18:30:00Z"
}
```

The artifact itself is **not** re-signed. The attachment is metadata that lives
alongside the artifact. The receipt in the `.kolm` is unaffected.

To detach: delete the sidecar (`rm <art.kolm>.rag.json`).

---

### `kolm rag list`

**Purpose.** Print every index under `~/.kolm/rag/`.

**Usage.**
```
kolm rag list
```

**Output.**
```
internal-docs            247 docs   115.8KB  /home/me/notes
compliance-runbooks       89 docs    42.1KB  /home/me/policies
```

---

## Using `lib.rag` inside a recipe

Once an artifact has been attached to an index, the recipe sandbox sees
`lib.rag`:

```js
function generate(input, lib) {
  // Defensive: this recipe needs rag.
  if (!lib.rag) throw new Error('attach a rag index: kolm rag attach <art> --index <name>');

  // Query the local index.
  var hits = lib.rag.query(input.q, 5).matches;
  if (!hits.length) {
    return { answer: 'no relevant docs found', sources: [] };
  }

  // Compose an answer from the top excerpt.
  var top = hits[0];
  return {
    answer: top.excerpt,
    sources: hits.map(function (h) { return { path: h.path, score: h.score }; }),
  };
}
```

**Shape of `lib.rag.query(q, k)`.**
```ts
{
  matches: Array<{
    score: number;       // BM25 score, rounded to 4 decimals
    path: string;        // relative path inside the indexed root
    preview: string;     // first 240 chars of the doc
    excerpt: string;     // 240-char window centered on the first query-token hit
  }>;
  n_docs: number;        // total docs in the index
  query_tokens: string[];// tokens that survived stopword/length filtering
}
```

**Sandbox guarantees.** `lib.rag.query` does pure file IO under
`~/.kolm/rag/<name>/`. No subprocess. No network. The artifact's eval suite
will pass exactly the same way whether the index has 1 doc or 100,000.

---

## Index format (`index.json`)

```json
{
  "spec": "rag-bm25-1",
  "name": "internal-docs",
  "created_at": "2026-05-11T18:00:00Z",
  "root": "/home/me/notes",
  "n_docs": 247,
  "avgdl": 1195.3,
  "k1": 1.5,
  "b": 0.75,
  "docs": [
    {
      "id": 0,
      "path": "policies/hipaa.md",
      "abs": "/home/me/notes/policies/hipaa.md",
      "len": 1480,
      "preview": "HIPAA technical safeguards · 45 CFR §164.312 …"
    }
  ],
  "df": { "hipaa": 12, "phi": 8, "audit": 31 },
  "postings": { "hipaa": [[0, 14], [22, 3]], "phi": [[0, 7]] }
}
```

`postings[term]` is a list of `[doc_id, term_frequency]` pairs.

The format is intentionally readable. You can `jq .docs[].path` to list
indexed paths, or `jq '.postings.hipaa | length'` to see how many docs
matched a term.

---

## When NOT to use BM25

- **Multi-language corpora.** The stopword list is English-only. Adapt or skip.
- **Synonyms.** BM25 doesn't know "MRN" ≈ "medical record number." Either
  expand the query yourself (`q + " " + synonyms.join(' ')`) or wait for the
  ONNX dense option.
- **Tiny indexes (<10 docs).** BM25 needs some doc count to compute decent
  idf weights. With <10 docs, just grep.
- **Code search.** Tokenization is text-shaped. For code, ripgrep is better;
  use that and wrap it in a recipe if you must.

---

## Failure modes you'll see

| Symptom                                          | Cause                                         | Fix                                                                          |
|--------------------------------------------------|-----------------------------------------------|------------------------------------------------------------------------------|
| `kolm rag index` exits "no files matched"        | `--ext` filter excluded everything            | Add the right extensions, e.g. `--ext md,txt,pdf` (but pdf isn't tokenized). |
| Query returns 0 matches                          | All query tokens fell out (stopwords)         | Try with a more specific query.                                              |
| Index file is huge                               | You indexed `node_modules`                    | The walker skips `node_modules` by default. Check for vendored copies.       |
| `lib.rag is undefined` inside recipe             | No `<art>.rag.json` sidecar                   | `kolm rag attach <art> --index <name>`.                                      |

---

## Roadmap

- v7.6 (this release): BM25, pure JS, zero deps. **Shipped.**
- v7.7: optional ONNX MiniLM (`--use-onnx`). Add `--rerank` for hybrid.
- v7.8: cross-encoder rerank stage (also ONNX).
- v8.0: incremental indexing (`kolm rag index --add file.md`); index diffing.

Until then, re-running `kolm rag index <dir>` is the supported "update" path.
It is fast (~1 s for ~10 MB of text) and the index is one file.
