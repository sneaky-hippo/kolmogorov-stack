---
name: invoice-ext
description: extract invoice line items (description, quantity, unit_price, total) from a free-text line
allowed-tools: []
disable-model-invocation: false
---

# invoice-ext

extract invoice line items (description, quantity, unit_price, total) from a free-text line

## How to invoke

Frontier agents call this skill via MCP after `kolm serve --mcp`:

- Tool name: `mcp__kolm__invoice-ext`
- Backing artifact: `invoice-ext.kolm`
- Transport: stdio (zero-port; no network exposure)

## Guarantees

K-score: 0.988 (composite). Runtime egress is patched at the process boundary — the artifact cannot reach the network during execution. The .kolm bundle is signed; signatures are verified before each call.
