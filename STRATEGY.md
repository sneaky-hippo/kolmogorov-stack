# Recipe — Strategy v2

> Written 2026-05-06 after a hard internal critique. The previous positioning ("paste examples, get a function") tested a primitive without a wedge. This document re-anchors the product on a real, urgent, billion-dollar problem and lays out the path to a $10B outcome.

---

## TL;DR

We are not selling "tiny programs." We are selling **AI bill reduction on autopilot**.

Every AI-native company is bleeding 30–60% of their inference spend on tiny repeat questions that don't need a smart model. Today the answer is "manually rewrite your prompts" — nobody does it. We turn that into a 30-second SDK install that watches your traffic, finds the waste, replaces it deterministically, and shows you the savings.

The recipe primitive (examples → deterministic function) is the *engine*. The product is the *autopilot* that drives it: observe → cluster → synthesize → replace → measure. Everything we already built (bridges/observe, auto-synthesize, registry, specialists) was the right infrastructure with the wrong front door.

**Tagline: "Cut your AI bill 80%. Automatically."**

---

## The honest critique of v1

What was wrong with the positioning we shipped:

1. **The hero asked the user to do work.** "Show us how once" sounds friendly, but it makes the first step "go find 8 representative examples of a thing that bothers you." Most people don't have a thing that bothers them — they have a *bill* that bothers them.
2. **The value was abstract.** "Tiny programs from examples" describes a *capability*, not a *gain*. Capabilities don't sell; outcomes do.
3. **No one's actively shopping for what we built.** No CFO has "find me a way to compile examples to deterministic functions" on their list. They do have "AI cost is killing margin" on their list.
4. **We tested against the wrong category.** We compared to Cohere classify and OpenAI fine-tunes. The real competitor is *the Claude/GPT call you already make*, and the real category is *spend optimization*, not *classification platforms*.
5. **Specialists was strategically right but tactically buried.** Local LoRA on free hardware is a $10B story. We had it on the roadmap as Day 60. It should be the future arc of the homepage.

---

## What we actually have (the moat re-examined)

Stripping marketing, the assets we hold:

| Asset | What it does | Why it matters |
|---|---|---|
| **Synthesis engine** | examples → deterministic JS in 3s, 95% pass-rate | Nobody else can mint a deterministic specialist this fast |
| **Template clustering** (`bridges/observe`) | groups raw LLM prompts by signature, finds repeat patterns | This is the *spend autopilot's* eyes |
| **Auto-synthesize from clusters** | promotes a 6-call cluster into a recipe automatically | This is the *spend autopilot's* hands |
| **Edge runtime** | 30µs p50, no GPU, runs anywhere JS runs | The savings are real because the runtime is essentially free |
| **Registry + composer** | recipes are reusable, attention-routable | Network effect: every new user gets pre-built primitives |
| **Specialists scaffold** | path from recipe → fine-tuned LoRA on synthetic labels | The bigger play: own the local-model layer |

Every one of these is shipped. The mistake was talking about #1 (synthesis) when the wedge is #2 + #3 (observe + auto-replace).

---

## The real problem (first-principles)

### What is an AI product, structurally?

Every AI product is a directed graph of LLM calls. A user request fans out into:
- **1 big call** — the actual reasoning ("write the code", "summarize the doc")
- **N small calls** — routing, classifying, validating, formatting, extracting

For a typical agent today: **1 big call : 8–40 small calls**. The small calls collectively cost more than the big call. They are also slower, more flaky, and break determinism in the hot path.

### What % of small calls don't need a smart model?

Empirically (Hindsight, Helicone telemetry papers, our own bench): **~80%** of repeat small calls have ≤200 distinct semantic clusters per million calls. They are classification, intent detection, extraction, safety/policy checks, format validation, language detection.

### What's the addressable spend?

OpenAI revenue Q4 2026 ≈ $13B annualized. Anthropic ≈ $4B. Together with Bedrock/Vertex/Mistral et al, the global LLM-API spend is **~$50B/yr** and growing 5–7×/year. If 60% of that is "tiny repeat questions" and 80% of those are deterministically replaceable, the addressable savings pool is **~$24B/yr** today, growing to **~$200B/yr by 2030**.

A platform that captures even **5% of measured savings as fee** is a **$1.2B → $10B** company on the savings layer alone, before any expansion into specialists, edge, or marketplace.

