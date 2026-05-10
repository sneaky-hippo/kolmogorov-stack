# Customer demo runbook

**Goal:** in 5 minutes, take the customer from "I don't get it" to "where do I sign up." All real, no mocks, all on a publicly-deployed URL.

**Live:** https://kolmogorov-stack-production.up.railway.app

---

## Open with the cost math (15 seconds — get them leaning in)

> "How many AI calls are you making per month for repeat questions — yes/no, pick a category, extract these tokens?"

Wait for a number. Whatever they say, do the math out loud:

> "OK, 1M calls per month at ~$0.001 per call to Claude Sonnet 4.6 — that's about **$675/month, $8,000/year**, just to have a 70-billion-parameter model answer questions a 400-byte JS function would answer for free, in 35 microseconds, with the same answer every time."

> "Recipe pays itself off after the first ~500 calls. After that, the meter stops."

This is the hook. Now show them what they actually get.

---

## Before they arrive (10 seconds)

Open four browser tabs:

1. https://kolmogorov-stack-production.up.railway.app/ — the pitch (Recipe + 3-pillar framing)
2. https://kolmogorov-stack-production.up.railway.app/playground — synthesis, live
3. https://kolmogorov-stack-production.up.railway.app/registry — 26 recipes already published
4. https://kolmogorov-stack-production.up.railway.app/dashboard — telemetry refreshing every 2s

Mint yourself a key:

```bash
KS=$(curl -sS -X POST https://kolmogorov-stack-production.up.railway.app/v1/signup \
  -H 'Content-Type: application/json' -d '{"email":"demo@example.com"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['api_key'])")
echo $KS
```

---

## Tab 1 — Home (45 seconds)

> "Three steps. Show. Get. Run. You paste examples. We synthesize a tiny program. You get an endpoint and the source. You run it forever for free."

Point at the comparison table. **Recipe vs Claude / Cohere / OpenAI fine-tune**: 1000× cheaper, 100× faster, deterministic, runs at the edge, fits in 400 bytes.

Scroll to the **three-pillar block at the bottom**: Memory · Skills · Specialists. Recipe is the middle pillar — Skills. Specialists is the headline product launch on Day 60–120: paste examples, get a fine-tuned LoRA.

---

## Tab 2 — Playground (90 seconds — the hero moment)

> "Watch me build a recipe from scratch."

Click `classify-issue-type` in the examples sidebar. The form populates with 6 examples. Click **Watch live**.

The event log paints in real time, in plain English:
- `start → planning approach → asking Claude → drafting program → tested 6/6 examples → passed → published`

Each event has a microsecond timestamp.

Within ~2 seconds the result panel shows:
- Quality score (1.000)
- Latency p50 in microseconds
- Recipe size in bytes
- The actual recipe source (12 lines of JS, readable, editable)
- Test trace (every example passing)
- A "try it live" box
- **An ROI banner**: *"this recipe replaces ~$3/mo of AI calls at 1k tickets/day"*

Type into the live box: `deploy crashes since friday`. Hit run. Returns `{ output: "bug", latency_us: ~38, cache: null }`. Run it again. Returns `cache: "L1"` and `latency_us: <1`.

> "That recipe is now in the registry. It has a version, a vector, lineage. Anyone on the team can call it."

Edit the source — change a keyword. Click **Re-test**. Quality score recomputes. Click **Publish edited version** — a new version lands.

---

## Tab 3 — Registry (45 seconds)

> "26 recipes already in here. Search by meaning, not keyword."

Type in the search box: `extract email addresses`. Watch `extract-emails` rank first.

Click into it. Show the friendly summary card: **Quality 1.00 · p50 latency 47 µs · Built by Claude**. The engineering details (vector dim, source hash, lineage) are tucked behind a `(details)` toggle — they're there if engineers want them, not in the way otherwise.

Run it on `ping me at hello@kolm.ai or hi@example.com`. Returns `["hello@kolm.ai", "hi@example.com"]`.

---

## Tab 4 — Live runtime (30 seconds — the credibility reveal)

> "This is real. Right now, on a public URL."

The banner at the top is the closer:
> *"Claude Sonnet 4.6 typical: ~600 ms per call · Recipe: see p50 below — usually 30–50 µs."*

Show:
- 26 recipes, growing tenant count
- p50 / p95 / p99 percentile cards
- Cache hit rate climbing as the demo continues
- The **sparkline** of the last 60 invocations
- Recent invocations table updating live

---

## The compositional moment (60 seconds — the magic)

In the playground or via curl:

```bash
curl -X POST https://kolm.ai/v1/compose \
  -H "Authorization: Bearer $KS" -H "Content-Type: application/json" -d '{
    "query": "extract things from text",
    "input": "contact hello@kolm.ai or 555-123-4567 about $99 price on 2026-04-15",
    "strategy": "attention",
    "k": 5
  }'
```

