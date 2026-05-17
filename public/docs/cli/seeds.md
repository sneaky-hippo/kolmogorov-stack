# kolm seeds

Scaffold and manage `seeds.jsonl` training corpora. Templates ship for
common recipe classes; free-text briefs generate per-class candidate libraries
(synthesized rows, tagged so the verifier knows they are placeholders).

## Usage

```
kolm seeds new <template>                       scaffold from a known template
kolm seeds new "<free text brief>" [flags]      candidate seeds from a brief
kolm seeds generate --from <file> --count <N>   deterministic mutation expansion
kolm seeds list                                 list known templates
kolm seeds bootstrap                            generate a starter project
kolm seeds validate <file>                      schema-check a seeds.jsonl
```

## Flags (brief route)

- `--class <c>` force recipe class. One of `rule`, `synthesized_rule`,
  `compiled_rule`, `distilled_model`.
- `--count <N>` candidate count (default: 10).
- `--out <path>` write JSONL candidates to `<path>` (with `synthesized:true`).
- `--json` full JSON output.
- `--air-gap` deterministic candidates from a per-class library (default).
- `--no-air-gap` reserved for the networked teacher path. Not yet wired.

## Examples

```
kolm seeds new phi-redactor
kolm seeds new "teach me about denial codes 50 ways" --count 12
kolm seeds new "draft a denial appeal letter" --class distilled_model --out seeds.jsonl
kolm seeds new "compute HEDIS CBP measure" --json
kolm seeds generate --from seeds.jsonl --count 200
kolm seeds validate seeds.jsonl
```

## Honest scope

Brief-mode rows are candidates, not labels. Each row carries
`synthesized:true`. The intended flow is: scaffold then `kolm seeds split`
then `kolm eval` then `kolm verify`. K-score against scaffolded candidates
is not ground truth. Verify before ship: replace candidate rows with
examples you actually want the model to learn from, then re-compile and
re-verify the receipt chain.

## See also

- `kolm nl "<brief>"` to scaffold the full recipe (spec + seeds) from a brief.
- `kolm compile --spec <file> --examples seeds.jsonl` to compile the recipe.
- `kolm verify <artifact>.kolm` to confirm the receipt chain.
- `/training/data-sources` for the upstream data-source registry.
- `/training` for the per-class data-volume targets.
- `/spec/rs-1` (RS-1 v2.1) for the seeds.jsonl train/holdout split schema.
