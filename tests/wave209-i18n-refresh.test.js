// Wave 209: i18n docs refresh — public/docs/i18n/{ja,zh,es,fr,de,ko}.html
// gain a "new surfaces (2026)" block that cross-links the W144 / W167 / W169
// / W185 / W186 / W187 / W189 / W193 / W196 / W197 / W198 / W199 / W200 /
// W201 surfaces. URLs are kept English; the surrounding label is in the
// target language. Each lock-in assertion ties a piece of rendered prose
// (or a hyperlink) to one of the new surfaces so future translation
// rewrites cannot silently drop the cross-links.
//
// Constraints checked:
//   - No em-dashes added (baseline was 0 across all six docs).
//   - No mdash entities added (renders identically to em-dash).
//   - No emojis added.
//   - File size grew (baseline floors snapshotted from pre-W209).
//   - lang= attribute on root <html> matches the expected language code.
//   - sw.js cache slug wave floor >= 209 (coordinator handoff).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const I18N_DIR = path.join(REPO, 'public', 'docs', 'i18n');
const SW = path.join(REPO, 'public', 'sw.js');

const read = (p) => fs.readFileSync(p, 'utf8');

const LANGS = ['ja', 'zh', 'es', 'fr', 'de', 'ko'];

// Pre-W209 byte sizes captured before the patch landed. Each post-W209 doc
// must be at least its baseline size + 800 bytes (the new section adds ~1.5
// KB but we leave headroom for future trims).
const BASELINE_BYTES = {
  ja: 20978,
  zh: 18553,
  es: 19323,
  fr: 19659,
  de: 19500,
  ko: 19898,
};

const surfacePath = (p) => p; // alias for readability

// The W185-W201 surfaces (excluding W144 spec and W167/W169 anchors). At
// least 3 must appear per doc.
const W185_201_SURFACES = [
  '/k-score-explained', // W185
  '/frozen-eval',       // W186
  '/format/v2',         // W187
  '/migrate',           // W188 (may not be present in all)
  '/security',          // W189
  '/research/methods-2026-q2', // W196
  '/quickstart/nl',     // W200
  '/training/data-sources', // W201
];

test('1. all six i18n docs exist on disk', () => {
  for (const lang of LANGS) {
    const p = path.join(I18N_DIR, `${lang}.html`);
    assert.ok(fs.existsSync(p), `missing i18n doc: ${p}`);
  }
});

test('2. each i18n doc has root <html lang="xx"> matching expected code', () => {
  // zh.html uses lang="zh-CN" (a valid BCP-47 region subtag). Accept the
  // bare two-letter code OR any region/script subtag (e.g. "zh-CN", "ja-JP").
  for (const lang of LANGS) {
    const html = read(path.join(I18N_DIR, `${lang}.html`));
    const re = new RegExp(`<html\\b[^>]*\\blang="${lang}(?:-[A-Za-z]{2,4})?"`, 'i');
    assert.match(html, re,
      `${lang}.html missing root html lang="${lang}" (or ${lang}-XX region) attribute`);
  }
});

test('3. each i18n doc size grew at least 800 bytes past baseline', () => {
  for (const lang of LANGS) {
    const p = path.join(I18N_DIR, `${lang}.html`);
    const size = fs.statSync(p).size;
    const floor = BASELINE_BYTES[lang] + 800;
    assert.ok(size >= floor,
      `${lang}.html size ${size} < floor ${floor} (baseline ${BASELINE_BYTES[lang]})`);
  }
});

test('4. each i18n doc references at least 3 of the W185-W201 surfaces', () => {
  for (const lang of LANGS) {
    const html = read(path.join(I18N_DIR, `${lang}.html`));
    const hits = W185_201_SURFACES.filter((s) => html.includes(s)).length;
    assert.ok(hits >= 3,
      `${lang}.html cites only ${hits} W185-W201 surfaces; need >= 3`);
  }
});

test('5. each i18n doc hyperlinks to /spec/rs-1 (the moat anchor)', () => {
  for (const lang of LANGS) {
    const html = read(path.join(I18N_DIR, `${lang}.html`));
    assert.match(html, /href="\/spec\/rs-1"/,
      `${lang}.html must hyperlink to /spec/rs-1`);
  }
});

test('6. at least 4 of 6 docs reference /quickstart/nl OR /research/methods-2026-q2', () => {
  let count = 0;
  for (const lang of LANGS) {
    const html = read(path.join(I18N_DIR, `${lang}.html`));
    if (html.includes(surfacePath('/quickstart/nl')) ||
        html.includes(surfacePath('/research/methods-2026-q2'))) {
      count++;
    }
  }
  assert.ok(count >= 4,
    `only ${count}/6 i18n docs reference /quickstart/nl or /research/methods-2026-q2`);
});

test('7. at least 4 of 6 docs reference /k-score-explained', () => {
  let count = 0;
  for (const lang of LANGS) {
    const html = read(path.join(I18N_DIR, `${lang}.html`));
    if (html.includes('/k-score-explained')) count++;
  }
  assert.ok(count >= 4,
    `only ${count}/6 i18n docs reference /k-score-explained`);
});

