# Homepage Claim Regression Audit - 2026-05-13

## Executive Summary

The current claim gate is doing useful work, but the homepage surface has drifted again.

The focused site test now fails because local `public/index.html` contains the forbidden regulated-healthcare phrase `PHI stays inside the customer-hosted bridge`. That is only the visible symptom. The same file also contains metadata, structured data, FAQ answers, demo copy, and use-case cards that imply shipped model-bearing artifacts, phone/on-device execution, VPC/local deployment, zero-egress behavior, automatic improvement, and commercial/compliance entitlements.

The live site is a different risk. As of this review, live `https://kolm.ai/` still presents an older model-artifact story: a model compiled from user data, multi-GB artifact, phone support, public-key-looking signature language, public registry anchoring, on-chain receipt language, and mobile/enterprise packaging. Live `https://kolm.ai/docs` also remains on the older recipe-era API and package surface. That means there are two claim surfaces to control:

- local homepage regression before the next deploy.
- live stale pages that remain public until replaced.

The safest release rule is simple: the homepage should only claim what the artifact tests and source currently prove. Today that is recipe-tier artifacts with manifest, recipes, evals, HMAC receipt mode, local deterministic JS execution, fixture benchmarks, tamper detection, and monitored benchmark egress. Model weights, LoRA deltas, phone-native runtime, public-key receipts, on-chain anchoring, VPC/private-deployment defaults, and regulated-data guarantees need explicit target-architecture or customer-controlled-deployment labels.

## Primary Evidence

- `node --test .\tests\site.test.js` failed on May 13 with one claim-gate failure: `public\index.html` contains `PHI stays inside the customer-hosted bridge`.
- The same local homepage includes meta/OG/Twitter descriptions saying the artifact contains model plus examples plus evaluator plus receipts and runs on a laptop or phone while data never moves.
- Local JSON-LD in `public/index.html` describes a signed artifact running on a laptop, phone, or inside a network, on-device runtime with zero egress, optional Sigstore co-signature, BAA availability, and optional VPC peering.
- Local homepage FAQ text says each compile is strictly better than the last and that the `.kolm` file contains a small model.
- Local use-case cards say Kolm builds a signed local model, healthcare data does not leave the network, phone inference runs with zero network, and a single signed file runs on an on-device deployment.
- Local scripted demo text says the compile specializes a model, stamps K-score, writes a patient-intake artifact, and returns a run result with host set to on-device.
- Live `https://kolm.ai/` returned HTTP 200 and still says Kolm compiles data into a model, returns an artifact that can run offline, shows a multi-GB artifact, uses public-key-looking signature copy, mentions model/LoRA/draft pack/index, phone support, public registry anchoring, and on-chain receipts.
- Live `https://kolm.ai/docs` returned HTTP 200 and remains on the older docs surface: it says 21 endpoints, uses legacy package/install guidance, points examples at the old hosted API, and ends with old brand positioning.
- The source truth remains narrower: `src/artifact.js` says `model.gguf` is a pointer record, not weights; the LoRA tier is future; `lora.bin` is an optional behavior-pack slot; `receipt.json` and `signature.sig` are HMAC-based today.
- `src/compile.js` says the current compile produces a cloud-runtime artifact and LoRA training ships later.
- `src/router.js` comments state public-key receipt mode is roadmap and current receipt verification recomputes HMAC server-side or through shared-secret mode.
- `tests/artifact-end-to-end.test.js` remains the best proof anchor for current artifacts: signatures, embedded evals, benchmark zero egress, tenant params, audit callback, input cap, and tamper rejection.

## What Is Working

The local claim gate is valuable. It caught the regulated-healthcare phrase as a release-blocking failure. The focused site suite also verifies encoding hygiene, public inline script parsing, referenced assets, routes, sitemap shape, signup surfaces, and SDK brand shape.

The codebase has strong enough proof to support a homepage, but not the homepage currently in the worktree. The proof-backed story should start from the four verified fixture artifacts, artifact anatomy, HMAC receipt truth, and benchmark report behavior.

## Main Gaps

The claim gate is exact-string based. It blocks `PHI stays inside the customer-hosted bridge`, but it does not block equivalent phrases such as data never moves, zero network, inference on the phone, VPC boundary, on-device runtime with zero egress, or strictly better compiles. Those phrases create the same buyer expectation as the blocked phrase.

The local homepage has risky structured data. Search engines and link previews can consume metadata and JSON-LD even when visible body copy is later corrected. The homepage currently embeds claims about model contents, on-device runtime, zero egress, BAA, VPC, Sigstore, and pricing/entitlements in machine-readable fields.

The live site remains behind the safer local research. The live homepage and docs still present older product and package claims that have already been flagged by earlier audits. A passing local gate would not prove the live site is safe unless a deploy parity smoke fetches and scans live pages too.

The homepage points high-risk regulated examples at healthcare, legal, finance, device, and edge before those pages have proof bundles, compliance owner review, or launch labels. This is avoidable: the homepage can link those areas as target patterns while the proof-backed demos stay generic or use the verified fixtures.

## Recommended Gate

Before deploy, require a homepage claim gate with four checks:

1. Local static scan: existing `tests/site.test.js`, expanded with phrase families instead of only exact strings.
2. Structured-data scan: parse meta tags, OG/Twitter fields, JSON-LD, FAQ schema, and offer schema for forbidden claims.
3. Proof-link scan: every claim about model, phone, VPC, airgap, regulated data, public-key receipts, on-chain anchoring, or automatic improvement must link to a proof artifact or be labeled target architecture.
4. Live parity scan: fetch live home, docs, pricing, device, healthcare, FAQ, API, benchmarks, and compare forbidden-pattern results against the local build before and after deployment.

## Buyer Impact

The homepage is the highest-leverage trust surface. If it overclaims, every later page has to repair buyer expectations. The release-safe homepage should be boringly precise: "recipe-tier artifacts run locally today; model-bearing and mobile-native runtimes are next gates." That is less flashy, but it matches the evidence and keeps Kolm credible with technical and regulated buyers.
