#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'public');

const REPLACEMENTS = [
  [/<a href="\/agents">agents<\/a>/g, '<a href="/cli">cli</a>'],
  [/<a href="\/evolve">evolve<\/a>/g, '<a href="/builder">builder</a>'],
  [/<a href="\/edge">edge<\/a>/g, '<a href="/device">device</a>'],
  [/<a href="\/showcase">showcase<\/a>/g, '<a href="/case-studies">case studies</a>'],
  [/<a href="\/cookbook">cookbook<\/a>/g, '<a href="/docs">cookbook</a>'],
  [/<a href="\/openai">openai compat<\/a>/g, '<a href="/quickstart">quickstart</a>'],
  [/<a href="\/capture">capture<\/a>/g, '<a href="/captures">captures</a>'],
];

const KILL_HREFS = new Set([
  '/agents', '/evolve', '/edge', '/showcase', '/openai',
]);

let changed = 0;
let scanned = 0;

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(p);
      continue;
    }
    if (!ent.name.endsWith('.html')) continue;
    scanned++;
    const orig = fs.readFileSync(p, 'utf8');
    let next = orig;
    for (const [re, rep] of REPLACEMENTS) {
      next = next.replace(re, rep);
    }
    if (next !== orig) {
      fs.writeFileSync(p, next);
      changed++;
    }
  }
}

walk(ROOT);
console.log(`scanned ${scanned} html files, updated ${changed}`);
