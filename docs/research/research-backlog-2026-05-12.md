# Research Backlog

Opened: 2026-05-12

This backlog keeps the research loop alive. The goal is to convert broad "keep researching" into specific questions that can update `critical-insights.csv`.

## P0: Claim And Product Truth

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-001 | What exactly is inside a current `.kolm` produced from a clean compile? | Generate a sample artifact, unzip it, hash every member, verify receipt, run artifact. | Artifact evidence page and updated claim table. |
| RB-002 | Which live pages imply local weights, LoRA, phone runtime, or compliance status? | Crawl `public/*.html` and live `kolm.ai` pages for claim terms. | Claim audit CSV with exact page, phrase, allowed/revise/action. |
| RB-003 | Can a receipt be verified offline from a clean machine without secrets? | Try CLI/API verifier with a sample HMAC receipt; design Ed25519 sample. | Receipt mode spec and verifier acceptance test. |
| RB-004 | What is the minimum production deployment profile? | Exercise `/ready` under env matrices: JSON, SQLite, missing secret, production-like host. | Deployment truth table. |
| RB-008 | Does the signed manifest K-score size match the final zip size? | Fix or test the `buildAndZip` second-pass size mutation found in `artifact-truth-audit-2026-05-12.md`. | Artifact K-score size consistency test and implementation fix. |
| RB-009 | Which artifact member names mislead buyers? | Review `model.gguf`, `lora.bin`, and `index.sqlite-vec` naming against actual v0.1 contents. | Artifact naming/copy decision memo. |
| RB-015 | What is the first public-key receipt mode Kolm can ship? | Design Ed25519 receipt fields, public key identity, fixture vectors, CLI verifier, and migration from HMAC. | Receipt v0.2 public verification spec. |
| RB-016 | Should local artifact runs produce signed per-run receipts? | Compare current unsigned `rs-1-run` object with artifact receipt and API run HMAC receipt paths. | Local-run receipt design decision. |
| RB-017 | Should production readiness require durable artifact storage? | Resolve the mismatch between `runtimeReadiness()` temp artifact fallback and `tests/auth.test.js` expected `not_ready`. | Readiness semantics fix and test update. |
| RB-018 | What is the accepted v0 production profile? | Choose SQLite, JSON override, or future Postgres/queue; document limits and retention behavior. | Production deployment profile memo. |

## P0/P1: Auth Boundary And Tenant Security

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-019 | How should anon workspaces be claimed without account takeover risk? | Use the anon-claim smoke from `auth-boundary-audit-2026-05-12.md`, design email/OAuth proof, and add regression tests. | Fixed claim flow and tests denying existing-email merge without proof. |
| RB-023 | How should query-string API keys be removed without breaking CLI users? | Inventory SDK/CLI callers, add deprecation warnings, and test header/cookie alternatives. | Query-key deprecation plan and implementation. |
| RB-024 | Which routes are intentionally public, protected, admin-only, or webhook-public? | Generate route declarations from `src/router.js` plus OAuth mounts and compare to `auth-boundary-matrix-2026-05-12.csv`. | Checked-in route auth manifest and failing test for unexpected changes. |
| RB-025 | What abuse controls should govern unauthenticated public runs? | Measure `/v1/public/run` cost, input sizes, receipt overhead, and limiter behavior under load. | `publicRunLimiter`, input caps, and public-run abuse tests. |
| RB-026 | Should browser sessions use separate credentials from long-lived API keys? | Review OAuth key rotation, cookie/header precedence, CLI key UX, and account recovery flows. | Session-token/API-key separation design. |
| RB-027 | Should account deletion purge data or deactivate access? | Use `tenant-data-lifecycle-audit-2026-05-12.md`, privacy copy, and retention requirements to choose semantics. | Account deletion/deactivation policy and implementation plan. |
| RB-028 | Can recall source preview escape the tenant root on Windows and POSIX? | Turn the local prefix smoke into tests for sibling prefixes, `..`, encoded separators, and exact root access. | Shared path-inside helper and traversal regression tests. |
| RB-029 | What data root and retention policy should runtime cache use? | Inventory cache files, KOLM_DATA_DIR/KOLM_CACHE_DIR behavior, account deletion expectations, and public/private cache modes. | Cache root migration and cache-retention test plan. |
| RB-035 | Which aggregate telemetry is tenant-private versus global public usage? | Review lineage, specialist candidates, public runs, telemetry dashboards, and owner analytics. | Aggregate telemetry scoping policy and route fixes. |
| RB-036 | What capture retention and redaction controls are required for enterprise use? | Review prompt/response persistence, namespace lifecycle, export/delete controls, DPA claims, and subprocessor needs. | Capture data governance spec and implementation backlog. |

## P0/P1: Billing And Plan Enforcement

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-037 | How should Stripe plan activation be bound to actual payment? | Use the pending-plan mismatch smoke, Stripe Price ids, Payment Link ids, metadata, and amount checks. | Safe webhook activation logic and route tests. |
| RB-038 | What is the canonical paid unit: compile credits, runtime calls, artifact months, receipt retention, or all of these? | Compare `billing-plan-enforcement-audit-2026-05-12.md` with pricing research and current `chargeUsage` calls. | Route-to-billing unit matrix and implementation plan. |
| RB-039 | Which plan features are actually enforceable today? | Map public pricing rows to code gates for seats, private artifacts, SSO, SCIM, audit logs, support, BAA, and registry controls. | Entitlement matrix and copy cleanup. |
| RB-043 | Should cancellation be immediate downgrade or period-end access? | Compare Stripe subscription state, route behavior, account UI, API docs, and customer expectations. | Cancel semantics decision and route/docs fix. |
| RB-044 | How should quota accounting become auditable and race-resistant? | Review stale-object `chargeUsage`, concurrent requests, usage ledgers, and quota reservation before expensive work. | Atomic usage ledger design and tests. |
| RB-045 | How should billing docs stay in sync with code? | Generate examples from `PLAN_CATALOG`, route fixtures, and signed webhook fixtures. | Docs snapshot tests for account/pricing/API billing examples. |

## P0/P1: SDK, CLI, And Developer Entry Points

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-046 | What is the minimal launch-safe SDK surface? | Start from `sdk-cli-integration-audit-2026-05-12.md` and choose browser, Node, Python, MCP, or CLI-only launch scope. | SDK launch readiness checklist. |
| RB-047 | How should browser SDK assets be built and gated? | Fix syntax, run `node --check`, browser import smoke, worker run smoke, and SRI manifest verification. | Browser SDK build gate and regenerated assets. |
| RB-048 | Which public recipe helper contract should all SDKs share? | Align Node, Python, MCP, and browser helpers on `/v1/public/run` and curated recipe lookup. | Shared public helper fixture tests. |
| RB-049 | What are the canonical package names and install commands? | Decide npm/PyPI/MCP names, private/GitHub fallback, and migration from `recipe` terminology. | Package naming decision and docs cleanup. |
| RB-054 | How should Python SDKs map to the current API and CLI? | Update batch, verify, public run, compile fallback, CLI flags, and response parsing. | Python SDK contract fix and CI tests. |
| RB-055 | How should SDK tests run without a live server? | Build fetch/urllib mocks and optional live `KOLM_BASE_URL` contract tests. | Reliable SDK CI matrix. |

