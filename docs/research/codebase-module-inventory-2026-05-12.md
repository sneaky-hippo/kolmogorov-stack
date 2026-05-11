# Codebase Module Inventory

Review date: 2026-05-12

Scope: `C:\Users\user\Desktop\kolmogorov-stack`

This inventory complements the strategic gap review by mapping what is actually present in the repo: runtime modules, route groups, tests, SDK surfaces, and proof gaps.

## Executive Summary

The Kolm codebase is a working single-node product stack, not just a landing page. It includes an Express API, public site, compile pipeline, signed `.kolm` artifact builder, artifact runner, HMAC receipts, K-score, registry, recall/RAG scaffolds, capture bridges, tuning docs/code, CLI, JS/Python/MCP SDKs, and test coverage.

The main architecture risk is concentration: `src/router.js` is about 120 KB and owns 86 inline route declarations plus most product workflow glue. That gave the project velocity, but it now makes auth boundaries, production readiness, billing, specialist preview behavior, and public claims harder to audit. The next architecture improvement should split routes by domain after stabilizing the P0 trust issues.

## Source Module Map

| Module | Approx Role | Current Maturity | Notes / Risks |
| --- | --- | --- | --- |
| `server.js` | Express app bootstrap, security headers, static routing, docs aliases, public page fallbacks, router mount. | Launchable | Static route behavior is explicit and covered by site tests. |
| `src/router.js` | Central API router for public, auth, compile, registry, recall, billing, specialists, bridges, capture, admin. | Broad prototype | 86 inline route declarations; split by domain before scale. |
| `src/auth.js` | Tenant provisioning, anonymous tenants, key hashing/migration, API auth, rate/quota token bucket. | Useful v0 | In-memory rate buckets and simple tenant model are not enterprise-grade. |
| `src/store.js` | Generic row store with JSON default and optional SQLite backend. | Improved v0 | SQLite is a good bridge, but default remains JSON and data model is generic rows. |
| `src/env.js` | Runtime readiness, production detection, receipt-secret policy. | Good guardrail | Production readiness depends on correct env and storage choices. |
| `src/artifact.js` | `.kolm` payload builder, K-score, HMAC receipt chain, zip packaging, manifest signature verification. | Core v0 | Model file is pointer metadata; LoRA/index slots are behavior-pack placeholders today. |
| `src/artifact-runner.js` | Loads `.kolm`, verifies signature, decodes pack/index, runs recipes, emits audit/receipt. | Core v0 | Good offline recipe-tier proof; not a full local model runtime. |
| `src/benchmark.js` | Artifact benchmark report generation. | Useful proof base | Needs broader hardware/runtime benchmark matrix. |
| `src/compile.js` | Compile job creation and fire-and-forget orchestration. | Prototype | Uses in-process `Map`; LoRA/decompose stages are roadmap or simplified. |
| `src/synthesis.js` | Pattern-mode synthesis from examples into generator source. | Functional wedge | Synthesis alone is cloneable; moat must be spec/receipt/registry. |
| `src/verifier.js` | Runs candidate JS/WASM and scores examples/properties. | Demo-grade sandbox | Uses `node:vm` and denylist; not a hard security boundary. |
| `src/runtime.js` | Runs published registry concepts with compiled/output cache. | Functional | Needs strong tenant isolation and production cache strategy. |
| `src/cache.js` | Disk/L1 cache support. | Prototype | Local disk cache only; no shared eviction/durability story. |
| `src/library.js` | Standard subroutines available to recipes. | Small core | Useful place to constrain recipe capabilities. |
| `src/registry.js` | Concept/version registry, search, publish/run support. | Functional v0 | Needs real signed artifacts/evals to become moat. |
| `src/recall.js` | Recall index/query scaffold. | Early | Needs concrete backend limits and data model. |
| `src/rag.js` | RAG indexing/query helpers. | Early | Distinguish RAG as support layer, not product identity. |
| `src/embedding.js` | Embedding helper. | Early | Provider/runtime dependency should be documented. |
| `src/capture.js` | Observations/capture bridge helpers. | Wedge-enabling | Important for trace-to-artifact path. |
| `src/tune.js` | Tune/capture/eval/promote logic. | Roadmap-enabling | Specialist/LoRA claims should remain qualified until pipeline is real. |
| `src/hooks.js` | Hook execution/config for workflows. | Useful integration | Security and shell behavior need careful production review. |
| `src/project.js` | Project/spec helpers. | Support | Should align with one canonical file format. |
| `src/spec-compile.js` | Local spec compile path and local receipt secret handling. | Useful developer path | Needs receipt mode alignment with public verifier. |
| `src/verified.js` | Verified inference support. | Feature surface | Depends on provider keys and verifier quality. |
| `src/composer.js` | Composition helpers. | Support | Needs route/test mapping before expanding. |
| `src/assistant.js` | Natural-language dashboard/control assistant. | Product surface | Keep scoped to observable/account/control actions. |
| `src/oauth.js` | Google/GitHub OAuth without SDK dependency. | Scaffolded | Rotates API key for OAuth sessions; UX/CLI implications need docs. |
| `src/stripe.js` | Stripe webhook signature verification and plan mapping. | Unit-covered | No Stripe SDK dependency; webhook idempotency/outbox still needed. |
| `src/email.js` | Email helper. | Support | Needs operational config and bounce/error observability. |

