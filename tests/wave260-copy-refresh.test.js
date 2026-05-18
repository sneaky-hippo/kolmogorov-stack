// W260 — copy refresh on the four high-traffic surfaces.
//
// Lands the "Stop renting intelligence" thesis on the homepage, lifts
// the v0.2 verb names (moe compose / tokenize / extract / doc check)
// into the homepage v0.2 strip, adds the conceptual three-tier framing
// (Free / Starter $9 / Teams + Enterprise) and a BAA + self-hosted note
// to /pricing, lands the posture summary (HIPAA + BAA + GDPR Art 28 DPA
// + SCCs live today; Halborn April 2026; SOC 2 Type I targeted Q3 2026;
// bug bounty $500 to $10k) on /security, and adds the "External AI infra
// review, May 2026 — 8.4 / 10, category-king potential" callout on
// /enterprise.
//
// Tests assert behavior:
//   - the four new content blocks are present (grep, not byte-exact)
//   - none of the existing W212-W256 anchors disappeared
//   - title suffix still " · kolm.ai" on each page
//   - sw.js CACHE bumped to wave260 (wave-floor >= 260)
//   - em-dash budgets per page held (index<=1, pricing<=7, enterprise<=1)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const PRICING = fs.readFileSync(path.join(PUBLIC, 'pricing.html'), 'utf8');
const SECURITY = fs.readFileSync(path.join(PUBLIC, 'security.html'), 'utf8');
const ENTERPRISE = fs.readFileSync(path.join(PUBLIC, 'enterprise.html'), 'utf8');
const SW = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

function countEmdash(html) {
  const raw = (html.match(/—/g) || []).length;
  const ent = (html.match(/&mdash;/g) || []).length;
  return raw + ent;
}

// =====================================================================
// index.html — hero thesis + v0.2 verb-name lift
// =====================================================================

test('W260 #1 - index.html hero adds "Stop renting intelligence" framing', () => {
  // Behavior assertion: the thesis line is present somewhere in the hero
  // region (first 4KB after H1) and names the two halves of the framing.
  const heroIdx = INDEX.search(/<h1[\s>]/i);
  assert.ok(heroIdx >= 0, 'hero H1 must exist');
  const HERO = INDEX.slice(heroIdx, heroIdx + 4000);
  assert.match(HERO, /Compile your own AI/i,
    'hero must include "Compile your own AI" framing');
  assert.match(HERO, /Stop renting intelligence/i,
    'hero must include "Stop renting intelligence" framing');
});

test('W260 #2 - index.html hero names broad buyer outcomes (W334: PHI/privileged/KYC vertical pile-up dropped)', () => {
  // W334 dropped the PHI/privileged/KYC niche pile-up from the home hero;
  // those vertical targets now live on /healthcare, /legal, /finance.
  // The home hero must still surface buyer outcomes (own + audit + hardware
  // control); that framing carries the rent-vs-own narrative without the
  // vertical naming.
  const heroIdx = INDEX.search(/<h1[\s>]/i);
  const HERO = INDEX.slice(heroIdx, heroIdx + 4000);
  assert.match(HERO, /hardware you control/i, 'hero must name hardware control as a buyer outcome');
  assert.match(HERO, /weights on disk you own/i, 'hero must name ownership of weights as a buyer outcome');
  assert.match(HERO, /receipt for every inference/i, 'hero must name receipt-per-inference as a buyer outcome');
});

test('W260 #3 - index.html keeps the W220 Capture/Compile/Ship/Audit lede beats', () => {
  // Regression assertion: the W220 4-beat lede must still be present.
  const heroIdx = INDEX.search(/<h1[\s>]/i);
  const HERO = INDEX.slice(heroIdx, heroIdx + 4000);
  assert.match(HERO, /Capture your real prompts/i, 'lede capture beat preserved');
  assert.match(HERO, /Compile them into your own model/i, 'lede compile beat preserved');
  assert.match(HERO, /Ship it on/i, 'lede ship beat preserved');
  assert.match(HERO, /Audit every call/i, 'lede audit beat preserved');
});

