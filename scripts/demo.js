// End-to-end demo flow: synthesize → publish → run → search → compose.
// Run: `npm run demo`

import 'dotenv/config';
import { synthesize } from '../src/synthesis.js';
import { createConcept, publishVersion, searchSimilar, getHead, listConcepts } from '../src/registry.js';
import { runConcept, composeRun } from '../src/runtime.js';
import { provisionTenant } from '../src/auth.js';

const TENANT = 'demo';
provisionTenant(TENANT);

const banner = (s) => console.log(`\n══ ${s} ${'═'.repeat(Math.max(0, 56 - s.length))}`);

banner('1. SYNTHESIZE');
const r = await synthesize({
  positives: [
    { input: 'FREE viagra click here', expected: true },
    { input: 'URGENT prize claim NOW', expected: true },
    { input: 'lunch tomorrow', expected: false },
    { input: 'team retro friday', expected: false },
  ],
  negatives: [{ input: 'PR review at 3pm', expected_not: true }],
  output_spec: { type: 'boolean' },
});
console.log('accepted:', r.accepted, '· strategy:', r.strategy, '· quality:', r.quality_score, '· bytes:', r.size_bytes);
console.log('source:\n' + r.source);

banner('2. PUBLISH');
const concept = createConcept({ name: 'demo-spam', description: 'demo spam classifier', tenant: TENANT, tags: ['demo'], visibility: 'public' });
const version = publishVersion({
  concept_id: concept.id,
  source: r.source,
  evaluation: { quality_score: r.quality_score, latency_p50_us: r.latency_p50_us, size_bytes: r.size_bytes, source_hash: r.source_hash, strategy: r.strategy },
  lineage: {},
});
console.log('concept:', concept.id, '· version:', version.id);

banner('3. RUN');
for (const inp of ['WIN a free iPhone', 'sync at 3pm']) {
  const out = await runConcept({ concept_id: concept.id, input: inp, tenant: TENANT });
  console.log(`  "${inp}" →`, out.output, `· ${out.latency_us ?? 0}µs · cache:${out.cache || 'miss'}`);
}

banner('4. CACHE HIT');
const inp = 'WIN a free iPhone';
const out2 = await runConcept({ concept_id: concept.id, input: inp, tenant: TENANT });
console.log(`  same input again → cache: ${out2.cache}`);

banner('5. SEARCH');
const matches = searchSimilar({ query: 'classify spam', tenant: TENANT, k: 5 });
for (const m of matches) console.log(`  ${m.score.toFixed(3)}  ${m.name}  (${m.concept_id})`);

banner('6. COMPOSE');
const composed = await composeRun({ query: 'classify spam', input: 'CLAIM your free reward today!!', tenant: TENANT, strategy: 'attention', k: 3 });
console.log('  output:', composed.output);
console.log('  dispatched:', composed.dispatched.map(d => `${d.name} → ${JSON.stringify(d.output)}`).join('  ·  '));

banner('DONE');
console.log('Concepts in registry:', listConcepts({ tenant: TENANT }).length);
