#!/usr/bin/env node
// Pre-bake the theme-toggle button into every page's site-actions/right group
// to eliminate the runtime-insertion layout shift ("menu jump") on nav.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'public');

const TOGGLE = '<button type="button" class="theme-toggle" aria-label="Toggle light/dark mode" title="Toggle light/dark">'
  + '<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
  + '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>'
  + '</button>';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.html')) {
      out.push(full);
    }
  }
  return out;
}

const SIGNIN_RE = /<a\s+href="\/signin"([^>]*)>/i;
let touched = 0;
let alreadyOk = 0;
let skipped = 0;

for (const file of walk(ROOT)) {
  let src = fs.readFileSync(file, 'utf8');
  if (!SIGNIN_RE.test(src)) {
    skipped++;
    continue;
  }
  if (/class="theme-toggle"/.test(src)) {
    alreadyOk++;
    continue;
  }
  const next = src.replace(SIGNIN_RE, TOGGLE + '\n      <a href="/signin"$1>');
  if (next === src) {
    skipped++;
    continue;
  }
  fs.writeFileSync(file, next, 'utf8');
  touched++;
}

console.log(`touched=${touched}  already-ok=${alreadyOk}  skipped=${skipped}`);
