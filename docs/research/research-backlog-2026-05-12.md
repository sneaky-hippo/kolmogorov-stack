# Research Backlog

Opened: 2026-05-12

This backlog keeps the research loop alive. The goal is to convert broad "keep researching" into specific questions that can update `critical-insights.csv`.

## P0: Claim And Product Truth

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-001 | What exactly is inside a current `.kolm` produced from a clean compile? | Generate a sample artifact, unzip it, hash every member, verify receipt, run artifact. | Artifact evidence page and updated claim table. |
| RB-002 | Which live pages imply local weights, LoRA, phone runtime, or compliance status? | Crawl `public/*.html` and live `kolm.ai` pages for claim terms. | Claim audit CSV with exact page, phrase, allowed/revise/action. |
| RB-003 | Can a receipt be verified offline from a clean machine without secrets? | Try CLI/API verifier with a sample HMAC receipt; design Ed25519 sample. | Receipt mode spec and verifier acceptance test. |
| RB-004 | What is the minimum production deployment profile? | Exercise `/ready` under env matrices: JSON, SQLite, missing secret, production-like host. | Deployment truth table. |
| RB-008 | Does the signed manifest K-score size match the final zip size? | Fix or test the `buildAndZip` second-pass size mutation found in `artifact-truth-audit-2026-05-12.md`. | Artifact K-score size consistency test and implementation fix. |
| RB-009 | Which artifact member names mislead buyers? | Review `model.gguf`, `lora.bin`, and `index.sqlite-vec` naming against actual v0.1 contents. | Artifact naming/copy decision memo. |
| RB-015 | What is the first public-key receipt mode Kolm can ship? | Design Ed25519 receipt fields, public key identity, fixture vectors, CLI verifier, and migration from HMAC. | Receipt v0.2 public verification spec. |
| RB-016 | Should local artifact runs produce signed per-run receipts? | Compare current unsigned `rs-1-run` object with artifact receipt and API run HMAC receipt paths. | Local-run receipt design decision. |

## P0: Competitor Depth

## P0: Claim Governance Follow-Up

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-005 | Which public pages fail the current forbidden-claim policy? | Run `tests/site.test.js` after isolating unrelated dirty public edits, then map each failure to a claim-audit row. | Claim cleanup task list. |
| RB-006 | Do live pages match the local repo after deployment? | Fetch key `kolm.ai` URLs and run the forbidden-pattern set from `tests/site.test.js`. | Live claim smoke report. |
| RB-007 | Which artifact claims have direct proof links? | For every page saying model, LoRA, phone, VPC, offline, or public-key receipt, identify a reproducible artifact/benchmark or mark as roadmap. | Proof-link matrix. |

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-010 | Which competitors already offer trace-to-cheaper-model or trace-to-function replacement? | Deep review of OpenPipe, Predibase, Braintrust, Langfuse, Helicone, Portkey, LiteLLM. | Direct-wedge competitor memo. |
| RB-011 | Which gateways can accept a custom artifact-first route today? | Prototype or docs review for LiteLLM, Vercel AI SDK, Cloudflare Workers, Portkey. | Integration priority matrix with implementation steps. |
| RB-012 | Which eval platforms can export datasets/traces in a format Kolm can ingest? | LangSmith, Langfuse, Braintrust, Phoenix, Weave, Helicone export docs. | Importer spec and sample fixtures. |
| RB-013 | Which competitor evidence rows have a working Kolm import path? | Use `competitor-evidence-matrix-2026-05-12.csv` to pick one gateway, one eval platform, and one prompt registry, then build fixtures. | Importer proof matrix. |
| RB-014 | Which competitor claims directly conflict with Kolm public copy? | Compare competitor matrix against `claim-audit-2026-05-12.csv` and current local pages. | Copy-risk diff and rewrite queue. |

## P1: Benchmarks And Runtime Targets

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-020 | What is the real recipe-tier performance on laptop/server? | Local benchmarks with 5 workloads, p50/p95, artifact size, receipt overhead. | Benchmark report and `/benchmarks` update. |
| RB-021 | What is the simplest local runtime target for a real model-bearing artifact? | Evaluate ONNX Runtime, llama.cpp/GGUF, LiteRT, Core ML, ExecuTorch bridge paths. | Runtime target decision memo. |
| RB-022 | What does "phone support" actually mean for v1? | iOS, Android, PWA/web target matrix with unsupported cases. | Platform support table for docs/site. |

## P1: Trust, Security, And Compliance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-030 | What is the strongest near-term recipe sandbox? | Compare isolated-vm, QuickJS, WASM/Wasmtime, Firecracker, worker isolation. | Sandbox decision and malicious test plan. |
| RB-031 | What receipt signing architecture should ship first? | Compare Ed25519 local keys, KMS/HSM, Sigstore/Rekor, tenant keys, key rotation. | Receipt v0.2 spec and migration plan. |
| RB-032 | What compliance evidence can Kolm honestly claim in Q2 2026? | DPA/BAA/subprocessor/security controls/current limitations. | Compliance posture page and sales one-pager. |

## P1: GTM And Buyer Proof

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-040 | Which first ICP has the fastest proof loop: AI-native SaaS, healthcare, fintech, defense, legal, or edge robotics? | Interview plan, buyer objections, pilot success metrics, willingness to pay. | ICP scorecard and design-partner list. |
| RB-041 | What pilot offer is clear enough to sell in one email? | Competitor pilot offers, Kolm proof assets, price/terms. | One-page design-partner offer. |
| RB-042 | What is the best public artifact pack for credibility? | Choose 8-12 tasks with evals, receipts, and live demos. | Seed registry plan. |

## P2: Pricing And Packaging

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-050 | Which pricing model avoids charging for local runtime while monetizing governance? | Compare competitor pricing and Kolm value units: compile, registry, receipt retention, org controls. | Pricing model memo and site copy update. |
| RB-051 | How should public/private registry SKUs work? | Enterprise package managers, model registries, compliance retention analogs. | Registry SKU spec. |

## Research Operating Cadence

| Cadence | Work |
| --- | --- |
| Daily during launch sprint | Update `critical-insights.csv` for any claim/product gap discovered. |
| Weekly | Refresh top 10 competitor changes, ship one source-backed memo, close or advance backlog rows. |
| Monthly | Re-score competitor matrix, pricing, benchmarks, and regulatory source notes. |
| Before public claims | Verify with live code, live page, source link, and reproducible command. |
