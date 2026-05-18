# kolm rescue

Re-parent an orphaned kolm child PID under a new controlling tty
(reptyr-style, W233). Use this when a `--detach`ed session lost its tmux
host or you want to pull a backgrounded compile into the foreground of a
fresh terminal without killing it.

## Usage

```
kolm rescue <pid> [--tty <path>] [--force]
```

`<pid>` is the kolm worker process id (visible in `kolm sessions list` and
in the `session_id`'s on-disk record). `--tty` defaults to the current
terminal. `--force` skips the safety prompt when the PID does not look
like a kolm-owned worker.

## Examples

```
kolm sessions list                         # find the pid: sess_abc pid 4711
kolm rescue 4711                           # adopt 4711 into this terminal
kolm rescue 4711 --tty /dev/pts/3 --force  # pin to a specific tty
```

## Constraints

- POSIX only on the reparenting path; Windows uses `attachConsole` (W233).
- Requires `CAP_SYS_PTRACE` on hardened Linux distros (or sudo).
- Won't adopt a process that isn't a kolm child (signature check).

## See also

- `kolm sessions` to enumerate detached worker pids.
- `kolm resume` for the tmux-friendly equivalent.
- `/foundations/tmux` for the survives-disconnect runtime pattern.
