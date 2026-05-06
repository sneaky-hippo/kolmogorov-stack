# Recipe — Strategy v3

> Written 2026-05-06 after a second hard critique. v2 ("savings autopilot") solved the wedge problem
> but described a feature, not a category. v3 names the category: **Recipe is the spec layer of AI.**
> Savings is how we get in the door. Verifiable, ownable, durable AI behavior is what we sell forever.

---

## TL;DR

Today there is no spec layer for AI. Every prompt is vibes. Every output is unverifiable. Every
agent call is unrepayable, unauditable, and undurable. The trillion-dollar agentic economy that
everyone is racing to build has *no contracts* — and that is the structural gap.

**Recipe is the open spec, the verified runtime, and the cryptographic receipt for AI behavior.**

The savings wedge ("paste examples, cut your bill 80%") is real and gets us in the door at every
AI-native company in the world. But the durable product is the **TCP/IP for the agentic web**:

1. An **open specification** of "AI behavior contracts" (Recipe Spec / RS) that anyone can implement.
2. A **synthesis engine** that compiles examples into spec-compliant deterministic functions.
3. A **public registry** of verified, attested behaviors that compounds with every user.
4. A **specialist tier** that turns specs into local LoRAs you own forever.
5. A **receipts layer** — every AI action shipped via Recipe gets a cryptographic attestation
   that anyone, anywhere, can verify against the open spec.

Five surfaces. One thesis. **Recipe is the layer that makes AI behavior programmable, ownable,
and provable.** That is a $100B category, not a $10B feature.

**Tagline: "The spec layer of AI."**
**Subhead: "Make AI behavior programmable, ownable, and provable."**

---

## The honest critique of v2

v2's "AI bill cutter on autopilot" framing was a real improvement — it gave us a wedge and a
buyer (the CFO of any AI-native company). But three structural problems remained:

1. **Savings is a budget item, not a category.** Cost-cutting tools get bought during downturns
   and forgotten in expansions. The category we want sits *above* "cost optimizer" — at the
   level of "the way you ship AI."
2. **Pricing aligned with savings is intrinsically capped.** If we take 10% of savings, our
   ceiling is a fraction of someone else's bill. We need a positioning where the value scales
   with the *durability* of the AI we deliver, not the *waste* it eliminated.
3. **No structural moat against the "Helicone clones synthesis" threat.** Anyone with a Claude
   key can build a primitive synthesis engine in a quarter. The moat must be the spec, the
   network effect of the registry, and the cryptographic verification layer — none of which can
   be cloned without a clean-room equivalent of years of standardization work.

v2 solved the marketing problem. v3 solves the moat problem.

---

## What we actually have, restated against the new thesis

Stripping the savings narrative, the assets we already shipped are the components of an **AI
behavior contract layer**. Re-mapping:

| Asset | v2 framing | v3 framing |
|---|---|---|
| Synthesis engine | "examples → JS function" | **Spec compiler** — examples → spec-compliant verified executable |
| Verifier (`>=95%` gate) | "we don't ship bad recipes" | **Conformance test runner** — proves a recipe matches its spec |
| Edge runtime | "30µs cheap calls" | **Reference implementation** of the spec; runs anywhere JS runs |
| Registry | "find existing recipes" | **The npm/pkg.go.dev/sigstore for AI behavior** — discovery + attestation |
| Specialists scaffold | "fine-tune a LoRA" | **Sovereign-ownership tier** — convert a spec into weights you alone control |
| Bridges/observe | "find waste in your traffic" | **Spec discovery from existing prompts** — reverse-engineer specs from production traffic |

Same code. Bigger story. Each artifact is now load-bearing in a category-defining product.

---

## What is the spec layer of AI? (first principles)

Every other widely-adopted technology has a spec layer:

| Domain | Spec layer | Why it won |
|---|---|---|
| Networks | TCP/IP | Open, anyone can implement; the standard *is* the network |
| Web pages | HTML/CSS | Open spec, browsers compete on quality of implementation |
| Databases | SQL | Standardized query contract; vendors interoperate |
| Containers | OCI | Replaced proprietary Docker images with a portable spec |
| Code packages | npm / PyPI / cargo | Public registry + ownership rules + version contract |
| Identity/signing | sigstore / x.509 | Cryptographic attestation that a thing is what it claims to be |
| AI behavior | **none today** | This is the gap |

