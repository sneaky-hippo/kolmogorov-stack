// Wave 224: slop cut + behavior-test pattern audit.
//
// 16 low-conversion pages cut with permanent 301 → canonical destinations
// so inbound links and SEO weight consolidate. Tests assert BEHAVIOR
// (page-file absent, redirect entry present with correct shape and a real
// destination, sw.js wave-floor, no orphan rewrites left pointing to the
// deleted .html) — not copy markers. Per Pablo W202-W210 anti-pattern fix.
//
// The same wave also locks in the "tests/wave211+.test.js are behavior-driven"
// pattern as a guard against the marker-asserting style drifting back in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const SW = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

// The 16 cut paths and their canonical 301 destinations. Every entry MUST
// match a permanent: true redirect in vercel.json.
// Note: /defense was originally cut here but resurrected in W272 as a v1
// vertical microsite. The W272 #13 test now requires public/defense.html
// to exist with canonical pointing at /defense, so it has been removed
// from the W224 CUTS list and from the vercel.json redirect set.
const CUTS = {
  '/agents':      '/product',
  '/evolve':      '/product',
  '/bounty':      '/community',
  '/bounties':    '/community',
  '/cloud':       '/enterprise',
  '/distill':     '/quickstart',
  '/edge':        '/device',
  '/cookbook':    '/docs',
  '/serve':       '/runtimes',
  '/playground':  '/quickstart',
  '/onboarding':  '/quickstart',
  '/recall':      '/captures',
  '/anatomy':     '/how-it-works',
  '/showcase':    '/case-studies',
  '/openai':      '/compare/kolm-vs-openai-fine-tune',
};

test('W224 #1 - at least 15 pages cut from public/ (plan floor)', () => {
  assert.ok(Object.keys(CUTS).length >= 15,
    `cut list has ${Object.keys(CUTS).length} entries; plan floor is 15`);
});

test('W224 #2 - cut .html files no longer exist in public/', () => {
  for (const slug of Object.keys(CUTS)) {
    const name = slug.replace(/^\//, '') + '.html';
    const fp = path.join(PUBLIC, name);
    assert.ok(!fs.existsSync(fp),
      `cut page still exists at ${fp} — delete the file and rely on the 301 redirect`);
  }
});

test('W224 #3 - every cut path has a permanent: true redirect in vercel.json', () => {
  for (const [src, dest] of Object.entries(CUTS)) {
    const rd = VERCEL.redirects.find((r) => r.source === src);
    assert.ok(rd, `missing redirect for ${src}`);
    assert.equal(rd.destination, dest,
      `redirect for ${src} should point to ${dest} (saw ${rd.destination})`);
    assert.equal(rd.permanent, true,
      `redirect for ${src} must be permanent: true (saw ${rd.permanent}) for SEO weight consolidation`);
  }
});

test('W224 #4 - no orphan rewrites pointing to cut .html files', () => {
  for (const slug of Object.keys(CUTS)) {
    const cutPath = slug + '.html';
    const orphan = VERCEL.rewrites.find((r) => r.destination === cutPath);
    assert.ok(!orphan,
      `rewrite still points to deleted ${cutPath} — orphan rewrite ${JSON.stringify(orphan)}`);
  }
});

test('W224 #5 - every 301 destination is itself a real surface (file or rewrite-resolvable)', () => {
  for (const [src, dest] of Object.entries(CUTS)) {
    // Either the destination is a literal file under public/, OR there's a
    // rewrite in vercel.json that maps it to one. (Some destinations like
    // /docs use index.html under a directory; others are .html files.)
    const tryFiles = [
      path.join(PUBLIC, dest.replace(/^\//, '') + '.html'),
      path.join(PUBLIC, dest.replace(/^\//, ''), 'index.html'),
    ];
    const fileExists = tryFiles.some((p) => fs.existsSync(p));
    const rewriteResolves = VERCEL.rewrites.some((r) => r.source === dest);
    assert.ok(fileExists || rewriteResolves,
      `redirect ${src} → ${dest} has no file at ${tryFiles[0]} / ${tryFiles[1]} and no rewrite either`);
  }
});

test('W224 #6 - sw.js cache slug at or beyond wave 224', () => {
  const m = SW.match(/const CACHE = 'kolm-v7-[^']+-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE must follow the wave-N slug pattern');
  const waveN = parseInt(m[1], 10);
  assert.ok(waveN >= 224, `sw.js wave-slug must be >= 224 (saw ${waveN})`);
});

test('W224 #7 - cut list members are NOT also rewritten (would mask the redirect)', () => {
  // Vercel evaluates rewrites before redirects; if a cut path is still in
  // rewrites pointing at *any* .html, the 301 never fires.
  for (const slug of Object.keys(CUTS)) {
    const rw = VERCEL.rewrites.find((r) => r.source === slug);
    assert.ok(!rw,
      `cut path ${slug} still has a rewrite entry ${JSON.stringify(rw)} — would mask the 301 redirect`);
  }
});

test('W224 #8 - W211+ tests follow the behavior-assertion pattern (sample audit)', () => {
  // Positive pattern lock-in: pick three W211-onwards tests at random
  // (W213, W217, W222), require each to assert at least one structural
  // behavior contract (file read, status code, regex on source identifier,
  // or fs.existsSync) — NOT just `.includes('marketing copy')`.
  const samples = [
    'wave213-live-capture-tail.test.js',
    'wave217-frontier-models.test.js',
    'wave222-tui-altscreen.test.js',
  ];
  const behaviorMarkers = [
    /assert\.match\(/,         // regex on source/structure
    /assert\.equal\(/,         // exact value (header, exit code, status)
    /spawnSync\(/,             // CLI exit-code contract
    /assert\.ok\(\s*fs\./,     // file existence / size check
    /JSON\.parse/,             // structured-data contract
    /process\.stdin|process\.stdout/, // I/O contract
  ];
  for (const f of samples) {
    const p = path.join(ROOT, 'tests', f);
    assert.ok(fs.existsSync(p), `sample test ${f} must exist for pattern audit`);
    const src = fs.readFileSync(p, 'utf8');
    const has = behaviorMarkers.some((rx) => rx.test(src));
    assert.ok(has,
      `${f} must use at least one behavior assertion idiom (regex/equal/spawnSync/file/JSON/IO); ` +
      `tests that only assert page copy violate the W202-W210 anti-pattern correction`);
  }
});

test('W224 #9 - cuts include the plan-named dup pairs', () => {
  // /distill (dup of /quickstart), /edge (dup of /device), /cookbook
  // (subsumed by /docs) — these three were explicit plan candidates.
  // Failure here means the cut list drifted from the plan.
  assert.equal(CUTS['/distill'], '/quickstart');
  assert.equal(CUTS['/edge'], '/device');
  assert.equal(CUTS['/cookbook'], '/docs');
});

test('W224 #10 - vercel.json is still valid JSON after the cut + redirect surgery', () => {
  // Smoke test: re-parse the file and confirm the top-level shape is intact.
  const raw = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.rewrites));
  assert.ok(Array.isArray(parsed.redirects));
  assert.ok(Array.isArray(parsed.headers));
  // The rewrites count drops by exactly the cuts; the redirects count
  // gains the same number. Asserted as a >= floor so we don't accidentally
  // re-add a rewrite for a cut path.
  assert.ok(parsed.redirects.length >= Object.keys(CUTS).length,
    `redirects must include at least the ${Object.keys(CUTS).length} cuts`);
});
