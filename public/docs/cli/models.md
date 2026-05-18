# kolm models

Inspect the frontier catalog and pre-cache model weights from HuggingFace.
Two halves: catalog verbs (`frontier`, `tiers`, `show`, `verify`) that read
`src/model-registry.js` (W217), and weights verbs (`manifest`, `pull`,
`prefetch`, `cache`) that read `src/model-weights-manifest.js` and stream
GGUF files into `~/.kolm/models` (W386).

## Catalog

```
kolm models frontier                        list verified frontier rows
kolm models tiers                           list hardware tier presets
kolm models backends                        list runtime backends
kolm models show <id>                       single-row inspection
kolm models verify                          re-fetch source URLs, fail on 4xx/5xx
kolm models benchmarks                      published scores per row
kolm models verify-benchmarks               re-run published scores locally
kolm models add <id> ...                    register a custom base
```

## Weights (W386)

```
kolm models manifest [--tier=<t>] [--json]            print the GGUF manifest
kolm models pull <id> [--variant=<q>]                 download one variant
kolm models prefetch [--tier=<t>] [--concurrency N]   pull every variant in a tier
kolm models cache list [--json]                       what is on disk
kolm models cache clear [<id>]                        delete one model or all
kolm models cache rescan                              rebuild index.json from disk
```

### Tiers

Tiers are keyed off the GGUF download size, not the GPU class. Pick the one
that fits the disk and bandwidth you can spare.

| tier         | typical models                                | rough size |
|--------------|------------------------------------------------|------------|
| `edge`       | SmolLM2-1.7B, Qwen 2.5 0.5B/1.5B, Phi 3.5 mini | ~7 GB      |
| `mobile`     | Gemma 2 2B, Phi 3.5 mini, Llama 3.2 3B         | ~6 GB      |
| `laptop`     | Qwen 2.5 7B, Llama 3.1 8B                      | ~10 GB     |
| `workstation`| Qwen 2.5 14B / 32B, Llama 3.3 70B Q4           | ~50 GB     |
| `datacenter` | Qwen 2.5 72B fp16, large MoE variants          | ~140 GB    |

### Examples

```
kolm models manifest --tier=edge                   # plain-text table
kolm models prefetch --tier=edge                   # ~7 GB into ~/.kolm/models
kolm models pull microsoft/Phi-3.5-mini-instruct   # one model, default quant
kolm models pull Qwen/Qwen2.5-7B-Instruct --variant=q4_0
kolm models cache list                             # what is on disk
kolm models cache clear Qwen/Qwen2.5-0.5B-Instruct # remove one model
kolm models cache rescan                           # reconcile after a crash
```

### How it works

The puller streams over `node:https` with Range support, so an interrupted
download resumes from `<file>.part` instead of restarting. SHA-256 is verified
when the manifest carries the hash; otherwise byte-count is the integrity
check. Files land at `~/.kolm/models/<slug>/<filename>` and the JSON index
at `~/.kolm/models/index.json` tracks every entry.

If the dev machine crashes mid-prefetch and the index falls behind the
on-disk files, `kolm models cache rescan` walks the directory, matches each
slug against the manifest, and rewrites `index.json` to reflect truth.

### HTTP endpoints

The same manifest is served by the backend so other tools can read it:

- `GET /v1/models/manifest` returns the full table as JSON.
- `GET /v1/models/manifest?tier=edge` filters by tier.
- `GET /v1/models/pull?id=<id>&variant=<q>` returns a 302 to the public
  HuggingFace resolve URL. No auth required; HuggingFace itself enforces any
  gating on the upstream side.
- `GET /v1/models/cache` returns the local cache index on the API host.

### Disclosure

Where the W217 frontier catalog lists a 2026 model that has not yet shipped
weights, the manifest falls back to the closest currently-shipping repo on
HuggingFace and records the substitution in the per-variant `notes` field.
Example: `google/gemma-3n-e2b-it` (announced) maps to `bartowski/gemma-2-2b-it-GGUF`
until the e2b weights are published. Run `kolm models manifest --json` to
inspect the substitutions.

## See also

- `/models` - the public catalog page; the Pre-cached weights section reads
  `/v1/models/manifest` + `/v1/models/cache` live.
- `kolm compile --tier=<t>` to compile against the matching base.
- `kolm doctor --detect-hw` to recommend a tier based on local hardware.
