# AGENT_GUIDE.md

A field guide for AI agents (Claude, GPT-class, Cursor, Continue, Cline, internal tool-use agents) and humans who want a single sheet that tells them exactly how to drive `kolm` from the command line.

This file is the canonical companion to `src/intent.js`. The verb table below mirrors `VERB_DESCRIPTIONS` in that module, the exit-code map matches `EXIT` in `cli/kolm.js`, and the JSON error envelope is exactly what `jsonErrorEnvelope()` emits. If you wire `kolm` into an agent, you can rely on these contracts being stable.

---

## TL;DR for agents

If you do not know the verb, send the user's instruction through `kolm do`:

```
kolm do --json --dry-run "show me captures in namespace support"
```

The exit code, the JSON shape on stdout, and the verb names below are the contract.

If you want the highest-signal status of where the user is right now:

```
kolm what --json
```

If you want a ranked next-step recommendation:

```
kolm next --json
```

If something failed and you need to interpret the error, see [Error envelope](#error-envelope-json) below.

---

## Exit codes (canonical)

`cli/kolm.js` defines `EXIT = { OK: 0, BAD_ARGS: 1, GATE_FAIL: 2, MISSING_PREREQ: 3, EXECUTION: 4, NOT_FOUND: 5, USAGE: 64, RUNTIME: 4 }`. The semantic meaning is:

| Exit | Name             | When                                                              |
|------|------------------|-------------------------------------------------------------------|
| 0    | OK               | Successful run. JSON envelope `{ ok: true, ... }` on stdout.      |
| 1    | BAD_ARGS         | Caller provided invalid args (missing positional, bad flag).      |
| 2    | GATE_FAIL        | An assertion / signature / K-score gate failed (audit-only).      |
| 3    | MISSING_PREREQ   | Cloud unreachable, missing key, capture store ephemeral, etc.     |
| 4    | EXECUTION        | Something blew up inside the verb (load, parse, runtime crash).   |
| 5    | NOT_FOUND        | Artifact / file / resource doesn't exist on disk or remote.       |
| 64   | USAGE            | sysexits-style "command line usage error" (BSD convention).       |

`RUNTIME` is a kept-for-compat alias of `EXECUTION` (both = 4). `USAGE` is reserved for help-mode misuse.

`process.exit(undefined)` would silently mask errors — the W202 audit caught 16+ sites of that and the constants above are now the single source of truth.

---

## Error envelope (JSON)

Every verb that supports `--json` returns `{ ok: true, ... }` on success or this exact shape on failure:

```json
{
  "ok": false,
  "error": "human-readable message",
  "code": "KOLM_E_*",
  "exit": 1,
  "hint": "optional one-line remediation",
  "next": ["kolm do \"...\"", "kolm what"]
}
```

`code` is a stable `KOLM_E_<SUBSYSTEM>_<REASON>` token suitable for switch statements in agent code. `next` is a curated list of follow-up commands you can present to the user as one-click suggestions.

---

## Verb table

70 verbs, grouped by topic. Each row gives the verb, a one-line description, the most useful args, and whether `--json` is supported.

### Natural-language UX

| Verb       | What                                                                  | Args                                | --json |
|------------|-----------------------------------------------------------------------|-------------------------------------|--------|
| `do`       | Classify a plain-English instruction and run the inferred verb.       | `"<text>" [--dry-run] [--json]`     | yes    |
| `what`     | One-screen snapshot: artifacts + captures + jobs + top recommendations.| `[--json]`                          | yes    |
| `next`     | Ranked recommended next action(s) given current state.                | `[--json]`                          | yes    |
| `explain`  | Plain-English description of a `.kolm` artifact (what / how / scores).| `<art.kolm> [--json]`               | yes    |
| `fix`      | Auto-iterate on a failing artifact: surface errors + suggest seed fixes.| `<art.kolm> [--apply] [--json]`   | yes    |
| `ask`      | Natural-language gateway to status / builds / install / compile.      | `"<question>"`                      | partial|
| `chat`     | Interactive natural-language session (airgap-safe).                   | none                                | no     |
| `repl`     | Interactive verb-by-verb REPL.                                        | none                                | no     |
| `tui`      | Multi-pane keyboard-driven .kolm shell.                               | none                                | no     |
| `nl`       | Natural-language recipe scaffolder (free text -> spec.json + seeds).  | `"<request>"`                       | yes    |

### Identity / account

| Verb        | What                                                       | Args                                     | --json |
|-------------|------------------------------------------------------------|------------------------------------------|--------|
| `signup`    | Provision a tenant + API key from the CLI.                 | `--email <addr>`                         | yes    |
| `login`     | Save an API key to `~/.kolm/config.json`.                  | `[--key ks_...] [--base <url>]`          | yes    |
| `whoami`    | Echo current tenant + plan + base URL.                     | `[--json]`                               | yes    |
| `config`    | Inspect or set kolm config.                                | `[base|api_key [value]]`                 | yes    |
| `profile`   | Save / use / list / show / delete a kolm profile.          | `<sub>`                                  | yes    |
| `keys`      | Ed25519 key rotation (list / rotate / fingerprint / export).| `<sub>`                                 | yes    |

### Health / status

| Verb            | What                                                  | Args                | --json |
|-----------------|-------------------------------------------------------|---------------------|--------|
| `status`        | Local snapshot: CLI version, base, key fingerprint, jobs.| `[--json]`       | yes    |
| `health`        | Probe the cloud endpoint (HTTP + RTT).                | `[--json]`          | yes    |
| `doctor`        | Sanity-check env (config, cloud, docker, project).    | `[--detect-hw]`     | yes    |
| `loop`          | Run the value-loop smoke (capture -> distill -> replay).| `[--json] [--remote]`| yes  |
| `metrics`       | Local CLI usage metrics.                              | `[--json]`          | yes    |
| `support-bundle`| Collect a tarball of state for support tickets.       | `--out <path>`      | yes    |
| `version`       | Print version (CLI + server contract).                | `[--short] [--json]`| yes    |

### Build / spec

| Verb         | What                                                       | Args                                     | --json |
|--------------|------------------------------------------------------------|------------------------------------------|--------|
| `init`       | Scaffold `kolm.yaml` + `.kolm/` at cwd.                    | `[--name <slug>]`                        | no     |
| `init-agent` | Script-first agent project scaffolder.                     | `<name> [dir] --template <t>`            | no     |
| `new`        | Scaffold a `spec.json` you can compile.                    | `<name> [--from <template>]`             | no     |
| `build`      | One-shot: new + seeds + compile + verify (fastest path).   | `<name> [--from <tpl>]`                  | yes    |
| `compile`    | Cloud-compile a task into a `.kolm` artifact.              | `"<task>" [opts]` OR `--spec <file>`     | yes    |
| `train`      | Alias for `compile` (training entry point) or `distill`.   | `--spec <file>` OR `--namespace <n>`     | yes    |
| `make`       | Unified pipeline UX (W359).                                | `<spec>`                                 | yes    |
| `ship`       | Unified pipeline UX (W360).                                | `<art.kolm>`                             | yes    |
| `seeds`      | Local-first training-data helpers.                         | `<sub>`                                  | yes    |
| `redact`     | Redact PII/PHI from a JSONL file.                          | `<file.jsonl>`                           | yes    |
| `anonymize`  | Templated PII/PHI replacement.                             | `<file.jsonl>`                           | yes    |

### Run / verify

| Verb        | What                                                                       | Args                              | --json |
|-------------|----------------------------------------------------------------------------|-----------------------------------|--------|
| `run`       | Execute a `.kolm` against an input.                                        | `<art.kolm> '<input>'`            | yes    |
| `eval`      | Re-run embedded evals, recompute K-score.                                  | `<art.kolm>`                      | yes    |
| `bench`     | Reproducible benchmark on a `.kolm` (latency + cost vs LLM).               | `<art.kolm> [--runs N]`           | yes    |
| `score`     | Print this artifact's K-score (per-artifact).                              | `<art.kolm>`                      | yes    |
| `verify`    | Verify signature + K-score gate + emit compliance binder.                  | `<art.kolm> [--binder out.html]`  | yes    |
| `inspect`   | Print manifest + recipes + signature + K-score of a `.kolm`.               | `<art.kolm>`                      | yes    |
| `diff`      | Compare two artifact manifests.                                            | `<a.kolm> <b.kolm>`               | yes    |
| `replay`    | Replay captured pairs against an artifact + diff results.                  | `<ns> <art-id> <art.kolm>`        | yes    |

### Local registry / publishing

| Verb          | What                                                          | Args                                     | --json |
|---------------|---------------------------------------------------------------|------------------------------------------|--------|
| `list` / `ls` | List every local `.kolm` artifact under `~/.kolm/artifacts/`. | none                                     | yes    |
| `artifacts`   | List/show/diff remote artifacts on the cloud.                 | `<sub>`                                  | yes    |
| `publish`     | Push a `.kolm` to the public verifiable hub.                  | `<art.kolm> [--public]`                  | yes    |
| `pull`        | Download a published artifact (SHA-256 pinned).               | `<owner>/<name>[@sha:...]`               | yes    |
| `hub`         | Browse the public artifact gallery.                           | `list|show`                              | yes    |
| `marketplace` | Search / install / publish marketplace items.                 | `<sub>`                                  | yes    |

### Capture / distill

| Verb        | What                                                                       | Args                                  | --json |
|-------------|----------------------------------------------------------------------------|---------------------------------------|--------|
| `capture`   | Configure the OpenAI/Anthropic proxy + view capture status.                | `--provider <p> --as <t>`             | yes    |
| `tail`      | Tail captures (SSE) from a namespace.                                      | `captures [--namespace <n>] [--json]` | yes    |
| `labels`    | Download the captured corpus as JSONL.                                     | `[--namespace <n>] [--out <path>]`    | yes    |
| `distill`   | Auto-distill captured (input, output) pairs into a local LoRA.             | `--from-captures --namespace <n>`     | yes    |

### Runtime / serving

| Verb        | What                                                                       | Args                                  | --json |
|-------------|----------------------------------------------------------------------------|---------------------------------------|--------|
| `serve`     | Expose `~/.kolm/artifacts/` as MCP tools or an HTTP endpoint.              | `[--mcp] [--http] [--port <n>]`       | yes    |
| `runtime`   | Runtime targets / doctor / build-from-source.                              | `<sub>`                               | yes    |
| `install`   | Wire kolm MCP into Claude Code / Cursor / Continue / Cline.                | `<harness> [--apply]`                 | yes    |
| `export`    | Convert a `.kolm` to GGUF / MLX / ONNX / CoreML / TensorRT.                | `<art.kolm> --to <fmt>`               | yes    |
| `quantize`  | Quantise an adapter via the isolated worker.                               | `<int4|int8|gptq|awq>`                | yes    |
| `models`    | Local model registry (list / info / recommend / pin / devices).            | `<sub>`                               | yes    |
| `gpu`       | Accelerator probe.                                                         | `<sub>`                               | yes    |

### Background / sessions

| Verb        | What                                                                       | Args                                  | --json |
|-------------|----------------------------------------------------------------------------|---------------------------------------|--------|
| `jobs`      | List or prune background jobs (`~/.kolm/jobs.jsonl`).                      | `list|prune`                          | yes    |
| `watch`     | Tail the log of a specific background job.                                 | `<job-id>`                            | yes    |
| `sessions`  | List all detached compile/distill sessions.                                | none                                  | yes    |
| `resume`    | Tail an already-detached session log.                                      | `<session-id>`                        | yes    |
| `rescue`    | Adopt an orphaned PID via reptyr (Linux only).                             | `<pid>`                               | yes    |
| `logs`      | Tail local run history (`~/.kolm/logs/runs.jsonl`).                        | `[--limit n] [--artifact x]`          | yes    |

### Compute / cloud

| Verb        | What                                                                       | Args                                  | --json |
|-------------|----------------------------------------------------------------------------|---------------------------------------|--------|
| `compute`   | Where training runs (list / detect / pick / use / info).                   | `<sub>`                               | yes    |
| `cloud`     | Real GPU train + BYOC deploy.                                              | `<sub>`                               | yes    |
| `tunnel`    | Remote access to a self-hosted kolm.                                       | `<sub>`                               | yes    |
| `airgap`    | Hard-offline mode (status / enable / disable / verify).                    | `<sub>`                               | yes    |
| `rag`       | Airgapped local lookup (index / query / attach / list).                    | `<sub>`                               | yes    |
| `tune`      | Evolve a local adapter (init / capture-on / step / promote / watch).       | `<sub>`                               | yes    |
| `drift`     | Drift detect / cron / verify (supersession events).                        | `<sub>`                               | yes    |
| `team`      | Multi-tenant workspaces (create / list / invite / members).                | `<sub>`                               | yes    |

### Misc

| Verb         | What                                                                      | Args                                  | --json |
|--------------|---------------------------------------------------------------------------|---------------------------------------|--------|
| `completion` | Emit a bash/zsh/fish completion script.                                   | `<bash|zsh|fish>`                     | no     |
| `upgrade`    | Check for a newer kolm release (does not install).                        | none                                  | yes    |
| `update`     | Self-install the latest kolm from github.                                 | none                                  | yes    |

---

## Recipes (multi-step)

10 high-value sequences for agents. Each recipe is a numbered list of commands to run in order; the bracketed `(verb)` is the verb in the table.

### 1. First-time setup

1. `kolm signup --email you@example.com` (signup)
2. `kolm login --key ks_...` (login)
3. `kolm whoami --json` (whoami) — confirm tenant + plan
4. `kolm doctor` (doctor) — sanity-check env

### 2. Ship a redactor in three commands

1. `kolm init-agent phi-redactor --template redactor` (init-agent)
2. `kolm build phi-redactor` (build) — one-shot new+seeds+compile+verify
3. `kolm publish phi-redactor.kolm --public` (publish)

### 3. Run an existing artifact

1. `kolm list` (list) — see what's installed
2. `kolm explain phi-redactor.kolm` (explain) — read what it does
3. `kolm run phi-redactor.kolm "Patient John Doe..."` (run)

### 4. Audit before deploying

1. `kolm verify phi-redactor.kolm --binder report.html` (verify)
2. `kolm bench phi-redactor.kolm --runs 100` (bench)
3. `kolm sigstore-attest phi-redactor.kolm` (attest)

### 5. Capture -> distill -> ship a specialist

1. `kolm capture --provider openai --as my-proxy` (capture)
2. `kolm tail captures --namespace support` (tail) — watch the inflow
3. `kolm distill --from-captures --namespace support` (distill)
4. `kolm replay support art_123 phi-redactor.kolm` (replay) — diff vs production

### 6. Recover from a failing artifact

1. `kolm eval phi-redactor.kolm` (eval) — confirm failure
2. `kolm fix phi-redactor.kolm` (fix) — surface failing cases
3. `kolm fix phi-redactor.kolm --apply` (fix) — write fix-seeds.jsonl
4. `kolm compile --spec phi-redactor.spec.json --examples phi-redactor.fix-seeds.jsonl --out phi-redactor.kolm` (compile)

### 7. Find your bearings (no context)

1. `kolm what --json` (what)
2. `kolm next --json` (next) — top 3 ranked actions

### 8. Natural-language fallback

1. `kolm do --dry-run "build a redactor from ./notes/"` (do) — preview the inferred verb
2. `kolm do "build a redactor from ./notes/"` (do) — run for real

### 9. Wire an MCP harness

1. `kolm install claude-code --apply` (install)
2. `kolm serve --mcp --http --port 7787` (serve)
3. Test from the host: `kolm do --json --dry-run "list my artifacts"` (do)

### 10. Cloud train + deploy

1. `kolm compute list --json` (compute)
2. `kolm cloud train --spec phi-redactor.spec.json --backend fal` (cloud)
3. `kolm cloud list --json` (cloud) — watch the job
4. `kolm cloud deploy art_123 --target fly` (cloud)

---

## VERB_DESCRIPTIONS (mirror)

The src/intent.js table is the canonical source. The lookup at runtime is:

```js
import { VERB_DESCRIPTIONS, listVerbs } from 'src/intent.js';
```

Each entry has `{ verb, desc, when, phrasings: [], examples: [] }`. The `phrasings` are matched against user input at runtime — adding a phrasing to the table both:

- Updates `kolm do "<phrasing>"` to resolve to the right verb (keyword fast path).
- Updates the ranked-overlap fallback so other phrasings score the verb higher.
- Updates this guide on the next re-generation pass.

There are 70+ verbs in the table. Run `node -e "import('./src/intent.js').then(m => console.log(m.listVerbs().join(' ')))"` for the live list.

---

## Conventions you can rely on

- **`--json` first stdout line** is a JSON object. Anything emitted to stderr is human-prose context (progress, warnings) and you may discard it.
- **Stable error codes**: `KOLM_E_<SUBSYSTEM>_<REASON>` (e.g. `KOLM_E_ARTIFACT_NOT_FOUND`, `KOLM_E_DO_NO_INPUT`, `KOLM_E_EVAL_FAILED`, `KOLM_E_LOAD_FAILED`). New codes are additive.
- **Exit code carries semantics** even when `--json` is not requested.
- **`next` is curated**: the strings in the `next` array are valid commands the agent can re-spawn directly.
- **`kolm do --dry-run --json`** is the agent's verb-discovery primitive — it never executes, only classifies.

---

## Versioning & stability

- Verb names — additive only. Removed verbs are kept as aliases for at least one major release.
- JSON envelope shapes — additive only. New top-level keys may appear; existing keys do not change semantics.
- Exit codes — frozen.
- Error codes (`KOLM_E_*`) — frozen.

Generated alongside `src/intent.js`. If you find a mismatch between this file and the runtime behavior of the CLI, the runtime wins and this file is the bug.
