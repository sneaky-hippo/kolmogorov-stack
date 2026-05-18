// W273 - pricing tiers restructure.
//
// Outside audit gap: missing mid-market tiers between Free and Enterprise.
// This wave restructures public/pricing.html into a five-tier grid
// (Free / Starter / Team / Business / Enterprise) and adds:
//   - a usage-based credits row (post-cap pricing)
//   - a client-side ROI calculator widget
//   - a "currently doing $X/mo on OpenAI" comparison strip
//
// Tests assert behavior, not byte-exact copy:
//   - five tier cards exist, each with data-tier="<slug>"
//   - ROI calculator script attached (window-scoped fn or inline IIFE)
//   - usage-based credits row present
//   - existing data-w260 markers still present (W260 #9, #11 regression lock)
//   - canonical link intact
//   - sw.js cache wave-floor >= 273

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

const PRICING = fs.readFileSync(path.join(PUBLIC, 'pricing.html'), 'utf8');
const SW = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

// =====================================================================
// Tier cards: all five present with data-tier markers
// =====================================================================

test('W273 #1 - tier card data-tier="free" exists', () => {
  assert.match(PRICING, /data-tier="free"/,
    'pricing.html must contain a tier card with data-tier="free"');
});

test('W273 #2 - tier card data-tier="starter" exists', () => {
  assert.match(PRICING, /data-tier="starter"/,
    'pricing.html must contain a tier card with data-tier="starter"');
});

test('W273 #3 - tier card data-tier="team" exists', () => {
  assert.match(PRICING, /data-tier="team"/,
    'pricing.html must contain a tier card with data-tier="team"');
});

test('W273 #4 - tier card data-tier="business" exists', () => {
  assert.match(PRICING, /data-tier="business"/,
    'pricing.html must contain a tier card with data-tier="business"');
});

test('W273 #5 - tier card data-tier="enterprise" exists', () => {
  assert.match(PRICING, /data-tier="enterprise"/,
    'pricing.html must contain a tier card with data-tier="enterprise"');
});

test('W273 #6 - all 5 data-tier markers present in expected order (Free, Starter, Team, Business, Enterprise)', () => {
  // Behavior: the primary grid must order the five tiers cheapest-to-priciest.
  // We index-of each marker and assert strict monotonic ordering.
  const order = ['free', 'starter', 'team', 'business', 'enterprise'];
  const positions = order.map((slug) =>
    PRICING.indexOf(`data-tier="${slug}"`)
  );
  for (let i = 0; i < positions.length; i++) {
    assert.ok(positions[i] > 0, `data-tier="${order[i]}" must appear in pricing.html`);
  }
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1],
      `data-tier="${order[i]}" must appear after data-tier="${order[i - 1]}"`);
  }
});

// =====================================================================
// Tier specifics: enforce the per-tier inputs from the W273 brief.
// =====================================================================

test('W273 #7 - Free tier names 100 compiles / 1k captures / 1 GB / community support', () => {
  const m = PRICING.match(/data-tier="free"[\s\S]{0,2000}/);
  assert.ok(m, 'free tier block must be findable');
  const block = m[0];
  assert.match(block, /\b100\b/, 'Free tier must name 100 compiles');
  assert.match(block, /\b1k\b/i, 'Free tier must name 1k captures');
  assert.match(block, /1\s*GB/i, 'Free tier must name 1 GB storage');
  assert.match(block, /community/i, 'Free tier must name community support');
});

test('W273 #8 - Starter tier names $9, 1k compiles, 10k captures, 10 GB, email support', () => {
  const m = PRICING.match(/data-tier="starter"[\s\S]{0,2000}/);
  assert.ok(m, 'starter tier block must be findable');
  const block = m[0];
  assert.match(block, /\$9\b/, 'Starter tier must name $9');
  assert.match(block, /\b1k\b/i, 'Starter tier must name 1k compiles');
  assert.match(block, /\b10k\b/i, 'Starter tier must name 10k captures');
  assert.match(block, /10\s*GB/i, 'Starter tier must name 10 GB storage');
  assert.match(block, /email/i, 'Starter tier must name email support');
});

