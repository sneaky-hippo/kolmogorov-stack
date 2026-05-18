#!/usr/bin/env node
// wave 159 — insert a "/training" link into every site-nav across public/.
// Idempotent: skips files that already have href="/training" in the nav block.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

// Match a site-nav block. Capture (opening tag) (body) (closing tag).
const NAV_RE = /(<nav\s+class="site-nav"[^>]*>)([\s\S]*?)(<\/nav>)/g;

// The target link line. Indentation handled at insert site.
const LINK = '<a href="/training">Training</a>';

function patchHtml(text) {
  let changed = false;
  const next = text.replace(NAV_RE, (_match, open, body, close) => {
    if (body.includes('href="/training"')) return _match;
    // Insert after the first "Use cases" anchor if present, else as first child.
    const useCasesIdx = body.search(/<a\s+href="\/use-cases"[^>]*>[^<]*<\/a>/);
    if (useCasesIdx === -1) {
      // Best-effort: insert at the start of the nav body with same indent as the rest.
      const indentMatch = body.match(/\n(\s+)<a/);
      const indent = indentMatch ? indentMatch[1] : '      ';
      changed = true;
      return `${open}\n${indent}${LINK}${body}${close}`;
    }
    const useCasesTag = body.match(/<a\s+href="\/use-cases"[^>]*>[^<]*<\/a>/)[0];
    const insertAt = useCasesIdx + useCasesTag.length;
    // Pick up the indent (newline + spaces) preceding the use-cases line.
    let indentStart = useCasesIdx;
    while (indentStart > 0 && body[indentStart - 1] !== '\n') indentStart -= 1;
    const indent = body.slice(indentStart, useCasesIdx);
    const newBody = body.slice(0, insertAt) + '\n' + indent + LINK + body.slice(insertAt);
    changed = true;
    return open + newBody + close;
  });
  return changed ? next : null;
}

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.name.toLowerCase().endsWith('.html')) out.push(p);
  }
  return out;
}

const summary = { scanned: 0, changed: 0, skipped: 0 };
for (const file of walk(PUBLIC)) {
  summary.scanned += 1;
  const raw = fs.readFileSync(file, 'utf8');
  if (!/<nav\s+class="site-nav"/.test(raw)) {
    summary.skipped += 1;
    continue;
  }
  const next = patchHtml(raw);
  if (next) {
    fs.writeFileSync(file, next);
    summary.changed += 1;
  } else {
    summary.skipped += 1;
  }
}
console.log(JSON.stringify(summary, null, 2));
