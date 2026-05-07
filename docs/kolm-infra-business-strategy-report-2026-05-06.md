# kolm.ai infrastructure and business strategy report

Date: 2026-05-06
Scope: `C:\Users\user\Desktop\kolmogorov-stack`

## Executive summary

kolm should not become another AI gateway, model router, or generic fine-tuning UI. Those markets are already crowded by well-funded companies with distribution: Portkey, LiteLLM, Cloudflare AI Gateway, Vercel AI Gateway, OpenRouter, Helicone, Langfuse, Braintrust, LangSmith, Predibase, Hugging Face, Replicate, Modal, Together, Fireworks, and the provider-native stacks from OpenAI, Anthropic, Google, and Microsoft.

The durable strategy is narrower and more valuable:

> kolm should become the verified AI artifact layer: compile repeatable AI behavior into signed `.kolm` artifacts, run them cheaply and locally, and attach receipts that gateways, agents, auditors, and customers can verify.

The wedge is cost and latency reduction. The category is verifiable AI behavior. The moat is the combination of:

1. A portable artifact format (`.kolm`).
2. A public spec and conformance suite.
3. Signed receipts and audit trails.
4. Deterministic recipe execution for the easiest workloads.
5. Specialist artifacts for the harder workloads.
6. Distribution through gateways, SDKs, agent frameworks, and compliance channels.

The repo already has the right prototype pieces: Express API, synthesis engine, registry, runtime cache, compile pipeline, `.kolm` packager, receipt schemas, static product surfaces, CLI/SDK scaffolds, and docs. It is not yet production infrastructure. The biggest blockers are JSON-file storage, in-memory queues and rate limits, weak sandboxing, dev HMAC receipts while schemas claim Ed25519, no real auth recovery, no billing, no durable artifact storage, no production observability, no complete LoRA pipeline, and no proof-grade conformance/eval harness.

The company-scale roadmap is therefore:

1. First 14 days: stabilize trust. Ship Postgres, object storage, durable compile jobs, real artifact receipts, seed registry, pricing consistency, auth recovery, and public eval examples.
2. First 45 days: ship the gateway/SDK wedge. Observe LLM traffic, identify repeat deterministic workloads, compile them into `.kolm`, route future calls to artifacts, and show dollar savings.
3. First 90 days: ship the enterprise trust layer. Ed25519/KMS signing, audit exports, DPA/BAA/security posture, SOC 2 Type I plan, private registries, and conformance suite.
4. First 180 days: ship Specialists v1. Recipe-to-label-corpus-to-LoRA-to-artifact pipeline with owned weights, deployment targets, and receipts.
5. First 12 months: turn the spec into an ecosystem. Gateway partnerships, MCP/LangGraph/OpenAI Agents integrations, public registry, conformance badge, and marketplace.

A multibillion-dollar outcome is plausible only if kolm owns the standard and distribution path for verified AI behavior, not if it remains a single hosted demo for compiling small classifiers.

## Investor critique incorporated

The strongest external critique is correct: the current site and docs under-answer the obvious question:

> Why use kolm instead of free, mature on-device AI infrastructure from Apple, Google, Microsoft, Meta/PyTorch, or open-source local LLM runtimes?

The answer cannot be "runs offline." Apple Core ML, Apple's Foundation Models framework, Google LiteRT, ONNX Runtime Mobile, ExecuTorch, llama.cpp, and MLC LLM can all claim some version of local/offline/private execution. The answer has to be:

> kolm is not the runtime. kolm is the compliance-grade compiler, artifact registry, and receipt layer above runtimes.

That means the near-term positioning should change:

1. Lead with regulated data staying on-device, not abstract AI compilation.
2. Pick one initial ICP, not "all developers."
3. Publish team/company legitimacy signals.
4. Get named design partners.
5. Publish benchmarks against free runtimes.
6. Make the business model explicit: what is free, what is paid, and why.

### Revised initial ICP

Pick one beachhead:

> Regulated mobile health and care apps that want AI features without sending PHI to cloud inference.

Why this ICP:

1. Pain is acute: HIPAA, privacy reviews, clinical/legal risk, user trust.
2. Mobile/on-device matters: health data is often generated on-device.
3. Enterprise willingness to pay is real.
4. Apple/Google free runtimes do not produce cross-platform signed artifacts, registry provenance, or audit receipts out of the box.
5. The demo can be concrete: symptom intake classifier, appointment triage, medication instruction simplifier, offline care-plan Q&A, PHI redaction, claims/document routing.

Fintech is the second vertical. Enterprise mobile is the horizontal expansion after healthcare proof.

### Homepage positioning rewrite

Current broad line:

> Ship private AI on every device.

Better healthcare wedge:

> Ship AI features without sending health data to the cloud.

Support copy:

> kolm compiles a task into a signed on-device artifact with an auditable receipt. Your app runs it on iOS, Android, web, or server. PHI stays local. Legal gets a verification trail.

This is sharper because it names the buyer pain, the privacy guarantee, and the compliance artifact.

### Business model clarity

The product should be described as three paid products plus a free open SDK:

| Product | Buyer pays for | Why it is worth paying |
| --- | --- | --- |
| Open SDK/runtime | Free, MIT/Apache-style | Developer adoption, local verification, trust. |
| Hosted compiler | Compile credits, training jobs, artifact packaging | Saves ML expertise and infrastructure. |
| Private registry and receipts | Private artifacts, receipt retention, audit export, org controls | Compliance, provenance, team workflow. |
| Enterprise compliance | SSO, DPA/BAA, VPC/on-prem, KMS keys, support | Procurement and regulated deployment. |

The paid product is not "run this free SDK." It is "produce, govern, sign, store, audit, and update AI artifacts safely."

### 30-day investor-readiness fixes

| Gap | Fix | Acceptance test |
| --- | --- | --- |
| Anonymous company | Publish founder/team page, LinkedIn company, Crunchbase profile, GitHub org. | Search result and LinkedIn/CBS profiles exist; homepage has accountable company identity. |
| No traction | Recruit 5 named design partners in healthcare/fintech/mobile enterprise. | Logos or named quotes on site, even if unpaid pilots. |
| Vague ICP | Rewrite homepage and deck for regulated mobile healthcare first. | Above-the-fold copy says who it is for and what compliance pain it solves. |
| Weak proof | Publish benchmark page vs Core ML, LiteRT, ONNX Runtime, ExecuTorch, llama.cpp. | Real hardware numbers: latency, package size, accuracy, battery/thermal notes, receipt overhead. |
| Unclear OSS | Public GitHub repo for SDK/spec/conformance suite. | Install, run sample, verify receipt from clean machine. |
| Unclear moat | Explain network effect: more artifacts -> more evals/receipts -> better registry -> lower integration cost. | One diagram on homepage/deck. |
| No enterprise GTM | Create design-partner offer and compliance pilot package. | One-page PDF: 30-day pilot, success metrics, data handling, price. |

## Deep venture readiness addendum

The revised venture score is **5.5/10**, with a credible path to 7+ if the next work proves runtime targets, personalization mechanics, registry value, team credibility, and design-partner traction.

### What is genuinely right

