# TUNE — verb reference for `kolm tune`

> Every flag, every exit code, every config field. See [`EVOLVE.md`](EVOLVE.md)
> for the conceptual arc; this doc is for users running the commands.

---

## TL;DR — the canonical first run

```bash
# 1. Compile an artifact (covered elsewhere).
kolm compile --spec my-redactor.spec.json --out ./artifacts/redactor.kolm

# 2. Pre-stage the base-model weights for airgap mode.
huggingface-cli download Qwen/Qwen2.5-Coder-7B-Instruct --local-dir ~/models/qwen-coder-7b

# 3. Initialize a skeleton LoRA against those weights.
kolm tune init --artifact ./artifacts/redactor.kolm --base ~/models/qwen-coder-7b --rank 8 --alpha 16

# 4. Turn captures on. From now on, every `kolm run` records (input, output).
kolm tune capture-on --artifact redactor.kolm

# 5. Use it for a while. (Either you directly, or your agent via MCP.)
kolm install claude-code --apply   # so Claude Code calls the artifact

# ... time passes, captures.jsonl grows ...

# 6. Run one step. --airgap blocks all network in the trainer.
kolm tune step --artifact redactor.kolm --airgap --epochs 1

# 7. Verify the candidate scores at least as well as the current head.
kolm tune eval --artifact redactor.kolm --rev v1

# 8. Promote. K-score gate enforced; refuses if v1 < gate.
kolm tune promote --artifact redactor.kolm --rev v1

# 9. (Optional) Let the watcher daemon do steps 6–8 automatically.
kolm tune watch --artifact redactor.kolm
```

---

## Verb reference

### `kolm tune init`

**Purpose.** Scaffold the skeleton LoRA. Idempotent: re-running on an already-init'd
artifact prints the existing HEAD and exits without writing anything.

**Usage.**
```
kolm tune init --artifact <art.kolm> --base <model_path_or_id> \
               [--rank 8] [--alpha 16] [--dropout 0.05]
```

**Flags.**

| Flag         | Default | Meaning                                                                                                |
|--------------|---------|--------------------------------------------------------------------------------------------------------|
| `--artifact` | —       | Required. Path to the `.kolm` artifact. May be a basename in `~/.kolm/artifacts/`.                     |
| `--base`     | —       | Required. Local path (preferred) or HuggingFace model id for the base model.                           |
| `--rank`     | 8       | LoRA rank. Higher = more capacity, larger adapter.                                                     |
| `--alpha`    | 16      | LoRA alpha. Convention: alpha = 2 × rank.                                                              |
| `--dropout`  | 0.05    | LoRA dropout (regularization).                                                                         |

**Writes.**
- `~/.kolm/tune/<slug>/tune-config.json` — kolm-side config (gate, watch threshold, captures flag).
- `~/.kolm/tune/<slug>/revisions/v0/adapter_config.json` — PEFT skeleton (zero-init, marked `skeleton: true`).
- `~/.kolm/tune/<slug>/HEAD` — single line `v0`.

**Exit codes.** 0 on success, 1 if the artifact is missing.

---

### `kolm tune capture-on` / `capture-off`

**Purpose.** Toggle the per-artifact capture flag.

**Usage.**
```
kolm tune capture-on  --artifact <art.kolm>
kolm tune capture-off --artifact <art.kolm>
```

When ON, `cli/kolm.js:cmdRun` calls `src/tune.js:appendCapture` after every
successful `kolm run` against this artifact. Each row carries `ts`, `input`,
`output`, `recipe`, `latency_us`.

**Where the rows go.** `~/.kolm/tune/<slug>/captures.jsonl`.