## P0/P1: CI, Tests, And Deployment Gates

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-056 | How should root tests become a required release gate? | Fix the current readiness test failure, add `npm test` to CI, and confirm branch protection uses it. | Required CI test workflow with green root suite. |
| RB-057 | How should browser SDK assets be validated before publish? | Add syntax checks, browser import smoke, worker execution smoke, versioned asset checks, and SRI manifest verification. | Browser SDK release gate and regenerated assets. |
| RB-058 | How should the GitHub compile action track the CLI contract? | Compare action flags/output with `cli/kolm.js`, add true JSON output or update parsing, and run an action contract smoke. | Working reusable compile action and fixture test. |
| RB-059 | What is the single production deploy topology? | Decide Vercel proxy versus direct app hosting, Railway backend role, Docker entrypoint, and strict readiness target. | Production deployment contract and config cleanup. |
| RB-060 | Which P0/P1 findings need route-level regression tests first? | Turn auth, billing, tenant lifecycle, recall path, and public-run findings into focused Node test files. | Security and billing regression test suite. |
| RB-061 | What CI matrix should cover SDKs and runtime versions? | Add Node SDK mocked tests, Python tests, MCP tests, Node version policy, and optional live contract jobs. | SDK/runtime CI matrix with clear required and optional jobs. |
| RB-062 | How should live/local parity be checked? | Generate route/API/docs contracts from source and run them locally plus against `kolm.ai`. | Dated parity report and failing deploy smoke for drift. |
| RB-063 | Which health endpoint should gate production promotion? | Resolve `/health` versus `/ready`, artifact storage expectations, secret requirements, and deploy platform behavior. | Strict readiness promotion policy and tests. |

## P0/P1: Compliance And Security Posture

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-064 | What is the real account deletion and tenant purge policy? | Compare privacy, BAA, tenant data stores, cache, artifacts, public registry, Stripe, and receipts. | Deletion policy plus purge/certification implementation plan. |
| RB-065 | How should capture data be retained, redacted, exported, and purged? | Use `observations` routes, capture proxy behavior, and privacy/audit-log claims. | Capture governance spec and route tests. |
| RB-066 | What is the minimum durable audit log that regulated buyers need? | Design tenant-scoped entries, opt-in state, JSON/CSV export, receipt chain, rotation, and migration. | Audit log implementation plan and fixtures. |
| RB-067 | Which legal/procurement artifacts actually exist? | Inventory BAA, DPA, MSA, SOC 2 letters, subprocessor list, security posture, and compliance binder templates. | Versioned compliance artifact pack. |
| RB-068 | What subprocessor and data-category map matches current deployment? | Map Vercel, Railway, Stripe, storage, capture, compile, logs, and regional options. | Dated subprocessor register and deploy data map. |
| RB-069 | What supply-chain evidence should be public at release? | Add SBOM, Cosign/Sigstore, provenance, release workflow, and verification instructions. | Release evidence workflow and public artifact links. |
| RB-070 | How should regulated vertical pages label shipped/manual/planned claims? | Review healthcare, legal, finance, defense, enterprise, security, privacy, terms, and BAA pages. | Claim-label policy and copy cleanup queue. |
| RB-071 | How should vulnerability disclosure be made fully operational? | Verify PGP key import, `.asc` publication, bounty scope, acknowledgments page, and security.txt expiry checks. | Disclosure operations checklist and tests. |
| RB-072 | What legal review matrix covers HIPAA, non-HIPAA health, GDPR, and sector-specific deployments? | Use official HHS, FTC, EUR-Lex, and customer deployment assumptions. | Legal review checklist for regulated pilots. |
| RB-073 | What should a quarterly compliance binder actually contain? | Define evidence sources for receipt-chain, K-score regression, subprocessors, incidents, retention, and deploy changes. | Sample generated binder and source manifest. |

## P0/P1: API Docs And Contract Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-074 | What route manifest should be the API source of truth? | Extract method, path, auth status, maturity, request schema, response schema, examples, and owners from `src/router.js`. | Checked-in route manifest or OpenAPI spec. |
| RB-075 | How should `/api`, README, SDK fixtures, and docs examples be generated? | Compare current manual docs to route manifest and SDK tests. | Docs generation pipeline and snapshot tests. |
| RB-076 | What are the canonical account and billing response shapes? | Reconcile account, change-plan, cancel, delete, Stripe webhook, and account UI behavior. | Stable account/billing API contract with tests. |
| RB-077 | How should public and anonymous APIs be documented and abuse-gated? | Include anon bootstrap/claim, public concepts/run/featured, public submit, receipts, and spec endpoints. | Public API section with auth/abuse semantics. |
| RB-078 | What are the stable compile, artifact, registry, and receipt schemas? | Generate examples from successful compile, artifact download, registry export, and receipt verify fixtures. | Executable schema fixtures for core developer flows. |
| RB-079 | How should docs examples be tested continuously? | Parse `/api` and `/docs` examples, execute safe local examples, and compare expected response snapshots. | Docs contract CI job. |

## P0/P1: Benchmarks And Reproducibility

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-080 | What is the canonical artifact benchmark report set? | Generate one report JSON per public fixture with command, secret, Node version, device label, artifact hash, and runs count. | Checked-in fixture report bundle and generated `/benchmarks` table. |
| RB-081 | Which K-score schema is authoritative for v1? | Compare current `computeKScore`, legacy fixture manifests, public table values, and `k-score-1` docs. | K-score migration plan and fixture rebuild checklist. |
| RB-082 | Should `compile --spec` require evals? | Build no-eval local artifacts and test downstream benchmark, MCP, and score behavior. | Gate policy and validation tests. |
| RB-083 | Where should `k_score.ships` be enforced? | Trace `synthesis`, `compile`, `spec-compile`, `buildAndZip`, MCP serve, and tune promote paths. | Central gate enforcement patch plan. |
| RB-084 | What benchmark statistics belong in `kolm-benchmark-1`? | Decide if artifact-local reports need confidence intervals, repeated-run variance, warmup, hardware metadata, and sample size rules. | Benchmark schema v2 proposal. |
| RB-085 | Can the SWE-bench reproducer be self-hosted? | Verify Docker image digest, local `bench/` completeness, external repo availability, p-value calculation, and report schema. | Reproducer release checklist and local smoke test. |
| RB-086 | What egress proof level is honest for each trust tier? | Test benign fixtures, malicious JS recipes, subprocess attempts, native binaries, and container isolation options. | Egress threat model and sandbox test suite. |
| RB-087 | What deterministic packaging work is required for byte-stable rebuilds? | Inspect zip timestamps, manifest timestamps, receipt IDs, order, compression, and signing payloads. | Deterministic artifact build design or copy limitation. |
| RB-088 | How should benchmark examples be generated in docs? | Render `/benchmarks`, `docs/benchmark-results`, and fixture JSON snippets from the same source files. | Docs generation script and stale-value tests. |
| RB-089 | Which benchmark claims need launch-blocking tests? | Map public claims to tests for no-eval rejection, gate enforcement, K-score schema, fixture reports, and egress monitor scope. | Benchmark release gate in CI. |

