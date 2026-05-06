# Recipe

**Show us how once. Run the recipe a million times for free.**

You paste 4–8 examples of a yes/no or pick-a-category question. We give you back a tiny program that answers it forever, for free, in under a millisecond.

That's the whole product on the surface. Underneath it's a synthesis engine, a versioned registry, an edge runtime, and the data-labeling layer for every future fine-tune.

> Engine code-named **Kolmogorov**. Retail brand: **Recipe**, the Skills layer of [REM Labs](https://remlabs.ai).
> Three pillars: **Memory** (what happened) · **Skills** (how to do things — *this repo*) · **Specialists** (a model that *became* the task).

---

## Live

**Production:** https://kolmogorov-stack-production.up.railway.app

| | |
|---|---|
| **Home** | https://kolmogorov-stack-production.up.railway.app/ |
| **Playground** | https://kolmogorov-stack-production.up.railway.app/playground |
| **Recipes** | https://kolmogorov-stack-production.up.railway.app/registry |
| **Live runtime** | https://kolmogorov-stack-production.up.railway.app/dashboard |
| **Why this exists** | https://kolmogorov-stack-production.up.railway.app/why |
| **API & SDKs** | https://kolmogorov-stack-production.up.railway.app/docs |
| **Pricing** | https://kolmogorov-stack-production.up.railway.app/pricing |
| **Specialists (preview)** | https://kolmogorov-stack-production.up.railway.app/specialists |
| **Status** | https://kolmogorov-stack-production.up.railway.app/status |
| **Get a key** | https://kolmogorov-stack-production.up.railway.app/signup |

10,000 recipe-calls / month, free, no card.

```bash
# 1. mint a key
KS=$(curl -sS -X POST https://kolmogorov-stack-production.up.railway.app/v1/signup \
  -H 'Content-Type: application/json' -d '{"email":"you@company.com"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['api_key'])")

# 2. show it how once
curl -X POST https://kolmogorov-stack-production.up.railway.app/v1/synthesize \
  -H "Authorization: Bearer $KS" -H "Content-Type: application/json" -d '{
    "name": "is-spam",
    "output_spec": { "type": "boolean" },
    "positives": [
      { "input": "FREE viagra click here", "expected": true },
      { "input": "URGENT — claim your prize", "expected": true },
      { "input": "Lunch tomorrow at noon?", "expected": false }
    ]
  }'
# → { accepted: true, concept_id: "cpt_…", quality_score: 1.0, latency_p50_us: 53 }

# 3. run the recipe forever
curl -X POST https://kolmogorov-stack-production.up.railway.app/v1/run \
  -H "Authorization: Bearer $KS" -H "Content-Type: application/json" \
  -d '{ "concept_id": "cpt_…", "input": "WIN a free iPhone" }'
# → { output: true, latency_us: 87, cache: null }
```

---

## What this replaces

The repeat AI calls in your product where the answer is small and structured.

| Today you might be using… | Recipe replaces it when… |
|---|---|
| A Claude / GPT call to classify support tickets | You have ~10 examples and the answer is one of N labels. |
| A Cohere classify endpoint | Same — Recipe is ~1000× cheaper and ~100× faster. |
| A regex you're scared to touch | You'd rather have a small program with tests than 80 chars of cryptic regex. |
| A DistilBERT fine-tune for spam / NSFW / language ID | You want it deployed on the edge with no GPU and no model weights. |
| A custom OpenAI fine-tune | Your task is small enough that a 400-byte JS function is enough. |

**Honest math (1M calls/month, yes/no classification):**
- Claude Sonnet 4.6: ~$675/mo
- Cohere classify: ~$2,000/mo (list price)
- OpenAI fine-tune (gpt-4.1-mini): ~$3,800/mo + ~$50 train
- **Recipe (Pro plan): $20/mo flat. Plus 10 minutes of your time.**

Recipe pays itself off after the first ~500 calls. After that, the meter stops — running a recipe in our edge runtime is essentially free, and if you self-host the JS source you pay *nothing*.

---

## What this does NOT do

Recipe is the right tool for *small, structured, repeating* questions. It is the wrong tool for everything below — use the right tool for those:

- **Open-ended generation.** "Write a marketing email." Use Claude / GPT.
- **Long-context reasoning.** "Read this 80-page PDF and extract the contract clauses." Use a model with long context.
- **Multi-step agent loops.** Browse, plan, take actions. Use Claude Code, OpenAI Assistants, or a real agent harness.
- **World knowledge / domain inference you don't have examples for.** "Is this molecule toxic?" with no labeled data — you need real training and real data.
- **Recall over a corpus.** "Find me prior conversations with this customer." That's [REM Labs Memory](https://remlabs.ai), not Skills.
- **Tasks where the right answer changes with world state.** "Is this stock a buy?" — not a fixed recipe; that's an inference problem with fresh data.
- **RAG over your knowledge base.** Recipe doesn't retrieve text. It retrieves and *executes* tiny programs.

If your task is fuzzy enough that a small program can't capture it, you want a [Specialist](https://kolmogorov-stack-production.up.railway.app/specialists) — same examples, but trained into a small LoRA. Specialists is the next pillar; preview live, full launch Day 60–120.

---

## Run it locally

```bash
cp .env.example .env       # optional — set ANTHROPIC_API_KEY for Claude path
npm install
npm start                  # auto-seeds 26 example recipes on first boot, http://localhost:8787
```

The boot log prints a demo API key. Save it as `KS`:

```bash
export KS=ks_…
```

---

## URLs

| | |
|---|---|
| `/` | Home / pitch |
| `/playground` | Build a recipe — live SSE stream |
| `/registry` | Browse recipes (yours + public) |
| `/dashboard` | Live runtime telemetry — p50/p95/p99 |
| `/why` | What it replaces, when not to use, ROI math |
| `/docs` | Full HTTP API + SDK reference |
| `/pricing` | Free / Pro / Scale tiers |
| `/specialists` | Forward-looking: paste examples → fine-tuned LoRA |
| `/status` | Live system health, version, changelog, roadmap |
| `/signup` | Mint a free API key |
| `/health` | JSON liveness + stats |

## API surface (21 endpoints)

```
POST   /v1/signup                   # public — mint a tenant + key
POST   /v1/synthesize               # build a recipe from examples
POST   /v1/synthesize/stream        #   SSE: plan/candidate/verified/accepted/published/done
POST   /v1/synthesize/batch         #   up to 25 recipes per request
POST   /v1/verify                   # test source against examples
POST   /v1/publish                  # manual publish of a hand-edited recipe

GET    /v1/concepts                 # list your recipes
GET    /v1/concepts/:id             # get a recipe
DELETE /v1/concepts/:id
GET    /v1/concepts/:id/lineage
GET    /v1/concepts/:id/stats       # invocations, cache hit rate, latency percentiles
POST   /v1/search                   # semantic via 256-d recipe vectors
GET    /v1/public/concepts          # public — no auth
GET    /v1/public/concepts/:id      # public
POST   /v1/public/run               # public — try any public recipe

POST   /v1/run                      # run a recipe
POST   /v1/compose                  # strategies: attention | voting | top1 | sequential

GET    /v1/account
POST   /v1/account/rotate-key
GET    /v1/telemetry                # p50/p95/p99 + sparkline
GET    /v1/library

POST   /v1/specialists/waitlist     # reserve a Specialists slot (preview)

POST   /v1/admin/tenant             # admin only
GET    /v1/admin/tenants
```

See `/docs` (live) for full request/response shapes and per-language SDK examples.

---

## Architecture notes

- **Synthesis** (the *show* layer) tries Claude Opus 4.7 (when `ANTHROPIC_API_KEY` is set) then a deterministic pattern synthesizer (5 patterns: bool keywords, regex extract, classifier, number regression, count). Every candidate goes through the same verifier and quality gate (`quality_score >= 0.85 && pass_rate_positive >= 0.85`). Generated source is plain JS taking `(input, lib)`.
- **Registry** (the *get* layer) persists to JSON files under `data/`. Recipes have versions, lineage, a 256-d hash-bag-of-n-grams vector for similarity, and per-tenant access control. Public recipes opt in via `visibility: "public"`.
- **Runtime** (the *run* layer) keeps a 10-minute warm compile cache + 3-tier output cache (in-memory LRU → disk → object store stub). Four composition strategies. Per-tenant token-bucket rate limit (20 req/s sustained, 60 burst). Monthly quota.
- **Security:** HSTS, X-Frame-Options DENY, X-Content-Type-Options nosniff, CORS preflight. API keys in `Authorization: Bearer …` or `X-API-Key`. Admin gate is independent and reads `ADMIN_KEY` env.

## Production swap-outs

The demo build optimises for zero external dependencies. Production swap-outs (drop-in):

| Demo | Production |
|---|---|
| JSON file store (`src/store.js`) | Postgres or Cloudflare D1 |
| Node `vm` sandbox (`src/verifier.js`) | `isolated-vm` or Wasmtime |
| Hash bag-of-n-grams embed (`src/embedding.js`) | Voyage AI / OpenAI / sentence-transformers |
| Single-node disk cache (`src/cache.js`) | Redis cluster + S3 |
| In-memory token bucket (`src/auth.js`) | Redis token bucket |

## SDKs & integrations

- **Node / TypeScript:** `npm i @kolmogorov/recipe`
- **Python:** `pip install kolmogorov-recipe`
- **Claude Code MCP:** `npx -y @kolmogorov/recipe-mcp` (synthesize + run as MCP tools)
- **VS Code extension:** scaffolded — watches your source for repeated LLM-style calls and offers *"replace with a recipe?"*

Each SDK is a thin wrapper over the HTTP API. See `/docs#sdk` for full snippets.

## Tests

```bash
npm test            # boots a server on :8801, exercises all layers via HTTP
npm run demo        # in-process end-to-end flow with prints
bash scripts/smoke-live.sh   # 45-check live battery against the production URL
```

## Deploy

- **Docker:** `docker build -t kolmogorov . && docker run -p 8787:8787 kolmogorov`
- **Railway:** `railway up` — `railway.toml` + `Dockerfile` are wired. Set `ADMIN_KEY` and (optionally) `ANTHROPIC_API_KEY`.
- **Vercel:** `vercel --prod`. The filesystem is read-only there — wire `src/store.js` to a managed store first.

## Roadmap

| When | What |
|---|---|
| Day 7–30 | npm + Python + MCP + VS Code distribution |
| Day 30–60 | `/v1/recipes/:id/label-corpus` — auto-label a HuggingFace dataset with one of your recipes |
| Day 60–120 | **Specialists** launch — paste examples, get a fine-tuned LoRA. Integrates the existing [REM Labs](https://remlabs.ai) LoRA pipeline |
| Day 120–180 | Public registry submissions, top-100 spotlight, embed API, search-first discovery |
| Day 180+ | Compounding: Memory ↔ Recipe ↔ Specialist routing inside the REM Labs console; Specialist marketplace |

---

*Recipe is the **Skills** layer of [REM Labs](https://remlabs.ai). Memory remembers. Skills repeat. Specialists become.*
