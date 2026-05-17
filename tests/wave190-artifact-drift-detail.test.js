// Wave 190 -- per-artifact drift report detail surface at
// /artifacts/example/drift. Static template view that documents the same
// render contract every /artifacts/<hash>/drift URL lands on. Each test
// ties one piece of rendered prose to a constant in src/drift-supersession.js
// (DEFAULT_TOLERANCES + SUPERSESSION_REASONS + DRIFT_STATUSES) or to the
// W167/W171/W174/W185 surfaces this page cross-links, so the page cannot
// drift away from the backend constants it cites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const PAGE = path.join(PUBLIC, 'artifacts', 'example', 'drift.html');
const SW = path.join(PUBLIC, 'sw.js');
const VERCEL = path.join(REPO, 'vercel.json');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /artifacts/example/drift page exists and is > 18 KB', () => {
  assert.ok(fs.existsSync(PAGE), `drift.html missing at ${PAGE}`);
  const stat = fs.statSync(PAGE);
  assert.ok(stat.size > 18 * 1024,
    `drift.html too small (${stat.size} bytes; expected > 18 KB)`);
});

test('2. canonical URL is https://kolm.ai/artifacts/example/drift', () => {
  const html = read(PAGE);
  assert.match(html,
    /<link rel="canonical" href="https:\/\/kolm\.ai\/artifacts\/example\/drift"/,
    'page must declare canonical https://kolm.ai/artifacts/example/drift');
});

test('3. Wave 190 stamp present', () => {
  const html = read(PAGE);
  assert.match(html, /[Ww]ave 190/,
    'page must self-stamp as wave 190 so future waves can grep the origin');
});

test('4. all 6 DEFAULT_TOLERANCES axes named', () => {
  // Mirrors DEFAULT_TOLERANCES + axis names emitted by detectDrift() in
  // src/drift-supersession.js. The k_score_axis backend key surfaces in
  // the per-axis signal as 'k_score.<axis>' so we assert on the rendered
  // form (k_score.<axis>) rather than the backend key.
  const html = read(PAGE);
  const AXES = [
    'eval_score',
    'k_score.composite',
    'k_score.&lt;axis&gt;',
    'external_holdout_hash',
    'tenant_shadow_corpus_hash',
    'artifact_hash',
  ];
  for (const a of AXES) {
    assert.ok(html.includes(a),
      `tolerance axis "${a}" missing from page (DEFAULT_TOLERANCES contract)`);
  }
});

test('5. all 6 SUPERSESSION_REASONS named', () => {
  const html = read(PAGE);
  const REASONS = [
    'drift_detected',
    'scheduled_rebuild',
    'security_patch',
    'recipe_revision',
    'policy_change',
    'tenant_request',
  ];
  for (const r of REASONS) {
    assert.ok(html.includes(r),
      `supersession reason "${r}" missing (SUPERSESSION_REASONS contract)`);
  }
});

test('6. all 3 DRIFT_STATUSES values surface', () => {
  // DRIFT_STATUSES = ['within', 'drift', 'breach'] per src/drift-supersession.js
  const html = read(PAGE);
  for (const s of ['within', 'drift', 'breach']) {
    assert.ok(html.includes(s),
      `drift status "${s}" missing (DRIFT_STATUSES contract)`);
  }
});

test('7. example hash carries sha256: prefix and reads as fake (ellipsis padding)', () => {
  const html = read(PAGE);
  assert.match(html, /sha256:/,
    'example hash must use sha256: prefix to mirror real artifact form');
  // The hash should be clearly fake. We assert on the ellipsis-padded form
  // (sha256:abc...def) that appears throughout the table + cards so a future
  // edit that swaps in a real-looking 64-hex hash trips this lock-in.
  assert.match(html, /sha256:abc&hellip;def/,
    'example hash must be obviously fake (sha256:abc...def) per template policy');
  // And the hero hash should be a 64-char hex run starting with abc12345
  // (the obvious-padding signature) — not a real cryptographic hash.
  assert.match(html, /abc1234567890abcdef/,
    'hero hash must use obvious abc12345...abcdef padding (not real hex)');
});

test('8. honest-scope "this is a template view" framing present', () => {
  const html = read(PAGE);
  assert.match(html, /[Tt]his is a template view/,
    'page must declare itself a template view (not a live report)');
  assert.match(html, /\/artifacts\/&lt;your-artifact-hash&gt;\/drift/,
    'page must show the production URL pattern with <your-artifact-hash> placeholder');
});

test('9. cross-links to /drift (W171) + /verify-prod (W174) + /spec/rs-1 + /k-score present', () => {
  const html = read(PAGE);
  assert.match(html, /href="\/drift"/,
    'page must cross-link to /drift (W171 generic lifecycle page)');
  assert.match(html, /href="\/verify-prod"/,
    'page must cross-link to /verify-prod (W174 upload page)');
  assert.match(html, /href="\/spec\/rs-1/,
    'page must cross-link to /spec/rs-1 (canonical spec)');
  assert.match(html, /href="\/k-score"/,
    'page must cross-link to /k-score (axes reference)');
});