## P0/P1: Public Registry Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-090 | How should public visibility become review-enforced? | Route `visibility: public` through concept/version review state for synthesize, stream, batch, and manual publish. | Public review gate design and route tests. |
| RB-091 | What evaluation evidence is required for public publish? | Define minimum positives, negatives, property tests, quality threshold, and empty-eval behavior. | Public publish policy plus verifier regression tests. |
| RB-092 | What is the canonical public registry schema? | Reconcile `/v1/public/concepts`, `/v1/public/concepts/:id`, `/v1/registry/public`, `/v1/registry/export`, Atlas, Leaderboard, SDK, and API docs. | Versioned public registry schema fixture. |
| RB-093 | What public detail and download surface should exist? | Design `/registry/{id}`, artifact download, source viewing, manifest, receipt, evals, and run affordances. | Public registry detail page and route contract. |
| RB-094 | What trust metadata belongs on concepts and versions? | Add review status, trust level, publisher identity, license, provenance, approved_by, approved_at, and revoked_at. | Registry trust schema and migration plan. |
| RB-095 | How should public run be abuse-gated? | Rate limits, quota class, sandbox tier, input caps, telemetry, and denial behavior for unauthenticated public runs. | Public run abuse-control test suite. |
| RB-096 | How should Atlas and Leaderboard avoid unsupported badges? | Fixture-test pages against actual response shapes and row-level signature/K-score evidence. | UI truth tests and copy cleanup queue. |
| RB-097 | Should registry export be signed, JSON, NDJSON, or both? | Decide export format, hash/signature semantics, registry versioning, and mirror compatibility. | Export schema v2 and docs generation. |
| RB-098 | How should seed entries be labeled and curated? | Distinguish boot demo examples from reviewed public artifacts; attach provenance and trust level. | Seed registry governance policy. |
| RB-099 | Which registry governance tests are launch-blocking? | Cover review bypass, empty eval publish, missing detail routes, export trust fields, public run limiter, and cache revocation. | Required public registry CI gate. |
| RB-100 | What admin workflow completes public submissions? | Build approve/reject/promote endpoints, audit trail, notifications, and owner-visible status. | Admin submission workflow spec and tests. |
| RB-101 | How should browser SDK caches handle revocation? | Add registry sequence, minimum accepted version, revocation list, and stale cache rejection semantics. | Offline cache revocation design and smoke tests. |

## P0/P1: Capture And Distillation Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-102 | What is the canonical observation schema? | Reconcile `namespace`, `corpus_namespace`, template hash, status, kept/discarded, source, retention class, and provenance. | Observation schema migration plan and fixtures. |
| RB-103 | How should triage control training data? | Decide kept-only defaults, discarded exclusion, failed-status exclusion, and manual override semantics for labels and distill. | Triage-bound export/distill policy and route tests. |
| RB-104 | How should capture errors be stored? | Test missing/invalid upstream key, provider 4xx, provider 5xx, malformed JSON, and timeout behavior. | Error-capture storage policy and tests. |
| RB-105 | How should capture retention actually work? | Define raw-body retention, hash-only expiry, per-namespace settings, purge jobs, and export audit. | Retention implementation spec and public copy cleanup. |
| RB-106 | What should bridge auto-synthesis persist? | Decide draft-only source, private concept/version, review state, lineage, and UI handoff. | Auto-synthesize persistence contract and tests. |
| RB-107 | What is the minimum auto-distill completion contract? | Add callback/status route, specialist state, artifact or weights URL, receipt evidence, and failure handling. | Auto-distill job lifecycle design. |
| RB-108 | How should capture inbox namespaces match CLI labels? | Share one readiness helper across inbox, labels, CLI, and auto-distill. | Namespace/readiness fixture tests. |
| RB-109 | What public threshold table should explain 4, 200, and 1,000? | Map bridge auto-synthesis, local tune watch, auto-distill, and specialist candidates. | Threshold policy and docs update. |
| RB-110 | How should savings estimates be computed? | Replace ad hoc savings math with a documented model using observed cost, traffic cadence, and replacement rate. | Savings estimator unit tests and copy guardrails. |
| RB-111 | When can local tune claim adapter improvement? | Implement adapter-aware eval or narrow tune copy to local capture and revision plumbing. | Tune eval/promotion proof plan. |
| RB-112 | What SDK helpers should expose capture export? | Add explicit capture corpus helpers separate from concept label-corpus helpers. | SDK capture API contract and tests. |
| RB-113 | Which capture/distill tests block launch? | Cover proxy namespace, discard exclusion, error capture, labels export, auto-synthesize persistence, bridge unavailable, and tune promotion. | Required capture/distill CI gate. |
| RB-114 | How should hosted capture and local tune be separated in copy? | Review capture, evolve, glossary, competitor, CLI, and docs pages for hosted-vs-local data path wording. | Copy truth matrix and rewrite queue. |

## P0/P1: Audit Observability Evidence

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-115 | What is the canonical tenant audit event schema? | Define actor, tenant, op, resource, hashes, redactions, receipt, request id, source route, and retention class. | `audit_events` schema and event contract. |
| RB-116 | How should audit opt-in and export work? | Decide default-on/default-off by plan, JSON/CSV/JSONL response shape, pagination, and auth behavior. | Audit log route spec and tests. |
| RB-117 | Which operations must write launch-blocking audit events? | Map capture, label export, auto-distill, compile, publish, run, verify, account delete, key rotation, plan change, and admin diagnostics. | Required audit writer matrix. |
| RB-118 | How should receipt issuance and verification be counted? | Separate issued, opted-out, verification success, verification failure, unavailable-secret, and drive-by checks. | Receipt telemetry schema and dashboard copy. |
| RB-119 | What request-id and error envelope should every API route use? | Add middleware, route wrappers, webhook exceptions, and response-header behavior. | Standard error contract and generated docs. |
| RB-120 | What should back `/status` uptime windows? | Pick external monitor, internal probe table, status-page static generation, and freshness SLA. | Status evidence architecture. |
| RB-121 | How are incidents declared, edited, and closed? | Define owner, severity, start/end times, customer impact, retro link, and public/private fields. | Incident model and status-page workflow. |
| RB-122 | Which `/ready` schema should status consumers rely on? | Align route fields with `status.html` rendering for label, hint, version, uptime, and optional gates. | Readiness schema fixture tests. |
| RB-123 | How should audit metadata differ from captured training corpus data? | Separate hash-only audit rows from full prompt/output observations, retention, and purge controls. | Data classification policy for audit vs capture. |
| RB-124 | Should local audit callbacks include input previews by default? | Evaluate PII risk, sink responsibility, redaction hooks, and opt-in preview settings. | Local audit preview/redaction policy. |
| RB-125 | Should admin diagnostic access be audited? | Identify sensitive diagnostic fields, actor identity, and minimal event payload. | Admin access audit events. |
| RB-126 | Which observability tests block launch? | Cover audit log export, opt-in, operation writers, request ids, receipt metrics, `/ready` schema, and status evidence. | Audit/observability CI gate. |
| RB-127 | How should public audit/status copy be labeled until controls ship? | Review audit-log, trust, status, security, healthcare, finance, and enterprise pages. | Copy downgrade queue with shipped/beta/planned labels. |