1. **Problem clarity is strong.** The pain is first-order: developers and regulated teams want AI features without sending sensitive user data to cloud inference.
2. **The abstraction layer is the right bet.** Runtime layers are being commoditized by Apple, Google, Microsoft, Meta/PyTorch, Apache TVM, and open-source local LLM projects. The valuable layer is task -> optimized artifact -> SDK call -> receipt.
3. **The tiered artifact model is technically coherent.** Recipe, Adapter, Specialist, and Bundle map to real deployment constraints: KB-scale deterministic logic, LoRA/adapters, self-contained task models, and model-plus-index packages.
4. **K-score can become a trust primitive.** If benchmarked against real workloads and devices, K-score can become a quality gate for artifact publication.
5. **Local personalization is the sharpest product claim.** If `artifact.personalize()` adapts using local data without exfiltration, it is meaningfully different from plain inference runtimes.
6. **Regulation is a tailwind.** HIPAA, GDPR, EU AI Act, and enterprise AI governance make receipts, local processing, and audit exports more valuable.
7. **Free SDK plus paid compiler/registry is plausible.** The open runtime lowers adoption friction; the paid value is compilation, signing, private registry, audit retention, and enterprise support.

### What is still wrong

| Issue | Severity | Why it matters | Required answer |
| --- | --- | --- | --- |
| Runtime dependency is unclear | Existential | If `.kolm` wraps Core ML/LiteRT/ONNX/ExecuTorch, runtime performance is not the moat. | State explicitly: `.kolm` is a wrapper/spec/receipt artifact that targets existing runtimes. Then prove it with exports. |
| No benchmark | Fatal for venture | VCs and developers will compare against Core ML, LiteRT, ONNX Runtime, ExecuTorch, llama.cpp, and cloud API baselines. | Publish latency, memory, size, accuracy, personalization time, battery/thermal, and receipt overhead on real hardware. |
| Compile-time monetization is thin | High | If users compile once and run forever, revenue is one-time unless registry, updates, compliance, or personalization drive recurring value. | Price private registry, receipt retention, updates, hosted compile, personalization events, and enterprise support. |
| Cross-platform claim lacks proof | High | iOS, Android, Web, and Server are not equal. Web and low-end Android are hard. | Ship a platform matrix with verified device classes, limits, and unsupported cases. |
| Personalization is underexplained | High | On-device LoRA training is very different from RAG, preference cache, or prompt profile. Battery/privacy/App Store implications differ. | Publish technical modes: retrieval profile, adapter delta, encrypted local profile, and when each is supported. |
| Registry is buried | High | Pre-built compliance-ready artifacts may be more monetizable than custom compilation. | Make registry a first-class product: "verified artifact marketplace for regulated on-device AI." |
| Compliance claims lack evidence | High | "HIPAA-ready" and "EU AI Act compliant" are liabilities without documentation. | Publish BAA status, DPA, subprocessor list, risk-tier guidance, audit receipt example, and security roadmap. |
| No why-now story | Medium-high | Investors need market timing. | Tie to capable small models, Apple Intelligence normalization, EU AI Act timeline, and Qualcomm/Edge Impulse consolidation. |
| No endgame | Medium-high | The wedge must lead somewhere. | Pick: App Store for verified on-device AI, compliance layer for regulated AI, or acquisition-grade cross-platform compiler. |
| Team credibility absent | High | Deep tech without visible team/history is hard to fund. | Publish founder/team, GitHub, LinkedIn, Crunchbase, technical writeups, and design partners. |

### Benchmark plan required before serious fundraising

Benchmarks must compare kolm against both free runtimes and cloud APIs. Minimum matrix:

| Axis | Required measurement |
| --- | --- |
| Hardware | iPhone with Neural Engine, mid-range Android, low-end Android, Mac/Windows laptop, browser with and without WebGPU. |
| Runtime targets | Core ML, LiteRT, ONNX Runtime, ExecuTorch, llama.cpp/GGUF where relevant, cloud API baseline. |
| Workloads | PHI redaction, medical intake classifier, transaction classifier, entity extraction, support triage, local personalization example. |
| Metrics | p50/p95 latency, cold start, memory, package size, battery/thermal notes, accuracy, K-score, receipt verification latency, compile time. |
| Developer UX | Lines of code, install time, artifact update flow, App Store/Play Store package impact. |

The benchmark headline should not be "kolm is faster than Core ML." It probably will not be. The headline should be:

> Same runtime performance class, but with cross-platform artifact packaging, reproducible evals, registry provenance, local personalization, and receipts.

### Personalization technical specification

The product must stop using `personalize()` as a magic word. Define three modes:

| Mode | What happens | Privacy posture | Device feasibility |
| --- | --- | --- | --- |
| Local retrieval profile | Build encrypted local index or preference profile; artifact reads it at runtime. | Data stays local; easiest to audit. | Works on most devices. |
| Local adapter delta | Train or update a small adapter/LoRA on-device or in private customer environment. | Strong privacy, but compute-heavy. | Only high-end devices or private server initially. |
| Local calibration | Store thresholds, labels, examples, or classifier weights derived from local data. | Strong privacy; deterministic. | Feasible broadly. |

Near-term recommendation: ship retrieval profile and calibration first. Treat gradient-based on-device LoRA as roadmap until benchmarks prove it.

### Registry-first product thesis

The registry may be more valuable than custom compilation. Reframe it as:

> A verified artifact registry for privacy-safe AI tasks.

Healthcare example:

1. `phi-redactor.kolm`
2. `symptom-intake-triage.kolm`
3. `medication-instruction-simplifier.kolm`
4. `care-plan-faq.kolm`
5. `claims-document-router.kolm`

Each registry artifact should show:

1. K-score and eval suite hash.
2. Supported runtime targets.
3. Device class minimums.
4. Receipt JSON.
5. Legal/compliance notes.
6. Integration snippet.
7. Update history.
8. Publisher and signer.

This creates a clearer recurring model than compile-only pricing: private registry, verified updates, compliance-ready artifacts, and marketplace fees.

### Why-now narrative

The timing story should be explicit:

1. Small models crossed practical thresholds in 2024-2026.
2. Apple Foundation Models normalized on-device AI for mainstream developers.
3. Google LiteRT and PyTorch ExecuTorch make cross-device deployment possible but not simple.
4. Qualcomm's Edge Impulse/Arduino/Foundries.io moves show edge AI developer tooling is consolidating.
5. EU AI Act obligations and healthcare/finance privacy reviews increase demand for local processing and audit evidence.
6. Cloud AI cost and latency remain painful for high-volume structured tasks.

### Endgame options

Kolm should choose one primary endgame and one secondary:

| Endgame | What it means | Fit |
| --- | --- | --- |
| App Store for verified on-device AI | Public/private registry, certified artifacts, marketplace, K-score, receipts. | Best long-term platform story. |
| Compliance layer for regulated AI | Healthcare/fintech artifact compiler plus audit receipts and private registry. | Best near-term revenue story. |
| Cross-platform compiler acquisition target | Apple/Qualcomm/Samsung/cloud/security vendor buys compiler/registry. | Plausible strategic outcome if traction exists. |

Recommendation: near-term wedge = compliance layer for healthcare; long-term story = App Store for verified on-device AI.

### Revised venture scoring

