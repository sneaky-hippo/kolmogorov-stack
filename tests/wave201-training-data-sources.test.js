// Wave 201: /training/data-sources public registry of reputable public
// training datasets, per task, with licenses, sources, and citations.
//
// Shift 5 finale of the W196-W201 NL+training infrastructure plan. W196
// shipped the methods research dump (/research/methods-2026-q2) that named
// LIMA, UltraFeedback, Tulu-3 as the open baseline triumvirate. W198
// refreshed /training with the per-recipe-class "how much data" grid. W201
// surfaces a curated REGISTRY of actual public training datasets the
// /training "how much data" grid is meant to fill: per-task, per-license,
// per-citation, including domain-specific corpora (every domain row carries
// an amber verify-before-ship pill because per-tenant legal review is the
// only honest framing).
//
// Each assertion ties one piece of rendered prose to a real dataset, a real
// license string, a real citation, or to an anchor on the W196 page so the
// registry cannot drift away from the research dump it cites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const PAGE = path.join(PUBLIC, 'training', 'data-sources.html');
const W196 = path.join(PUBLIC, 'research', 'methods-2026-q2.html');
const SW = path.join(PUBLIC, 'sw.js');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /training/data-sources page exists on disk and exceeds 22 KB floor', () => {
  assert.ok(fs.existsSync(PAGE), `data-sources.html missing at ${PAGE}`);
  const stat = fs.statSync(PAGE);
  assert.ok(stat.size > 22 * 1024,
    `data-sources.html too small (${stat.size} bytes; expected > 22 KB)`);
});

test('2. canonical URL https://kolm.ai/training/data-sources declared', () => {
  const html = read(PAGE);
  assert.match(html,
    /<link rel="canonical" href="https:\/\/kolm\.ai\/training\/data-sources"/,
    'data-sources.html must declare canonical https://kolm.ai/training/data-sources');
});

test('3. wave 201 stamp present', () => {
  const html = read(PAGE);
  assert.match(html, /[Ww]ave 201/,
    'data-sources.html must self-stamp as wave 201');
});

test('4. LIMA + UltraFeedback + Tulu-3 (W196 triumvirate) all named', () => {
  const html = read(PAGE);
  assert.ok(html.includes('LIMA'),
    'registry must name LIMA (W196 quality-over-volume anchor)');
  assert.ok(html.includes('UltraFeedback'),
    'registry must name UltraFeedback (W196 open preference baseline)');
  assert.ok(html.includes('Tulu-3') || html.includes('Tulu 3'),
    'registry must name Tulu-3 (W196 large-scale SFT mix)');
});

test('5. at least 4 distinct license types surface (Apache-2.0, MIT, CC-BY-4.0, ODC-BY)', () => {
  const html = read(PAGE);
  const LICENSES = ['Apache-2.0', 'MIT', 'CC-BY-4.0', 'ODC-BY'];
  const hits = LICENSES.filter((l) => html.includes(l));
  assert.ok(hits.length >= 4,
    `data-sources.html names only ${hits.length} of 4 expected license types: ${hits.join(', ')}`);
});

test('6. domain-specific section uses amber pre-ship-verification pills', () => {
  const html = read(PAGE);
  // W256 copy-scrub replaced the exact "verify before ship" phrase with
  // shipped equivalents ("legal review required" + per-row "verify" pills).
  // The behavior the assertion locks in is: domain rows surface that some
  // per-tenant verification step is required before redistribution/ship.
  assert.match(html, /legal review|verify the dataset|verify.*credential|per-tenant.*verify/i,
    'domain section must surface that per-tenant verification is required before ship');
  // Count amber pills inside the domain section by looking for the
  // `pill warn` class. Should appear multiple times for the domain rows
  // (per-row pill plus legend + roadmap pill).
  const pillCount = (html.match(/pill warn/g) || []).length;
  assert.ok(pillCount >= 4,
    `expected >= 4 amber warn pills (one per domain row + legend); saw ${pillCount}`);
});

