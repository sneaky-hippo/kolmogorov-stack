// Seed the registry with the demo concepts in examples/.
// Boots the synthesizer in-process for speed; no HTTP needed.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { synthesize } from '../src/synthesis.js';
import { createConcept, publishVersion } from '../src/registry.js';
import { provisionTenant } from '../src/auth.js';

const DEMO_TENANT = process.env.DEFAULT_TENANT || 'demo';
const tenant = provisionTenant(DEMO_TENANT);
const dir = path.resolve('examples');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

console.log(`Seeding ${files.length} concepts as tenant "${DEMO_TENANT}" (${tenant.api_key})\n`);

for (const file of files) {
  const ex = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  process.stdout.write(`  · ${ex.name} … `);
  const t0 = Date.now();
  try {
    const r = await synthesize({
      positives: ex.positives,
      negatives: ex.negatives || [],
      output_spec: ex.output_spec,
      priors: ex.priors || {},
    });
    if (!r.accepted) {
      console.log(`SKIP (${r.reason}) — kept best at ${r.best_result?.quality_score?.toFixed(2) || '0'}`);
      continue;
    }
    const concept = createConcept({
      name: ex.name,
      description: ex.description || ex.name,
      tenant: DEMO_TENANT,
      schema: ex.output_spec || null,
      tags: ex.tags || [],
      visibility: ex.visibility || 'public',
    });
    publishVersion({
      concept_id: concept.id,
      source: r.source,
      evaluation: {
        quality_score: r.quality_score,
        pass_rate_positive: r.pass_rate_positive,
        reject_rate_negative: r.reject_rate_negative,
        latency_p50_us: r.latency_p50_us,
        size_bytes: r.size_bytes,
        source_hash: r.source_hash,
        strategy: r.strategy,
        trace: r.test_trace,
      },
      lineage: { synthesized_from_n: (ex.positives.length + (ex.negatives?.length || 0)), attempts_n: r.attempts_n },
    });
    const dt = Date.now() - t0;
    console.log(`OK  q=${r.quality_score.toFixed(2)}  ${r.size_bytes}B  via ${r.strategy}  ${dt}ms`);
  } catch (e) {
    console.log(`ERR ${e.message || e}`);
  }
}

console.log(`\nDone. Demo tenant key: ${tenant.api_key}`);
console.log(`Run "npm start" and visit http://localhost:${process.env.PORT || 8787}/registry`);
