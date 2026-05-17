# RS-1 · the .kolm artifact contract

**Status:** This is the v0.1 working draft. The canonical specification is **RS-1 v2.0** at [/spec/rs-1](/spec/rs-1), which describes the shipping implementation including the four-class recipe taxonomy (`rule` / `synthesized_rule` / `compiled_rule` / `distilled_model`), the three-signature cascade (HMAC-SHA256 + Ed25519 + sigstore), the seeds.jsonl train/holdout split for eval independence, pretokenization (KOLMIDX2/KOLMPCK2), MoE composition, the PHI redactor chain extension, and cross-vendor distillation manifest fields. Where this draft and v2.0 disagree, v2.0 wins.

---

A `.kolm` is the binary that comes out of `kolm compile`. RS-1 is the contract that makes one `.kolm` byte-identical to another given the same inputs, signed end-to-end, and runnable on any device that can read the format.

This document describes what is inside the file, how the bytes are arranged, and what a runtime must verify before it executes a single token.

---

## 1. File shape

A `.kolm` is a deterministic ZIP archive. No compression timestamps. Members appear in the order below; runtimes MAY accept any order, but compilers MUST emit this order so that two compiles with identical inputs produce identical bytes.

| # | Member | Required | Description |
|---|--------|----------|-------------|
| 1 | `manifest.json` | yes | The artifact's identity card. See §2. |
| 2 | `recipes.json` | yes | The deterministic-token draft pack. May be empty `{}`. |
| 3 | `evals.jsonl` | yes | Embedded evals · one JSON object per line. May be empty. |
| 4 | `receipt.json` | yes | The signature chain. See §4. |
| 5 | `model.ptr` | yes | Pointer to the base model (sha256 + URL). The model bytes are NOT in the artifact. |
| 6 | `lora.bin` | optional | LoRA delta. Absent = base model only. |
| 7 | `index.sqlite-vec` | optional | Recall index. Absent = no grounding. |

Two compiles with the same `(task, examples, base_model, recipe_registry@version, corpus_namespace)` produce the same SHA-256.

## 2. manifest.json

```json
{
  "spec": "rs-1",
  "schema": "manifest-v0.1",
  "task": "summarize support tickets",
  "compiled_at": "2026-05-08T00:00:00Z",
  "base_model": {
    "name": "qwen2.5-coder-7b-instruct-q4_0",
    "sha256": "…"
  },
  "recipe_registry": {
    "version": "2026-05-01",
    "url": "https://kolm.ai/v1/registry/export"
  },
  "k_score": {
    "spec": "k-score-1",
    "composite": 0.71,
    "accuracy": 0.92,
    "coverage": 0.41,
    "size_bytes": 2147483648,
    "p50_latency_us": 18000,
    "cost_usd_per_call": 0.0
  },
  "compiler": { "name": "kolm", "version": "0.1.0" }
}
```

The `spec` and `schema` keys are load-bearing. A runtime SHOULD refuse any artifact with an unknown `spec`.

## 3. recipes.json

Recipes are the deterministic-token subset of the model's behavior. Each recipe is a (prefix-shape → tokens) draft. The runtime consults the pack before sampling; if the prefix-shape matches, the recipe wins and the token is emitted without inference.

```json
{
  "recipes": [
    {
      "id": "json-array-comma",
      "shape": "after a value inside an array",
      "tokens": [","],
      "coverage": 0.041
    }
  ]
}
```

The pack is a registry-co-signed subset; `recipe_registry.version` in the manifest names the snapshot.

## 4. receipt.json

The receipt is an HMAC chain over every member of the archive, in the order listed in §1. It also carries a verifier signature for the chosen `recipe_registry@version` so a third party can re-derive the chain without trusting the compiler.

```json
{
  "spec": "receipt-v0.1",
  "alg": "HMAC-SHA256",
  "signed_at": "2026-05-08T00:00:00Z",
  "signer": "kolm-cloud@kolm.ai",
  "chain": [
    { "member": "manifest.json", "sha256": "…" },
    { "member": "recipes.json",  "sha256": "…" },
    { "member": "evals.jsonl",   "sha256": "…" },
    { "member": "model.ptr",     "sha256": "…" },
    { "member": "lora.bin",      "sha256": "…", "optional": true },
    { "member": "index.sqlite-vec", "sha256": "…", "optional": true }
  ],
  "registry_signature": "…",
  "signature": "…"
}
```

A runtime MUST verify the signature before loading any model bytes.

## 5. model.ptr

```json
{
  "kind": "huggingface",
  "name": "qwen2.5-coder-7b-instruct-q4_0",
  "sha256": "…",
  "url": "https://huggingface.co/…/resolve/main/qwen2.5-coder-7b-instruct.q4_0.gguf"
}
```

The model bytes live outside the artifact so a `.kolm` is small enough to email. The runtime is responsible for resolving and caching the bytes; the receipt anchors the SHA-256 so substitution is detected.

## 6. Reproducibility rules

A compiler that claims RS-1 conformance MUST:

1. Emit members in the order given in §1.
2. Use ZIP store (no compression) with timestamps fixed to `1980-01-01T00:00:00Z`.
3. Sort JSON keys lexicographically and use `\n` line endings.
4. Pin the `recipe_registry.version` and the `base_model.sha256` exactly.

A runtime that claims RS-1 conformance MUST:

1. Verify the receipt chain before loading any model or LoRA byte.
2. Refuse to execute if `manifest.spec` is unknown.
3. Treat `index.sqlite-vec` as advisory unless the manifest declares grounded mode.

## 7. License

RS-1 is published under MIT. The intent is that any runtime · ours, a competitor's, an academic project · can implement RS-1 without asking permission. The receipt anchor (the registry public key) is the only externally-mutable input; everything else is self-describing.

## 8. Versioning

`spec` strings are immutable. A breaking change creates `rs-2`. Non-breaking additions get new optional members and bump only the `schema` field on the affected document.

 ·  see also: [manifest-v0.1.json](/docs/manifest-v0.1.json), [receipt-v0.1.json](/docs/receipt-v0.1.json).