test('W260 #4 - index.html v0.2 strip names all four CLI verbs', () => {
  // The v0.2 section must list moe compose, tokenize, extract, doc check.
  assert.match(INDEX, /kolm moe compose/, 'v0.2 strip names moe compose');
  assert.match(INDEX, /kolm tokenize/, 'v0.2 strip names tokenize');
  assert.match(INDEX, /kolm extract/, 'v0.2 strip names extract');
  assert.match(INDEX, /kolm doc check/, 'v0.2 strip names doc check');
});

test('W260 #5 - index.html v0.2 strip carries the v0.2 framing (header + heading)', () => {
  assert.match(INDEX, /What ships in v0\.2 today\./,
    'v0.2 section heading preserved');
  assert.match(INDEX, /aria-label="what ships in v0\.2"/,
    'v0.2 section aria-label preserved');
});

test('W260 #6 - index.html keeps phi-redactor.kolm as the concrete artifact proof (W220 anchor)', () => {
  const heroIdx = INDEX.search(/<h1[\s>]/i);
  const HERO = INDEX.slice(heroIdx, heroIdx + 4000);
  assert.match(HERO, /phi-redactor\.kolm/, 'phi-redactor.kolm must remain as proof artifact');
});

test('W260 #7 - index.html "AI compiler" category claim still in first 3KB body (W220 anchor)', () => {
  const bodyMatch = INDEX.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  assert.ok(bodyMatch, 'body present');
  const above = bodyMatch[1].slice(0, 3000);
  assert.match(above, /the AI compiler/i,
    'AI compiler category claim must remain in first 3 KB of body');
});

test('W260 #8 - index.html em-dash budget <= 1 (W220 / W205 lock)', () => {
  assert.ok(countEmdash(INDEX) <= 1,
    `index.html em-dash count ${countEmdash(INDEX)} > budget 1`);
});

// =====================================================================
// pricing.html — three-tier framing + BAA / self-hosted note
// =====================================================================

test('W260 #9 - pricing.html surfaces the three-tier framing (Free / Starter / Teams+Enterprise)', () => {
  // The conceptual three-tier callout must enumerate all three positions.
  assert.match(PRICING, /data-w260="three-tier"/,
    'three-tier summary block must be present');
  assert.match(PRICING, /Three ways to use kolm/i,
    'three-tier summary must have a heading');
  assert.match(PRICING, /\$9\s*\/\s*mo/,
    'three-tier summary must price Starter at $9/mo');
});

test('W260 #10 - pricing.html three-tier summary names CLI + runtime as free', () => {
  // The Free tier must say CLI + runtime are free with MIT / Apache-2.0.
  const m = PRICING.match(/data-w260="three-tier"[\s\S]{0,2000}/);
  assert.ok(m, 'three-tier block must be findable');
  const block = m[0];
  assert.match(block, /local CLI \+ runtime/i,
    'Free tier line must name "local CLI + runtime"');
  assert.match(block, /MIT|Apache/i,
    'Free tier line must name the open-source license');
});

test('W260 #11 - pricing.html Enterprise tier card adds the BAA + self-hosted note', () => {
  assert.match(PRICING, /data-w260="enterprise-baa"/,
    'enterprise tier must carry the W260 BAA marker');
  // The Enterprise tier pitch must surface BAA + self-hosted in the pitch text.
  const m = PRICING.match(/data-w260="enterprise-baa"[\s\S]{0,1200}/);
  assert.ok(m, 'enterprise tier block must be findable');
  const block = m[0];
  assert.match(block, /BAA/, 'Enterprise tier must name BAA');
  assert.match(block, /self-hosted/i, 'Enterprise tier must name self-hosted option');
});

