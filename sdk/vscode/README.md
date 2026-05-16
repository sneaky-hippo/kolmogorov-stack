# Kolm — VS Code Extension

> Compile, inspect, verify, and run `.kolm` artifacts without leaving your editor.

When this extension sees a call to `openai.chat.completions.create`, `anthropic.messages.create`, or a `fetch(api.openai.com/...)` it offers a CodeLens:

> *↳ Replace with a signed kolm artifact (pay once, run free forever)*

Click it, pick (or compile) a `.kolm` artifact, and the LLM call gets swapped for a deterministic call that's signed, gated by K-score, and verifiable end-to-end.

## Install

```bash
code --install-extension kolm-vscode-0.2.0.vsix
```

Or build from source:

```bash
cd sdk/vscode
npm install -g @vscode/vsce
vsce package
```

## Configure

`Settings → Kolm`:

| Setting | Default | What it does |
|---|---|---|
| `kolm.apiKey` | `""` | Your `ks_…` key. Falls back to `KOLM_API_KEY` env var. Get one at [kolm.ai/signup](https://kolm.ai/signup). |
| `kolm.baseUrl` | `https://kolm.ai` | Override the API endpoint (point at staging or a local server.js). |
| `kolm.suggestReplacements` | `true` | Toggle the inline "Replace with a signed kolm artifact" CodeLens. |
| `kolm.showRestEquivalent` | `true` | After every command, log the equivalent REST call to the Kolm output channel. Editor doubles as an API tutorial. |

## Commands

Open the command palette (`Cmd/Ctrl+Shift+P`) and type `Kolm:`.

| Command | What it does |
|---|---|
| **Kolm: Inspect this .kolm artifact** | Shows manifest + receipt summary in the output channel. Works on the active editor, an explorer right-click, or a file picker. |
| **Kolm: Verify this .kolm artifact** | Re-verifies the 4-ring HMAC receipt chain via `/v1/receipts/verify`. |
| **Kolm: Run a .kolm artifact with an input** | Prompts for input, POSTs `/v1/run/inline`, prints the output + latency + verified flag. |
| **Kolm: Compile a new artifact from a spec** | Plain-English task description → `/v1/compile` job. Track progress in the dashboard. |
| **Kolm: Search the public registry** | Search the public `/v1/registry/export` catalog and copy a slug to the clipboard. |
| **Kolm: Replace this LLM call with a kolm artifact** | Swap a highlighted LLM call for a `kolm.run(...)` invocation. |
| **Kolm: Open the dashboard** | Opens `https://kolm.ai/dashboard` in the system browser. |

The first three also appear when you right-click a `.kolm` file in the Explorer panel.

## CLI → REST translator

Every command logs the equivalent REST call to the **Kolm** output channel (toggle off with `kolm.showRestEquivalent: false`). This mirrors the behavior of `kolm tui` and `kolm run` / `kolm verify` so you never have to read SDK docs to find the right endpoint.

Sample log line after running an artifact:

```
> REST equivalent
  POST https://kolm.ai/v1/run/inline
  Authorization: Bearer ks_169...
  Content-Type: application/json
  {
    "artifact": "phi-redactor.kolm",
    "input": "hello"
  }
```

## Why this exists

Cloud LLM bills compound. Every prompt is a paid call. A `.kolm` artifact is compiled once (the bill stops there) and then runs for free against any input, with the same signed K-score guarantee on every call.

This extension exists so the compile → inspect → verify → run loop happens where you already work.

## License

Apache-2.0 © [Kolmogorov](https://kolm.ai)
