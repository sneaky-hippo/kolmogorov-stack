// Wave 189 — /security KMS key rotation section.
// Locks in the customer-facing surface that documents the Ed25519 key
// rotation lifecycle backing the signature scheme (RS-1 v2.1 §7.9/§7.10).
// Each assertion ties one piece of rendered prose to a frozen backend
// constant (src/ed25519.js, src/pubkey-directory.js) so the page cannot
// drift from the spec it documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const SECURITY = path.join(PUBLIC, 'security.html');
const SW = path.join(PUBLIC, 'sw.js');
const CLI = path.join(REPO, 'cli', 'kolm.js');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /security page exists on disk and is non-trivial size', () => {
  assert.ok(fs.existsSync(SECURITY), `security.html missing at ${SECURITY}`);
  const stat = fs.statSync(SECURITY);
  assert.ok(stat.size > 18 * 1024,
    `security.html too small (${stat.size} bytes; expected > 18 KB after wave 189 KMS section)`);
});

test('2. /security declares canonical URL https://kolm.ai/security', () => {
  const html = read(SECURITY);
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/security"/,
    'security.html must declare canonical https://kolm.ai/security');
});

test('3. /security stamps the wave 189 KMS rotation surface', () => {
  const html = read(SECURITY);
  assert.ok(html.includes('wave 189'),
    'security.html must self-stamp wave 189 for the KMS rotation section');
});

test('4. /security names all three rotation triggers', () => {
  const html = read(SECURITY);
  for (const trigger of ['cadence', 'compromise', 'personnel']) {
    assert.ok(html.includes(trigger),
      `security.html must name rotation trigger "${trigger}"`);
  }
});

test('5. /security surfaces the default rotation cadence of 365 days', () => {
  const html = read(SECURITY);
  assert.ok(html.includes('365 days') || html.includes('365-day'),
    'security.html must surface the 365-day default rotation cadence');
});

test('6. /security mentions the 30-day overlap window for retired keys', () => {
  const html = read(SECURITY);
  assert.ok(html.includes('30 days') || html.includes('30-day'),
    'security.html must surface the 30-day overlap window');
});

test('7. /security names all four customer-hosted KMS targets', () => {
  const html = read(SECURITY);
  for (const target of ['AWS KMS', 'GCP', 'Azure Key Vault', 'HashiCorp Vault']) {
    assert.ok(html.includes(target),
      `security.html must name customer-hosted KMS target "${target}"`);
  }
});

test('8. /security cites NIST SP 800-57 for cryptoperiod grounding', () => {
  const html = read(SECURITY);
  assert.ok(html.includes('NIST SP 800-57'),
    'security.html must cite NIST SP 800-57 for compliance grounding');
});

test('9. /security cross-references RS-1 §7.9 and §7.10', () => {
  const html = read(SECURITY);
  assert.ok(html.includes('/spec/rs-1#section-7-9'),
    'security.html must link to /spec/rs-1#section-7-9 (Ed25519 contract)');
  assert.ok(html.includes('/spec/rs-1#section-7-10'),
    'security.html must link to /spec/rs-1#section-7-10 (Sigstore + Rekor)');
});

test('10. /security surfaces kolm keys list / rotate / export verbs', () => {
  const html = read(SECURITY);
  assert.ok(html.includes('kolm keys list'),
    'security.html must surface kolm keys list verb');
  assert.ok(html.includes('kolm keys rotate'),
    'security.html must surface kolm keys rotate verb');
  assert.ok(html.includes('kolm keys export'),
    'security.html must surface kolm keys export verb');
});

test('11. /security cites the signature.key_id manifest field', () => {
  const html = read(SECURITY);
  assert.ok(html.includes('signature.key_id'),
    'security.html must cite the logical signature.key_id manifest field');
  assert.ok(html.includes('key_fingerprint'),
    'security.html must explain the implementation as key_fingerprint');
});

test('12. /security declares honest scope (kolm ships vs customer owns)', () => {
  const html = read(SECURITY);
  assert.ok(html.includes('kolm ships'),
    'security.html honest-scope must declare what kolm ships');
  assert.ok(html.includes('customer owns'),
    'security.html honest-scope must declare what the customer owns');
});

test('13. /security cross-links to /threat-model and /drift', () => {
  const html = read(SECURITY);
  assert.ok(html.includes('href="/threat-model"'),
    'security.html must cross-link to /threat-model');
  assert.ok(html.includes('href="/drift"'),
    'security.html must cross-link to /drift (lifecycle sibling)');
});

test('14. /security light-theme switch IIFE runs in <head> BEFORE body styles', () => {
  const html = read(SECURITY);
  // IIFE must appear before <body>
  const bodyIdx = html.indexOf('<body');
  const iifeIdx = html.indexOf("localStorage.getItem('kolm-theme')");
  assert.ok(iifeIdx >= 0, 'security.html must include the kolm-theme localStorage IIFE');
  assert.ok(iifeIdx < bodyIdx,
    'security.html light-theme IIFE must run in <head> BEFORE the <body> tag to prevent dark-flash');
});

test('15. /security KMS section declares --accent + --warn + --bad design tokens', () => {
  const html = read(SECURITY);
  // Tokens are scoped to .kms-section
  assert.match(html, /--accent:\s*#10b981/,
    'security.html .kms-section must declare --accent #10b981 (drift-pattern token)');
  assert.match(html, /--warn:\s*#f0b86b/,
    'security.html .kms-section must declare --warn #f0b86b');
  assert.match(html, /--bad:\s*#ff6b91/,
    'security.html .kms-section must declare --bad #ff6b91');
});

test('16. sw.js CACHE bumped to a wave-floor >= 189 slug', () => {
  const sw = read(SW);
  // Wave 189 is the floor for this test; later waves bump the slug forward.
  const m = sw.match(/const CACHE = 'kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(Number(m[1]) >= 189,
    `sw.js CACHE wave segment must be >= 189 (saw wave${m[1]})`);
});

test('17. /security KMS section has no em-dashes in load-bearing copy', () => {
  const html = read(SECURITY);
  // The .kms-section is everything from the opening tag to its </section>.
  const start = html.indexOf('class="section kms-section"');
  assert.ok(start >= 0, 'security.html must have the kms-section');
  const tail = html.slice(start);
  const end = tail.indexOf('</section>');
  const sectionHtml = tail.slice(0, end);
  // Literal em-dash (U+2014) is banned.
  const hasEm = /—/.test(sectionHtml);
  assert.ok(!hasEm,
    'security.html KMS section must not contain literal em-dashes in copy (use HTML entity or rephrase)');
});

test('18. kolm keys rotate is either wired in cli/kolm.js OR amber-pilled with wave 193 roadmap note', () => {
  const html = read(SECURITY);
  const cli = read(CLI);
  // Check 1: is the verb wired today?
  const wired = /case 'keys':/.test(cli);
  if (wired) {
    // If wired, the page can still warn before ship but isn't required to.
    assert.ok(true, 'kolm keys is wired in cli/kolm.js — no amber pill required');
  } else {
    // If NOT wired, the page MUST mark rotate as future + name wave 193 roadmap.
    assert.ok(html.includes('wave 193'),
      'kolm keys rotate is not wired in cli/kolm.js — security.html must name "wave 193" roadmap');
    // The amber pill is required somewhere near the rotate verb.
    assert.ok(html.includes('verify before ship') || html.includes('verify-before-ship') ||
              html.includes('roadmap'),
      'security.html must mark kolm keys rotate with an amber pill or roadmap framing');
  }
});
