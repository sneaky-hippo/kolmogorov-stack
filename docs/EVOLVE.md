# EVOLVE — from a skeleton LoRA to a living local model

> The full picture. How an empty adapter on a fresh box becomes a model
> that gets demonstrably better at the task every time it runs. Without
> ever phoning home.

This doc is the spine. Two sister docs zoom in:

- [`TUNE.md`](TUNE.md) — the `kolm tune` family of verbs (`init`, `capture-on`,
  `step`, `eval`, `promote`, `rollback`, `watch`, `status`).
- [`RAG.md`](RAG.md) — the `kolm rag` family for airgapped local lookup
  (`index`, `query`, `attach`, `list`).

---

## The arc, in one breath

```
spec.json ──► kolm compile ──► artifact.kolm ──► kolm tune init ──► v0 skeleton
                                                                       │
                                                                       ▼
   kolm rag attach    ◄──   kolm rag index     ◄───  local corpus
                                                                       │
                                                                       ▼
   kolm install <harness>  ──►  agent calls artifact   ──►  capture(input,output)
                                                                       │
                                                                       ▼
                                                            captures.jsonl grows
                                                                       │
                                                                       ▼
                                                      threshold crossed (200 rows)
                                                                       │
                                                                       ▼
                                                            kolm tune step (--airgap)
                                                                       │
                                                                       ▼
                                                            v1 candidate written
                                                                       │
                                                                       ▼
                                                            kolm tune eval --rev v1
                                                                       │
                                                                       ▼
                                                ┌─── K-score(v1) ≥ 0.85 AND ≥ K(head)? ───┐
                                                │                                            │
                                                ▼ YES                                        ▼ NO
                                       kolm tune promote                              kolm tune step ↺
                                       HEAD = v1                                       (more captures,
                                       hot-reload serve                                 different lr,
                                                │                                       eval again)
                                                ▼
                              agent keeps calling, captures keep flowing,
                              the model keeps improving — without ever
                              leaving the box.
```

---

## Six properties that make this loop unique

1. **Cold start is identity.** `kolm tune init` writes a zero-init LoRA. The model
   behaves exactly like the base — no surprises, no regression risk. The skeleton
   is signed into the artifact's tune-dir; the receipt records its config.

2. **Captures are local-only by construction.** `captures.jsonl` lives under
   `~/.kolm/tune/<artifact>/`. No network code touches it. The capture appender
   in `src/tune.js:appendCapture` is a pure file-append. There is no upload path,
   no analytics, no opt-in telemetry. The data physically cannot leave the box.

3. **Training is airgap-strict.** `kolm tune step --airgap` sets
   `TRANSFORMERS_OFFLINE=1`, `HF_HUB_OFFLINE=1`, `HF_DATASETS_OFFLINE=1` in the
   trainer subprocess env. The trainer (`scripts/tune-step.py`) actively rejects
   any `base_model` that is not a local path that exists. A remote model id
   (`mistralai/Mistral-7B-…`) fails fast with a clear message; an absolute path
   to a local checkout proceeds.

4. **Promotion is K-score gated.** A candidate revision only becomes the head if
   its K-score is ≥ the project's gate (default 0.85) AND ≥ the current head's
   K-score (when `require_improvement: true` in `tune-config.json`, which is the
   default). The K-score itself is computed by `src/artifact.js:computeKScore`,
   the same formula that gated the original compile. One ruler.

5. **Rollback is a file rename.** `kolm tune rollback` swaps `HEAD` with
   `head.prev`. No data is lost. If a promotion turns out to underperform in
   production runs, the prior revision is one command away.

6. **The watcher is optional but fully autonomous.** `kolm tune watch` is a
   daemon: it polls `captures.jsonl` size every N seconds; when the row count
   grows past `tune-config.watch.threshold_rows`, it auto-runs step + eval +
   (gated) promote, and logs every state change to `~/.kolm/logs/tune.jsonl`.
   If the gate blocks, the watcher does NOT promote — it logs `gate_blocked`
   and goes back to waiting. The next batch of captures gets a fresh attempt.

---

## What "airgapped" means here, precisely

When the user adds `--airgap` to `kolm tune step`, the kolm orchestrator does
four things, each verifiable by reading the source:

1. **Env propagation.** Sets `KOLM_AIRGAP=1`, `TRANSFORMERS_OFFLINE=1`,
   `HF_DATASETS_OFFLINE=1`, `HF_HUB_OFFLINE=1` in the spawned Python's `env`
   dict (see `src/tune.js:runTuneStepWith`).

2. **Base-model path validation.** Before any model load, the trainer reads
   `tune-config.json` for `base_model`. If `KOLM_AIRGAP=1` AND
   (`base_model` contains `://` OR `Path(base_model).expanduser().exists()`
   is false), `tune-step.py` exits with a clean message — no partial load,
   no DNS lookup, no cache hit on stale data (see `scripts/tune-step.py:main`).

3. **No outbound network in JS.** The orchestrator only spawns Python and reads
   stdout. There is no `fetch`, no `http` import in `src/tune.js`. The only IO
   is local file IO under `~/.kolm/tune/`.