## API Surface Inventory

The router has 86 inline route declarations in `src/router.js`. `src/oauth.js` mounts three additional OAuth routes under `/v1/oauth/*`.

| Group | Routes | Auth Boundary | Maturity | Notes |
| --- | --- | --- | --- | --- |
| Public health/readiness | `GET /health`, `GET /ready` | Public | Good | `/ready` is the production gate. |
| Pricing/plans | `GET /v1/pricing`, `GET /v1/plans` | Public | Good | Must stay consistent with public pricing pages. |
| Anonymous/account bootstrap | `POST /v1/anon/bootstrap`, `POST /v1/anon/claim`, `POST /v1/signup`, `POST /v1/signin`, `POST /v1/signout`, session login/logout | Public with limiters or body token | Functional | Auth is API-key-first; OAuth exists but UI should not overpromise if unconfigured. |
| OAuth | `GET /v1/oauth/providers`, `GET /v1/oauth/:provider/start`, `GET /v1/oauth/:provider/callback` | Public | Scaffolded | Provider routes return 503 when env vars are missing. |
| Public registry/run | `GET /v1/public/concepts`, `GET /v1/public/concepts/:id`, `POST /v1/public/run`, `GET /v1/registry/export`, `GET /v1/registry/public`, `GET /v1/public/featured` | Public | Functional | `registry/export` claims offline public recipe payload; qualify as recipe-tier. |
| Spec/receipts | `GET /v1/spec`, `POST /v1/receipts/verify` | Public | Core v0 | HMAC verification works but public-key mode is not shipped. |
| Verified/wrap | `POST /v1/wrap/verified`, `POST /v1/verified-inference` | Authenticated, rate-limited | Provider-dependent | Requires provider API key on server. |
| Staff health | `GET /v1/health` | Authenticated admin | Good | More detailed than public `/health`. |
| Compile/artifacts | `POST /v1/compile`, `GET /v1/compile`, `GET /v1/compile/:id`, `GET /v1/compile/:id/.kolm`, artifact list/detail/download | Authenticated | Core v0 | Job runner is in-process; artifact output is recipe-tier/pointer-tier. |
| Recall/embed | `POST /v1/recall`, `POST /v1/embed`, `GET /v1/recall/status`, `GET /v1/recall/sources/:id(*)` | Authenticated | Early | File/source access has tenant-root checks. |
| Assistant/account | `POST /v1/assistant`, `GET /v1/account`, rotate/change-plan/cancel/delete | Authenticated | Functional | Account lifecycle is still simpler than enterprise org/RBAC. |
| Billing | `POST /v1/stripe/webhook` | Public webhook with signature check | Unit-covered helper | Needs durable event idempotency/outbox. |
| Synthesis/verify/publish/run | synthesize, stream, batch, verify, publish, concepts, search, run, compose | Authenticated | Core product | Main recipe workflow. |
| Telemetry/library | `GET /v1/telemetry`, `GET /v1/library` | Authenticated except library after auth middleware still requires auth | Mixed | Telemetry uses invocation count as receipt proxy. |
| Admin | tenant create/list, diagnostics, waitlist/submissions | Authenticated admin | Internal | Admin fallback disabled in production-like envs. |
| Recipes/jobs | recipe list/detail/stats/lineage, label corpus/stream, job status | Authenticated | Functional/early | Useful for registry and distill workflow. |
| Specialists | waitlist, train, list/detail/weights/run, auto-distill | Waitlist public; most authenticated | Preview | Training incomplete or bridge-dependent. Keep claims qualified. |
| Public submissions | `POST /v1/public/submit` | Authenticated | Functional | Public namespace but tenant-owned submission. |
| Bridges/capture | observe, suggestions, observations, auto-synthesize, specialist candidates, Anthropic/OpenAI capture, labels export | Authenticated | Strong wedge | Most important route family for trace-to-artifact GTM. |
| Memory bridge | `POST /v1/memory/recall` | Authenticated | Compatibility bridge | Reuses registry search and runtime. |

