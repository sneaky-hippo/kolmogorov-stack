// Wave 200: /quickstart/nl page lock-in tests.
//
// Shift 5 of the Wave 196 to W201 plan ships the dedicated natural-language
// quickstart surface. The four-step CLI flow it documents (kolm nl, kolm
// seeds new, kolm distill, kolm verify) is the same flow the wave 197+199
// CLI work wires up. These tests assert the page exists, surfaces every
// step in order, carries the air-gap honesty framing, cross-links to the
// research dump (W196) + training playbook (W198) + data-sources (W201
// pending), and stays in lockstep with the sw.js cache slug.
//
// If any of these assertions fail, either the page silently drifted away
// from the documented contract or a future wave forgot to bump the sw.js
// cache slug past 200.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PAGE = path.join(REPO, 'public', 'quickstart', 'nl.html');
const SW   = path.join(REPO, 'public', 'sw.js');

// Read once. Every test grep against the same buffer.
const html = fs.existsSync(PAGE) ? fs.readFileSync(PAGE, 'utf8') : '';

test('1. /quickstart/nl page exists and is at least 18 KB', () => {
  assert.ok(fs.existsSync(PAGE), `expected ${PAGE} to exist`);
  const bytes = fs.statSync(PAGE).size;
  assert.ok(bytes >= 18_000,
    `page should be at least 18 KB; got ${bytes} bytes`);
});

test('2. canonical URL is https://kolm.ai/quickstart/nl', () => {
  assert.match(html,
    /<link rel="canonical" href="https:\/\/kolm\.ai\/quickstart\/nl">/,
    'canonical link must point at /quickstart/nl');
});

test('3. wave 200 stamp present', () => {
  assert.match(html, /wave 200/i,
    'page must self-stamp with the shipping wave (200)');
});

test('4. all four steps present in order: nl, seeds new, distill, verify', () => {
  const idxNl     = html.indexOf('kolm nl');
  const idxSeeds  = html.indexOf('kolm seeds new');
  const idxDist   = html.indexOf('kolm distill');
  const idxVerify = html.indexOf('kolm verify');
  assert.ok(idxNl     > 0, 'page must mention kolm nl');
  assert.ok(idxSeeds  > 0, 'page must mention kolm seeds new');
  assert.ok(idxDist   > 0, 'page must mention kolm distill');
  assert.ok(idxVerify > 0, 'page must mention kolm verify');
  // First occurrence of each verb must respect step order:
  // nl < seeds new < distill < verify.
  assert.ok(idxNl < idxSeeds,
    `kolm nl (idx ${idxNl}) must appear before kolm seeds new (idx ${idxSeeds})`);
  assert.ok(idxSeeds < idxDist,
    `kolm seeds new (idx ${idxSeeds}) must appear before kolm distill (idx ${idxDist})`);
  assert.ok(idxDist < idxVerify,
    `kolm distill (idx ${idxDist}) must appear before kolm verify (idx ${idxVerify})`);
});

test('5. all four CLI verbs surface in the page text', () => {
  // (Belt and braces beyond test 4: bare verb strings present, not just step indices.)
  assert.match(html, /\bkolm nl\b/,         'kolm nl must surface verbatim');
  assert.match(html, /\bkolm seeds new\b/,  'kolm seeds new must surface verbatim');
  assert.match(html, /\bkolm distill\b/,    'kolm distill must surface verbatim');
  assert.match(html, /\bkolm verify\b/,     'kolm verify must surface verbatim');
});

test('6. KOLM_AIRGAP=1 mentioned at least once', () => {
  assert.match(html, /KOLM_AIRGAP\s*=\s*1/,
    'page must surface the KOLM_AIRGAP=1 air-gap toggle');
});

test('7. honest scope framing present for the networked path', () => {
  // W256 copy-scrub removed the literal "NOT YET WIRED" string per user
  // directive ("NOT AMBER PILL, WE FUCKING SHIP EVERYTHING"). The behavior
  // the assertion locks in is: page makes the air-gap default explicit and
  // names that the network path is opt-in, so the reader can audit which
  // surface their bytes leave on. Match the shipped framing.
  assert.match(html, /air-gap.*default|deterministic.*default/i,
    'page must declare the air-gap/deterministic path is the default');
  assert.match(html, /--network|opt.in/i,
    'page must declare the networked LLM path is opt-in (e.g. --network)');
});

test('8. "candidates" or "scaffold" framing surfaces (NOT "labels")', () => {
  // Brief: rows are CANDIDATES, not labels. The page should pick candidate/scaffold language.
  const hasCandidates = /\bcandidate(s)?\b/i.test(html);
  const hasScaffold   = /\bscaffold(s|ed|ing)?\b/i.test(html);
  assert.ok(hasCandidates || hasScaffold,
    'page must use "candidates" and/or "scaffold" framing for step-2 rows');
});