Returns the merged output of `extract-emails`, `extract-phones`, `extract-prices`, `extract-dates` running in parallel, weighted by relevance:

```json
{
  "output": ["hello@kolm.ai", "$99", "2026-04-15", "555-123-4567"],
  "dispatched": [4 recipes, all sub-100µs],
  "strategy": "attention"
}
```

> "Four recipes retrieved by semantic similarity, dispatched in parallel, merged into one output. End-to-end under a millisecond."

---

## The forward-looking close (60 seconds — the bigger play)

Click `/specialists` in the top nav. Pause for them to read the headline:

> *"Paste examples. Get a tiny model trained for your task. Runs locally, free, forever."*

> "Recipe is one pillar of three. Skills is what an AI can repeat — that's Recipe. Specialists is *a model that's been the task* — same examples, but baked into a small LoRA you can run on your laptop, your edge, your phone. The artifact you ship is a signed `.kolm` file."

> "Today you'd see Recipe ship. Day 60–120 you'll see the same examples produce a Specialist. Day 180 they compound — recipes become training data, Specialists generate new recipes, Memory routes between them."

---

## Pricing rails (30 seconds)

Click `/pricing`. Three tiers. Free is real.

| | |
|---|---|
| **Free** | $0, 10k recipe-calls / mo, no card |
| **Pro** | $20/mo + usage, 1M included, private registry, priority Specialists |
| **Scale** | talk to us — air-gap, SOC 2, dedicated support, custom Specialists |

Per-unit on the same page if they want to dig in.

---

## If they ask "but what about Claude / Cohere / OpenAI?"

> "We use them. Claude is our synthesis substrate today. As the registry grows, we replace them — the synthesizer trains up on our own labeled data. Year 1 we ride on top; year 3 we own the model."

## If they ask "isn't this just RAG?"

> "RAG retrieves text. Recipe retrieves and *executes*. RAG gives you 'the price of widget X is in this paragraph.' Recipe gives you `38.99` because the price-extractor recipe ran on the paragraph. Different output, different latency, different unit economics."

## If they ask "what if you can't synthesize for our domain?"

> "Two paths. The pattern path runs without an LLM and handles ~60% of common cases. The Claude path handles the rest. For your domain we'd run synthesis-with-feedback: every rejected candidate becomes a refinement pass with the failures fed back as additional context. And if your task is too fuzzy for any small program — that's exactly when you want a Specialist instead."

## If they ask "doesn't a small JS program eventually break on weird inputs?"

> "Yes — at the edges. Every recipe ships with its examples and a re-verify endpoint. When you see a class of inputs the recipe gets wrong, you add 2 examples and re-synthesize. The version control means you roll back if the new one is worse. Past a certain fuzziness, you train a Specialist instead. Both products live in the same console."

---

## Hand them the SDK

```js
// 30 lines, drop into any project
import { Recipe } from '@kolmogorov/recipe';

const r = new Recipe({ apiKey: process.env.KS });

// build it once
const recipe = await r.synthesize({
  name: 'classify-issue-type',
  positives: [
    { input: 'crash on submit',  expected: 'bug' },
    { input: 'add dark mode',    expected: 'feature' },
    { input: 'how do I export?', expected: 'question' },
  ],
});

// run it forever
await r.run(recipe.concept_id, 'login button broken');  // → 'bug'
```

---

## Live verified numbers (Railway US-West, 2026-05-06)

| Metric | Value |
|---|---|
| Cold dispatch latency p50 | 4–50 µs (depends on recipe) |
| Cold dispatch latency p99 | ~380 µs |
| Cache hit latency | <1 µs (in-memory LRU) |
| 50 parallel runs round-trip | 1.3 s including transatlantic network |
| 10 parallel synthesizes | 833 ms |
| Pattern-path synthesis | 2–5 ms per recipe |
| Quality score floor | 1.00 across all 26 demo recipes |
| Recipe size | 104 B (extract-urls) → 603 B (intent classifier) |
| Compose K=3 attention round-trip | <250 µs server-side |
| 45/45 endpoint smoke battery | PASS |

---

## The strategic backdrop (only if they ask "why are you building this?")

This is the picks-and-shovels layer for compositional AI.

1. **It compounds.** Every accepted recipe is training data for our specialized synthesizer. Every dispatch is telemetry that improves cache prediction.
2. **It feeds Specialists.** A Recipe + a HuggingFace corpus = 100k auto-labeled examples = a fine-tuned LoRA. Recipe is the data-labeling layer that the Specialists product ships on.
3. **It's real.** Not a deck — every number on screen is from running code on a public URL. They can mint a key right now and have a working recipe inside 60 seconds.

---

## Reset between demos

The demo registry seeds itself on every fresh deploy. To clear customer-specific state without redeploying:

```bash
# kill server, wipe data/, restart — auto-seed runs again
railway redeploy
```
