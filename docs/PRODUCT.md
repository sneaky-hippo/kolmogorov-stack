# kolm — terminal product spec

> The one-document answer to "what is this and why does it exist." Updated 2026-05-11.

---

## In one sentence

**`kolm` is a compiler cache for intelligence: turn a task spec into a signed, byte-reproducible `.kolm` artifact that runs locally with zero egress, and surface it to any frontier agent (Claude Code, Cursor, Cline, Continue) as an MCP tool.**

---

## The three frames

Three audiences, one product. Each sees the same artifact through a different lens:

| Frame                  | Audience                | What kolm IS, in their words                                                   |
|------------------------|-------------------------|--------------------------------------------------------------------------------|
| **Docker for AI**      | DevOps / platform       | A single-file deploy unit. Same input → same artifact → same output, forever. |
| **Compiler cache**     | Engineers               | Compile once, run a million times locally. µs latency. No round-trip.         |
| **MCP tool registry**  | Agent builders          | Every `.kolm` is automatically a callable tool with K-score, paths, schema.   |

The three frames all reduce to the same thing: **a signed binary that an agent can run without phoning home**.

---

## The terminal product loop

```
   spec.json  ──►  kolm compile  ──►  *.kolm                  (build once)
                       │
                       ▼
                  K-score gate                                (verify)
                       │
                       ▼
          ┌────────────┴────────────┐
          ▼                         ▼
    kolm run                  kolm install <harness>           (use anywhere)
      (CLI / SDK)               (Claude Code, Cursor,
                                 Cline, Continue)
                       │
                       ▼
                ~/.kolm/logs/runs.jsonl                       (observe)
                       │
                       ▼
                  kolm bench                                  (re-prove)
```

Every step is a verb-noun CLI command. Every step is fully offline after the initial compile. Every step writes a signed, auditable receipt.

---

## CLI surface (verb-noun grammar, terminal)

```
authoring          kolm init / new / login / config
compile-and-prove  kolm compile / eval / score / inspect
run-and-observe    kolm run / bench / logs / doctor
serve-and-share    kolm serve --mcp / install <harness> / publish
data-loop          kolm capture / labels / distill
```

Every verb is a single function in `cli/kolm.js`. Every flag is documented in `kolm help <verb>`. No subcommand trees deeper than two.

**Deferred (v7.6+):** `kolm tune`, `kolm registry`, `kolm bridge`.

---

## File formats (the persistence layer)

| File              | Carries                                                                 | Spec       |
|-------------------|-------------------------------------------------------------------------|------------|
| `*.kolm`          | recipes + verifier + evals + manifest + HMAC chain                      | RS-1       |
| `kolm.yaml`       | project root, artifact globs, k_min gate, MCP transport, hooks          | kolm-yaml-v0.1 |
| `SKILL.md`        | Claude Code skill frontmatter (auto-emitted next to every `.kolm`)      | claude-code |
| `~/.kolm/config.json` | local API key, receipt secret, base URL                             | local-config-v0.1 |
| `~/.kolm/logs/runs.jsonl` | append-only run history (artifact, latency, k_score, recipe)    | jsonl |

The `.kolm` file is to AI what a Docker image is to a service: a single deploy unit that carries the model, the adapter, the verifier, the eval suite, and a signed receipt of the gate that let it ship.

---

## The K-score (ship gate)

```
K = 0.40·A + 0.15·S + 0.15·L + 0.15·C + 0.15·V
    │       │       │       │       │
    │       │       │       │       └─ coverage (eval pass fraction)
    │       │       │       └───────── cost per call
    │       │       └───────────────── p50 latency
    │       └───────────────────────── size on disk
    └───────────────────────────────── accuracy on evals

ship gate: K ≥ 0.85
```

The K-score is a number between 0 and 1. Anything below 0.85 fails the ship gate. The gate runs at compile-time, at install-time (`k_min` in `kolm.yaml`), and at serve-time (MCP discovery refuses to expose low-K artifacts). Three layers, same number.

---

## What we do NOT do (scope discipline)

- **We do not host models.** kolm is the substrate; weights live in `.gguf` / `.safetensors` and are referenced by hash.
- **We do not run inference for you.** `kolm run` is local. The cloud is for compile + registry, never for runtime.
- **We do not phone home.** Zero egress at runtime is enforced by the bench monitor; wire-touching artifacts fail benchmark.
- **We do not ship a chat UI.** kolm exposes tools, not chats. The agent — Claude Code, Cursor, etc. — owns the conversation.
- **We do not gate the spec.** RS-1 is MIT-licensed. Anyone can read and write `.kolm` files without paying us a cent.
- **We do not claim compliance.** kolm gives you the substrate (signed artifacts, zero egress, audit receipts). The HIPAA / SOC 2 / FedRAMP audit is yours.