test('9. cross-links to /quickstart (W175), /training (W198), /research/methods-2026-q2 (W196) present', () => {
  assert.match(html, /href="\/quickstart"/,
    'page must cross-link back to /quickstart (W175)');
  assert.match(html, /href="\/training"/,
    'page must cross-link to /training (W198 training refresh)');
  assert.match(html, /href="\/research\/methods-2026-q2"/,
    'page must cross-link to /research/methods-2026-q2 (W196 methods dump)');
});

test('10. cross-link to /training/data-sources (W201 pending) present', () => {
  assert.match(html, /href="\/training\/data-sources"/,
    'page must cross-link to /training/data-sources (W201 follow-up surface)');
});

test('11. K-score gate (the verification mechanism) mentioned', () => {
  assert.match(html, /K-score/,
    'page must surface K-score as the gating mechanism');
  assert.match(html, /gate/i,
    'page must surface the word "gate" alongside K-score');
});

test('12. receipt chain (the integrity mechanism) mentioned', () => {
  assert.match(html, /receipt chain/i,
    'page must surface the receipt chain as the integrity mechanism');
});

test('13. light-theme switch IIFE appears in <head> BEFORE body styles (pre-paint)', () => {
  const headOpen  = html.indexOf('<head>');
  const headClose = html.indexOf('</head>');
  const bodyOpen  = html.indexOf('<body>');
  assert.ok(headOpen >= 0 && headClose > headOpen, 'page must have a <head>');
  assert.ok(bodyOpen > headClose, '<body> must come after </head>');
  const headHtml = html.slice(headOpen, headClose);
  // The IIFE that reads localStorage and sets data-theme=light pre-paint.
  assert.match(headHtml, /localStorage\.getItem\(['"]kolm-theme['"]\)/,
    'pre-paint theme IIFE must live inside <head>');
  assert.match(headHtml, /data-theme/,
    'pre-paint theme IIFE must set data-theme attribute');
  // And the body-affecting styles must come AFTER that IIFE inside <head>.
  const iifeIdx = headHtml.indexOf('localStorage.getItem');
  const bodyStyleIdx = headHtml.indexOf('body{');
  if (bodyStyleIdx >= 0) {
    assert.ok(iifeIdx < bodyStyleIdx,
      'theme IIFE must execute BEFORE the body{} style block to avoid a light-mode flash');
  }
});

test('14. design tokens --accent + --warn + --bad all present (drift.html palette parity)', () => {
  assert.match(html, /--accent\s*:/,
    'design token --accent must be defined (matches /drift palette)');
  assert.match(html, /--warn\s*:/,
    'design token --warn must be defined (matches /drift palette)');
  assert.match(html, /--bad\s*:/,
    'design token --bad must be defined (matches /drift palette)');
});

test('15. sw.js cache slug wave floor is >= 200', () => {
  const sw = fs.readFileSync(SW, 'utf8');
  const m = sw.match(/const\s+CACHE\s*=\s*['"]kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, `sw.js must declare const CACHE = 'kolm-v7-YYYY-MM-DD-wave<N>-...'; got:\n${sw.slice(0, 200)}`);
  const waveNum = parseInt(m[1], 10);
  assert.ok(waveNum >= 200,
    `sw.js CACHE wave slug must be >= 200; got wave ${waveNum} (W200 page is in flight)`);
});

test('16. no em-dashes in load-bearing copy', () => {
  // Brief: no em-dashes. Strip the SVG path/style blocks (which never carry copy)
  // and assert the remaining text is em-dash-free.
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '');
  assert.ok(!stripped.includes('—'),
    'load-bearing copy must not contain literal em-dash (use hyphen or rephrase)');
  assert.ok(!/&mdash;/.test(stripped),
    'load-bearing copy must not contain &mdash; entity (use hyphen or rephrase)');
});

test('17. "what this does NOT do" honest-scope section ships three bullets', () => {
  // The brief enumerates three boundaries: no human eval replacement, no
  // unverified-example promotion, no online learning. We assert all three.
  assert.match(html, /does NOT[\s\S]{0,80}(replace|substitute)[\s\S]{0,80}human/i,
    'honest-scope bullet 1: does NOT replace human eval');
  assert.match(html, /does NOT[\s\S]{0,200}promote[\s\S]{0,200}(unverified|examples?)/i,
    'honest-scope bullet 2: does NOT promote unverified examples');
  assert.match(html, /does NOT[\s\S]{0,80}(do |run )?online learning/i,
    'honest-scope bullet 3: does NOT do online learning');
});

test('18. Qwen 7B Instruct (W183 letter-generator base) surfaces in the distill step', () => {
  // Brief: distill step must name qwen2.5-7b-instruct (case-insensitive)
  // since that is the W183 letter-generator base model.
  assert.match(html, /Qwen2\.5-7B-Instruct|qwen2\.5-7b-instruct/i,
    'distill step must surface Qwen2.5-7B-Instruct as the student base');
});
