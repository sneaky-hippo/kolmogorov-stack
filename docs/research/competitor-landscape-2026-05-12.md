# Competitor Landscape

Research pass: 2026-05-12

This map groups competitors by the job they own. The purpose is not to say every listed company is a direct substitute. The purpose is to protect Kolm from drifting into crowded markets and to identify the integration paths that make Kolm's artifact/receipt layer more valuable.

## Executive Read

Kolm's credible moat is not "cheaper inference" by itself. Cost, privacy, and latency are adoption wedges. The stronger category is verified AI behavior: task artifact, eval gate, receipt, registry, runtime target, and governance.

Most adjacent vendors own one layer:

- Gateways own routing, spend control, caching, and provider abstraction.
- Observability/eval platforms own traces, datasets, prompts, experiments, and dashboards.
- Fine-tuning platforms own adapter/model training and hosted inference.
- RAG/memory platforms own retrieval, memory state, and agent context.
- On-device runtimes own execution backends.
- Standards/protocols own model-tool context, schemas, and supply-chain signing.

Kolm should integrate with these layers and own the artifact contract above them.

## Threat Ranking

| Rank | Threat | Why It Matters | Defensive Move |
| --- | --- | --- | --- |
| 1 | Status quo: keep paying frontier APIs | Easiest buyer behavior. No migration work. | Prove avoided calls, lower latency, and audit evidence with a one-day SDK/gateway integration. |
| 2 | Gateways adding trace-to-function replacement | They already sit in customer traffic and can detect repeated workloads. | Ship gateway plugins first and make `.kolm` the artifact they route to. |
| 3 | Observability/eval platforms adding compile/export | They own traces, eval datasets, and prompt history. | Import traces from them and export receipts back. Own the packaging/proof layer. |
| 4 | Fine-tuning platforms offering cheaper hosted adapters | They can undercut "local LoRA" until Kolm has real runtime packaging. | Treat them as training backends while Kolm owns signing, eval gates, and registry. |
| 5 | On-device runtimes improving developer UX | They make local execution cheaper and easier. | Target them as backends; do not claim Kolm replaces Core ML, LiteRT, ONNX, ExecuTorch, llama.cpp, or MLC. |
| 6 | Provider-native schemas and agent SDKs | OpenAI, Anthropic, Google, and others can add constrained output, tracing, and tool contracts. | Stay vendor-neutral and prove offline/portable receipts across runtimes. |

## Cluster Map

| Cluster | Representative Players | What They Own | What They Do Not Own | Kolm Implication |
| --- | --- | --- | --- | --- |
| AI gateways and routers | Portkey, LiteLLM, Cloudflare AI Gateway, Vercel AI Gateway, OpenRouter | Provider abstraction, routing, keys, budgets, caching, observability hooks. | Portable signed task artifacts with eval receipts that run outside the gateway. | Build middleware/plugins so gateways can route repeated calls to `.kolm` artifacts before model fallback. |
| LLM observability and evals | LangSmith, Langfuse, Braintrust, Helicone, Arize Phoenix, Weights & Biases Weave, PromptLayer, Humanloop, Vellum | Traces, prompt versions, evals, datasets, annotation, dashboards, experiments. | A vendor-neutral executable artifact standard with third-party-verifiable compile/run receipts. | Make these systems source feeds: import traces/evals, compile artifacts, write receipts back. |
| Fine-tuning and model customization | Predibase, OpenPipe, Together, OpenAI fine-tuning, Hugging Face AutoTrain, Fireworks, Replicate | Training UX, datasets, adapters, hosted inference, model deployment. | Cross-runtime artifact packaging, receipt ledger, K-score conformance, private registry. | Use them as training backends until native Specialist pipeline is real; do not compete on generic training UI. |
| RAG, orchestration, and memory | LangChain/LangGraph, LlamaIndex, DSPy, Mem0, Zep, Letta, Haystack | Chains, agents, retrieval, memory, optimization loops, context state. | Signed deterministic behavior artifacts and proof of a specific task contract. | Kolm artifacts should be callable nodes/tools inside these frameworks. |
| On-device and local runtimes | Apple Core ML, Apple Foundation Models, Google LiteRT, ONNX Runtime Mobile, PyTorch ExecuTorch, llama.cpp, MLC LLM, Ollama, LM Studio | Local model execution, hardware acceleration, quantized runtime backends. | Cross-platform behavior spec, receipt trail, registry, compliance evidence, artifact governance. | Publish a runtime target matrix. Position Kolm as wrapper/compiler/governance, not as the runtime itself. |
| Standards and protocols | MCP, OpenAI Structured Outputs, JSON Schema, Sigstore/Rekor, OCI-style packaging ideas | Tool/resource context, structured output constraints, signing primitives, transparency logs. | End-to-end AI behavior contract and compiler. | Integrate rather than oppose: Kolm MCP server, JSON schema output contracts, Sigstore/Rekor receipt anchoring. |

