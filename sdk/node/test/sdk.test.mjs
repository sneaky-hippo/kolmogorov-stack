// SDK test - runs against a live local server (default http://localhost:3939).
// Set KOLM_BASE_URL or RECIPE_BASE_URL to point elsewhere.
//
//   node test/sdk.test.mjs

import assert from 'node:assert';
import KolmClient, { recipe, RecipeError } from '../index.mjs';

const baseUrl = process.env.KOLM_BASE_URL || process.env.RECIPE_BASE_URL || 'http://localhost:3939';
const c = new KolmClient({ baseUrl });

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL  ${name}: ${e?.message || e}`); fail++; }
}

console.log(`SDK test against ${baseUrl}`);

await it('health()', async () => {
  const h = await c.health();
  assert.strictEqual(h.status, 'ok');
});

await it('signup() mints a key', async () => {
  const r = await c.signup(`sdk-test-${Date.now()}@example.com`);
  assert.match(r.api_key, /^ks_/);
  c.apiKey = r.api_key; // re-arm client with the fresh key
});

await it('featured() lists curated recipes', async () => {
  const f = await c.featured();
  assert.ok(Array.isArray(f.featured));
});

await it('list() returns recipes array', async () => {
  const l = await c.list({ limit: 5 });
  assert.ok(Array.isArray(l.recipes));
});

let cid;
await it('synthesize() small boolean', async () => {
  const r = await c.synthesize({
    name: `sdk-test-${Date.now()}`,
    positives: [
      { input: 'YES', expected: true },
      { input: 'YEAH', expected: true },
      { input: 'no',   expected: false },
      { input: 'never', expected: false },
    ],
    output_spec: { type: 'boolean' },
  });
  if (r.accepted) cid = r.concept_id;
  // Whether accepted depends on the synthesis backend; structurally must be sane:
  assert.ok(r.strategy);
  assert.ok(typeof r.duration_ms === 'number');
});

if (cid) {
  await it('run() echoes output', async () => {
    const r = await c.run({ recipe_id: cid, input: 'YES' });
    assert.ok('output' in r);
  });

  await it('stats() returns shape', async () => {
    const s = await c.stats(cid);
    assert.ok('invocations' in s);
    assert.ok('latency_us' in s);
  });

  await it('labelCorpus() inline', async () => {
    const r = await c.labelCorpus(cid, { rows: [{ input: 'YES' }, { input: 'no' }] });
    assert.strictEqual(r.rows_labeled, 2);
  });

  await it('public/submit via SDK', async () => {
    const r = await c._req('POST', '/v1/public/submit', { recipe_id: cid, blurb: 'sdk smoke' });
    assert.match(r.submission_id, /^sub_/);
  });
}

await it('search() returns matches', async () => {
  const s = await c.search('detect spam', 3);
  assert.ok(Array.isArray(s.matches));
});

await it('waitlistSpecialist() reserves a slot', async () => {
  const r = await c.waitlistSpecialist(`sdk-test-${Date.now()}@x.io`, 'classify support tickets');
  assert.ok(typeof r.position === 'number');
});

await it('RecipeError on unknown recipe id', async () => {
  try {
    await c.run({ recipe_id: 'cpt_nope', input: 'x' });
    assert.fail('expected error');
  } catch (e) {
    assert.ok(e instanceof RecipeError);
  }
});

await it('listSpecialists()', async () => {
  const r = await c.listSpecialists();
  assert.ok(Array.isArray(r.specialists));
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
