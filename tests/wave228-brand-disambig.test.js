// Wave 228: brand-disambig sweep lock-in.
//
// W228 enforces three brand-disambiguation invariants across every
// indexable public/*.html:
//   1. <title> ends with " · kolm.ai" (not bare " · kolm").
//   2. First 1200 chars of <body> contain the literal "kolm.ai".
//   3. /enterprise, /pricing, /signup, /signin link to
//      /articles/kolm-ai-vs-kolm-therapeutics.
//
// Tests assert behavior (the invariants hold across the corpus + the
// sweep is idempotent), not page copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SCRIPTS = path.join(ROOT, 'scripts');
const SW = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

const SKIP_FILES = new Set(['404.html', '500.html']);
const SKIP_PREFIXES = ['preview-', 'dev-', '_'];

function shouldSkip(name) {
  if (SKIP_FILES.has(name)) return true;
  for (const px of SKIP_PREFIXES) if (name.startsWith(px)) return true;
  return false;
}

function listIndexable() {
  return fs.readdirSync(PUBLIC, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html') && !shouldSkip(e.name))
    .map((e) => e.name);
}

test('W228 #1 - every indexable page <title> ends with " · kolm.ai"', () => {
  const offenders = [];
  for (const name of listIndexable()) {
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    const m = html.match(/<title>([^<]*)<\/title>/i);
    if (!m) { offenders.push(`${name}: no <title>`); continue; }
    const title = m[1].trim();
    if (!/[·|]\s*kolm\.ai\s*$/i.test(title)) {
      offenders.push(`${name}: "${title}"`);
    }
  }
  assert.equal(offenders.length, 0,
    `pages with non-conforming title suffix:\n${offenders.slice(0,10).join('\n')}`);
});

test('W228 #2 - no page <title> ends with bare " · kolm" (must be " · kolm.ai")', () => {
  const offenders = [];
  for (const name of listIndexable()) {
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    const m = html.match(/<title>([^<]*)<\/title>/i);
    if (!m) continue;
    const title = m[1].trim();
    if (/[·|]\s*kolm\s*$/i.test(title)) {
      offenders.push(`${name}: "${title}"`);
    }
  }
  assert.equal(offenders.length, 0,
    `pages with bare " · kolm" suffix (missing .ai):\n${offenders.slice(0,10).join('\n')}`);
});

test('W228 #3 - first 1200 chars of <body> contain "kolm.ai" on every page', () => {
  const offenders = [];
  for (const name of listIndexable()) {
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    const bodyOpen = html.search(/<body[^>]*>/i);
    if (bodyOpen === -1) { offenders.push(`${name}: no <body>`); continue; }
    const head = html.slice(bodyOpen, bodyOpen + 1200);
    if (!/kolm\.ai/.test(head)) offenders.push(name);
  }
  assert.equal(offenders.length, 0,
    `pages without "kolm.ai" in first 1200 body chars:\n${offenders.slice(0,10).join('\n')}`);
});

test('W228 #4 - /enterprise, /pricing, /signup, /signin link to disambig article', () => {
  const targets = ['enterprise.html', 'pricing.html', 'signup.html', 'signin.html'];
  const href = '/articles/kolm-ai-vs-kolm-therapeutics';
  for (const name of targets) {
    const full = path.join(PUBLIC, name);
    if (!fs.existsSync(full)) continue;
    const html = fs.readFileSync(full, 'utf8');
    assert.ok(html.includes(href),
      `${name} must link to ${href}`);
  }
});

test('W228 #5 - brand-disambig sweep is idempotent (re-run touches 0)', () => {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'brand-disambig-sweep.cjs')], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `sweep should exit 0; got ${r.status}, stderr=${r.stderr}`);
  assert.match(r.stdout, /titles=0 anchors=0 links=0/,
    `sweep should be idempotent on second run; saw: ${r.stdout}`);
});

test('W228 #6 - sw.js cache wave-floor >= 228', () => {
  const m = SW.match(/const CACHE = 'kolm-v7-[^']+-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE must follow wave-N slug pattern');
  const waveN = parseInt(m[1], 10);
  assert.ok(waveN >= 228, `sw.js wave-slug must be >= 228 (saw ${waveN})`);
});

test('W228 #7 - the disambig article exists and is reachable', () => {
  const p = path.join(PUBLIC, 'articles', 'kolm-ai-vs-kolm-therapeutics.html');
  assert.ok(fs.existsSync(p), 'disambig article must exist at /articles/kolm-ai-vs-kolm-therapeutics');
});

test('W228 #8 - every page that has "kolm" in the title also has "kolm.ai" suffix (no half-disambig)', () => {
  const offenders = [];
  for (const name of listIndexable()) {
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    const m = html.match(/<title>([^<]*)<\/title>/i);
    if (!m) continue;
    const title = m[1].trim();
    if (/\bkolm\b/i.test(title) && !/[·|]\s*kolm\.ai\s*$/i.test(title)) {
      offenders.push(`${name}: "${title}"`);
    }
  }
  assert.equal(offenders.length, 0,
    `pages mentioning "kolm" without proper " · kolm.ai" suffix:\n${offenders.slice(0,10).join('\n')}`);
});

test('W228 #9 - sweep stable across 3 runs (no oscillation between runs)', () => {
  for (let i = 0; i < 3; i++) {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'brand-disambig-sweep.cjs')], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `run ${i+1} must exit 0`);
    assert.match(r.stdout, /titles=0 anchors=0 links=0/,
      `run ${i+1} must be a no-op; saw: ${r.stdout}`);
  }
});

test('W228 #10 - no <title> contains other Kolm entities that could confuse buyers', () => {
  const banned = [/Kolm therapeutics/i, /Kolm engines/i, /Kolm band/i, /Petter Kolm/i];
  const offenders = [];
  for (const name of listIndexable()) {
    if (name === 'articles') continue;
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    const m = html.match(/<title>([^<]*)<\/title>/i);
    if (!m) continue;
    const title = m[1];
    for (const re of banned) {
      if (re.test(title)) offenders.push(`${name}: "${title}"`);
    }
  }
  assert.equal(offenders.length, 0,
    `pages with confusing Kolm entity in <title>:\n${offenders.join('\n')}`);
});
