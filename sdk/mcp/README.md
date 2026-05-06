# @kolmogorov/recipe-mcp

> MCP server for [Recipe](https://kolmogorov-stack-production.up.railway.app) — show your AI agent how once, run forever.

Adds 13 tools to Claude Code (or any MCP client) for synthesizing, running, searching, and composing deterministic JS classifiers. Use these inside an agent loop instead of paying for repeat LLM-as-judge calls.

## Install

```bash
npm i -g @kolmogorov/recipe-mcp
```

Add to `~/.config/claude-code/.mcp.json` (or your project's `.mcp.json`):

```json
{
  "mcpServers": {
    "recipe": {
      "command": "recipe-mcp",
      "env": {
        "RECIPE_API_KEY": "ks_…"
      }
    }
  }
}
```

## Tools exposed

| Tool | Use it when… |
|---|---|
| `recipe_synthesize` | The agent sees itself about to call an LLM the same tiny question over and over. |
| `recipe_run` | Run a recipe by id or curated name (e.g. `is-spam`). |
| `recipe_search` | Before synthesizing — there might already be one. |
| `recipe_compose` | Combine the top-k matched recipes for a query. |
| `recipe_list` / `recipe_get` / `recipe_stats` | Browse and inspect. |
| `recipe_label_corpus` | Auto-label a HuggingFace dataset with a recipe. |
| `recipe_train_specialist` | Turn a recipe into a fine-tuned LoRA (Day 60-120 pipeline). |
| `recipe_specialists` / `recipe_run_specialist` | Manage Specialists. |
| `recipe_featured` / `recipe_account` | Public registry + your tenant. |

## How an agent uses this

```
USER: detect spam in these 200 support tickets

AGENT (cold call to LLM, ~$0.20):
  → recipe_search { query: "detect spam in support tickets" }
  → recipe_run { recipe: "is-spam", input: <each ticket> }   # 200×, ~$0
  → done.
```

Compared to 200 LLM calls (~$0.20 + 200×600ms latency), the agent finishes in milliseconds for free.

## License

MIT © [REM Labs](https://remlabs.ai)