## Player Notes

### Gateways And Routers

| Player | Source-Backed Position | Kolm Angle |
| --- | --- | --- |
| Portkey | Official docs and product materials emphasize AI gateway, observability, guardrails, caching, virtual keys, and control across providers. | Portkey is a route-in point. Kolm can be the compiled artifact target for repeated deterministic traffic. |
| LiteLLM | Official docs position LiteLLM as a proxy/router across model providers with virtual keys, budgets, logging, and fallbacks. | A LiteLLM callback or provider adapter is likely the fastest way to prove avoided calls. |
| Cloudflare AI Gateway | Official docs emphasize caching, rate limiting, analytics, logging, and provider management at the network edge. | Cloudflare can host a Kolm verifier or edge recipe-tier runtime, but Kolm should not rebuild the gateway. |
| Vercel AI Gateway | Official docs emphasize routing and provider access through Vercel's AI stack. | Vercel AI SDK middleware can call `.kolm` first and fall back to gateway models. |
| OpenRouter | Official docs emphasize routing to many models/providers, provider routing, and fallbacks. | Useful comparison page: OpenRouter rents models; Kolm packages owned task behavior. |

### Observability, Evals, And Prompt Management

| Player | Source-Backed Position | Kolm Angle |
| --- | --- | --- |
| LangSmith | Official docs cover tracing/observability, evaluation, datasets, prompts, and LangGraph app workflows. | Import LangSmith datasets and traces, compile `.kolm`, export run receipts. |
| Langfuse | Official docs cover open-source LLM observability, tracing, prompt management, evals, and datasets. | Strong integration candidate because open-source users value portability. |
| Braintrust | Official docs emphasize evals, experiments, datasets, prompt playgrounds, and observability. | Braintrust evals can become Kolm eval gates. |
| Helicone | Official docs/product materials emphasize LLM observability, gateway/proxy, caching, rate limiting, and logs. | Helicone traffic logs can surface repeat tasks for compilation. |
| Arize Phoenix | Official docs cover AI/LLM observability, tracing, evals, and datasets. | Good source of eval traces and monitoring feedback for K-score drift. |
| Weights & Biases Weave | Official docs cover LLM application tracing, evaluations, and experiments. | Similar import/export path. |
| PromptLayer | Official docs cover prompt management, prompt registry, logs, evals, and collaboration. | Prompt versioning can feed Kolm specs; Kolm receipts can be attached to prompt releases. |
| Humanloop | Official docs/product materials focus on prompt management, evals, and AI product iteration. | Competes for AI workflow governance, but not artifact runtime ownership. |
| Vellum | Official docs/product materials cover AI workflow building, prompt management, evals, and deployment. | Threat if Vellum adds deterministic task compilation. Integration may be lower priority than Langfuse/Braintrust. |

### Fine-Tuning And Model Customization

