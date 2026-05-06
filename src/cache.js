// Three-tier cache: L1 in-memory (LRU), L2 disk-persistent, L3 stub for object storage.
// Keyed on (generator_version_id, input_hash).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const L1_CAP = 2048;
const L1 = new Map();
let l1Hits = 0, l1Misses = 0, l2Hits = 0;

// Same Vercel/Lambda fallback as src/store.js: deploy bundle is read-only,
// only /tmp is writable. We never seed the cache from the bundle — the L2
// cache rebuilds itself from L1 misses.
const ON_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const CACHE_DIR = ON_SERVERLESS ? '/tmp/data/cache' : path.resolve('data', 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

export function cacheKey(version_id, input) {
  const h = crypto.createHash('sha1').update(JSON.stringify(input ?? '')).digest('hex').slice(0, 24);
  return `${version_id}:${h}`;
}

export function get(version_id, input) {
  const k = cacheKey(version_id, input);
  if (L1.has(k)) {
    l1Hits++;
    const v = L1.get(k);
    L1.delete(k); L1.set(k, v); // LRU touch
    return { hit: 'L1', value: v };
  }
  l1Misses++;
  const f = path.join(CACHE_DIR, k.replace(':', '_') + '.json');
  if (fs.existsSync(f)) {
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8'));
      L1.set(k, v);
      l2Hits++;
      return { hit: 'L2', value: v };
    } catch {}
  }
  return { hit: null };
}

export function put(version_id, input, value) {
  const k = cacheKey(version_id, input);
  L1.set(k, value);
  if (L1.size > L1_CAP) {
    const oldest = L1.keys().next().value;
    L1.delete(oldest);
  }
  const f = path.join(CACHE_DIR, k.replace(':', '_') + '.json');
  try { fs.writeFileSync(f, JSON.stringify(value)); } catch {}
}

export function invalidate(version_id) {
  for (const k of L1.keys()) if (k.startsWith(version_id + ':')) L1.delete(k);
}

export function cacheStats() {
  return {
    l1_size: L1.size,
    l1_capacity: L1_CAP,
    l1_hits: l1Hits,
    l1_misses: l1Misses,
    l2_hits: l2Hits,
    hit_rate: l1Hits + l1Misses === 0 ? 0 : (l1Hits + l2Hits) / (l1Hits + l1Misses),
  };
}
