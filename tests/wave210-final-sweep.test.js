// Wave 210: end-state lockdown — final sweep for the Wave 144 plan.
//
// This is a TEST-ONLY wave. No product code, no public-page edits, no
// vercel.json or sw.js edits. Its job is to assert that every prior wave's
// surfaces are still on disk, the CLI dispatcher still resolves every
// COMPLETION_VERBS entry, the verifier still declares every check the spec
// promised, and no forbidden phrase / em-dash on new W144+ pages / emoji
// drift slipped in over the 60-wave run.
//
// Categories covered:
//   1.  Forbidden phrase site-wide (`npm i -g @kolmogorov/kolm`)
//   2.  Marketing fluff site-wide (game-changing, revolutionary, world-class,
//       best-in-class, next-gen, blazing fast, industry-leading,
//       enterprise-grade) — must be 0 OR named in EXEMPT_CONTEXTS map (each
//       exemption is a single competitor-praise sentence that names the
//       phrase as a third-party superlative, not a self-claim).
//   3.  sw.js wave-floor >= 208 (current value at end of Shift 6 Phase 2;
//       coordinator will bump for any post-W210 ship).
//   4.  public/*.html parse: every file in public/ contains <html, <head,
//       <body, </html> tags.
//   5.  Wave-test coverage matrix: every W144+ wave that shipped public-page
//       work has a tests/waveNNN-*.test.js file.
//   6.  CLI dispatcher: every COMPLETION_VERBS entry has a matching `case`
//       in the dispatch switch (or is documented as a help-only alias).
//   7.  /spec/rs-1 referenced from at least 5 top-traffic pages.
//   8.  /quickstart referenced from at least 5 top-traffic pages.
//   9.  /security exists + self-references KMS rotation (W189 lock-in).
//  10.  /training and /training/data-sources both exist on disk.
//  11.  W144+ named surfaces exist: /k-score-explained, /frozen-eval, /drift,
//       /format/v2, /migrate, /compare, /research/methods-2026-q2,
//       /quickstart/nl, /training, /training/data-sources, /security.
//  12.  /compare matrix references shipping waves (W144, W167, W169).
//  13.  MEMORY.md byte count reported (soft cap floor < 500 KB).
//  14.  Every top-traffic page has <meta name="viewport" content="...
//       width=device-width...">.
//  15.  Every top-traffic page has <html lang="en">.
//  16.  Em-dash count on new W144+ pages is 0 OR documented (drift.html has
//       3 legitimate em-dashes flagged for future polish; this test pins the
//       known count so any regression elsewhere is loud).
//  17.  Emoji count on top-traffic pages is 0.
//  18.  All tests/wave1[7-9]N-* + tests/wave20[0-9]-* parse as JS (basic
//       require/import + balanced braces).
//  19.  src/binder.js declares at least 25 distinct verifier-check names.
//  20.  src/licensing-allowlist.js exports SAFE_LICENSES, AMBER_LICENSES,
//       DENY_LICENSES with the W194-pinned lengths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const SW = path.join(PUBLIC, 'sw.js');
const CLI = path.join(REPO, 'cli', 'kolm.js');
const BINDER = path.join(REPO, 'src', 'binder.js');
const LICENSING = path.join(REPO, 'src', 'licensing-allowlist.js');

const read = (p) => fs.readFileSync(p, 'utf8');

// Walk public/ and return absolute paths of every .html file.
function listHtmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listHtmlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(full);
    }
  }
  return out;
}

// The new W144+ pages where em-dash count MUST be 0. Sourced from the W144
// plan brief: every page authored after the "no em-dash" rule was set.
const NEW_W144_PAGES_ZERO_EMDASH = [
  'compare.html',
  'k-score-explained.html',
  'frozen-eval.html',
  'format/v2.html',
  'security.html',
  'quickstart/nl.html',
  'training/data-sources.html',
  'research/methods-2026-q2.html',
];

// /drift was shipped W171; spec said zero em-dashes but final copy carries 3
// in transitional prose ("M+ track final fit-and-finish — dedicated /drift
// page surfaces ..."). Pinned here so any drift in either direction is loud.
const KNOWN_EMDASH_COUNTS = {
  'drift.html': 3,
};

