# @kolmogorov/kolm-sdk

Node SDK for kolm account, registry, receipt, and recipe APIs.

The public package is intentionally small. It gives product code a typed client for the same surface the CLI uses: synthesize deterministic recipes, run registry entries, submit public concepts, inspect account state, and manage artifact-adjacent workflows.

## Install

The npm package is not published yet. Use a local checkout while the package is prepared:

```bash
git clone https://github.com/sneaky-hippo/kolmogorov-stack
npm i file:./kolmogorov-stack/sdk/node
```

For local development:

```bash
git clone https://github.com/sneaky-hippo/kolmogorov-stack
cd kolmogorov-stack/sdk/node
npm install
npm test
```

## Usage

```js
import KolmClient, { recipe } from '@kolmogorov/kolm-sdk';

const kolm = new KolmClient({
  apiKey: process.env.KOLM_API_KEY,
  baseUrl: process.env.KOLM_BASE_URL || 'https://kolm.ai',
});

const health = await kolm.health();
console.log(health.status);

const created = await kolm.synthesize({
  name: 'is-support-ticket',
  positives: [
    { input: 'checkout fails on Android', expected: true },
    { input: 'cannot reset MFA', expected: true },
    { input: 'lunch at noon?', expected: false },
    { input: 'ship notes look good', expected: false },
  ],
  output_spec: { type: 'boolean' },
});

if (created.accepted) {
  const out = await kolm.run({
    recipe_id: created.concept_id,
    input: 'billing export crashes',
  });
  console.log(out.output, out.latency_us);
}

const spam = await recipe.isSpam('WIN FREE BITCOIN');
console.log(spam);
```

## Environment

```bash
KOLM_API_KEY=ks_...
KOLM_BASE_URL=https://kolm.ai
```

The SDK still accepts `RECIPE_API_KEY`, `RECIPE_BASE_URL`, and `KOLMOGOROV_API_KEY` for backward compatibility.

## API Surface

```ts
class KolmClient {
  synthesize(req)
  synthesizeBatch(items)
  verify(source, examples)
  run(opts)

  list(opts?)
  get(recipe_id)
  stats(recipe_id)
  search(query, k?)
  compose(opts)

  labelCorpus(recipe_id, opts)
  job(id)
  waitlistSpecialist(email, task)
  trainSpecialist(req)
  listSpecialists()
  getSpecialist(id)
  runSpecialist(id, input)

  featured()
  publicConcepts()
  publicRun(opts)

  account()
  rotateKey()
  signup(email, name?)
  health()

  bootstrapAnonymous(meta?)
  claimAnonymous(anon_token, email, name?)
}
```

## CLI Note

The production CLI is the repo-root `kolm` binary. This SDK package also includes a legacy recipe-registry helper exposed as `kolm-recipes` for registry experiments. New product flows should prefer:

```bash
npm i -g github:sneaky-hippo/kolmogorov-stack
kolm config base https://kolm.ai
kolm login
```

## License

MIT
