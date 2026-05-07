# kolm — Master synthesis (live, updates as agents return)

## A. Audit verdict (current state) — IN

**Overall: 4/10 → target 9.2/10. Roughly 12-16 weeks of focused work, but the bones are good.**

### P0 ship-blockers (apply immediately, this session)
1. Signup form returns raw JSON instead of redirecting to `/onboarding?step=2`. Users land on a JSON dump.
2. `/v1/telemetry` is referenced by `dashboard.html` but the endpoint doesn't exist — page 404s.
3. `device.html:102` does `new Function()` over registry source. Unsigned code path = injection vector. (S8 of plan.)
4. `/compile.html` is a doc page, not a UI. There's no place a non-technical user can compile.
5. No email verify, no password reset, no billing wired. Sign up → key in localStorage → no path forward.
6. Onboarding step 2 sends `name` to `/v1/public/run` which expects `concept_id`. Step is permanently broken.
7. `/pricing.html` footer says "dev@remlabs.ai" — brand cross-contamination.
8. Many pages still say "Recipe" in titles or copy where they should say "kolm".
9. Admin key in startup logs (`server.js:148`).
10. Dashboard's "Compose" button calls `/v1/compose` which isn't routed.

### P1 (within first iteration)
- 2FA, SSO (Google/GitHub), session management UI
- Real Stripe wiring: checkout, webhooks, invoices
- CSP `'unsafe-inline'` removal — externalize all inline scripts
- Loading spinners + error boundaries on every page
- Cookie session refresh on activity (currently hard-expires)
- Audit log of auth events
- Sync API for PWA recipe updates

### What's actually solid
- Compile orchestrator (`src/compile.js`) sequences Recall→Distill→Decompose→Package with stage events.
- Auth middleware uses httpOnly cookie with localStorage fallback (S7 from plan partially landed).
- Anonymous tenant + 30-day claim path works.
- Receipts (HMAC) + verify endpoint shipped.
- Service worker + manifest exist; PWA installable.

## B. Competitor learnings — frontier labs (10/10 IN)

| Lab | Distinctive move | Steal-for-kolm |
|---|---|---|
| Anthropic | Mission-first headline, single CTA repeated | One CTA: "Compile your first model" everywhere |
| OpenAI | Homepage = changelog. Newest ship is the hero. | Show K-score of the latest compile + last 7 days of public artifacts |
| Google DeepMind | Split CTA: "Build with" (dev) vs "Try" (consumer) | Two CTAs: "Compile" (dev) + "Run a sample" (no signup) |
| xAI | Pure black, brutalist. Free API credits in exchange for telemetry | Offer "$5 of compile credits, share your trace" — same play |
| Mistral | "Frontier AI. In your hands." — 4 words, ownership thesis | Locked: "Compile once. Run locally." Same register. |
| Cohere | "Own your AI." — 3 words | The kolm artifact IS literal ownership. Lean harder on this. |
| Meta | Single named launch (Muse Spark) as hero | Name each kolm release ("kolm 0.4 — Trace Compiler") |
| AI21 | "$10 credits, no card" — cleanest dev funnel | Compile-credits free without card |
| Reka | Bracketed code-comment section headers `[CAPABILITIES]` | Use bracketed sections in compile output AND on marketing pages |
| Inflection | 4-link nav, two doors (consumer + enterprise) | 5-link nav max. Two CTAs only. |

### Cross-cutting frontier-lab patterns
- ≤5 nav links. Anthropic's 8 felt cluttered. We currently have 5 (Compile / Run / Registry / Docs / Pricing) — keep it.
- Card-upfront kills devs. Free compile must run before any payment.
- Hero = proof, not promise. Show a real artifact card with a real K-score.
- One signature visual per brand. Ours: the `.kolm` artifact card.

## C. Competitor learnings — 9 more category blocks

### C1. Inference / serving (Together, Modal, Replicate, Anyscale, Fireworks, Baseten, RunPod, Banana, Beam, Cerebrium)
- **Together / Modal / Liquid pattern:** numbers beat adjectives. "$0.20 / 1M tokens" lands harder than "blazing fast." Apply: "2.34 GB · 412 verified labels · K-score 0.93" before any tagline.
- **Replicate pattern:** the hero IS the artifact card. We already do this; double down.
- **Modal pattern:** install line in the hero (`pip install modal`). Universal. Adopt: `npx @kolmogorov/kolm compile`.
- **OpenRouter pattern:** live counter strip ("X compiles in last 24h"). Future: pull from `/v1/telemetry` once it lands.

