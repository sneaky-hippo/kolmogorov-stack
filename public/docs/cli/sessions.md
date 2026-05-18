# kolm sessions

List, inspect, kill, or prune detached worker sessions started with
`--detach` (W233). Sessions are tracked in `~/.kolm/sessions/*.json`
records that survive shell exits.

## Usage

```
kolm sessions list [--json]
kolm sessions show <session-id>
kolm sessions kill <session-id> [--signal SIGTERM|SIGKILL]
kolm sessions prune [--dead-only] [--older-than 7d]
```

## Examples

```
kolm sessions list                         # table of every detached session
kolm sessions show sess_abc                # full record + recent log tail
kolm sessions kill sess_abc                # SIGTERM by default
kolm sessions kill sess_abc --signal SIGKILL
kolm sessions prune --dead-only            # remove records whose pid is gone
kolm sessions prune --older-than 7d        # garbage-collect old records
```

## Output

`kolm sessions list` columns: `session_id`, `kind` (compile/distill/eval/serve),
`pid`, `state` (running/exited/orphan), `started_at`, `log_path`.

`--json` emits one record per line for piping to `jq`.

## See also

- `kolm resume` to re-attach to a live session.
- `kolm rescue` to re-parent an orphaned pid into a new terminal.
- `/foundations/tmux` for the detached-runtime recipe.
