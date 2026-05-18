// Wave 223: TUI showcase page /tui — asciinema-style demo + 6-card keymap +
// install snippet, links to /captures + /quickstart + /foundations + /product.
// Tests assert BEHAVIOR + structure, not page-text marketing markers. The .cast
// file must be valid asciinema v2 (header object + frame arrays). Per
// Pablo W202-W210 anti-pattern correction: don't lock in copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TUI_HTML = fs.readFileSync(path.join(ROOT, 'public/tui.html'), 'utf8');
const CAST_FILE = path.join(ROOT, 'public/cdn/kolm-assets/tui-demo.cast');
const CAST_TEXT = fs.readFileSync(CAST_FILE, 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

test('W223 #1 - /tui page exists with semantic structure (h1, lede, main)', () => {
  assert.match(TUI_HTML, /<h1>kolm tui<\/h1>/);
  assert.match(TUI_HTML, /<main id="main">/);
  assert.match(TUI_HTML, /<section class="hero">/);
  // Lede must mention the value loop concretely (live captures + artifact
  // verbs) — not just "AI compiler" boilerplate.
  assert.ok(/live\s+captures/i.test(TUI_HTML), 'lede must name live captures');
  assert.ok(/SSE/i.test(TUI_HTML), 'lede must name SSE (the W213 transport)');
});

test('W223 #2 - asciinema terminal-player <pre> + play/pause/restart controls', () => {
  // Player surface — the <pre id="tui-player"> is the canvas; three
  // standard controls (play/pause/restart) so the demo is operable, not
  // just hero decoration.
  assert.match(TUI_HTML, /<pre id="tui-player"/);
  assert.match(TUI_HTML, /id="tui-play"/);
  assert.match(TUI_HTML, /id="tui-pause"/);
  assert.match(TUI_HTML, /id="tui-restart"/);
});

test('W223 #3 - 6-card keymap grid (Movement / Source / Filter & command / Actions / Value loop / Help & exit)', () => {
  // The page exists to teach the keymap. Each of the six cards must be
  // present with its key list. Asserted via the h3 titles + key glyphs.
  const cards = [
    /<h3>Movement<\/h3>/,
    /<h3>Source<\/h3>/,
    /<h3>Filter &amp;\s*command<\/h3>/,
    /<h3>Actions<\/h3>/,
    /<h3>Value loop<\/h3>/,
    /<h3>Help &amp;\s*exit<\/h3>/,
  ];
  for (const rx of cards) {
    assert.match(TUI_HTML, rx, `missing keymap card matching ${rx}`);
  }
});

test('W223 #4 - install snippet shows `kolm tui` and a tmux/SSH/Tailscale form', () => {
  // The 5-foundations stack is the whole point of shipping a TUI — install
  // copy must show the SSH+tmux incantation, not just `kolm tui` bare.
  assert.match(TUI_HTML, /class="install"/);
  assert.match(TUI_HTML, /kolm tui/);
  assert.match(TUI_HTML, /tmux/);
  assert.match(TUI_HTML, /ssh/i);
  // Brand: Tailscale named explicitly so the page can be found in search.
  assert.match(TUI_HTML, /Tailscale/i);
});

test('W223 #5 - cross-links to /captures + /quickstart + /foundations + /product', () => {
  // Each of the four sibling surfaces the TUI sits between in the value loop
  // must be linked. Tested by anchor href, not link text (text can drift).
  assert.match(TUI_HTML, /href="\/captures"/);
  assert.match(TUI_HTML, /href="\/quickstart"/);
  assert.match(TUI_HTML, /href="\/foundations"/);
  assert.match(TUI_HTML, /href="\/product"/);
});

test('W223 #6 - vercel.json wires /tui → /tui.html', () => {
  const rw = VERCEL.rewrites.find((r) => r.source === '/tui');
  assert.ok(rw, '/tui rewrite must exist');
  assert.equal(rw.destination, '/tui.html');
});

test('W223 #7 - sw.js cache slug at or beyond wave 223 (monotonic wave-floor, not equality)', () => {
  // Anti-pattern correction (W169 test #12 trap): assert >= 223, not == 223,
  // so subsequent waves bumping the cache don't regress this test.
  const m = SW_JS.match(/const CACHE = 'kolm-v7-[^']+-wave(\d+)-/);
  assert.ok(m, 'sw.js CACHE must follow the wave-N slug pattern');
  const waveN = parseInt(m[1], 10);
  assert.ok(waveN >= 223, `sw.js wave-slug must be >= 223 (saw ${waveN})`);
});

test('W223 #8 - JSON-LD: SoftwareApplication + BreadcrumbList', () => {
  // Structured data so the page is indexable for "kolm tui" / "ai compiler tui"
  // and shows up in rich results. Crawled by the W225 SEO sweep.
  assert.match(TUI_HTML, /<script type="application\/ld\+json">/);
  assert.match(TUI_HTML, /"@type":\s*"SoftwareApplication"/);
  assert.match(TUI_HTML, /"@type":\s*"BreadcrumbList"/);
  // The breadcrumb must root the page in /product → /tui (W221 nav semantics).
  assert.match(TUI_HTML, /"item":\s*"https:\/\/kolm\.ai\/product"/);
  assert.match(TUI_HTML, /"item":\s*"https:\/\/kolm\.ai\/tui"/);
});