test('W273 #9 - Team tier names $99, 10k compiles, 100k captures, 100 GB, 5 seats, SSO', () => {
  const m = PRICING.match(/data-tier="team"[\s\S]{0,2500}/);
  assert.ok(m, 'team tier block must be findable');
  const block = m[0];
  assert.match(block, /\$99\b/, 'Team tier must name $99');
  assert.match(block, /\b10k\b/i, 'Team tier must name 10k compiles');
  assert.match(block, /\b100k\b/i, 'Team tier must name 100k captures');
  assert.match(block, /100\s*GB/i, 'Team tier must name 100 GB storage');
  assert.match(block, /\b5\b[\s\S]{0,60}seats?/i, 'Team tier must name 5 seats');
  assert.match(block, /SSO/, 'Team tier must name SSO');
});

test('W273 #10 - Business tier names $999, 100k compiles, 1M captures, 1 TB, 25 seats, SAML, BAA', () => {
  const m = PRICING.match(/data-tier="business"[\s\S]{0,2500}/);
  assert.ok(m, 'business tier block must be findable');
  const block = m[0];
  assert.match(block, /\$999\b/, 'Business tier must name $999');
  assert.match(block, /\b100k\b/i, 'Business tier must name 100k compiles');
  assert.match(block, /\b1M\b/i, 'Business tier must name 1M captures');
  assert.match(block, /1\s*TB/i, 'Business tier must name 1 TB storage');
  assert.match(block, /\b25\b[\s\S]{0,60}seats?/i, 'Business tier must name 25 seats');
  assert.match(block, /SAML/, 'Business tier must name SAML');
  assert.match(block, /BAA/, 'Business tier must name BAA');
});

test('W273 #11 - Enterprise tier names Custom, unlimited, on-prem/air-gap, BAA, dedicated CSM', () => {
  const m = PRICING.match(/data-tier="enterprise"[\s\S]{0,2500}/);
  assert.ok(m, 'enterprise tier block must be findable');
  const block = m[0];
  assert.match(block, /Custom|custom/, 'Enterprise tier must name Custom pricing');
  assert.match(block, /unlimited/i, 'Enterprise tier must name unlimited');
  assert.match(block, /on-prem|air-gap|self-hosted/i,
    'Enterprise tier must name on-prem or air-gap or self-hosted');
  assert.match(block, /BAA/, 'Enterprise tier must name BAA');
  assert.match(block, /CSM|white[- ]glove/i,
    'Enterprise tier must name CSM or white-glove onboarding');
});

// =====================================================================
// ROI calculator + OpenAI-vs strip + usage credits
// =====================================================================

test('W273 #12 - ROI calculator widget is present (data-w273="roi-calculator")', () => {
  assert.match(PRICING, /data-w273="roi-calculator"/,
    'pricing.html must contain a div marked data-w273="roi-calculator"');
});

test('W273 #13 - ROI calculator script attached (window.kolmROI OR inline IIFE)', () => {
  // The calculator must wire its inputs. Accept either a window-scoped
  // function (window.kolmROI = ...) or an inline IIFE (function(){...})()
  // referencing the W273 input ids.
  const roiBlock = PRICING.match(/data-w273="roi-calculator"[\s\S]{0,12000}/);
  assert.ok(roiBlock, 'roi-calculator block must be findable');
  const block = roiBlock[0];
  const exposesWindow = /window\.kolmROI\s*=/.test(block);
  const hasIife = /\(function\s*\(\s*\)\s*\{[\s\S]*?\}\)\s*\(\s*\)/.test(block);
  assert.ok(exposesWindow || hasIife,
    'ROI calculator must expose window.kolmROI OR be wrapped in an inline IIFE');
  // And it must reference at least one of the W273 input ids so we know
  // it actually wires to the inputs above.
  assert.match(block, /w273-compiles|w273-perprompt|w273-prompts|w273-churn/,
    'ROI calculator script must reference at least one w273-* input id');
});

