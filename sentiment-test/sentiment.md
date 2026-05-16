---
name: sentiment
description: classify product-review sentiment as positive/neutral/negative with a continuous score using a lexicon
allowed-tools: []
disable-model-invocation: false
---

# sentiment

classify product-review sentiment as positive/neutral/negative with a continuous score using a lexicon

## How to invoke

Frontier agents call this skill via MCP after `kolm serve --mcp`:

- Tool name: `mcp__kolm__sentiment`
- Backing artifact: `sentiment.kolm`
- Transport: stdio (zero-port; no network exposure)

## Guarantees

K-score: 0.988 (composite). Runtime egress is patched at the process boundary — the artifact cannot reach the network during execution. The .kolm bundle is signed; signatures are verified before each call.
