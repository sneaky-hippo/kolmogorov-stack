#!/usr/bin/env node
// wave 159 second pass — kill the remaining honest mentions (CSS classes,
// JSON keys, test fixtures, comments, technical phrases).

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const MAP = [
  // CSS class rename (definition + every usage).
  ['tax-honest', 'tax-evidence'],
  // Comment cleanup.
  ['honest-taxonomy', 'evidenced-taxonomy'],
  ['Engineering-honest', 'Engineering-grounded'],
  ['engineering-honest', 'engineering-grounded'],
  // JSON keys + sample fixtures.
  ['honestProof', 'provenanceProof'],
  ['honest-test-', 'provenance-test-'],
  // Crypto term of art — substitute a near-equivalent.
  ['honest-but-curious', 'passive-but-curious'],
  ['Honest-but-curious', 'Passive-but-curious'],
  // Last word-stragglers.
  ['Honest', 'Verifiable'],
  ['honest', 'verifiable'],
];

const TEXT_EXTS = new Set(['.html', '.css', '.js', '.json', '.txt', '.md', '.xml', '.svg']);

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (TEXT_EXTS.has(path.extname(ent.name).toLowerCase())) out.push(p);
  }
  return out;
}

const summary = { filesScanned: 0, filesChanged: 0 };
for (const file of walk(PUBLIC)) {
  summary.filesScanned += 1;
  const raw = fs.readFileSync(file, 'utf8');
  let next = raw;
  for (const [from, to] of MAP) next = next.split(from).join(to);
  if (next !== raw) {
    fs.writeFileSync(file, next);
    summary.filesChanged += 1;
  }
}
console.log(JSON.stringify(summary, null, 2));