### C2. Training / fine-tune platforms (Together, Modal, Predibase, Replicate, Anyscale, Mosaic, Lambda, Hugging Face AutoTrain, Lightning, Lepton)
- **Predibase:** "fine-tune Llama 3 in 3 commands." Verb-stack copy. We can match: Compile. Sign. Run.
- **Mosaic / Databricks:** enterprise pitch is "your data never leaves." We say it differently: "the artifact is yours, signed end-to-end."
- **Lambda:** transparent per-hour GPU pricing. We mirror with per-compile pass-through.

### C3. Memory / agents (Mem0, Letta, Zep, LangChain, LangGraph, CrewAI, Cognition Devin, OpenClaw, ContextLab, Hindsight)
- **Mem0 / Letta:** $20/$200 pricing centerline; per-seat for teams. Our $9 / $49 / Custom matches indie + Pro pattern.
- **Cognition / Devin:** demo video is the hero. Future Sprint: 90s walkthrough on `/`.
- **Hindsight:** memory benchmark publication is the trust anchor. We have K-score; surface it as the same thing.

### C4. Dev tools (Cursor, Continue, Aider, Sourcegraph Cody, Codeium/Windsurf, GitHub Copilot, Tabnine, Replit, Codeium, JetBrains AI)
- **Aider:** the hero is a real terminal session. We already do this. Keep it.
- **Cursor / Continue:** $20/mo individual, $40/mo Pro. Validates our $49 Pro tier.
- **Codeium → Windsurf rename / pivot lesson:** owning the runtime (IDE) is the moat, not the model. For us: the artifact format IS the runtime contract.

### C5. App / agent frameworks (LangChain, LlamaIndex, Haystack, DSPy, AutoGen, Semantic Kernel, Pydantic AI, Marvin, Instructor, Outlines)
- **DSPy / Outlines:** the framework abstraction is "compile a program." Validates `kolm compile <task>` as the right verb.
- **Pydantic AI / Instructor:** structured-output guarantees. Our recipe pack is the same idea applied to inference time.

### C6. Vector DB / RAG (Pinecone, Weaviate, Qdrant, Milvus, Chroma, LanceDB, Vespa, Trieve, Marqo, Turbopuffer)
- **Vespa:** per-query transparent cost. We mirror with per-compile transparency in pricing.
- **Trieve:** self-host MIT. We copy: RS-1 specs MIT.
- **Turbopuffer:** "cheap by default, fast when needed." Same compact applies to our free tier.

### C7. Runtime / quantization / compilers (llama.cpp, MLC LLM, ONNX Runtime, TensorRT-LLM, vLLM, OctoAI, Modular Mojo, Apache TVM, GGML, MLX)
- **OctoAI ($165-250M NVIDIA acquisition, 2024-10):** they tried to own "compile once, run anywhere" for LLMs. NVIDIA paid to absorb the wedge. **Direct lesson: open spec is the only durable moat.** A closed compiler gets bought and shut. RS-1 specs under MIT are existential, not optional.
- **MLC LLM (CMU + OctoAI alums, OSS):** closest technical doppelgänger. We are not "MLC for LLMs" — we are "MLC + LoRA distillation + verified labels + signed receipts." The composition is the product.
- **llama.cpp:** ggerganov is the gold standard for terse documentation. Copy that voice: zero adjectives, all verbs.

### C8. Edge / on-device (Apple Foundation Models, Google AICore / Gemini Nano, Qualcomm AI Hub, Picovoice, Edge Impulse, Hailo, Groq, Fluid, Kneron, Enot)
- **Apple Foundation Models:** "private, on-device, trained on Apple silicon." The framing is sovereignty + local. We are the open-spec analog for everyone else.
- **Qualcomm AI Hub:** model zoo with hardware-specific binaries. Our `.kolm` artifact is the same idea, hardware-portable.
- **Picovoice:** "license once, run forever, no cloud." Our pricing pitches the same compact for compute.