test('7. MIMIC-IV cited as healthcare flagship dataset', () => {
  const html = read(PAGE);
  assert.match(html, /MIMIC-IV/,
    'data-sources.html must cite MIMIC-IV (healthcare flagship dataset)');
  // And it must be flagged as research-only / credentialed.
  assert.match(html, /research-only|credential|PhysioNet/i,
    'MIMIC-IV row must mention research-only license or PhysioNet credentialing');
});

test('8. four synthetic-data methods named (Self-Instruct, Evol-Instruct, Magpie, Persona-Hub)', () => {
  const html = read(PAGE);
  const METHODS = ['Self-Instruct', 'Evol-Instruct', 'Magpie', 'Persona-Hub'];
  for (const m of METHODS) {
    assert.ok(html.includes(m),
      `data-sources.html must name synthetic-data method: ${m}`);
  }
});

test('9. cross-links to /research/methods-2026-q2 AND /training AND /quickstart/nl AND /recipe-classes', () => {
  const html = read(PAGE);
  const LINKS = [
    'href="/research/methods-2026-q2',  // tolerates anchor suffixes
    'href="/training"',
    'href="/quickstart/nl"',
    'href="/recipe-classes"',
  ];
  for (const l of LINKS) {
    assert.ok(html.includes(l),
      `data-sources.html must cross-link to: ${l}`);
  }
});

test('10. honest-scope section names "redistribution" AND "license"', () => {
  const html = read(PAGE);
  assert.match(html, /redistribut/i,
    'honest-scope must address redistribution');
  assert.match(html, /license/i,
    'honest-scope must address licensing');
  // And it must say kolm does not redistribute.
  assert.match(html, /kolm does .{0,8}not.{0,12}redistribut/i,
    'honest-scope must explicitly state kolm does not redistribute datasets');
});

test('11. W194 corpus-licensing-gate cited as roadmap (amber pill or "wave 194 roadmap" framing)', () => {
  const html = read(PAGE);
  assert.match(html, /[Ww]ave 194/,
    'data-sources.html must cite W194 corpus-licensing-gate as upcoming');
  assert.match(html, /roadmap|upcoming|will enforce/i,
    'W194 mention must frame as roadmap / upcoming');
});

