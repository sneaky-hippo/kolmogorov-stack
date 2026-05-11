# Competitor Evidence Matrix And Positioning Gaps

Date: 2026-05-12

This pass converts the earlier competitor landscape into a source-backed evidence matrix. The detailed row-level artifact is `competitor-evidence-matrix-2026-05-12.csv`.

## Core Finding

Kolm should not compete as a generic AI gateway, trace dashboard, prompt registry, memory layer, fine-tuning UI, RAG framework, or mobile runtime. Every one of those categories already has credible specialists with current official docs and product surfaces.

The stronger lane is narrower and harder to copy:

- compile successful task behavior into portable artifacts,
- verify those artifacts with explicit conformance/K-score gates,
- emit receipts that can be checked without trusting a dashboard,
- import traces/evals/prompts from existing tools,
- target existing local/server/mobile runtimes instead of replacing them.

## Cluster Findings

### Gateways Are Table Stakes

Portkey, LiteLLM, Cloudflare AI Gateway, Vercel AI Gateway, OpenRouter, and Helicone all cover overlapping gateway primitives: unified model access, provider routing, fallback, retries, budgets, caching, rate limits, logging, analytics, and observability.

Implication: gateway claims should be demoted to integration language. Kolm should become the thing that consumes traces from gateways and emits executable, verifiable artifacts.

Near-term product move: create `kolm import` or bridge examples for LiteLLM, Portkey, Vercel AI SDK, Cloudflare Workers, and Helicone logs.

### Observability And Evals Own The Feedback Loop

LangSmith, Langfuse, Braintrust, Helicone, and PromptLayer already give teams traces, prompts, datasets, evals, scorecards, production logs, and human review loops.

Implication: Kolm cannot win by adding another traces page. The differentiator must be what happens after a task has enough evidence: compilation, conformance, portability, and receipts.

Near-term product move: define a minimal trace/eval interchange schema and ship one importer fixture each for Langfuse, Braintrust, and LangSmith.

### Fine-Tuning Providers Own LoRA And Hosted Customization

Predibase, OpenPipe, Together AI, Hugging Face AutoTrain, and model providers all sell or document paths for fine-tuning/customization. OpenPipe is especially close to the trace-to-cheaper-model wedge.

Implication: LoRA cannot be used as public proof unless the generated `.kolm` artifact actually contains adapter evidence and a verifier can inspect it. Until then, LoRA belongs in roadmap or integration-target language.

Near-term product move: split artifact tiers into `recipe-only`, `recipe-plus-index`, `model-adapter`, and `native-runtime` with commands that prove each tier.

### Memory Vendors Own Persistent Personalization

Mem0, Zep, and Letta show that agent memory and stateful personalization are active products with their own APIs and platforms.

Implication: Kolm should not overclaim recall-index or memory features. It should compile from memory snapshots or trace outputs when present, and document exactly what state is packaged.

Near-term product move: add artifact schema fields for source memories, index metadata, and unsupported memory semantics.

### Runtime Substrate Should Be Borrowed

Apple Foundation Models, Google LiteRT, PyTorch ExecuTorch, ONNX Runtime Mobile, llama.cpp, MLC, and Ollama cover much of the local/on-device execution surface.

Implication: Kolm should wrap these substrates. Public phone/offline claims need hardware, runtime, model, artifact size, latency, power, and supported-device proof.

Near-term product move: select one primary runtime bridge for proof and move all other runtimes to explicit target architecture.

### Standards Compress Moats

MCP standardizes tool/context connections. OpenAI Structured Outputs handles strict schema-shaped output for many tasks. Sigstore/Rekor patterns raise the bar for public verification. EU AI Act and other compliance regimes make broad readiness claims risky.

Implication: Kolm should use standards as inputs and verification targets, not claim broad compatibility without conformance evidence.

Near-term product move: add conformance checklists for MCP, schema output, receipt verification, and compliance claim review.

## Direct Positioning Gaps

| Gap | Evidence | Risk | Better Position |
| --- | --- | --- | --- |
| Generic gateway story | Multiple gateway vendors document routing, fallback, budgets, cache, rate limits, and logs. | Buyers compare Kolm to cheaper or embedded gateway tools. | Kolm compiles from gateway traces into portable artifacts. |
| Generic trace dashboard | LangSmith, Langfuse, Braintrust, Helicone, and PromptLayer cover traces/evals/prompts. | Kolm becomes another dashboard with weaker ecosystem depth. | Kolm turns accepted traces/evals into artifacts and receipts. |
| LoRA as shipped fact | Fine-tuning vendors own LoRA/customization; local code marks LoRA as later bridge work. | Public pages can be falsified by artifact inspection. | LoRA is a roadmap tier until artifact evidence exists. |
| Phone/offline runtime | Native runtime ecosystems are platform-specific and fast-moving. | Unsupported hardware claims create buyer trust and support risk. | One benchmarked runtime bridge first; everything else target architecture. |
| Public receipt verification | HMAC proves service-internal integrity, not public offline verification. | Registry/on-chain wording overstates trust model. | Ed25519/Sigstore-style verification before public registry claims. |
| Compliance readiness | Legal obligations depend on deployment, data, role, controls, and documentation. | HIPAA/EU AI/SOC 2/FedRAMP language can become sales or regulatory risk. | Claim specific controls and review status only. |

## Product And Research Actions

1. Build a gateway-to-artifact proof loop: capture traces from one gateway/observability source, generate a recipe-only artifact, run conformance, and emit a receipt.
2. Add import fixtures for Langfuse, Braintrust, and LangSmith before building more custom observability UI.
3. Publish a precise artifact-tier vocabulary: `recipe-only`, `recipe-plus-index`, `model-adapter`, and `native-runtime`.
4. Choose one v1 runtime bridge and benchmark it before making device claims.
5. Upgrade receipt architecture from HMAC-only to public-key verification if public/offline verification remains a core claim.
6. Add claim-review gates for MCP compatibility, structured-output equivalence, HIPAA, EU AI Act, SOC 2, FedRAMP, phone support, and local weights.

## Evidence Limits

This is a product-positioning and architecture evidence pass. Official competitor pages prove what those vendors claim and document, not their real adoption, performance, reliability, or customer satisfaction. Follow-up research should test import/export paths, pricing, developer friction, and artifact proof against live tools.
