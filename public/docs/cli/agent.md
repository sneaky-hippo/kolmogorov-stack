# kolm agent

Build, inspect, merge, and export self-growing Hermes-style tool-use
agents from one or more `.kolm` recipes (W236). The agent blueprint
ships as a deterministic signed JSON document so consumers can verify
the tool catalog before instantiation.

## Usage

```
kolm agent export <recipe.kolm>... --out <agent.json>
kolm agent build  --name <slug> --base-model <id> --description <text>
kolm agent merge  <a.json> <b.json> --out <merged.json>
kolm agent show   <agent.json>
kolm agent verify <agent.json>
```

## Examples

```
kolm agent export billing.kolm support.kolm --out finance-agent.json
kolm agent build --name ops --base-model NousResearch/Hermes-4.3-36B \
                 --description "ops triage assistant"
kolm agent merge finance-agent.json ops-agent.json --out combined.json
kolm agent show combined.json
kolm agent verify combined.json                # integrity_hash + tool sigs
```

## What an agent blueprint contains

- `id` / `name` / `description` / `base_model` / `chat_template`
- `tools[]`: one entry per recipe, with `name`, `description`,
  `input_schema`, `recipe_class`, and `artifact_hash`
- `capture_namespace`: where invocations capture for the self-growing
  loop
- `integrity_hash`: sha256 over canonical JSON (excluding the hash itself)

## See also

- `/foundations/scripts` for the deployment recipe.
- `kolm init-agent --template agent` for the scaffolding flow.
- `kolm compile` to produce the underlying recipes the agent wraps.
