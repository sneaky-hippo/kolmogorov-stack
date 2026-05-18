// W278 - Standards play: RS-1 flagship + free kolm verify CLI surface.
// Behavior assertions on the shipped HTML + vercel.json + sw.js floor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const readPublic = (p) => fs.readFileSync(path.join(ROOT, 'public', p), 'utf8');
const readRoot   = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('W278 /spec/rs-1 declares Apache-2.0 open standard', () => {
  const html = readPublic('spec/rs-1.html');
  assert.match(html, /Apache-2\.0/, 'spec must name Apache-2.0 license');
  // The banner says "open standard"
  assert.match(html, /open standard/i, 'banner must call RS-1 an open standard');
});

test('W278 /spec/rs-1 has a How to participate section', () => {
  const html = readPublic('spec/rs-1.html');
  assert.match(html, /How to participate/, 'How to participate heading required');
  // Linux Foundation pattern + RFC + mailing list + change log signals
  assert.match(html, /RFC process/i, 'RFC process must be named');
  assert.match(html, /[Mm]ailing list/, 'mailing list must be named');
  assert.match(html, /[Cc]hange log/, 'change log must be named');
});

test('W278 /spec/rs-1 has a Standards-Body Status section', () => {
  const html = readPublic('spec/rs-1.html');
  assert.match(html, /Standards-Body Status/, 'Standards-Body Status heading required');
  // Candidate venues for formal standardization
  assert.match(html, /IETF/, 'IETF candidate venue must be named');
  assert.match(html, /W3C/, 'W3C candidate venue must be named');
});

test('W278 /spec/rs-1 has v2.1 current callout pointing at /spec/changelog', () => {
  const html = readPublic('spec/rs-1.html');
  assert.match(html, /v2\.1 current/i, 'v2.1 current callout required');
  assert.match(html, /\/spec\/changelog/, 'callout links to /spec/changelog');
});

test('W278 /spec/rs-1 banner links to /verify-cli and GitHub', () => {
  const html = readPublic('spec/rs-1.html');
  assert.match(html, /\/verify-cli/, 'banner links to /verify-cli');
  assert.match(html, /github\.com\/sneaky-hippo\/kolmogorov-stack/, 'banner links to GitHub source');
});

test('W278 /verify-cli has curl-install snippet', () => {
  const html = readPublic('verify-cli.html');
  assert.match(html, /curl -fsSL https:\/\/kolm\.ai\/install\/verify \| sh/, 'curl install snippet required');
});

test('W278 /verify-cli has docker-run snippet', () => {
  const html = readPublic('verify-cli.html');
  assert.match(html, /docker run /, 'docker-run snippet required');
  assert.match(html, /kolm\/verify/, 'docker image must be kolm/verify');
});

test('W278 /verify-cli enumerates the four verifier checks', () => {
  const html = readPublic('verify-cli.html');
  assert.match(html, /[Ss]ignature chain/, 'signature chain check');
  assert.match(html, /[Mm]anifest schema/, 'manifest schema check');
  assert.match(html, /[Ff]rozen-eval hash/i, 'frozen-eval hash check');
  assert.match(html, /K-score recomputation/, 'K-score recomputation check');
});

test('W278 /verify-cli is no-login, no-telemetry, Apache-2.0', () => {
  const html = readPublic('verify-cli.html');
  assert.match(html, /[Nn]o login/, 'no login messaging required');
  assert.match(html, /[Nn]o telemetry/, 'no telemetry messaging required');
  assert.match(html, /Apache-2\.0/, 'Apache-2.0 license stamp required');
});

test('W278 /verify-cli has canonical URL', () => {
  const html = readPublic('verify-cli.html');
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/verify-cli"/);
});

test('W278 /spec/changelog lists v1.0 with frozen date 2026-01-15', () => {
  const html = readPublic('spec/changelog.html');
  assert.match(html, /v1\.0/, 'v1.0 must appear');
  assert.match(html, /2026-01-15/, 'v1.0 freeze date required');
});

test('W278 /spec/changelog lists v1.1 with drift block summary', () => {
  const html = readPublic('spec/changelog.html');
  assert.match(html, /v1\.1/, 'v1.1 must appear');
  assert.match(html, /drift block/i, 'v1.1 theme = drift block');
});

