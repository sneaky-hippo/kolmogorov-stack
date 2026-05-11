# Kolm Research Knowledge Repository

Last updated: 2026-05-12

This directory is the living research base for Kolm / the Kolmogorov stack. It is meant to be updated continuously as code, live site claims, competitors, buyer feedback, benchmarks, and regulatory facts change.

## Current Artifacts

| Artifact | Purpose |
| --- | --- |
| `critical-insights.csv` | Living sheet of the highest-leverage findings, risks, actions, and follow-up research threads. |
| `competitor-landscape-2026-05-12.md` | Source-backed competitor and adjacent-market map. |
| `competitor-evidence-matrix-2026-05-12.csv` | Row-level official-source evidence matrix for competitors, standards, implications, gaps, and recommended action. |
| `competitor-positioning-gaps-2026-05-12.md` | Strategic synthesis from the competitor evidence matrix. |
| `codebase-and-live-site-gap-review-2026-05-12.md` | Evidence-based comparison of the local repo, the live `kolm.ai` positioning, and the current implementation. |
| `codebase-module-inventory-2026-05-12.md` | Module, route-group, test, SDK, and architecture inventory from local source evidence. |
| `api-surface-inventory-2026-05-12.csv` | Route-group sheet for auth boundaries, maturity, risks, and follow-up research. |
| `claim-governance-audit-2026-05-12.md` | Live/local public-claim audit for offline, mobile, LoRA, receipt, and compliance language. |
| `claim-audit-2026-05-12.csv` | Claim-level sheet with evidence, risk, code truth, and recommended action. |
| `artifact-truth-audit-2026-05-12.md` | Current `.kolm` artifact contents, fixture proof, and product-truth gaps. |
| `artifact-fixture-inventory-2026-05-12.csv` | Row-level inventory of generated and fixture artifacts, hashes, contents, receipt mode, and K-score size drift. |
| `receipt-verification-truth-2026-05-12.md` | HMAC receipt verification truth, unsafe public-verification wording, and public-key gaps. |
| `receipt-verification-matrix-2026-05-12.csv` | Receipt-mode matrix across artifact receipts, API receipts, local runs, drive-by verifier, and readiness. |
| `source-register-2026-05-12.md` | Primary-source register for the first research pass. |
| `research-backlog-2026-05-12.md` | Open research threads to keep this repository moving. |

## Maintenance Rules

1. Treat `critical-insights.csv` as the canonical sheet. Add a row whenever a finding changes product direction, positioning, technical priority, customer targeting, or risk posture.
2. Prefer primary sources: official docs, official product pages, official policy pages, repo code, live pages, verified benchmark output, and customer evidence.
3. Separate facts from implications. A product page can prove what a competitor claims; it does not prove performance, adoption, or customer value.
4. Mark roadmap and preview features explicitly. Do not let live copy imply shipped local weights, LoRA training, mobile runtime support, or compliance certification unless real evidence exists.
5. Keep source dates. Competitor claims and AI regulation change quickly.

## Working Thesis

Kolm should not compete as another gateway, observability tool, memory layer, RAG framework, fine-tuning UI, or on-device runtime. The defensible lane is:

- a portable `.kolm` artifact format,
- a compiler that turns task evidence into executable behavior,
- a conformance and K-score gate,
- signed compile/run receipts,
- private/public registry and governance,
- runtime targets that wrap existing local/server runtimes rather than replacing them.

The most urgent work is making this claim true end to end: real artifact contents, real receipt verification, durable storage/jobs, stronger sandboxing, seeded registry evidence, and hardware/runtime benchmarks.
