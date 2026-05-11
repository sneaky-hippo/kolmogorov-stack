# Source Register

Research pass: 2026-05-12

This register records primary sources used in the first knowledge-base pass. Source pages can change; refresh monthly or before fundraising, launch, enterprise sales, or public claims.

## Kolm Sources

| Ref | URL / File | Type | Used For |
| --- | --- | --- | --- |
| kolm-live-home | https://kolm.ai/ | Live site | Public positioning and artifact claims. |
| kolm-live-pricing | https://kolm.ai/pricing | Live site | Pricing, stale brand/package, savings, enterprise claims. |
| kolm-live-docs | https://kolm.ai/docs | Live site | API documentation, endpoint count, SDK package names. |
| kolm-live-device | https://kolm.ai/device | Live site | On-device recipe-registry demo and offline PWA claims. |
| README.md | `README.md` | Repo file | Current status, caveats, architecture, API surface, product gates. |
| STRATEGY.md | `STRATEGY.md` | Repo file | Spec-layer thesis and roadmap framing. |
| SOTA | `docs/SOTA-2026-05-11.md` | Repo file | Current product/strategy map and 90-day plan. |
| infra-report | `docs/kolm-infra-business-strategy-report-2026-05-06.md` | Repo file | Prior infrastructure, business, GTM, and competitor critique. |
| artifact-code | `src/artifact.js` | Repo file | Artifact internals, K-score, receipt implementation, pointer model. |
| compile-code | `src/compile.js` | Repo file | Current compile pipeline and roadmap caveats. |
| store-code | `src/store.js` | Repo file | JSON/SQLite storage implementation. |
| verifier-code | `src/verifier.js` | Repo file | Recipe sandbox and verifier implementation. |
| router-code | `src/router.js` | Repo file | API routes, receipts, specialists, product endpoints. |

## Gateways And Routers

| Ref | URL | Used For |
| --- | --- | --- |
| portkey-docs | https://portkey.ai/docs/product/ai-gateway | Portkey gateway capabilities. |
| portkey-series-a | https://portkey.ai/blog/series-a-funding | Market traction and positioning context. |
| litellm-docs | https://docs.litellm.ai/docs/ | LiteLLM proxy/router, keys, budgets, fallback context. |
| cloudflare-ai-gateway-docs | https://developers.cloudflare.com/ai-gateway/features/ | Cloudflare AI Gateway capabilities. |
| vercel-ai-gateway-docs | https://vercel.com/docs/ai-gateway/capabilities | Vercel AI Gateway capabilities. |
| openrouter-docs | https://openrouter.ai/docs/model-routing | OpenRouter model routing and fallback context. |

## Observability, Evals, And Prompt Ops

| Ref | URL | Used For |
| --- | --- | --- |
| langsmith-docs | https://docs.langchain.com/langsmith/ | LangSmith observability, evals, prompts, datasets. |
| langgraph-durable | https://docs.langchain.com/oss/python/langgraph/durable-execution | LangGraph durable execution context. |
| langfuse-docs | https://langfuse.com/docs | Langfuse observability, prompt management, evals. |
| braintrust-docs | https://www.braintrust.dev/docs/evaluate | Braintrust evals and experiments. |
| braintrust-series-a | https://www.braintrust.dev/blog/announcing-series-a | Market traction and positioning context. |
| helicone-docs | https://docs.helicone.ai/ | Helicone observability/gateway source. |
| promptlayer-docs | https://docs.promptlayer.com/ | Prompt management, registry, logs, evals. |
| humanloop-docs | https://humanloop.com/docs | Prompt/eval workflow context. |
| vellum-docs | https://docs.vellum.ai/ | Workflow/prompt/eval platform context. |
| phoenix-docs | https://arize.com/docs/phoenix | Arize Phoenix observability/eval context. |
| weave-docs | https://weave-docs.wandb.ai/ | W&B Weave tracing/eval context. |

## Fine-Tuning And Model Customization

