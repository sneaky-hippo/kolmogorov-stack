---
name: md-links
description: Extract markdown links (inline, reference, autolink) into a structured list.
allowed-tools: []
disable-model-invocation: false
---

# md-links

Extract markdown links (inline, reference, autolink) into a structured list.

## How to invoke

Frontier agents call this skill via MCP after `kolm serve --mcp`:

- Tool name: `mcp__kolm__md-links`
- Backing artifact: `md-links.kolm`
- Transport: stdio (zero-port; no network exposure)

## Guarantees

K-score: 0.988 (composite). Runtime egress is patched at the process boundary — the artifact cannot reach the network during execution. The .kolm bundle is signed; signatures are verified before each call.
