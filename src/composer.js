// Four pluggable composition strategies.

export function compose(strategy, dispatched) {
  if (dispatched.length === 0) return null;
  switch (strategy) {
    case 'attention': return attentionWeighted(dispatched);
    case 'voting':    return voting(dispatched);
    case 'top1':      return top1(dispatched);
    case 'sequential':return sequential(dispatched);
    default:          return attentionWeighted(dispatched);
  }
}

function attentionWeighted(d) {
  // For numeric outputs: weighted average by similarity score.
  // For string/array: bag of all outputs with weights.
  // For booleans/discrete: weighted vote.
  const sample = d[0]?.output;
  if (typeof sample === 'number') {
    const total = d.reduce((s, x) => s + Math.max(0, x.score), 0) || 1;
    return d.reduce((s, x) => s + (Number(x.output) || 0) * Math.max(0, x.score), 0) / total;
  }
  if (typeof sample === 'boolean') {
    return weightedVote(d.map(x => ({ k: !!x.output, w: Math.max(0, x.score) })));
  }
  if (Array.isArray(sample)) {
    const merged = new Map();
    for (const x of d) {
      const w = Math.max(0, x.score);
      for (const item of (x.output || [])) {
        const k = JSON.stringify(item);
        merged.set(k, (merged.get(k) || 0) + w);
      }
    }
    return [...merged.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => JSON.parse(k));
  }
  const winner = weightedVote(d.map(x => ({ k: JSON.stringify(x.output), w: Math.max(0, x.score) })));
  if (!winner) return null;
  try { return JSON.parse(winner); } catch { return winner; }
}

function weightedVote(pairs) {
  const tally = new Map();
  for (const { k, w } of pairs) tally.set(k, (tally.get(k) || 0) + w);
  let best = null, bestW = -Infinity;
  for (const [k, w] of tally) if (w > bestW) { bestW = w; best = k; }
  return best;
}

function voting(d) {
  const winner = weightedVote(d.map(x => ({ k: JSON.stringify(x.output), w: 1 })));
  if (!winner) return null;
  try { return JSON.parse(winner); } catch { return winner; }
}

function top1(d) {
  const sorted = [...d].sort((a, b) => b.score - a.score);
  return sorted[0]?.output ?? null;
}

function sequential(d) {
  // Pipe each generator's output to the next as input.
  // For demo we return the array of stages.
  return d.map(x => ({ stage: x.name, output: x.output }));
}

export const STRATEGIES = ['attention', 'voting', 'top1', 'sequential'];