| Dimension | Score | Rationale |
| --- | --- | --- |
| Problem clarity | 8/10 | Real, large, well-defined privacy and deployment pain. |
| Solution elegance | 7/10 | Artifact abstraction and tier model are sound. |
| Differentiation/moat | 4/10 | Registry/receipts can become a moat, but runtime dependency and benchmarks are unresolved. |
| Market size and timing | 8/10 | Tailwinds are strong, though TAM depends heavily on definition. |
| Traction/proof | 2/10 | No visible users, logos, GitHub stars, or benchmarks yet. |
| Team credibility | 1/10 | Team/company transparency is currently absent. |
| Business model | 5/10 | Compiler pricing is thin; registry/compliance model is better but underdeveloped. |
| Investor narrative | 3/10 | Needs why-now, endgame, and social proof. |
| Technical depth | 6/10 | Right architecture, but personalization and runtime targets need details. |

Composite: **5.5/10**.

## Current-state evidence from the repo

### What exists

The repo has a serious prototype foundation:

| Area | Evidence | Strategic value |
| --- | --- | --- |
| API and static app | `server.js`, `src/router.js`, `public/*.html` | Working product shell with API routes and website surfaces. |
| Synthesis | `src/synthesis.js`, `src/verifier.js` | Converts examples into deterministic JS functions and gates them by verifier score. |
| Runtime | `src/runtime.js`, `src/cache.js` | Runs published versions with warm compiled cache and output cache. |
| Registry | `src/registry.js`, `data/*.json` | Versioned concept store, public/private visibility, vector-ish search. |
| Compile pipeline | `src/compile.js` | Job stages for recall, distill, decompose, package. |
| Artifact packaging | `src/artifact.js`, `src/artifact-runner.js` | Builds and runs `.kolm` zip artifacts with manifests, recipes, evals, signatures, receipts. |
| Receipts/spec | `docs/manifest-v0.1.json`, `docs/receipt-v0.1.json`, `docs/rs-1.md` | Early RS-1 contract and receipt schema. |
| Auth and quota | `src/auth.js` | API keys, anonymous tenants, claim flow, rate limits, quotas. |
| Product pages | `public/index.html`, `public/compile.html`, `public/registry.html`, `public/security.html` | Current brand has moved toward "AI compiler / signed specialist / .kolm artifact." |
| Prior strategy | `STRATEGY.md`, `STRATEGY-v3.md`, `_audit/*.md` | Good existing thesis: savings wedge plus spec layer. |

### What is prototype-only

These are production blockers, not cosmetic issues:

| Blocker | Evidence | Why it matters |
| --- | --- | --- |
| JSON-file database | `src/store.js` writes one JSON file per table. | Unsafe under concurrent writes, no query model, no migrations, weak tenant isolation. |
| In-memory compile jobs | `src/compile.js` uses `const JOBS = new Map()`. | Jobs are lost on restart and cannot scale across workers. |
| In-memory rate limits | `src/auth.js` uses process-local token buckets. | Multi-instance deployments will overrun limits and quotas. |
| Disk cache | `src/cache.js` writes cache files to `data/cache`. | No cross-region cache, no eviction controls beyond L1, no object-store durability. |
| Node `vm` sandbox | `src/verifier.js` uses `node:vm` and cooperative timeout. | Not enough isolation for untrusted code in production. Needs isolated-vm, Wasmtime, or microVM isolation. |
| HMAC dev receipts | `src/router.js` and `src/artifact.js` use shared HMAC secret defaults. | Schemas claim Ed25519. Production needs per-tenant signing keys, KMS/HSM, and rotation. |
| Receipt schema mismatch | `docs/receipt-v0.1.json` says `signature_alg: ed25519`; code stores HMAC in `signature`. | Third-party verifiers cannot rely on the public spec yet. |
| No durable queue | Compile work runs in process. | Long-running compiles, model calls, retries, and artifact packaging need a queue/orchestrator. |
| No real LoRA pipeline | `src/compile.js` and `src/artifact.js` mark LoRA and model weights as future/pointer-only. | Specialist positioning is not yet backed by training infrastructure. |
| No real identity recovery | API keys and sessions exist, but no password reset, email verification, SSO, orgs/RBAC. | Enterprise and serious self-serve users need account recovery and access control. |
| No billing | Pricing pages exist, but no Stripe/webhook/subscription entitlements. | Cannot monetize beyond manual enterprise sales. |
| No full telemetry platform | `/v1/telemetry` exists, but there is no OpenTelemetry, logs pipeline, traces, SLOs, or alerting. | Cannot operate as production infra or sell trust. |
| Test risk | `tests/e2e.test.js` wipes files in `data/`. | Tests are not safe to run against developer/seed data without isolation. |

## Market facts that matter

The market is large, but crowded:

1. Gartner forecasts worldwide AI spending at about $2.52 trillion in 2026, with AI infrastructure alone at about $1.37 trillion. Source: Gartner, "Worldwide AI Spending Will Total $2.5 Trillion in 2026."
2. IDC reported full-year 2025 AI infrastructure spending at $318 billion and projects $487 billion in 2026, with 2029 exceeding $1 trillion. Source: IDC, "AI Infrastructure Spending Caps Historic Year..."
3. Gartner predicts LLM observability investments will reach 50% of GenAI deployments by 2028, up from 15%. Source: Gartner, "Explainable AI Will Drive LLM Observability Investments..."
4. EU AI Act high-risk and transparency obligations start applying on 2026-08-02, with full rollout by 2027-08-02. Source: European Commission AI Act Service Desk FAQ.
5. The EU AI Act emphasizes logging, traceability, documentation, transparency, human oversight, robustness, cybersecurity, and accuracy for high-risk systems. Source: European Commission AI Act policy page.
6. MCP is now an open standard for connecting AI applications to external systems and has broad ecosystem support across Claude, ChatGPT, VS Code, Cursor, and other clients. Source: modelcontextprotocol.io official docs.
7. OpenAI Structured Outputs guarantees schema adherence through constrained decoding, but it remains model/provider-runtime dependent, not a portable deterministic artifact. Source: OpenAI Structured Outputs docs.
8. Public market estimates vary sharply by definition. Grand View Research estimates global edge AI software at $1.95B in 2024 and $8.91B by 2030, while U.S. on-device AI alone is estimated at $5.82B in 2024. Broader edge AI markets can be much larger because they include hardware, cloud infrastructure, services, and vertical deployments. Do not use a single TAM number without defining the category.
9. Qualcomm announced an agreement to acquire Edge Impulse in March 2025 and later described Edge Impulse as part of a broader IE-IoT expansion with Arduino, Foundries.io, FocusAI, and Augentix. This confirms edge AI developer tooling is strategically important to incumbents and likely to consolidate.
10. OctoML/Apache TVM history proves both opportunity and risk: ML compilation can attract major funding, but general "optimize any model for any hardware" is a hard, crowded systems problem. Kolm should avoid a pure performance-compiler war and own task packaging, compliance, registry, and receipts instead.

Interpretation: the market is no longer "AI demos." It is production governance, cost control, reliability, and auditability. That is why the artifact/receipt/spec layer is the right place for kolm.

## Competitive landscape

### 1. AI gateways and control planes

These companies sit in the path of LLM traffic. They own routing, observability, budgets, and policy.