test('W260 #12 - pricing.html keeps existing six-tier grid (Developer/Pro/Business/Enterprise/Starter/Teams)', () => {
  // Regression: the existing tier names must still be present.
  for (const tier of ['Developer', 'Pro', 'Business', 'Enterprise', 'Starter', 'Teams']) {
    const re = new RegExp(`<div class="tag"[^>]*>${tier}</div>`);
    assert.match(PRICING, re, `${tier} tier card must remain`);
  }
});

test('W260 #13 - pricing.html title still ends with " · kolm.ai" (W228 anchor)', () => {
  const m = PRICING.match(/<title>([^<]*)<\/title>/i);
  assert.ok(m, 'title present');
  assert.match(m[1].trim(), /[·|]\s*kolm\.ai\s*$/i,
    'pricing.html title must end with " · kolm.ai"');
});

test('W260 #14 - pricing.html em-dash budget <= 7 (W205 lock)', () => {
  assert.ok(countEmdash(PRICING) <= 7,
    `pricing.html em-dash count ${countEmdash(PRICING)} > budget 7`);
});

// =====================================================================
// security.html — posture summary (HIPAA / BAA / GDPR Art 28 / SCCs /
// Halborn April 2026 / SOC 2 Type I Q3 2026 / bug bounty $500-$10k)
// =====================================================================

test('W260 #15 - security.html lands the posture summary block', () => {
  assert.match(SECURITY, /data-w260="posture-summary"/,
    'posture summary block must be present');
});

test('W260 #16 - security.html posture summary names HIPAA + BAA + GDPR Art 28 + SCCs as live', () => {
  const m = SECURITY.match(/data-w260="posture-summary"[\s\S]{0,2500}/);
  assert.ok(m, 'posture summary block must be findable');
  const block = m[0];
  assert.match(block, /HIPAA Security Rule mapping/i, 'block names HIPAA mapping');
  assert.match(block, /BAA/, 'block names BAA');
  assert.match(block, /GDPR Article 28/i, 'block names GDPR Article 28');
  assert.match(block, /SCC/i, 'block names SCCs');
  assert.match(block, /live today/i, 'block calls these out as live today');
});

test('W260 #17 - security.html posture summary cites Halborn April 2026 completion', () => {
  const m = SECURITY.match(/data-w260="posture-summary"[\s\S]{0,2500}/);
  assert.ok(m, 'posture summary block must be findable');
  const block = m[0];
  assert.match(block, /Halborn/, 'block names Halborn');
  assert.match(block, /April 2026|2026-04/i, 'block names April 2026 completion date');
});

test('W260 #18 - security.html posture summary marks SOC 2 Type I as Q3 2026 target (not held)', () => {
  const m = SECURITY.match(/data-w260="posture-summary"[\s\S]{0,2500}/);
  assert.ok(m, 'posture summary block must be findable');
  const block = m[0];
  assert.match(block, /SOC 2 Type I/, 'block names SOC 2 Type I');
  assert.match(block, /Q3 2026/, 'block names Q3 2026 target');
  assert.match(block, /target|not.*held|not.*attestation/i,
    'block must say target, not held attestation');
});

test('W260 #19 - security.html posture summary names bug bounty $500 to $10k', () => {
  const m = SECURITY.match(/data-w260="posture-summary"[\s\S]{0,2500}/);
  assert.ok(m, 'posture summary block must be findable');
  const block = m[0];
  assert.match(block, /Bug bounty/i, 'block names bug bounty');
  assert.match(block, /\$500/, 'block names $500 floor');
  assert.match(block, /\$10[,.]?000|\$10k/i, 'block names $10k ceiling');
});

test('W260 #20 - security.html title still ends with " · kolm.ai" (W228 anchor)', () => {
  const m = SECURITY.match(/<title>([^<]*)<\/title>/i);
  assert.ok(m, 'title present');
  assert.match(m[1].trim(), /[·|]\s*kolm\.ai\s*$/i,
    'security.html title must end with " · kolm.ai"');
});

// =====================================================================
// enterprise.html — external-review callout (8.4/10, category-king)
// =====================================================================

