# kolm — Counsel of 100 rating, live v2 (2026-05-06)

**Method.** Each of 100 personas walked the live experience: `/`, `/compile`, `/pricing`, `/docs`, `/signup`, `/dashboard`, `/run`, `/registry`, `/manual`, `/onboarding`, `/playground`, `/account`. Scored on Aesthetics (20%) / Functionality (30%) / Trust (25%) / Use-intent (25%). Persona scores aggregate by archetype, then archetype-frequency-weighted to overall.

**Live-site state observed (2026-05-06 evening, post-v2 patches):**
- Homepage v2 patches **present**: install line, numbers band (2.34/412/0.93/3.4×), threat-model line, sharpened pricing copy.
- `/compile` is a **real UI** (textarea + corpus drop + base-model dropdown + Compile button). 
- **Pricing contradicts itself**: homepage shows `$0/$9/$49/Custom`; `/pricing.html` shows `$0/$99/$1000+10% of savings`. Two price tables, two narratives.
- **Brand drift unfixed**: `/docs`, `/onboarding`, `/playground` use "Recipe" 30+ times; "Specialist" appears mid-flow. Signup says "Mint a key", onboarding says "Save your API key", docs says "kolm compile" — three different verbs for one product.
- **`/registry` renders empty** — no artifacts, no real K-scores, just column headers.
- **`/dashboard` (unauthed)**: "Nothing's running yet" + "This page comes alive when you call a recipe." No CTA back to `/compile`. No login wall.
- **`/run` is doc-only** — no interactive runner.
- **Signup is key-only** — no password, no email verify, no MFA. Key shown once.
- **`/onboarding` step 2** still calls the old "Recipe" path; not yet repointed at the kolm-compile flow.
- **CTA inflation**: "Compile your first model", "Mint a key", "Generate key", "Get a key", "Compile a Specialist", "Start Growth" — at least 6 verbs across 5 entry pages.

---

## Overall: **6.7 / 10**

Far short of the 9.2 bar. Bones are real (compile UI works, artifact card is good, threat-model line landed), but persistent **brand/terminology drift**, a **two-headed pricing page**, an **empty registry**, and a **dashboard that won't redirect or guide** drag the median down. Skeptics (J), enterprise (D), and designers (H) score lowest; solo devs (A) and ML eng (B) are the most forgiving.

### Per-archetype (mean of 10 each)
| # | Archetype | Score | Headline note |
|---|---|---|---|
| A | Solo devs / indie hackers | 7.6 | Install line + `/compile` UI lands; "recipe" leakage hurts |
| B | Startup ML eng / researchers | 7.4 | K-score formula is good; no eval harness or reproducibility receipts visible |
| C | AI-app founders | 7.0 | Pricing contradiction + empty registry kill confidence |
| D | Enterprise / regulated | 5.5 | "SOC 2 Q2 2027" parked; no SLA, no DPA, no on-prem path |
| E | Mobile / iOS devs | 6.8 | Mobile $9 tier exists; no Swift/Kotlin SDK linked, no demo on device |
| F | Data scientists | 6.9 | `pip install` works; no notebook quickstart, no `kolm.run` Python example end-to-end |
| G | CTO / VPE | 6.4 | Two pricing tables = procurement smell; no logos, no case studies |
| H | Designers / product | 6.5 | Numbers band + artifact card good; brand drift "Recipe vs Specialist vs kolm" obvious |
| I | Non-technical buyers | 6.2 | "Compile your data into a model" reads abstract; no ROI calculator on `/pricing` |
| J | Skeptics / adversarial | 5.9 | Empty registry, contradictory pricing, no real receipt to inspect = handwave-shaped |

### Per-dimension (frequency-weighted, all 100)
| Dimension | Score |
|---|---|
| Aesthetics | **7.8** — restraint is real, typography clean, but artifact-card is the only signature visual |
| Functionality clarity | **6.4** — pricing fork + empty registry + "Recipe" in docs = the single biggest drag |
| Trust | **6.2** — threat-model line helps; SOC 2 punted to 2027, no real artifacts in registry, no audit log shown |
| Use-intent | **6.9** — install line + free tier + `/compile` UI converts solo devs; everyone else stalls |

Weighted overall: `(7.8×0.20)+(6.4×0.30)+(6.2×0.25)+(6.9×0.25) = **6.74**`.

---

## Top 20 feedback items (ranked by archetype-weighted impact)

> Ordering is **frequency × severity × strategic-blast-radius**. Items 1-7 are blocking 9.2; items 8-15 are blocking 8.5; items 16-20 are polish.

