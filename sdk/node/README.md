# @kolmogorov/recipe

> **Recipe.** Show how once. Run forever.
> The Skills layer of [REM Labs](https://remlabs.ai).

Anywhere your product asks an AI the same tiny question over and over, you're paying ~$0.001 per call to a 70 B-parameter model to answer something a 400-byte JS function would answer for free, in 35 µs, with the same answer every time.

This SDK is a thin client for the Recipe HTTP API.

## Install

```bash
npm i @kolmogorov/recipe
```

## 30-second usage

```js
import RecipeClient from '@kolmogorov/recipe';

const c = new RecipeClient({ apiKey: process.env.RECIPE_API_KEY });

// 1) Show 4-8 examples once
const r = await c.synthesize({
  name: 'is-spam',
  positives: [
    { input: 'WIN A FREE iPhone NOW',     expected: true },
    { input: 'CLICK HERE FOR $1000',      expected: true },
    { input: 'meeting at 3pm tomorrow',   expected: false },
    { input: 'lunch?',                    expected: false },
  ],
  output_spec: { type: 'boolean' },
});

// 2) Run it forever
const out = await c.run({ recipe_id: r.concept_id, input: 'BUY CRYPTO NOW' });
console.log(out.output);   // → true
console.log(out.latency_us); // → typically < 50 µs
```

## Drop-in replacements for repeat LLM-as-judge calls

```js
import { recipe } from '@kolmogorov/recipe';

await recipe.isSpam("WIN free Bitcoin");        // → true
await recipe.classifyIntent("how do I cancel"); // → "support"
await recipe.sentiment("this product changed my life");
await recipe.detectLanguage("c'est la vie");
await recipe.classifyIssue("the deploy crashed since friday");
```

These read from the public registry of curated Recipes. No key required.

## CLI

```bash
npm i -g @kolmogorov/recipe
export RECIPE_API_KEY=ks_...

recipe run is-spam "WIN free Bitcoin"
recipe synthesize examples.json
recipe list --tag classifier
recipe stats cpt_xxx
recipe waitlist you@example.com "extract addresses from emails"
```

## API surface

```ts
class RecipeClient {
  // core
  synthesize(req): Promise<SynthesizeResponse>
  run(opts): Promise<RunResponse>
  verify(source, examples): Promise<{ pass_rate, trace }>

  // registry
  list(opts?)
  get(id)
  stats(id)
  search(query, k?)
  compose(opts)

  // forward-looking (Day 30-180+)
  labelCorpus(recipe_id, opts)        // examples → labeled corpus
  trainSpecialist(req)                 // labeled corpus → fine-tuned LoRA
  waitlistSpecialist(email, task)
  listSpecialists()
  runSpecialist(id, input)

  // public
  featured()
  publicConcepts()
  publicRun(opts)

  // account
  account()
  rotateKey()
  signup(email, name?)
  health()
}
```

## Get a key

Free 10,000 recipe-calls/month, no credit card:

```bash
curl -X POST https://kolmogorov-stack-production.up.railway.app/v1/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
```

Or visit [/signup](https://kolmogorov-stack-production.up.railway.app/signup).

## Three pillars

| Pillar | What it remembers | Today |
|---|---|---|
| **Memory** | What happened (facts, sessions, context) | shipped — `remlabs.ai` |
| **Skills** | How to do things (deterministic functions) | this package |
| **Specialists** | A model that's *been* the task (fine-tuned LoRA) | Day 60-120 |

> Memory remembers. Skills repeat. Specialists become.

## License

MIT © [REM Labs](https://remlabs.ai)
