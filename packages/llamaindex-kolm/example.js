// example.js — minimal runnable example.
//
// Prereq: a compiled artifact and the `kolm` CLI on PATH.
// Run with:  node example.js

import { KolmLLM } from './index.js';

const artifact = process.env.KOLM_ARTIFACT || './phi-redactor.kolm';

async function main() {
  const llm = new KolmLLM({ artifactPath: artifact });
  const r = await llm.complete('Redact: Patient Jane Roe, MRN 9876543.');
  console.log('output:', r.text);
  if (r.raw?.receipt) {
    console.log('cid:', r.raw.receipt.cid);
    console.log('k_score:', r.raw.receipt.k_score);
  }
}

main().catch((err) => {
  console.error('example failed:', err.message);
  process.exit(1);
});
