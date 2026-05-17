// Wave 194 — corpus URL licensing gate (N+2 / N+3).
// Closes the Wave 144 plan item "Corpus URL licensing gate not in verifier":
// a manifest declaring corpus_sources[] must carry source_url + license for
// each, where license sits in SAFE_LICENSES or AMBER_LICENSES (amber passes
// with a manual-review caveat). DENY_LICENSES (proprietary, scraped,
// tos-violated, unknown) and missing license strings fail the check.
//
// Coverage (18 tests):
//   1.  module exports SAFE_LICENSES / AMBER_LICENSES / DENY_LICENSES arrays
//   2.  SAFE_LICENSES has expected entries (MIT, Apache-2.0, CC-BY-4.0, CC0-1.0)
//   3.  AMBER_LICENSES has expected entries (CC-BY-NC-4.0, research-only)
//   4.  DENY_LICENSES has expected entries (proprietary, scraped, unknown)
//   5.  SAFE_LICENSES has >= 5 entries, AMBER >= 3, DENY >= 3
//   6.  the three lists are disjoint (no license in two lists)
//   7.  classifyLicense returns safe / amber / deny / unknown correctly
//   8.  validSourceUrl accepts http/https URLs and local: / internal: identifiers
//   9.  validSourceUrl rejects empty / garbage source_url
//  10.  checkCorpusLicensing passes (legacy note) when no sources declared
//  11.  checkCorpusLicensing passes when every source is SAFE
//  12.  checkCorpusLicensing passes with caveat when one source is AMBER
//  13.  checkCorpusLicensing fails when any source is in DENY_LICENSES
//  14.  checkCorpusLicensing fails when license is missing
//  15.  binder check #25 appears in buildBinder output (against real artifact)
//  16.  binder check #25 fail status propagates to verdict='fail'
//  17.  sw.js cache slug carries wave-floor >= 194 (regex extract)
//  18.  /verify-prod.html documents the new Check #25
//  19.  no em-dashes in licensing-allowlist.js prose

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

import {
  SAFE_LICENSES,
  AMBER_LICENSES,
  DENY_LICENSES,
  classifyLicense,
  validSourceUrl,
  extractCorpusSources,
  checkCorpusLicensing,
} from '../src/licensing-allowlist.js';
import { buildAndZip } from '../src/artifact.js';
import { buildBinder } from '../src/binder.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const SW = path.join(PUBLIC, 'sw.js');
const VERIFY_PROD = path.join(PUBLIC, 'verify-prod.html');
const LICENSING_MODULE = path.join(REPO, 'src', 'licensing-allowlist.js');

const SECRET = 'wave194-test-secret-' + crypto.randomBytes(8).toString('hex');
process.env.RECIPE_RECEIPT_SECRET = SECRET;

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w194-${label}-`));
}

function isolateEnv(t) {
  const saved = {};
  for (const k of [
    'KOLM_ED25519_KEY_STORE', 'KOLM_ED25519_PRIVATE_KEY', 'KOLM_ED25519_PRIVATE_KEY_PATH',
    'KOLM_ED25519_DISABLE', 'KOLM_SIGSTORE_DISABLE', 'KOLM_SIGSTORE_REKOR_URL',
    'KOLM_REKOR_REQUIRE', 'KOLM_REQUIRE_REKOR', 'KOLM_REQUIRE_ED25519',
    'KOLM_POLICY_OPT_OUT',
  ]) saved[k] = process.env[k];
  const keyDir = tmpDir('keys');
  process.env.KOLM_ED25519_KEY_STORE = keyDir;
  delete process.env.KOLM_ED25519_PRIVATE_KEY;
  delete process.env.KOLM_ED25519_PRIVATE_KEY_PATH;
  delete process.env.KOLM_ED25519_DISABLE;
  delete process.env.KOLM_SIGSTORE_DISABLE;
  delete process.env.KOLM_SIGSTORE_REKOR_URL;
  delete process.env.KOLM_REKOR_REQUIRE;
  delete process.env.KOLM_REQUIRE_REKOR;
  delete process.env.KOLM_REQUIRE_ED25519;
  delete process.env.KOLM_POLICY_OPT_OUT;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(keyDir, { recursive: true, force: true }); } catch { /* swallow */ }
  });
}

async function buildOne(suffix) {
  const outDir = tmpDir(`artifact-${suffix}`);
  const result = await buildAndZip({
    job_id: `wave194-${suffix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    task: 'wave194-corpus-licensing-test',
    base_model: 'none',
    recipes: [{
      id: 'r1',
      source: 'export default function r1(x){return String(x).toUpperCase()}',
      positives: [{ input: 'hi', expected: 'HI' }],
    }],
    evals: { cases: [{ input: 'hi', expected: 'HI' }] },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 10, cost_usd_per_call: 0 },
    outDir,
    tier: 'recipe',
  });
  return { ...result, outDir };
}