## P0/P1: Recall RAG Memory Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-128 | What are the canonical recall modes? | Separate hosted qmd bridge, local BM25 RAG, artifact-bound recall, and concept memory recall. | Recall mode taxonomy and docs labels. |
| RB-129 | How should compile actually use recall chunks? | Decide whether chunks feed synthesis, eval generation, priors, verifier prompts, or package metadata. | Compile grounding contract and tests. |
| RB-130 | What is the artifact-bound recall payload for v0.1? | Choose empty slot, KOLMIDX JSON, sqlite-vec roadmap, or external namespace marker semantics. | Artifact recall conformance matrix. |
| RB-131 | How should `kolm compile --data` work for hosted SaaS? | Compare upload/archive, self-hosted mounted paths, local spec compile, and failure behavior. | CLI data-path contract and user-facing errors. |
| RB-132 | How should local `kolm rag attach` integrate with runtime? | Wire `.rag.json` sidecar loading, `lib.rag.query`, signing implications, and missing-index errors. | Local RAG runtime integration plan. |
| RB-133 | How should `/v1/recall/sources` be hardened? | Test traversal, sibling-prefix paths, absolute path leakage, preview size, and audit events. | Source preview security patch plan. |
| RB-134 | What deletion and retention controls does recall need? | Define namespace delete, sidecar cleanup, qmd collection delete, local index remove, and retention policy. | Recall lifecycle controls. |
| RB-135 | How should qmd availability appear to users? | Distinguish unavailable backend, empty index, empty result, and degraded multimodal tokenization. | Recall health/error contract. |
| RB-136 | Which multimodal claims are actually shipped? | Inventory text, code, PDF, image, audio, video behavior with and without optional dependencies. | Recall capability table and copy queue. |
| RB-137 | Which tests block recall launch? | Cover `/v1/embed`, `/v1/recall`, status, qmd unavailable, compile grounding, local RAG index/query/attach, and artifact runner `lib.rag`. | Recall CI gate. |
| RB-138 | Should `/v1/memory/recall` be renamed? | Compare route name to behavior: registry search plus concept runs, not corpus recall. | Route naming/deprecation decision. |
| RB-139 | How should local RAG indexes protect sensitive paths and previews? | Evaluate absolute path storage, previews, permissions, redaction, and optional encrypted local storage. | Local RAG privacy policy and flags. |
| RB-140 | Which public pages need recall claim downgrades? | Review recall, API, docs, whitepaper, security, vs-rag, vs-openpipe, vs-predibase, and vs-ollama pages. | Recall claim cleanup queue. |

## P0/P1: Cookbook Example Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-179 | Which cookbook commands are executable today? | Extract visible snippets and JSON-LD HowTo commands, compare to `kolm --help`, and run non-network smoke cases. | Cookbook command contract test. |
| RB-180 | What is the minimum proof bundle for a verified cookbook recipe? | Define required spec, examples, artifact, receipt, K-score schema, benchmark report, and source hashes. | `cookbook-proofs.json` schema. |
| RB-181 | Which cookbook pages should be verified, seed, preview, or target? | Classify all 33 detail pages against existing files and fixture evidence. | Status matrix driving public labels. |
| RB-182 | Which 8-12 recipes should become real launch proof? | Choose high-signal generic and vertical examples, then create specs, evals, artifacts, receipts, and benchmarks. | Verified launch cookbook pack. |
| RB-183 | Should CLI support `--output`, `--input-file`, `--input-stdin`, and `spec --check`? | Decide whether docs adapt to CLI or CLI gains compatibility aliases. | CLI/docs compatibility decision and tests. |
| RB-184 | What K-score scale should cookbook pages use? | Compare fixture manifest values, CLI `score`, public pages, and benchmark reports. | K-score schema migration and rendering policy. |
| RB-185 | Which device benchmarks are real enough to publish? | Run verified artifacts on CI, local laptop, GPU server, phone/browser, and CPU server where available. | Device benchmark report set. |
| RB-186 | How should JSON-LD HowTo stay truthful? | Parse structured data, verify referenced files and commands, and emit only for verified pages. | Structured-data CI gate. |
| RB-187 | Which regulated examples need caveats or proof links? | Review healthcare, finance, legal, edge, and web3 pages for datasets, verifiers, compliance boundaries, and receipts. | Regulated recipe proof/copy queue. |
| RB-188 | How should seed examples graduate to artifacts? | Compile selected `examples/*.json` into artifact specs, add evals, and attach receipts. | Seed-to-artifact promotion pipeline. |
| RB-189 | What demo script should replace the stale runbook? | Rewrite the demo around current domain, current brand, current packages, and verified artifacts only. | Proof-based demo runbook. |
| RB-190 | Which cookbook checks block launch? | Combine command extraction, file existence, artifact verification, receipt verification, and benchmark freshness. | Cookbook release gate. |

## P0/P1: Project Hooks Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-191 | Should `kolm.yaml` be schema-validated before runtime use? | Compare current hand-parser behavior with public schema examples and invalid fixtures. | Project config validation command and tests. |
| RB-192 | What hook failure policy is launch-safe? | Decide advisory versus blocking defaults for PreCompile, PreRun, PreBench, and timeouts. | Hook fail-closed policy and migration note. |
| RB-193 | Should hook stdout be allowed to modify events? | Design or remove `additionalContext` and `updatedInput`; test mutation and denial paths. | Hook mutation spec or schema cleanup. |
| RB-194 | How should users inspect hook side effects? | Add `kolm hooks list` or `kolm doctor --hooks` showing discovered root, commands, timeout, and mode. | Hook inventory UX and tests. |
| RB-195 | How should K-score gates compare scores? | Normalize fixture and future K-score values before applying `k_min` floors. | K-score gate migration and MCP tests. |
| RB-196 | Should `sse` remain in the project schema? | Compare schema transport enum with implemented stdio and HTTP JSON-RPC server. | Schema transport correction or SSE implementation. |
| RB-197 | How should `allowed-tools` be enforced? | Trace project config to SKILL.md, MCP metadata, and harness permissions. | Sidecar/MCP allowed-tool enforcement decision. |
| RB-198 | What should `kolm doctor` actually certify? | Add harness config checks, MCP initialize/list smoke, project parser validation, hooks, sidecars, and artifacts. | Doctor certification matrix. |
| RB-199 | Should project discovery execute ancestor hooks by default? | Test nested project behavior, untrusted checkout scenarios, and explicit bypass UX. | Project root and hook trust policy. |
| RB-200 | How should hook execution be audited? | Capture hook command id, exit code, timeout, bypass state, and redacted stderr/stdout. | Local hook audit log schema. |
| RB-201 | How should generated sidecars avoid overstating runtime guarantees? | Compare sidecar guarantee text with benchmark-scoped egress monitor and local run behavior. | Sidecar template rewrite and test. |
| RB-202 | Which config/hook tests block launch? | Cover init, parser, schema, hooks, KOLM_HOOKS_OFF, k_min, doctor, sidecar, and MCP config. | Project automation CI gate. |

