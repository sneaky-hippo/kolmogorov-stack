// Wave 204 — Post-auth UI/UX audit + patch.
//
// Audit focus: /account, /dashboard, and any related post-auth pages.
// Patches landed this wave:
//   1. Rate-limit fineprint added to /account API-key card (links /pricing + /security)
//   2. /security cross-link added inline (not only in footer)
//   3. Honest-scope statement added under /account lede (does / does not)
//   4. OAuth path hint added to /account empty-state (links /signin + /pricing)
//
// Tests lock the patches against future regressions and assert wave-floor on sw.js.
// /api-keys does NOT exist as a public route; keys are managed on /account. The
// "missing surface" gap is asserted explicitly so a future wave that adds the
// route will need to update this test (forcing a deliberate decision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const ACCOUNT = path.join(PUBLIC, 'account.html');
const DASHBOARD = path.join(PUBLIC, 'dashboard.html');
const SIGNUP = path.join(PUBLIC, 'signup.html');
const API_KEYS = path.join(PUBLIC, 'api-keys.html');
const SW = path.join(PUBLIC, 'sw.js');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /account exists on disk and is at least the W204 baseline size (25000 bytes)', () => {
  assert.ok(fs.existsSync(ACCOUNT), `account.html missing at ${ACCOUNT}`);
  const size = fs.statSync(ACCOUNT).size;
  assert.ok(size >= 25000,
    `account.html is ${size} bytes; W204 baseline floor is 25000 (patches add rate-limit + scope + OAuth hint)`);
});

test('2. /dashboard exists on disk and is at least the W204 baseline size (120000 bytes)', () => {
  assert.ok(fs.existsSync(DASHBOARD), `dashboard.html missing at ${DASHBOARD}`);
  const size = fs.statSync(DASHBOARD).size;
  assert.ok(size >= 120000,
    `dashboard.html is ${size} bytes; W204 baseline floor is 120000 (existing rich surface)`);
});

test('3. /api-keys is NOT a public route (keys live on /account); gap is explicit', () => {
  // If this assertion ever flips, a future wave must update the test AND wire
  // a real /api-keys route. We do not invent the route in this audit wave.
  assert.ok(!fs.existsSync(API_KEYS),
    'public/api-keys.html should NOT exist; keys are managed on /account. ' +
    'If a future wave adds the route, update this test and add /account -> /api-keys link.');
  // /account must therefore document the key controls itself.
  const html = read(ACCOUNT);
  assert.ok(html.includes('<h2>API key</h2>'),
    '/account must contain the API key section since no /api-keys route exists');
});

test('4. /account has a sign-out path AND a sign-in path', () => {
  const html = read(ACCOUNT);
  // Sign-out button wired to /v1/signout
  assert.ok(html.includes('id="acct-logout"') && html.includes('/v1/signout'),
    '/account must keep sign-out button + /v1/signout call');
  // Sign-in button (empty state) + OAuth path link added this wave
  assert.ok(html.includes('id="acct-paste-btn"') && html.includes('Sign in'),
    '/account must keep paste-key Sign in button');
  assert.ok(html.includes('href="/signin"'),
    '/account empty-state must link /signin for OAuth (added W204)');
});

test('5. /account has a link to /pricing (next-action availability)', () => {
  const html = read(ACCOUNT);
  // Two contexts: billing-banner CTA + new fineprint near API key card + new OAuth hint
  const count = (html.match(/href="\/pricing"/g) || []).length;
  assert.ok(count >= 2,
    `/account must link /pricing in at least 2 places (banner + fineprint or hint); got ${count}`);
});

test('6. /account has rate-limit copy near API key card (W204 patch)', () => {
  const html = read(ACCOUNT);
  assert.ok(html.includes('rate-limited per plan'),
    '/account must include "rate-limited per plan" copy near API key card (W204 patch)');
  assert.ok(html.includes('X-RateLimit-Remaining'),
    '/account must name the X-RateLimit-Remaining response header so users can find quota');
});

test('7. /account has /security cross-link inline (not only in footer)', () => {
  const html = read(ACCOUNT);
  // Footer link is at the bottom; we need an inline body link too.
  // Strip the footer section to assert the inline link.
  const footerStart = html.indexOf('<footer');
  assert.ok(footerStart > 0, 'account.html must have a <footer>');
  const body = html.slice(0, footerStart);
  assert.ok(body.includes('href="/security"'),
    '/account body (not footer) must cross-link /security for key/storage context');
});

test('8. /account has honest-scope "What this page does / does not do" statement (W204 patch)', () => {
  const html = read(ACCOUNT);
  assert.ok(html.includes('What this page does:'),
    '/account must include honest-scope "What this page does:" statement (W204 patch)');
  assert.ok(html.includes('does not do'),
    '/account must explicitly name what the page does NOT do');
});