## Test Coverage Map

| Test File | What It Proves | Remaining Gap |
| --- | --- | --- |
| `tests/artifact-end-to-end.test.js` | Four fixture artifacts load, signature verifies, evals pass, benchmark reports 0 egress, tenant params work, audit callback fires, oversize input rejects, tampered manifest rejects. | Does not prove real LoRA/model weights or mobile runtime. |
| `tests/server.test.js` | Production-like proxy trust, artifact receipt algorithm labeling, benchmark report/CLI path. | Does not prove deployed Railway/Vercel behavior. |
| `tests/store.test.js` | JSON backup/recovery and SQLite transactional path when `node:sqlite` is available. | Does not prove Postgres or multi-process concurrency. |
| `tests/auth.test.js` | Production disables fallback admin and dev receipt defaults; readiness gates secrets/storage. | Does not prove org/RBAC/SSO. |
| `tests/auth-hash.test.js` | Tenant API keys hash at rest and legacy raw keys migrate on use. | Single-key tenant model remains. |
| `tests/stripe.test.js` | Stripe signature helper, cents-to-plan mapping, checkout param stitching. | Does not prove live webhook idempotency or subscription entitlement flow. |
| `tests/site.test.js` | Static/site text hygiene, forbidden claims, public route resolution, sitemap/robots consistency, SDK package brand. | Current dirty public files may be user edits; rerun before deploy. |
| `tests/e2e.test.js` | Server-level flow coverage. | Needs review against current API surface after route growth. |

## SDK / Distribution Surface

| Surface | Evidence | Notes |
| --- | --- | --- |
| CLI | `cli/kolm.js`, package `bin.kolm` | Main developer wedge. Needs one canonical install path. |
| Node SDK | `sdk/node/*`, tests in `site.test.js` | Package name expected as `@kolmogorov/kolm-sdk` in tests. |
| Python SDK | `sdk/python/*` | Needs clean packaging/readme path verification. |
| MCP server | `sdk/mcp/*`, `services/mcp/server.js` | Strong agent integration path. |
| GitHub Action | `.github/actions/kolm-compile/action.yml` | CI compile/eval route. |
| Homebrew/Winget scripts | `scripts/brew/kolm.rb`, `scripts/winget/kolm.yaml` | Distribution scaffolds; verify against actual package identity. |

## Architecture Recommendations

| Priority | Recommendation | Acceptance Evidence |
| --- | --- | --- |
| P0 | Split claim truth from roadmap in route responses and public copy. | `/v1/spec`, public pages, README, and docs use the same receipt/artifact maturity language. |
| P0 | Add route inventory test or generated manifest. | CI fails when a route is added without auth classification and docs entry. |
| P0 | Replace or isolate recipe execution boundary. | Malicious recipe tests fail under hard isolation, not string scanning. |
| P0 | Make production storage/job mode explicit. | `/ready` refuses JSON/in-memory job mode unless an explicit dev override is set. |
| P1 | Split `src/router.js` into route modules. | `routes/public.js`, `routes/compile.js`, `routes/registry.js`, `routes/account.js`, `routes/admin.js`, `routes/bridges.js`, `routes/specialists.js`. |
| P1 | Create real artifact evidence fixtures for marketing claims. | Public sample artifact page shows zip members, hashes, evals, benchmark, receipt, and verifier command. |
| P1 | Add integration tests for capture-to-suggest-to-compile. | A fixture trace becomes a `.kolm` with eval and receipt in CI. |