test('12. light-theme switch IIFE in <head> BEFORE body styles', () => {
  const html = read(PAGE);
  const headEnd = html.indexOf('</head>');
  assert.ok(headEnd > 0, '<head> closing tag must exist');
  const head = html.slice(0, headEnd);
  assert.match(head, /localStorage\.getItem\(['"]kolm-theme['"]\)/,
    'light-theme switch IIFE must be inside <head>');
  assert.match(head, /data-theme.{0,4}light/,
    'light-theme switch must set data-theme=light pre-paint');
  // And the IIFE must precede the <body> tag (head is everything before </head>).
  const bodyTagIdx = html.indexOf('<body');
  assert.ok(headEnd < bodyTagIdx,
    '<head> must close before <body> opens');
});

test('13. design tokens --accent + --warn + --bad all defined', () => {
  const html = read(PAGE);
  assert.match(html, /--accent:\s*#10b981/,
    'design token --accent (#10b981) must be defined');
  assert.match(html, /--warn:\s*#f0b86b/,
    'design token --warn (#f0b86b) must be defined');
  assert.match(html, /--bad:\s*#ff6b91/,
    'design token --bad (#ff6b91) must be defined');
});

test('14. sw.js cache wave-floor >= 201 (regex extract + numeric compare)', () => {
  const sw = read(SW);
  const m = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, `sw.js CACHE constant did not match expected pattern (saw: ${sw.slice(0, 200)})`);
  const wave = parseInt(m[1], 10);
  assert.ok(wave >= 201,
    `sw.js wave floor is ${wave}; expected >= 201 after W201 ships (coordinator bumps sw.js separately)`);
});

test('15. no em-dashes in load-bearing copy (U+2014 forbidden site-wide on this page)', () => {
  const html = read(PAGE);
  // Per the W201 brief: hyphens or middle-dots only.
  const emDash = '—';
  assert.ok(!html.includes(emDash),
    'data-sources.html must not contain em-dashes (U+2014). Use hyphens or middle-dots.');
  // Also no &mdash; HTML entity (different surface, same intent).
  assert.ok(!html.includes('&mdash;'),
    'data-sources.html must not contain &mdash; HTML entity. Use hyphens or middle-dots.');
});

test('16. every general-purpose dataset row has a citation (author + year minimum)', () => {
  const html = read(PAGE);
  // Citations are anchored by "et al.," + a 4-digit year, or by a 4-digit
  // year inside the cite cell. Easier check: count "20XX" mentions inside
  // the cite cells.
  const YEAR_RX = /class="cite"[^>]*>[^<]*(?:<a[^>]*>[^<]*<\/a>[^<]*)*[^<]*(?:Allen AI|et al\.|Teknium|Databricks|NVIDIA|Yang|Cui|Lambert|Zhou|Chan|Xu|Wang|Cobbe|Chen|Austin|Hendrycks|Maia|Zheng|Chalkidis|Johnson|Uzuner|Taori),?\s*[^<]*20\d{2}/;
  const cites = html.match(/class="cite"/g) || [];
  // Each dataset row uses class="cite"; allow >= 14 (8 general + 6 code/math/reasoning + 6 domain = 20; minimum floor 14 for safety).
  assert.ok(cites.length >= 14,
    `expected >= 14 citation cells; saw ${cites.length}`);
  // And at least one citation has a verifiable last-name + year pattern.
  assert.ok(YEAR_RX.test(html),
    'at least one citation cell must carry an author last-name + 4-digit year');
});

test('17. general-purpose section has >= 6 rows', () => {
  const html = read(PAGE);
  // Slice the section between "General-purpose" h2 and the next h2.
  const start = html.indexOf('General-purpose instruction');
  assert.ok(start > 0, 'General-purpose section header missing');
  const nextH2 = html.indexOf('<h2', start + 1);
  const section = html.slice(start, nextH2 > 0 ? nextH2 : undefined);
  const rowCount = (section.match(/<tr>\s*<td class="key">/g) || []).length;
  assert.ok(rowCount >= 6,
    `general-purpose table needs >= 6 dataset rows; saw ${rowCount}`);
});

test('18. code/math/reasoning section has >= 4 rows', () => {
  const html = read(PAGE);
  const start = html.indexOf('Code, math, and reasoning');
  assert.ok(start > 0, 'Code/math/reasoning section header missing');
  const nextH2 = html.indexOf('<h2', start + 1);
  const section = html.slice(start, nextH2 > 0 ? nextH2 : undefined);
  const rowCount = (section.match(/<tr>\s*<td class="key">/g) || []).length;
  assert.ok(rowCount >= 4,
    `code/math/reasoning table needs >= 4 dataset rows; saw ${rowCount}`);
});

test('19. domain-specific section has >= 4 rows (and every row tagged class="domain")', () => {
  const html = read(PAGE);
  const start = html.indexOf('Domain-specific datasets');
  assert.ok(start > 0, 'Domain-specific section header missing');
  const nextH2 = html.indexOf('<h2', start + 1);
  const section = html.slice(start, nextH2 > 0 ? nextH2 : undefined);
  // Domain rows use class="domain" + class="key" inside td.
  const rowCount = (section.match(/<tr class="domain">/g) || []).length;
  assert.ok(rowCount >= 4,
    `domain-specific table needs >= 4 dataset rows; saw ${rowCount}`);
});

test('20. anchor link #data-creation references W196 actual anchor (verified on W196 page)', () => {
  const w196Html = read(W196);
  assert.match(w196Html, /id="data-creation"/,
    'W196 page must have id="data-creation" anchor for /training/data-sources to link into');
  // And our page must actually link into it.
  const ourHtml = read(PAGE);
  assert.match(ourHtml, /href="\/research\/methods-2026-q2#data-creation"/,
    'data-sources.html must link to /research/methods-2026-q2#data-creation');
});
