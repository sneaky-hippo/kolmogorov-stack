# Kolm v7.4 — SOTA infrastructure & harness amendments

> 2026-05-11. Founder asked: "Review all of vast.ai infrastructure and build mechanisms. Anything we should amend within our build in any way necessary. Also the architecture of all top harnesses. We have to be SOTA — remember that."
>
> This document is the audit + the amendments shipped this pass + the design for the deferred work (the hook protocol and full harness adapters).

---

## What was reviewed

Three parallel research passes converged on the same five amendments:

1. **vast.ai infrastructure** — provisioning manifests, env-var contracts, layered base images, port-forward conventions, verb-noun CLI grammar.
2. **Top AI/agent harnesses** — Claude Code (skills + hooks), Cursor (`.cursor/rules`), Cline (`.clinerules`), Aider (`.aider.conf.yml` + repo-map), Continue (`~/.continue/config.yaml`), OpenHands microagents, SWE-bench harness, claude-code-hooks.
3. **Kolm inventory** — current CLI surface, artifact format, MCP server, capture/distill flow, bench reproducer.

The throughline: every SOTA harness has a **declarative project file** (`config.yaml`, `.cursor/rules`, `.clinerules`, `.aider.conf.yml`) that pins what the harness loads, what tools are allowed, and what auto-attach patterns fire. Kolm shipped a CLI and an artifact format but **had no project file** — every project had to wire MCP and skills manually. Two of the three audits flagged this independently. **P0.**

---

## Amendments shipped this pass (v7.4)

### 1. `kolm.yaml` v0.1 schema

`docs/kolm-yaml-v0.1.json` — JSON Schema (draft 2020-12) for the project file. Mirrors the role of Continue's `config.yaml` and Cursor's rules folder: one declarative file at the repo root that declares which `.kolm` artifacts belong to the project, how MCP exposes them, how the bench harness runs, and which compile/run hooks fire.

Key fields:

- `name` — project slug; becomes the MCP namespace (`mcp__<name>__<artifact>`).
- `artifacts[]` — list of `.kolm` paths (or globs), each with a stable `name`, optional `description`, optional `allowed-tools`, optional `paths` (glob patterns for auto-attach), and optional `k_min` floor.
- `mcp` — `transport` (stdio | http | sse), `host` (default `127.0.0.1`, never `0.0.0.0`), `port`.
- `bench` — `suite`, `n`, `model` for `kolm bench --reproduce`.
- `hooks` — map of event → script list. Events: `PreCompile`, `PostCompile`, `PreRun`, `PostRun`, `PreBench`, `PostBench`. Scripts read JSON event on stdin, exit 0 = allow, 2 = block. Stdout JSON may modify the event (additionalContext, updatedInput). Mirrors claude-code-hooks contract.
- `skills_dir` — where `kolm compile` writes `SKILL.md` sidecars. Default `./.kolm/skills`.
- `registry` — registry base URL. Override for self-hosted or staging.

### 2. `kolm init` command

`cli/kolm.js` — new top-level verb that scaffolds a project:

```
kolm init [--name <slug>] [--force]
```

Writes:

- `./kolm.yaml` — project manifest with sensible defaults and inline-commented optional sections (hooks, bench).
- `./.kolm/artifacts/` — local working dir for compiled `.kolm` files.
- `./.kolm/skills/` — where SKILL.md sidecars land.
- `./.gitignore` — appends `.kolm/` if a gitignore or `.git/` is present. Does not create one in non-git directories.

Refuses to overwrite an existing kolm.yaml unless `--force`. Validates the name matches the schema's `^[a-z0-9][a-z0-9-_]*$` pattern.

### 3. SKILL.md auto-emission on `kolm compile`

Both compile paths (spec-driven offline + cloud-synthesised) now emit a `SKILL.md` sidecar by default. Pass `--no-skill` to suppress.

The sidecar uses Claude Code's frontmatter format so it's directly indexable by Claude Code, Cursor, Cline, and Continue without further config:

```markdown
---
name: <artifact-name>
description: <one-line from spec.task or compile task>
allowed-tools: []
disable-model-invocation: false
---

# <artifact-name>

<description>

## How to invoke

Frontier agents call this skill via MCP after `kolm serve --mcp`:
- Tool name: `mcp__<project>__<artifact>`
- Backing artifact: `<relative path>`
- Transport: stdio (zero-port; no network exposure)

## Guarantees

K-score: <composite>. Runtime egress is patched at the process boundary…
```

Discovery rules:

- If a `kolm.yaml` is found by walking up from the artifact's directory, the sidecar lands in `<projectRoot>/<skills_dir>/<artifact>.md` and the MCP tool name uses `<project name>`.
- Otherwise, the sidecar lands next to the artifact and the MCP tool name defaults to `mcp__kolm__<artifact>`.

### 4. Dockerfile digest pinning

Both Dockerfiles now pin base images by `sha256:` digest, not floating tags. Reproducer benchmarks depend on byte-identical build chains; floating tags break reproducibility the moment Docker Hub publishes an update.

- `Dockerfile` — `node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f`
- `bench/Dockerfile` — `python:3.11-slim@sha256:a5b427ace4900267d93db34138e512325c6fa6af84ad5e4ed5f3b36258cc4142`

Digests captured from Docker Hub v2 API on 2026-05-11. Refresh quarterly or when CVE-bumped.

### 5. Payer production use-cases on `/healthcare`

`public/healthcare.html` — added section `04b — Payer use-cases` with six production-ready insurance-vertical artifact cards: prior authorization triage, claims adjudication assist, appeals & grievances drafts, member services AI, utilization management review, FWA pattern detection. Audience line targets payer teams running on TPAs, MA / D-SNP plans, ACOs, and risk-bearing entities.