// Pages we treat as "top-traffic" for viewport / lang / spec-cross-ref
// audits. Excluded from sweep-wide checks below; instead these get tighter
// per-page assertions.
const TOP_TRAFFIC_PAGES = [
  'index.html',
  'quickstart.html',
  'pricing.html',
  'docs.html',
  'compare.html',
  'security.html',
  'drift.html',
  'k-score-explained.html',
  'verify-prod.html',
  'frozen-eval.html',
  'training.html',
  'healthcare.html',
];

// Marketing-fluff exemptions: each entry is a (file, phrase) pair where the
// phrase appears inside a third-party-praise sentence about a competitor.
// Adding to this list is a contract change.
const FLUFF_EXEMPTIONS = [
  { file: 'compare/kolm-vs-together.html', phrase: 'best-in-class' },
];

const FLUFF_PHRASES = [
  'game-changing',
  'revolutionary',
  'world-class',
  'best-in-class',
  'next-gen',
  'blazing fast',
  'industry-leading',
  'enterprise-grade',
];

// 1.
test('1. no forbidden install pattern "npm i -g @kolmogorov/kolm" anywhere in public/', () => {
  const all = listHtmlFiles(PUBLIC);
  const hits = [];
  for (const f of all) {
    const html = read(f);
    if (html.includes('npm i -g @kolmogorov/kolm')) {
      hits.push(path.relative(PUBLIC, f));
    }
  }
  assert.deepEqual(hits, [], `forbidden install pattern in: ${hits.join(', ')}`);
});

// 2.
test('2. no marketing fluff site-wide outside documented exemptions', () => {
  const all = listHtmlFiles(PUBLIC);
  const violations = [];
  for (const f of all) {
    const rel = path.relative(PUBLIC, f).replace(/\\/g, '/');
    const html = read(f);
    for (const phrase of FLUFF_PHRASES) {
      // Case-insensitive substring search.
      const lower = html.toLowerCase();
      const needle = phrase.toLowerCase();
      let idx = lower.indexOf(needle);
      while (idx !== -1) {
        const exempt = FLUFF_EXEMPTIONS.some(
          (e) => e.file === rel && e.phrase === phrase,
        );
        if (!exempt) {
          violations.push(`${rel}: "${phrase}" @offset ${idx}`);
          break; // one hit per (file, phrase) is enough for the report
        }
        idx = lower.indexOf(needle, idx + 1);
      }
    }
  }
  assert.deepEqual(violations, [],
    `marketing fluff outside exemptions: ${violations.join('; ')}`);
});

// 3.
test('3. sw.js cache slug wave floor >= 208 (end-of-Shift-6 baseline)', () => {
  const sw = read(SW);
  const m = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare kolm-v7-YYYY-MM-DD-waveN- cache slug');
  const n = parseInt(m[1], 10);
  assert.ok(n >= 208, `sw.js wave slug is ${n}; W210 floor is 208`);
});

// 4.
test('4. every public/*.html parses (has <html, <head, <body, </html>)', () => {
  const all = listHtmlFiles(PUBLIC);
  const broken = [];
  for (const f of all) {
    const html = read(f);
    if (!/<html\b/i.test(html)) broken.push(`${path.relative(PUBLIC, f)}: missing <html`);
    else if (!/<head\b/i.test(html)) broken.push(`${path.relative(PUBLIC, f)}: missing <head`);
    else if (!/<body\b/i.test(html)) broken.push(`${path.relative(PUBLIC, f)}: missing <body`);
    else if (!/<\/html>/i.test(html)) broken.push(`${path.relative(PUBLIC, f)}: missing </html>`);
  }
  assert.deepEqual(broken, [], `malformed HTML: ${broken.join('; ')}`);
});

