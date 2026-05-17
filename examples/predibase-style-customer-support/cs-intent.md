---
name: cs-intent
description: Classify a customer-support message into one of 10 intent labels: refund, cancel, billing, shipping, password_reset, account_lock, complaint, feedback, escalate, other. Designed as the Predibase/LoRAX-style 1000-row demo — the rule-class compiled artifact should match the LLM on intent recall while costing $0/call and running in microseconds.
allowed-tools: []
disable-model-invocation: false
---

# cs-intent

Classify a customer-support message into one of 10 intent labels: refund, cancel, billing, shipping, password_reset, account_lock, complaint, feedback, escalate, other. Designed as the Predibase/LoRAX-style 1000-row demo — the rule-class compiled artifact should match the LLM on intent recall while costing $0/call and running in microseconds.

## How to invoke

Frontier agents call this skill via MCP after `kolm serve --mcp`:

- Tool name: `mcp__kolm__cs-intent`
- Backing artifact: `cs-intent.kolm`
- Transport: stdio (zero-port; no network exposure)

## Guarantees

K-score: 0.987 (composite). Runtime egress is patched at the process boundary — the artifact cannot reach the network during execution. The .kolm bundle is signed; signatures are verified before each call.