Goal: when a payer-side prospect visits kolm.ai/healthcare, the page reads as "we built for payers" without forcing a separate vendor-named landing. If the conversation advances to a tailored deck or one-pager, the founder picks the format then.

---

## Deferred work (queued for v7.5)

### Full hook protocol implementation

The schema declares `PreCompile/PostCompile/PreRun/PostRun/PreBench/PostBench`. The CLI does not yet read `kolm.yaml` and dispatch hooks. The protocol mirrors claude-code-hooks:

1. Before the event, kolm CLI loads `kolm.yaml`, finds hooks for the event.
2. For each script, spawn it with `kolm_hook_event=<name>` env, pipe a JSON event on stdin: `{ "event": "PreCompile", "spec_path": "...", "cwd": "...", "kolm_version": "0.1.0" }`.
3. Exit 0 = continue with possibly-modified event from stdout JSON. Exit 2 = block; print the script's stderr and abort the compile/run/bench. Any other code = warn but continue.
4. PostCompile is the natural place to:
   - Compute reproducible SBOM
   - Lint the spec against a custom policy (e.g., "no PII in evals")
   - Trigger CI/CD downstream (push artifact to S3, notify Slack)
   - Refresh the SKILL.md with project-specific extra frontmatter

**Estimated effort:** ~3 hours. Smallest cut: implement loader + dispatcher + PreCompile/PostCompile only; add the run/bench hooks in a follow-up.

### `kolm serve --mcp` reads `kolm.yaml`

Currently `kolm serve --mcp` enumerates `~/.kolm/artifacts/*.kolm`. With `kolm.yaml`, serve should:

1. Resolve `artifacts[]` from cwd's kolm.yaml.
2. Expose each as `mcp__<project name>__<artifact name>`.
3. Refuse to expose artifacts with K-score below `k_min` (if set).
4. Honour `allowed-tools` on the sub-agent path (kolm-as-sub-agent).
5. Auto-attach by `paths` glob — when the harness reports the user is editing `src/**/*.ts`, surface the matching artifact more prominently.

**Estimated effort:** ~2 hours.

### Harness-specific adapter docs

A short page per harness explaining one-command wiring:

- **Claude Code** — point at `./.kolm/skills/` as a skill source; `kolm serve --mcp` registers as an MCP server in `.claude/settings.json`.
- **Cursor** — symlink `./.cursor/rules/kolm.mdc` → kolm-generated MDC file pointing at the skills_dir.
- **Cline** — same idea under `./.clinerules/`.
- **Continue** — append a `mcpServers` entry to `~/.continue/config.yaml`.
- **Aider** — wire `kolm serve --mcp` as a tool in `.aider.conf.yml`.
- **OpenHands** — drop microagent stubs that delegate to `mcp__<project>__<artifact>`.

**Estimated effort:** ~1 hour per harness for the docs page; ~1 hour for a `kolm install <harness>` command that automates the wiring.

### Vast.ai-style provisioning manifest

For self-hosted MCP servers on rented GPU: a `PROVISIONING_MANIFEST.json` that lists required env vars (`KOLM_API_KEY`, `KOLM_BASE`, `RECIPE_RECEIPT_SECRET`, etc.), required ports (MCP HTTP if used), and a verb-noun init script. Lets users `kolm provision --vast` and have a working remote artifact server in one command.

**Estimated effort:** ~2 hours.

### `compile-lock.json` reproducibility lock

A sibling of `package-lock.json` for compile reproducibility: capture base-model digest, recipe digests, eval-case hashes, base Docker image digest. Future `kolm compile --frozen` refuses to compile if any input differs. Pairs with the Dockerfile digest pinning shipped in this pass.

**Estimated effort:** ~3 hours.

---

## Why this is the right cut

- **kolm.yaml + init + SKILL.md emission** removes the largest friction in the developer story: "how do I make Claude Code see my .kolm?" Previously: hand-edit `.claude/settings.json` and copy SKILL.md by hand. Now: `kolm init && kolm compile` and the harness picks it up.
- **Digest pinning** is the cheapest reproducibility win available. We claim byte-identical reproducer numbers; we can't claim that on top of `node:22-alpine` (mutable tag).
- **Healthcare payer cards** is the answer to "tailor toward payers." Cheaper than a separate vendor-named page; reads as competence rather than pander.

The deferred work is sized so v7.5 fits in a single follow-up session: hook protocol + serve-reads-kolm-yaml are the two load-bearing pieces; the rest is documentation and adapter ergonomics.

---

## Verification

Local smoke (during this pass):

```
# scratch dir
mkdir /tmp/kolm-init-test && cd /tmp/kolm-init-test
node cli/kolm.js init --name payer-pilot
# → wrote kolm.yaml + .kolm/artifacts/ + .kolm/skills/
node cli/kolm.js new ah-priorauth --from classifier
node cli/kolm.js compile --spec ah-priorauth.spec.json --out .kolm/artifacts/ah-priorauth.kolm
# → built artifact + skill: .kolm/skills/ah-priorauth.md
# → SKILL.md frontmatter: name=ah-priorauth, MCP tool=mcp__payer-pilot__ah-priorauth
```

Production smoke after deploy:

- `curl -sI https://kolm.ai/docs/kolm-yaml-v0.1.json` → 200
- `URL=https://kolm.ai bash scripts/e2e-flow.sh` → 9/9 PASS
- `URL=https://kolm.ai bash scripts/check-sitemap.sh` → ≥109/109
- Spot check `https://kolm.ai/healthcare` shows the 6 payer use-case cards under section 04b.
