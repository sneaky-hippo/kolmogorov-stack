---
name: claims-redactor
description: Claims-redactor: HIPAA Safe Harbor PHI redaction for healthcare claims and clinical narratives. Strips all 18 Safe Harbor identifiers plus NPI, DEA, and Medicaid IDs, replacing each with a stable [PHI_<CLASS>_<INDEX>] token so the original can be re-injected after a teacher-API round trip. Single source of truth: examples/claims-redactor/recipe.js mirrors the detector matrix in src/phi-redactor.js (W295/W258-ML-4 pattern). Evals run against examples/claims-redactor/seeds.jsonl (60 real claims no
allowed-tools: []
disable-model-invocation: false
---

# claims-redactor

Claims-redactor: HIPAA Safe Harbor PHI redaction for healthcare claims and clinical narratives. Strips all 18 Safe Harbor identifiers plus NPI, DEA, and Medicaid IDs, replacing each with a stable [PHI_<CLASS>_<INDEX>] token so the original can be re-injected after a teacher-API round trip. Single source of truth: examples/claims-redactor/recipe.js mirrors the detector matrix in src/phi-redactor.js (W295/W258-ML-4 pattern). Evals run against examples/claims-redactor/seeds.jsonl (60 real claims no

## How to invoke

Frontier agents call this skill via MCP after `kolm serve --mcp`:

- Tool name: `mcp__kolm__claims-redactor`
- Backing artifact: `claims-redactor.kolm`
- Transport: stdio (zero-port; no network exposure)

## Guarantees

K-score: 0.983 (composite). Runtime egress is patched at the process boundary — the artifact cannot reach the network during execution. The .kolm bundle is signed; signatures are verified before each call.
