# kolm

The AI compiler. Compile a task into a signed `.kolm` artifact you own, run it offline on any device, verify every output.

```bash
npm i -g github:sneaky-hippo/kolmogorov-stack
kolm build my-redactor --from redactor --yes     # one-shot: scaffold + seeds + compile + verify
kolm run my-redactor.kolm '{"text":"call 555-1212"}'
```

The `kolm build` one-shot is the fastest path: it scaffolds the spec, drops in starter seeds, compiles, and verifies — printing the K-score, the failing cases (if any), and the exact iterate command. The four underlying verbs (`kolm new`, `kolm seeds new`, `kolm compile`, `kolm verify`) still exist for power use and CI:

```bash
kolm signup --email you@example.com               # or: kolm login --key ks_... (paste from /signup)
kolm compile "your task" --examples ./examples.jsonl   # cloud-compile w/ your frontier key
kolm run your-artifact.kolm "new input"
```

You bring your own frontier API key. kolm uses it once, during compile. The result is a single signed file with recipe code, examples, evaluator, and receipt chain. Runs on a laptop, phone, or in your VPC. Your data never moves.

If you'd rather talk to the CLI, `kolm chat` opens an interactive session that maps natural-language asks to real verbs — "make me a redactor recipe" runs `kolm new --from redactor`, "anonymize my customer data" runs `kolm seeds generate --strategy redact-pii-templated`, "upgrade kolm" runs `kolm update`. Add `--airgap` to keep it narration-only on disconnected boxes. `kolm anonymize <file>.jsonl` is a first-class shortcut for the same PII-templated seeds path with no LLM and no network.

## What ships in v0.2 (wave 144)

Four new pillars land in this release. Each one is real code with a passing test file you can run today; nothing is a roadmap claim.

- **`kolm moe compose`** — combine N expert `.kolm` files into a single composite with a deterministic router (keyword regex, `intent_field`, or `first_match`). The Kimi/Qwen MoE pattern, applied to compiled recipes: small experts, cheap routing, one signed artifact. Per-expert sha256 + recipe source hash + router spec live in `training_stats.moe` so the receipt chain captures the composition exactly. `kolm moe inspect <composite.kolm>` reads the block back. Tests: `tests/wave144-moe-compose.test.js`.

- **`kolm tokenize {train,encode,decode,inspect}`** — pure-JS byte-level BPE tokenizer (spec id `kolm-tokenizer-1`). Trains on a JSONL/text corpus, round-trips any UTF-8 input (the byte-level fallback guarantees it), serialises to a single `tokenizer.json` you can ship inside the `.kolm`. `kolm compile --tokenizer tokenizer.json` embeds it into the artifact and the manifest records `tokenizer.spec`, `tokenizer.vocab_size`, and `tokenizer.sha256`. No native deps. Tests: `tests/wave144-tokenizer.test.js`, `tests/wave144-tokenizer-artifact.test.js`.

- **`kolm extract <file>`** — pure-JS text extraction front door for `.kolm` pipelines. Handles plain text, JSON/JSONL flatten, HTML tag strip with paragraph breaks, and a built-in PDF text-layer extractor that inflates `FlateDecode` content streams and walks `BT`/`ET`/`Tj`/`TJ`/`'`/`"` operators. Images require `--ocr` (shells out to `tesseract` if installed) or `--vision` (Anthropic vision API, needs `ANTHROPIC_API_KEY`); without one of those flags an image input fails with a clear error rather than silently producing empty text. Output ships `{ kind, text, pages?, source, sha256, warnings[] }`. Tests: `tests/wave144-extract.test.js`.

- **`kolm doc check <file> --type <spec>`** — multimodal document completeness gate. Five built-in specs (`claim-packet`, `denial-letter`, `pa-request`, `eob`, `appeal-letter`) cover the common health-insurance document classes; `kolm doc types` lists them. Custom specs are JSON conforming to `kolm-docspec-1` with `required_patterns`, `forbidden_patterns`, `required_sections`, and word-count gates. Verdict is `pass` / `warn` / `fail`; the CLI exits `0` on pass-or-warn and `2` on fail so it composes with shell pipes and CI gates. Score is `(required_passed + 0.5 * warn_passed) / total`. Tests: `tests/wave144-doc-check.test.js`.

All four ship in pure JavaScript. None of them require a C, Rust, or Python toolchain. Heavy ML deps (real LoRA training, ONNX export, INT4 quantization) remain explicitly **roadmap** in the gates list below; this release does not pretend one class is another.

## Primary use case: clinical AI inside the hospital network

