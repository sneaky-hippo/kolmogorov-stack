# kolm resume

Re-attach to a detached compile, distill, eval, or serve session that was
started with `--detach` (W233). The session keeps running inside a tmux
target or background pty even after your terminal disconnects, and
`kolm resume <session-id>` re-attaches the live stdout/stderr stream from
the on-disk log.

## Usage

```
kolm resume <session-id> [--tail N] [--follow] [--json]
kolm resume --list
```

Pass an exact `session_id` (returned when you ran `kolm compile --detach`
or `kolm distill --detach`). `--tail N` prints the last N lines and exits;
omit it to stream live. `--follow` keeps streaming new lines as they
arrive. `--list` is equivalent to `kolm sessions list`.

## Examples

```
kolm compile spec.json --detach            # start; prints session_id sess_abc
kolm resume sess_abc                       # re-attach to live tail
kolm resume sess_abc --tail 50             # last 50 log lines + exit
kolm resume sess_abc --follow              # stream until ^C
kolm resume --list                         # show every detached session
```

## See also

- `kolm sessions` to list / kill detached sessions explicitly.
- `kolm rescue` to re-parent an orphaned PID under a new tty (reptyr-style).
- `/foundations/tmux` for the tmux-friendly detached-runtime recipe.