// Canonical JSON helper matching src/artifact.js shape (sorted keys, no
// indentation, no whitespace). signature.sig binds to canonical-json HMAC.
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

// Patch a built .kolm with an injected manifest.corpus_sources[] field. The
// HMAC signature.sig binds to manifest_hash + job_id; since we want the test
// to be purely about check #25 (not signature reverification), we rebuild
// the zip from its existing entries (modifying manifest.json + signature.sig)
// and re-sign signature.sig in the same JSON-envelope shape src/artifact.js
// emits at build time.
function patchKolmCorpusSources(kolmPath, corpusSources) {
  const ARTIFACT_SPEC = 'kolm-1';
  const oldZip = new AdmZip(kolmPath);
  const entries = oldZip.getEntries().map(e => ({ name: e.entryName, data: e.getData() }));
  const manifestEntry = entries.find(e => e.name === 'manifest.json');
  if (!manifestEntry) throw new Error(`manifest.json missing in ${kolmPath}`);
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  manifest.corpus_sources = corpusSources;
  const newManifestJson = JSON.stringify(manifest, null, 2);
  const newManifestHash = crypto.createHash('sha256').update(Buffer.from(newManifestJson)).digest('hex');
  // Compute the HMAC over the sig_payload canonical JSON shape used by
  // src/artifact.js when it builds signature.sig at compile time. We use the
  // minimal manifest_hash + job_id payload (second of two payload variants
  // accepted by verifyManifestSignature in src/artifact.js).
  const sigPayload = { spec: ARTIFACT_SPEC, manifest_hash: newManifestHash, job_id: manifest.job_id };
  const hmac = crypto.createHmac('sha256', process.env.RECIPE_RECEIPT_SECRET)
    .update(canonicalJson(sigPayload)).digest('hex');
  const newSigJson = JSON.stringify({
    spec: ARTIFACT_SPEC,
    job_id: manifest.job_id,
    manifest_hash: newManifestHash,
    hmac_alg: 'HMAC-SHA256',
    hmac,
    issued_at: new Date().toISOString(),
  }, null, 2);
  // Rebuild zip from scratch (writeZip on a modified AdmZip is fragile for
  // sourced-from-disk zips; reading entries + adding to a new AdmZip works).
  const newZip = new AdmZip();
  for (const e of entries) {
    if (e.name === 'manifest.json') {
      newZip.addFile('manifest.json', Buffer.from(newManifestJson, 'utf8'));
    } else if (e.name === 'signature.sig') {
      newZip.addFile('signature.sig', Buffer.from(newSigJson, 'utf8'));
    } else {
      newZip.addFile(e.name, e.data);
    }
  }
  newZip.writeZip(kolmPath);
}

// ---------------------------------------------------------------------------
// 1. module exports SAFE_LICENSES / AMBER_LICENSES / DENY_LICENSES arrays
// ---------------------------------------------------------------------------
test('1. licensing-allowlist exports SAFE / AMBER / DENY arrays', () => {
  assert.ok(Array.isArray(SAFE_LICENSES));
  assert.ok(Array.isArray(AMBER_LICENSES));
  assert.ok(Array.isArray(DENY_LICENSES));
  assert.ok(Object.isFrozen(SAFE_LICENSES));
  assert.ok(Object.isFrozen(AMBER_LICENSES));
  assert.ok(Object.isFrozen(DENY_LICENSES));
});