test('W278 /spec/changelog lists v2.0 with supersession + teacher-fidelity', () => {
  const html = readPublic('spec/changelog.html');
  assert.match(html, /v2\.0/, 'v2.0 must appear');
  assert.match(html, /supersession/i, 'v2.0 supersession theme');
  assert.match(html, /teacher-fidelity|teacher fidelity/i, 'v2.0 teacher-fidelity theme');
});

test('W278 /spec/changelog lists v2.1 with k-score-2 axes', () => {
  const html = readPublic('spec/changelog.html');
  assert.match(html, /v2\.1/, 'v2.1 must appear');
  assert.match(html, /k-score-2 axes|K-score-2 axes/, 'v2.1 k-score-2 axes theme');
});

test('W278 /spec/changelog provides diff links per version', () => {
  const html = readPublic('spec/changelog.html');
  // Each non-initial version should link to a compare URL on GitHub
  assert.match(html, /github\.com\/sneaky-hippo\/kolmogorov-stack\/compare\/spec-v1\.0\.\.\.spec-v1\.1/);
  assert.match(html, /github\.com\/sneaky-hippo\/kolmogorov-stack\/compare\/spec-v1\.1\.\.\.spec-v2\.0/);
  assert.match(html, /github\.com\/sneaky-hippo\/kolmogorov-stack\/compare\/spec-v2\.0\.\.\.spec-v2\.1/);
});

test('W278 /spec/changelog has canonical URL', () => {
  const html = readPublic('spec/changelog.html');
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/spec\/changelog"/);
});

test('W278 vercel.json rewrites /verify-cli to /verify-cli.html', () => {
  const vj = JSON.parse(readRoot('vercel.json'));
  const rewrites = vj.rewrites || [];
  const hit = rewrites.find(r => r.source === '/verify-cli');
  assert.ok(hit, '/verify-cli rewrite missing');
  assert.equal(hit.destination, '/verify-cli.html');
});

test('W278 vercel.json rewrites /spec/changelog to /spec/changelog.html', () => {
  const vj = JSON.parse(readRoot('vercel.json'));
  const rewrites = vj.rewrites || [];
  const hit = rewrites.find(r => r.source === '/spec/changelog');
  assert.ok(hit, '/spec/changelog rewrite missing');
  assert.equal(hit.destination, '/spec/changelog.html');
});

test('W278 sw.js cache slug is at least wave278', () => {
  const sw = readPublic('sw.js');
  const m = sw.match(/const CACHE = 'kolm-[^']*?wave(\d+)/);
  assert.ok(m, 'sw.js CACHE wave segment missing');
  const wave = Number(m[1]);
  assert.ok(wave >= 278, `sw.js wave segment ${wave} should be >= 278`);
});

test('W278 /verify-cli cross-links the spec + change log + verify-prod', () => {
  const html = readPublic('verify-cli.html');
  assert.match(html, /\/spec\/rs-1/, 'links to RS-1 spec');
  assert.match(html, /\/spec\/changelog/, 'links to change log');
  assert.match(html, /\/verify-prod/, 'links to /verify-prod browser verifier');
});

test('W278 /spec/changelog cross-links rs-1 + verify-cli', () => {
  const html = readPublic('spec/changelog.html');
  assert.match(html, /\/spec\/rs-1/, 'links to RS-1 spec');
  assert.match(html, /\/verify-cli/, 'links to standalone verifier');
});

test('W278 /spec/rs-1 still contains the v2.1 abstract + four-class taxonomy (regression guard)', () => {
  const html = readPublic('spec/rs-1.html');
  // Preserved spec content
  assert.match(html, /four-class taxonomy|four recipe classes/i, 'four-class taxonomy preserved');
  assert.match(html, /HMAC-SHA256/, 'HMAC layer preserved');
  assert.match(html, /Ed25519/, 'Ed25519 layer preserved');
  assert.match(html, /sigstore/, 'sigstore layer preserved');
  assert.match(html, /K-score/, 'K-score still cited');
});
