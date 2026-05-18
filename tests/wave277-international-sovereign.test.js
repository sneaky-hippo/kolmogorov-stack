// W277 — international + sovereign AI surfaces.
//
// Behavior tests for the international expansion and sovereign-AI landing
// pages added in wave 277 per the outside audit. The audit noted that the
// site had no /eu surface (despite an existing BAA/DPA template that already
// covered GDPR), no /sovereign-ai surface (despite air-gap-friendly compile
// infra shipped in W264), and no i18n scaffolding for the major non-English
// buyer locales (DE / FR / JA).
//
// These tests pin:
//
//   - the 5 new HTML files exist at their canonical paths,
//   - /eu mentions GDPR + EU AI Act (both verbatim) so a regulated EU buyer
//     scanning the page sees the framework names before they read prose,
//   - /sovereign-ai mentions air-gap + on-prem (both verbatim) so a sovereign
//     procurement officer scanning the page sees the architectural posture
//     before they read prose,
//   - the three i18n landing pages each include a native-language H1 — the
//     German "Kompilieren Sie Ihre eigene KI", French "Compilez votre propre
//     IA", and Japanese composition built from the requested glyphs,
//   - public/index.html has hreflang link tags for all 4 language variants
//     near the canonical link,
//   - vercel.json has all 5 W277 rewrites wired in,
//   - sw.js cache slug is at or past wave277 (wave floor, not equality, to
//     avoid the regression trap W169 recorded in MEMORY.md),
//   - no em-dashes were introduced in body copy on any of the new pages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');

const EU_PAGE        = path.join(ROOT, 'public', 'eu.html');
const SOV_PAGE       = path.join(ROOT, 'public', 'sovereign-ai.html');
const DE_PAGE        = path.join(ROOT, 'public', 'lang', 'de', 'index.html');
const FR_PAGE        = path.join(ROOT, 'public', 'lang', 'fr', 'index.html');
const JA_PAGE        = path.join(ROOT, 'public', 'lang', 'ja', 'index.html');
const HOME_PAGE      = path.join(ROOT, 'public', 'index.html');
const VERCEL_JSON    = path.join(ROOT, 'vercel.json');
const SW_JS          = path.join(ROOT, 'public', 'sw.js');

function read(p) { return fs.readFileSync(p, 'utf8'); }

// Em-dash budget: zero. Body copy uses commas, semicolons, or restructured
// sentences. The lock-in test catches accidental U+2014 reintroduction by a
// later wave that copies prose from a non-W277-compliant source.
function assertNoEmDash(html, label) {
  assert.equal(/—/.test(html), false, `${label}: U+2014 em-dash present in body copy`);
}

test('W277 #1 — /eu page exists at public/eu.html', () => {
  assert.ok(fs.existsSync(EU_PAGE), 'public/eu.html exists');
  const html = read(EU_PAGE);
  assert.ok(html.length > 4000, `EU page has real content, got ${html.length} bytes`);
});

test('W277 #2 — /eu mentions GDPR + EU AI Act verbatim', () => {
  const html = read(EU_PAGE);
  assert.match(html, /\bGDPR\b/, 'GDPR named verbatim');
  assert.match(html, /\bEU AI Act\b/, 'EU AI Act named verbatim');
  // Hero positioning the spec requires.
  assert.match(html, /Compile in the EU\./);
  assert.match(html, /Stay in the EU\./);
  // Schrems II is the canonical EU data-transfer reference — page should name it.
  assert.match(html, /Schrems II/);
});

