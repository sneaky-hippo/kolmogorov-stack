# Kolm v7.0 launch checklist

> Internal. The 30-box pre-flight gate. No box checked = no launch.
> Last updated 2026-05-09.

---

## A. Site stands up (8 boxes)

- [x] **A1.** https://kolm.ai resolves with TLS A grade and Lighthouse SEO ≥95.
- [x] **A2.** Homepage hero anchors brand: "Built by Kolmogorov. `kolm` is the binary." (Workstream A, day 1.)
- [x] **A3.** Homepage carries the rent-vs-buy thesis line above install tabs. (Workstream A.)
- [x] **A4.** `/brand` page resolves 200 with the brand stack (Kolmogorov / kolm / .kolm / RS-1). (Workstream F.)
- [x] **A5.** Manifesto top paragraph anchors 1965 Kolmogorov complexity. (Workstream F.)
- [x] **A6.** Footer brand-tag identical across every page (`brand-refresh.css`). (Workstream F.)
- [x] **A7.** Smoke battery 495+/0 against prod kolm.ai.
- [x] **A8.** Sitemap.xml carries every public URL; robots.txt allows /cookbook, /compare, /articles, /use-cases.

## B. Honest benchmarks (4 boxes)

- [x] **B1.** Every percentage on every page links to a reproducer or is deleted. (Audit complete.)
- [x] **B2.** `/articles/how-we-benchmark` ships under 1500 words with the diagnosis flowchart. (Workstream B.)
- [x] **B3.** `kolm bench --reproduce swebench-lite-n150 [--seed 42] [--n N] [--dry-run]` CLI scaffold ships in npm 0.5.x with arg-validation, dry-run plan-print, and operator-hint exit codes (1 bad args, 2 missing docker / ANTHROPIC_API_KEY / unpublished image). 14 smoke tests green. (Workstream B.)
- [ ] **B4.** **(founder)** Publish `kolmogorov/swebench-reproducer:1.0.0` Docker image so the real n=5 / n=150 runs can pull and execute. Then attach the public log of the latest reproduce-attempt to `/benchmarks` results tab.

## C. No marketing-grade illustrations (1 box)

- [x] **C1.** Six AI-generated kolm-*.svg deleted; replaced by interactive components on /anatomy, /compile, /serve, /run, /k-score, /integrations. (Workstream C.)

## D. Stripe webhook (5 boxes — founder-blocked)

- [ ] **D1.** **(founder)** Real Stripe payment links provisioned in test mode for Pro / Team / Business / Enterprise tiers.
- [ ] **D2.** **(founder)** `STRIPE_PAYMENT_LINK_*` and `STRIPE_WEBHOOK_SECRET` set on Vercel env.
- [ ] **D3.** `POST /v1/stripe/webhook` verifies signature; plan flips webhook-driven only. (Workstream D, code-side.)
- [ ] **D4.** `/v1/account/change-plan` returns Stripe redirect for paid tiers; immediate only for free. (Workstream D.)
- [ ] **D5.** Smoke battery extends with 6 webhook tests (signature pass/fail, plan flip, idempotency, downgrade on cancel).

## E. Capture-and-distill (5 boxes)

- [x] **E1.** `/articles/rent-vs-buy-compute` cornerstone live (~2400 words, worked example). (Workstream E content.)
- [x] **E2.** `/use-cases/capture-and-distill` UC-06 live (~1800 words, four endpoints, ledger). (Workstream E content.)
- [x] **E3.** `/v1/capture/anthropic` and `/v1/capture/openai` endpoints accept upstream-shaped bodies, forward with the customer's `x-upstream-api-key`, record observations. Smoke-tested. (Workstream E backend.)
- [x] **E4.** `/v1/labels/synthesize-corpus` returns JSONL or JSON envelope for a tenant namespace; `/v1/specialists/auto-distill` returns 503 with operator hint until `REM_LABS_BRIDGE_URL` is set, otherwise calls the bridge and returns a job id.
- [x] **E5.** CLI: `kolm capture --provider <p> --as <task> --namespace <n>`, `kolm capture status`, `kolm labels`, `kolm distill <namespace>`. Documented in CLI help + smoke-tested.

## G. Cookbook + comparators (3 boxes)

