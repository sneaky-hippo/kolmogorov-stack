# Codebase And Live-Site Gap Review

Review date: 2026-05-12

Scope:

- Local repo: `C:\Users\user\Desktop\kolmogorov-stack`
- Public repo snapshot: `C:\Users\user\Desktop\kolmogorov-stack-public`
- Live site checked: `https://kolm.ai/`
- Existing strategy docs reviewed: `README.md`, `STRATEGY.md`, `docs/SOTA-2026-05-11.md`, `docs/kolm-infra-business-strategy-report-2026-05-06.md`

## Bottom Line

The repo has a serious prototype for a signed artifact, receipt, verifier, CLI/API, SDK, and product website. The highest-risk gap is not absence of product direction. The highest-risk gap is claim synchronization:

- The live/product story implies owned offline artifacts with model/LoRA/index contents.
- The code and README still identify v0 artifacts as cloud-runtime pointer artifacts with recipe-tier payloads.
- Receipts are useful but HMAC-based today.
- Runtime isolation, storage, queues, benchmarks, and registry evidence are not yet enterprise-grade.

This is fixable, but it should be treated as P0 trust work.

## Evidence Map

| Area | Evidence | Current Meaning |
| --- | --- | --- |
| Product claim | Live homepage presents Kolm as a compiler into signed artifacts that run offline and can be shipped to laptop, phone, or VPC. | Strong category narrative, but it must be backed by artifact contents and runtime targets. |
| README caveat | `README.md` says v0 `.kolm` files contain signed pointers plus recipe/eval/receipt data, not embedded production model weights. | Repo is honest. Live copy should stay as honest or the implementation must catch up. |
| Compile pipeline | `src/compile.js` says Sprint 1 produces a cloud-runtime artifact whose `model.gguf` is a pointer resolved over HTTPS. | No full offline LoRA/model artifact yet. |
| Artifact builder | `src/artifact.js` writes `model.gguf` as a pointer record, `lora.bin` as optional KOLMPACK data, and `index.sqlite-vec` as optional KOLMIDX data. | Good forward-compatible slots, but current names can mislead if buyers expect real weights or sqlite-vec. |
| Receipts | `src/artifact.js` emits HMAC chain and `signature_alg: hmac-sha256`; `src/router.js` verifies HMAC receipts. | Good v0 proof inside issuer trust boundary, not yet public-key third-party proof. |
| Store | `src/store.js` supports JSON and optional SQLite via `KOLM_STORE_DRIVER`. | Better than earlier JSON-only risk, but default remains JSON and relational data model is still generic rows. |
| Jobs | `src/compile.js` uses `JOBS = new Map()` plus persisted job rows. | Process restarts and multi-worker operation are still weak. |
| Verifier sandbox | `src/verifier.js` uses `node:vm`, string denylist, and cooperative timeout; comments say production should harden. | Not a production boundary for untrusted code. |
| Specialist routes | `src/router.js` includes preview/fallback paths and messages that training is incomplete. | Specialist/LoRA claims should be roadmap/preview until end-to-end artifact exists. |
| Tests | `package.json` test command is `node --test tests/*.test.js`. | There is meaningful automated coverage. Docs-only updates do not require full app test run, but product claims require e2e artifact smoke tests. |

## Claim Governance Table

| Public Claim Type | Allowed Today | Needs Qualification | Needs Product Work Before Unqualified Claim |
| --- | --- | --- | --- |
| "Signed `.kolm` artifacts" | Yes. Artifact packaging and receipts exist. | Say v0 recipe-tier artifacts include pointer records, recipes, evals, and receipts. | Stable RS-1 conformance suite and public verifier examples. |
| "Run offline" | Only for deterministic recipe-tier behavior if no cloud runtime is needed. | Do not imply full local model weights for all tasks. | Local runners, embedded model/adapter or verifiable local resolver, platform matrix. |
| "Model and LoRA inside artifact" | Not generally true today. | `lora.bin` is a slot/behavior pack in v0.1, not a trained LoRA. | Real adapter/weight packaging with hashes and license provenance. |
| "Third-party verifiable receipts" | Partly. Endpoint verifies HMAC receipts if verifier has issuer secret. | HMAC is symmetric. It is not the same as public-key verification. | Ed25519 per signer, public key registry, optional Sigstore/Rekor anchor, offline verifier CLI. |
| "Compliance-grade" | Use carefully. | Say "audit evidence substrate", not "compliant". | DPA/BAA, subprocessor list, retention/export, access controls, SSO/RBAC, security review. |
| "Runs on phone" | Roadmap unless a mobile runtime artifact works. | Say target/runtime plan. | iOS/Core ML or Apple Foundation Models bridge, Android/LiteRT or ONNX bridge, test devices. |
| "Every API call trains a local LoRA" | Not today. | Say captures can become training signals. | Capture pipeline, label corpus, LoRA training backend, promotion, eval regression gate. |

