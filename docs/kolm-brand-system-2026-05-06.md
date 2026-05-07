# Kolm brand system

Date: 2026-05-06 (revised 2026-05-07 — spine lock)

## Positioning

**Kolm is the compiler cache for intelligence.**

It turns repeated frontier-model work into the smallest local artifact that passes the tests. Run it on a laptop, a phone, or behind your VPC. Every artifact is signed end-to-end and discoverable through MCP.

The company should not position itself as another model runtime. Core ML, LiteRT, ONNX Runtime, ExecuTorch, llama.cpp, and MLC are the execution substrate. Kolm sits above them as the **compiler**, the **cache**, and the **registry** — the layer that turns "I called Claude again to do the same thing" into "I compiled that behavior once and the local artifact answers."

## Primary Message

Compile frontier behavior once. Run it locally forever.

## One-Liner

`kolm compile <task>` produces a signed `.kolm` artifact with a visible K-score. `kolm serve --mcp` exposes it to Claude, Codex, Cursor and Zed automatically. The cache strictly grows.

## Buyer Narrative

Your team is paying frontier prices for the same handful of behaviors thousands of times a day. Triage, classification, review, summarization, extraction. Each call is correct. Each call is also cacheable.

Kolm compiles the behavior into a single signed file: a small base model, a personal LoRA distilled from verified frontier output, a recipe pack covering the deterministic-token subset, a multimodal recall index of the user's data. It runs unchanged on a laptop, a phone, or behind a VPC. It serves itself over MCP so the agents you already use route to it automatically. Every artifact carries a K-score (size, accuracy, latency, cost, coverage) so you can defend the swap without a meeting.

The compliance wedge is downstream of this, not upstream of it. If the artifact never round-trips to the cloud, regulated workflows get the answer for free. We do not lead with the regulator; we lead with the engineer who is tired of paying twice for the same answer.

## Four pillars (Sprint 1 lock)

1. **`kolm compile`** produces a real `.kolm` artifact: model + LoRA + recipe pack + recall index + signed manifest.
2. **`kolm serve --mcp`** exposes the artifact as a tool. Claude, Codex, Cursor and Zed pick it up by name.
3. **K-score on every artifact** — visible size, accuracy, latency, cost, coverage. A single defensible number.
4. **Compounding cache** — every compile enriches the public deterministic-pattern registry. The next compile is smaller, faster, cheaper.

## Taglines

- Compile frontier behavior once. Run it locally forever.
- The compiler cache for intelligence.
- One artifact. Every device. Same receipt.
- One number you can stare at, five you can defend.
- The cache strictly grows.

## Homepage Tone

- Engineer-first, not enterprise-first. The artifact is the protagonist.
- Spine narrative before pillars. Pillars before sub-systems. Sub-systems before pricing.
- Crisp, concrete, evidence-oriented. K-score numbers wherever a claim is made.
- Compliance is a downstream consequence, not the lead. Keep BAA / DPA / SOC 2 paragraphs scoped to `/security` and `/enterprise`.
- No unsupported absolutism. Use "designed for", "audit-ready", "evidence pack" until certifications exist.

## Visual System

- Base: obsidian black, deeper and cooler than generic blue-black SaaS. `#050610` base, `#080b18` elevation, `#0d1224` cards, `#11172a` borders.
- Brand mark: bracketed K. The brackets represent the compile boundary and the artifact package. The K stroke represents the compiled behavior crossing from frontier into local execution. Filled with a single iridescent gradient (jade → cyan → violet → highlight) over thin steel-tone bracket strokes.
- Brand energy: cool aurora ribbons drifting in zero gravity. No warm tones, no rainbow, no decorative blobs. Pure cool spectrum.
- Accent roles (cool-only):
  - Pale jade `#5be8b6`: verification, compile success, K-score wins, signed receipts.
  - Electric cyan `#4dd1ff`: compile path, target matrix, MCP discovery, platform energy.
  - Soft violet `#aa9cff`: intelligence layer, registry, model behavior, hero accents.
  - Highlight `#d4c8ff`: gradient terminus only, never as a fill.
  - No reds, no oranges, no ambers, no golds. The only red allowed is `#ff7a98` for `--bad` error states.
- Type: SF Pro / system UI for product confidence; SF Mono for receipts, artifacts, K-score, targets, CLI. No external font loads, ever.
- Shape language: 8px radius, hairline borders (`rgba(188, 200, 232, 0.15)`), dense information, no oversized cards inside cards, no soft shadows, no rounded pill CTAs.