There is **no** universally accepted way to say "this AI agent will, given input X, produce output
Y, deterministically, and here is a cryptographic proof." Today the only answer is "trust
OpenAI / Anthropic / your fine-tuned model." That is unsustainable at agentic scale.

What's the unit of an AI spec? A *behavior contract*: a labeled set of (input, expected) pairs,
plus an output-shape schema, plus a verification gate. Three machine-readable artifacts:

1. **Examples manifest** — the canonical (input, expected, weight) tuples.
2. **Output schema** — the type / structure / value-set the output must conform to.
3. **Conformance trace** — a reproducible test trace produced when the spec was last verified.

A *recipe* is a synthesized executable that matches a spec. Multiple recipes can match one spec
(different runtimes, different models). But the spec is the durable artifact.

This is the same shape as JSON Schema, OCI image manifests, OpenAPI, and protobuf. None of those
existed before someone wrote the standard. We write the AI standard.

---

## The five surfaces of the Recipe platform (durable products)

Each is independently shippable and independently revenue-bearing. They compound.

```
                            ┌─────────────────────────────────────┐
                            │   1. RECIPE SPEC (RS) — open, MIT  │
                            │   "the JSON Schema of AI behavior"  │
                            └──────────────┬──────────────────────┘
                                           │
                            ┌──────────────┴──────────────────────┐
                            │   2. RECIPE ENGINE — synthesizer +  │
                            │   verifier + runtime (hosted + OSS) │
                            └──────────────┬──────────────────────┘
                                           │
       ┌──────────────────┬────────────────┼────────────────────┬────────────────────┐
       │                  │                │                    │                    │
   ┌───▼─────┐    ┌──────▼────────┐  ┌────▼─────────┐   ┌───────▼────────┐   ┌──────▼──────┐
   │3.REGISTRY│    │ 4.SPECIALISTS │  │ 5. RECEIPTS  │   │  AUTOPILOT     │   │  EDGE       │
   │ verified │    │ sovereign     │  │ cryptographic│   │  (savings      │   │  RUNTIME    │
   │ behaviors│    │ local LoRA    │  │ attestation  │   │   wedge)       │   │  (any JS)   │
   └──────────┘    └───────────────┘  └──────────────┘   └────────────────┘   └─────────────┘
       │                  │                │                    │                    │
       └──────────────────┴────────────────┴────────────────────┴────────────────────┘
                                  network effect compounds across all
```

### 1. Recipe Spec (RS) — open, MIT-licensed
- Public, machine-readable spec for AI behavior contracts (`spec.recipe.dev`).
- Versioned (RS-1, RS-2, etc.), with backwards-compatibility guarantees.
- Anyone can implement a Recipe-compliant runtime — including our competitors.
- We win by being the maintainer + hosting the canonical reference implementation.
- **Revenue:** none directly. The standard is the moat.

### 2. Recipe Engine — synthesizer + verifier + runtime
- Hosted SaaS (the current product).
- Open-source self-host package (released as v1.0).
- Includes the conformance test runner so any spec can be verified against any runtime.
- **Revenue:** SaaS subscription + per-call usage on hosted; consulting + support on self-host.

### 3. Registry — verified, attested, public
- Every published recipe has a cryptographic attestation: source_hash, spec_hash, runtime_version, signer.
- Browseable like npm. Searchable by spec. Forkable.
- Public recipes are free to use; private recipes are tenant-isolated.
- **Revenue:** marketplace cut (5–15%) on premium / commercial recipes; storage; private-registry SKU.

### 4. Specialists — sovereign local LoRA
- A spec compiles into a fine-tuned local model that the customer owns outright.
- Recipe stays free; Specialist is the high-margin add-on for fuzzy tasks.
- The customer never ships data to us during inference — sovereignty pillar.
- **Revenue:** train fee ($40–$1,000/spec) + optional hosting ($20/mo per active spec).

### 5. Receipts — cryptographic attestation
- Every recipe execution returns a signed receipt: `{ output, source_hash, input_hash, runtime_version, timestamp, hmac }`.
- Public verifier endpoint: anyone can re-execute and confirm.
- This is the durable compliance moat: EU AI Act, SOC 2, HIPAA, regulated-industry buyers literally cannot get this from any LLM provider.
- **Revenue:** Compliance Tier ($10K–$100K ACV) — receipts ledger, audit-export, verifier, retention.

The autopilot ("savings dashboard") is now correctly framed as a **demand-generation surface**
that converts buyers into users of the spec/registry/receipts layers.