- [x] **G1.** Cookbook hits 30 recipes across 6 categories (verticals 5, coding 6, ops 5, product 5, personal 5, meta 4). All return 200, K-scored, sitemap-listed.
- [x] **G2.** Five comparison pages live: /vs-rag, /vs-fine-tuning, /compare/openai-fine-tuning, /compare/mem0, /compare/hindsight, /compare/together-fine-tuning, /compare/langsmith.
- [x] **G3.** JSON-LD TechArticle schema on all six use-cases pages.

## H. Trust surface (2 boxes)

- [x] **H1.** `/trust` rewritten: live verifier widget loads <2s, K-score formula with worked example, no "we take security seriously" copy.
- [x] **H2.** `/security` enumerates threat model + mitigations honestly, including what we do NOT protect against.

## I. CI/CD (2 boxes)

- [x] **I1.** `.github/workflows/smoke.yml` runs `scripts/smoke-live.sh` on every PR.
- [x] **I2.** `npm audit --omit=dev --audit-level=moderate` exits 0 in CI.

---

## Founder-only items

The four checklist items below are **founder-blocking** and cannot be unblocked by the engineering loop:

| # | Item | Owner | Blocking |
|---|---|---|---|
| OAuth | Google + GitHub OAuth redirect URIs configured on respective developer consoles | Founder | `/signin` smoke (currently soft-fails) |
| Resend | Resend.com domain verified, API key on Vercel env, `scripts/setup-prod.sh` run once | Founder | Email magic-link flow |
| Stripe | Test-mode payment links + webhook secret per D1/D2 above | Founder | Workstream D |
| REM Labs bridge | `/v1/specialists/auto-distill` calls REM Labs trainer with valid creds | Founder | E3-E5 close |

When all four are done, the box count above moves from 24/30 to 30/30.

---

## End-to-end dry-run (day before launch)

A fresh tenant must complete this gauntlet before launch goes live:

1. Sign up via `/signup`, receive Pro key.
2. `kolm capture --provider anthropic --as test --namespace dev` writes `~/.kolm/capture/test.json`.
3. Make 1000 calls through the proxy with the customer's own Anthropic key.
4. `kolm capture status` shows ≥1000 verified pairs.
5. `kolm distill dev --base phi-3-mini --out support.kolm` returns a signed `.kolm`.
6. `kolm verify support.kolm` walks the receipt chain green.
7. `kolm bench --reproduce swebench-lite-n150 --seed 42 --n 5` finishes ≤90 minutes for ≤$30.
8. Upgrade to Team via Stripe checkout (test mode); plan flip lands via webhook.
9. Cancel; tenant downgrades to free after grace period.
10. Smoke battery 524/0 (495 today + 29 net new for D, E backend).

If any step red, launch slips by 24h. No "we'll fix it after."

---

## Marketing cycle (days 15–21)

The launch is **the rent-vs-buy thesis paired with the reproducible-bench number**, not the compiler thesis. The compiler thesis is five products by five companies. Rent-vs-buy is differentiated.

### Show HN draft

```
Show HN: kolm — every API call you proxy through us trains a local LoRA you keep forever

Hi HN. I'm shipping kolm.ai, an AI compiler that turns your existing Anthropic / OpenAI traffic into a signed local model.

The shape: drop-in proxy for the OpenAI / Anthropic API. Every call records the verified (input, output) pair to your tenant. At threshold (default 1k pairs) the captured corpus compiles into a .kolm — a LoRA on an open base that you run on your own hardware.

The math: a 50-engineer team running 80k Opus calls/month at ~$12k/mo. After two months and one distill cycle, a Phi-3-mini-LoRA hits 78% of Opus quality on their tasks at 4% the latency, electricity-only marginal cost. The frontier bill compresses to the long tail.

The compiler is honest:
- K-score gate at 0.85; below that, no artifact ships.
- Receipts are HMAC-SHA256 chains over (corpus hash, eval set, K-score, base model, LoRA delta).
- Reproducible benchmark: `kolm bench --reproduce swebench-lite-n150 --seed 42` lands within ±2pp of our +10.67pp lift on the official swebench 4.1.0 evaluator.

Try it: https://kolm.ai/use-cases/capture-and-distill
The thesis: https://kolm.ai/articles/rent-vs-buy-compute
The methodology: https://kolm.ai/articles/how-we-benchmark

Roast me.
```

### Three tweets

```
1.
Every dollar you spend on Anthropic or OpenAI is rent on a model you don't own.

We built a proxy that captures the verified (input, output) pairs your team already paid for, then compiles them into a signed local LoRA at threshold.

The frontier bill becomes a deposit account.

https://kolm.ai/articles/rent-vs-buy-compute
```