| Competitor | Strength | Threat to kolm | Where kolm should win |
| --- | --- | --- | --- |
| Portkey | Unified control plane, gateway, governance, observability, reliability, spend controls. Publicly announced $15M Series A in Feb 2026 and claims 500B+ daily tokens, 120M+ daily requests, 24,000+ orgs. | High. It sits exactly where the savings wedge wants to sit. | Do not compete as a gateway. Become the deterministic artifact target Portkey routes to when a workload is compilable. |
| LiteLLM | Open-source unified interface for 100+ LLMs, proxy gateway, virtual keys, budgets, routing, fallbacks, admin UI. | High for developer distribution. | Build a LiteLLM plugin/proxy mode: "route matching clusters to `.kolm` first." |
| Cloudflare AI Gateway | Global edge, caching, logs, rate limits, guardrails, DLP, dynamic routing, provider support. | High at infra layer. | Cloudflare is the ideal runtime/partner. `.kolm` should run in Workers and expose receipts through Cloudflare logs. |
| Vercel AI Gateway | Unified API, observability, usage monitoring, data retention controls. | Medium-high for web app teams. | Ship a Vercel AI SDK middleware that compiles recurring calls and returns receipts. |
| OpenRouter | Model marketplace, routing, fallbacks, provider normalization. | Medium. It is model selection, not artifact verification. | Position `.kolm` as "model: kolm/artifact-id" equivalent for deterministic work. |
| Helicone Gateway | OSS observability plus AI Gateway, provider routing, fallbacks, cache. | Medium-high. It can add replacement features. | Partner/integrate with Helicone clusters, but own artifacts and receipts. |
| Kong AI Gateway / enterprise API gateways | Enterprise distribution and policy controls. | Medium for large accounts. | Treat as channel: `.kolm` verifier and runtime plugin. |

Conclusion: a hosted gateway is a losing frontal assault. The best strategy is to be the target that gateways route to, not the gateway itself.

### 2. Observability, evals, and prompt management

| Competitor | Strength | Threat | Where kolm wins |
| --- | --- | --- | --- |
| Langfuse | Open-source LLM engineering platform: traces, prompts, evals, experiments, human annotation, cost/latency dashboards. | High for developer mindshare. | Langfuse shows production data. kolm should convert repeated traces into artifacts. |
| Braintrust | Strong evals, playgrounds, production monitoring, datasets; $36M Series A in 2024. | High in eval-heavy teams. | Braintrust evaluates prompts; kolm compiles verified behavior and emits receipts. |
| LangSmith | Deep LangChain/LangGraph distribution, tracing/evals. | High for LangGraph users. | Ship a LangGraph node that checks `.kolm` before LLM calls and logs receipts to LangSmith. |
| Helicone | LLM observability and caching; simple OpenAI-compatible setup. | Medium-high. | Use Helicone traces as input clusters. |
| Arize Phoenix, Weights & Biases Weave, WhyLabs, AgentOps, PromptLayer | Observability, tracing, evals, monitoring. | Medium. | They are data sources and partners if kolm owns compile/receipt. |

Conclusion: observability companies see the waste. kolm must become the automated action layer after waste is detected.

### 3. Fine-tuning and model-serving platforms

| Competitor | Strength | Threat | Where kolm wins |
| --- | --- | --- | --- |
| Predibase | LoRA fine-tuning platform, RFT/SFT workflows, model repository, serverless infra. | High for Specialists if kolm only offers "train a LoRA." | kolm must own the upstream: verified examples, label generation, eval receipts, local artifact packaging. |
| Hugging Face AutoTrain / Hub / Inference Endpoints | Distribution, model hosting, open-source gravity. | High. | Publish `.kolm` artifacts to HF, but maintain RS-1 conformance and receipts. |
| Replicate | Simple hosted model execution and marketplace. | Medium. | Replicate is hosted inference; kolm is owned artifact plus verifier. |
| Modal | Developer-friendly serverless compute for AI jobs. | Medium. | Use Modal as a compile backend early; do not try to out-Modal Modal. |
| Baseten, Fireworks, Together, Anyscale, Lambda, RunPod | Model serving and GPU infrastructure. | Medium-high if Specialists require hosted GPUs. | Abstract these as training/serving backends. The product is not GPUs; it is signed behavior contracts. |
| OpenAI/Anthropic/Google fine-tuning | Provider-native and convenient. | High for simple hosted fine-tunes. | They cannot credibly sell "own this model and reduce calls to us" as the main incentive. kolm can. |

Conclusion: Specialists must be positioned as owned, verifiable artifacts produced from specs, not as another fine-tuning UI.

### 4. Agent frameworks and protocols

| Competitor | Strength | Threat | Where kolm wins |
| --- | --- | --- | --- |
| MCP | Open protocol for connecting AI apps to tools/data; broad support. | Strategic. MCP may own integration standard. | Do not compete. Make `.kolm` artifacts first-class MCP tools with receipts. |
| OpenAI Agents SDK | Agents, handoffs, guardrails, tracing. | High for OpenAI-first teams. | Provide an Agents SDK processor/tool that checks artifact registry before model calls. |
| LangGraph | Durable execution, checkpoints, replay, human-in-loop. | High in production agents. | Recipes are deterministic graph nodes with receipts; LangGraph should call them. |
| LlamaIndex | RAG/data framework distribution. | Medium. | Use `.kolm` for post-retrieval classification/extraction/routing. |
| CrewAI / AutoGen / Semantic Kernel / Google ADK / PydanticAI / Vercel AI SDK | Agent orchestration and app dev. | Medium. | Provide small adapters and recipes as tools; do not build a general agent framework. |

Conclusion: agents need contracts. kolm should be the behavior contract and receipt layer inside existing frameworks.

### 5. Structured output, guardrails, and verification

| Competitor | Strength | Threat | Where kolm wins |
| --- | --- | --- | --- |
| OpenAI Structured Outputs | Reliable schema adherence through constrained decoding. | High for "valid JSON" use cases. | It guarantees shape, not deterministic behavior ownership or portable receipts. |
| Instructor / PydanticAI / Outlines / Guidance / Guardrails AI | Structured output, validation, constrained generation. | Medium-high for developer tasks. | These validate LLM outputs. kolm replaces repeat calls with verified executable artifacts. |
| Portkey/Cloudflare guardrails | Runtime policy checks and moderation. | Medium. | kolm can compile guardrails into local deterministic checks and attach receipts. |
| DSPy | Optimizes prompts/programs from examples. | Medium. | DSPy stays model-centric; kolm should output portable artifacts and signed receipts. |

Conclusion: structured-output tools reduce failure. kolm must eliminate or verify repeat behavior.

### 6. Edge, local, and on-device AI