### Why is this not solved already?

Three structural reasons:

1. **Observability tools are paid per-token-observed.** Helicone, Langfuse, Braintrust make money when *more* LLM calls happen. They show you the cost; they don't eliminate it. Eliminating calls would cannibalize their core metric.
2. **Foundation labs are paid per-call.** OpenAI/Anthropic will not ship "automatically replace your calls with deterministic functions" — that's the worst possible product for their P&L.
3. **Manual replacement is too tedious.** A senior engineer can spend a week writing classifiers to replace one prompt. Most teams never do it. The autopilot is the unlock — taking the manual labor to zero.

We are the only player aligned with the customer's actual incentive: **smaller bill**. That alignment is the moat.

---

## The $10B framing

### The product, in one sentence

> **Recipe is the autopilot that watches your LLM traffic and silently replaces the wasteful 80% with deterministic functions, so your AI bill goes down without you doing anything.**

### The five surfaces of the company

```
                       ┌─────────────────────────────────┐
                       │   1. SAVINGS METER (consumer)    │
                       │   "$X saved this month, here's   │
                       │   the receipt"                   │
                       └────────────┬────────────────────┘
                                    │
                       ┌────────────┴────────────────────┐
                       │   2. AUTOPILOT (engine)          │
                       │   observe → cluster →            │
                       │   synthesize → replace           │
                       └────────────┬────────────────────┘
                                    │
        ┌───────────────────┬───────┴──────┬──────────────────┐
        │                   │              │                  │
   ┌────▼────┐      ┌──────▼──────┐ ┌─────▼─────┐    ┌───────▼────────┐
   │ 3. RECIPES│      │ 4. SPECIAL- │ │ 5. EDGE   │    │ 6. REGISTRY    │
   │ (today)   │      │   ISTS (LoRA│ │  RUNTIME  │    │  (network      │
   │ JS funcs  │      │   day 60)   │ │  any JS   │    │   effect)      │
   └───────────┘      └─────────────┘ └───────────┘    └────────────────┘
```

Each layer reinforces the others:
- **Recipes** handle 80% of the easy-win clusters (today).
- **Specialists** handle the harder 15% via fine-tuned local LoRAs (Day 60–120).
- **Edge runtime** is what makes both essentially free to serve.
- **Registry** is the network effect — every new customer benefits from every prior customer's pre-baked primitives.
- **Autopilot** is the orchestrator that decides what gets synthesized vs specialist-trained vs left as LLM.
- **Savings meter** is the daily-engagement surface that justifies the bill.

---

## Competitor map — the real one

We are not competing with Cohere fine-tunes. We are competing for the AI-spend wallet share. The real map:

### Tier 1 — Observability (show the spend, don't fix it)

| Player | Funding | What they do | Where we win |
|---|---|---|---|
| **Helicone** | ~$10M | Open-source LLM observability, basic cache | They show; we eliminate. They're free OSS, so distribution-strong; we beat on outcomes. |
| **Langfuse** | ~$4M seed | Tracing + evals, OSS-first | Same — observability category, customer-aligned but doesn't reduce spend. |
| **Braintrust** | ~$36M Series A | Eval-first, prompt experimentation | They optimize *prompts*; we eliminate the call entirely. Their tool needs spend to justify itself. |
| **Lunary** | small | LLM ops, prompt mgmt | Niche, not a serious threat alone. |
| **Datadog LLM Obs** | enterprise | Bolt-on to existing APM | Enterprise distribution but generic; we're the "wedge inside the spend graph." |

**Strategic read:** the entire observability tier sells visibility. We sell the next step — *automated action on what visibility surfaces.* They are partners as much as competitors. The savings metric we show feeds back into their dashboards.

### Tier 2 — Gateways (route the spend, don't reduce it)

| Player | Funding | What they do | Where we win |
|---|---|---|---|
| **Portkey** | $30M Series A | AI Gateway, caching, fallback | They cache responses; we replace the *generator*. Cache helps the lucky 5% that hit; we hit the predictable 80%. |
| **OpenRouter** | unfunded? | Model marketplace + routing | Arbitrage; doesn't reduce volume. |
| **LiteLLM** | OSS, ~$15M raised by BerriAI | Unified API + routing | Plumbing layer, not optimization. |
| **Kong AI Gateway** | enterprise | Gateway with policy/guardrails | Enterprise; we'd integrate, not replace. |