**What does not get captured.** Failed runs (we don't train on errors).
Bench runs (those are reproducibility checks, not user signal).

---

### `kolm tune step`

**Purpose.** Spawn one supervised-fine-tune pass over `captures.jsonl`. Writes
a new revision dir (`v(N+1)`) under `~/.kolm/tune/<slug>/revisions/`.

**Usage.**
```
kolm tune step --artifact <art.kolm> \
               [--epochs 1] [--airgap] \
               [--batch-size 4] [--lr 2e-4]
```

**Flags.**

| Flag           | Default | Meaning                                                                                                                                |
|----------------|---------|----------------------------------------------------------------------------------------------------------------------------------------|
| `--epochs`     | 1       | Number of passes over the captures dataset.                                                                                            |
| `--airgap`     | off     | Sets `KOLM_AIRGAP=1`, `TRANSFORMERS_OFFLINE=1`, `HF_HUB_OFFLINE=1`, `HF_DATASETS_OFFLINE=1`. Refuses non-local `base_model`.            |
| `--batch-size` | 4       | Per-device train batch size. Lower if GPU is small.                                                                                    |
| `--lr`         | 2e-4    | Learning rate for the adapter.                                                                                                         |

**Trainer.** `scripts/tune-step.py`. Uses `peft` + `transformers` + `trl` (or
plain `Trainer` if `trl` is absent).

**Dependencies.** `kolm tune step` requires Python 3.10+ and:
```
pip install 'torch>=2.2' 'transformers>=4.42' 'peft>=0.11' \
            'datasets>=2.18' 'accelerate>=0.30' 'trl>=0.9'
```
Without them, it exits cleanly with the install command in the error message.
The rest of the `kolm tune` family does not need Python.

**Stdout.** A single JSON line at the end with `revision_dir`,
`captures_trained_on`, `epochs`, `trainable_params`, `total_params`,
`elapsed_sec`, `airgap`, `trl`, `base_model`.

**Exit codes.** 0 on success; 1 on caller error (missing artifact, no
captures yet); 64 on missing Python deps; other non-zero on trainer error
(stderr tail included in JS-side error message).

---

### `kolm tune eval`

**Purpose.** Recompute K-score against the artifact's embedded evals for a given
revision. Used to decide whether to promote.

**Usage.**
```
kolm tune eval --artifact <art.kolm> [--rev vN]
```

If `--rev` is omitted, defaults to HEAD.

**Output (stdout).**
```
revision v1
  pass:     14/15  (93.3% acc)
  p50:      82us
  K-score:  0.9314  (gate=0.85)
  ships:    YES
```

**Notes.** In v7.6, `kolm tune eval` runs the artifact's recipes as-is — the
adapter doesn't yet influence recipe execution because recipes are deterministic
sandbox code, not LM calls. The plumbing is in place for v0.2 LM-backed recipes
(where `lib.lm.generate(...)` would route through the active adapter); for now,
the eval is a faithful re-check of the artifact's compiled correctness.

---

### `kolm tune promote`

**Purpose.** If the candidate revision passes the K-score gate, flip `HEAD`
to it. Snapshot the previous head to `head.prev` for rollback.

**Usage.**
```
kolm tune promote --artifact <art.kolm> --rev vN [--force]
```

**Gates.**
- K-score(rev) ≥ `tune-config.gate.k_min` (default 0.85).
- (When `require_improvement: true`, also: K-score(rev) ≥ K-score(current HEAD).)

**Flags.**
- `--force` bypasses the K-score gate. **Avoid in production**; mostly for
  testing the rollback path.

**Exit codes.** 0 on promote; 2 with code `K_GATE` if the gate refuses; 1 on
caller error.

---

### `kolm tune rollback`

**Purpose.** Restore the previous HEAD.

**Usage.**
```
kolm tune rollback --artifact <art.kolm>
```

Swaps `HEAD` and `head.prev`. Idempotent in pairs.

---

### `kolm tune watch`

**Purpose.** Daemon. Polls `captures.jsonl`; when it grows past
`tune-config.watch.threshold_rows` (default 200), auto-runs step → eval →
promote. Logs every state change to `~/.kolm/logs/tune.jsonl`.

**Usage.**
```
kolm tune watch --artifact <art.kolm> [--interval 30000]
```

Run under a process supervisor (`systemd`, `tmux`, `pm2`) if you want it
to survive reboots.

**Log events (one JSON line per event).**
```
watch_started     { captures, threshold }
step_triggered    { captures }
step_complete     { revision }
eval_complete     { revision, k, accuracy }
promoted          { revision, previous, k }
gate_blocked      { revision, k, gate }
step_failed       { error, code? }
tick_error        { error }
```

---

### `kolm tune status`

**Purpose.** Print a snapshot of the artifact's tune state.

**Usage.**
```
kolm tune status --artifact <art.kolm>
```

**Output (JSON).**
```json
{
  "initialized": true,
  "artifact": "redactor.kolm",
  "base_model": "/home/me/models/qwen-coder-7b",
  "captures_on": true,
  "captures": 247,
  "head": "v3",
  "revisions": ["v0", "v1", "v2", "v3"],
  "gate": { "k_min": 0.85, "require_improvement": true },
  "watch": { "threshold_rows": 200, "sample_size": 32 }
}
```

---

## `tune-config.json` reference

```json
{
  "artifact": "redactor.kolm",
  "base_model": "/home/me/models/qwen-coder-7b",
  "rank": 8,
  "alpha": 16,
  "dropout": 0.05,
  "captures_on": true,
  "gate": {
    "k_min": 0.85,
    "require_improvement": true
  },
  "watch": {
    "threshold_rows": 200,
    "sample_size": 32
  },
  "created_at": "2026-05-11T18:00:00Z"
}
```

All fields are user-editable. The CLI never overwrites user-set values except
on `init` (first write) and `capture-on`/`capture-off` (flag flip only).

---

## When NOT to tune

- **Deterministic-token recipes.** A regex redactor doesn't get better with more
  data. The recipe is the program; the LoRA is irrelevant.
- **Frozen artifacts.** Compliance-anchored artifacts whose receipt must stay
  byte-stable should never tune. Init is optional; if you don't run it, the
  artifact is unchanged.
- **Pre-launch.** Until you have ≥ 200 production captures, tuning is overfitting
  to demo data. Wait.

---

## Failure modes you'll see

| Symptom                                          | Cause                                         | Fix                                                                          |
|--------------------------------------------------|-----------------------------------------------|------------------------------------------------------------------------------|
| `tune step` exits 64 with pip command            | torch/peft/transformers not installed         | Install the deps listed in the error.                                        |
| `tune step` exits with "airgap: base_model …"    | `--airgap` but `base_model` is a HF id        | Pre-stage weights, point `--base` at a local dir.                            |
| `tune promote` exits 2 `K_GATE`                  | Candidate underperforms the gate              | More captures, lower lr, or accept it's an honest "no" and don't promote.    |
| `tune eval` shows 0/0 accuracy                   | Artifact has no embedded evals                | Add evals to your spec before compile; that's how the K-score gate sees you. |
| Watcher logs `step_failed` repeatedly            | Trainer is crashing                           | `tail ~/.kolm/logs/tune.jsonl` for the error code; check Python env.         |

---

## Testing the loop without a GPU

You can exercise every verb except `tune step` without GPU/torch:

```bash
kolm tune init --artifact redactor.kolm --base /tmp/fake-model-dir
mkdir -p /tmp/fake-model-dir
kolm tune capture-on --artifact redactor.kolm
kolm run ~/.kolm/artifacts/redactor.kolm '{"text":"phone 555-1234"}'
kolm tune status --artifact redactor.kolm
# captures: 1, head: v0
```

The `step → eval → promote` chain requires the Python deps. The rest is pure
Node, runs anywhere.
