// W375 — account control plane behavior tests.
//
// Asserts the 15 /account/* section files exist, share the same shell
// (sidebar, skip-link, auth gate, JSON-LD), and each hits at least one real
// /v1/* endpoint. Storage truth panel is the headline page; billing names
// every meter; opportunities names every type.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const ACCT = path.join(ROOT, 'public', 'account');

const SECTIONS = [
  'overview',
  'connectors',
  'captured',
  'privacy-events',
  'repeated-workflows',
  'opportunities',
  'labeling',
  'datasets',
  'simulations',
  'bakeoffs',
  'builds',
  'artifacts',
  'devices',
  'storage',
  'billing',
];

function read(section) {
  return fs.readFileSync(path.join(ACCT, section + '.html'), 'utf8');
}

// ----- 1) All 15 section files exist -----
test('W375 #1 - all 15 section files exist under public/account/', () => {
  for (const s of SECTIONS) {
    const p = path.join(ACCT, s + '.html');
    assert.ok(fs.existsSync(p), 'missing: ' + p);
    const stat = fs.statSync(p);
    assert.ok(stat.size > 1200, s + '.html too small: ' + stat.size);
  }
});

// ----- 2) Each title ends with the brand suffix -----
test('W375 #2 - every page title ends with " · Account · kolm.ai"', () => {
  for (const s of SECTIONS) {
    const html = read(s);
    const m = html.match(/<title>([^<]+)<\/title>/);
    assert.ok(m, s + ' has no <title>');
    const t = m[1].trim();
    assert.ok(
      / · Account · kolm\.ai$/.test(t),
      s + ' title does not end with the brand suffix: ' + t,
    );
  }
});

