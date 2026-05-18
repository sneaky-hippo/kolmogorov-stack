// example.js — minimal runnable example.
//
// Prereq: a compiled artifact such as phi-redactor.kolm and the `kolm` CLI on
// PATH. Run with:  node example.js

import { KolmLLM } from './index.js';

const artifact = process.env.KOLM_ARTIFACT || './phi-redactor.kolm';

async function main() {
  const llm = new KolmLLM({ artifactPath: artifact });
  const prompt = 'Redact this note: Patient John Doe, DOB 1980-01-01, MRN 1234567.';
  const { text, receipt } = await llm.invokeWithReceipt(prompt);
  console.log('output:', text);
  if (receipt) {
    console.log('cid:', receipt.cid);
    console.log('k_score:', receipt.k_score);
  }
}

main().catch((err) => {
  console.error('example failed:', err.message);
  process.exit(1);
});