## P0/P1: Tune Evolution Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-203 | How should tune eval load real artifact eval cases? | Compare `evalRevision`, `inspectArtifact`, `evalArtifact`, fixture bundles, and current 0/0 probe behavior. | Fixed eval-case loader and regression test. |
| RB-204 | What is the adapter-backed eval contract? | Decide how a revision adapter affects LM-backed recipes, deterministic recipes, or a separate model-eval harness. | Adapter eval design and launch labels. |
| RB-205 | What should tune promotion actually modify? | Compare local `HEAD` flips, artifact bundle mutation, re-signing, registry revisions, and serve hot reload. | Promotion semantics decision and implementation plan. |
| RB-206 | How should `require_improvement` and `k_min` be enforced? | Evaluate candidate and current head on the same eval set and read configured gates in CLI output. | Promotion gate tests and CLI output fix. |
| RB-207 | What governance controls belong on local captures? | Define redaction, encryption, consent, retention, source labels, purge, and audit events for `captures.jsonl`. | Local capture governance schema. |
| RB-208 | What airgap proof level is honest for tune? | Test env flags, local base paths, remote model ids, Python network APIs, and OS/process-level denial options. | Tune airgap threat model and smoke test. |
| RB-209 | How should tune dependency failures surface? | Preserve trainer exit code 64, implement or remove `KOLM_TUNE_TRAINER`, and add dependency doctor checks. | Tune troubleshooting contract and tests. |
| RB-210 | What watcher controls are needed before auto-promote? | Add locking, duplicate-run protection, backoff, sample-size behavior, process status, and manual approval mode. | Watcher safety policy and tests. |
| RB-211 | Should RAG attachment be signed local state or runtime injection? | Compare sidecar behavior, `lib.rag` target architecture, runner integration, and artifact receipt semantics. | RAG attachment contract and copy cleanup. |
| RB-212 | Can CI run a cheap tune loop? | Build a fake trainer or tiny local-model fixture for init, capture, step, eval, promote, rollback, and watch. | Deterministic tune CI fixture. |
| RB-213 | Which evolve page claims must be proof-generated? | Generate terminal samples and K-score values from current CLI/eval fixtures. | Evolve static claim test. |
| RB-214 | Which tune/evolution checks block launch? | Combine eval-case loading, adapter scope, promotion gates, capture governance, airgap, watcher, and RAG status. | Tune/evolution release gate. |

## P0/P1: Homepage Claim Regression

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-215 | What homepage copy is safe for the current artifact tier? | Rewrite the homepage around verified fixture artifacts, HMAC receipt truth, and recipe-tier local execution. | Proof-backed homepage claim spec. |
| RB-216 | How should metadata and JSON-LD be claim-gated? | Parse meta, OG, Twitter, FAQ schema, offer schema, and software feature arrays for forbidden claim families. | Structured-data claim linter. |
| RB-217 | Which exact and fuzzy phrase families should block deployment? | Expand beyond exact phrases to model weights, phone runtime, VPC, airgap, regulated data, public-key receipts, and monotonic improvement. | Claim-family rule set and tests. |
| RB-218 | How should live/local parity be verified before release? | Fetch live home, docs, pricing, healthcare, FAQ, API, device, benchmarks, and compare against local forbidden-claim scans. | Live claim smoke script. |
| RB-219 | What public homepage proof block should replace handwritten demos? | Use sample, redactor, extractor, and classifier fixtures plus benchmark output to generate demo snippets. | Generated homepage proof partial. |
| RB-220 | Which regulated homepage cards need labels or removal? | Review healthcare, legal, finance, device, edge, BAA, VPC, and audit-log wording against implemented controls. | Regulated card rewrite queue. |
| RB-221 | How should README/package metadata align with implementation truth? | Compare README intro, package description, local homepage, and artifact code caveats. | Metadata cleanup patch list. |
| RB-222 | Which live docs/install claims remain stale after the next deploy? | Compare live docs against route manifest, package availability, and current CLI/package names. | Post-deploy docs parity report. |
| RB-223 | What is the minimum public proof link for model/phone/VPC/airgap claims? | Define acceptable proof artifacts, benchmarks, deployment diagrams, receipts, and owner sign-off. | Claim-proof policy. |
| RB-224 | Which homepage checks block launch? | Combine static text, structured data, proof links, live parity, and fixture-generated examples. | Homepage release gate. |

## P0/P1: Runtime Sandbox Threat

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-225 | What trust levels should govern recipe execution? | Define generated, customer-private, curated-public, and public-untrusted behavior across CLI, API, registry export, browser SDK, and MCP. | Runtime trust-level schema. |
| RB-226 | Which malicious JS primitives are blocked today? | Add tests for process, require, module, globalThis, import, Function, eval, constructor, prototype, ArrayBuffer, SharedArrayBuffer, Atomics, fetch, Date, randomness, and async tasks. | `verifier-security.test.js`. |
| RB-227 | How should CPU and memory be bounded? | Test infinite loops, long synchronous loops, recursion, allocation pressure, and worker/process termination behavior. | Killable execution design. |
| RB-228 | Should benchmark egress become runtime egress policy? | Compare benchmark-only patching with `runArtifact`, `/v1/run`, MCP, browser SDK, and public run behavior. | Runtime egress policy and tests. |
| RB-229 | How should public registry rows prove trust? | Add review state, publisher identity, source hash/signature envelope, revocation epoch, and trust tier to public exports. | Public recipe trust envelope. |
| RB-230 | How should browser sandbox assets be verified? | Syntax-check SDK/worker assets, run worker smoke, and test malicious globals and main-thread fallback behavior. | Browser sandbox CI gate. |
| RB-231 | Should main-thread browser fallback be disabled? | Test no-Worker runtimes, unsafeMode, public registry source, and explicit user consent. | Browser unsafe-mode policy. |
| RB-232 | What is the first WASM/Wasmtime recipe fixture? | Convert one fixture recipe or a tiny DSL output to WASM and test explicit imports, memory bounds, and conformance. | WASM recipe proof of concept. |
| RB-233 | How should compiled function cache respect trust and revocation? | Include trust tier, source hash, and registry revocation epoch in cache keys and invalidation. | Runtime cache invalidation plan. |
| RB-234 | Which sandbox checks block launch? | Combine malicious JS tests, external asset syntax checks, public-run trust gating, egress policy, and fixture trust labels. | Runtime sandbox release gate. |

## P0/P1: Release Distribution Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-167 | What is the canonical public CLI install path before v0.1.0? | Compare missing npm package, GitHub-source install, package dry-run contents, and docs tabs. | Preview install contract. |
| RB-168 | Which npm packages should exist at launch? | Decide root CLI, Node SDK, MCP package, package scopes, names, files, license, and ownership. | npm package plan and publish checklist. |
| RB-169 | How should root package contents be curated? | Snapshot `npm pack --dry-run`, denylist docs/research/test/fixtures/public bulk, and include license. | `.npmignore` or `files` policy. |
| RB-170 | How should GitHub Action stay in CLI contract? | Smoke action against current CLI, remove missing commands, and decide JSON output shape. | Action contract test and updated action. |
| RB-171 | What package-manager labels are true today? | Check npm, Homebrew tap, winget path, Scoop manifest, PyPI, Docker registry, and VS Code marketplace. | Evidence-backed integration status manifest. |
| RB-172 | What is the Python package name strategy? | Resolve PyPI `kolm` collision, package scripts, current README, and CLI wrapper drift. | Python packaging decision. |
| RB-173 | Which Python wrappers must be rewritten? | Test `compile`, `run`, `verify`, `wait`, auth env, and CLI fallback against root CLI. | Python SDK contract tests. |
| RB-174 | What is the VS Code extension release path? | Update base URL/imports, package VSIX, add smoke tests, and decide marketplace publisher. | VS Code release checklist. |
| RB-175 | Should Docker mean server image, CLI image, or example command? | Compare root Dockerfile, public Docker command, registry image availability, and signing needs. | Docker distribution contract. |
| RB-176 | What release workflow emits SLSA, Sigstore, and SBOM evidence? | Add tag workflow with id-token, package publish, Cosign, CycloneDX, checksums, and verification jobs. | Signed-release workflow. |
| RB-177 | How should docs render shipped/preview labels? | Build a release-evidence JSON manifest and drive public integration badges from checks. | Generated integration status labels. |
| RB-178 | Which package-manager tests block launch? | Add npm view, pip/PyPI ownership, tap URL, winget/Scoop, action smoke, package dry-run, and VSIX checks. | Release CI gate. |