// ----- 3) Sidebar lists all 15 sections -----
test('W375 #3 - every page has <nav id="account-sidebar"> with all 15 links', () => {
  for (const s of SECTIONS) {
    const html = read(s);
    assert.ok(
      /<nav[^>]*id=["']account-sidebar["']/.test(html),
      s + ' has no <nav id="account-sidebar">',
    );
    for (const peer of SECTIONS) {
      const re = new RegExp('href=["\']/account/' + peer + '["\']');
      assert.ok(re.test(html), s + ' sidebar missing link to /account/' + peer);
    }
    // current section gets aria-current="page"
    const cur = new RegExp(
      'href=["\']/account/' + s + '["\'][^>]*aria-current=["\']page["\']'
    );
    const curAlt = new RegExp(
      'aria-current=["\']page["\'][^>]*href=["\']/account/' + s + '["\']'
    );
    assert.ok(
      cur.test(html) || curAlt.test(html),
      s + ' current sidebar link lacks aria-current="page"',
    );
  }
});

// ----- 4) Skip link + <main id="main"> -----
test('W375 #4 - every page has a skip link + <main id="main">', () => {
  for (const s of SECTIONS) {
    const html = read(s);
    assert.ok(
      /<a[^>]*href=["']#main["'][^>]*class=["'][^"']*skip-link/.test(html),
      s + ' missing skip-link anchor',
    );
    assert.ok(/<main[^>]*id=["']main["']/.test(html), s + ' missing <main id="main">');
  }
});

// ----- 5) Client-side auth gate -----
test('W375 #5 - every page has a client-side auth gate script', () => {
  for (const s of SECTIONS) {
    const html = read(s);
    // looks for the kolm-key localStorage check + /signin redirect
    assert.ok(/localStorage[\s\S]{0,40}['"]kolm-key['"]/.test(html), s + ' has no kolm-key auth check');
    assert.ok(/\/signin/.test(html), s + ' has no /signin redirect target');
  }
});

// ----- 6) Each page calls at least one /v1/* endpoint -----
test('W375 #6 - every page contains at least one fetch to /v1/<endpoint>', () => {
  for (const s of SECTIONS) {
    const html = read(s);
    const hits = html.match(/['"`]\/v1\/[a-zA-Z0-9_\-/:]+/g) || [];
    assert.ok(hits.length >= 1, s + ' contains no /v1/* endpoint string. got: ' + hits.length);
  }
});

// ----- 7) Empty state present per section -----
test('W375 #7 - every page has a data-empty-state element', () => {
  for (const s of SECTIONS) {
    const html = read(s);
    assert.ok(
      /\bdata-empty-state\b/.test(html),
      s + ' has no data-empty-state element',
    );
  }
});

// ----- 8) Storage truth panel: 3 panels -----
test('W375 #8 - storage.html has the 3 truth panels', () => {
  const html = read('storage');
  for (const p of ['local-paths', 'storage-mode', 'cloud-sync']) {
    const re = new RegExp('data-panel=["\']' + p + '["\']');
    assert.ok(re.test(html), 'storage.html missing data-panel="' + p + '"');
  }
});

// ----- 9) Storage modes -----
test('W375 #9 - storage.html lists all 5 storage modes by name', () => {
  const html = read('storage');
  for (const mode of [
    'metadata_only',
    'redacted_local',
    'raw_local',
    'redacted_cloud_sync',
    'raw_cloud_sync',
  ]) {
    assert.ok(html.includes(mode), 'storage.html missing mode: ' + mode);
  }
});

// ----- 10) Cloud sync states -----
test('W375 #10 - storage.html lists all 4 cloud-sync states by name', () => {
  const html = read('storage');
  for (const state of ['disabled', 'metadata_only', 'redacted_only', 'raw_enabled']) {
    assert.ok(html.includes(state), 'storage.html missing cloud sync state: ' + state);
  }
});

// ----- 11) Billing 12 meters -----
test('W375 #11 - billing.html lists all 12 meter names', () => {
  const html = read('billing');
  const meters = [
    'captured_events',
    'redacted_events',
    'raw_cloud_synced_bytes',
    'redacted_cloud_synced_bytes',
    'hosted_build_minutes',
    'training_gpu_minutes',
    'synthetic_examples_generated',
    'eval_examples_run',
    'artifacts_built',
    'artifact_installs',
    'team_seats',
    'device_sync_targets',
  ];
  for (const m of meters) {
    assert.ok(html.includes(m), 'billing.html missing meter: ' + m);
  }
});

// ----- 12) Captured.html has SSE consumer -----
test('W375 #12 - captured.html has an SSE consumer (EventSource or fetch+reader)', () => {
  const html = read('captured');
  const hasES = /new\s+EventSource\s*\(/.test(html);
  const hasReader = /response\.body\.getReader\s*\(\s*\)/.test(html) || /\.getReader\(\)/.test(html);
  assert.ok(hasES || hasReader, 'captured.html has no SSE consumer');
  assert.ok(/\/v1\/capture\/stream/.test(html), 'captured.html does not reference /v1/capture/stream');
});

// ----- 13) Opportunities.html names all 11 types -----
test('W375 #13 - opportunities.html names all 11 opportunity types', () => {
  const html = read('opportunities');
  const types = [
    'cache_candidate',
    'cheaper_model_candidate',
    'local_replacement_candidate',
    'privacy_leak',
    'prompt_compression',
    'repeated_extraction',
    'repeated_classification',
    'log_triage',
    'routing_policy',
    'dataset_ready',
    'training_ready',
  ];
  for (const t of types) {
    assert.ok(html.includes(t), 'opportunities.html missing type: ' + t);
  }
});

// ----- 14) Labeling.html accept/correct/reject controls -----
test('W375 #14 - labeling.html has accept/correct/reject controls (data-action)', () => {
  const html = read('labeling');
  for (const act of ['accept', 'correct', 'reject']) {
    const re = new RegExp('data-action=["\']' + act + '["\']');
    assert.ok(re.test(html), 'labeling.html missing data-action="' + act + '"');
  }
});

// ----- 15) Devices.html test button per row -----
test('W375 #15 - devices.html has a test-button row template (data-action="test-device")', () => {
  const html = read('devices');
  assert.ok(
    /data-action=["']test-device["']/.test(html),
    'devices.html missing data-action="test-device"',
  );
});

// ----- 16) sw.js cache slug -----
test('W375 #16 - sw.js CACHE slug follows kolm-v7-YYYY-MM-DD-waveN-* format', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const m = sw.match(/const\s+CACHE\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(m, 'sw.js has no CACHE constant');
  assert.match(
    m[1],
    /^kolm-v7-\d{4}-\d{2}-\d{2}-wave\d+(-[a-z0-9-]+)*$/,
    'CACHE must match kolm-v7-YYYY-MM-DD-waveN-<slug> format so each wave invalidates old caches: ' + m[1],
  );
});

// ----- 17) vercel.json rewrites for /account + each section -----
test('W375 #17 - vercel.json has rewrites for /account and all 15 sections', () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const rw = v.rewrites || [];
  const sources = new Set(rw.map((x) => x.source));
  assert.ok(sources.has('/account'), 'vercel.json missing rewrite for /account');
  for (const s of SECTIONS) {
    assert.ok(sources.has('/account/' + s), 'vercel.json missing rewrite for /account/' + s);
  }
  // The /account rewrite must target overview.html (or /account/overview.html).
  const root = rw.find((x) => x.source === '/account');
  assert.ok(
    /\/overview\.html$/.test(root.destination) || /^\/account\/overview\.html$/.test(root.destination),
    '/account rewrite must point at overview.html, got: ' + root.destination,
  );
});

// ----- 18) JSON-LD WebPage + BreadcrumbList present on every page -----
test('W375 #18 - every page has JSON-LD with WebPage + BreadcrumbList', () => {
  for (const s of SECTIONS) {
    const html = read(s);
    assert.ok(
      /application\/ld\+json/.test(html),
      s + ' missing application/ld+json script',
    );
    assert.ok(/WebPage/.test(html), s + ' JSON-LD missing WebPage');
    assert.ok(/BreadcrumbList/.test(html), s + ' JSON-LD missing BreadcrumbList');
  }
});

// ----- 19) Brand anchor in first 1200 chars + em-dash <= 1 -----
test('W375 #19 - brand anchor "kolm.ai" in first 1200 chars + em-dash count <= 1', () => {
  for (const s of SECTIONS) {
    const html = read(s);
    const head = html.slice(0, 1200);
    assert.ok(head.includes('kolm.ai'), s + ' has no kolm.ai brand anchor in first 1200 chars');
    // em-dash budget: literal em-dash or &mdash; entity
    const literal = (html.match(/—/g) || []).length;
    const entity = (html.match(/&mdash;/g) || []).length;
    assert.ok(literal + entity <= 1, s + ' em-dash budget blown: literal=' + literal + ' entity=' + entity);
  }
});

// ----- 20) No forbidden marketing language -----
test('W375 #20 - no "coming soon" / "Beta" / "not_yet_wired"', () => {
  for (const s of SECTIONS) {
    const html = read(s);
    assert.ok(!/coming soon/i.test(html), s + ' contains "coming soon"');
    assert.ok(!/\bBeta\b/.test(html), s + ' contains the word "Beta"');
    assert.ok(!/not_yet_wired/.test(html), s + ' contains "not_yet_wired"');
  }
});