test('W277 #3 — /eu links to /baa, /privacy, /security', () => {
  const html = read(EU_PAGE);
  assert.match(html, /href="\/baa"/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/security"/);
});

test('W277 #4 — /eu enumerates at least four EU regions', () => {
  const html = read(EU_PAGE);
  for (const region of ['Frankfurt', 'Paris', 'Stockholm', 'Milan']) {
    assert.match(html, new RegExp(region), `EU region ${region} present`);
  }
});

test('W277 #5 — /eu has no em-dash in body copy', () => {
  assertNoEmDash(read(EU_PAGE), '/eu');
});

test('W277 #6 — /sovereign-ai page exists at public/sovereign-ai.html', () => {
  assert.ok(fs.existsSync(SOV_PAGE), 'public/sovereign-ai.html exists');
  const html = read(SOV_PAGE);
  assert.ok(html.length > 4000, `sovereign-ai page has real content, got ${html.length} bytes`);
});

test('W277 #7 — /sovereign-ai mentions air-gap + on-prem', () => {
  const html = read(SOV_PAGE);
  // "Air-gap" and the longer hyphenated form both acceptable.
  assert.match(html, /[Aa]ir-gap/);
  assert.match(html, /\bon-prem\b/i);
  // Hero positioning the spec requires.
  assert.match(html, /AI that stays inside/i);
  assert.match(html, /your borders/i);
});

test('W277 #8 — /sovereign-ai names UAE, Saudi, Singapore, India', () => {
  const html = read(SOV_PAGE);
  assert.match(html, /UAE|United Arab Emirates/);
  assert.match(html, /Saudi/);
  assert.match(html, /Singapore/);
  assert.match(html, /India/);
});

test('W277 #9 — /sovereign-ai surfaces Arabic + Hindi + Mandarin localization', () => {
  const html = read(SOV_PAGE);
  assert.match(html, /Arabic/);
  assert.match(html, /Hindi/);
  assert.match(html, /Mandarin/);
});

test('W277 #10 — /sovereign-ai links to /enterprise/self-hosted', () => {
  const html = read(SOV_PAGE);
  assert.match(html, /href="\/enterprise\/self-hosted"/);
});

test('W277 #11 — /sovereign-ai has no em-dash in body copy', () => {
  assertNoEmDash(read(SOV_PAGE), '/sovereign-ai');
});

test('W277 #12 — /lang/de exists and has native-language H1', () => {
  assert.ok(fs.existsSync(DE_PAGE), 'public/lang/de/index.html exists');
  const html = read(DE_PAGE);
  // German H1 keyword. We assert "Kompilieren" + "eigene KI" rather than the
  // full phrase so this test does not break if a future copy revision swaps
  // the Sie politeness register for du (still German, still production).
  assert.match(html, /<h1[^>]*>[\s\S]*Kompilieren[\s\S]*eigene KI[\s\S]*<\/h1>/i,
    'German H1 contains "Kompilieren ... eigene KI"');
  assert.match(html, /lang="de"/, 'html lang attribute is de');
});

test('W277 #13 — /lang/fr exists and has native-language H1', () => {
  assert.ok(fs.existsSync(FR_PAGE), 'public/lang/fr/index.html exists');
  const html = read(FR_PAGE);
  // French H1 keyword: "Compilez" + "propre IA". Accent characters are
  // expressed as numeric entities so the test does not depend on the bytes
  // the file is written with.
  assert.match(html, /<h1[^>]*>[\s\S]*Compilez[\s\S]*propre IA[\s\S]*<\/h1>/i,
    'French H1 contains "Compilez ... propre IA"');
  assert.match(html, /lang="fr"/, 'html lang attribute is fr');
});

test('W277 #14 — /lang/ja exists and has native-language H1', () => {
  assert.ok(fs.existsSync(JA_PAGE), 'public/lang/ja/index.html exists');
  const html = read(JA_PAGE);
  assert.match(html, /lang="ja"/, 'html lang attribute is ja');
  // Japanese H1: assert the H1 contains the verb "compile" (&#12467; etc) and
  // the AI noun. We match on the numeric entities for "AI" + "compile" stems
  // so the test is byte-identical whether the file uses entities or literal
  // glyphs.
  //   AI:      A (\&\#65;) + I (\&\#73;)  ... but AI is ASCII "AI" in our copy.
  //   compile: &#12467;&#12531;&#12497;&#12452;&#12523; (KO N PA I RU)
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  assert.ok(h1Match, 'Japanese page contains an <h1>');
  const h1 = h1Match[1];
  // The H1 must reference "AI" and the verb stem "compile".
  assert.match(h1, /AI/, 'Japanese H1 references "AI"');
  assert.ok(
    /&#12467;&#12531;&#12497;&#12452;&#12523;|コンパイル/.test(h1),
    'Japanese H1 contains the verb "compile" (kompairu)'
  );
});

test('W277 #15 — each i18n page links back to English at /', () => {
  for (const [label, p] of [['de', DE_PAGE], ['fr', FR_PAGE], ['ja', JA_PAGE]]) {
    const html = read(p);
    assert.match(html, /href="\/"/, `${label} page links back to English at /`);
  }
});

test('W277 #16 — each i18n page declares hreflang for all 4 language variants', () => {
  for (const [label, p] of [['de', DE_PAGE], ['fr', FR_PAGE], ['ja', JA_PAGE]]) {
    const html = read(p);
    assert.match(html, /hreflang="en"[^>]*href="https:\/\/kolm\.ai\/"/, `${label}: hreflang en present`);
    assert.match(html, /hreflang="de"[^>]*href="https:\/\/kolm\.ai\/lang\/de"/, `${label}: hreflang de present`);
    assert.match(html, /hreflang="fr"[^>]*href="https:\/\/kolm\.ai\/lang\/fr"/, `${label}: hreflang fr present`);
    assert.match(html, /hreflang="ja"[^>]*href="https:\/\/kolm\.ai\/lang\/ja"/, `${label}: hreflang ja present`);
  }
});

test('W277 #17 — public/index.html has hreflang alternates for de/fr/ja', () => {
  const html = read(HOME_PAGE);
  assert.match(html, /<link rel="alternate" hreflang="de" href="https:\/\/kolm\.ai\/lang\/de"\s*\/?>/,
    'hreflang="de" alternate present on /');
  assert.match(html, /<link rel="alternate" hreflang="fr" href="https:\/\/kolm\.ai\/lang\/fr"\s*\/?>/,
    'hreflang="fr" alternate present on /');
  assert.match(html, /<link rel="alternate" hreflang="ja" href="https:\/\/kolm\.ai\/lang\/ja"\s*\/?>/,
    'hreflang="ja" alternate present on /');
});

test('W277 #18 — vercel.json has all 5 W277 rewrites', () => {
  const vc = JSON.parse(read(VERCEL_JSON));
  const rewrites = vc.rewrites || [];
  const expected = [
    { source: '/eu',           destination: '/eu.html' },
    { source: '/sovereign-ai', destination: '/sovereign-ai.html' },
    { source: '/lang/de',      destination: '/lang/de/index.html' },
    { source: '/lang/fr',      destination: '/lang/fr/index.html' },
    { source: '/lang/ja',      destination: '/lang/ja/index.html' },
  ];
  for (const e of expected) {
    const hit = rewrites.find((r) => r.source === e.source && r.destination === e.destination);
    assert.ok(hit, `vercel.json missing rewrite ${e.source} -> ${e.destination}`);
  }
});

test('W277 #19 — sw.js CACHE slug is at or past wave277 (wave floor)', () => {
  const sw = read(SW_JS);
  const m = sw.match(/kolm-v7-2026-05-\d+-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE constant matches expected pattern');
  assert.ok(Number(m[1]) >= 277,
    `sw.js cache wave must be >= 277, got ${m[1]} (W169 lesson: use wave floor not equality)`);
});

test('W277 #20 — i18n pages do not contain em-dashes in body copy', () => {
  for (const [label, p] of [['de', DE_PAGE], ['fr', FR_PAGE], ['ja', JA_PAGE]]) {
    assertNoEmDash(read(p), `/lang/${label}`);
  }
});