| Competitor | Strength | Threat | Where kolm wins |
| --- | --- | --- | --- |
| Apple Foundation Models / Core ML | Native Apple runtime, on-device LLM access, structured generation, tool calling, Neural Engine optimization, free to Apple developers. | Very high for iOS. | Do not claim "offline AI" as differentiation. Claim cross-platform signed artifact, compliance receipts, registry, and healthcare/enterprise evidence. Export to Core ML where useful. |
| Google LiteRT / AI Edge | Mature on-device framework across Android, iOS, embedded, microcontrollers; optimized latency/privacy/connectivity/size/power story. | Very high. | Do not replace LiteRT. Generate/verifiably package artifacts that can target LiteRT. |
| ONNX Runtime Mobile/Web | Framework-agnostic runtime across OS/hardware, strong Microsoft ecosystem. | High for custom model portability. | Use ONNX as an export/runtime target. kolm adds artifact governance, receipts, registry, and task compilation. |
| ExecuTorch | PyTorch-native edge deployment, Meta-backed, hardware partners, AOT compilation, mobile/embedded reach. | High for PyTorch teams. | Treat ExecuTorch as backend for specialists; kolm owns compliance/eval/receipt layer above it. |
| MediaPipe / Google AI Edge perception stack | Strong real-time perception and mobile ML demos. | Medium-high for vision/audio use cases. | Avoid perception-first wedge until `.kolm` can package multimodal artifacts with receipts. |
| Ollama / LM Studio | Local model running and distribution. | Medium. | They run models; kolm defines and verifies task behavior. |
| llama.cpp / GGML / MLX / MLC LLM | Open-source local LLM runtimes and de facto quantized model formats. | Medium-high for "run local LLM" narrative. | Use as execution targets. Do not fight the runtime layer. |
| Qualcomm AI Hub / Edge Impulse | Edge deployment and hardware optimization. | Medium. | Partner or export targets. |
| Cloudflare Workers / Vercel Edge / Deno / Bun | Edge runtime distribution. | Medium. | `.kolm` recipe tier should run natively here. |

Conclusion: "run anywhere" only wins if backed by real SDKs, artifacts, receipts, and device demos.

The strategic answer to free runtimes:

| Free runtime question | kolm answer |
| --- | --- |
| "Why not Core ML?" | Core ML is the Apple execution backend. kolm is the cross-platform compile, registry, eval, and receipt layer. For iOS, kolm should export to Core ML or call Foundation Models when that is the right target. |
| "Why not LiteRT?" | LiteRT is a runtime. It does not recruit examples, produce a task artifact, maintain a private registry, sign receipts, or provide compliance exports by itself. |
| "Why not ONNX?" | ONNX gives model portability. kolm gives behavior provenance and auditability. ONNX can be inside a `.kolm` artifact. |
| "Why not ExecuTorch?" | ExecuTorch is best for PyTorch deployment. kolm should target it for Specialists while owning K-score/evals/receipts. |
| "Why not llama.cpp?" | llama.cpp runs LLMs locally. kolm decides what repeat behavior should become an artifact and proves what ran. |

### 7. AI security and compliance

| Competitor | Strength | Threat | Where kolm wins |
| --- | --- | --- | --- |
| Vanta / Drata / Secureframe | Compliance workflows and evidence collection. | Medium. | Integrate receipts as AI evidence artifacts. |
| Lakera / Protect AI / HiddenLayer / Robust Intelligence / CalypsoAI | AI security testing, guardrails, model security. | Medium. | They secure AI systems; kolm proves deterministic behavior. |
| Sigstore / Cosign / SLSA / in-toto | Supply-chain signing and provenance. | Strategic, mostly partner. | Adopt their patterns. Do not invent a weak signing standard. |

Conclusion: receipts become valuable when auditors can replay or verify them. Build for evidence export.

## Positioning recommendation

Current positioning has three competing stories:

1. "Recipe": examples into deterministic functions.
2. "kolm": compile a signed specialist that runs offline.
3. "RS-1": spec layer and receipts for AI behavior.

The strongest unified story:

> kolm compiles repeatable AI behavior into signed artifacts you can run, route, and audit anywhere.

Use one noun ladder:

| Term | Meaning | Use |
| --- | --- | --- |
| `.kolm artifact` | The file/package. | Primary product noun. |
| Recipe | KB-scale deterministic code artifact. | Technical tier only. |
| Adapter | Small LoRA/delta plus recipe pack. | Technical tier. |
| Specialist | Self-contained task model/artifact. | Premium tier. |
| Bundle | Specialist plus portable index/data. | Enterprise/offline tier. |
| Receipt | Signed proof of compile/run/eval. | Trust/compliance noun. |
| RS-1 | Open spec/conformance contract. | Developer/ecosystem noun. |

Do not use "Recipe" as the consumer-facing brand. It creates drift with the current `.kolm` specialist strategy.

## Product strategy

### Ideal customer profile, in order

1. Regulated mobile healthcare and care-delivery teams handling PHI and blocked by cloud inference reviews.
2. Fintech mobile and web teams handling PII, transaction data, fraud/risk workflows, and audit requirements.
3. Enterprise mobile teams whose legal/security teams prohibit cloud AI for sensitive workflows.
4. AI-native SaaS companies with $5k-$250k/month LLM spend and repeated structured calls.
5. Agent/product teams already using Langfuse, Braintrust, Helicone, LiteLLM, Portkey, or LangGraph.

Do not start with generic consumers. Do not lead with "compile any AI." Start with teams that already feel pain in cost, latency, reliability, or audit.

### The wedge product

Ship "kolm Autopilot" as an SDK and gateway plugin:

1. Observe LLM traffic.
2. Cluster repeated small tasks.
3. Estimate savings and latency reduction.
4. Compile candidate `.kolm` artifacts.
5. Run evals and produce a receipt.
6. Route future matching calls to artifact first.
7. Fall back to the original model when confidence or coverage is low.
8. Show a weekly receipt: dollars saved, calls avoided, latency reduced, artifacts created, failed clusters rejected.

This is how kolm lands. The buyer does not need to understand RS-1 on day one. They need to see "we avoided 18,240 Claude calls and saved $642 this week."

For the healthcare beachhead, the wedge product should be "Compliance Compiler":

1. Developer uploads task description, seed examples, and evals.
2. kolm compiles a signed artifact.
3. Artifact runs on the user's device or customer VPC.
4. Receipt proves artifact hash, eval hash, score, signer, and timestamp.
5. Compliance/legal can export an evidence bundle.

Savings matters later. The first healthcare sale is privacy and auditability.

### The durable product

After the wedge, sell the trust layer:

1. Private artifact registry.
2. Signed compile receipts.
3. Signed run receipts.
4. Conformance test suite.
5. Audit exports for SOC 2, EU AI Act, HIPAA/BAA workflows.
6. Per-tenant signing keys and retention.
7. On-prem or VPC runtime for enterprise.

### The expansion product

Specialists:

1. Compile a deterministic recipe where possible.
2. Use recipe/verifier to label a corpus.
3. Train LoRA/adapters for fuzzy work.
4. Package owned weights/deltas into `.kolm`.
5. Produce receipts and eval harness.
6. Run on cloud, edge, or device.

Specialists are the path to a larger ACV. But selling them before the artifact/receipt/eval loop is real will look like vapor.

## Infrastructure target architecture

### Immediate production architecture

Replace prototype foundations with this:

| Layer | Recommendation |
| --- | --- |
| Edge/CDN/WAF | Cloudflare in front of API and static assets. WAF, DDoS, bot protection, rate limiting. |
| API service | Keep Express short-term, migrate to TypeScript and modular services. Containerized, stateless. |
| Database | Postgres with migrations. Tables for tenants, users, orgs, keys, artifacts, receipts, evals, jobs, invocations, observations, billing. |
| Cache/rate limits | Redis/Upstash/Valkey for rate limiting, idempotency keys, compile locks, hot metadata. |
| Queue | BullMQ/Redis or Temporal. Temporal is better for compile pipeline durability, retries, and stage history. |
| Object storage | S3/R2 for `.kolm` artifacts, receipts, eval sets, logs, and export bundles. |
| Search/vector | Postgres pgvector to start. Move to dedicated vector/search only after scale. |
| Sandbox | `isolated-vm` for JS recipe execution short-term; Wasmtime for WASM; Firecracker/microVM for untrusted heavy compile jobs. |
| Signing | Ed25519 per tenant or per registry signer, keys in KMS/HSM, public key registry, key rotation. |
| Observability | OpenTelemetry traces, structured logs, metrics, Sentry, uptime checks, alerting, SLO dashboards. |
| Billing | Stripe checkout, subscriptions, metered usage, credits, webhooks, entitlements. |
| Auth | Email/password, magic link, OAuth, recovery, orgs, RBAC, SSO/SAML for enterprise, hashed API keys. |
| CI/CD | GitHub Actions or equivalent: lint, tests, schema validation, SBOM, dependency scan, Docker build, staging deploy, canary prod. |
| Compliance | Audit logs, DPA/BAA templates, subprocessor list, retention controls, export/delete APIs, data residency plan. |

