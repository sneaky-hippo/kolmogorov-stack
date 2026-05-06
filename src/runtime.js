// Edge runtime: query planner → vector first-pass → parallel WASM/JS executor → composer → cache.

import { getVersion, getHead, searchSimilar } from './registry.js';
import { compileJs, compileWasm } from './verifier.js';
import { compose } from './composer.js';
import * as cache from './cache.js';
import { insert } from './store.js';

const compiledCache = new Map();
let cleanupTimer = null;
const COMPILED_TTL_MS = 10 * 60 * 1000;

function getCompiled(version) {
  const k = version.id;
  const now = Date.now();
  if (compiledCache.has(k)) {
    const entry = compiledCache.get(k);
    entry.touchedAt = now;
    return entry.fn;
  }
  let fn;
  if (version.source.startsWith('WASM:')) {
    // base64 wasm bytes after WASM:
    fn = null; // resolved async via runVersion
  } else {
    fn = compileJs(version.source);
  }
  compiledCache.set(k, { fn, touchedAt: now });
  scheduleCleanup();
  return fn;
}

function scheduleCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - COMPILED_TTL_MS;
    for (const [k, v] of compiledCache) if (v.touchedAt < cutoff) compiledCache.delete(k);
  }, 60_000);
  cleanupTimer.unref?.();
}

async function instantiate(version) {
  if (version.source.startsWith('WASM:')) {
    const b64 = version.source.slice(5);
    return await compileWasm(b64);
  }
  return getCompiled(version);
}

export async function runVersion({ version_id, input, tenant, use_cache = true }) {
  const found = getVersion(version_id, tenant);
  if (!found) throw new Error('version not found or not authorized');
  const { version, concept } = found;

  const source_hash = version.evaluation?.source_hash || null;

  if (use_cache) {
    const c = cache.get(version.id, input);
    if (c.hit) {
      logInvocation({ version_id, concept_id: concept.id, tenant, latency_us: 0, cache_hit: c.hit });
      return { output: c.value, cache: c.hit, version_id, concept: concept.name, source_hash };
    }
  }

  const fn = await instantiate(version);
  const t0 = process.hrtime.bigint();
  let output, error;
  try { output = fn(input); } catch (e) { error = String(e.message || e); }
  const us = Number(process.hrtime.bigint() - t0) / 1000;

  logInvocation({ version_id, concept_id: concept.id, tenant, latency_us: us, cache_hit: null, error });

  if (error) throw new Error(error);
  if (use_cache) cache.put(version.id, input, output);

  return { output, cache: null, latency_us: Math.round(us), version_id, concept: concept.name, source_hash };
}

export async function runConcept({ concept_id, input, tenant }) {
  const head = getHead(concept_id, tenant);
  if (!head) throw new Error('concept has no published version');
  return runVersion({ version_id: head.id, input, tenant });
}

export async function composeRun({ query, input, tenant, k = 5, strategy = 'attention', tag }) {
  const matches = searchSimilar({ query, tenant, k, tag });
  if (matches.length === 0) return { output: null, dispatched: [], reason: 'no candidates' };

  const dispatched = [];
  for (const m of matches) {
    try {
      const r = await runVersion({ version_id: m.version_id, input, tenant });
      dispatched.push({
        concept_id: m.concept_id, name: m.name, version_id: m.version_id,
        score: m.score, output: r.output, cache: r.cache, latency_us: r.latency_us || 0,
      });
    } catch (e) {
      dispatched.push({ concept_id: m.concept_id, name: m.name, error: String(e.message || e) });
    }
  }

  const composed = compose(strategy, dispatched.filter(d => !d.error));
  return { output: composed, dispatched, strategy };
}

function logInvocation(row) {
  insert('invocations', { id: 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), ...row, ts: new Date().toISOString() });
}

export function compiledCacheSize() { return compiledCache.size; }
export { cache };