---

## Competitive positioning

| Camp                      | Examples                          | Where kolm fits                                                    |
|---------------------------|-----------------------------------|--------------------------------------------------------------------|
| **Model weights formats** | `.gguf`, `.safetensors`, `.onnx`  | Complement. kolm references weights by hash; doesn't replace them. |
| **Inference runtimes**    | Ollama, vLLM, llama.cpp           | Complement. `kolm run` calls them as a base layer.                 |
| **Agent harnesses**       | Claude Code, Cursor, Cline        | Customer. kolm appears as MCP tools they call.                     |
| **Memory layers**         | Mem0, Zep, MemPalace, Hindsight   | Different problem. kolm is task-shaped; memory is conversation-shaped. |
| **Spec / contract layer** | (kolm is essentially alone here)  | **This is the moat.** RS-1 + K-score + signed receipts = the spec. |

**The wedge:** every agent harness needs to call tools. Every regulated buyer needs the tool to be auditable. Every CFO needs the inference to be predictable in cost. kolm is the substrate that makes all three true at once.

---

## Why now (the market window)

1. **Frontier APIs hit a per-request liability ceiling.** Every `requests.post('api.openai.com')` in a regulated codebase is now a compliance question.
2. **Open-weight models cleared the quality bar.** Qwen 3 / Llama 3.3 / DeepSeek V3 do 90% of the work most agent tools need.
3. **MCP standardized the agent-tool boundary.** A `.kolm` becomes a tool with one config entry. Network effects compound.
4. **K-score answers the AI-fragility complaint.** A signed receipt + reproducible eval is the only way to make AI behavior contractually defensible.

We are the wedge **between the model and the agent**, owning the unit of deployment.

---

## Architecture, top-down

```
┌─────────────────────────────────────────────────────────────────┐
│                  FRONTIER AGENT HARNESS                         │
│        Claude Code · Cursor · Cline · Continue                  │
│                  (kolm install <harness>)                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │  MCP (stdio | http)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  kolm serve --mcp                               │
│         tools/list · tools/call · k_min gate                    │
│           reads kolm.yaml + ~/.kolm/artifacts                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │  load .kolm
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  artifact-runner.js                             │
│        node:vm sandbox · 1 MiB cap · 1 000 ms timeout           │
│        HMAC chain verify · per-recipe dispatch                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │  emit
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│        receipt → runs.jsonl    →    hooks (PostRun)             │
│        K-score → score gate    →    metrics                     │
└─────────────────────────────────────────────────────────────────┘
```

No daemons. No dashboards. No telemetry leaving the box.

---

## Pricing (positioning, not the truth source)

| Tier         | Who                              | What unlocks                                       |
|--------------|----------------------------------|----------------------------------------------------|
| **Free**     | individual devs                  | local CLI, MCP serve, all OSS spec, public registry |
| **Pro**      | startups / small teams           | shared registry, private receipts, K-score dashboards |
| **Business** | regulated / multi-vertical teams | SSO, audit log API, K-score gate enforcement       |
| **Enterprise** | design partners                | dedicated channel, custom k_min policies, escalation |

Source of truth: `/pricing`. This table is for orientation only.

---

## The product loop, in one paragraph

A developer writes a JSON spec describing a task. They pipe it to `kolm compile`. The compiler synthesizes a verifier, fits a small adapter, runs the evals, and packages the lot into a `.kolm` file signed under their local secret. They run `kolm install claude-code` once. From that moment on, Claude Code (or Cursor, or Cline, or any MCP-aware agent) calls the artifact as a tool. Each call writes a row to `~/.kolm/logs/runs.jsonl` with the recipe, latency, K-score, and receipt. Nothing leaves the box. The same spec, run a year later, produces a byte-identical artifact. That is the loop. Everything else is plumbing.

---

## Read next

- **Spec:** [`docs/rs-1.md`](rs-1.md) — RS-1 wire format.
- **Authoring:** [`docs/AUTHORING.md`](AUTHORING.md) — spec field reference.
- **Hooks:** [`docs/HOOKS.md`](HOOKS.md) — event contract.
- **kolm.yaml:** [`docs/kolm-yaml-v0.1.json`](kolm-yaml-v0.1.json) — JSON Schema.
- **v7.4 amendments:** [`docs/SOTA-amendments-2026-05-11.md`](SOTA-amendments-2026-05-11.md) — what shipped this pass.
