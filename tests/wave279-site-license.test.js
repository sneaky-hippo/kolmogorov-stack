// W279 — BYO air-gap enterprise compiler site-license tier behavior tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SITE_LICENSE_TIERS,
  getSiteLicenseTier,
  approximateQuote,
  listTierIds,
} from '../src/site-license.js';

test('W279 SITE_LICENSE_TIERS frozen and contains the four canonical tiers', () => {
  assert.ok(Array.isArray(SITE_LICENSE_TIERS));
  assert.ok(Object.isFrozen(SITE_LICENSE_TIERS));
  const ids = SITE_LICENSE_TIERS.map(t => t.id);
  for (const id of ['compiler-only', 'compiler-plus-training', 'compiler-plus-everything-sla', 'defense']) {
    assert.ok(ids.includes(id), `missing tier: ${id}`);
  }
});

test('W279 every tier has a price_band of [lo, hi] within $250K – $2.5M', () => {
  for (const t of SITE_LICENSE_TIERS) {
    assert.ok(Array.isArray(t.price_band_usd_annual));
    assert.equal(t.price_band_usd_annual.length, 2);
    const [lo, hi] = t.price_band_usd_annual;
    assert.ok(lo >= 250_000, `${t.id} lo must be >= 250K, got ${lo}`);
    assert.ok(hi <= 2_500_000, `${t.id} hi must be <= 2.5M, got ${hi}`);
    assert.ok(hi > lo, `${t.id} hi must be > lo`);
  }
});

test('W279 every tier carries deployment + support_sla + compliance_supports', () => {
  for (const t of SITE_LICENSE_TIERS) {
    assert.ok(typeof t.deployment === 'string' && t.deployment.length > 10);
    assert.ok(typeof t.support_sla === 'string' && t.support_sla.length > 5);
    assert.ok(Array.isArray(t.compliance_supports) && t.compliance_supports.length > 0);
  }
});

test('W279 every tier included list is non-empty and frozen', () => {
  for (const t of SITE_LICENSE_TIERS) {
    assert.ok(Array.isArray(t.included));
    assert.ok(t.included.length >= 3, `${t.id} should include >= 3 items, got ${t.included.length}`);
    assert.ok(Object.isFrozen(t.included));
  }
});

test('W279 getSiteLicenseTier resolves by id and returns null for unknown', () => {
  assert.equal(getSiteLicenseTier('compiler-only').id, 'compiler-only');
  assert.equal(getSiteLicenseTier('does-not-exist'), null);
  assert.equal(getSiteLicenseTier(null), null);
});

test('W279 approximateQuote stays inside the band for any seat count', () => {
  for (const seats of [0, 1, 100, 500, 2500, 10_000]) {
    const q = approximateQuote('compiler-only', { seats });
    assert.ok(q.estimate_usd_annual >= q.band_low);
    assert.ok(q.estimate_usd_annual <= q.band_high);
  }
});

test('W279 approximateQuote scales monotonically with seats', () => {
  const a = approximateQuote('compiler-plus-training', { seats: 50 });
  const b = approximateQuote('compiler-plus-training', { seats: 1000 });
  const c = approximateQuote('compiler-plus-training', { seats: 5000 });
  assert.ok(a.estimate_usd_annual <= b.estimate_usd_annual);
  assert.ok(b.estimate_usd_annual <= c.estimate_usd_annual);
});

test('W279 approximateQuote returns null for unknown tier', () => {
  assert.equal(approximateQuote('nope'), null);
});

test('W279 defense tier compliance_supports includes CMMC L3 + DFARS 7012 + ITAR', () => {
  const t = getSiteLicenseTier('defense');
  assert.ok(t.compliance_supports.includes('CMMC L3'));
  assert.ok(t.compliance_supports.includes('DFARS 7012'));
  assert.ok(t.compliance_supports.includes('ITAR'));
});

test('W279 listTierIds enumerates the four ids', () => {
  const ids = listTierIds();
  assert.equal(ids.length, 4);
  assert.deepEqual(ids.sort(), ['compiler-only', 'compiler-plus-everything-sla', 'compiler-plus-training', 'defense']);
});