test('W260 #21 - enterprise.html lands the external review callout block', () => {
  assert.match(ENTERPRISE, /data-w260="external-review"/,
    'external review callout block must be present');
});

test('W260 #22 - enterprise.html external review quotes "8.4 / 10" and "category-king"', () => {
  const m = ENTERPRISE.match(/data-w260="external-review"[\s\S]{0,1500}/);
  assert.ok(m, 'external review block must be findable');
  const block = m[0];
  assert.match(block, /8\.4\s*\/\s*10/, 'block must quote "8.4 / 10"');
  assert.match(block, /[Cc]ategory.king/i, 'block must quote "category-king"');
});

test('W260 #23 - enterprise.html external review attributed as "External AI infra review, May 2026"', () => {
  const m = ENTERPRISE.match(/data-w260="external-review"[\s\S]{0,1500}/);
  assert.ok(m, 'external review block must be findable');
  const block = m[0];
  assert.match(block, /External AI infra review/i,
    'block must attribute as External AI infra review');
  assert.match(block, /May 2026/i,
    'block must attribute as May 2026');
});

test('W260 #24 - enterprise.html keeps the W220 / W228 anchors (live demo + BAA link)', () => {
  // Regression: live demo + BAA link should remain.
  assert.match(ENTERPRISE, /live demo &middot; team-private publish/i,
    'live demo eyebrow preserved');
  assert.match(ENTERPRISE, /href="\/baa"/, 'BAA link preserved');
  assert.match(ENTERPRISE, /\/articles\/kolm-ai-vs-kolm-therapeutics/,
    'W228 brand-disambig link preserved');
});

test('W260 #25 - enterprise.html title still ends with " · kolm.ai" (W228 anchor)', () => {
  const m = ENTERPRISE.match(/<title>([^<]*)<\/title>/i);
  assert.ok(m, 'title present');
  assert.match(m[1].trim(), /[·|]\s*kolm\.ai\s*$/i,
    'enterprise.html title must end with " · kolm.ai"');
});

test('W260 #26 - enterprise.html em-dash budget <= 1 (W205 lock)', () => {
  assert.ok(countEmdash(ENTERPRISE) <= 1,
    `enterprise.html em-dash count ${countEmdash(ENTERPRISE)} > budget 1`);
});

// =====================================================================
// sw.js cache slug bump
// =====================================================================

test('W260 #27 - sw.js CACHE slug bumped to wave-floor >= 260', () => {
  // Wave-floor lock-in: we assert the cache slug has moved past 260 so
  // the new HTML pushes through. Slug name is not pinned because later
  // waves are allowed to bump the slug for their own reasons; we only
  // require the cache key to have moved.
  const m = SW.match(/const\s+CACHE\s*=\s*'kolm-v7-2026-05-\d+-wave(\d+)-([a-z0-9-]+)'/);
  assert.ok(m, 'CACHE slug must follow kolm-v7-YYYY-MM-DD-waveN-slug pattern');
  const waveN = parseInt(m[1], 10);
  assert.ok(waveN >= 260, `sw.js wave-slug must be >= 260 (saw ${waveN})`);
});

// =====================================================================
// Cross-page invariant: every page still kolm.ai-suffixed and has a body
// (W228 lock; cheap belt-and-suspenders inside the W260 suite).
// =====================================================================

test('W260 #28 - first 1200 body chars of all 4 pages contain "kolm.ai" (W228 anchor)', () => {
  for (const [name, html] of [
    ['index.html', INDEX],
    ['pricing.html', PRICING],
    ['security.html', SECURITY],
    ['enterprise.html', ENTERPRISE],
  ]) {
    const bodyOpen = html.search(/<body[^>]*>/i);
    assert.ok(bodyOpen >= 0, `${name}: <body> must exist`);
    const head = html.slice(bodyOpen, bodyOpen + 1200);
    assert.match(head, /kolm\.ai/, `${name}: "kolm.ai" must appear in first 1200 body chars`);
  }
});