test('8. no em-dashes added (baseline was 0 across all six docs)', () => {
  for (const lang of LANGS) {
    const html = read(path.join(I18N_DIR, `${lang}.html`));
    const matches = html.match(/—/g) || [];
    assert.equal(matches.length, 0,
      `${lang}.html contains ${matches.length} em-dashes; baseline was 0`);
  }
});

test('9. no &mdash; entities added (renders as em-dash)', () => {
  for (const lang of LANGS) {
    const html = read(path.join(I18N_DIR, `${lang}.html`));
    const matches = html.match(/&mdash;/g) || [];
    assert.equal(matches.length, 0,
      `${lang}.html contains ${matches.length} &mdash; entities; baseline was 0`);
  }
});

test('10. no emoji added (BMP supplementary planes empty per doc)', () => {
  // Cheap heuristic: count any code points >= U+1F000 (covers emoji blocks
  // U+1F300..U+1FAFF and most pictographs without false-positives on CJK).
  for (const lang of LANGS) {
    const html = read(path.join(I18N_DIR, `${lang}.html`));
    let emojiCount = 0;
    for (const ch of html) {
      const cp = ch.codePointAt(0);
      if (cp !== undefined && cp >= 0x1F000) emojiCount++;
    }
    assert.equal(emojiCount, 0,
      `${lang}.html contains ${emojiCount} emoji-range code points; expected 0`);
  }
});

test('11. sw.js cache slug wave floor >= 209', () => {
  const sw = read(SW);
  const m = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-waveN- cache slug');
  // Note: this assertion intentionally fails until the coordinator bumps
  // sw.js to wave >= 209. That is the hand-off contract.
  assert.ok(parseInt(m[1], 10) >= 209,
    `sw.js wave slug is ${m[1]}; W209 requires >= 209`);
});

test('12. ja.html cites /spec/rs-1 + /compare + /drift + /quickstart/nl', () => {
  const html = read(path.join(I18N_DIR, 'ja.html'));
  for (const s of ['/spec/rs-1', '/compare', '/drift', '/quickstart/nl']) {
    assert.ok(html.includes(s), `ja.html missing surface ${s}`);
  }
});

test('13. zh.html cites /spec/rs-1 + /compare + /drift + /quickstart/nl', () => {
  const html = read(path.join(I18N_DIR, 'zh.html'));
  for (const s of ['/spec/rs-1', '/compare', '/drift', '/quickstart/nl']) {
    assert.ok(html.includes(s), `zh.html missing surface ${s}`);
  }
});

test('14. all 6 docs cite /training (W198) and /training/data-sources (W201)', () => {
  for (const lang of LANGS) {
    const html = read(path.join(I18N_DIR, `${lang}.html`));
    assert.ok(html.includes('/training/data-sources'),
      `${lang}.html missing /training/data-sources (W201)`);
    assert.match(html, /href="\/training"/,
      `${lang}.html missing hyperlink to /training (W198)`);
  }
});

test('15. each i18n doc names at least one of (kolm nl, kolm seeds new, kolm keys rotate)', () => {
  for (const lang of LANGS) {
    const html = read(path.join(I18N_DIR, `${lang}.html`));
    const hit =
      html.includes('kolm nl') ||
      html.includes('kolm seeds new') ||
      html.includes('kolm keys rotate');
    assert.ok(hit,
      `${lang}.html names none of: kolm nl / kolm seeds new / kolm keys rotate`);
  }
});

test('16. each i18n doc contains the new section header (English label "new surfaces")', () => {
  // The new section uses each language's word for "new" but every block
  // carries the English label "new surfaces" in parens for bilingual
  // readability and to make this assertion language-agnostic.
  for (const lang of LANGS) {
    const html = read(path.join(I18N_DIR, `${lang}.html`));
    assert.match(html, /new surfaces/i,
      `${lang}.html missing "new surfaces" English-label marker`);
  }
});

test('17. each i18n doc has at least 7 cross-link <li> entries in the new section', () => {
  // The new <ul> block ships with 10 items per language; we assert >= 7
  // to leave editorial headroom while catching accidental list deletion.
  for (const lang of LANGS) {
    const html = read(path.join(I18N_DIR, `${lang}.html`));
    // Count <li> entries between the new-surfaces <ul> and its closing tag.
    const ulMatch = html.match(/<ul[^>]*>[\s\S]*?<\/ul>/g) || [];
    const newSectionUl = ulMatch.find((blk) =>
      blk.includes('/spec/rs-1') && blk.includes('/k-score-explained'));
    assert.ok(newSectionUl, `${lang}.html missing the new-surfaces <ul> block`);
    const liCount = (newSectionUl.match(/<li\b/g) || []).length;
    assert.ok(liCount >= 7,
      `${lang}.html new-surfaces <ul> has ${liCount} <li>; need >= 7`);
  }
});
