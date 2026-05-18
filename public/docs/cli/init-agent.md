# kolm init-agent

Script-first project scaffolder (W238). Creates a complete kolm agent
project directory you can `cd` into and run with `./run.sh`. No config
wizards, no globals, just plain-text files you can hand-edit and commit
to git.

## Usage

```
kolm init-agent <name> [dir] [--template chatbot|redactor|classifier|extraction|agent]
                              [--git] [--tmux] [--force] [--dry-run] [--json]
```

`<name>` must match `[a-zA-Z0-9._-]+`. `[dir]` defaults to `<name>`.
`--git` runs `git init` + first commit. `--tmux` writes a `tmux.conf`
for a 3-pane compile/serve/watch session. `--force` overwrites a
non-empty directory. `--dry-run` prints the file plan without writing.

## Templates

- `chatbot`    - Qwen 2.5 3B Instruct, chatml chat template (default)
- `redactor`   - rule class, no model bytes
- `classifier` - Qwen 2.5 0.5B distilled student
- `extraction` - Qwen 2.5 3B, JSON output target
- `agent`      - Hermes 4.3 36B with a self-growing blueprint (W236 link)

## Examples

```
kolm init-agent demo                                        # default chatbot, ./demo
kolm init-agent ops ./ops --template agent --tmux --git     # full agent stack
kolm init-agent redact --template redactor --dry-run        # plan only
kolm init-agent demo --template extraction --json           # machine-readable
```

## What gets scaffolded

```
<dir>/
  spec.json        kolm compile spec
  seeds.jsonl      one seed pair per line (one stub example)
  blueprint.json   self-growing agent blueprint (W236)
  run.sh / run.ps1     compile + serve scripts
  watch.sh / watch.ps1 capture + auto-distill watchers
  tmux.conf        optional 3-pane session layout
  .gitignore       sensible defaults
  README.md        one-paragraph "what is this" + how-to-run
```

## See also

- `kolm compile` / `kolm serve` / `kolm tail captures` for the runtime path.
- `kolm agent` to inspect / merge / verify the generated blueprint.
- `/foundations/scripts` for the script-everything recipe.