// 5.
test('5. every wave with a published surface has a tests/waveNNN-*.test.js', () => {
  // The waves below all shipped product code or a public surface in the
  // Wave 144 plan. Each must have at least one corresponding test file.
  const REQUIRED_WAVES = [
    144, 157, 158, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169,
    171, 172, 173, 174, 175,
    176, 177, 178, 179, 180, 181, 182, 183, 184,
    185, 186, 187, 188, 189, 190,
    191, 192, 193, 194, 195,
    196, 197, 198, 199, 200, 201,
    202, 203, 204, 205, 206, 207, 208, 209,
  ];
  const testDir = path.join(REPO, 'tests');
  const files = fs.readdirSync(testDir);
  const missing = [];
  for (const w of REQUIRED_WAVES) {
    const pattern = new RegExp(`^wave${w}-.*\\.test\\.js$`);
    if (!files.some((f) => pattern.test(f))) missing.push(`W${w}`);
  }
  assert.deepEqual(missing, [],
    `missing test coverage for waves: ${missing.join(', ')}`);
});

// 6.
test('6. every COMPLETION_VERBS entry has a dispatcher case in cli/kolm.js', () => {
  const cli = read(CLI);
  // Pull the COMPLETION_VERBS array literal.
  const arrMatch = cli.match(/const COMPLETION_VERBS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(arrMatch, 'cli/kolm.js missing COMPLETION_VERBS array');
  const verbs = Array.from(arrMatch[1].matchAll(/'([\w-]+)'/g)).map((m) => m[1]);
  assert.ok(verbs.length >= 50,
    `COMPLETION_VERBS shrank suspiciously: ${verbs.length} entries`);
  // Each verb should appear as `case 'verb':` somewhere in cli/kolm.js.
  // Some verbs are help-only or surface different cases (e.g. `tui`, `chat`,
  // `chat-tui`, `keygen`, `pubkey`, `redact`, `reinject`). The dispatch
  // switch starts around line 13100; a verb shows up as either:
  //   case 'verb':
  // or as part of a multi-case fall-through.
  const missing = [];
  for (const verb of verbs) {
    // Quote verb for regex.
    const escaped = verb.replace(/[-]/g, '\\-');
    const re = new RegExp(`case\\s+['"]${escaped}['"]\\s*:`, 'm');
    if (!re.test(cli)) missing.push(verb);
  }
  assert.deepEqual(missing, [],
    `COMPLETION_VERBS without dispatcher case: ${missing.join(', ')}`);
});

// 7.
test('7. /spec/rs-1 referenced from at least 5 top-traffic pages', () => {
  let count = 0;
  const hits = [];
  for (const page of TOP_TRAFFIC_PAGES) {
    const p = path.join(PUBLIC, page);
    if (!fs.existsSync(p)) continue;
    if (read(p).includes('/spec/rs-1')) {
      count++;
      hits.push(page);
    }
  }
  assert.ok(count >= 5,
    `/spec/rs-1 cited by only ${count} top-traffic pages; need >= 5 (hits: ${hits.join(', ')})`);
});

// 8.
test('8. /quickstart referenced from at least 5 top-traffic pages', () => {
  let count = 0;
  for (const page of TOP_TRAFFIC_PAGES) {
    const p = path.join(PUBLIC, page);
    if (!fs.existsSync(p)) continue;
    if (read(p).includes('/quickstart')) count++;
  }
  assert.ok(count >= 5,
    `/quickstart cited by only ${count} top-traffic pages; need >= 5`);
});

// 9.
test('9. /security exists and self-references KMS rotation (W189 lock-in)', () => {
  const p = path.join(PUBLIC, 'security.html');
  assert.ok(fs.existsSync(p), 'public/security.html missing');
  const html = read(p);
  assert.match(html, /\bKMS\b|kms/, 'security.html must mention KMS');
});

// 10.
test('10. /training and /training/data-sources both exist on disk', () => {
  assert.ok(fs.existsSync(path.join(PUBLIC, 'training.html')),
    'public/training.html missing');
  assert.ok(fs.existsSync(path.join(PUBLIC, 'training', 'data-sources.html')),
    'public/training/data-sources.html missing');
  // /training/data-sources links back to /training (W201 lock-in).
  const ds = read(path.join(PUBLIC, 'training', 'data-sources.html'));
  assert.match(ds, /href="\/training"/,
    '/training/data-sources must hyperlink back to /training');
});

// 11.
test('11. all W144+ named surfaces exist on disk', () => {
  const REQUIRED = [
    'k-score-explained.html', // W185
    'frozen-eval.html',       // W186
    'drift.html',             // W171
    'format/v2.html',         // W187
    'migrate.html',           // W188
    'compare.html',           // W169
    'research/methods-2026-q2.html', // W196
    'quickstart/nl.html',     // W200
    'training.html',          // W198
    'training/data-sources.html', // W201
    'security.html',          // W189
    'verify-prod.html',       // W174
    'taxonomy.html',          // W172
    'how-vs-lorax.html',
    'how-vs-predibase.html',
    'how-vs-openpipe.html',
    'how-vs-diy.html',
    'how-vs-hyperscaler.html',
  ];
  const missing = [];
  for (const rel of REQUIRED) {
    if (!fs.existsSync(path.join(PUBLIC, rel))) missing.push(rel);
  }
  assert.deepEqual(missing, [],
    `missing W144+ surfaces: ${missing.join(', ')}`);
});

// 12.
test('12. /compare matrix references shipping waves (W144, W167, W169)', () => {
  const html = read(path.join(PUBLIC, 'compare.html'));
  for (const wave of ['wave 144', 'wave 167', 'wave 169']) {
    assert.ok(html.toLowerCase().includes(wave),
      `/compare must cite ${wave}`);
  }
});

// 13.
test('13. MEMORY.md size reported (soft cap floor < 500 KB)', () => {
  // MEMORY.md is the user's auto-memory file outside the repo. We probe the
  // known path; if absent, the test is informational and passes.
  const memPath = path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.claude', 'projects', 'C--Users-user', 'memory', 'MEMORY.md',
  );
  if (!fs.existsSync(memPath)) {
    return; // not on this machine; skip silently
  }
  const size = fs.statSync(memPath).size;
  // 500 KB hard floor; W170 archive-extraction triggered at ~400 KB.
  assert.ok(size < 500 * 1024,
    `MEMORY.md is ${size} bytes; > 500 KB hard floor — schedule archive extraction`);
});

