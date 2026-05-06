# kolmogorov-recipe

> **Recipe.** Show how once. Run forever.
> The Skills layer of [REM Labs](https://remlabs.ai).

A thin Python client for the Recipe HTTP API — replaces repeat LLM-as-judge calls with deterministic JS classifiers that run in microseconds, for free, and always return the same answer.

## Install

```bash
pip install kolmogorov-recipe
```

Zero runtime dependencies. Works on Python 3.8+.

## 30-second usage

```python
from recipe import RecipeClient

c = RecipeClient(api_key="ks_...")

# 1) Show 4-8 examples once
r = c.synthesize(
    name="is-spam",
    positives=[
        {"input": "WIN A FREE iPhone NOW",   "expected": True},
        {"input": "CLICK HERE FOR $1000",    "expected": True},
        {"input": "meeting at 3pm tomorrow", "expected": False},
        {"input": "lunch?",                  "expected": False},
    ],
    output_spec={"type": "boolean"},
)

# 2) Run it forever
out = c.run(recipe_id=r["concept_id"], input="BUY CRYPTO NOW")
print(out["output"])     # → True
print(out["latency_us"]) # → typically < 50 µs
```

## Drop-in replacements for repeat LLM-as-judge calls

```python
from recipe import recipe

recipe.is_spam("WIN free Bitcoin")            # → True
recipe.classify_intent("how do I cancel")     # → "support"
recipe.detect_language("c'est la vie")        # → "french"
recipe.classify_issue("the deploy crashed")   # → "bug"
```

These hit the public registry of curated Recipes — no API key required.

## CLI

```bash
pip install kolmogorov-recipe
export RECIPE_API_KEY=ks_...

recipe run is-spam "WIN free Bitcoin"
recipe synthesize examples.json
recipe list --tag classifier
recipe stats cpt_xxx
recipe waitlist you@example.com "extract addresses from emails"
```

## Get a key

Free 10,000 recipe-calls/month, no credit card:

```bash
curl -X POST https://kolmogorov-stack-production.up.railway.app/v1/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
```

## Three pillars

| Pillar | What it remembers | Today |
|---|---|---|
| **Memory** | What happened (facts, sessions, context) | shipped — `remlabs.ai` |
| **Skills** | How to do things (deterministic functions) | this package |
| **Specialists** | A model that's *been* the task (fine-tuned LoRA) | Day 60-120 |

> Memory remembers. Skills repeat. Specialists become.

## License

MIT © [REM Labs](https://remlabs.ai)
