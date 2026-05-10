# Recipe — VS Code Extension

> Show your AI agent how once. Run forever — right inside your editor.

When this extension sees a call to `openai.chat.completions.create` or `anthropic.messages.create`, it shows a CodeLens above it:

> *↳ Replace with Recipe — pay once, run free forever*

Click it → pick (or synthesize) a Recipe → the LLM call gets swapped for a deterministic JS function that costs $0 per call and returns in microseconds.

## Install

```bash
code --install-extension recipe-vscode-0.1.0.vsix
```

(or build it: `npm install -g @vscode/vsce && vsce package`)

## Configure

`Settings → Recipe`:

- `recipe.apiKey` — your `ks_…` key (or set env `RECIPE_API_KEY`)
- `recipe.baseUrl` — defaults to the hosted service
- `recipe.suggestReplacements` — toggle the inline CodeLens

## Commands

| Command | What it does |
|---|---|
| **Recipe: Synthesize from selection** | Highlight 4-8 examples → mints a recipe |
| **Recipe: Run a recipe** | Quick-run by id or curated name |
| **Recipe: Search the registry** | Plain-language search; copies id to clipboard |
| **Recipe: Replace this LLM call with a recipe** | Swap a detected LLM call inline |
| **Recipe: Open Console** | Open the hosted dashboard |

## Selection format for synthesis

JSON:

```json
[
  { "input": "WIN free iPhone", "expected": true },
  { "input": "lunch?",          "expected": false }
]
```

Or arrow lines:

```
WIN free iPhone → true
CLICK FOR $1000 → true
meeting at 3pm  → false
lunch?          → false
```

## License

MIT © [Kolmogorov](https://kolm.ai)