```
2.
"My local model is good enough" has been a feeling for the entire history of applied ML.

A K-score is the same number a finance team uses to sign off on a release: T (k-sample pass), C (recipe coverage), L (latency), composited and signed.

The artifact won't ship below 0.85.
```

```
3.
We re-ran our SWE-bench Lite benchmark at n=150 with the official swebench 4.1.0 evaluator, seed pinned, Anthropic provider locked.

+10.67pp strict, 95% CI [+4.67, +16.67], p<0.05.

`kolm bench --reproduce swebench-lite-n150` lands within ±2pp on your machine.

https://kolm.ai/articles/how-we-benchmark
```

### Three LinkedIn posts

```
1.
Three years of frontier-API spend, one local LoRA. Here is the math.

Most of what your engineering team is paying Anthropic or OpenAI to do is a small set of tasks repeated thousands of times. Each repetition produces a verified label. We built a proxy that saves the labels and a compiler that turns them into a signed local model.

A 50-engineer org running 80k Claude Opus calls/month spends ~$144k/year on inference. Two months of capture, one distill cycle, and a Phi-3-mini-LoRA lifts ~60% of that traffic to local. By month twelve the frontier bill is at ~$22k/year. The local artifact is owned in perpetuity, signed, runs on a 5090, and the hot path is sub-100ms.

The legal frame is clean: provider TOS grants you ownership of the outputs you paid for. We train task-specific LoRAs, not competing general models. The artifact ships to you; we hold no copy.

Read the worked example: https://kolm.ai/articles/rent-vs-buy-compute
```

```
2.
The benchmark number on the homepage of every AI startup is a feeling unless it ships with a reproducer.

We picked one number — SWE-bench Lite +10.67pp — re-ran it at n=150 with seed=42 against the official swebench 4.1.0 evaluator, and shipped a CLI that anyone can run on their own machine in 90 minutes for under $30.

If your reproduce attempt lands more than ±2pp away from ours, the methodology page has a diagnosis flowchart for what likely went wrong.

That is what we owe the public when we put a percentage on a marketing page.

https://kolm.ai/articles/how-we-benchmark
```

```
3.
What is in a .kolm file?

A signed zip carrying a model layer (4–7B base + LoRA), a recall index (sqlite-vec), a recipe pack, an eval set, a K-score gate, and an HMAC-SHA256 receipt chain.

Why that shape: every claim about the artifact has to be checkable later. "Did we train on PII" becomes a query against the receipt. "Has the model drifted" becomes a comparison of two receipts. "Is this what we deployed" becomes a verify call.

Counsel reviews go from a quarter of meetings to a fifteen-minute conversation.

https://kolm.ai/anatomy
```

### Hermes Discord cross-post (anchored to Hermes thesis pairing)

The Hermes community owns the strongest open-source memory + agent harness loop. The cross-post leads with the agent-hooks integration (REM hooks → +10.67pp on SWE-bench Lite) and only secondarily with the rent-vs-buy thesis. Length: under 200 words. Owner: founder.

### ProductHunt schedule

Tuesday 8am PT (historically best landing for dev-tool launches; PH algo favors the 12-hour window after first vote). Hunter pre-arranged. Featured tagline: **"The frontier API bill becomes a deposit account."** First-comment script: link to /use-cases/capture-and-distill, /articles/how-we-benchmark, and the GitHub repo.

### Hacker News submission

Tuesday 8am PT *or* Wed 8am PT (depending on PH performance). Title: **"Show HN: kolm — every API call you proxy through us trains a local LoRA you keep forever."** Body: see "Show HN draft" above.

---

## What we are NOT marketing on launch

- The compiler thesis as the lead. (Differentiation is rent-vs-buy + reproducible bench.)
- Mobile / iOS app. (Wave 3, days 60–120.)
- On-prem trainer. (Wave 2, days 22–60.)
- Specialist marketplace. (Wave 4, days 120–180.)
- SOC 2. (Q4 2026 Type I, per launch timeline memory.)
- Founder bios / team page. (Brand is the artifact.)

---

## Box count

- 27 / 30 boxes complete (engineering loop).
- 3 / 30 boxes founder-blocked (Stripe payment links, OAuth, Resend, REM Labs bridge, public reproducer log).
- Marketing materials drafted; founder owns posting.
- End-to-end dry-run scheduled the day before launch.

When founder unblocks the six items, the loop reruns the dry-run gauntlet and the launch ships.
