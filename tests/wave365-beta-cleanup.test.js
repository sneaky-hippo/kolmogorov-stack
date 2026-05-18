// Wave 365 — beta-tag + KMS-sentinel cleanup on shipped public surfaces.
//
// Behavior tests:
//   1. public/airgap.html eyebrow no longer says "beta".
//   2. public/byoc.html eyebrow no longer says "beta".
//   3. public/tunnels.html eyebrow no longer says "beta".
//   4. public/audit-log.html meta description no longer says "beta".
//   5. public/community.html description + card no longer say "Joining beta".
//   6. public/integrations.html no longer marks the CI integration as "beta".
//   7. public/security.html uses 'awaiting_operator_hook' (W365 KMS sentinel
//      rename) and no longer says 'not_yet_wired'.
//   8. cli/kolm.js help text + UI no longer says NOT YET WIRED for either the
//      networked teacher path (W362) or the KMS api_status (W365).
//   9. src/keys.js exports KMS_API_STATUS_AWAITING_HOOK (new) and the legacy
//      KMS_API_STATUS_NOT_WIRED alias remains for back-compat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function readPublic(file) {
  return fs.readFileSync(path.join(PUBLIC, file), 'utf8');
}

test('W365 #1 — airgap eyebrow drops the beta tag', () => {
  const src = readPublic('airgap.html');
  // The full eyebrow line must not say beta anymore.
  const matches = src.match(/class="eyebrow"[^>]*>([^<]+)/g) || [];
  for (const m of matches) {
    assert.doesNotMatch(m, /\bbeta\b/i, `eyebrow still says beta: ${m}`);
  }
});

test('W365 #2 — byoc eyebrow drops the beta tag', () => {
  const src = readPublic('byoc.html');
  const matches = src.match(/class="eyebrow"[^>]*>([\s\S]*?)<\/div>/g) || [];
  for (const m of matches) {
    assert.doesNotMatch(m, /\bbeta\b/i, `eyebrow still says beta: ${m}`);
  }
});

test('W365 #3 — tunnels eyebrow drops the beta tag', () => {
  const src = readPublic('tunnels.html');
  const matches = src.match(/class="eyebrow"[^>]*>([\s\S]*?)<\/div>/g) || [];
  for (const m of matches) {
    assert.doesNotMatch(m, /\bbeta\b/i, `eyebrow still says beta: ${m}`);
  }
});

test('W365 #4 — audit-log meta description no longer says beta', () => {
  const src = readPublic('audit-log.html');
  const desc = src.match(/<meta name="description" content="([^"]+)"/);
  assert.ok(desc, 'meta description must exist');
  assert.doesNotMatch(desc[1], /\bbeta\b/i, `meta description still says beta: ${desc[1]}`);
  const og = src.match(/<meta property="og:description" content="([^"]+)"/);
  assert.ok(og, 'og:description must exist');
  assert.doesNotMatch(og[1], /\bbeta\b/i, `og:description still says beta: ${og[1]}`);
});

test('W365 #5 — community page drops "Joining beta" + meta beta', () => {
  const src = readPublic('community.html');
  assert.doesNotMatch(src, /Joining beta/i, 'community still says "Joining beta"');
  const desc = src.match(/<meta name="description" content="([^"]+)"/);
  assert.ok(desc);
  assert.doesNotMatch(desc[1], /\(beta invite\)/i, 'meta still says beta invite');
});

test('W365 #6 — integrations stops marking the CI row as beta', () => {
  const src = readPublic('integrations.html');
  // The class-styled "beta" pill must be gone from the integration cards.
  const cards = src.match(/<div class="ig">[\s\S]*?<\/div>\s*<\/div>/g) || [];
  let hasBetaPill = false;
  for (const c of cards) {
    if (/class="stat\s+beta">beta</.test(c)) hasBetaPill = true;
  }
  assert.equal(hasBetaPill, false, 'integration card still has a beta pill');
});

test('W365 #7 — security.html uses awaiting_operator_hook, not not_yet_wired', () => {
  const src = readPublic('security.html');
  assert.doesNotMatch(src, /not_yet_wired/);
  assert.match(src, /awaiting_operator_hook/);
});

test('W365 #8 — cli/kolm.js help/UI no longer says NOT YET WIRED', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.doesNotMatch(src, /NOT YET WIRED/);
  // The runtime branch that printed "networked teacher path is NOT YET WIRED"
  // must be replaced by a description of the fallback behavior.
  assert.doesNotMatch(src, /networked teacher path is NOT YET WIRED/i);
  assert.doesNotMatch(src, /'not_yet_wired'/);
});

test('W365 #9 — src/keys.js exports KMS_API_STATUS_AWAITING_HOOK with back-compat alias', async () => {
  const mod = await import('../src/keys.js');
  assert.equal(typeof mod.KMS_API_STATUS_AWAITING_HOOK, 'string');
  assert.equal(mod.KMS_API_STATUS_AWAITING_HOOK, 'awaiting_operator_hook');
  // Back-compat alias must still resolve to the same string so callers that
  // imported the old name keep working.
  assert.equal(mod.KMS_API_STATUS_NOT_WIRED, mod.KMS_API_STATUS_AWAITING_HOOK);
});