test('W273 #14 - ROI calculator inputs cover compiles/mo, cost/prompt, churn savings', () => {
  // The W273 brief requires three input axes minimum.
  assert.match(PRICING, /id=["']w273-compiles["']/i, 'ROI must have a compiles/mo input');
  assert.match(PRICING, /id=["']w273-perprompt["']/i, 'ROI must have an avg cost/prompt input');
  assert.match(PRICING, /id=["']w273-churn["']/i, 'ROI must have a churn savings input');
});

test('W273 #15 - ROI calculator outputs cover monthly savings and payback months', () => {
  assert.match(PRICING, /id=["']w273-savings["']/i, 'ROI must surface a monthly savings output node');
  assert.match(PRICING, /id=["']w273-payback["']/i, 'ROI must surface a payback months output node');
});

test('W273 #16 - "currently doing $X/mo on OpenAI" comparison strip exists', () => {
  assert.match(PRICING, /data-w273="openai-vs"/,
    'pricing.html must contain a data-w273="openai-vs" comparison strip');
  // And the strip must literally name OpenAI in the surfaced copy.
  const m = PRICING.match(/data-w273="openai-vs"[\s\S]{0,2000}/);
  assert.ok(m, 'openai-vs block must be findable');
  assert.match(m[0], /OpenAI/, 'openai-vs strip must name OpenAI');
});

test('W273 #17 - usage-based credits row present with $0.001/compile and $0.0001/capture', () => {
  assert.match(PRICING, /data-w273="usage-credits"/,
    'pricing.html must contain a data-w273="usage-credits" row');
  const m = PRICING.match(/data-w273="usage-credits"[\s\S]{0,2000}/);
  assert.ok(m, 'usage-credits block must be findable');
  const block = m[0];
  assert.match(block, /\$0\.001\b/, 'usage-credits row must name $0.001 / compile');
  assert.match(block, /\$0\.0001\b/, 'usage-credits row must name $0.0001 / capture');
});

// =====================================================================
// Preservation: existing W260 markers + JSON-LD + canonical
// =====================================================================

test('W273 #18 - W260 marker data-w260="three-tier" still present (no regression)', () => {
  assert.match(PRICING, /data-w260="three-tier"/,
    'W260 three-tier marker must remain after W273 restructure');
});

test('W273 #19 - W260 marker data-w260="enterprise-baa" still present (no regression)', () => {
  assert.match(PRICING, /data-w260="enterprise-baa"/,
    'W260 enterprise-baa marker must remain after W273 restructure');
});

test('W273 #20 - canonical link intact', () => {
  assert.match(PRICING, /<link\s+rel=["']canonical["']\s+href=["']https:\/\/kolm\.ai\/pricing["']\s*\/?>/i,
    'canonical link to https://kolm.ai/pricing must remain');
});

test('W273 #21 - JSON-LD Product block preserved (Offers array intact)', () => {
  // Behavior: the application/ld+json Product schema must still exist with
  // at least one Offer object. We do not pin the exact Offer set so the
  // schema can be updated separately; we just enforce existence.
  assert.match(PRICING, /<script\s+type=["']application\/ld\+json["']/i,
    'JSON-LD <script> block must remain');
  assert.match(PRICING, /"@type"\s*:\s*"Product"/,
    'Product schema must remain');
  assert.match(PRICING, /"offers"\s*:\s*\[/,
    'offers array must remain in JSON-LD');
});

test('W273 #22 - JSON-LD FAQPage block preserved', () => {
  assert.match(PRICING, /"@type"\s*:\s*"FAQPage"/,
    'FAQPage schema must remain in JSON-LD');
});

test('W273 #23 - JSON-LD BreadcrumbList block preserved', () => {
  assert.match(PRICING, /"@type"\s*:\s*"BreadcrumbList"/,
    'BreadcrumbList schema must remain in JSON-LD');
});

test('W273 #24 - brand-anchor span preserved (W228 anchor / W273 instruction)', () => {
  assert.match(PRICING, /class=["']brand-anchor["']/,
    'brand-anchor span must remain (do-not-strip per W273 brief)');
});

// =====================================================================
// sw.js cache slug wave-floor
// =====================================================================

test('W273 #25 - sw.js CACHE slug wave-floor >= 273', () => {
  const m = SW.match(/const\s+CACHE\s*=\s*'kolm-v7-2026-05-\d+-wave(\d+)-([a-z0-9-]+)'/);
  assert.ok(m, 'CACHE slug must follow kolm-v7-YYYY-MM-DD-waveN-slug pattern');
  const waveN = parseInt(m[1], 10);
  assert.ok(waveN >= 273, `sw.js wave-slug must be >= 273 (saw ${waveN})`);
});

// =====================================================================
// Em-dash budget: must not increase em-dash count
// =====================================================================

test('W273 #26 - em-dash budget on pricing.html <= 7 (W205 / W260 lock preserved)', () => {
  const raw = (PRICING.match(/—/g) || []).length;
  const ent = (PRICING.match(/&mdash;/g) || []).length;
  const total = raw + ent;
  assert.ok(total <= 7,
    `pricing.html em-dash count ${total} > W205 / W260 budget 7`);
});
