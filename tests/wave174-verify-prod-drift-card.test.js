// Wave 174 — Live drift indicator card on /verify-prod.
//
// The W167 src/drift-supersession.js backend ships detectDrift + the six
// DEFAULT_TOLERANCES axes. W171 shipped the canonical /drift surface. W174
// adds a "Live drift indicator" card to /verify-prod so the same operator
// who just verified an artifact can ALSO see what running `kolm drift detect`
// against that artifact would look like — without leaving the verifier page.
//
// Every assertion ties one piece of rendered prose to a frozen W167 backend
// constant so the card cannot drift from the spec it is meant to document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const VERIFY = path.join(PUBLIC, 'verify-prod.html');
const SW = path.join(PUBLIC, 'sw.js');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /verify-prod exists on disk and contains the Live drift indicator section', () => {
  assert.ok(fs.existsSync(VERIFY), `verify-prod.html missing at ${VERIFY}`);
  const html = read(VERIFY);
  assert.ok(html.includes('Live drift indicator'),
    'verify-prod.html must contain the new "Live drift indicator" section heading');
});

test('2. existing verify-prod content is preserved (drop UI + 6-check grid + offline section)', () => {
  const html = read(VERIFY);
  // Original hero + drop UI
  assert.ok(html.includes('Verify any .kolm artifact, free.'),
    'original hero h1 must remain');
  assert.ok(html.includes('id="drop"'), 'drop zone DOM must remain');
  assert.ok(html.includes('id="result"'), 'result block DOM must remain');
  // Original "What gets checked" 6-card grid headings
  for (const heading of ['What gets checked', '01 . manifest', '02 . CID',
    '03 . HMAC chain', '04 . K-score', '05 . provenance', '06 . signature']) {
    assert.ok(html.includes(heading), `existing "${heading}" content removed`);
  }
  // Original verifier JS must still be wired
  assert.ok(html.includes("crypto.subtle.digest('SHA-256'"),
    'existing browser verifier JS must remain wired');
});

test('3. card surfaces all three DRIFT_STATUSES verbatim (within / drift / breach)', () => {
  const html = read(VERIFY);
  for (const status of ['within', 'drift', 'breach']) {
    assert.ok(html.includes(status),
      `verify-prod.html drift card missing status "${status}"`);
  }
});

test('4. card names every axis from DEFAULT_TOLERANCES with its warn/fail floors', () => {
  const html = read(VERIFY);
  const AXES = ['eval_score', 'k_score.composite', 'k_score.&lt;axis&gt;',
    'external_holdout_hash', 'tenant_shadow_corpus_hash', 'artifact_hash'];
  for (const a of AXES) {
    assert.ok(html.includes(a),
      `verify-prod.html drift card missing tolerance axis "${a}"`);
  }
  // Quoted warn/fail floors from src/drift-supersession.js DEFAULT_TOLERANCES.
  for (const floor of ['warn 0.02', 'fail 0.05', 'warn 0.03', 'fail 0.08',
    'warn 0.05', 'fail 0.10']) {
    assert.ok(html.includes(floor),
      `verify-prod.html drift card missing tolerance floor "${floor}"`);
  }
});

test('5. card includes the kolm drift detect CLI example with --window 7d', () => {
  const html = read(VERIFY);
  assert.ok(html.includes('kolm drift detect'),
    'verify-prod.html drift card must include `kolm drift detect` CLI command');
  assert.ok(html.includes('--window 7d'),
    'verify-prod.html drift card must include the --window 7d example flag');
  assert.ok(html.includes('--artifact'),
    'verify-prod.html drift card must include the --artifact flag');
});

test('6. card cross-links to /drift, /spec/rs-1#section-7-15, and /research/eval-set-drift', () => {
  const html = read(VERIFY);
  for (const href of ['/drift', '/spec/rs-1#section-7-15', '/research/eval-set-drift']) {
    assert.ok(html.includes(`href="${href}"`),
      `verify-prod.html drift card missing cross-link to ${href}`);
  }
});

test('7. card carries W167 (backend) and W174 (this wave) wave stamps', () => {
  const html = read(VERIFY);
  const lower = html.toLowerCase();
  assert.ok(lower.includes('wave 167'),
    'verify-prod.html drift card must cite W167 backend');
  assert.ok(lower.includes('wave 174'),
    'verify-prod.html drift card must self-stamp wave 174');
});

test('8. card reuses the existing design tokens (--mono, --ink, --bg, --accent, --warn, --bad)', () => {
  const html = read(VERIFY);
  // Token definitions must include warn + bad now (W174 extended the palette).
  assert.ok(html.includes('--warn:#f0b86b') && html.includes('--bad:#ff6b91'),
    'verify-prod.html :root must define --warn and --bad for the drift pills');
  assert.ok(html.includes('--accent-soft') && html.includes('--warn-soft') && html.includes('--bad-soft'),
    'verify-prod.html :root must define *-soft backgrounds for the drift pills');
  // Light-theme overrides for new tokens.
  assert.ok(html.includes('--warn:#b8770b') && html.includes('--bad:#c8385c'),
    'verify-prod.html [data-theme=light] must override --warn and --bad');
  // Card must consume tokens not hard-coded colors.
  for (const tok of ['var(--accent)', 'var(--warn)', 'var(--bad)',
    'var(--ink)', 'var(--mono)', 'var(--bg-elev)']) {
    assert.ok(html.includes(tok),
      `verify-prod.html drift card must consume design token ${tok}`);
  }
});

test('9. drift_report-v1 spec version + drift-snapshot-v1 are named in the sample output', () => {
  const html = read(VERIFY);
  assert.ok(html.includes('drift-snapshot-v1'),
    'verify-prod.html drift card sample output must name drift-snapshot-v1');
  assert.ok(html.includes('drift-report-v1'),
    'verify-prod.html drift card sample output must name drift-report-v1');
});

test('10. card declares pure-client-side honesty (no real /v1/drift API call)', () => {
  const html = read(VERIFY);
  // Honesty: this is a documentation surface, the browser does not call a drift API.
  assert.ok(html.toLowerCase().includes('documentation surface'),
    'verify-prod.html drift card must declare itself a documentation surface (no API call)');
});

test('11. card preserves exit-code semantics so CI can gate on breach', () => {
  const html = read(VERIFY);
  // src/drift-supersession.js detectDrift verdict 'breach' => CLI exit 2.
  assert.ok(html.includes('exit code') || html.includes('Exit code'),
    'verify-prod.html drift card must document the exit-code contract');
  assert.ok(html.includes('rollback.sh') || html.includes('|| '),
    'verify-prod.html drift card should show CI gating pattern');
});

test('12. sw.js cache wave segment is >= 174 (wave-floor regex, NOT literal slug match)', () => {
  // Hard-learned lesson from W169 test #12: pinning the literal wave slug
  // makes every later cache bump regress this test. Match the wave segment
  // as a number and assert >= 174 so future bumps are forward-compatible.
  const sw = read(SW);
  const m = sw.match(/const CACHE = 'kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, `sw.js must declare CACHE matching kolm-v7-YYYY-MM-DD-wave<N>- pattern; got first line: ${sw.split('\n')[1] || sw.split('\n')[0]}`);
  const wave = Number(m[1]);
  assert.ok(wave >= 174,
    `sw.js CACHE wave segment is ${wave}; expected >= 174 (W174 ships verify-prod drift card)`);
});