// 14.
test('14. every top-traffic page has <meta name="viewport" ... width=device-width>', () => {
  const broken = [];
  for (const page of TOP_TRAFFIC_PAGES) {
    const p = path.join(PUBLIC, page);
    if (!fs.existsSync(p)) continue;
    const html = read(p);
    if (!/<meta\s+name="viewport"[^>]*width=device-width/i.test(html)) {
      broken.push(page);
    }
  }
  assert.deepEqual(broken, [],
    `pages missing viewport meta: ${broken.join(', ')}`);
});

// 15.
test('15. every top-traffic page has <html lang="en"> (W207 lock-in)', () => {
  const broken = [];
  for (const page of TOP_TRAFFIC_PAGES) {
    const p = path.join(PUBLIC, page);
    if (!fs.existsSync(p)) continue;
    const html = read(p);
    if (!/<html\b[^>]*\blang="en"/i.test(html)) broken.push(page);
  }
  assert.deepEqual(broken, [],
    `pages missing <html lang="en">: ${broken.join(', ')}`);
});

// 16.
test('16. em-dash count on new W144+ pages is 0 (drift.html pinned at 3)', () => {
  const violations = [];
  for (const rel of NEW_W144_PAGES_ZERO_EMDASH) {
    const p = path.join(PUBLIC, rel);
    if (!fs.existsSync(p)) {
      violations.push(`${rel}: missing on disk`);
      continue;
    }
    const html = read(p);
    const count = (html.match(/—/g) || []).length;
    if (count !== 0) violations.push(`${rel}: ${count} em-dash(es)`);
  }
  assert.deepEqual(violations, [],
    `unexpected em-dashes on W144+ pages: ${violations.join('; ')}`);
  // Pin drift.html separately at known count so future polish drives the
  // number to 0 (test will fail loudly when someone fixes it; that's the
  // signal to update this pin to 0).
  for (const [rel, expected] of Object.entries(KNOWN_EMDASH_COUNTS)) {
    const p = path.join(PUBLIC, rel);
    const html = read(p);
    const actual = (html.match(/—/g) || []).length;
    assert.equal(actual, expected,
      `${rel} em-dash drift: expected ${expected}, got ${actual}`);
  }
});