### Data model outline

Minimum Postgres tables:

| Table | Purpose |
| --- | --- |
| `users` | Human identity and recovery. |
| `orgs` | Billing/security boundary. |
| `org_members` | Roles and permissions. |
| `api_keys` | Hashed keys, scopes, last used, rotation. |
| `tenants` | Runtime namespace, plan, quotas. |
| `artifacts` | `.kolm` artifact metadata, hash, tier, status, owner. |
| `artifact_versions` | Immutable version rows and storage URIs. |
| `receipts` | Compile/run/eval receipt metadata, signature, hash, storage URI. |
| `eval_sets` | Canonical eval cases and hashes. |
| `compile_jobs` | Durable job state, stages, retries, errors. |
| `observations` | LLM traffic observations with redaction and retention. |
| `clusters` | Repeat workload clusters and savings estimates. |
| `routes` | Mapping from cluster signatures to artifacts and fallback model. |
| `invocations` | Artifact/model calls, latency, cache, cost, receipt pointer. |
| `billing_events` | Metered events and Stripe sync. |
| `audit_events` | Security and admin evidence. |

### Security hardening

Highest-priority fixes:

1. Stop using default HMAC secrets for receipts.
2. Align `docs/receipt-v0.1.json` with actual code or implement Ed25519 immediately.
3. Hash API keys at rest. Never store raw keys after creation.
4. Replace Node `vm` with stronger isolation.
5. Add per-request idempotency keys for compile and billing endpoints.
6. Add tenant/org-level authorization checks to every artifact and receipt path.
7. Add CSRF protection or same-site strategy for cookie-authenticated browser mutations.
8. Remove inline scripts and tighten CSP.
9. Add dependency scanning and SBOM generation.
10. Add public security page with vulnerability disclosure and contact.

### Reliability targets

Phase 1 SLOs:

| Surface | Target |
| --- | --- |
| Public website | 99.9% monthly uptime. |
| `/v1/run` recipe tier | p95 < 20 ms server-side for cached/compiled recipes. |
| `/v1/compile` job creation | p95 < 500 ms to accepted job. |
| Compile completion | 95% of recipe-tier jobs complete < 60 s. |
| Receipt verification | p95 < 100 ms. |
| Data durability | No acknowledged compile artifact can be lost. |

## Missing product work

### Must fix before serious launch

1. One pricing model across homepage and pricing page.
2. One product vocabulary across docs, onboarding, playground, registry, and CLI.
3. Registry seeded with real artifacts and real receipts, not just UI examples.
4. Public receipt example with "copy JSON, verify" workflow.
5. K-score page with formula, eval examples, limitations, and reproducible command.
6. Auth recovery: email verify, password/magic link, key rotation, lost-key path.
7. Billing and entitlements.
8. Dashboard empty state that guides to compile or connect SDK.
9. SDK package naming cleanup: one canonical CLI, one TS SDK, one Python SDK.
10. Public docs for CLI config, env vars, self-host base URL, and artifact verification.
11. Runtime target matrix: what works today on iOS, Android, web, server, and which backend executes it.
12. `artifact.personalize()` technical note with supported modes, limitations, storage model, encryption model, and battery/compute expectations.
13. Benchmark harness and public benchmark page against Core ML, LiteRT, ONNX Runtime, ExecuTorch, and cloud API baseline.

### Must fix before enterprise

1. DPA, BAA template, subprocessor list.
2. Security architecture page with concrete controls and current limitations.
3. Audit logs and export.
4. SSO/SAML, org roles, scoped API keys.
5. Private registry.
6. VPC/on-prem deployment doc.
7. Data retention controls and deletion/export APIs.
8. Regional deployment plan.
9. SOC 2 Type I timeline and evidence collection.
10. Base-model provenance and licensing documentation.

### Must fix before claiming "on-device"

1. Actual iOS, Android, web, and server artifact runners.
2. Artifact size budgets by device class.
3. Swift/Kotlin/React Native/Flutter story or clear roadmap.
4. Real PWA/mobile demo.
5. Offline verification demo.
6. Model weight/delta packaging, not pointer-only artifacts.

## Business model

### Recommended pricing

Keep pricing simple:

| Tier | Price | What it sells |
| --- | --- | --- |
| Free | $0 | Public artifacts, 1 private artifact, 10k runs/mo, public receipts. |
| Pro | $49/mo | Private artifacts, more compile credits, local runners, basic registry. |
| Team | $499/mo | Org, seats, private registry, SDK autopilot, artifact routes, receipt retention. |
| Scale | $2k+/mo + usage | Higher limits, SSO, audit logs, dedicated compile capacity, support. |
| Enterprise | Custom | VPC/on-prem, DPA/BAA, compliance pack, custom retention, private signing keys. |
| Savings add-on | 5-10% of verified savings, optional | Only for teams using Autopilot to replace existing LLM calls. |
| Marketplace | 10-20% take rate | Commercial artifact/specialist sales later. |

Do not force savings-based pricing as the only model. It is a good wedge, but it caps upside and creates measurement fights. Use it as an add-on or pilot guarantee.

For the regulated-healthcare wedge, price the pilot and enterprise path explicitly:

| Offer | Price | Purpose |
| --- | --- | --- |
| Design partner pilot | Free to $5k | Trade discount for named quote, benchmark permission, and case study. |
| Compliance pilot | $10k-$25k | One workflow, one artifact, receipt evidence pack, security review support. |
| Production Team | $499-$2k/mo | Private registry, receipt retention, org controls, compile credits. |
| Enterprise | $50k-$150k ACV | BAA/DPA, SSO, audit exports, VPC/on-prem, KMS keys, support SLA. |

This resolves the free-SDK tension: developers can run artifacts for free, but companies pay to compile, govern, sign, store, audit, and support production artifacts.

### Revenue lines

1. Hosted compile and registry subscription.
2. Autopilot savings replacement.
3. Verify/compliance tier with receipt retention and audit exports.
4. Specialist training fees.
5. Private registry and enterprise support.
6. Runtime distribution through gateways and edge partners.
7. Marketplace take rate.
8. Usage-based personalization or managed-update events, not raw local inference. Charging per on-device run undermines the "run locally forever" promise; charging for signed updates, private registry access, managed personalization policies, and receipt retention aligns better with value.

The key pricing rule:

> Keep local runtime free. Monetize artifact creation, artifact governance, artifact updates, private distribution, personalization management, and audit evidence.

### North-star metrics

Use metrics tied to the unique thesis:

