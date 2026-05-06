// Subroutine library — reusable primitives that synthesized generators can call.
// Smaller generators, higher quality, more correct.
// Versioned so generators pin a snapshot.

export const LIBRARY_VERSION = '1.0.0';

export const subroutines = {
  // text primitives
  tokenize: (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  ngrams: (s, n) => {
    const t = String(s).toLowerCase();
    const out = [];
    for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n));
    return out;
  },
  countMatches: (s, re) => (String(s).match(re) || []).length,
  containsAny: (s, list) => {
    const lower = String(s).toLowerCase();
    return list.some(w => lower.includes(String(w).toLowerCase()));
  },

  // numeric primitives
  parseFloatSafe: (s) => {
    const m = String(s).match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  },
  clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
  zscore: (x, mean, std) => (std === 0 ? 0 : (x - mean) / std),

  // pattern primitives
  patterns: {
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    url:   /\bhttps?:\/\/[^\s<>"']+/g,
    phone: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,
    price: /\$\s?\d+(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?\s?(?:USD|EUR|GBP)/gi,
    date:  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    ipv4:  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  },

  // logic
  any: (xs, pred) => xs.some(pred),
  all: (xs, pred) => xs.every(pred),
  vote: (xs) => {
    const c = new Map();
    for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
    let best, bestN = -1;
    for (const [k, n] of c) if (n > bestN) { best = k; bestN = n; }
    return best;
  },
};

export function libraryDescription() {
  return Object.entries(subroutines).map(([name, fn]) => {
    if (typeof fn === 'object') return `lib.${name} = { ${Object.keys(fn).join(', ')} }`;
    return `lib.${name}(${fn.length} args)`;
  }).join('\n');
}
