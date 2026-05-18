// W267 - free Pro tier for non-profits / academics.
//
// Lands /nonprofits as a landing page with a 5-field application form
// (name + email + institution + tax-id-or-equivalent + research-focus).
// Submit is intercepted client-side and shows a toast; no real POST.
// Adds a small callout strip at the top of /pricing linking to it.
// Both surfaces carry stable data-* markers so a parallel W273 pricing
// rewrite can preserve them.
//
// Tests assert behavior (not byte-exact copy):
//   1. /nonprofits exists with the right canonical and title suffix
//   2. brand-anchor span present (W228 invariant)
//   3. who-qualifies section enumerates the 4 buckets
//   4. what-you-get section names the headline limits
//   5. form has the 5 required fields with correct types
//   6. submit handler calls preventDefault and shows toast
//   7. no real POST to /v1 in the page script
//   8. /pricing carries the data-w267 strip linking to /nonprofits
//   9. vercel.json rewrites /nonprofits to /nonprofits.html
//  10. sw.js CACHE bumped to wave-floor >= 267

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

const NPP_PATH = path.join(PUBLIC, 'nonprofits.html');
const PRICING_PATH = path.join(PUBLIC, 'pricing.html');
const SW_PATH = path.join(PUBLIC, 'sw.js');
const VERCEL_PATH = path.join(REPO, 'vercel.json');

const NPP = fs.readFileSync(NPP_PATH, 'utf8');
const PRICING = fs.readFileSync(PRICING_PATH, 'utf8');
const SW = fs.readFileSync(SW_PATH, 'utf8');
const VERCEL = JSON.parse(fs.readFileSync(VERCEL_PATH, 'utf8'));

// =====================================================================
// /nonprofits page basics
// =====================================================================

test('W267 #1 - /nonprofits page file exists and has substantive body', () => {
  assert.ok(fs.existsSync(NPP_PATH), 'public/nonprofits.html must exist');
  assert.ok(NPP.length > 4000, `page must be substantive (got ${NPP.length} bytes)`);
});

test('W267 #2 - <title> ends with " · kolm.ai" (W228 invariant)', () => {
  const m = NPP.match(/<title>([^<]*)<\/title>/i);
  assert.ok(m, 'must have a <title>');
  assert.match(m[1].trim(), /[·|]\s*kolm\.ai\s*$/i,
    `title "${m[1]}" must end with " · kolm.ai"`);
});