## P0/P1: Release Channel Live Refresh

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-235 | What single install command is truthful before package publication? | Compare live docs, local docs, npm registry state, source package dry-run, and public repo availability. | Preview install contract. |
| RB-236 | How should the root package be curated? | Add allowlist or ignore policy, exclude `tmp/`, research docs, public bulk, tests, and verify lock/license decision. | Package-content policy and CI budget. |
| RB-237 | What should replace the current GitHub Action contract? | Smoke action against current CLI commands or implement missing auth/verify/JSON output modes. | Action contract test and rewrite. |
| RB-238 | Which package names are actually publishable? | Resolve npm CLI, Node SDK, Python name collision, script names, ownership, and namespace policy. | Package naming decision record. |
| RB-239 | How should Homebrew, winget, Scoop, and Docker be labeled? | Verify tap, formula SHA, manifests, image digest, and install smoke. | Package-manager evidence manifest. |
| RB-240 | How should live docs handle the old API/package page? | Compare live `/docs`, local docs, sitemap, redirects, and generated docs assets. | Legacy docs retirement or banner plan. |
| RB-241 | What is the release evidence manifest schema? | Define channel, command, expected version, source URL, last check, status, and proof artifact fields. | `release-evidence.json` schema. |
| RB-242 | Which docs labels should be generated from release evidence? | Map integrations/docs/quickstart/changelog package labels to release-evidence fields. | Generated label rendering plan. |
| RB-243 | What release workflow should emit package proofs? | Design tag workflow for npm, Python, Docker, VS Code, checksums, signatures, SBOM, and provenance. | Tagged release workflow spec. |
| RB-244 | Which stale SDK docs must be blocked from publication? | Review Python README, VS Code metadata, Node SDK README, live docs, and package descriptions. | SDK docs cleanup queue. |

## P0/P1: Device Offline Browser Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-154 | What is the minimum browser runtime contract for `/device`? | Decide whether launch proof is browser demo, local CLI artifact, native runtime, or all three. | Browser/runtime claim policy. |
| RB-155 | How did ternary corruption enter browser assets? | Diff generation/transformation steps for `sdk.js`, `recipe-worker.js`, and `device.html` around `? :` expressions. | Root-cause fix and regression test. |
| RB-156 | Which browser assets must syntax-check before deploy? | Add checks for `sdk.js`, `sdk-*.js`, `recipe-worker.js`, extracted module scripts, and generated current SDK manifests. | Browser asset CI gate. |
| RB-157 | What should `scripts/build-sdk-version.js` refuse to stamp? | Run syntax, import, and browser smoke checks before writing `sdk-current.json`. | Safe SDK versioning release step. |
| RB-158 | What is the exact offline cache contract? | Compare cache-first, network-first, stale-revalidate, manual sync, and signed registry snapshots. | Offline cache policy and service-worker tests. |
| RB-159 | Which dependencies must the `/device` PWA precache? | Enumerate `/device` HTML dependencies, worker scripts, CSS, manifest, icons, and registry payload. | Complete PWA precache manifest. |
| RB-160 | Should `/device` use a dedicated manifest? | Verify installed app start target, scope, icons, offline shell, and app-store-like title. | Device PWA manifest decision. |
| RB-161 | How should browser registry bundles be signed? | Compare source hash only, HMAC envelope, public-key signature, revocation list, and epoch root. | Browser registry trust-envelope spec. |
| RB-162 | What is the signed browser run receipt format? | Compare local SDK metadata, API `rs-1` receipts, artifact `receipt.json`, and offline verifier needs. | Browser receipt v0 spec and verifier. |
| RB-163 | Can the browser worker be a trusted sandbox tier? | Test malicious recipe attempts for fetch, indexedDB, caches, importScripts, globals, timing, and CPU loops. | Browser sandbox threat model and fixtures. |
| RB-164 | Should main-thread `new Function` fallback exist for public registry rows? | Test no-Worker browsers, unsafe mode, and source trust policy. | Public-source execution policy. |
| RB-165 | Which runtimes does the browser SDK actually support? | Smoke browser, Node, Deno, Bun, and Cloudflare Worker usage or split packages. | Runtime support matrix. |
| RB-166 | Which public pages need revised on-device/offline wording? | Review `/device`, security, healthcare article, whitepaper, docs, and homepage after browser proof is fixed or narrowed. | Copy rewrite queue tied to proof links. |

## P0/P1: Agent MCP Install Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-141 | What is the canonical MCP transport contract? | Compare stdio, localhost HTTP JSON-RPC, claimed SSE, port defaults, and client config examples. | MCP transport spec and generated docs. |
| RB-142 | Should `kolm serve --mcp <artifact>` be implemented or removed from docs? | Test positional artifact args, global artifact discovery, project globs, and exposure blast radius. | Single-artifact serve decision and CLI/doc update. |
| RB-143 | How should MCP runtime egress be enforced? | Move or duplicate benchmark egress monitor into `runArtifact` or define a narrower artifact trust tier. | Runtime egress policy and malicious fixture tests. |
| RB-144 | What is the signed local-run receipt format? | Compare artifact receipt, API run receipt, current `rs-1-run`, and MCP `_kolm` trailer needs. | Local per-call receipt spec and verifier fixture. |
| RB-145 | How should K-score normalization gate MCP discovery? | Rebuild fixtures or migrate score schema, then test `k_min` with pass/fail artifacts. | Normalized K-score serve gate. |
| RB-146 | Which harness config paths are canonical? | Separate Claude Desktop, Claude Code, Cursor, Continue, and Cline targets and verify on current clients. | Harness install matrix and installer tests. |
| RB-147 | What should `kolm doctor` verify for agent wiring? | Inspect generated config files, command availability, MCP initialize/list smoke, and port listeners. | Doctor MCP checks and troubleshooting output. |
| RB-148 | How should generated skill sidecars name tools? | Compare global tools, project-prefixed tools, sidecar frontmatter, and harness indexing behavior. | Sidecar naming fixture test. |
| RB-149 | What happens to MCP run logs and audit events? | Add MCP call rows to local `runs.jsonl` and decide tenant-visible audit payload. | MCP log/audit contract and tests. |
| RB-150 | Should `sdk/mcp` remain a legacy cloud MCP package? | Compare `recipe_*` tools, package naming, public docs, and artifact MCP server. | MCP package consolidation or deprecation plan. |
| RB-151 | How should agent templates stay command-accurate? | Parse Claude/Cursor templates for CLI commands and test against `kolm help` dispatch. | Template command snapshot tests. |
| RB-152 | Which shipped integrations need proof before "shipped" labels? | Smoke GitHub Action, VS Code extension, package-manager installs, SDK MCP, and harness install. | Integration status matrix and label policy. |
| RB-153 | Which MCP/install tests block launch? | Cover stdio, HTTP, invalid artifacts, install snippets, doctor checks, logs, `k_min`, and public docs commands. | Required agent integration CI gate. |

## P0: Competitor Depth