kolm was built around healthcare. The architecture supports BAA-bounded deployment so PHI never leaves the hosts your security team already trusts. Reference workloads: prior-auth triage, encounter-note drafting for sign-off, ICD-10 coding, intake routing, drug-name redaction. Every output carries an HMAC-bound receipt your clinical informatics committee can re-verify. See [public/healthcare.html](public/healthcare.html) for the canonical positioning and the reference artifacts (hipaa-summarizer, intake-triage, drug-name-redact). BAA review is a per-customer step in Enterprise onboarding, not a generic template the product ships.

Other supported deployment shapes: finance (SR 11-7 model risk, examinable receipt chain), legal (privileged work inside the firm boundary), edge and offline.

Live: https://kolm.ai · Open spec: [public/docs/rs-1.md](public/docs/rs-1.md) · Apache-2.0 licensed.

## Status

This repository currently ships:

- Public website, docs, pricing, articles, benchmarks, security, privacy, and account flows.
- HTTP API for signup/signin, synthesis, compile jobs, artifacts, receipts, registry export, recall, telemetry, and admin operations.
- Signed `.kolm` artifact packaging with `manifest.json`, `recipes.json`, `evals.json`, `receipt.json`, `signature.sig`, optional `tokenizer.json` (wave 144), and optional `moe.json` for composite artifacts (wave 144).
- Verified-inference and verified-wrap endpoints behind authentication and rate limits.
- JSON-backed single-node store with `KOLM_DATA_DIR` support for safe test isolation.
- Production hardening for admin keys, receipt secrets, proxy handling, security headers, and public health redaction.

Honest implementation note: `.kolm` artifacts in v0.2 carry compiled JavaScript recipe code, the seed corpus, the evaluator, the receipt chain, and (when produced via `kolm tokenize` + `kolm compile --tokenizer`) a deterministic byte-level BPE tokenizer. They do **not** carry trained LoRA weights, ONNX graphs, INT4-quantized tensors, or sqlite-vec indexes — those remain explicit roadmap items. Where the code does its job today is rule-class transforms (redaction, normalization, classification with deterministic comparators), MoE composition of those recipes, and document completeness checks. The four wave-144 features above are real and tested; the model-class artifacts named in the "Product Gates" section are not in this release.

## Local Setup

Works on macOS, Linux, and Windows. Requires Node.js 20+ on PATH.

```bash
# macOS / Linux
cp .env.example .env
npm install
npm start
```

```powershell
# Windows (PowerShell)
Copy-Item .env.example .env
npm install
npm start
```

Open:

- `http://localhost:8787/`
- `http://localhost:8787/docs`
- `http://localhost:8787/benchmarks`
- `http://localhost:8787/security`

### CLI install (any OS)

```bash
npm i -g github:sneaky-hippo/kolmogorov-stack
kolm version
```

This repository is public. The shortcut above resolves to
`https://github.com/sneaky-hippo/kolmogorov-stack` and `npm` clones it over HTTPS
with no auth. If the install hangs silently:

1. Re-run with `--verbose` to see what npm is stuck on:
   ```bash
   npm i -g github:sneaky-hippo/kolmogorov-stack --verbose
   ```
2. Use the explicit HTTPS URL (skips git-protocol negotiation on some networks):
   ```bash
   npm i -g git+https://github.com/sneaky-hippo/kolmogorov-stack.git
   ```
3. Or fetch a tarball directly (no git required at all):
   ```bash
   npm i -g https://github.com/sneaky-hippo/kolmogorov-stack/archive/refs/heads/main.tar.gz
   ```
4. After install completes:
   ```bash
   kolm version
   kolm doctor
   ```