// ---------------------------------------------------------------------------
// 2. SAFE_LICENSES contains expected SPDX permissive identifiers
// ---------------------------------------------------------------------------
test('2. SAFE_LICENSES contains MIT, Apache-2.0, CC0-1.0, CC-BY-4.0', () => {
  for (const lic of ['MIT', 'Apache-2.0', 'CC0-1.0', 'CC-BY-4.0', 'BSD-3-Clause']) {
    assert.ok(SAFE_LICENSES.includes(lic), `SAFE_LICENSES must include '${lic}'`);
  }
});

// ---------------------------------------------------------------------------
// 3. AMBER_LICENSES contains expected research-only / NC variants
// ---------------------------------------------------------------------------
test('3. AMBER_LICENSES contains CC-BY-NC-4.0, research-only, OpenRAIL-M', () => {
  for (const lic of ['CC-BY-NC-4.0', 'research-only', 'OpenRAIL-M']) {
    assert.ok(AMBER_LICENSES.includes(lic), `AMBER_LICENSES must include '${lic}'`);
  }
});

// ---------------------------------------------------------------------------
// 4. DENY_LICENSES contains expected known-bad designations
// ---------------------------------------------------------------------------
test('4. DENY_LICENSES contains proprietary, scraped, unknown, tos-violated', () => {
  for (const lic of ['proprietary', 'scraped', 'unknown', 'tos-violated']) {
    assert.ok(DENY_LICENSES.includes(lic), `DENY_LICENSES must include '${lic}'`);
  }
});

// ---------------------------------------------------------------------------
// 5. SAFE has >= 5 entries, AMBER >= 3, DENY >= 3
// ---------------------------------------------------------------------------
test('5. SAFE >= 5 entries, AMBER >= 3, DENY >= 3', () => {
  assert.ok(SAFE_LICENSES.length >= 5, `SAFE_LICENSES has ${SAFE_LICENSES.length} (need >= 5)`);
  assert.ok(AMBER_LICENSES.length >= 3, `AMBER_LICENSES has ${AMBER_LICENSES.length} (need >= 3)`);
  assert.ok(DENY_LICENSES.length >= 3, `DENY_LICENSES has ${DENY_LICENSES.length} (need >= 3)`);
});

// ---------------------------------------------------------------------------
// 6. the three lists are disjoint
// ---------------------------------------------------------------------------
test('6. SAFE / AMBER / DENY lists are disjoint', () => {
  const all = [...SAFE_LICENSES, ...AMBER_LICENSES, ...DENY_LICENSES];
  const uniq = new Set(all);
  assert.equal(uniq.size, all.length,
    `lists must be disjoint; duplicates would silently shadow classification`);
});

// ---------------------------------------------------------------------------
// 7. classifyLicense returns safe / amber / deny / unknown correctly
// ---------------------------------------------------------------------------
test('7. classifyLicense buckets each known license correctly', () => {
  assert.equal(classifyLicense('MIT'), 'safe');
  assert.equal(classifyLicense('Apache-2.0'), 'safe');
  assert.equal(classifyLicense('CC-BY-NC-4.0'), 'amber');
  assert.equal(classifyLicense('research-only'), 'amber');
  assert.equal(classifyLicense('proprietary'), 'deny');
  assert.equal(classifyLicense('scraped'), 'deny');
  assert.equal(classifyLicense('unknown'), 'deny');
  assert.equal(classifyLicense(''), 'unknown');
  assert.equal(classifyLicense(null), 'unknown');
  assert.equal(classifyLicense('not-a-real-license'), 'unknown');
});

// ---------------------------------------------------------------------------
// 8. validSourceUrl accepts http(s) URLs and known prefix identifiers
// ---------------------------------------------------------------------------
test('8. validSourceUrl accepts http(s) URLs and local: / internal: / huggingface: identifiers', () => {
  assert.equal(validSourceUrl('https://example.com/corpus').ok, true);
  assert.equal(validSourceUrl('http://example.com/corpus').ok, true);
  assert.equal(validSourceUrl('local:tenant/corpus').ok, true);
  assert.equal(validSourceUrl('internal:cms-2026q1').ok, true);
  assert.equal(validSourceUrl('huggingface:glue/sst2').ok, true);
});