## Logo Assets

- `/logo-mark.svg` — transparent bracketed K mark for headers and inline use.
- `/logo-lockup.svg` — mark + "kolm" wordmark + "COMPILER CACHE FOR INTELLIGENCE" eyebrow.
- `/favicon.svg` — app-icon with dark rounded square and gradient K.
- `/og-card.svg` — social preview with mark, wordmark, and the spine headline "Compile frontier behavior once. Run it locally forever."
- `/brand-logo-exploration.png` — generated exploration board used to choose the final direction.
- `/brand-hero-prism.png` — hero image, telescoping nested obsidian dodecahedra with subtle iridescent thin-film, cool iridescence only, against an obsidian void.
- `/brand-aurora-field.png` — full-bleed aurora field for marketing surfaces that need horizontal motion.
- `/aurora.svg` — pure-vector aurora ribbon used behind hero/closing sections via `background-clip:text` and as a soft layered backdrop.

## Generated Hero Image Prompt (v2 — cool spectrum, no warm tones)

Editorial cinematic product photography, 16:9 widescreen. Telescoping nested obsidian-glass dodecahedra against a pure obsidian midnight void (`#050608`), each shell rendered as polished volcanic glass with subtle iridescent thin-film coating — soft violet (`#aa9cff`), electric cyan (`#4dd1ff`), and pale jade (`#5be8b6`) shimmer across facets like oil-slick interference on dark water. No horizon, no ground plane, no environment reflections. Subsurface scattering reveals interior depth. Lighting: cool soft top-key, pale violet fill from below, razor-sharp specular highlights along beveled edges, no warm tones whatsoever. ABSOLUTELY NO red, NO orange, NO yellow, NO warm colors of any kind — pure cool spectrum only: deep blacks, soft violets, electric cyan, pale jade. Heavy negative space, generous breathing room. Composition centered with Apple Vision Pro launch-still restraint. Hyper-realistic 8K, razor-sharp detail, restrained editorial composition, Foster + Partners architectural visualization aesthetic, Beksinski void mood, Damien Hirst diamond meets Apple Park glass.

Negative prompt: red, orange, yellow, warm colors, rainbow, fire, sunset, gold, brown, sepia, vintage, low quality, watermark, text, logo, signature.

## Homepage Structure (locked)

1. Hero — spine headline + lede + dual CTA + artifact inspector with K-score and MCP discovery strip.
2. Section 01 · Four pillars — `.kolm` artifact, MCP-native serving, K-score, compounding cache.
3. Section 02 · Compile — terminal demo of `kolm compile "<task>" --data ./examples`.
4. Section 03 · Serve · MCP-native — before/after comparison card (latency, cost, offline, receipt).
5. Section 04 · K-score — five-cell breakdown with explanations and big-K display.
6. Section 05 · Compounding — four-step loop (first call → repeat → drift → recompile).
7. Section 06 · Install — CLI / JS / Python / Swift / Kotlin tabs.
8. Section 07 · Targets — six-runtime grid (phones, browsers, laptops, VPC, edge, IDEs).
9. Section 08 · Registry — three featured `.kolm` tiles with K-score, size, pulls.
10. Section 09 · Pricing — Developer $0 · Pro · cache $49/mo · Enterprise custom.
11. Closing — spine headline repeated + dual CTA.
12. Footer — Product / Develop / Trust columns + RS-1 / RS-1-multimodal / RS-1-receipts attribution.

## Claims To Avoid Until Proven

- "HIPAA compliant" unless backed by BAA, controls, and customer context.
- "EU AI Act compliant" as a universal claim.
- "Runs on every device" without a public target matrix.
- "Better than Core ML / LiteRT" without benchmarks.
- "On-device fine-tuning" without stating whether personalization is LoRA training, retrieval, adapter selection, cache learning, or another mechanism.
- "K-score 1.0" — keep K-scores in plausible single-decimal range tied to the underlying inputs.
- "Beats frontier" without a verifier and a public benchmark.

## Words we do not use

- "Regulated apps" as the primary frame. Compliance lives at `/security` and `/enterprise`, not on the homepage.
- "AI Zapier" — wrong shape, deprecated.
- "Generic AI compiler" — too vague; always say "the compiler cache for intelligence".
- "Verified AI artifacts for regulated apps" — old descriptor; replaced by "the compiler cache for intelligence".
- "Trust layer" — vague; we are a compiler with a cache, not a trust layer.