test('W267 #3 - canonical points to https://kolm.ai/nonprofits', () => {
  assert.match(NPP, /<link\s+rel=["']canonical["']\s+href=["']https:\/\/kolm\.ai\/nonprofits["']/i,
    'canonical must be /nonprofits');
});

test('W267 #4 - brand-anchor span present (W228 invariant)', () => {
  assert.match(NPP, /class=["']brand-anchor["']/,
    'page must carry the brand-anchor span (kolm.ai vs Kolm therapeutics disambig)');
  assert.match(NPP, /Not Kolm therapeutics/i,
    'brand-anchor must name the disambig targets');
});

test('W267 #5 - first 1200 chars of body contain "kolm.ai" (W228 invariant)', () => {
  const bodyIdx = NPP.search(/<body[^>]*>/i);
  assert.ok(bodyIdx >= 0, 'must have <body>');
  const head = NPP.slice(bodyIdx, bodyIdx + 1200);
  assert.match(head, /kolm\.ai/, 'first 1200 chars of body must name kolm.ai');
});

// =====================================================================
// Content sections
// =====================================================================

test('W267 #6 - hero names "Free Pro" and "non-profits and academia"', () => {
  assert.match(NPP, /Free Pro/i, 'hero must name Free Pro');
  assert.match(NPP, /non-profits and academia/i, 'hero must name non-profits and academia');
});

test('W267 #7 - who-qualifies enumerates the 4 buckets', () => {
  assert.match(NPP, /501\(c\)\(3\)/, 'must name 501(c)(3)');
  assert.match(NPP, /EU/i, 'must name EU equivalents');
  assert.match(NPP, /accredited universit/i, 'must name accredited universities');
  assert.match(NPP, /academic/i, 'must name academic institutions');
  assert.match(NPP, /student researcher/i, 'must name verified student researchers');
});

test('W267 #8 - what-you-get names the headline limits and Pro features', () => {
  assert.match(NPP, /100k/i, 'must name 100k compiles/mo');
  assert.match(NPP, /compile/i, 'must name compile units');
  assert.match(NPP, /10k/i, 'must name 10k captures/mo');
  assert.match(NPP, /capture/i, 'must name captures');
  assert.match(NPP, /priority support/i, 'must name priority support');
});

// =====================================================================
// Form: 5 required fields
// =====================================================================

test('W267 #9 - form has 5 required input/textarea fields', () => {
  const form = (NPP.match(/<form[\s\S]*?<\/form>/i) || [''])[0];
  assert.ok(form.length > 0, 'must have a <form>');

  // name + email + institution + tax_id + research_focus
  assert.match(form, /name=["']name["']/, 'must have name field');
  assert.match(form, /name=["']email["']/, 'must have email field');
  assert.match(form, /name=["']institution["']/, 'must have institution field');
  assert.match(form, /name=["']tax_id["']/, 'must have tax_id field');
  assert.match(form, /name=["']research_focus["']/, 'must have research_focus field');
});

test('W267 #10 - email field has type="email"', () => {
  const form = NPP.match(/<form[\s\S]*?<\/form>/i)[0];
  assert.match(form,
    /<input[^>]*name=["']email["'][^>]*type=["']email["']|<input[^>]*type=["']email["'][^>]*name=["']email["']/,
    'email field must use type="email"');
});

test('W267 #11 - research_focus is a textarea (not a single-line input)', () => {
  const form = NPP.match(/<form[\s\S]*?<\/form>/i)[0];
  assert.match(form, /<textarea[^>]*name=["']research_focus["']/,
    'research_focus must be a <textarea>');
});

test('W267 #12 - all 5 fields are marked required', () => {
  const form = NPP.match(/<form[\s\S]*?<\/form>/i)[0];
  const requiredAttrs = (form.match(/\brequired\b/g) || []).length;
  assert.ok(requiredAttrs >= 5,
    `expected >=5 "required" attributes, found ${requiredAttrs}`);
});

test('W267 #13 - submit button exists with type="submit"', () => {
  const form = NPP.match(/<form[\s\S]*?<\/form>/i)[0];
  assert.match(form, /<button[^>]*type=["']submit["']/,
    'must have submit button');
});

// =====================================================================
// Submit handler: client-side intercept, toast, no real POST
// =====================================================================

test('W267 #14 - script intercepts submit with preventDefault', () => {
  assert.match(NPP, /addEventListener\(['"]submit['"]/,
    'must register submit handler');
  assert.match(NPP, /preventDefault\(\)/,
    'submit handler must call preventDefault');
});

test('W267 #15 - submit handler shows toast (no real network call)', () => {
  // toast element exists and the success message is queued from the script
  assert.match(NPP, /id=["']np-toast["']/, 'toast element must exist');
  assert.match(NPP, /Application received/i, 'toast copy must include success message');
  assert.match(NPP, /48 hours/i, 'toast must promise 48-hour follow-up');
});

test('W267 #16 - no real POST to /v1 or any backend in the form script', () => {
  // The form must NOT call fetch(/v1/...) or XMLHttpRequest or any
  // submission endpoint. Search the whole page (script lives inline).
  assert.doesNotMatch(NPP, /fetch\(['"`]\/v1\//,
    'page must not call /v1/* (client-side only)');
  assert.doesNotMatch(NPP, /XMLHttpRequest/,
    'page must not use XMLHttpRequest');
  // No <form action=...> targeting a real endpoint.
  const form = NPP.match(/<form[\s\S]*?<\/form>/i)[0];
  assert.doesNotMatch(form, /<form[^>]+action=/i,
    'form must not have an action attribute (no real submission)');
});

// =====================================================================
// /pricing callout strip
// =====================================================================

test('W267 #17 - /pricing carries the data-w267 strip at the top of <main>', () => {
  assert.match(PRICING, /data-w267=["']nonprofits-strip["']/,
    'pricing.html must carry the data-w267 marker so W273 merge can preserve it');
});

test('W267 #18 - the W267 strip on /pricing links to /nonprofits', () => {
  const m = PRICING.match(/data-w267=["']nonprofits-strip["'][\s\S]{0,1200}/);
  assert.ok(m, 'must locate the W267 strip block');
  assert.match(m[0], /href=["']\/nonprofits["']/,
    'the strip must link to /nonprofits');
});

test('W267 #19 - the W267 strip is the FIRST block inside <main> on /pricing', () => {
  // The W267 strip must appear before the hero section so a parallel
  // W273 pricing rewrite (which is expected to restructure the hero +
  // tier grid) can either preserve or move it without conflict.
  const mainIdx = PRICING.search(/<main[^>]*id=["']main["'][^>]*>/i);
  assert.ok(mainIdx >= 0, '<main id="main"> must exist on pricing.html');
  const stripIdx = PRICING.indexOf('data-w267="nonprofits-strip"');
  const heroIdx = PRICING.indexOf('class="hero"', mainIdx);
  assert.ok(stripIdx > mainIdx, 'strip must be inside <main>');
  if (heroIdx >= 0) {
    assert.ok(stripIdx < heroIdx,
      'strip must precede the hero section (so W273 merge has stable insertion anchor)');
  }
});

// =====================================================================
// Wiring: vercel.json + sw.js
// =====================================================================

test('W267 #20 - vercel.json has /nonprofits rewrite to /nonprofits.html', () => {
  const rw = VERCEL.rewrites.find((r) => r.source === '/nonprofits');
  assert.ok(rw, 'vercel.json must have a /nonprofits rewrite');
  assert.equal(rw.destination, '/nonprofits.html',
    '/nonprofits must rewrite to /nonprofits.html');
});

test('W267 #21 - sw.js CACHE bumped to wave-floor >= 267', () => {
  const m = SW.match(/const\s+CACHE\s*=\s*['"]kolm-v\d+-\d{4}-\d{2}-\d{2}-wave(\d+)/);
  assert.ok(m, 'sw.js CACHE constant must follow the wave naming convention');
  const waveNum = Number(m[1]);
  assert.ok(waveNum >= 267,
    `sw.js wave segment must be >= 267 (found wave${waveNum})`);
});

// =====================================================================
// Content hygiene
// =====================================================================

test('W267 #22 - no em-dash characters in body copy', () => {
  // Em-dash drift guard (W210 / W220 / W245 invariant): the page must
  // not introduce literal em-dashes or &mdash; entities into body copy.
  const raw = (NPP.match(/—/g) || []).length;
  const ent = (NPP.match(/&mdash;/g) || []).length;
  assert.equal(raw + ent, 0,
    `em-dash budget exceeded: ${raw} literal + ${ent} entity`);
});

test('W267 #23 - footer disambig link to /articles/kolm-ai-vs-kolm-therapeutics present (W228)', () => {
  assert.match(NPP, /href=["']\/articles\/kolm-ai-vs-kolm-therapeutics["']/,
    'footer must link to the disambig article (W228 invariant)');
});