// ---------------------------------------------------------------------------
// 9. validSourceUrl rejects empty / garbage URLs
// ---------------------------------------------------------------------------
test('9. validSourceUrl rejects empty / garbage / unsupported-protocol URLs', () => {
  assert.equal(validSourceUrl('').ok, false);
  assert.equal(validSourceUrl(null).ok, false);
  assert.equal(validSourceUrl('not a url at all').ok, false);
  assert.equal(validSourceUrl('local:').ok, false); // prefix with no identifier
  assert.equal(validSourceUrl('ftp://example.com/x').ok, false);
});

// ---------------------------------------------------------------------------
// 10. checkCorpusLicensing passes with legacy note when no sources declared
// ---------------------------------------------------------------------------
test('10. checkCorpusLicensing passes with legacy-manifest note when sources absent', () => {
  const r = checkCorpusLicensing({});
  assert.equal(r.status, 'pass');
  assert.equal(r.sources_count, 0);
  assert.match(r.detail, /no corpus sources declared/);
  assert.match(r.detail, /legacy or template manifest/);
});

// ---------------------------------------------------------------------------
// 11. checkCorpusLicensing passes when every source is SAFE
// ---------------------------------------------------------------------------
test('11. checkCorpusLicensing passes when every source is SAFE', () => {
  const r = checkCorpusLicensing({
    corpus_sources: [
      { name: 'wiki-en', source_url: 'https://huggingface.co/datasets/wikipedia', license: 'CC-BY-SA-4.0' },
      { name: 'opensubtitles', source_url: 'https://opensubtitles.org', license: 'MIT' },
    ],
  });
  assert.equal(r.status, 'pass');
  assert.equal(r.sources_count, 2);
  assert.match(r.detail, /wiki-en \(CC-BY-SA-4\.0\)/);
  assert.match(r.detail, /opensubtitles \(MIT\)/);
});

// ---------------------------------------------------------------------------
// 12. checkCorpusLicensing passes with caveat when one source is AMBER
// ---------------------------------------------------------------------------
test('12. checkCorpusLicensing passes with caveat when one source is amber', () => {
  const r = checkCorpusLicensing({
    corpus_sources: [
      { name: 'permissive-src', source_url: 'https://example.com/a', license: 'Apache-2.0' },
      { name: 'research-src', source_url: 'https://example.com/b', license: 'CC-BY-NC-4.0' },
    ],
  });
  assert.equal(r.status, 'pass');
  assert.equal(r.sources_count, 2);
  assert.ok(Array.isArray(r.caveats));
  assert.equal(r.caveats.length, 1);
  assert.match(r.caveats[0], /research-src/);
  assert.match(r.caveats[0], /CC-BY-NC-4\.0/);
  assert.match(r.caveats[0], /amber/);
  assert.match(r.detail, /manual procurement review/);
});

// ---------------------------------------------------------------------------
// 13. checkCorpusLicensing fails when any source is in DENY_LICENSES
// ---------------------------------------------------------------------------
test('13. checkCorpusLicensing fails when any source is in DENY_LICENSES', () => {
  const r = checkCorpusLicensing({
    corpus_sources: [
      { name: 'clean-src', source_url: 'https://example.com/a', license: 'MIT' },
      { name: 'bad-src', source_url: 'https://example.com/b', license: 'proprietary' },
    ],
  });
  assert.equal(r.status, 'fail');
  assert.ok(Array.isArray(r.bad));
  assert.equal(r.bad.length, 1);
  assert.match(r.bad[0], /bad-src/);
  assert.match(r.bad[0], /proprietary/);
  assert.match(r.detail, /DENY_LICENSES/);
});

