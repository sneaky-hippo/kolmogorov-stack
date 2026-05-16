#!/usr/bin/env node
// Bootstrap R2: create primary buckets, smoke-test upload + download.
// Env: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (or lowercase variants).
import * as R2 from '../src/r2.js';

const BUCKETS = ['kolm-assets', 'kolm-receipts', 'kolm-artifacts', 'kolm-reports'];

async function main() {
  if (!R2.r2Configured()) {
    console.error('R2 not configured — set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN');
    process.exit(2);
  }

  console.log('==> r2-bootstrap.mjs');
  console.log(`    account: ${R2.accountId.slice(0, 6)}...`);

  const existing = await R2.listBuckets();
  console.log(`    existing buckets: ${existing.map((b) => b.name).join(', ') || '(none)'}`);

  for (const name of BUCKETS) {
    const has = existing.find((b) => b.name === name);
    if (has) { console.log(`    skip create  ${name}  (exists)`); continue; }
    await R2.createBucket(name);
    console.log(`    created       ${name}`);
  }

  // smoke
  const key = `_smoke/${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  const body = `kolm r2 smoke ${new Date().toISOString()}`;
  await R2.putObject(key, body, { bucket: 'kolm-assets', contentType: 'text/plain' });
  console.log(`    PUT  ${key}  (${body.length} bytes)`);

  const r = await R2.getObject(key, { bucket: 'kolm-assets' });
  if (!r) throw new Error('smoke GET returned null');
  const echoed = await r.text();
  if (echoed !== body) throw new Error(`smoke mismatch: got "${echoed}"`);
  console.log(`    GET  ${key}  ok (round-trip match)`);

  await R2.deleteObject(key, { bucket: 'kolm-assets' });
  console.log(`    DEL  ${key}  ok`);

  console.log('\n==> r2-bootstrap done.');
}

main().catch((e) => { console.error(`FAIL: ${e.message}`); process.exit(1); });