test('10. both CLI commands surface: kolm distill --reuse-seeds + kolm compile --supersession-of', () => {
  const html = read(PAGE);
  assert.match(html, /kolm distill --reuse-seeds/,
    'drift-band next-action card must show kolm distill --reuse-seeds');
  assert.match(html, /kolm compile --supersession-of/,
    'breach-band next-action card must show kolm compile --supersession-of');
});

test('11. verifier checks #23 and #24 cited', () => {
  const html = read(PAGE);
  assert.match(html, /#23/,
    'page must cite verifier check #23 (Supersession chain)');
  assert.match(html, /#24/,
    'page must cite verifier check #24 (Drift report)');
});

test('12. light-theme switch IIFE in <head> BEFORE body styles', () => {
  const html = read(PAGE);
  // Find the position of the theme-switch IIFE and the <body> tag; assert
  // the IIFE comes first. This is the pre-paint guard so light-mode users
  // do not see a dark flash.
  const iifeIdx = html.indexOf("localStorage.getItem('kolm-theme')");
  const bodyIdx = html.indexOf('<body');
  assert.ok(iifeIdx > 0, 'theme-switch IIFE must be present (kolm-theme localStorage)');
  assert.ok(iifeIdx < bodyIdx,
    'theme-switch IIFE must come BEFORE <body> in document order (pre-paint)');
});

test('13. design tokens --accent + --warn + --bad present', () => {
  const html = read(PAGE);
  assert.match(html, /--accent:#10b981/,
    'design token --accent:#10b981 must match /drift token set');
  assert.match(html, /--warn:#f0b86b/,
    'design token --warn:#f0b86b must match /drift token set');
  assert.match(html, /--bad:#ff6b91/,
    'design token --bad:#ff6b91 must match /drift token set');
});

test('14. sw.js CACHE wave segment is >= 190 (wave-floor regex; never literal match)', () => {
  const sw = read(SW);
  // Pattern: const CACHE = 'kolm-vN-YYYY-MM-DD-waveNNN-...'
  // Lock-in tests for monotonically-increasing values MUST use >= comparison,
  // not equality, to avoid the known regression trap (W169 test #12 originally
  // asserted literal wave169 and broke on every subsequent cache bump).
  const match = sw.match(/kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(match,
    'sw.js must declare const CACHE with kolm-v7-YYYY-MM-DD-waveNNN- slug');
  const wave = Number(match[1]);
  assert.ok(wave >= 190,
    `sw.js CACHE wave segment must be >= 190 (found wave${wave})`);
});

test('15. no em-dashes (U+2014) or &mdash; entities in load-bearing copy', () => {
  const html = read(PAGE);
  // Whole-page scan; the page is W190 net-new so no historical &mdash;
  // exemption is needed.
  assert.ok(!html.includes('—'),
    'page must not contain the em-dash glyph U+2014 in any copy');
  assert.ok(!html.includes('&mdash;'),
    'page must not contain the &mdash; HTML entity in any copy');
});

test('16. 14-node receipt chain present (matches W171 /drift order)', () => {
  // The receipt chain order is frozen at /drift wave 171: spec, seeds,
  // split, train, recipes, evals, external_holdout, tenant_shadow,
  // auditor_attestation, supersession, drift_report, export, signatures,
  // rekor. We assert every node label appears in the receipt-chain block.
  const html = read(PAGE);
  const chainMatch = html.match(/<div class="receipt-chain">([\s\S]*?)<\/div>/);
  assert.ok(chainMatch, 'page must contain a .receipt-chain block');
  const chain = chainMatch[1];
  const NODES = [
    'spec', 'seeds', 'split', 'train', 'recipes', 'evals',
    'external_holdout', 'tenant_shadow', 'auditor_attestation',
    'supersession', 'drift_report', 'export', 'signatures', 'rekor',
  ];
  for (const n of NODES) {
    assert.ok(chain.includes(n),
      `receipt-chain block missing node "${n}" (14-node chain contract)`);
  }
});

test('17. recipe-class neutral (mentions all four classes; no class-specific assumption)', () => {
  // The drift detail page applies to every recipe class. We assert the page
  // explicitly says so (names all four RECIPE_CLASSES values) so a future
  // edit that accidentally restricts the page to one class trips this test.
  const html = read(PAGE);
  for (const cls of ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model']) {
    assert.ok(html.includes(cls),
      `page must name recipe class "${cls}" (recipe-class neutrality contract)`);
  }
});

test('18. vercel rewrite /artifacts/(.*)/drift -> /artifacts/example/drift.html present', () => {
  // The static template ships at public/artifacts/example/drift.html; the
  // rewrite lets every /artifacts/<hash>/drift URL land on the same render.
  // If a future wave removes the rewrite, only the literal /artifacts/example/drift
  // URL resolves and the lock-in fires.
  const vercel = read(VERCEL);
  assert.match(vercel,
    /"source":\s*"\/artifacts\/\(\.\*\)\/drift",\s*"destination":\s*"\/artifacts\/example\/drift\.html"/,
    'vercel.json must rewrite /artifacts/(.*)/drift to /artifacts/example/drift.html');
});
