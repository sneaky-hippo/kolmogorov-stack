// Wave 312 — /value-loop live status badge lock-in.
//
// The /value-loop page documents the five rungs but until W312 it was static.
// W312 adds a live status pill that probes /health on page load and updates
// the badge color + label + meta. Behavior assertions only — never page copy.
//
// What gets locked in:
//   1. The badge element exists with id=loop-status, role=status, data-state.
//   2. The probe targets /health and uses {cache:'no-store'} so CDN caches do
//      not lie about uptime.
//   3. The script downgrades to amber (not red) on network error, since
//      "couldn't reach kolm.ai" is usually the visitor's network not ours.
//   4. There is an AbortController-based 4s timeout so a hung backend does
//      not leave the pill spinning forever.
//   5. The badge has all three states (checking / green / amber/red) wired
//      via CSS data-state= selectors so a screen reader can read each.
//   6. The page still cites the W297 + W298 tests as the source of truth.
//   7. /health endpoint in src/router.js still emits {status, version,
//      uptime_s} — the three fields the badge displays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VL_PATH = path.resolve(__dirname, '..', 'public', 'value-loop.html');
const ROUTER_PATH = path.resolve(__dirname, '..', 'src', 'router.js');

function readVL() { return fs.readFileSync(VL_PATH, 'utf8'); }
function readRouter() { return fs.readFileSync(ROUTER_PATH, 'utf8'); }

test('W312 #1 — value-loop.html contains a loop-status badge element', () => {
  const html = readVL();
  assert.match(html, /id="loop-status"/, 'badge needs id="loop-status"');
  assert.match(html, /role="status"/, 'badge needs role="status" for a11y');
  assert.match(html, /data-state="checking"/, 'badge needs initial data-state="checking"');
  assert.match(html, /aria-live="polite"/, 'badge needs aria-live so updates announce');
  assert.match(html, /id="loop-status-label"/, 'label sub-element must have id');
  assert.match(html, /id="loop-status-meta"/, 'meta sub-element must have id');
});

test('W312 #2 — badge probes /health with cache:"no-store"', () => {
  const html = readVL();
  // Find the loop-status script block.
  assert.match(html, /fetch\(\s*['"]\/health['"]/, 'probe must hit /health');
  // The fetch options must include cache: 'no-store' to bypass intermediate caches.
  assert.match(html, /cache:\s*['"]no-store['"]/, 'probe must use cache:no-store');
});

test('W312 #3 — probe failure sets amber state, not red (visitor-network bias)', () => {
  const html = readVL();
  const start = html.indexOf('id="loop-status"');
  assert.ok(start > 0, 'badge anchor must be present');
  // The catch() handler must call setState with "amber", not "red".
  assert.match(html, /\.catch\(\s*function\s*\(\s*err\s*\)\s*{[\s\S]+?setState\(\s*['"]amber['"]/, 'network failure should downgrade to amber');
});

test('W312 #4 — probe has a 4s AbortController timeout', () => {
  const html = readVL();
  assert.match(html, /AbortController/, 'probe must use AbortController');
  assert.match(html, /setTimeout\(\s*function\s*\(\s*\)\s*{\s*if\s*\(\s*ctl\s*\)\s*ctl\.abort\(\)/, 'timeout handler must trigger abort');
  // The timeout value should be 4000ms (4s) - quick enough to avoid spinning forever.
  const m = html.match(/setTimeout\([^,]+,\s*(\d+)\s*\)/);
  assert.ok(m, 'timeout call must specify duration');
  const ms = parseInt(m[1], 10);
  assert.ok(ms >= 2000 && ms <= 10000, `timeout must be 2-10s, got ${ms}`);
});

test('W312 #5 — CSS rules exist for checking, green, amber, red states', () => {
  const html = readVL();
  assert.match(html, /\.status-badge\s*\[data-state="green"\]/, 'green state CSS missing');
  assert.match(html, /\.status-badge\s*\[data-state="amber"\]/, 'amber state CSS missing');
  assert.match(html, /\.status-badge\s*\[data-state="red"\]/, 'red state CSS missing');
  // The animation should ride on the green dot specifically (loop is alive).
  assert.match(html, /\[data-state="green"\][^{]*\.dot[^{]*{[^}]*animation/, 'green dot must have pulse animation');
});

test('W312 #6 — page still references the W297/W298 tests as source of truth', () => {
  // The W312 badge must not displace the existing "tested behavior" anchors.
  const html = readVL();
  assert.match(html, /wave297-value-loop-happy-path\.test\.js/, 'page must still cite wave297 test');
  assert.match(html, /wave298-doctor-loop\.test\.js/, 'page must still cite wave298 test');
});

test('W312 #7 — /health endpoint still emits the three fields the badge displays', () => {
  // The badge reads .version + .uptime_s + (presence of status). If any of
  // those go away in src/router.js, the badge meta line breaks silently.
  const src = readRouter();
  assert.match(src, /r\.get\(['"]\/health['"]/, '/health route must exist');
  // Find the handler body.
  const start = src.indexOf("r.get('/health'");
  const end = src.indexOf('}));', start);
  const body = src.slice(start, end);
  assert.match(body, /status:\s*['"]ok['"]/, '/health must include status:"ok"');
  assert.match(body, /version:/, '/health must include version field');
  assert.match(body, /uptime_s:/, '/health must include uptime_s field');
});

test('W312 #8 — sessionStorage cache is read on load to avoid flash', () => {
  const html = readVL();
  assert.match(html, /sessionStorage\.getItem\(\s*['"]kolm-loop-status['"]/, 'cached state must be re-hydrated');
  assert.match(html, /sessionStorage\.setItem\(\s*['"]kolm-loop-status['"]/, 'green state must persist to sessionStorage');
});