---

## Why this is at the *core* of AI

Three vectors of inevitability:

### 1. The agentic economy needs contracts
Agents calling agents calling agents is a graph. Graphs need contracts at each edge or they are
unverifiable, unrepayable, and unscalable. Every multi-step agent today is a black box. Recipe is
the only contract format that is (a) compilable from examples, (b) deterministic at runtime, and
(c) cryptographically verifiable at audit time. The agentic web cannot scale without something
that does what Recipe does.

### 2. Regulation forces auditability
EU AI Act 2026, US state laws, sector-specific compliance (banking, healthcare, defense). The
question "prove this AI did what it was supposed to do" becomes a *required field* on every
production AI deployment. There is no off-the-shelf answer today. Recipe receipts are the only
shape that satisfies the requirement without locking the customer into a vendor.

### 3. The frontier-to-edge gradient
Frontier models are getting cheaper but stay slow and stochastic. Edge models are getting
better but require labels. Recipe is the bridge: front-runs the frontier where determinism is
needed (recipes), distills to the edge where ownership matters (specialists), and verifies
both ends with receipts. **We are the gradient.**

---

## Updated competitor map (against the new thesis)

The "savings tools" map (Helicone, Portkey, Predibase) still applies, but the v3 map is bigger:

### Standards-layer competitors (real threat)
| Player | What they do | Where we win |
|---|---|---|
| **OpenAI Structured Outputs** | JSON-schema-constrained generation | Tied to OpenAI runtime; no determinism; no cross-vendor portability; no ownership |
| **MCP (Anthropic)** | Tool-call protocol | Different layer — MCP wraps tools, Recipe defines behaviors. Complementary. We could become the canonical recipe-as-tool MCP server |
| **LangChain / LlamaIndex** | Orchestration glue | They are the wiring; we are the contract. They benefit if Recipe wins (every chain step gets a spec) |
| **AutoGen / DSPy** | Programmatic prompt optimization | Similar surface (examples → optimized program), but stays inside one model. Recipe outputs a portable function or LoRA |
| **W3C / IEEE AI working groups** | Slow, multi-year | We move 100× faster; they may eventually adopt our spec |

### Verification / receipts competitors
| Player | What they do | Where we win |
|---|---|---|
| **sigstore / cosign** | Signed container images | Wrong layer; we sign behaviors, they sign artifacts. We can integrate, not compete |
| **Helicone audit logs** | Request/response logs | Logs are not receipts; no spec, no replay, no determinism guarantee |
| **OpenAI Evals** | Evaluation framework | Internal-only; not a public spec or receipt format |

### Sovereign / on-device competitors
| Player | What they do | Where we win |
|---|---|---|
| **Apple Foundation Models** | First-party on-device LLMs | Closed ecosystem; Recipe specialists run anywhere |
| **Ollama / LM Studio** | OSS local-model runners | Distribution channels for Specialists, not competitors |
| **Hugging Face AutoTrain** | Fine-tune UI | Manual; Recipe synthesizes the data first, then trains |

### The actual #1 competitor (reiterated)
**Status quo: keep paying the LLM API.** Inertia is the enemy. Nothing in v3 changes this. Self-serve install + 24-hour-receipt loop is still the wedge.

---

## Why this earns a $100B+ category, not a $10B feature

**Math:**
- Global LLM-API spend ~$50B → $200B by 2030. Savings tier: 5% capture = $10B revenue.
- Cumulative AI compliance market (EU AI Act + sector rules) ~$30B by 2030. Receipts tier: 5% = $1.5B.
- Sovereign / local-model market (Apple-style on-device) ~$80B in licensing + tools by 2030. Specialists tier: 2% = $1.6B.
- Marketplace / registry (compare: npm/PyPI run "free," but the JFrog / npm-Inc / GitHub-packages backers monetize at $5–10B revenue): 1% capture = $1B.
- Spec-licensing royalties (compare: ARM, MPEG-LA): 10–100bp on devices/agents using the spec: $0.1–1B.

Add the surfaces, conservatively:
**$10B + $1.5B + $1.6B + $1B + $0.5B ≈ $14.6B revenue floor by 2030 → 30× → $400B valuation.**

Aggressive (capture 10% across surfaces): >$1T outcome.

The point: **the savings wedge alone is a great business. The spec layer is a category-owning business.** v3 positions for the latter while still landing the former on the way in.

