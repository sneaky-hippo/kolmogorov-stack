#!/usr/bin/env node
// wave 159 — purge every occurrence of "honest" across the site.
// Phrase-level replacements first; falls back to word-level for stragglers.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const PHRASE_MAP = [
  ['Honest Data Generation', 'Provenance Data Generation'],
  ['honest data generation', 'provenance data generation'],
  ['Honest training-data generation', 'Provenance training-data generation'],
  ['honest training-data generation', 'provenance training-data generation'],
  ['Capture-loop honesty', 'Capture-loop fidelity'],
  ['capture-loop honesty', 'capture-loop fidelity'],
  ['Capture-Loop Honesty', 'Capture-Loop Fidelity'],

  ['Honest framing', 'Code-grounded framing'],
  ['honest framing', 'code-grounded framing'],
  ['Honest decode', 'Calibrated decode'],
  ['honest decode', 'calibrated decode'],
  ['Honest reset', 'Production reset'],
  ['honest reset', 'production reset'],
  ['Honest limits', 'Documented limits'],
  ['honest limits', 'documented limits'],
  ['Honest claim', 'Evidenced claim'],
  ['honest claim', 'evidenced claim'],
  ['Honest pass', 'Audit pass'],
  ['honest pass', 'audit pass'],
  ['Honest version', 'Evidenced version'],
  ['honest version', 'evidenced version'],
  ['Honest about', 'Transparent about'],
  ['honest about', 'transparent about'],
  ['Honest description', 'Evidenced description'],
  ['honest description', 'evidenced description'],
  ['Honest taxonomy', 'Evidenced taxonomy'],
  ['honest taxonomy', 'evidenced taxonomy'],
  ['Honest spec', 'Evidenced spec'],
  ['honest spec', 'evidenced spec'],
  ['Honest specification', 'Evidenced specification'],
  ['honest specification', 'evidenced specification'],
  ['Honest gap', 'Evidenced gap'],
  ['honest gap', 'evidenced gap'],
  ['Honest answer', 'Evidenced answer'],
  ['honest answer', 'evidenced answer'],
  ['Honest signal', 'Calibrated signal'],
  ['honest signal', 'calibrated signal'],
  ['Honest number', 'Calibrated number'],
  ['honest number', 'calibrated number'],
  ['Honest score', 'Calibrated score'],
  ['honest score', 'calibrated score'],
  ['Honest disclosure', 'Calibrated disclosure'],
  ['honest disclosure', 'calibrated disclosure'],
  ['Honest by construction', 'Provable by construction'],
  ['honest by construction', 'provable by construction'],
  ['Honest by design', 'Provable by design'],
  ['honest by design', 'provable by design'],
  ['Honest report', 'Audited report'],
  ['honest report', 'audited report'],
  ['Honest copy', 'Calibrated copy'],
  ['honest copy', 'calibrated copy'],
  ['Honest marketing', 'Calibrated marketing'],
  ['honest marketing', 'calibrated marketing'],
  ['Honest positioning', 'Calibrated positioning'],
  ['honest positioning', 'calibrated positioning'],

  ['kept it honest', 'kept it grounded'],
  ['keep it honest', 'keep it grounded'],
  ['keep us honest', 'keep us grounded'],
  ['keeps it honest', 'keeps it grounded'],
  ['keeps us honest', 'keeps us grounded'],
  ['Be honest', 'Be transparent'],
  ['be honest', 'be transparent'],
  ['stay honest', 'stay grounded'],
  ['Stay honest', 'Stay grounded'],
  ['get honest', 'get transparent'],
  ['Get honest', 'Get transparent'],
  ['fully honest', 'fully transparent'],
  ['Fully honest', 'Fully transparent'],

  ['Honesty pass', 'Audit pass'],
  ['honesty pass', 'audit pass'],
  ['Honesty Pass', 'Audit Pass'],
  ['Honesty gate', 'Audit gate'],
  ['honesty gate', 'audit gate'],
  ['Honesty wave', 'Audit wave'],
  ['honesty wave', 'audit wave'],
  ['Honesty surface', 'Provenance surface'],
  ['honesty surface', 'provenance surface'],
  ['Honesty checklist', 'Audit checklist'],
  ['honesty checklist', 'audit checklist'],
  ['Honesty label', 'Provenance label'],
  ['honesty label', 'provenance label'],

  ['Honesty', 'Provenance'],
  ['honesty', 'provenance'],

  ['Honestly,', 'Plainly,'],
  ['honestly,', 'plainly,'],
  ['Honestly:', 'Plainly:'],
  ['honestly:', 'plainly:'],
  ['Honestly', 'Plainly'],
  ['honestly', 'plainly'],

  ['Honest framing.', 'Code-grounded framing.'],
  ['honest framing.', 'code-grounded framing.'],
];

const WORD_MAP = [
  ['Honest', 'Verifiable'],
  ['honest', 'verifiable'],
];

const SLUG_RENAMES = {
  'research/honest-data-generation.html': 'research/provenance-data-generation.html',
  'research/capture-loop-honesty.html': 'research/capture-loop-fidelity.html',
};

const HREF_SLUG_MAP = [
  ['honest-data-generation', 'provenance-data-generation'],
  ['capture-loop-honesty', 'capture-loop-fidelity'],
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

function applyMap(text, map) {
  let out = text;
  for (const [from, to] of map) {
    out = out.split(from).join(to);
  }
  return out;
}

function isWordChar(c) {
  return /[A-Za-z0-9_-]/.test(c);
}

function wordReplace(text, from, to) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(from, i)) {
      const before = i === 0 ? '' : text[i - 1];
      const after = text[i + from.length] || '';
      if (!isWordChar(before) && !isWordChar(after)) {
        out += to;
        i += from.length;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function applyWordMap(text, map) {
  let out = text;
  for (const [from, to] of map) {
    out = wordReplace(out, from, to);
  }
  return out;
}

const SUMMARY = { filesScanned: 0, filesChanged: 0, replacements: 0, renamed: 0 };

const files = walk(PUBLIC);
for (const file of files) {
  SUMMARY.filesScanned += 1;
  const raw = fs.readFileSync(file, 'utf8');
  let next = applyMap(raw, PHRASE_MAP);
  next = applyMap(next, HREF_SLUG_MAP);
  next = applyWordMap(next, WORD_MAP);
  if (next !== raw) {
    fs.writeFileSync(file, next);
    SUMMARY.filesChanged += 1;
    SUMMARY.replacements += (raw.match(/[Hh]onest/g) || []).length;
  }
}

for (const [oldRel, newRel] of Object.entries(SLUG_RENAMES)) {
  const oldAbs = path.join(PUBLIC, oldRel);
  const newAbs = path.join(PUBLIC, newRel);
  if (fs.existsSync(oldAbs)) {
    fs.renameSync(oldAbs, newAbs);
    SUMMARY.renamed += 1;
  }
}

// Also scan launch-checklist.md (it's in public root, already caught by walk).
// And vercel.json (one level up) for rewrites/redirects pointing at slugs.
const vercelJson = path.join(ROOT, 'vercel.json');
if (fs.existsSync(vercelJson)) {
  const raw = fs.readFileSync(vercelJson, 'utf8');
  const next = applyMap(raw, HREF_SLUG_MAP);
  if (next !== raw) {
    fs.writeFileSync(vercelJson, next);
    SUMMARY.filesChanged += 1;
  }
}

console.log(JSON.stringify(SUMMARY, null, 2));