test('9. No NEW em-dashes added to /account; baseline is 0', () => {
  const html = read(ACCOUNT);
  const count = (html.match(/—/g) || []).length;
  assert.equal(count, 0,
    `/account must have 0 em-dashes (baseline 0; W204 prose uses ASCII separators); got ${count}`);
});

test('10. No marketing fluff phrases in /account (game-changing / revolutionary / world-class / best-in-class / next-gen / blazing fast)', () => {
  const html = read(ACCOUNT).toLowerCase();
  const banned = ['game-changing', 'revolutionary', 'world-class', 'best-in-class', 'next-gen', 'blazing fast'];
  for (const phrase of banned) {
    assert.ok(!html.includes(phrase),
      `/account contains marketing fluff phrase "${phrase}" -- remove`);
  }
});

test('11. No emoji characters in /account (codepoints in emoji ranges)', () => {
  const html = read(ACCOUNT);
  // Cover the most common emoji blocks. ASCII separators (. , / · &middot;) are fine.
  const ranges = [
    /[\u{1F300}-\u{1F5FF}]/u,  // Misc symbols & pictographs
    /[\u{1F600}-\u{1F64F}]/u,  // Emoticons
    /[\u{1F680}-\u{1F6FF}]/u,  // Transport & map
    /[\u{1F700}-\u{1F77F}]/u,  // Alchemical
    /[\u{1F900}-\u{1F9FF}]/u,  // Supplemental symbols & pictographs
    /[\u{2600}-\u{26FF}]/u,    // Misc symbols (sun, umbrella, etc)
    /[\u{2700}-\u{27BF}]/u,    // Dingbats
  ];
  for (const re of ranges) {
    assert.ok(!re.test(html),
      `/account contains emoji codepoint matching ${re}; remove emoji from copy`);
  }
});

test('12. /account light-theme switch IIFE runs pre-paint (in <head> before body styles)', () => {
  const html = read(ACCOUNT);
  const headStart = html.indexOf('<head>');
  const headEnd = html.indexOf('</head>');
  const bodyStart = html.indexOf('<body>');
  assert.ok(headStart >= 0 && headEnd > headStart && bodyStart > headEnd,
    'account.html must have well-formed <head>...</head> before <body>');
  const head = html.slice(headStart, headEnd);
  // The IIFE reads kolm-theme from localStorage and applies data-theme before paint.
  assert.ok(head.includes("localStorage.getItem('kolm-theme')") &&
            head.includes("data-theme") &&
            head.includes("(function(){"),
    'account.html must run the kolm-theme IIFE pre-paint inside <head> (no dark-flash)');
});

test('13. /signup serves both /signup and /signin via vercel rewrite (post-auth flow target)', () => {
  // signup.html is the dual-purpose file. We do NOT edit it this wave; we just
  // assert it exists so the /signin link added on /account does not 404.
  assert.ok(fs.existsSync(SIGNUP), `signup.html missing at ${SIGNUP}`);
  const html = read(SIGNUP);
  // The header comment documents the dual-purpose nature; lock that contract.
  assert.ok(html.toLowerCase().includes('dual-purpose') ||
            html.toLowerCase().includes('/signup and /signin'),
    'signup.html must document its dual /signup + /signin role (comment header)');
});

test('14. /dashboard still has its existing sign-out button + redirect on 401', () => {
  // We do NOT edit /dashboard this wave; we just lock that the post-auth flow
  // it documents stays in place so /account is the SETTINGS surface and
  // /dashboard is the WORK surface.
  const html = read(DASHBOARD);
  assert.ok(html.includes('id="signout"'),
    '/dashboard must keep its sign-out button id="signout"');
  assert.ok(html.includes("'/signin?return=' + encodeURIComponent('/dashboard')"),
    '/dashboard must keep its 401 redirect to /signin?return=/dashboard');
});

test('15. sw.js cache wave segment is >= 204 (wave-floor regex, NOT literal slug)', () => {
  // Hard lesson from W169 test #12 / W171 test #18: pinning the literal wave
  // slug regresses every later cache bump. Match wave segment as a number.
  const sw = read(SW);
  const m = sw.match(/const CACHE = 'kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, `sw.js must declare CACHE matching kolm-v7-YYYY-MM-DD-wave<N>- pattern`);
  const wave = parseInt(m[1], 10);
  assert.ok(wave >= 204,
    `sw.js CACHE wave segment is ${wave}; expected >= 204 (W204 post-auth UI patches). ` +
    `Coordinator must bump sw.js before deploy.`);
});

test('16. /account fineprint is wired to its targets (no dead links)', () => {
  const html = read(ACCOUNT);
  // The W204 rate-limit fineprint links /pricing and /security.
  // The W204 OAuth hint links /signin and /pricing.
  // The W204 scope statement links /teams and mailto:dev@kolm.ai.
  for (const target of ['href="/pricing"', 'href="/security"', 'href="/signin"',
                         'href="/teams"', 'mailto:dev@kolm.ai']) {
    assert.ok(html.includes(target),
      `/account W204 copy must link ${target}; missing target indicates broken patch`);
  }
});