**Strategic read:** gateways move calls around. We remove calls. Different unit-economic story. Long-term we *integrate* with gateways: every gateway should auto-route through Recipe first.

### Tier 3 — Fine-tune / Distillation (build smaller models manually)

| Player | Funding | What they do | Where we win |
|---|---|---|---|
| **Predibase** | $13M+ Series A | Fine-tune platform, LoRA-as-a-service | Manual: bring data, run job. We auto-generate the data via synthesis; user does nothing. |
| **OpenAI fine-tune** | first-party | OAI-only fine-tunes | Bound to OpenAI runtime, no edge, no determinism. |
| **Cohere fine-tune** | first-party | Same as above for Cohere | Same story. |
| **HuggingFace AutoTrain** | huge | OSS fine-tune UI | Manual; no observation loop. |
| **Replicate** | ~$40M | Hosted model serving + fine-tunes | Compute layer, not workflow layer. |

**Strategic read:** all of these need labeled data and a human in the loop. Recipe synthesizes deterministic labelers from 8 examples, then auto-labels millions of rows, then fine-tunes the LoRA. We are the missing zero-effort upstream.

### Tier 4 — DIY (the actual #1 competitor)

The biggest competitor is **status quo: keep paying the LLM bill.** Friction to act is the enemy.

This shapes the product: anything that requires a meeting, a contract, a procurement cycle, or an engineering sprint loses. Self-serve install with the SDK + 30-second savings receipt is the wedge.

---

## SWOT — McKinsey × YC × Thiel × Sovereign

### Strengths
- **Aligned incentives.** Customer wins ⇒ we win. Observability vendors are misaligned (more tokens = more revenue).
- **Determinism premium.** EU AI Act, finance, healthcare, regulated workflows demand deterministic + auditable. We deliver natively.
- **30µs p50 latency.** 17,000× faster than a Claude call. Unlocks real-time use cases (fraud, moderation, recs) that LLMs can't touch.
- **Edge-deployable.** No GPU, no model weights, runs in browsers, on phones, on edge IoT. The recipe is a 400-byte JS function.
- **Compounding registry.** Every customer's recipes (when public) become every other customer's free starter library. Network effect over time.
- **Already-shipped infra.** Observation, clustering, auto-synthesis, lineage, registry, specialists scaffold — the autopilot is wired; we just need the front door.

### Weaknesses
- **Brand recognition zero.** Helicone has a 7k★ GitHub repo; we have a fresh URL.
- **Single-founder velocity.** Against $30M-funded teams with 15 engineers.
- **No flagship customer testimonial.** Need 3 named users with $-attached savings claims before this is a credible pitch.
- **"What if synthesis fails?" answer is incomplete.** When an LLM call is genuinely complex, recipe declines and you keep paying. We need to communicate this honestly without seeming to over-promise.
- **Specialists path is unproven at scale.** The full LoRA-from-synthetic-labels loop has only been demoed locally, not at customer-traffic volume.

### Opportunities
- **AI spend exploding 5–7×/year.** Every CFO is asking how to control it. We are the only autonomous answer.
- **Regulatory tailwind.** EU AI Act 2026, state-level US laws. Deterministic + auditable goes from nice-to-have to mandatory for certain verticals (banking, insurance, healthcare).
- **Distillation category opening.** Hugging Face, Anyscale, Together — everyone is racing to "make smaller models." We are the only one with the upstream data-generation engine.
- **Consumer / device-side AI.** Apple Intelligence, Phi-3, Gemma — small-model boom. Recipes are perfect for "ship a classifier with the app."
- **AI-native SDR / GTM.** A bot can install our SDK and prove savings before a human ever talks to the buyer. Self-serve at agent speed.
- **Token marketplace.** Long-term: each recipe is meterable + ownable. Marketplace-as-business.

### Threats
- **OpenAI / Anthropic ship "auto-replace from observed traffic."** They have the data and the relationship. *Mitigant:* they make money per call; cannibalization unlikely. Timeline ~36 months.
- **Helicone or Portkey clones synthesis.** Most likely real threat. *Mitigant:* they'd cannibalize their per-token model; cultural / business-model conflict.
- **Foundation models become so cheap synthesis isn't worth it.** Sonnet at 1/100th today's price would erode the savings story. *Mitigant:* even free per-call doesn't beat 30µs latency, edge deployment, or determinism. Latency moat is structural.
- **Open-source DIY pattern emerges.** "Just ask Claude to write you a regex" with LangChain glue. *Mitigant:* that's exactly what we automate; the autopilot loop (observe → measure → swap) is the product.
- **Lock-in regulation.** EU AI Act could classify deterministic distillation oddly; need legal review. Probably opportunity, not threat.