4. **The bench harness still patches `fetch`/`http`/`https`/`net`/`tls`/`dns`
   when running evals.** Any recipe that tries to call out during eval fails the
   benchmark, which would in turn fail the K-score, which would fail promotion.
   Egress is impossible to hide.

---

## Where "lookup" fits in

A local model that has been fine-tuned still needs to look things up. Some facts
change too often to bake into weights (policies, prices, schemas, runbooks). For
those, kolm ships `kolm rag` — a pure-BM25 (no embedder, no network) local index.

The flow:

1. `kolm rag index ./docs --name internal-docs` — builds a BM25 inverted index
   over the directory. The index is one JSON file under `~/.kolm/rag/<name>/`.
   No external model required. Pure JavaScript tokenizer + tf/idf math.

2. `kolm rag attach ./artifacts/help-bot.kolm --index internal-docs` — writes a
   tiny `<artifact>.kolm.rag.json` sidecar pinning the index. The artifact's
   manifest receipt does not change (we don't re-sign), but the runner picks
   the attachment up at run time.

3. Inside the recipe sandbox, `lib.rag` is now defined:

   ```js
   function generate(input, lib) {
     if (!lib.rag) throw new Error('this recipe requires kolm rag attach');
     var hits = lib.rag.query(input.q, 3).matches;
     // ... do something with hits
   }
   ```

4. The recipe runs locally, hits the local index, returns. Zero egress.

When you eventually want denser-than-BM25 recall, the design supports plugging
in an ONNX MiniLM embedder (24 MB, runs CPU); `kolm rag index --use-onnx` is
the planned switch. v7.6 ships BM25 first to keep the install zero-deps.

---

## Why a LoRA, not a full fine-tune?

- **Cost.** LoRA adapters are 100–1000× smaller than the base. A 7B model fits
  in 14 GB; the adapter is ~30 MB.
- **Composability.** Different adapters for different tasks (the redactor
  adapter, the classifier adapter, the SQL adapter) coexist on the same base.
- **Reversibility.** Promotion is a metadata flip. Rollback is a metadata flip
  the other way. Full fine-tunes lose the base permanently.
- **Airgap-friendly.** The base weights are downloaded once (offline,
  pre-staged). Every subsequent step is `base + Δ` where `Δ` is small enough
  to inspect, diff, and audit.

---

## Where the "living" part comes from

A model that does not change is just an artifact. A model that changes blindly
is dangerous. The kolm loop threads the needle:

- **Every interaction is a training signal.** Captures are `(input, output)`
  pairs from real production runs. They are higher quality than synthetic data
  because they reflect the actual distribution the artifact lives in.

- **Every signal goes through a gate.** The K-score is computed on the artifact's
  own evals — the same evals that gated the original compile. If a candidate
  revision starts overfitting to recent captures and forgets earlier behavior,
  K-score drops, the gate refuses to promote, the watcher logs the event, and
  the head stays where it was.

- **Every gate is logged.** `~/.kolm/logs/tune.jsonl` records `step_triggered`,
  `step_complete`, `eval_complete` (with the K-score), `promoted`, `gate_blocked`,
  `step_failed`. The whole evolution is auditable.

The model is alive in the sense that an organism is alive: it changes in response
to its environment, but the changes are constrained by checks that protect it
from drifting beyond what its own tests will tolerate.

---

## Reading order from here

1. [`TUNE.md`](TUNE.md) — verb-by-verb walkthrough of `kolm tune`, every flag.
2. [`RAG.md`](RAG.md) — the BM25 index format, query semantics, attach contract.
3. [`HOOKS.md`](HOOKS.md) — how to interpose policy on every step of the loop.
4. [`AUTHORING.md`](AUTHORING.md) — the recipe spec format that compiles to `.kolm`.
5. [`PRODUCT.md`](PRODUCT.md) — the terminal product spec; how all of these fit
   together into one mental model.
6. [`rs-1.md`](rs-1.md) — the RS-1 wire format for `.kolm` files.

---

## Files this loop touches

| Path                                          | Owner            | When written                                         |
|-----------------------------------------------|------------------|------------------------------------------------------|
| `~/.kolm/tune/<artifact>/tune-config.json`    | `kolm tune init` | Once at init. Updated by `capture-on`/`capture-off`. |
| `~/.kolm/tune/<artifact>/captures.jsonl`      | runner           | Append on every `kolm run` when captures are on.     |
| `~/.kolm/tune/<artifact>/revisions/vN/`       | trainer          | One dir per `kolm tune step`.                        |
| `~/.kolm/tune/<artifact>/HEAD`                | `tune promote`   | Single line: current revision id.                    |
| `~/.kolm/tune/<artifact>/head.prev`           | `tune promote`   | The promotion before the current one.                |
| `~/.kolm/logs/tune.jsonl`                     | `tune watch`     | One JSON line per state change.                      |
| `~/.kolm/logs/runs.jsonl`                     | runner           | One row per `kolm run` (regardless of tune state).   |
| `<artifact>.kolm.rag.json`                    | `kolm rag attach`| Sidecar pointing at a rag index.                     |

The artifact itself (`<artifact>.kolm`) is **never modified by the loop**. The
signed manifest stays put. Evolution lives in sidecar paths that the runner
loads at execution time. This is how the model evolves while the artifact's
audit receipt stays cryptographically stable.