---

## SWOT — v3 (the spec-layer thesis)

### Strengths
- **First-mover on a category that doesn't exist yet.** Spec layers reward whoever publishes the standard first and earns mindshare; today there is no standard.
- **Three independently moats compound.** (a) the open spec earns adoption; (b) the registry compounds with users; (c) the receipts layer is technically inimitable by stochastic-LLM vendors.
- **Synthesis engine is already shipped.** Most "spec layer" plays are pure standards; we have a working compiler from day 1, which makes the spec usable, not just declared.
- **Edge / sovereign story unique.** No frontier-lab competitor can credibly say "you own the model and run it without us." Our specialists tier does exactly that.
- **Aligned with regulatory tailwind.** Compliance-driven adoption is hard to lobby against; we sell the answer to the question regulation forces buyers to ask.

### Weaknesses
- **Standards-as-strategy takes years to compound.** TCP/IP, OCI, JSON Schema all took 3–7 years from publication to dominance. We need bridge revenue (the savings + receipts tier) to fund the marathon.
- **No flagship buyer for the receipts SKU yet.** Need 2–3 named compliance-anchored deployments before the EU AI Act narrative is real instead of theoretical.
- **Spec governance is hard.** Pulling a spec inside a single company's control invites forks. We'll need a governance model (foundation? committee? BDFL?) within 6 months.
- **Solo-founder velocity vs. ecosystem-defining ambition.** Standards usually emerge from coalitions. We need to make the spec self-perpetuating (good docs, conformance suite, reference impl) so it doesn't depend on us forever.

### Opportunities
- **EU AI Act enforcement begins 2026.** First wave of compliance demand is now.
- **Agent frameworks (LangChain, CrewAI, AutoGen) need a portable behavior contract.** We can become the canonical "behavior" type in their stacks.
- **MCP adoption growing fast at Anthropic.** Recipe-as-MCP-server makes us a first-class integration in Claude Code, Claude Desktop, and any agent that speaks MCP.
- **OSS small-model boom (Qwen, Llama, SmolLM, Phi).** Specialists tier is exactly the workflow these communities lack.
- **Cloudflare / Vercel / Deno edge platforms** all want a deterministic, sub-ms primitive for AI; we ship one.

### Threats
- **OpenAI / Anthropic publish their own behavior-spec.** Real risk; mitigation = move first, position as vendor-neutral.
- **An OSS competitor open-sources synthesis with a permissive license and gives the engine away.** Synthesis alone is not the moat; the spec + registry + receipts are. Have to publish openly first to claim the category.
- **A foundation (LF AI? OpenSSF?) launches a competing spec.** Get ahead of this — submit RS to relevant foundations in year 2; we want partners, not adversaries.
- **EU AI Act gets watered down.** Demand for receipts softens. Mitigant: receipts also serve SOC 2, internal audit, and procurement needs that don't depend on EU regulation.

---

## Pricing — re-cast for the durable product

The savings-aligned pricing from v2 stays for the autopilot wedge. v3 adds two new SKUs that are
the durable revenue:

| Tier | Price | Includes |
|---|---|---|
| **Free** | $0 | Public spec, public registry, 10K calls/mo, anon CLI |
| **Growth** | $99/mo + 10% of savings | Autopilot, private registry, savings receipts (the wedge tier from v2) |
| **Verify** *(new)* | $499/mo flat | Cryptographic receipts, public verifier integration, 1M signed calls/mo, audit export |
| **Compliance** *(new)* | $5,000/mo+ | EU AI Act ready, SOC 2 evidence pack, retention guarantees, on-call audit support |
| **Scale** | $1K/mo + 5% of savings | Specialists, VPC, SLA |
| **Enterprise** | custom | Air-gapped, custom registry, contractually defined receipts retention |

The Verify and Compliance tiers monetize the cryptographic receipts moat directly, independently of any savings claim. They are sold to procurement, infosec, and legal — not just engineering.

---

## Distribution v3 — riding existing standards adoption curves

Same wedges as v2 (CLI, IDE, SDK, audit funnel) plus three v3-specific plays:

### 1. The Open Spec Launch
- Publish RS-1.0 at `spec.recipe.dev` on a hard date.
- Post to HN, X, Lobsters with a working conformance suite.
- File issues against LangChain / LlamaIndex / DSPy / etc. asking them to adopt RS.
- 12–18 months of intentional evangelism. The spec is the permission to claim the category.

