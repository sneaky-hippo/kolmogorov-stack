---
name: zh-greeter
description: english to mandarin chinese phrasebook. exact-match lookup with case-fold and trim. returns {chinese, pinyin, exact} or null when unknown.
allowed-tools: []
disable-model-invocation: false
---

# zh-greeter

english to mandarin chinese phrasebook. exact-match lookup with case-fold and trim. returns {chinese, pinyin, exact} or null when unknown.

## How to invoke

Frontier agents call this skill via MCP after `kolm serve --mcp`:

- Tool name: `mcp__kolm__zh-greeter`
- Backing artifact: `zh-greeter.kolm`
- Transport: stdio (zero-port; no network exposure)

## Guarantees

K-score: 0.988 (composite). Runtime egress is patched at the process boundary — the artifact cannot reach the network during execution. The .kolm bundle is signed; signatures are verified before each call.
