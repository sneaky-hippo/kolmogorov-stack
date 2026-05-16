#!/usr/bin/env node
/* Add `<a href="/compare">Compare</a>` next to `<a href="/benchmarks">Benchmarks</a>`
 * in footer nav across all public HTML pages. Keeps spacing/case/whitespace
 * stable so diffs are minimal. */
const fs = require('node:fs');
const path = require('node:path');

const COMPARE_LINK = '<a href="/compare">Compare</a>';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

let touched = 0;
for (const f of walk(path.resolve(__dirname, '..', 'public'))) {
  const before = fs.readFileSync(f, 'utf-8');
  if (!before.includes('href="/benchmarks"')) continue;
  if (before.includes('href="/compare"')) continue;
  // Insert compare link as next sibling after benchmarks link, preserving the
  // surrounding indent. Look for `<a href="/benchmarks">…</a>` and append a
  // matching newline + indent + compare link.
  const re = /([\t ]*)<a href="\/benchmarks">([^<]*)<\/a>(\r?\n)/;
  const m = re.exec(before);
  if (!m) continue;
  const indent = m[1];
  const newline = m[3];
  const insert = `${indent}<a href="/benchmarks">${m[2]}</a>${newline}${indent}${COMPARE_LINK}${newline}`;
  const after = before.replace(re, insert);
  if (after !== before) {
    fs.writeFileSync(f, after);
    touched++;
  }
}
console.log(`patched ${touched} pages with /compare nav link`);