test('W223 #9 - inline player JS fetches the .cast file and parses frames', () => {
  // The player must: (a) fetch /cdn/kolm-assets/tui-demo.cast,
  // (b) JSON-parse each line into a frame array, (c) write payloads into
  // the <pre>. Asserted by source-grep on the contract pieces.
  assert.match(TUI_HTML, /fetch\(['"]\/cdn\/kolm-assets\/tui-demo\.cast['"]/);
  assert.match(TUI_HTML, /JSON\.parse/);
  assert.match(TUI_HTML, /preEl\.textContent\s*=/);
  // Must handle clear-and-home (\x1b[2J\x1b[H) — the alt-screen redraw signal
  // — so the frame replaces rather than appends.
  assert.match(TUI_HTML, /\\\[2J\\\[H|\[2J\[H/, 'must handle alt-screen clear-and-home');
});

test('W223 #10 - .cast file is valid asciinema v2 (header object + frame arrays)', () => {
  // Cast file format: line 1 is a JSON object with version:2 + width + height
  // + timestamp; lines 2+ are JSON arrays of [time, "o", payload]. Tested by
  // actually parsing.
  const lines = CAST_TEXT.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 7, `expected >=7 lines (header + >=6 frames), saw ${lines.length}`);
  const header = JSON.parse(lines[0]);
  assert.equal(header.version, 2, 'header version must be 2');
  assert.ok(header.width > 0, 'header width must be positive');
  assert.ok(header.height > 0, 'header height must be positive');
  let frameCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const frame = JSON.parse(lines[i]);
    assert.ok(Array.isArray(frame), `line ${i + 1} must be a frame array`);
    assert.ok(frame.length >= 3, `frame ${i} must have [time, type, payload]`);
    assert.equal(frame[1], 'o', `frame ${i} type must be 'o'`);
    assert.equal(typeof frame[0], 'number', `frame ${i} time must be a number`);
    assert.equal(typeof frame[2], 'string', `frame ${i} payload must be a string`);
    frameCount++;
  }
  assert.ok(frameCount >= 6, `expected >=6 demo frames, saw ${frameCount}`);
});

test('W223 #11 - .cast file demonstrates the alt-screen TUI (alt-screen escape + box-drawing or status bar)', () => {
  // The recording exists to show the W222 TUI behavior. Its frames must show
  // the alt-screen enter sequence (\x1b[?1049h or the bare-escape form) AND
  // some pane/box-drawing characters, AND the status bar at the bottom.
  // Without these the file isn't really a TUI demo, it's just text.
  assert.match(CAST_TEXT, /\[\?1049h/, 'cast must show alt-screen enter');
  assert.match(CAST_TEXT, /\[\?1049l/, 'cast must show alt-screen exit on cleanup');
  // Box-drawing — either Unicode box chars or ASCII pipe/dash that the TUI uses.
  assert.ok(/[┌┐└┘│─┬┴]/.test(CAST_TEXT), 'cast must include box-drawing characters');
  // Mode tag from the status bar — proves the recording is the real TUI not a
  // hand-typed mockup.
  assert.ok(/\[normal\]|\[filter\]|\[command\]|\[:/.test(CAST_TEXT),
    'cast must include a TUI status-bar mode tag');
});

test('W223 #12 - .cast frames are monotonic in time (so playback order is well-defined)', () => {
  // Asciinema players assume frame times are non-decreasing. A bad cast that
  // has out-of-order timestamps would render frames in the wrong order.
  const lines = CAST_TEXT.split(/\r?\n/).filter(Boolean);
  let prev = 0;
  for (let i = 1; i < lines.length; i++) {
    const f = JSON.parse(lines[i]);
    assert.ok(f[0] >= prev, `frame ${i} time ${f[0]} must be >= previous ${prev}`);
    prev = f[0];
  }
});

test('W223 #13 - non-TTY hint references the right fallback verbs from /tui copy', () => {
  // Mirrors W222 #12: when stdin/stdout aren't a TTY, kolm tui exits with a
  // stderr hint. The /tui page should advertise the same non-interactive
  // verbs so users on CI / mobile shells know where to look.
  assert.match(TUI_HTML, /kolm list/);
  assert.match(TUI_HTML, /kolm inspect/);
  assert.match(TUI_HTML, /kolm tail captures/);
});

test('W223 #14 - has a canonical URL + OG card so SEO/share consumers index it', () => {
  // W225 will own the sweep; this is the per-page contract.
  assert.match(TUI_HTML, /<link rel="canonical" href="https:\/\/kolm\.ai\/tui">/);
  assert.match(TUI_HTML, /<meta property="og:title"/);
  assert.match(TUI_HTML, /<meta property="og:description"/);
});
