# kolm hooks — v0.1

Hooks let a project intercept `kolm compile`, `kolm run`, and `kolm bench` to
enforce policy, emit telemetry, push artifacts to a private registry, or block
unsafe operations before they happen. They mirror the
[claude-code-hooks](https://github.com/anthropics/claude-code-hooks) shape so
scripts written for that ecosystem run without modification.

## Wiring

Hooks live in `kolm.yaml` under the `hooks:` map. Each event is a list of
shell commands. The kolm CLI walks up from `cwd` looking for `kolm.yaml`; if
none is found, hooks are silently inert.

```yaml
hooks:
  PreCompile:  ["./scripts/lint-spec.sh"]
  PostCompile: ["./scripts/sign-and-push.sh"]
  PreRun:      []
  PostRun:     []
  PreBench:    []
  PostBench:   []
```

You can also write objects when you need to override the default 30s timeout:

```yaml
hooks:
  PreBench:
    - { command: "./scripts/warm-cache.sh", timeout_ms: 120000 }
```

## Events and payloads

Every hook receives a single JSON object on **stdin**:

| Event         | Fires                          | Payload fields (in addition to `event`, `command`, `cwd`, `project_root`) |
|---------------|--------------------------------|--------------------------------------------------------------------------|
| `PreCompile`  | before `kolm compile` builds   | `spec_job_id?`, `spec_task?`, `task?`, `cloud?`                          |
| `PostCompile` | after the `.kolm` is written   | `artifact`, `sha256`, `bytes`, `k_score`                                 |
| `PreRun`      | before `kolm run` executes     | `artifact`, `input`                                                      |
| `PostRun`     | after `kolm run` returns       | `artifact`, `latency_us`, `k_score`, `recipe`                            |
| `PreBench`    | before `kolm bench` starts     | `artifact`, `runs?`                                                      |
| `PostBench`   | after `kolm bench` completes   | `artifact`, `runs`, `summary?`                                           |

## Exit codes

| Code | Meaning                                                                          |
|------|----------------------------------------------------------------------------------|
| 0    | continue — the operation proceeds                                                |
| 2    | block — the operation aborts. `kolm` exits 2 and prints which hook blocked.      |
| any  | other non-zero — logged as `hook WARN` but the operation proceeds (advisory).    |

## Environment

- `KOLM_HOOK_EVENT` is set to the event name in the hook's process env.
- `KOLM_HOOKS_OFF=1` disables all hooks (useful in CI snapshots and `kolm bench --reproduce`).
- Hooks run with `project_root` as their working directory, so relative paths
  like `./scripts/foo.sh` resolve consistently regardless of where the user
  invoked `kolm` from inside the project.

## Examples

### Block compiles that score below the project gate

```sh
#!/usr/bin/env sh
# scripts/k-gate.sh
event=$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.k_score && j.k_score.composite < 0.90){process.stderr.write('K='+j.k_score.composite+' below project floor 0.90\\n');process.exit(2);}})")
```

```yaml
hooks:
  PostCompile: ["./scripts/k-gate.sh"]
```

### Push every signed artifact to an internal registry

```yaml
hooks:
  PostCompile:
    - { command: "./scripts/push-internal.sh", timeout_ms: 60000 }
```

### Tee benchmark reports into S3

```yaml
hooks:
  PostBench: ["aws s3 cp $(jq -r .summary.report_path) s3://bench-reports/"]
```

## Cookbook

- **Lint specs**: `PreCompile` → reject specs without an `evals` array.
- **Egress audit**: `PostRun` → emit `(artifact, recipe, latency_us)` to your log pipeline.
- **Drift alert**: `PostBench` → diff `summary.k_score.composite` against last week.
- **Promote to staging**: `PostCompile` → copy the `.kolm` into a shared MCP store.

## Compatibility

`kolm` hooks are intentionally a strict subset of claude-code-hooks: same JSON-on-stdin contract, same exit-code semantics. A script that works for Claude Code's `PreToolUse` will work as a kolm `PreRun` — adjust which event names you mount it under and you're done.