| Ref | URL | Used For |
| --- | --- | --- |
| predibase-docs | https://docs.predibase.com/ | Predibase fine-tuning and deployment context. |
| predibase-platform | https://predibase.com/platform | Product positioning for fine-tuning and inference. |
| openpipe-docs | https://docs.openpipe.ai/ | OpenPipe fine-tuning/eval workflow context. |
| together-finetune-docs | https://docs.together.ai/docs/fine-tuning-overview | Together fine-tuning context. |
| openai-finetune-docs | https://platform.openai.com/docs/guides/fine-tuning | OpenAI fine-tuning context. |
| hf-autotrain-docs | https://huggingface.co/docs/autotrain/index | Hugging Face AutoTrain context. |

## RAG, Memory, Agents, And Optimization

| Ref | URL | Used For |
| --- | --- | --- |
| llamaindex-docs | https://docs.llamaindex.ai/ | RAG/agent/data framework context. |
| dspy-docs | https://dspy.ai/ | LM program optimization context. |
| mem0-docs | https://docs.mem0.ai/ | AI memory platform context. |
| zep-docs | https://help.getzep.com/ | Agent memory context. |
| letta-docs | https://docs.letta.com/ | Stateful agent/memory context. |
| haystack-docs | https://docs.haystack.deepset.ai/ | RAG/orchestration context. |

## Local And On-Device Runtime Substrate

| Ref | URL | Used For |
| --- | --- | --- |
| apple-foundation-models | https://developer.apple.com/documentation/FoundationModels | Apple on-device foundation model framework. |
| coreml-docs | https://developer.apple.com/documentation/CoreML | Apple model runtime target. |
| litert-docs | https://ai.google.dev/edge/litert/overview | Google on-device runtime target. |
| onnx-runtime-mobile | https://onnxruntime.ai/docs/tutorials/mobile/ | ONNX Runtime Mobile target. |
| executorch-docs | https://docs.pytorch.org/executorch/stable/intro-overview.html | PyTorch edge runtime target. |
| executorch-site | https://executorch.ai/ | ExecuTorch product context. |
| ollama-docs | https://github.com/ollama/ollama | Local LLM runtime context. |
| llama-cpp | https://github.com/ggml-org/llama.cpp | Local LLM runtime context. |
| mlc-llm-docs | https://llm.mlc.ai/docs/ | MLC local/runtime context. |

## Standards, Protocols, And Regulation

| Ref | URL | Used For |
| --- | --- | --- |
| mcp-docs | https://modelcontextprotocol.io/docs/getting-started/intro | MCP context/tool protocol scope. |
| anthropic-mcp-launch | https://www.anthropic.com/news/model-context-protocol | MCP ecosystem context. |
| openai-structured-outputs | https://platform.openai.com/docs/guides/structured-outputs | Provider-native schema-constrained output context. |
| openai-agents-tracing | https://openai.github.io/openai-agents-python/tracing/ | Agents tracing context. |
| sigstore-docs | https://docs.sigstore.dev/ | Signing/transparency-log analog. |
| rekor-docs | https://docs.sigstore.dev/rekor/overview/ | Transparency log context. |
| eu-ai-act-commission | https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai | EU AI Act official policy context. |
| eu-ai-act-service-desk | https://ai-act-service-desk.ec.europa.eu/en/faq | EU AI Act FAQ context. |

## Market And Macro Sources To Refresh

| Ref | URL | Used For |
| --- | --- | --- |
| gartner-ai-spending-2026 | https://www.gartner.com/en/newsroom/press-releases/2026-1-15-gartner-says-worldwide-ai-spending-will-total-2-point-5-trillion-dollars-in-2026 | AI spending context from prior report. |
| idc-ai-infra | https://www.idc.com/resource-center/blog/ai-infrastructure-spending-caps-historic-year-at-90-billion-in-q4-2025-2029-spending-to-eclipse-1-trillion/ | AI infrastructure spending context from prior report. |
| grandview-edge-ai | https://www.grandviewresearch.com/industry-analysis/edge-ai-software-market-report | Edge AI market sizing context. |
| qualcomm-edge-impulse | https://www.qualcomm.com/news/releases/2025/03/qualcomm-to-bolster-ai-and-iot-capabilities-with-edge-impulse-ac | Edge AI consolidation context. |