## P0: Claim Governance Follow-Up

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-005 | Which public pages fail the current forbidden-claim policy? | Run `tests/site.test.js` after isolating unrelated dirty public edits, then map each failure to a claim-audit row. | Claim cleanup task list. |
| RB-006 | Do live pages match the local repo after deployment? | Fetch key `kolm.ai` URLs and run the forbidden-pattern set from `tests/site.test.js`. | Live claim smoke report. |
| RB-007 | Which artifact claims have direct proof links? | For every page saying model, LoRA, phone, VPC, offline, or public-key receipt, identify a reproducible artifact/benchmark or mark as roadmap. | Proof-link matrix. |

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-010 | Which competitors already offer trace-to-cheaper-model or trace-to-function replacement? | Deep review of OpenPipe, Predibase, Braintrust, Langfuse, Helicone, Portkey, LiteLLM. | Direct-wedge competitor memo. |
| RB-011 | Which gateways can accept a custom artifact-first route today? | Prototype or docs review for LiteLLM, Vercel AI SDK, Cloudflare Workers, Portkey. | Integration priority matrix with implementation steps. |
| RB-012 | Which eval platforms can export datasets/traces in a format Kolm can ingest? | LangSmith, Langfuse, Braintrust, Phoenix, Weave, Helicone export docs. | Importer spec and sample fixtures. |
| RB-013 | Which competitor evidence rows have a working Kolm import path? | Use `competitor-evidence-matrix-2026-05-12.csv` to pick one gateway, one eval platform, and one prompt registry, then build fixtures. | Importer proof matrix. |
| RB-014 | Which competitor claims directly conflict with Kolm public copy? | Compare competitor matrix against `claim-audit-2026-05-12.csv` and current local pages. | Copy-risk diff and rewrite queue. |

## P0/P1: Competitor Trace Import Wedge

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-245 | What is the `kolm-trace-1` interchange schema? | Map Langfuse, LangSmith, Braintrust, Helicone, Phoenix, Weave, OpenPipe, and local observations to one row shape. | Trace/eval schema spec. |
| RB-246 | Which importer should ship first? | Compare API/export friction, self-host value, fixture availability, and buyer overlap for Langfuse, Helicone, LangSmith, Braintrust, and OpenPipe. | Importer priority decision. |
| RB-247 | How should Langfuse traces become eval cases? | Pull traces, observations, scores, datasets, and tags via SDK/API and convert to a small Kolm spec. | Langfuse golden fixture. |
| RB-248 | How should Helicone exports become compile candidates? | Use dataset export, request query, or export CLI rows with request/response bodies and metadata. | Helicone JSONL fixture. |
| RB-249 | What LiteLLM hook shape feeds Kolm without blocking requests? | Prototype callback/logger payload, async post-success behavior, and error isolation. | LiteLLM callback package plan. |
| RB-250 | What Vercel AI SDK middleware contract routes artifact-first? | Wrap model, try artifact, emit receipt, fall back to original model, and report avoided call. | Vercel middleware fixture. |
| RB-251 | Can Cloudflare or Portkey route to Kolm as a custom/private provider? | Verify endpoint requirements, auth headers, OpenAI-compatible shape, and cache/rate-limit behavior. | Custom-provider route plan. |
| RB-252 | How should external scores map into K-score? | Map Braintrust, Langfuse, Weave, Phoenix, and Helicone scores to pass/fail evals, coverage, and confidence. | Score-normalization memo. |
| RB-253 | What privacy gates block trace imports? | Define redaction, consent, retention, user/session hashing, and source-system data residency requirements. | Import privacy policy. |
| RB-254 | How should Kolm write results back to source systems? | Determine artifact ID, receipt ID, K-score, benchmark, fallback, and avoided-cost metadata per source. | Receipt write-back contract. |
| RB-255 | What JSON schemas should validate `kolm-trace-1` and `kolm-evalcase-1`? | Convert the research spec into schema files plus valid and invalid fixtures. | Schema files and fixture test suite. |
| RB-256 | Which fields must never embed inside `.kolm` evals? | Compare source IDs, raw payload refs, scores, user/session hashes, and consent metadata against portable artifact contents. | Eval embedding allowlist. |
| RB-257 | How should source row checksums and import receipts work? | Define canonical JSON checksum, raw source checksum, importer manifest, and receipt IDs. | Import receipt spec. |
| RB-258 | How should namespace drift be fixed before importers land? | Compare `namespace`, `corpus_namespace`, bridge observations, labels export, and inbox filters. | Namespace migration plan and regression tests. |
| RB-259 | Which first fixture set proves field preservation? | Build Langfuse, Helicone, OpenPipe, LangSmith, Weave, and local observation fixtures with expected normalized output. | Golden fixture pack. |
| RB-260 | What is the `kolm-score-1` normalized score object? | Convert external score normalization memo into JSON schema and examples. | Score schema and validation fixtures. |
| RB-261 | How should score maps be configured per source/project? | Define numeric scale, direction, threshold, categorical maps, scorer trust, and eval_use fields. | Score-map config spec. |
| RB-262 | Which source scores can select holdout evals? | Test Langfuse, LangSmith, Braintrust, Phoenix, and Weave score fixtures with missing/known directions and thresholds. | Eval selection policy. |
| RB-263 | How should conflicting source scores be reported? | Create fixtures with human/user/LLM/code scorer disagreement. | Score conflict report. |
| RB-264 | Which score aggregates are allowed only in manifests? | Compare Weave summaries, Langfuse analytics, LangSmith feedback_stats, and Braintrust experiment summaries. | Aggregate-score guard tests. |
| RB-265 | What privacy modes should every importer support? | Specify hash-only, redacted, raw, and blocked semantics with fixture examples. | Import privacy mode schema. |
| RB-266 | What should an import manifest contain for purge and audit? | Define privacy mode, retention, row checksums, source checksums, raw sidecar refs, loss report, and source delete refs. | Import manifest schema. |
| RB-267 | How should redaction-before-persist work locally? | Define redactor hook interface, detector report, dropped-field behavior, and no-sample loss reports. | Redaction hook fixture. |
| RB-268 | How should import purge/anonymize work? | Delete normalized rows, raw sidecars, loss reports, label exports, cache entries, jobs, and write-back state. | `kolm import purge` spec. |
| RB-269 | Which importer privacy tests block launch? | Cover blocked mode, missing retention, raw allow flag, identity hashing, sidecar purge, artifact allowlist, and no-sample loss reports. | Import privacy CI gate. |
| RB-270 | What should `kolm-import-manifest-1` contain? | Define manifest ID, source checksum, row refs, privacy block, counts, artifacts, loss reports, and purge state. | Manifest JSON schema. |
| RB-271 | How should purge dry-run report targets? | Enumerate rows, scores, raw sidecars, labels, cache keys, writebacks, artifacts, blocked targets, and counts. | Dry-run output fixture. |
| RB-272 | How should delete and anonymize differ? | Define delete target removal and anonymize patch allowlists for rows, scores, comments, identities, and raw refs. | Purge mode spec and tests. |
| RB-273 | How should purge audit survive row deletion? | Add durable purge event or signed manifest update independent of deleted source rows. | Purge audit event design. |
| RB-274 | What cache helpers are required for import purge? | Add delete-by-key and configured data-root alignment for cache entries listed in import manifests. | Cache purge helper plan. |
| RB-275 | What exact Langfuse fixture pack should ship first? | Build traces observations scores datasets dataset items run items retention and expected-output files from the Langfuse importer spec. | Langfuse golden fixture directory. |
| RB-276 | How should Langfuse score-map fixtures fail closed? | Cover numeric direction thresholds boolean evidence categorical map misses text scores scorer origin and attachment targets. | Langfuse score-map fixture suite. |
| RB-277 | Which Langfuse dataset items become artifact eval cases? | Test expected output presence archived status schema validity source trace links dataset version timestamps and privacy boundaries. | Dataset-to-evalcase acceptance tests. |
| RB-278 | What manifest and loss-report assertions prove Langfuse import completeness? | Compare source counts row checksums mode-specific outputs blocked rows loss rows dry-run purge targets and no-sample reports. | Manifest and loss-report fixture gate. |
| RB-279 | When is Langfuse live API fetch safe to add? | Require fixture parity pagination coverage field-group preservation credential handling privacy modes and purge dry-run first. | Live connector readiness checklist. |
| RB-280 | What exact fixture files implement the Langfuse support-v1 pack? | Materialize traces observations scores datasets retention score-map and expected output files from the blueprint. | Executable fixture pack. |
| RB-281 | What semantic assertions should the fixture harness enforce? | Check pagination field groups structured IO scores loss rows manifest counts denylist and mode differences. | Importer fixture test harness. |
| RB-282 | How should hash-only output differ from redacted output? | Compare checksums source refs loss classes counts and IO payload suppression. | Hash-only fixture snapshots. |
| RB-283 | What purge dry-run output follows from the Langfuse manifest? | Enumerate rows scores loss reports sidecars caches writebacks non-purgeable artifacts and blocked targets. | Langfuse purge dry-run fixture. |
| RB-284 | Which source fields need canonical checksum rules? | Define canonical JSON for trace observation score dataset and loss rows before fixture snapshots ship. | Canonical checksum rule memo. |
| RB-285 | Which JCS implementation should Kolm use? | Compare dependency footprint test-vector support browser/server availability and security posture. | JCS implementation decision. |
| RB-286 | What checksum test vectors should block fixture generation? | Use RFC 8785 vectors plus Kolm domain-envelope examples, byte checksums, JSONL ordering, and manifest state updates. | Checksum test-vector suite. |
| RB-287 | How should import manifests display checksum provenance to operators? | Decide what source file row normalized evalcase score loss and state checksums are visible in CLI and APIs. | Manifest checksum UX contract. |
| RB-288 | How should checksum migration work if rules change? | Define rule_id versioning, dual-write windows, old-manifest verification, and migration reports. | Checksum migration policy. |
| RB-289 | How should checksum errors be reported without leaking data? | Create redacted diagnostics for malformed JSON, non-finite numbers, checksum mismatch, and missing row refs. | Checksum error taxonomy. |

