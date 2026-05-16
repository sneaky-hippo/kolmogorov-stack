---
name: phone-validator
description: validate and normalize raw phone strings into E.164 with country tag
allowed-tools: []
disable-model-invocation: false
---

# phone-validator

validate and normalize raw phone strings into E.164 with country tag

## How to invoke

Frontier agents call this skill via MCP after `kolm serve --mcp`:

- Tool name: `mcp__kolm__phone-validator`
- Backing artifact: `phone-validator.kolm`
- Transport: stdio (zero-port; no network exposure)

## Guarantees

K-score: 0.988 (composite). Runtime egress is patched at the process boundary — the artifact cannot reach the network during execution. The .kolm bundle is signed; signatures are verified before each call.