---

## Pricing — savings-aligned, not seat-aligned

The standard SaaS playbook (per-seat, per-API-key) is wrong here. The right play:

### Tier 1 — Free
- 10,000 recipe-calls/mo
- 5 recipes synthesized
- Public recipes only
- **Goal:** any developer can prove value before procurement.

### Tier 2 — Growth ($99/mo + 10% of measured savings)
- Unlimited recipe-calls
- Unlimited synthesis
- Private recipes
- Autopilot: auto-detect and synthesize from observed traffic
- Savings dashboard
- **Goal:** small startups that pay $200–$5,000/mo on Claude/OpenAI. We save them $X, take 10%.
- Math: a $2,000/mo Claude bill drops to $400; we charge $99 + (1600 × 0.10) = $259/mo. Customer net: saves $1,340/mo. Both win.

### Tier 3 — Scale ($1,000/mo + 5% of savings, capped 50% of bill)
- Specialists (LoRA fine-tunes from synthetic labels)
- SLA + dedicated synthesis priority
- VPC / on-prem option
- **Goal:** companies spending $20k–$500k/mo on inference. The cap protects them; the % aligns us.

### Tier 4 — Enterprise (custom)
- Six- and seven-figure bills
- Air-gapped runtime
- Custom registry / private marketplace
- Multi-region + SOC 2 + HIPAA
- **Goal:** banks, insurers, hyperscalers. Pricing tied to verified savings via a 30-day pilot.

### The sales-cycle insight
This pricing model is **its own marketing**. We can claim *"we don't make money unless your bill goes down"* — a line no observability vendor can match.

---

## Distribution — where the buyers actually live

### 1. Developers in the IDE (zero-friction)
- **Claude Code MCP** — `recipe.synthesize` and `recipe.run` available inline. Already shipped.
- **VS Code extension** — already shipped, watches code for repeated `claude.complete()` calls and offers replacement. Need to harden + publish to marketplace.
- **Cursor extension** — same pattern, different IDE.

### 2. The CLI (autonomous agents — net new this version)
- `npm i -g @kolmogorov/recipe`
- `recipe init` — auto-mints anonymous tenant, no signup needed
- `recipe synthesize ...` — works immediately
- `recipe claim --email me@co.com` — converts anon to real account
- **Why this matters:** GPT-5 / Claude / Devin agents will install our CLI as a tool. They don't have email addresses; they have tokens. We meet them there.

### 3. The SDK (the autopilot wedge)
- `import { observe } from '@kolmogorov/recipe'`
- Wrap your existing Anthropic / OpenAI client. We log prompts (PII-redacted), cluster, synthesize candidates. **Synthesis is opt-in per cluster.**
- **The savings receipt:** weekly email with "we found N replaceable clusters worth $X/mo. Click to deploy."

### 4. Inbound: the "share your AI bill" funnel
- Public form: paste 3 of your most-frequent prompts. We'll synthesize them for free and tell you what you'd save.
- Lead gen + viral mechanic: "AI bill audit" gets shared.

### 5. Bottom-up GitHub / Hacker News
- Technical posts with reproducible numbers ("we cut a startup's AI bill 73% in 11 days")
- Open-source the synthesis engine; close-source the autopilot orchestration.
- Optimize for HN front-page: "Show HN: We watch your AI traffic and silently replace 80% of it"

### 6. Partnerships (Tier 2)
- **Helicone / Langfuse / Braintrust:** "click here to send these clusters to Recipe for replacement." Both vendors win because their dashboards show the savings *they* surfaced.
- **Cloudflare Workers / Vercel Edge:** ship the recipe runtime as a primitive. Free distribution to every edge developer.

---

## Product gaps to close (in order of leverage)