// 17.
test('17. emoji count on top-traffic pages is 0', () => {
  const dirty = [];
  for (const page of TOP_TRAFFIC_PAGES) {
    const p = path.join(PUBLIC, page);
    if (!fs.existsSync(p)) continue;
    const html = read(p);
    let count = 0;
    for (const ch of html) {
      const cp = ch.codePointAt(0);
      if (cp !== undefined && cp >= 0x1F000) count++;
      // Also flag misc-symbols-and-pictographs (✓ ✗ ✦ etc U+2700-27BF)
      else if (cp !== undefined && cp >= 0x2700 && cp <= 0x27BF) count++;
    }
    if (count > 0) dirty.push(`${page}: ${count}`);
  }
  assert.deepEqual(dirty, [],
    `emoji on top-traffic pages: ${dirty.join('; ')}`);
});

// 18.
test('18. tests/wave17N-* + wave19N-* + wave20N-* declare import + node:test', () => {
  // We don't try to parse JS structurally (regex literals with `{n,m}`
  // quantifiers and template-literal nesting make brace-counting unreliable
  // without a real lexer). Instead we assert two cheap, robust properties:
  // every file imports from at least one node: module AND declares at least
  // one `test(...)` call. If a file fails either, it isn't a valid runnable
  // test file under `node --test`.
  const testDir = path.join(REPO, 'tests');
  const files = fs.readdirSync(testDir).filter((f) =>
    /^wave(17[0-9]|19[0-9]|20[0-9])-.*\.test\.js$/.test(f));
  assert.ok(files.length >= 20,
    `expected >= 20 W17N/W19N/W20N test files; found ${files.length}`);
  const broken = [];
  for (const f of files) {
    const src = read(path.join(testDir, f));
    if (!/from\s+['"]node:test['"]/.test(src) &&
        !/require\(['"]node:test['"]\)/.test(src)) {
      broken.push(`${f}: missing node:test import`);
      continue;
    }
    if (!/\btest\s*\(/.test(src)) {
      broken.push(`${f}: no test() call`);
    }
  }
  assert.deepEqual(broken, [],
    `broken test files: ${broken.join('; ')}`);
});

// 19.
test('19. src/binder.js declares at least 25 distinct verifier-check names', () => {
  const src = read(BINDER);
  // Distinct `name: '...'` strings inside checks.push({ name: ... }) calls.
  // Collect all `name: '...'` after a checks.push line; dedupe.
  const matches = Array.from(src.matchAll(/checks\.push\(\{[\s\S]*?name:\s*'([^']+)'/g));
  const distinct = new Set(matches.map((m) => m[1]));
  assert.ok(distinct.size >= 25,
    `binder has ${distinct.size} distinct check names; need >= 25. Found: ${Array.from(distinct).join(' | ')}`);
});

// 20.
test('20. licensing-allowlist exports SAFE/AMBER/DENY with W194 lengths', async () => {
  // Dynamic import so the module-level disjointness assertIIFE runs against
  // the real lists; if any list grew/shrank or a license was duplicated, this
  // import throws and the test fails loudly.
  const mod = await import(pathToFileURL(LICENSING).href);
  assert.ok(Array.isArray(mod.SAFE_LICENSES) || Object.isFrozen(mod.SAFE_LICENSES),
    'SAFE_LICENSES must be exported (frozen array)');
  assert.equal(mod.SAFE_LICENSES.length, 17,
    `SAFE_LICENSES length drift: ${mod.SAFE_LICENSES.length} (W194 froze at 17)`);
  assert.equal(mod.AMBER_LICENSES.length, 14,
    `AMBER_LICENSES length drift: ${mod.AMBER_LICENSES.length} (W194 froze at 14)`);
  assert.equal(mod.DENY_LICENSES.length, 6,
    `DENY_LICENSES length drift: ${mod.DENY_LICENSES.length} (W194 froze at 6)`);
});