| Player | Source-Backed Position | Kolm Angle |
| --- | --- | --- |
| Predibase | Official docs/product pages emphasize fine-tuning, LoRA, serverless inference, and model deployment. | Strong Specialist-tier competitor. Kolm should use receipt/registry/governance as differentiator. |
| OpenPipe | Official docs/product pages emphasize data collection, fine-tuning, evaluations, and replacing expensive LLM calls. | Closest wedge competitor for cost reduction from production traces. |
| Together AI | Official docs include fine-tuning and inference platform capabilities. | A training backend partner or comparison target. |
| OpenAI Fine-tuning | Official docs cover fine-tuning provider-hosted models from training examples. | Strong default option for OpenAI users, but provider-bound and not an owned local artifact. |
| Hugging Face AutoTrain | Official docs/product pages cover training models with managed/no-code workflows. | Training layer, not artifact proof layer. |

### RAG, Memory, And Agent Frameworks

| Player | Source-Backed Position | Kolm Angle |
| --- | --- | --- |
| LangChain / LangGraph | Official docs cover chains/agents, durable execution, tools, and app workflows. | Kolm should become a node/tool that returns receipts. |
| LlamaIndex | Official docs cover data connectors, RAG, agents, workflows, and observability integrations. | Kolm artifacts can replace repeated RAG sub-decisions or serve as post-retrieval gates. |
| DSPy | Official docs cover programming and optimizing LM pipelines. | Similar "examples to optimized behavior" spirit; Kolm must differentiate on artifact format and proof. |
| Mem0 | Official docs/product pages focus on memory for AI agents and personalization. | Not a core competitor; memory can feed Kolm personalization. |
| Zep | Official docs focus on agent memory and context engineering. | Complementary to compile/update loops. |
| Letta | Official materials focus on long-lived stateful agents and memory. | Different layer: agent state vs signed task contract. |

### On-Device And Local Runtime Substrate

| Player | Source-Backed Position | Kolm Angle |
| --- | --- | --- |
| Apple Core ML | Official docs describe integrating machine learning models into Apple apps. | Target backend for iOS artifacts, not the enemy. |
| Apple Foundation Models | Official docs describe on-device foundation model access in Apple apps. | A major objection to "offline AI"; Kolm must offer proof/governance above Apple's runtime. |
| Google LiteRT | Official docs describe on-device AI runtime for mobile/edge. | Android target backend. |
| ONNX Runtime Mobile | Official docs describe mobile/edge optimized runtime for ONNX models. | Cross-platform backend target. |
| PyTorch ExecuTorch | Official docs describe deploying PyTorch models to edge devices. | Backend target for Specialist artifacts. |
| llama.cpp / MLC / Ollama / LM Studio | Official docs/product pages cover local LLM execution and model management. | Developer distribution channels, not core substitutes for receipts and registry. |

## Positioning Rules

1. Do not say "Kolm is a better gateway." Say "gateways route; Kolm gives them a signed artifact target."
2. Do not say "Kolm is fine-tuning." Say "fine-tuning creates model behavior; Kolm packages, gates, signs, and governs task behavior."
3. Do not say "Kolm replaces Core ML or LiteRT." Say "Kolm emits artifacts for existing runtimes and attaches evals and receipts."
4. Do not say "Kolm is compliance." Say "Kolm produces audit evidence: receipts, eval hashes, artifact provenance, and verifier outputs."
5. Do not sell "local forever" until the artifact contains or resolves to real local runtime assets for the target platform.

## Top Integration Backlog

| Priority | Integration | Proof Target |
| --- | --- | --- |
| P0 | LiteLLM adapter | Repeat classifier routed to `.kolm` with fallback and savings receipt. |
| P0 | Langfuse import | Trace dataset becomes eval set and `.kolm` artifact. |
| P0 | MCP server path | Agent can search, run, and verify a Kolm artifact as a tool. |
| P1 | Braintrust eval import | Existing eval suite becomes K-score gate. |
| P1 | Vercel AI SDK middleware | Artifact-first routing in a Next.js app. |
| P1 | Sigstore/Rekor receipt anchoring | Public verifier can show transparency-log proof. |
| P1 | Core ML/LiteRT target matrix | One tiny artifact or documented bridge per platform. |