1. Verified artifact runs per week.
2. Frontier model calls avoided.
3. Dollars saved by routed artifacts.
4. Number of artifacts with third-party-verifiable receipts.
5. Artifact reuse rate across teams.
6. Private registry retention.
7. Compile-to-production conversion rate.

Avoid vanity metrics like total signups unless they map to artifacts deployed.

## GTM plan

### First 10 lighthouse customers

Target teams with regulated on-device or private-runtime pressure first:

1. Mobile health apps with PHI-sensitive intake, triage, care-plan, medication, or coaching flows.
2. Healthcare admin workflow vendors that want offline PHI-safe classification or redaction.
3. Fintech mobile teams with PII-sensitive transaction classification, fraud triage, or KYC document routing.
4. Enterprise mobile apps with legal/security blockers on cloud AI.
5. Legal/contract extraction tools that need audit receipts.
6. AI customer support products only when repeated traffic and savings are obvious.
7. Agentic coding/devtool companies only for the later gateway/autopilot wedge.

Offer:

1. 30-day design-partner pilot.
2. One signed artifact for a real workflow.
3. One receipt/eval evidence pack legal can inspect.
4. One on-device or VPC deployment path.
5. Benchmarks against the customer's default stack: Core ML, LiteRT, ONNX, or direct cloud API.
6. Optional traffic audit and savings report if they already have LLM traffic.
7. Convert to Team/Scale/Enterprise if privacy, audit, latency, or savings target is met.

Design partner criteria:

1. Named logo or quote allowed.
2. Real production or near-production workflow.
3. Clear data-sensitivity reason for not using cloud-only AI.
4. Measurable target: latency, cloud calls avoided, PHI kept local, audit evidence accepted, or workflow shipped.
5. A buyer who can become a paid customer within 90 days.

### Distribution channels

1. LiteLLM plugin.
2. Portkey integration/app.
3. Langfuse/Braintrust export-to-kolm flow.
4. LangGraph node.
5. OpenAI Agents SDK tracing processor/tool.
6. MCP server for artifact search/run/verify.
7. Vercel AI SDK middleware.
8. Cloudflare Worker runtime.
9. CLI one-liner and GitHub Action.
10. Public registry and benchmarks.

### Content that can sell

1. "We replaced 63% of repeat LLM classifier calls with signed artifacts."
2. "A `.kolm` receipt you can verify offline."
3. "Portkey/LiteLLM/Cloudflare route: model first vs artifact first."
4. "K-score explained with a reproducible eval harness."
5. "EU AI Act evidence pack for small AI decisions."
6. "Compile once, run on Workers/iOS/server with the same receipt."

## Roadmap

### P0: 0-14 days, make it credible

| Work | Owner area | Acceptance test |
| --- | --- | --- |
| Publish company legitimacy signals | GTM | LinkedIn company, Crunchbase profile, GitHub org, founder/team page, contact emails. |
| Recruit first 5 design partners | GTM | Healthcare/fintech/enterprise mobile targets identified, outreach sent, pilot offer accepted by at least 2. |
| Rewrite homepage for healthcare privacy wedge | Product | Hero names PHI/on-device/compliance pain; one ICP; one CTA. |
| Public benchmark plan | Product/Eng | Benchmark matrix and harness defined for Core ML, LiteRT, ONNX Runtime, ExecuTorch, and cloud API baseline. |
| Publish runtime-target truth table | Product/Eng | iOS, Android, Web, Server each marked as supported/beta/planned with backend, limits, and sample artifact. |
| Publish personalization technical note | Product/Eng | `personalize()` documented as retrieval profile, local calibration, or adapter delta; no magic claims. |
| Move data from JSON files to Postgres | Infra | All current API routes pass against Postgres; migrations checked in. |
| Move artifacts/receipts to S3/R2 | Infra | Compile artifact survives restart and can be downloaded by signed URL. |
| Add durable queue for compile jobs | Infra | Kill API process mid-compile; worker resumes or marks failed with retry state. |
| Implement Ed25519 receipts or update schema honestly | Security | `receipt-v0.1.json` validates actual receipts; verifier passes on real sample. |
| Replace Node `vm` for untrusted execution | Security | Malicious infinite-loop and prototype-pollution tests fail safely. |
| Seed registry with 8 real artifacts | Product | `/registry` cards backed by API rows, each has receipt and eval set. |
| Fix pricing and terminology | Product | No "Recipe" consumer-brand drift; one pricing table. |
| Auth recovery and key hashing | Product/Security | Lost-key path works; DB stores key hashes only. |
| Public K-score/eval proof | Trust | `kolm eval sample.kolm` reproduces score. |
| CI test isolation | Eng | Tests run without wiping real `data/`; CI green from clean checkout. |

### P1: 15-45 days, ship the wedge

| Work | Acceptance test |
| --- | --- |
| SDK traffic observer for OpenAI/Anthropic clients | A sample app logs calls, costs, latency, and redacted prompts. |
| Cluster suggestions | Dashboard shows repeat clusters and estimated savings. |
| One-click compile from cluster | Cluster becomes artifact with eval receipt. |
| Artifact-first routing | SDK routes future matching calls to `.kolm`, with fallback to original LLM. |
| Savings receipt | Weekly report shows avoided calls, dollars, p50 latency change, fallback rate. |
| LiteLLM adapter | LiteLLM config can call kolm before model fallback. |
| Langfuse/Braintrust import | Exported traces can seed clusters. |
| Billing v1 | Stripe subscription and compile/run entitlements enforced. |

### P2: 46-90 days, sell trust

| Work | Acceptance test |
| --- | --- |
| Private registry | Org-scoped artifact registry with RBAC. |
| Receipt ledger | Search, export, retention, delete policies. |
| Compliance pack | DPA, BAA, subprocessor list, security controls, audit export. |
| SSO/SAML | Enterprise org can require SSO. |
| KMS-backed signing | Signer key rotation and public key lookup work. |
| Conformance suite | External runtime can run RS-1 tests and earn badge. |
| Cloudflare Worker runtime | Recipe-tier artifact runs at edge with receipt. |
| Case studies | 3 named or anonymized pilots with real savings and latency numbers. |

### P3: 91-180 days, ship Specialists

| Work | Acceptance test |
| --- | --- |
| Label-corpus pipeline | Artifact/verifier labels corpus with audit trail. |
| LoRA training backend | Train adapter on Modal/RunPod/Baseten or own queue. |
| Specialist packaging | `.kolm` contains actual adapter/weights or verifiable pointer with license/hash. |
| Local runners | Server and at least one device/web runner execute specialist. |
| Eval harness | Holdout evals, regression gates, and receipts for every specialist. |
| Marketplace beta | Public/commercial artifact listings with install/verify. |

### P4: 6-12 months, create the category

| Work | Goal |
| --- | --- |
| RS-1 foundation/governance | Avoid "company-owned fake standard" perception. |
| Gateway partnerships | Make artifact-first routing a default option. |
| Multi-language SDKs | JS, Python, Swift, Kotlin, Rust/WASM. |
| Enterprise deployments | 5-10 Scale/Enterprise customers. |
| Public benchmarks | Standard repeat-call replacement benchmark. |
| Marketplace | Registry network effect and revenue share. |

## Multibillion-dollar path

The credible path is not "be a better model." It is "own the verified behavior layer."

### Year 1

Goal: prove wedge and trust.