### P0 — must ship this week (the wedge is broken without these)
1. **Anonymous CLI auth.** Robots and agents must be able to install + use within 30 seconds. Anon-token bootstraps a tenant; `claim` converts to real account. *(In progress.)*
2. **Homepage rebuild.** "Cut your AI bill 80%" framing. Live savings counter. Real comparison vs Helicone/Portkey/Braintrust. *(In progress.)*
3. **`/optimize` page.** The autopilot UX. Paste prompts, see clusters, see savings, deploy with one click.
4. **Savings meter as the daily-engagement surface.** Dashboard headline becomes "$X saved this week," not "p50 latency."

### P1 — must ship within 30 days (turns wedge into wallet share)
5. **The Autopilot SDK wrapper.** `wrapAnthropic(client)` — drops in front of an existing Anthropic client, observes silently, surfaces clusters in dashboard.
6. **Cluster → Recipe with one click.** The bridges/auto-synthesize flow needs a UI that says "replace these 6 calls with this recipe? +$120/mo savings."
7. **Auto-routing.** Once a recipe replaces a cluster, the SDK transparently routes future matching calls to the recipe. Customer changes nothing.
8. **Stripe + savings-tied pricing** (Growth + Scale tiers). The tier itself becomes a marketing line.
9. **First 3 named case studies.** Founder-led pilots. Public numbers, public quotes. No story without these.

### P2 — must ship within 90 days (locks in the moat)
10. **Specialists v1 — production.** End-to-end: observe traffic → synthesize labeler → auto-label corpus → fine-tune LoRA → deploy. Customer never touches a training script.
11. **Recipe registry as a public good.** Every common task (spam, intent, NSFW, language, format) has a public recipe. New users *find* before they *make*.
12. **Edge-runtime SDK.** Cloudflare Workers, Vercel Edge, Deno. Recipe runs at the CDN, before the request hits your origin.
13. **Auditing UI.** For regulated customers: every recipe has a reproducible test trace, a determinism proof, and a code-review page. Sells to compliance.

### P3 — quarterly (compounding plays)
14. **Mobile / device-side runtime.** WASM build of the recipe interpreter, ships in iOS/Android apps. "Your app's AI runs offline, free."
15. **Recipe marketplace** — sellable recipes + specialists. We take a cut. Comparable to npm + a payment rail.
16. **Multi-modal.** Recipes for image classification, audio gating. Today: text only.

---

## The moonshot scenario (why this is $10B+)

The bull case in numbered steps:

1. **Year 1:** 10,000 self-serve developers install the SDK. 1,500 convert to Growth ($99 + savings cut). Average savings $800/mo, our cut $80/mo. **ARR: ~$1.5M.**
2. **Year 2:** 50 Scale customers ($20k+ AI bills). Average save $80k/yr each, we take $4k/mo. **ARR: $4M from Scale, $9M from self-serve. Total ~$15M.**
3. **Year 3:** Specialists ships. 10 enterprise pilots; 3 close. $1M ACV each. **ARR: $40–60M.**
4. **Year 4:** Registry network effect kicks in. Public recipes saturate "common tasks" (spam, intent, NSFW, etc). New users skip synthesis 60% of the time. Conversion rate to Growth doubles. **ARR: $100M+.**
5. **Year 5:** Recipe runtime is the default deterministic layer in every AI gateway / IDE / edge. Edge marketplace + mobile distribution. **ARR: $300M+, revenue multiple of 30× → $10B valuation.**

The unlock at each stage is **product, not sales**. Self-serve has to convert without humans. Once it does, the company prints money.

---

## Why this story is more honest than "build me a function"

The first version was a *capability* in search of a *job to be done*. This version is a *job to be done* with our capability as the unique answer.

- The job: **"My AI bill is too high."**
- The unique answer: **"We watch your traffic and replace 80% of it deterministically — bill goes down, latency goes down, determinism goes up. Zero engineering effort."**
- The proof: **a savings receipt, dollar-denominated, in the buyer's email by Friday.**

That story converts. The previous one didn't.

---

## The 30-second pitch

> Companies are spending billions on Claude and GPT calls that don't need to be Claude or GPT calls.
>
> Drop our SDK in front of your AI client. We watch your traffic, find the 80% that's actually classification or extraction or routing, and silently replace those calls with deterministic functions that run in 35 microseconds and cost nothing.
>
> Your bill goes down. Your latency goes down. Your determinism goes up. You did nothing.
>
> We charge 10% of what we save you. So if we don't cut your bill, we don't get paid.

That's the company.
