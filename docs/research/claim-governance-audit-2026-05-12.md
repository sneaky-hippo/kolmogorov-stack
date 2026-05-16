# Claim Governance Audit

Review date: 2026-05-12

Scope:

- Live pages sampled from `https://kolm.ai/`: home, pricing, docs, device.
- Local public pages under `public/*.html`, `public/use-cases/*.html`, `public/articles/*.html`, and `public/cookbook/*.html`.
- Test gate: `tests/site.test.js`.
- Code truth baseline: `README.md`, `src/artifact.js`, `src/compile.js`, `src/router.js`, `src/verifier.js`, and artifact tests.

The detailed sheet is `claim-audit-2026-05-12.csv`.

## Executive Read

The public claim surface is ahead of the current implementation in several places. The safest current proof is recipe-tier `.kolm` artifacts: signed zip, manifest, recipes, evals, HMAC receipt chain, local recipe execution, fixture benchmarks, zero monitored egress in tests, and tamper detection.

The riskiest claims imply shipped model-bearing artifacts: local model weights, LoRA deltas, sqlite-vec indexes, phone runtimes, React Native SDKs, public-key or on-chain receipts, HIPAA readiness, and VPC/airgap deployments as current defaults.

The codebase already knows the truth. The README and long-form articles say the current product is recipe-tier/pointer-tier and that native model execution, LoRA packaging, and device benchmarks are future or deployment-specific work. The homepage, FAQ, API page, mobile page, healthcare metadata, and live site need to follow that standard.

## Top P0 Claim Risks

| Risk | Evidence | Code Truth | Required Fix |
| --- | --- | --- | --- |
| Live homepage says offline model artifacts with LoRA, ed25519, public-registry anchoring, and on-chain receipts. | `https://kolm.ai/` lines 11-13, 45, 75-78, 131, 141, 213. | Current artifacts are recipe-tier or pointer-tier, receipts are HMAC, and on-chain/public-key receipt modes are not shipped. | Replace live homepage with v0-accurate copy or ship proof first. |
| Live pricing/docs still use Recipe/REM Labs and old package/API language. | `https://kolm.ai/pricing` and `https://kolm.ai/docs`. | Local repo has Kolm branding and much broader/current API surface. | Redeploy current docs/pricing from repo after claim cleanup. |
| Local FAQ says `.kolm` contains base model and personal LoRA. | `public/faq.html` lines 86, 141, 153. | `src/artifact.js` currently writes model pointer metadata and optional pack/index slots. | Rewrite artifact-tier FAQ. |
| Local API docs say compile fits/trains LoRA and auto-distill ships signed `.kolm`. | `public/api.html` lines 333, 510, 591-605. | `src/compile.js` marks LoRA as Sprint 3; auto-distill is bridge-dependent and can return 503. | Mark LoRA/auto-distill as preview. |
| Mobile page claims iPhone/Pixel support and SDK/runtime performance. | `public/use-cases/mobile.html` lines 153-154, 198-214, 238-256. | The page itself says RN module is preview and today is browser-WASM via WebView. | Move tables to target/roadmap until benchmarks and SDK packages exist. |
| Healthcare metadata says HIPAA Security Rule mapped and PHI stays inside the customer-hosted bridge. | `public/healthcare.html` lines 176-177. | Page body has a better disclaimer that public product is not HIPAA certification. | Make SEO metadata match the disclaimer. |

## Good Claim Patterns To Reuse

These are closer to the code evidence and should be copied into higher-risk pages:

| Source | Why It Works |
| --- | --- |
| `public/articles/ai-compiler.html` lines 209, 231, 234, 269, 281 | It says the current public product proves recipe-mode artifact path and that native model packaging/device runtimes require bridge work and benchmarks. |
| `public/articles/hipaa-on-device.html` lines 301, 304-305 | It distinguishes mature local deployment from current public product and says native weights/LoRA/sqlite-vec require completed bridge and benchmarks. |
| `public/benchmarks.html` lines 155, 316, 335-336 | It anchors proof in embedded evals, offline benchmark harness, monitored egress, and HMAC integrity. |
| `public/build-your-own.html` lines 239, 256, 260-261 | It correctly scopes local authoring to HMAC local secrets, zero-egress benchmark monitoring, and no compliance attestation. |
| `public/defense.html` from prior scan | It explicitly says FedRAMP/CMMC/ITAR remain customer-led compliance work, not public certifications. |

## Claim Vocabulary Rule

Use current-tier language:

- "recipe-tier artifact"
- "signed zip with manifest, recipes, evals, receipt"
- "model pointer record in v0"
- "HMAC receipt mode"
- "public-key receipt mode is roadmap"
- "local JS recipe execution"
- "runtime target matrix"
- "customer-controlled deployment required for PHI/VPC/airgap"
- "LoRA/Specialist bridge preview"

Avoid unqualified language until proof exists:

- "model, LoRA, draft pack, index"
- "student baked in"
- "runs on a phone"
- "HIPAA Security Rule mapped"
- "PHI stays inside the customer-hosted bridge"
- "zero runtime egress" for non-recipe artifacts
- "on-chain receipts"
- "ed25519 verified"
- "self-hosted"
- "in your environment" as a default hosted-product claim
- "every run makes it better"

## Release Gates

| Gate | Implementation |
| --- | --- |
| Local forbidden claim scan | Keep and expand `tests/site.test.js` forbidden patterns. |
| Live claim scan | Fetch home, pricing, docs, healthcare, FAQ, API, mobile, device, benchmarks, and run the same forbidden-pattern set against live HTML. |
| Route/docs parity | Generate or maintain a route manifest and compare docs endpoint count against actual routes. |
| Artifact proof gate | Any page saying "model", "LoRA", "phone", or "offline" must link to a passing artifact or benchmark proving that tier. |
| Compliance claim owner | Healthcare, BAA, DPA, SOC 2, HIPAA, FedRAMP, ITAR, and EU AI Act copy must carry last-reviewed date and owner. |

## Next Edits To Make

1. Replace live `kolm.ai` home/pricing/docs with current Kolm-branded copy after fixing local overclaims.
2. Rewrite `public/faq.html` artifact definition into tiered reality.
3. Move `public/use-cases/mobile.html` performance and SDK tables behind "target architecture" language.
4. Split `public/api.html` into shipped endpoints vs preview endpoints.
5. Make `public/healthcare.html` metadata as careful as its body disclaimer.
6. Add a live-site forbidden-pattern smoke command to CI or deployment checklist.