// ---------------------------------------------------------------------------
// 14. checkCorpusLicensing fails when license is missing or empty
// ---------------------------------------------------------------------------
test('14. checkCorpusLicensing fails when license is missing or empty', () => {
  const r = checkCorpusLicensing({
    corpus_sources: [
      { name: 'no-license-src', source_url: 'https://example.com/x' },
    ],
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.bad.length, 1);
  assert.match(r.bad[0], /no-license-src/);
  assert.match(r.bad[0], /\(missing\)/);
});

// ---------------------------------------------------------------------------
// 15. binder check #25 appears in buildBinder output (no corpus_sources branch)
// ---------------------------------------------------------------------------
test('15. binder check #25 appears in buildBinder output (legacy artifact, no sources)', async (t) => {
  isolateEnv(t);
  const { outPath } = await buildOne('no-sources');
  const report = await buildBinder(outPath);
  const c25 = report.checks.find(c => c.name === 'Corpus URL licensing gate');
  assert.ok(c25, 'check #25 (Corpus URL licensing gate) must always emit');
  assert.equal(c25.status, 'pass');
  assert.match(c25.detail, /no corpus sources declared/);
  // Check #25 itself does not push the artifact into the fail state for the
  // legacy/template branch; other unrelated stub-artifact checks may flag
  // (e.g. seed-provenance), so we only assert that #25 specifically is pass.
});

// ---------------------------------------------------------------------------
// 16. binder check #25 fail propagates to verdict='fail' (DENY license in manifest)
// ---------------------------------------------------------------------------
test('16. check #25 fail propagates to verdict=fail when corpus_sources carries DENY license', async (t) => {
  isolateEnv(t);
  const { outPath } = await buildOne('deny-license');
  patchKolmCorpusSources(outPath, [
    { name: 'scraped-corpus', source_url: 'https://example.com/scraped', license: 'scraped' },
  ]);
  const report = await buildBinder(outPath);
  const c25 = report.checks.find(c => c.name === 'Corpus URL licensing gate');
  assert.ok(c25);
  assert.equal(c25.status, 'fail', `expected fail, got ${c25.status}: ${c25.detail}`);
  assert.match(c25.detail, /scraped-corpus/);
  // Verdict overall: at least one failed check (and check #25 is one of them)
  // => verdict=fail and kolm verify exits non-zero (EXIT.EXECUTION).
  assert.equal(report.verdict, 'fail');
  // Confirm check #25 specifically is in the failing-checks set
  const failingChecks = report.checks.filter(c => c.status === 'fail').map(c => c.name);
  assert.ok(failingChecks.includes('Corpus URL licensing gate'),
    `Corpus URL licensing gate must be in failing checks; got ${JSON.stringify(failingChecks)}`);
});

// ---------------------------------------------------------------------------
// 17. sw.js cache slug carries wave-floor >= 194 (regex extract, not literal)
// ---------------------------------------------------------------------------
test('17. sw.js CACHE bumped to a wave-floor >= 194 slug', () => {
  const sw = fs.readFileSync(SW, 'utf8');
  const m = sw.match(/const CACHE = 'kolm-v\d+-\d{4}-\d{2}-\d{2}-wave(\d+)-[^']+'/);
  assert.ok(m, 'sw.js must declare const CACHE = ... wave<N>-<slug> ...');
  const wave = parseInt(m[1], 10);
  assert.ok(wave >= 194,
    `sw.js CACHE wave-floor is ${wave}; wave 194 needs >= 194 — coordinator must bump after wiring this verifier check`);
});

// ---------------------------------------------------------------------------
// 18. /verify-prod.html documents the new Check #25
// ---------------------------------------------------------------------------
test('18. /verify-prod.html documents the new Check #25 corpus URL licensing gate', () => {
  const html = fs.readFileSync(VERIFY_PROD, 'utf8');
  assert.match(html, /25\s*\.\s*corpus URL licensing gate/i,
    '/verify-prod.html must surface "25 . corpus URL licensing gate" in the checks grid');
  assert.match(html, /SAFE_LICENSES/,
    '/verify-prod.html row must reference SAFE_LICENSES (frozen allowlist constant)');
  assert.match(html, /AMBER_LICENSES/,
    '/verify-prod.html row must reference AMBER_LICENSES');
  assert.match(html, /wave 194/,
    '/verify-prod.html row must self-stamp wave 194');
});

// ---------------------------------------------------------------------------
// 19. licensing-allowlist.js prose has no em-dashes in code comments
// ---------------------------------------------------------------------------
test('19. licensing-allowlist.js source carries no em-dashes (style guard)', () => {
  const src = fs.readFileSync(LICENSING_MODULE, 'utf8');
  assert.ok(!src.includes('—'),
    'licensing-allowlist.js must not contain em-dash (U+2014) characters');
});