1. 100 Team customers at $499/mo = about $600k ARR.
2. 20 Scale customers at $2k-$10k/mo = $500k-$2.4M ARR.
3. 3 enterprise pilots at $50k-$150k ACV = $150k-$450k ARR.
4. Public evidence: $1M+ annualized customer LLM spend replaced or governed.

### Year 2

Goal: platform expansion.

1. 1,000 Team customers = about $6M ARR.
2. 100 Scale customers average $4k/mo = about $4.8M ARR.
3. 20 Enterprise customers average $100k ACV = $2M ARR.
4. Specialist training and registry usage = $2M-$5M ARR.
5. Total target: $15M-$25M ARR.

### Year 3

Goal: category proof.

1. Gateways and observability integrations become major channels.
2. Receipts/compliance tier creates enterprise ACV.
3. Private registries and Specialists expand accounts.
4. Target: $50M-$100M ARR with high gross margin.

### Valuation logic

A multibillion-dollar valuation requires at least one of:

1. $100M+ ARR with strong growth and retention.
2. Ownership of a de facto standard adopted by gateways/agents.
3. A marketplace or registry network effect.
4. Enterprise compliance lock-in through receipt ledgers.
5. Strategic acquisition value to Cloudflare, Datadog, Vercel, OpenAI, Anthropic, GitHub, or a security/compliance platform.

The best route combines all five.

## Strategic risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Gateway vendors clone compile/replacement | High | Move fast on spec, receipts, conformance, and registry. Integrate before they compete. |
| "Spec layer" story feels too abstract | High | Lead with savings and latency. Sell receipts after proof. |
| Specialists are technically harder than promised | High | Be honest: recipe tier first, adapter/specialist later. Use pointer-only language only in dev docs. |
| Receipt claims outpace cryptography | High | Implement Ed25519/KMS and public verifier before enterprise claims. |
| Security incident from untrusted recipe code | High | Replace Node `vm`, fuzz, sandbox, isolate compile jobs. |
| Foundation models get cheaper | Medium | Emphasize latency, determinism, offline, audit, and data ownership, not only cost. |
| No customer proof | High | Founder-led pilots immediately. Publish numbers. |
| Naming/positioning drift | Medium | Lock brand vocabulary and package names. |

## Source notes

Market and competitor sources checked on 2026-05-06:

1. Gartner AI spending forecast, 2026: `https://www.gartner.com/en/newsroom/press-releases/2026-1-15-gartner-says-worldwide-ai-spending-will-total-2-point-5-trillion-dollars-in-2026`
2. Gartner IT spending forecast, 2026: `https://www.gartner.com/en/newsroom/press-releases/2026-02-03-gartner-forecasts-worldwide-it-spending-to-grow-10-point-8-percent-in-2026-totaling-6-point-15-trillion-dollars`
3. Gartner LLM observability forecast: `https://www.gartner.com/en/newsroom/press-releases/2026-03-30-gartner-predicts-by-2028-explainable-ai-will-drive-llm-observability-investments-to-50-percent-for-secure-genai-deployment`
4. IDC AI infrastructure spending: `https://www.idc.com/resource-center/blog/ai-infrastructure-spending-caps-historic-year-at-90-billion-in-q4-2025-2029-spending-to-eclipse-1-trillion/`
5. EU AI Act Service Desk FAQ: `https://ai-act-service-desk.ec.europa.eu/en/faq`
6. European Commission AI Act policy page: `https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai`
7. MCP official docs: `https://modelcontextprotocol.io/docs/getting-started/intro`
8. Anthropic MCP launch: `https://www.anthropic.com/news/model-context-protocol`
9. OpenAI Structured Outputs: `https://platform.openai.com/docs/guides/structured-outputs`
10. OpenAI Agents SDK tracing: `https://openai.github.io/openai-agents-python/tracing/`
11. LangGraph durable execution: `https://docs.langchain.com/oss/python/langgraph/durable-execution`
12. Portkey Series A and metrics: `https://portkey.ai/blog/series-a-funding`
13. Portkey AI Gateway docs: `https://portkey.ai/docs/product/ai-gateway`
14. LiteLLM docs: `https://docs.litellm.ai/docs/`
15. Cloudflare AI Gateway features: `https://developers.cloudflare.com/ai-gateway/features/`
16. Vercel AI Gateway capabilities: `https://vercel.com/docs/ai-gateway/capabilities`
17. OpenRouter routing docs: `https://openrouter.ai/docs/model-routing`
18. Langfuse docs/homepage: `https://langfuse.com/docs`
19. Braintrust eval docs: `https://www.braintrust.dev/docs/evaluate`
20. Braintrust Series A: `https://www.braintrust.dev/blog/announcing-series-a`
21. Predibase platform/fine-tuning: `https://predibase.com/platform`
22. Predibase supported models: `https://docs.predibase.com/fine-tuning/models`
23. Apple Foundation Models framework: `https://developer.apple.com/documentation/FoundationModels`
24. Apple Core ML: `https://developer.apple.com/documentation/CoreML`
25. Google LiteRT overview: `https://ai.google.dev/edge/litert/overview`
26. ONNX Runtime Mobile: `https://opensource.microsoft.com/blog/2020/10/12/introducing-onnx-runtime-mobile-reduced-size-high-performance-package-edge-devices`
27. PyTorch ExecuTorch overview: `https://docs.pytorch.org/executorch/stable/intro-overview.html`
28. ExecuTorch product site: `https://executorch.ai/`
29. Grand View Research global edge AI software market: `https://www.grandviewresearch.com/industry-analysis/edge-ai-software-market-report`
30. Grand View Research U.S. on-device AI market: `https://www.grandviewresearch.com/industry-analysis/us-on-device-ai-market-report`
31. Qualcomm Edge Impulse acquisition announcement: `https://www.qualcomm.com/news/releases/2025/03/qualcomm-to-bolster-ai-and-iot-capabilities-with-edge-impulse-ac`
32. Qualcomm IE-IoT expansion with Edge Impulse/Arduino/Foundries.io: `https://www.qualcomm.com/news/releases/2026/01/qualcomm-s-ie_iot-expansion-is-complete--edge-ai-unleashed-for-d`
33. OctoML Series B / Apache TVM: `https://techcrunch.com/2021/03/17/octoml-raises-28m-series-b-for-its-machine-learning-acceleration-platform/`
34. OctoML Series C and Apache TVM creators: `https://techcrunch.com/2021/11/01/octoml-raises-85m-for-it-for-its-machine-learning-acceleration-platform/`

Note on future claims: the critique referenced "Apple Core AI / WWDC 2026." Because this report was updated on 2026-05-06, before WWDC 2026, that claim is treated as a likely hyperscaler-risk scenario, not as an observed launch fact. The current verified Apple threats are Core ML and the Foundation Models framework.

## Bottom line

The best strategy for kolm.ai is:

1. Stop competing with gateways.
2. Become the artifact and receipt target that gateways, agents, and auditors need.
3. Use savings as the adoption wedge.
4. Use signed receipts and RS-1 conformance as the moat.
5. Use Specialists and private registries as expansion revenue.
6. Replace prototype infrastructure immediately so the trust story is true.

The next concrete move is not another manifesto. It is a production-grade 14-day sprint: Postgres, object storage, durable jobs, Ed25519 receipts, seeded registry, auth recovery, and one working SDK/gateway integration that proves avoided LLM calls with receipts.