`kolm` reads/writes `~/.kolm/` on macOS/Linux and `%USERPROFILE%\.kolm\` on Windows (via Node's `os.homedir()`). All shell-out hooks branch on `process.platform` to use `/bin/sh -c` on POSIX and `cmd /c` on Windows.

The canonical install is always the GitHub repo above (not the unrelated `kolm`
package on the public npm registry). `kolm upgrade` reads the version off the
GitHub main branch's `package.json` to compare; `kolm update` re-runs the GitHub
install one-shot.

Run tests:

```bash
npm test
```

The tests boot isolated servers on dynamic ports and write to temporary data directories. They should not mutate the real `data/` directory.

## Required Production Environment

Set these before hosting anything public:

```bash
ADMIN_KEY=ks_admin_<random>
RECIPE_RECEIPT_SECRET=ks_receipt_<random>
KOLM_DATA_DIR=/path/to/durable/data
KOLM_ARTIFACT_DIR=/path/to/durable/artifacts
KOLM_RECALL_ROOT=/path/to/recall/root
INVITE_ONLY=true
```

Optional provider config:

```bash
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-opus-4-7
RATE_LIMIT_PER_SEC=20
RATE_LIMIT_BURST=60
```

Production behavior:

- `ADMIN_KEY` has no development fallback in production-like hosts.
- `RECIPE_RECEIPT_SECRET` is required for receipt verification and `.kolm` artifact signing in production-like hosts.
- `/v1/wrap/verified` and `/v1/verified-inference` require a valid tenant key.
- Public `/health` is intentionally minimal and should be used for uptime only.
- Public `/ready` is the deploy gate. In production-like hosts it returns `503` until critical signing config is present.
- Authenticated `/v1/health` contains the fuller runtime snapshot and readiness detail for staff.

## API Surface

Public:

- `GET /health`
- `GET /ready`
- `GET /v1/pricing`
- `POST /v1/signup`
- `POST /v1/signin`
- `POST /v1/signout`
- `POST /v1/anon/bootstrap`
- `POST /v1/anon/claim`
- `GET /v1/public/concepts`
- `GET /v1/public/concepts/:id`
- `POST /v1/public/run`
- `POST /v1/receipts/verify`
- `GET /v1/spec`
- `GET /v1/registry/export`

Authenticated:

- `GET /v1/health`
- `POST /v1/compile`
- `GET /v1/compile`
- `GET /v1/compile/:id`
- `GET /v1/compile/:id/.kolm`
- `GET /v1/artifacts`
- `GET /v1/artifacts/:id`
- `GET /v1/artifacts/:id/download`
- `POST /v1/wrap/verified`
- `POST /v1/verified-inference`
- `POST /v1/recall`
- `POST /v1/embed`
- `GET /v1/recall/status`
- `GET /v1/account`
- `POST /v1/account/rotate-key`
- `POST /v1/synthesize`
- `POST /v1/synthesize/stream`
- `POST /v1/synthesize/batch`
- `POST /v1/verify`
- `POST /v1/publish`
- `GET /v1/concepts`
- `POST /v1/run`
- `POST /v1/compose`
- `GET /v1/telemetry`
- `GET /v1/library`

Admin:

- `POST /v1/admin/tenant`
- `GET /v1/admin/tenants`
- `GET /v1/admin/waitlist`
- `GET /v1/admin/submissions`

## Architecture

The API is a single Express server:

- `server.js` mounts security headers, static pages, docs aliases, public routes, API routes, and branded error pages.
- `src/router.js` owns HTTP routing, auth boundaries, receipt verification, compile endpoints, registry export, and legacy recipe endpoints.
- `src/auth.js` provisions tenants, validates API keys, rotates keys, applies usage limits, and disables fallback admin auth in production.
- `src/env.js` centralizes production detection and receipt-secret selection.
- `src/compile.js` runs the v0 compile job state machine.
- `src/artifact.js` builds and signs `.kolm` zip artifacts.
- `src/store.js` is a JSON-backed store with `KOLM_DATA_DIR` override.
- `tests/*.test.js` cover auth hardening, e2e behavior, production proxy config, route/assets resolution, sitemap rules, and brand-token drift.

## Production Data Caveat

The built-in JSON store is acceptable for demos, local development, and single-node prototypes. It is not the final multi-tenant production database.

Before serious public launch, swap it for a durable transactional store:

| Current | Production target |
| --- | --- |
| JSON files in `KOLM_DATA_DIR` | Postgres, SQLite with backups, or D1 |
| In-memory rate counters | Redis-backed token buckets |
| Single-node artifact disk | Object storage with signed URLs |
| In-memory compile job cache | Durable job queue |
| Inline scripts on static pages | External JS and stricter CSP |

## Security Checklist

- Never commit provider keys, FAL keys, admin keys, receipt secrets, or tenant API keys.
- Treat any key pasted into chat, logs, screenshots, or tickets as compromised.
- Set `INVITE_ONLY=true` until abuse controls and billing are ready.
- Keep `RECIPE_RECEIPT_SECRET` stable; rotating it invalidates prior receipts.
- Run `npm test` before deploy.
- Confirm `/robots.txt` excludes `/v1/`, `/api/`, `/admin`, `/dashboard`, `/onboarding`, and `/signin`.

## Product Gates

The next gates before claiming full terminal-state parity with the public positioning:

- Replace JSON store with a durable production database.
- Implement real LoRA/model layer bundling for `.kolm` artifacts.
- Populate and query sqlite-vec recall indexes inside artifacts.
- Ship native/mobile/web runtimes that execute artifacts without cloud runtime dependency.
- Publish hardware benchmark results against Core ML, LiteRT, ONNX Runtime Mobile, ExecuTorch, llama.cpp, and MLC.
- Add third-party security/compliance evidence for enterprise claims.

## License

Apache-2.0. See [LICENSE](LICENSE).