### 2. Conformance program
- "Recipe-compatible" badge for any runtime that passes the conformance suite.
- Encourage Cloudflare Workers, Vercel Edge, Deno, Bun, Hono, Cloudflare AI Gateway to ship Recipe-compatible runtimes.
- Each compatible runtime is a free distribution channel.

### 3. Compliance partnership wedge
- Co-sell with audit firms (KPMG, PwC, Deloitte) and compliance-tooling vendors (Drata, Vanta, Tugboat Logic).
- They get a tangible "AI evidence pack" to bundle into SOC 2 / EU AI Act audits.
- We get warm intros to enterprises during the audit window — when they have to act.

---

## Roadmap — sequenced for compounding

### P0 (this week — surface the new positioning)
- [x] STRATEGY-v3.md — this document
- [ ] Homepage hero rewritten to "spec layer of AI" with savings as proof
- [ ] `/spec` page — public Recipe Spec v0 (working draft) with machine-readable JSON
- [ ] `/receipts` page — explainer + live verify form
- [ ] Backend: `/v1/run` returns a `receipt` object with HMAC signature
- [ ] Backend: `/v1/receipts/verify` endpoint that recomputes and confirms a receipt
- [ ] Backend: `/v1/spec` endpoint serving the canonical spec JSON

### P1 (next 30 days — operationalize the standard)
- [ ] Conformance test suite as `@kolmogorov/recipe-conformance` npm package
- [ ] Conformance badge / website (`recipe-compatible.dev`)
- [ ] Open-source repo for the spec at `recipe-spec/recipe-spec`
- [ ] Reference Cloudflare Workers runtime implementation
- [ ] Submit RS-1 RFC to LangChain + LlamaIndex + DSPy
- [ ] First named flagship customer (savings *and* receipts)

### P2 (next 90 days — defend and extend)
- [ ] Specialists v1 ships (LoRA-as-a-service, sovereign weights)
- [ ] EU AI Act compliance pack (audit export, retention, on-call audit support)
- [ ] Registry marketplace (commercial recipes with revenue share)
- [ ] Receipts ledger UI + signed-export capability
- [ ] First three case studies with named buyers

### P3 (next 180 days — earn the category)
- [ ] Recipe Foundation (governance body) chartered
- [ ] Multiple Recipe-compatible runtimes shipped (Cloudflare, Vercel, Deno, Bun)
- [ ] First "Recipe-compatible" badge issued to a non-us runtime
- [ ] First academic paper citing Recipe Spec
- [ ] Marketplace + Specialists revenue exceeds savings revenue (the moat shifts)

---

## What changes today

A small but decisive set of product moves operationalize v3:

1. **Homepage** repositions: hero is "the spec layer of AI"; savings becomes proof. (1 file edit.)
2. **`/spec` page** ships RS-1 working draft + JSON manifest format. (1 new file.)
3. **`/receipts` page** ships with a live verify demo. (1 new file.)
4. **Backend receipts:** every `/v1/run` returns a signed receipt. New `/v1/receipts/verify` endpoint. (~80 LoC in router.js + a small helper module.)
5. **`/v1/spec` endpoint** serves the canonical RS-1 JSON spec. (~20 LoC.)

Nothing else changes structurally. Everything from v2 is still right; v3 just zooms out and gives the savings story a category to live inside.

---

## Why this is the best version of the future

> "AI today is unverifiable. Recipe makes AI behavior programmable, ownable, and provable."

The world we're betting on:
- Every production AI call is wrapped in a Recipe spec.
- Every output ships with a receipt anyone can verify.
- Every fuzzy task that needs intelligence has a Specialist the customer owns.
- Every developer searches the Recipe registry before writing a prompt — like searching npm before
  writing a function.
- Every regulator audits AI by replaying receipts against published specs.
- Every cost-conscious team uses the autopilot to find waste — and cuts their bill 80% as a
  side-effect of doing the right thing.

The savings story sells the install. The spec story sells the future. Same product. Two narratives.
We win on whichever the customer is ready to hear first, and the durable revenue compounds on the
back of both.

This is the most defensible and most ambitious framing of what we already have, and it puts us at
the architectural center of the next decade of AI. **No serious AI deployment, in five years,
should ship without a Recipe spec, a registry-attested implementation, and a verifiable receipt.**

That is the product of the future. We are exactly six product moves away from offering it today.