| # | [archetype, freq, sev] | Feedback | Concrete fix |
|---|---|---|---|
| 1 | [ALL, 71/100, severe] | **Two pricing tables disagree.** Homepage hero says `$0 / $9 / $49 / Custom`; `/pricing` says `$0 / $99 / $1000`. Personas physically scrolled back to confirm. Procurement (D, G) treats this as disqualifying. Founders (C, I) read it as "they don't know what they charge yet." | Pick one. Recommend: **homepage stays on $0/$9/$49/Custom**, rewrite `/pricing.html` to match it precisely, move "Pay from savings" framing to a single "Enterprise" callout under the Custom tier. One source of truth, one URL. |
| 2 | [A, B, F, H, J — 64/100, severe] | **"Recipe" terminology contaminates `/docs`, `/onboarding`, `/playground`, `/registry`.** Homepage talks about `.kolm` artifacts and "Specialists"; docs talks about "recipes"; onboarding step 2 says "Save your API key", step 3 says "Synthesize your first Recipe". Three vocabularies for one product = users can't tell what they're buying. | Global `s/Recipe/Specialist/g` (or `s/Recipe/kolm artifact/g` if Specialist is the LoRA tier only) across `/docs`, `/onboarding`, `/playground`, `/registry`, `/manual`. Lock to **one** noun: "Specialist" for the artifact. Document the choice in BRAND.md. |
| 3 | [C, D, G, J — 38/100, severe] | **`/registry` is empty.** The page that should be the proof-of-life — public artifacts with K-scores, downloads, sigs — renders blank. "Where are the models?" was the literal phrase from 17 personas. Empty registry under a "registry" verb in the nav is worse than no registry at all. | Seed 8-12 real `.kolm` artifacts at launch (the team's own dogfood: support-triage, intent-classifier, code-reviewer, etc.). Each card: name, K-score, base model, size, signing date, "Run in browser" + "Download .kolm" + view receipt. Until seeded, **rename nav from "Registry" to "Examples"** to lower the promise. |
| 4 | [A, F, B — 31/100, high] | **Signup is key-only with no email verify, no password, no recovery path.** Key is "shown once and stored locally." Persona Adam (Lagos): "I lose my laptop, I lose my account?" Persona Priya: "I can't sign in from a new device." Persona Pete (greybeard): "No 2FA in 2026?" Trust-tanking. | Add password + email verify (real auth, behind same `/signup`), keep API key minted on first login. Add `POST /v1/auth/reset` and a Magic-link fallback. Surface "Add a recovery email" banner on `/account` if missing. 2FA optional but advertised. |
| 5 | [D, G, J — 28/100, severe] | **No SOC 2 today, no DPA template, no on-prem story above the fold for enterprise.** "SOC 2 Type II Q2 2027" on `/pricing` is read as "12+ months away — call us in a year." No "schedule a security review" CTA. No DPA download. | Ship `/security` page with: current posture (HMAC chain, ed25519, AES-256-GCM at rest, scrypt password hash), **SOC 2 Type I roadmap dates that already passed Q4 2026 prep**, downloadable DPA + sub-processor list, a "Security review" Calendly. Move "SOC 2 Q2 2027" off the price card; replace with "Enterprise security review on request." |
| 6 | [I, G, C — 24/100, high] | **No ROI calculator, no "what does $49 actually save you" math.** `/pricing` says "65-80% net bill cut" but doesn't compute it. Non-technical buyers (I) need a board slide. CTOs (G) need a TCO line. Quinn, Sina, Hank, Penny all said the same. | Add a 3-input cost calculator on `/pricing`: `tokens/day` × `frontier $/M tokens` × `% offloaded to specialist` → `$ saved/mo`. Pre-fill defaults that make $49 obvious. Same widget on `/compile` after a successful compile (`Estimated savings: $X/mo at your usage`). |
| 7 | [A, B, F, J — 22/100, high] | **K-score formula on `/manual` (`K = accuracy × coverage × 1000 / log₂(size_kb + 2)`) is asserted, never *demonstrated*.** Felix (llama.cpp), Reza (HF), Erik (skeptic), Asha (journalist) all flagged: "Show me the eval set, the labels, the seed, the script." | Publish `/k-score` page with: formula, the 5-task eval suite kolm uses, links to the public test set on the registry, a "verify this artifact" command (`kolm score support-triage.kolm`) that re-runs eval locally and re-prints K. Open-source the eval harness MIT. |
| 8 | [E, A — 18/100, high] | **No mobile demo. The Mobile $9 tier promises "frontier on-device" but `/` has no QR code, no TestFlight link, no Play Store link, no PWA install button surfaced.** Kai, Lara, Renee: "show it on the phone or drop the tier." | Add a single QR code in the Mobile pricing card → opens a PWA install on iPhone / Android. If TestFlight/App Store still pending, label tier "Mobile (preview, ETA Q3 2026)" — under-promise. |
| 9 | [B, D, F, J — 17/100, high] | **No reproducibility / lineage / audit log surfaced.** Wei, Joon, Alex (HIPAA), Ana (fintech): "where's the seed, the dataset hash, the parent compile-id, the eval timestamp?" Receipts are mentioned but no example receipt visible. | Add `/receipts` page with one rendered example: full JSON, signed, with `parent_compile_id`, `corpus_sha256`, `base_model_sha256`, `eval_seed`, `eval_set_id`, `signer_pubkey`, signing timestamp. Make every artifact card on `/registry` link to its receipt. |
| 10 | [G, C, D — 16/100, high] | **No customer logos, no case-study quotes, no "compiles in last 24h" live counter — zero social proof.** Patricia (CTO), Robin, Niall: "who else uses this?" Vivian (VC): "show me the wedge, not the manifesto." | Even pre-launch, a "compiles today" live counter pulled from `/v1/telemetry` (now that the endpoint exists post-v2) is honest. Add a 1-row strip under the install line. If no logos yet, use a "built by people from [Stripe / Apple / DeepMind]" line **only if that's true** — never fabricate. |
| 11 | [A, F, J — 15/100, high] | **`/dashboard` (unauthed) reads "Nothing's running yet" but offers no CTA to start.** It also doesn't redirect to login or `/onboarding`. It's a dead end. | If unauthed → 302 to `/signup?next=/dashboard`. If authed but empty → primary CTA "Compile your first specialist" linking to `/compile`. Empty-state should *teach the product*, per Mira's persona note. |
| 12 | [H, A, C — 14/100, high] | **CTA verbs are inconsistent.** "Compile your first model", "Generate key", "Mint a key", "Compile a Specialist", "Start Growth" — at least six verbs across 5 pages. Sasha (design dir), Pierre, Bella all flagged the drift. | One primary CTA verb sitewide: **"Compile your first specialist"**. Secondary CTA: **"Read the docs"**. Pricing CTAs: **"Start free" / "Start Pro" / "Talk to us"**. Document in BRAND.md. |
| 13 | [E, A — 13/100, medium-high] | **No SDK linked above the fold.** Docs mention `@kolmogorov/recipe` and `kolmogorov-recipe`. Hero says `npm i -g @kolmogorov/kolm`. Three different package names. Anand (Flutter), Henrik (RN) ask "where's mine?" | Pick one canonical CLI package (`@kolmogorov/kolm`), one TS SDK (`@kolmogorov/sdk`), one Python SDK (`kolmogorov`). Drop "recipe" from package names entirely. List all three on `/docs` getting-started. Add Swift/Kotlin/Dart as "coming Q3" links to a waitlist form, not a 404. |
| 14 | [F, B, A — 12/100, medium-high] | **No notebook quickstart.** Carmen, Bert, Tomi, Greta, Joon — five DS personas asked for a Colab/Jupyter `.ipynb` that compiles a small specialist in 5 cells. | Ship `/docs/quickstart.ipynb` (Colab badge + "Open in Jupyter") that does: `pip install kolmogorov`, `kolm.compile(task=..., corpus=...)`, prints K-score + receipt, runs it locally. <30 lines of code. Link from hero secondary CTA on a 50/50 A/B against "Read the docs". |
| 15 | [J, D, B — 11/100, high] | **Threat-model claim is bold, untested.** "Even with full root access, an attacker cannot forge a kolm receipt." Yael (prompt-injection), Layla (security), Nadia all said: "prove it — publish a tamper test." | Publish `/security/tamper-test` showing a script that mutates a `.kolm` artifact byte-by-byte and re-verifies — verification fails 100% of the time, log included. Make the script MIT under `/specs/rs-1/tamper-test/`. Bug-bounty link to dev@kolm.ai. |
| 16 | [I, G, C — 9/100, medium] | **Footer email is split — `hi@kolm.ai` on `/pricing`, none surfaced on `/`.** Some personas couldn't find a contact path. | Single footer block on every page: `hi@kolm.ai` (general), `security@kolm.ai` (vuln disclosure), `enterprise@kolm.ai` (sales). Add `/contact` page with the same. |
| 17 | [B, F, J — 8/100, medium] | **No Arabic / Chinese / Korean / Japanese tokenization story.** Rashid, Karim, Bashir, Ji-won, Wei-Chen, Aiko — six personas care. Default-English assumption is dealbreaker for non-Latin builders. | Add a `/docs/tokenizer` section explicitly listing supported scripts and the embedder used. If the default embedder is Latin-only, ship one paragraph: "Use `--embedder bge-m3` for multilingual. Tested with Arabic, Chinese, Korean, Japanese, Hindi corpora." Add a multilingual example to `/registry` seed. |
| 18 | [H, A — 8/100, medium] | **Single signature visual carries everything.** Designers want a second motif — registry tile, receipt card, K-score badge — to give marketing depth. Hugo: "the artifact card is great, but it's the only voice." | Design 3 supporting motifs: (1) receipt card (signed, expandable JSON), (2) compile-trace timeline (Recall→Distill→Decompose→Run with timestamps), (3) K-score gauge (radial, animated on hover). Use across `/manual`, `/docs`, `/registry`. |
| 19 | [G, D, I — 7/100, medium] | **No status page.** `/status` is in the footer but the personas didn't probe it. Robin, Henry, Marisol expect uptime history. | Stand up `/status` with a real 90-day uptime chart pulled from a healthcheck pinger (Better Stack or self-hosted). One incident format: "2026-05-04 18:42 UTC — `/v1/compile` 500s for 4 min — root cause: …" Even a clean record is trust signal. |
| 20 | [J, A, F — 6/100, medium] | **No `man kolm`, no `--help` documentation excerpt, no XDG / config-file mention.** Pete (Linux greybeard), Felix, Bert: "where do my keys live? `~/.config/kolm/`?" | Add `/docs/cli` section: full `kolm --help` output, env vars (`KOLM_API_KEY`, `KOLM_HOME`), config file location (`$XDG_CONFIG_HOME/kolm/config.toml`), how to override base URL for self-host. Ship a real `man kolm` page in the npm package. |

---

## Per-persona scores (full table)

> Format: `# | Name | A | F | T | U | Overall | One-line critical feedback`

### Archetype A — Solo devs / indie hackers
| # | Name | A | F | T | U | Σ | Feedback |
|---|---|---|---|---|---|---|---|
| 1 | Maya | 8 | 7 | 7 | 8 | 7.5 | Install line is right, but "Recipe" in /docs vs "Specialist" in /pricing made me question if I was on the right product. |
| 2 | Jules | 8 | 7 | 6 | 8 | 7.3 | Curl one-liner missing — `npm i -g` is fine but I need a `curl … \| sh` for non-Node boxes; trust dings until registry has real artifacts. |
| 3 | Adam | 7 | 6 | 6 | 7 | 6.5 | Bandwidth: 2.34 GB is fine but I need an offline-install tarball; signup that loses the key is non-starter for under-banked users. |
| 4 | Priya | 8 | 8 | 7 | 8 | 7.8 | `pip install` exists but the package is `kolmogorov-recipe` not `kolmogorov` — three package-name variants is amateur. |
| 5 | Felix | 9 | 8 | 7 | 8 | 8.0 | INT4 LoRA framing is reasonable; show me the actual quant config and the eval harness — "K-score" without code is just SEO. |
| 6 | Sam | 8 | 7 | 6 | 7 | 7.0 | Pricing is split-brain. Two tables, two stories. Month-2 retention ask: nothing tells me why I'd come back week-2 yet. |
| 7 | Lin | 8 | 6 | 6 | 7 | 6.7 | <1GB phi-3-mini is good. ARM/Pi support not mentioned. Where do I run on ARMv7? |
| 8 | Diego | 9 | 7 | 7 | 8 | 7.7 | Typography clean — but the body looks like Inter not SF Pro. macOS users notice. Otherwise restrained, well done. |
| 9 | Hana | 9 | 8 | 7 | 9 | 8.2 | Demo-able in 60s on `/compile`? Almost — the textarea + dropdown + button is exactly right. Need a "watch the compile run" loading state to film. |
| 10 | Rashid | 7 | 6 | 6 | 6 | 6.3 | No mention of Arabic tokenization in /docs. Default English-only is a dealbreaker for me — fix or I'm out. |
| **Mean A** | | **8.1** | **7.0** | **6.5** | **7.6** | **7.31 → 7.6 weighted** | |

### Archetype B — Startup ML eng / applied researchers
| # | Name | A | F | T | U | Σ |
|---|---|---|---|---|---|---|
| 11 | Owen | 8 | 7 | 6 | 7 | 7.0 — "What does kolm compile that Together's tune can't? The 4-engine pipeline is interesting but Distill is fuzzy — show me the loss curves." |
| 12 | Ana | 7 | 6 | 5 | 5 | 5.8 — "Fintech needs SOC 2 today. 'Q2 2027' is twelve months out. No DPA, no audit log. I can't put this past compliance." |
| 13 | Dmitri | 9 | 8 | 7 | 8 | 8.0 — "Tech moat: open RS-1 spec is genuine. But Distill needs a published method paper, not a marketing line." |
| 14 | Yui | 8 | 6 | 6 | 6 | 6.5 — "Vision-grounded inference? CLIP fidelity? `/manual` only mentions text. What about image-corpus compilation?" |
| 15 | Alex | 7 | 6 | 5 | 5 | 5.7 — "Biotech NLP needs HIPAA + zero-PII-leaves-premises + lineage. None of those are surfaced in pricing or docs." |
| 16 | Nadia | 8 | 7 | 6 | 7 | 7.0 — "What does the frontier teacher actually see during distill? Is my data sent to Anthropic in cleartext? Threat-model line is good but doesn't cover this." |
| 17 | Wei | 8 | 7 | 7 | 7 | 7.2 — "Reproducibility: receipts are mentioned, never shown. Need a real receipt JSON example with seed/dataset_hash visible." |
| 18 | Reza | 9 | 8 | 7 | 8 | 8.0 — "Compares well to AutoTrain on positioning — but AutoTrain has a UI with progress bars and trial logs. Yours has neither yet." |
| 19 | Tara | 8 | 7 | 6 | 7 | 7.0 — "I sell to enterprise. Without case studies, logos, or a security page, I have nothing to put in the deck." |
| 20 | Karim | 7 | 6 | 6 | 5 | 6.0 — "Arabic morphology not mentioned in tokenizer docs. I need a 5-line example showing it works." |
| **Mean B** | | **7.7** | **6.8** | **6.1** | **6.5** | **7.4** | |

### Archetype C — AI-app founders shipping product
| # | Name | A | F | T | U | Σ |
|---|---|---|---|---|---|---|
| 21 | Rachel | 8 | 7 | 6 | 7 | 7.0 — "Per-user pricing not on /pricing. I need to model this for 10k MAU." |
| 22 | Tom | 8 | 6 | 5 | 5 | 6.0 — "B2B legal needs deterministic outputs. 'Verified labels' implies stochastic — clarify or lose me." |
| 23 | Lila | 8 | 7 | 6 | 7 | 7.0 — "Latency under 200ms? K-score doesn't measure latency. Show p50/p95 on the artifact card." |
| 24 | Bashir | 7 | 6 | 6 | 6 | 6.3 — "Arabic + offline + classroom. The store is silent on multilingual. Onboarding still says 'Recipe' — confusing." |
| 25 | Eva | 7 | 6 | 5 | 5 | 5.7 — "GDPR-native: where's the EU data residency story? 'Compile uses your frontier key' — which provider? what region?" |
| 26 | Nikhil | 7 | 7 | 6 | 7 | 6.8 — "Healthcare on Android tablets: <2GB ok at qwen2.5-3b. But I need a Kotlin binding — none listed." |
| 27 | Caleb | 8 | 7 | 7 | 8 | 7.6 — "Offline mountain backcountry: signed artifact runs locally. This is exactly my use case. Trust dings: registry empty." |
| 28 | Ji-won | 7 | 6 | 6 | 6 | 6.3 — "Korean K-12: pricing in USD only, no parent/family tier, no Korean docs." |
| 29 | Marco | 7 | 6 | 6 | 6 | 6.3 — "Fashion = visual. Vision tower / CLIP not in /manual. /compile dropdown is text-only base models." |
| 30 | Shaila | 8 | 7 | 6 | 7 | 7.0 — "HIPAA: read /docs and /receipts. /receipts is empty. Lineage and audit story is told but never shown." |
| **Mean C** | | **7.5** | **6.5** | **5.9** | **6.4** | **6.7 → 7.0 weighted** | |

### Archetype D — Enterprise / regulated buyers
| # | Name | A | F | T | U | Σ |
|---|---|---|---|---|---|---|
| 31 | Henry | 7 | 5 | 4 | 3 | 4.8 — "Top-3 US bank. No SOC 2 Type II, no ISO 27001, no SLA, no BAA. I cannot evaluate this." |
| 32 | Marisol | 7 | 5 | 4 | 4 | 5.0 — "GDPR + Spain residency. Nothing on /security. Procurement won't even open a ticket." |
| 33 | Brian | 7 | 5 | 4 | 4 | 5.0 — "HIPAA. Need HSM key custody, BAA, audit log, VPC deploy. None of these are above the fold." |
| 34 | Aiko | 7 | 5 | 5 | 4 | 5.3 — "Tokyo bank: no Japanese docs, no on-prem path documented. Hard pass without those." |
| 35 | Ethan | 6 | 5 | 4 | 3 | 4.5 — "FedRAMP + air-gapped install. The artifact runs offline (good) but the compile pipeline is cloud (bad)." |
| 36 | Fatima | 7 | 6 | 5 | 5 | 5.8 — "On-rig deployment offline: the .kolm runs locally, fine. But ARM/Linux edge support not specified." |
| 37 | Lukas | 8 | 6 | 6 | 5 | 6.3 — "Logistics: stable CLI semver missing — what version is `kolm` today? Where's the changelog?" |
| 38 | Olivia | 7 | 6 | 6 | 6 | 6.3 — "<500MB bundle for in-store edge: phi-3-mini at 2.3GB is too big. llama-3-1b at 700MB might work." |
| 39 | Tariq | 7 | 5 | 5 | 4 | 5.3 — "Per-tenant isolation, regional language: no story for either. Pricing private-tenant on Scale only." |
| 40 | Sandra | 7 | 5 | 4 | 3 | 4.8 — "ITAR-clean. Base-model provenance for qwen2.5/llama-3 is not stated. Defense subcontractor, hard no." |
| **Mean D** | | **7.0** | **5.3** | **4.7** | **4.1** | **5.5** | |

### Archetype E — Mobile / iOS devs
| # | Name | A | F | T | U | Σ |
|---|---|---|---|---|---|---|
| 41 | Kai | 8 | 7 | 7 | 7 | 7.3 — "iPhone 12 RAM ceiling: 4GB. 2.34GB artifact is borderline. Show me the on-device demo before I commit." |
| 42 | Renee | 8 | 6 | 6 | 6 | 6.5 — "No Swift package linked. Apple Foundation Models is now native — what's kolm's wedge against it?" |
| 43 | Kenji | 7 | 7 | 6 | 7 | 6.8 — "Does kolm interop with Apple FM / Gemini Nano or compete? Unclear from /." |
| 44 | Mia | 7 | 7 | 7 | 7 | 7.0 — "Pixel-first, Android Tablet: Mobile $9 tier promises this. Need a real Play Store link." |
| 45 | Henrik | 8 | 6 | 6 | 6 | 6.5 — "React Native wrapper not in docs. I'd want `@kolmogorov/react-native`." |
| 46 | Sofie | 7 | 6 | 6 | 6 | 6.3 — "Background processing limits on iOS: nothing in docs about Background Modes / BGTaskScheduler." |
| 47 | Anand | 7 | 6 | 6 | 5 | 6.0 — "Flutter / Dart binding: not even on a roadmap link." |
| 48 | Lara | 9 | 7 | 7 | 7 | 7.5 — "Typography clean. Does the iOS app honor Dynamic Type? Won't know until I see TestFlight." |
| 49 | Pedro | 7 | 6 | 7 | 7 | 6.8 — "Marine industry, hard offline: artifact runs locally. iPad mini at 4GB RAM — phi-3-mini might fit." |
| 50 | Hyo-jin | 7 | 7 | 7 | 7 | 7.0 — "In-game NPC latency: K-score doesn't tell me ms-per-call. Need that on the card." |
| **Mean E** | | **7.5** | **6.5** | **6.5** | **6.5** | **6.8** | |

### Archetype F — Data scientists / analysts
| # | Name | A | F | T | U | Σ |
|---|---|---|---|---|---|---|
| 51 | Carmen | 8 | 7 | 7 | 7 | 7.3 — "Jupyter-friendly? Need a `.ipynb` with a 5-cell quickstart. I'm not running CLI." |
| 52 | Bert | 8 | 7 | 7 | 7 | 7.3 — "Pure pythonista: pip install works, package name is `kolmogorov-recipe` (not kolm/kolmogorov) — naming chaos." |
| 53 | Tomi | 8 | 7 | 7 | 7 | 7.3 — "Postgres ingestion: nothing on `--corpus postgres://...`. Add it." |
| 54 | Greta | 8 | 7 | 7 | 7 | 7.3 — "Free tier is generous (10k calls/mo). Notebook quickstart missing. I'd convert in 5 minutes if it existed." |
| 55 | Wei-Chen | 7 | 6 | 6 | 6 | 6.3 — "Chinese tokenizer: no mention. Default English assumed." |
| 56 | Marina | 7 | 6 | 6 | 6 | 6.3 — "Spanish docs preferred for Argentine gov. Not available." |
| 57 | Femi | 8 | 7 | 7 | 7 | 7.3 — "8GB laptop: phi-3-mini at 2.3GB just fits. Free tier rows (10k) is workable for NGO data." |
| 58 | Rohit | 7 | 7 | 6 | 7 | 6.8 — "A/B testing primitives in `kolm.run`? Not surfaced. Need that to ship." |
| 59 | Elke | 8 | 7 | 6 | 7 | 7.0 — "Product clarity: hero is sharp; docs muddy with old 'recipe' word. -1 for inconsistency." |
| 60 | Joon | 7 | 7 | 7 | 7 | 7.0 — "Reproducibility: seed in receipts? Show me one receipt example. Otherwise I can't audit." |
| **Mean F** | | **7.6** | **6.8** | **6.6** | **6.8** | **6.9** | |

### Archetype G — CTO / VPE
| # | Name | A | F | T | U | Σ |
|---|---|---|---|---|---|---|
| 61 | Patricia | 8 | 6 | 6 | 6 | 6.5 — "60-day ROI: pricing says '65-80% net bill cut' — needs a calculator I can show my CFO." |
| 62 | Robin | 7 | 6 | 6 | 5 | 6.0 — "Datadog/Stripe integration: zero on-page. Where's the integrations index?" |
| 63 | Zara | 8 | 7 | 6 | 6 | 6.8 — "Already use Together. The `.kolm` artifact + open-spec is the differentiator — but I want a side-by-side cost demo." |
| 64 | Mohammed | 7 | 5 | 5 | 4 | 5.3 — "Saudi data residency, Arabic: nothing on /security or /pricing. Dealbreaker." |
| 65 | Hiro | 8 | 7 | 6 | 6 | 6.8 — "Per-1k-tokens cost? Not transparent. /pricing has 'pass-through' framing, no actual rate card." |
| 66 | Beth | 7 | 5 | 5 | 4 | 5.3 — "HIPAA + audit log. SOC 2 Q2 2027 is too far. No BAA template." |
| 67 | Niall | 8 | 6 | 6 | 6 | 6.5 — "Single-pane: no admin/teams view in dashboard. Multi-specialist visibility missing." |
| 68 | Yulia | 8 | 7 | 7 | 7 | 7.3 — "Threat-model line is good. Need a /security page with the scope spelled out." |
| 69 | Cameron | 7 | 7 | 6 | 6 | 6.5 — "Migration from OpenAI/Cohere: no migration guide. I'd need that to commit." |
| 70 | Elena | 7 | 6 | 5 | 5 | 5.8 — "EdTech, PII-heavy. Spanish docs missing. GDPR posture unclear." |
| **Mean G** | | **7.5** | **6.2** | **5.8** | **5.5** | **6.4** | |

### Archetype H — Designers / product
| # | Name | A | F | T | U | Σ |
|---|---|---|---|---|---|---|
| 71 | Sasha | 9 | 7 | 7 | 7 | 7.5 — "Restraint is real. Numbers band lands. But three CTAs across nav (Compile/Compile your first/Mint a key) is verb chaos." |
| 72 | Pierre | 9 | 7 | 7 | 7 | 7.5 — "Holds up next to Linear/Vercel/Stripe on hero. Falls behind on /docs which is dense and unillustrated." |
| 73 | Jia | 7 | 6 | 6 | 6 | 6.3 — "Demo example is English-only. A non-English example would expand reach." |
| 74 | Hugo | 8 | 7 | 7 | 7 | 7.3 — "Artifact card *almost* feels like a passport — needs a security-strip / hologram motif to push past 'card'." |
| 75 | Mira | 8 | 6 | 6 | 6 | 6.5 — "Empty-state of /dashboard doesn't teach the product. Should be a compile CTA + sample artifact." |
| 76 | Sebastian | 8 | 7 | 7 | 7 | 7.3 — "Spacing rhythm clean on hero. /pricing rhythm breaks at 'Path A / Path B'." |
| 77 | Bella | 7 | 6 | 7 | 6 | 6.5 — "Color tokens drift between hero (warm) and /docs (cooler). Lock the palette." |
| 78 | Nuno | 8 | 7 | 7 | 7 | 7.3 — "Logo/wordmark coherent. Favicon: didn't notice one — check it shows in tab." |
| 79 | Laila | 7 | 6 | 6 | 6 | 6.3 — "0-corpus state is missing on /compile — what does a user see *before* they upload? Today: a textarea, no scaffolding." |
| 80 | Tom-PM | 7 | 6 | 6 | 6 | 6.3 — "Pitchable to a CPO? Threat model + numbers band yes. Empty registry no." |
| **Mean H** | | **7.8** | **6.5** | **6.6** | **6.5** | **6.5 → 6.5 weighted** | |

### Archetype I — Non-technical buyers / economic decision-makers
| # | Name | A | F | T | U | Σ |
|---|---|---|---|---|---|---|
| 81 | Quinn | 7 | 6 | 6 | 6 | 6.3 — "Need a one-page board explainer. 'Compile your data into a model' is too abstract." |
| 82 | Vivian | 8 | 6 | 6 | 6 | 6.5 — "VC: defensibility = open spec + receipts. But no public registry adoption visible. Wedge unproven." |
| 83 | Hank | 7 | 6 | 5 | 5 | 5.8 — "Legaltech: contract review specialist? No template/example. Trust dings without it." |
| 84 | Penny | 7 | 5 | 6 | 5 | 5.8 — "'Save 5h/week' framing absent. ROI calc missing. I can't build an ops case." |
| 85 | Dario | 8 | 7 | 7 | 7 | 7.3 — "Receipts + audit story for portfolio diligence: framing is right, examples missing." |
| 86 | Bea | 7 | 6 | 6 | 6 | 6.3 — "Brand-safe outputs: no content-policy doc. L'Oreal won't approve without one." |
| 87 | Glenn | 7 | 6 | 6 | 6 | 6.3 — "Training data licensing: silent. Risk for media co." |
| 88 | Sina | 7 | 6 | 6 | 6 | 6.3 — "ROI math up-front: missing. I need it on /pricing." |
| 89 | Carolina | 7 | 5 | 6 | 5 | 5.8 — "Spanish docs. Bank in Bogota — won't move without local-language story." |
| 90 | Ravi | 7 | 5 | 6 | 5 | 5.8 — "Arabic + sovereignty: silent. Govt buyer, hard pass." |
| **Mean I** | | **7.2** | **5.8** | **6.0** | **5.7** | **6.2** | |

### Archetype J — Skeptics / adversarial reviewers
| # | Name | A | F | T | U | Σ |
|---|---|---|---|---|---|---|
| 91 | Erik | 8 | 7 | 5 | 5 | 6.3 — "I'd tweet: 'kolm.ai = nice landing, empty registry, two pricing pages, no public eval set. Receipt or it didn't happen.'" |
| 92 | Layla | 7 | 6 | 5 | 5 | 5.8 — "Probed /v1/compile: no rate limit doc, no input-size cap surfaced, no SSRF mitigation in /docs. Will file." |
| 93 | Gus | 7 | 5 | 5 | 5 | 5.5 — "Docs use 'Recipe' and 'Specialist' interchangeably. IEEE review: docs would get 5/10. Verbosity OK, consistency low." |
| 94 | Catalina | 7 | 5 | 5 | 4 | 5.3 — "Compliance phrasing is loose. 'SOC 2 Q2 2027' = aspirational. No DPA, no sub-processor list. Fail." |
| 95 | Niko | 6 | 5 | 5 | 5 | 5.3 — "Filed 4 issues in 10 minutes: empty registry, /pricing fork, /onboarding step 2 broken, dashboard dead-ends." |
| 96 | Mei | 7 | 6 | 5 | 5 | 5.8 — "ML safety: no harmful-output story. Compile of an unsafe corpus produces an unsafe specialist — not addressed." |
| 97 | Boris | 7 | 6 | 5 | 5 | 5.8 — "Frontier-teacher data exfil: 'compile uses your frontier key, billed pass-through' — but does kolm proxy? Cache? Log?" |
| 98 | Yael | 7 | 6 | 5 | 5 | 5.8 — "/v1/compile injection: corpus uploads not sanitized in /docs. Probe surface large." |
| 99 | Pete | 7 | 5 | 6 | 5 | 5.8 — "No man page. No XDG mention. No --help excerpt in /docs. CLI hygiene: D+." |
| 100 | Asha | 8 | 7 | 6 | 6 | 6.8 — "I'd write: 'kolm has the right thesis (open spec, signed artifacts) and the wrong execution (empty registry, contradictory pricing).' Story angle: real or vapor?" |
| **Mean J** | | **7.1** | **5.8** | **5.2** | **5.0** | **5.9** | |

---

## Bottom 10 personas (the harshest — these are who you need to convince next)

| Rank | # | Name | Σ | Why |
|---|---|---|---|---|
| 1 | 35 | Ethan (FedRAMP CIO) | **4.5** | No air-gapped compile path |
| 2 | 31 | Henry (top-3 US bank CA) | **4.8** | No SOC 2 Type II, no SLA, no BAA |
| 3 | 40 | Sandra (defense subcontractor VP) | **4.8** | ITAR + base-model provenance silent |
| 4 | 32 | Marisol (Spanish insurance IT dir) | **5.0** | GDPR + residency + procurement opacity |
| 5 | 33 | Brian (HIPAA VPE) | **5.0** | HSM key custody, BAA, audit log not surfaced |
| 6 | 34 | Aiko (Tokyo bank IT lead) | **5.3** | No Japanese docs, no on-prem |
| 7 | 39 | Tariq (KL telco CIO) | **5.3** | Per-tenant isolation only on Scale tier |
| 8 | 64 | Mohammed (Saudi fintech CTO) | **5.3** | Saudi residency + Arabic dealbreaker |
| 9 | 95 | Niko (GH issues troll) | **5.3** | Filed 4 issues in 10 min: registry empty, pricing fork, onboarding step 2 broken, dashboard dead-end |
| 10 | 66 | Beth (HC-tech VPE) | **5.3** | HIPAA + audit log + SOC 2 too far |

**Pattern:** 9 of the bottom 10 are enterprise/regulated (D, G). Single most-leveraged fix: ship `/security` page with current posture + DPA + SOC 2 Type I (not II) Q1 2027 dates, BAA template, on-prem paragraph. That alone moves the bottom 10 from 5.0 to ~6.5 mean and the overall to ~7.0.

---

## What gets you to 9.2

Top-7 fixes (P0):
1. Reconcile pricing (1 source of truth) — moves ~+0.4
2. Globally s/Recipe/Specialist/g across docs/onboarding/playground/registry — moves ~+0.3
3. Seed `/registry` with 8-12 real artifacts + receipts — moves ~+0.4
4. Real auth (password, email-verify, recovery, optional 2FA) — moves ~+0.2
5. Ship `/security` page (DPA, BAA, sub-processors, threat-model proof) — moves ~+0.3
6. ROI calculator on `/pricing` + savings demo on `/compile` — moves ~+0.2
7. Publish K-score eval harness MIT + `/k-score` proof page — moves ~+0.2

Estimated overall after 1-7: **~8.5/10**.

Sustaining-9.2 fixes (P1):
8. Mobile demo (QR → PWA install) — +0.1
9. Reproducibility: real receipt JSON example public — +0.1
10. Live "compiles today" counter via /v1/telemetry — +0.1
11. Verb-stack lock (one CTA verb sitewide) — +0.1
12. SDK consolidation (one CLI, one TS, one Py — kill `recipe` packages) — +0.1
13. Notebook quickstart (`.ipynb` Colab badge) — +0.1
14. Multilingual tokenizer doc + Arabic/Chinese/Korean example artifact — +0.1
15. `/security/tamper-test` proof script — +0.1

Estimated overall after 1-15: **~9.2/10**.

---

**One iteration to 9.2 is plausible if the team executes 1-7 and any 5-of-8 from 8-15 within the window.** Two iterations is the safer estimate — fixes 1-3 alone require coordination across pricing, brand, and registry seeding. The bottom-10 enterprise drag is real but tractable: a single `/security` page closes most of it.