## P1: Benchmarks And Runtime Targets

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-020 | What is the real recipe-tier performance on laptop/server? | Local benchmarks with 5 workloads, p50/p95, artifact size, receipt overhead. | Benchmark report and `/benchmarks` update. |
| RB-021 | What is the simplest local runtime target for a real model-bearing artifact? | Evaluate ONNX Runtime, llama.cpp/GGUF, LiteRT, Core ML, ExecuTorch bridge paths. | Runtime target decision memo. |
| RB-022 | What does "phone support" actually mean for v1? | iOS, Android, PWA/web target matrix with unsupported cases. | Platform support table for docs/site. |

## P1: Trust, Security, And Compliance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-030 | What is the strongest near-term recipe sandbox? | Compare isolated-vm, QuickJS, WASM/Wasmtime, Firecracker, worker isolation. | Sandbox decision and malicious test plan. |
| RB-031 | What receipt signing architecture should ship first? | Compare Ed25519 local keys, KMS/HSM, Sigstore/Rekor, tenant keys, key rotation. | Receipt v0.2 spec and migration plan. |
| RB-032 | What compliance evidence can Kolm honestly claim in Q2 2026? | DPA/BAA/subprocessor/security controls/current limitations. | Compliance posture page and sales one-pager. |
| RB-033 | What artifact trust levels should gate recipe execution? | Define trusted, curated, customer-private, and public-untrusted recipe policies. | Artifact trust-level schema and execution policy. |
| RB-034 | Can Kolm compile the current fixture recipes to a WASM-safe target? | Try a minimal WASM or DSL translation for sample/redactor/classifier recipes. | WASM recipe proof of concept. |

## P1: GTM And Buyer Proof

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-040 | Which first ICP has the fastest proof loop: AI-native SaaS, healthcare, fintech, defense, legal, or edge robotics? | Interview plan, buyer objections, pilot success metrics, willingness to pay. | ICP scorecard and design-partner list. |
| RB-041 | What pilot offer is clear enough to sell in one email? | Competitor pilot offers, Kolm proof assets, price/terms. | One-page design-partner offer. |
| RB-042 | What is the best public artifact pack for credibility? | Choose 8-12 tasks with evals, receipts, and live demos. | Seed registry plan. |

## P2: Pricing And Packaging

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-050 | Which pricing model avoids charging for local runtime while monetizing governance? | Compare competitor pricing and Kolm value units: compile, registry, receipt retention, org controls. | Pricing model memo and site copy update. |
| RB-051 | How should public/private registry SKUs work? | Enterprise package managers, model registries, compliance retention analogs. | Registry SKU spec. |
| RB-052 | What is the first paid unit Kolm should test? | Price-sensitivity interviews around compile jobs, accepted artifacts, receipt retention, registry artifact-months, and org seats. | Pilot pricing scorecard. |
| RB-053 | What proof is required before savings claims are priced? | Capture-to-artifact benchmark that measures avoided model calls and retained receipt evidence. | Savings claim proof protocol. |

## P0: Venture Redline Follow-Ups

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-290 | Which runtime target matrix can be published without overclaiming? | Real device list, target runtime, artifact tier, support status, fallback behavior, and benchmark command. | Runtime target matrix and `/research` update. |
| RB-291 | Which native baselines must be run before cross-platform claims expand? | Core ML, LiteRT, ONNX Runtime, ExecuTorch, llama.cpp, MLC, and server baselines where relevant. | Native benchmark pack with raw logs. |
| RB-292 | What exactly does local personalization mean in v1? | Retrieval/training decision, storage, encryption, deletion, device limits, eval impact, and review risk. | Personalization mechanics spec. |
| RB-293 | What does each artifact tier actually contain? | `kolm inspect --json` output for recipe, adapter, specialist, and bundle tiers. | Artifact contents proof fixtures. |
| RB-294 | How should registry pages prove trust? | K-score history, target profile, source provenance, review status, receipt sample, license, and revocation policy. | Public artifact detail template. |
| RB-295 | Which compliance claims can be said after legal/security review? | BAA/DPA posture, subprocessors, retention, audit logs, encryption, support access, limitations, and owner. | Compliance evidence map. |
| RB-296 | Which single vertical should get the first 90-day pilot offer? | Healthcare, fintech, and enterprise mobile buyer interviews with sales objections and success metric. | ICP scorecard and design-partner offer. |

## Research Operating Cadence

| Cadence | Work |
| --- | --- |
| Daily during launch sprint | Update `critical-insights.csv` for any claim/product gap discovered. |
| Weekly | Refresh top 10 competitor changes, ship one source-backed memo, close or advance backlog rows. |
| Monthly | Re-score competitor matrix, pricing, benchmarks, and regulatory source notes. |
| Before public claims | Verify with live code, live page, source link, and reproducible command. |
