#!/usr/bin/env node
// W280: strip ` · kolm · kolm.ai` and `, kolm · kolm.ai` double-suffix from titles.
// Canonical form is `<Page> · kolm.ai`.
// Idempotent: running twice is a no-op.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'public');

const TITLE_RE = /<title>([^<]*)<\/title>/gi;

function fixTitle(inner) {
  // Strip trailing ` · kolm · kolm.ai`, ` · kolm | kolm.ai`, `, kolm · kolm.ai`, `: kolm · kolm.ai`
  // and ensure canonical ` · kolm.ai` ending using the raw middot (U+00B7) to match
  // the wave228 lock-in test which only accepts raw `·` or `|`, NOT `&middot;`.
  let t = inner;
  // Strip ` · kolm` or ` &middot; kolm` immediately before ` · kolm.ai` / ` &middot; kolm.ai`
  t = t.replace(/\s*(?:·|&middot;|\|)\s*kolm\s*(·|&middot;|\|)\s*kolm\.ai\s*$/i, ' · kolm.ai');
  // Strip `, kolm · kolm.ai` / `: kolm · kolm.ai` (lowercase suffix glue)
  t = t.replace(/[,:]\s*kolm\s*(·|&middot;|\|)\s*kolm\.ai\s*$/i, ' · kolm.ai');
  // Normalize any remaining `&middot; kolm.ai` ending to raw `· kolm.ai` so the
  // wave228 lock-in regex (character class with raw middot) accepts the file.
  t = t.replace(/\s*&middot;\s*kolm\.ai\s*$/i, ' · kolm.ai');
  return t;
}

let scanned = 0, changed = 0;

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(p); continue; }
    if (!ent.name.endsWith('.html')) continue;
    scanned++;
    const orig = fs.readFileSync(p, 'utf8');
    let next = orig.replace(TITLE_RE, (m, inner) => '<title>' + fixTitle(inner) + '</title>');
    if (next !== orig) {
      fs.writeFileSync(p, next);
      changed++;
    }
  }
}

walk(ROOT);
console.log(`scanned ${scanned} html files, updated ${changed} titles`);