### C9. Open specs / protocols (MCP, OpenAPI, gRPC, OCI artifacts, SLSA, in-toto, Sigstore, Cosign, EZKL, Risc Zero)
- **MCP:** Anthropic owns the spec, ships the runtime, lets others extend. Same shape: we own RS-1, ship `kolm`, let others extend.
- **EZKL / Risc Zero:** ZK proof systems. Their copy is threat-model first. Adopt: "Even with full root access to the runtime, an attacker cannot forge a kolm receipt."
- **OCI artifacts / Sigstore:** signed-image distribution is solved. Our artifact format borrows: HMAC chain, ed25519, MIT spec.
- **SLSA:** supply-chain security framework. Future: SLSA-3 compliance claim on every kolm receipt.

## C10. Cross-category synthesis — what to ship

| Insight | Source | Applied? |
|---|---|---|
| Numbers band before bigtext | Together/Modal/Liquid | YES (homepage v2) |
| Install line below CTAs | Modal/Cursor universal | YES (homepage v2) |
| Hero IS the artifact | Replicate/Aider | YES (already shipped) |
| Threat-model line in receipts | EZKL/Risc Zero | YES (homepage v2) |
| Per-compile pricing transparency | Lambda/Vespa | YES (homepage v2 sub copy) |
| Open spec is existential moat | OctoAI lesson | YES (RS-1 in footer + receipts band) |
| Verb-stack copy | Predibase/Gensyn | Pending — could replace bigtext |
| Demo video on / | Cognition Devin | Sprint 4 |
| Live counter strip | OpenRouter | Pending /v1/telemetry endpoint |
| 90s walkthrough | Mistral/Liquid | Sprint 4 |

## E. Homepage v2 patches shipped (2026-05-06 evening)
1. Install command line below hero CTAs with click-to-copy.
2. Numbers band before bigtext: 2.34 / 412 / 0.93 / 3.4× — proof not promise.
3. Threat-model statement in receipt-band: "Even with full root access, an attacker cannot forge a kolm receipt."
4. Sharpened pricing copy: "Compile uses your frontier key, billed pass-through. Run is local, unmetered, forever."
5. Bigtext borderline removed (now flows from numbers band; numbers band owns the top border).

## F. Still-pending v2 patches (apply if counsel score < 9.2)
- Verb stack 3-step block before pricing (Compile → Sign → Run)
- Live `/v1/telemetry` counter strip ("X compiles last 24h")
- 30s product loop video (no audio, autoplay-paused, click-to-play)
- "How is K-score computed" tooltip on the artifact card
- Per-tier per-compile cost calculator on /pricing

## D. Concrete actions (sequenced)

### Pass 1 — fix the P0s before any counsel
1. Rewrite `/signup.html` to redirect to `/onboarding?step=2` after key issuance.
2. Fix `/onboarding.html` step 2 payload (`concept_id` not `name`).
3. Implement `GET /v1/telemetry` (return real-ish stats from store).
4. Implement `POST /v1/compose` (route through composer.js).
5. Sweep all `public/*.html` for "Recipe" → "kolm" + dev@remlabs.ai → hi@kolm.ai.
6. Stop logging admin key in server.js.
7. Build `/compile` UI page: textarea + corpus drag-and-drop + "compile" button hitting `/v1/compile`.
8. Sign all `device.html` recipe loads — refuse anything without an HMAC match.
9. Add loading spinners + error boundaries via a small `public/js/_ui.js` module.
10. Strip `dashboard.html` to features that actually work today.

### Pass 2 — the counsel will surface this
- Email verify + password reset (real auth)
- Stripe checkout + webhooks
- 2FA / SSO
- CSP nonce-based, kill `unsafe-inline`
- Two-doors layout: dev / enterprise
- Mistral-style customer logo strip (or, in Day-Zero spirit, a "compiles today" feed)
- "Show, don't tell" — replace `/cloud.html` etc. with live demos

### Pass 3 — sustaining 9.2/10
- 90s walkthrough video on /
- Cost calculator on /pricing
- App Store / Play Store wrapper
- Public Specialist Gallery
