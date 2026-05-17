# kolm nl

Natural-language recipe scaffolder. Describe a recipe in plain English; get a
structured scaffold ready to drop into `spec.json` + `seeds.jsonl`.

## Usage

```
kolm nl "<free text request>" [--class <c>] [--out <path>] [--json] [--no-network]
```

## Flags

- `--class <c>` force the recipe class. One of `rule`, `synthesized_rule`,
  `compiled_rule`, `distilled_model`. Default: keyword-inferred from the request.
- `--out <path>` write the scaffold to a file (default: stdout).
- `--json` machine-readable JSON output. Default: human-readable.
- `--no-network` force the air-gap path (same as `KOLM_AIRGAP=1`). Today the
  networked path is **not yet wired** so every invocation is effectively
  air-gap; the flag exists for forward compatibility.

## Examples

```
kolm nl "parse EDI 837 claims and emit JSON rows"
kolm nl "draft an appeal letter for an 835 denial with code CO-97"
kolm nl "compute HEDIS HBD measure for a diabetic cohort"
kolm nl "redact PHI from clinical notes" --class rule --out scaffolds/phi.json
```

## Output schema

```
{
  "ok": true,
  "suggested_slug":              "<kebab-case slug>",
  "suggested_task_description":  "<the request, verbatim>",
  "recipe_class":                "rule | synthesized_rule | compiled_rule | distilled_model",
  "suggested_k_score_gate":      0.88,
  "suggested_seed_examples":     [{ "prompt": "...", "completion": "..." }, ...],   // length 10
  "next_steps":                  [ "kolm compile --spec ...", "kolm verify ..." ],
  "class_inference_basis":       "keyword:edi | class_hint | default",
  "network_status":              "air_gap | not_yet_wired",
  "note":                        "scaffolds are starting points. refine + verify before compile."
}
```

## How class inference works (air-gap path)

A keyword match over the request text picks the class in priority order:

1. Generative requests (`draft`, `write a`, `summarize`, `translate`, `appeal letter`)
   map to `distilled_model` (real model bytes required).
2. Native / wasm / C / Rust mentions map to `compiled_rule`.
3. Known measures with a spec (`HEDIS`, `compute measure`, `apply spec`) map to
   `synthesized_rule` (teacher emits the rule code, AST-validated).
4. Deterministic parsing / redacting / validating (`parse`, `redact`, `extract`,
   `EDI`, `FHIR`, `classify`) map to `rule`.
5. No keyword match -> default `rule` (honest floor; upgrade with `--class`).

Pass `--class <c>` to override.

## Honest scope

- The air-gap path is deterministic, keyword-based, and ships today. Same input
  always produces the same scaffold.
- The networked LLM-augmented path is **not yet wired**. When it lands, it will
  replace the placeholder fields (seed examples, task description refinement)
  with model-generated suggestions, leaving class inference + slug + gate
  intact.
- Scaffolds are starting points, not finished recipes. Edit the seeds, refine
  the task description, then run `kolm compile --spec <file>` and
  `kolm verify <artifact>.kolm` before you ship anything to production.

## See also

- `kolm seeds new <template>`: scaffold from a pre-built template
- `kolm compile --spec <file>`: compile a recipe from a spec
- `kolm verify <artifact>.kolm`: verify the receipt chain before ship
- `/quickstart/nl`: the four-step walk-through from brief to signed artifact
- `/spec/rs-1` (RS-1 v2.1): full manifest + receipt-chain schema
- `/frozen-eval`: how the eval set hash anchors the K-score replay
- `/training/data-sources`: registry of data sources behind the seed templates
