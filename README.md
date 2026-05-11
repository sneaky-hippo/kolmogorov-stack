# kolm

The AI compiler. Compile a task into a signed `.kolm` artifact you own, run it offline on any device, verify every output.

```bash
npm i -g @kolmogorov/kolm
kolm login
kolm compile "your task" --examples ./examples.jsonl
kolm run your-artifact.kolm "new input"
```

You bring your own frontier API key. kolm uses it once, during compile. The result is a single signed file with model, examples, evaluator, and receipt chain. Runs on a laptop, phone, or in your VPC. Your data never moves.

Live: https://kolm.ai · Open spec: [public/docs/rs-1.md](public/docs/rs-1.md) · MIT licensed.

## Status

This repository currently ships:

- Public website, docs, pricing, articles, benchmarks, security, privacy, and account flows.
- HTTP API for signup/signin, synthesis, compile jobs, artifacts, receipts, registry export, recall, telemetry, and admin operations.
- Signed `.kolm` artifact packaging with `manifest.json`, `recipes.json`, `evals.json`, `receipt.json`, `signature.sig`, and placeholder runtime layers.
- Verified-inference and verified-wrap endpoints behind authentication and rate limits.
- JSON-backed single-node store with `KOLM_DATA_DIR` support for safe test isolation.
- Production hardening for admin keys, receipt secrets, proxy handling, security headers, and public health redaction.

Important implementation note: v0 `.kolm` files are cloud-runtime artifacts. They contain signed pointers plus recipe/eval/receipt data, not embedded production model weights. Full LoRA weight bundling, populated sqlite-vec recall indexes, and mature on-device runners are the next product gates.

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

`kolm` reads/writes `~/.kolm/` on macOS/Linux and `%USERPROFILE%\.kolm\` on Windows (via Node's `os.homedir()`). All shell-out hooks branch on `process.platform` to use `/bin/sh -c` on POSIX and `cmd /c` on Windows.

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

MIT. See the repository license metadata and source headers.