## Current Code Strengths

1. Artifact packaging has a coherent internal shape: manifest, recipes, evals, model pointer, pack/index slots, signatures, and receipt.
2. K-score is implemented in code with accuracy, size, latency, cost, and coverage axes.
3. Receipts exist for artifact and run paths, with canonical JSON and constant-time HMAC checks.
4. The route surface is broad enough for self-serve: signup/signin, compile, run, verify, registry, recall, assistant, account, pricing, health.
5. The repo has JS SDK, Python SDK, MCP server, CLI, examples, tests, and static docs.
6. SQLite support is now present as a stepping stone from JSON.
7. Existing strategy docs are unusually candid about what remains prototype-only.

## Current Code Risks

| Risk | Severity | File Evidence | Why It Matters |
| --- | --- | --- | --- |
| Offline claim overreach | P0 | `README.md`, `src/compile.js`, `src/artifact.js` | Misalignment between live copy and artifact contents can break buyer trust. |
| Public proof gap | P0 | `src/artifact.js`, `src/router.js` | HMAC receipts are not enough for vendor-neutral public verification. |
| Sandbox boundary | P0 | `src/verifier.js` | Running untrusted generated code in `node:vm` is unsafe at production trust levels. |
| Job durability | P0 | `src/compile.js` | In-process jobs do not survive restarts reliably and cannot scale across workers. |
| Store model | P1 | `src/store.js` | JSON/default generic-row store makes access control, migrations, and reporting hard. |
| Registry proof | P1 | `public/registry.html`, `src/registry.js` | Registry needs real eval-backed artifacts to become moat, not content. |
| Specialist preview | P1 | `src/router.js`, `docs/TUNE.md` | LoRA/specialist story is strategically strong but should not be sold as shipped. |
| Benchmark absence | P1 | `docs/benchmark-results-v0.1.0.md`, benchmark docs | Buyers will compare with mature runtimes and cloud APIs. |

## Recommended P0 Trust Sprint

| Work | Acceptance Evidence |
| --- | --- |
| Align public copy with v0 reality | Live homepage, docs, and README all distinguish recipe-tier, pointer-tier, and future local-weight artifacts. |
| Produce one downloadable artifact evidence page | Artifact contents listed with hashes, eval cases, receipt JSON, verifier command, and limitations. |
| Add offline verifier CLI command | A user can verify a sample receipt without calling Kolm's API. |
| Define receipt modes | Docs and schema clearly show HMAC-dev, HMAC-tenant, Ed25519-public, and Rekor-anchored modes. |
| Choose production storage gate | `KOLM_STORE_DRIVER=sqlite` or Postgres becomes required for production readiness. |
| Add queue/job durability decision | Compile jobs survive process restart or explicitly fail with resumable state. |
| Replace or constrain sandbox | Untrusted recipe code cannot reach Node process capabilities; malicious tests are added. |
| Publish benchmark matrix | Real numbers for at least recipe-tier and one local runtime target. |

## Suggested Copy Guardrails

Use:

- "v0 recipe-tier artifacts carry recipes, evals, receipts, and signed model pointers."
- "Kolm is building toward local model/adapter packaging; current local proof is recipe-tier."
- "Receipts are HMAC-signed today; public-key receipt verification is the enterprise path."
- "Kolm targets Core ML, LiteRT, ONNX Runtime, ExecuTorch, llama.cpp, and Web/WASM runtimes."

Avoid unless implementation evidence exists:

- "One file includes the model and LoRA."
- "Runs offline on phone" for all artifacts.
- "EU AI Act compliant."
- "Third-party verifiable" without explaining HMAC/public-key mode.
- "Every call trains a local LoRA."

## Public Repo Snapshot Note

`kolmogorov-stack-public` is a smaller OSS-facing snapshot with CLI, docs, examples, services, source, and tests. It does not include the full public website or API surface from the private/main workspace. Use it for open-source packaging review, not as the complete product state.