## Competitor Evidence Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| portkey-gateway-current | https://portkey.ai/docs/product/ai-gateway | Gateway routing, caching, fallbacks, observability, guardrails, and usage controls. |
| litellm-proxy-current | https://docs.litellm.ai/docs/ | OpenAI-compatible proxy, provider abstraction, virtual keys, budgets, rate limits, and spend controls. |
| cloudflare-ai-gateway-current | https://developers.cloudflare.com/ai-gateway/features/ | AI Gateway analytics, logging, caching, rate limiting, retry, fallback, and provider controls. |
| vercel-ai-gateway-current | https://vercel.com/docs/ai-gateway | Unified provider access, Vercel AI SDK integration, observability, usage, and budgets. |
| openrouter-routing-current | https://openrouter.ai/docs/model-routing | Model routing and fallback behavior. |
| helicone-platform-current | https://docs.helicone.ai/ | AI Gateway, observability, caching, rate limits, prompt management, and security. |
| langsmith-observability-current | https://docs.langchain.com/langsmith/observability | Tracing, monitoring, datasets, evals, and prompt workflows. |
| langfuse-overview-current | https://langfuse.com/docs | Open-source LLM observability, prompts, evals, datasets, metrics, and integrations. |
| braintrust-evaluate-current | https://www.braintrust.dev/docs/evaluate | Datasets, experiments, scoring, and evaluation loops. |
| braintrust-observe-current | https://www.braintrust.dev/docs/guides/observability | Production tracing, logs, monitoring, and feedback workflow. |
| promptlayer-platform-current | https://docs.promptlayer.com/ | Prompt registry, logs, evals, datasets, monitoring, and prompt-management workflows. |
| llamaindex-current | https://docs.llamaindex.ai/ | RAG, agents, workflows, data connectors, indexes, and evaluation tooling. |
| dspy-current | https://dspy.ai/ | LM programming and optimization framework context. |
| mem0-current | https://docs.mem0.ai/ | AI memory API and long-term memory product context. |
| zep-current | https://help.getzep.com/ | Agent memory and temporal knowledge graph context. |
| letta-current | https://docs.letta.com/ | Stateful agent and memory framework context. |
| predibase-finetune-current | https://docs.predibase.com/ | Fine-tuning, adapters, serving, and deployment context. |
| openpipe-current | https://docs.openpipe.ai/ | Trace collection, fine-tuning, evaluation, and deployment context. |
| together-finetune-current | https://docs.together.ai/docs/fine-tuning-overview | Supervised fine-tuning workflow context. |
| hf-autotrain-current | https://huggingface.co/docs/autotrain/index | Automated model training and fine-tuning workflow context. |
| apple-foundation-models-current | https://developer.apple.com/documentation/FoundationModels | Apple on-device foundation model framework. |
| litert-current | https://ai.google.dev/edge/litert/overview | Google AI Edge LiteRT on-device runtime context. |
| executorch-current | https://docs.pytorch.org/executorch/stable/intro-overview.html | PyTorch edge/on-device runtime context. |
| mcp-current | https://modelcontextprotocol.io/docs/getting-started/intro | MCP tool, resource, prompt, and client/server protocol scope. |
| openai-structured-outputs-current | https://platform.openai.com/docs/guides/structured-outputs | JSON Schema constrained output behavior and strict mode. |
| sigstore-rekor-current | https://docs.sigstore.dev/rekor/overview/ | Public transparency log context for verifiable receipts. |
| eu-gpai-code-current | https://digital-strategy.ec.europa.eu/en/policies/contents-code-gpai | EU GPAI code-of-practice and documentation context. |
