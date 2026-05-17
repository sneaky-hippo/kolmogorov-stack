// Wave 171 — M+3 + M+4 lifecycle UI surface. Locks in the dedicated
// /drift page that consumes the W167 src/drift-supersession.js backend
// and surfaces the four lifecycle tiers (stale, cadence, drift, supersession)
// the W170 backlog explicitly called for. Each assertion ties one piece of
// rendered prose to a frozen backend constant so the page cannot drift
// from the spec it is meant to document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const DRIFT = path.join(PUBLIC, 'drift.html');
const COMPARE = path.join(PUBLIC, 'compare.html');
const SW = path.join(PUBLIC, 'sw.js');
const VERCEL = path.join(REPO, 'vercel.json');

const read = (p) => fs.readFileSync(p, 'utf8');

test('1. /drift page exists on disk and is non-trivial size', () => {
  assert.ok(fs.existsSync(DRIFT), `drift.html missing at ${DRIFT}`);
  const stat = fs.statSync(DRIFT);
  assert.ok(stat.size > 8192, `drift.html too small (${stat.size} bytes; expected > 8 KB)`);
});

test('2. /drift declares canonical URL https://kolm.ai/drift', () => {
  const html = read(DRIFT);
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/drift"/,
    'drift.html must declare canonical https://kolm.ai/drift');
});

test('3. /drift enumerates all six SUPERSESSION_REASONS from src/drift-supersession.js', () => {
  const html = read(DRIFT);
  const REASONS = ['drift_detected', 'scheduled_rebuild', 'security_patch',
    'recipe_revision', 'policy_change', 'tenant_request'];
  for (const r of REASONS) {
    assert.ok(html.includes(r), `drift.html missing supersession reason "${r}"`);
  }
});

test('4. /drift lists every axis from DEFAULT_TOLERANCES', () => {
  const html = read(DRIFT);
  const AXES = ['eval_score', 'k_score.composite', 'k_score.&lt;axis&gt;',
    'external_holdout_hash', 'tenant_shadow_corpus_hash', 'artifact_hash'];
  for (const a of AXES) {
    assert.ok(html.includes(a), `drift.html missing tolerance axis "${a}"`);
  }
});

test('5. /drift references the four lifecycle ladder tiers M+1 through M+4', () => {
  const html = read(DRIFT);
  for (const tier of ['M+1', 'M+2', 'M+3', 'M+4']) {
    assert.ok(html.includes(tier), `drift.html missing lifecycle tier "${tier}"`);
  }
  for (const name of ['Stale notification', 'Re-distillation cadence',
    'Drift detection cron', 'Supersession chain']) {
    assert.ok(html.includes(name), `drift.html missing tier name "${name}"`);
  }
});

test('6. /drift cites the backend wave (167) and the originating plan wave (144)', () => {
  const html = read(DRIFT);
  const lower = html.toLowerCase();
  assert.ok(lower.includes('wave 167'), 'drift.html must cite the W167 backend');
  assert.ok(lower.includes('wave 144'), 'drift.html must cite the W144 plan');
  assert.ok(lower.includes('wave 171'), 'drift.html must self-stamp wave 171');
});

test('7. /drift names the three spec-version constants from drift-supersession.js', () => {
  const html = read(DRIFT);
  for (const spec of ['supersession-v1', 'drift-snapshot-v1', 'drift-report-v1']) {
    assert.ok(html.includes(spec), `drift.html missing spec version "${spec}"`);
  }
});

test('8. /drift surfaces the three drift status values within / drift / breach', () => {
  const html = read(DRIFT);
  for (const status of ['within', 'drift', 'breach']) {
    assert.ok(html.includes(status), `drift.html missing drift status "${status}"`);
  }
});

test('9. /drift documents the four CLI surfaces', () => {
  const html = read(DRIFT);
  for (const cmd of ['kolm drift detect', 'kolm drift cron',
    'kolm compile --supersession-of', 'kolm verify']) {
    assert.ok(html.includes(cmd), `drift.html missing CLI surface "${cmd}"`);
  }
});

test('10. /drift names verifier checks #23 and #24', () => {
  const html = read(DRIFT);
  assert.ok(html.includes('#23'), 'drift.html must reference verifier check #23 (supersession)');
  assert.ok(html.includes('#24'), 'drift.html must reference verifier check #24 (drift report)');
});

test('11. /drift shows the receipt-chain ordering with supersession + drift_report appended', () => {
  const html = read(DRIFT);
  for (const node of ['spec', 'seeds', 'split', 'train', 'recipes', 'evals',
    'external_holdout', 'tenant_shadow', 'auditor_attestation',
    'supersession', 'drift_report', 'export', 'signatures', 'rekor']) {
    assert.ok(html.includes(node), `drift.html receipt chain missing node "${node}"`);
  }
});

test('12. /drift names the reason-specific evidence guard verbatim', () => {
  const html = read(DRIFT);
  assert.ok(html.includes('drift_signals') && html.includes('drift_report_hash'),
    'drift.html must name drift_signals + drift_report_hash for drift_detected guard');
});

test('13. /drift declares honest scope (kolm ships vs tenant owns)', () => {
  const html = read(DRIFT);
  assert.ok(html.includes('kolm ships'),
    'drift.html must declare what kolm ships');
  assert.ok(html.includes('tenant owns'),
    'drift.html must declare what the tenant owns');
  for (const sched of ['cron', 'systemd', 'k8s', 'Airflow', 'GitHub Actions']) {
    assert.ok(html.includes(sched),
      `drift.html honest-scope section must name "${sched}" as a tenant-owned scheduler`);
  }
});

test('14. /drift cross-links to the canonical surfaces', () => {
  const html = read(DRIFT);
  for (const href of ['/spec/rs-1#section-7-15', '/compare', '/verify-prod', '/quickstart']) {
    assert.ok(html.includes(`href="${href}"`),
      `drift.html missing cross-link to ${href}`);
  }
});

test('15. /drift uses the consistent design system tokens', () => {
  const html = read(DRIFT);
  assert.match(html, /--mono:/, 'drift.html must declare --mono CSS custom property');
  assert.match(html, /--accent:/, 'drift.html must declare --accent CSS custom property');
  assert.match(html, /--warn:/, 'drift.html must declare --warn CSS custom property');
  assert.match(html, /--bad:/, 'drift.html must declare --bad CSS custom property');
});

test('16. /drift shows the four lifecycle scenarios (A scheduled / B warn / C breach / D forged)', () => {
  const html = read(DRIFT);
  assert.ok(html.includes('Scheduled rebuild'),
    'drift.html must document scenario A: scheduled rebuild, no drift');
  assert.ok(html.includes('Warn-band'),
    'drift.html must document scenario B: warn-band ship');
  assert.ok(html.includes('Breach') || html.includes('breach'),
    'drift.html must document scenario C: breach + successor');
  assert.ok(html.includes('Forged'),
    'drift.html must document scenario D: forged supersession rejected');
});

test('17. vercel.json rewrites /drift to /drift.html', () => {
  const vercel = JSON.parse(read(VERCEL));
  const rewrite = vercel.rewrites.find((r) => r.source === '/drift');
  assert.ok(rewrite, 'vercel.json missing rewrite for /drift');
  assert.equal(rewrite.destination, '/drift.html',
    'vercel.json /drift rewrite must target /drift.html');
});

test('18. sw.js CACHE bumped to wave171 or later slug', () => {
  const sw = read(SW);
  // Wave 171 was the floor for this test; later waves bump the slug forward.
  // Match any kolm-v7-* CACHE with a numeric wave segment >= 171.
  const m = sw.match(/const CACHE = 'kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(Number(m[1]) >= 171,
    `sw.js CACHE wave segment must be >= 171 (saw wave${m[1]})`);
});

test('19. /compare row 14 (drift+supersession) now links to /drift dedicated surface', () => {
  const html = read(COMPARE);
  const rowIdx = html.indexOf('Drift detection + supersession chain');
  assert.ok(rowIdx >= 0, 'compare.html missing the Drift detection + supersession chain row');
  const closeIdx = html.indexOf('</tr>', rowIdx);
  const rowHtml = html.slice(rowIdx, closeIdx);
  assert.ok(rowHtml.includes('/drift'),
    'compare.html row 14 must link to the /drift dedicated surface');
});

test('20. /drift hero language matches the existential framing from W144 Doc 3 §7', () => {
  const html = read(DRIFT);
  assert.ok(html.includes('does not stay correct forever'),
    'drift.html hero must frame the lifecycle problem as the existential framing demands');
});

test('21. /drift names the SHA-256 binding into artifact_hash_input', () => {
  const html = read(DRIFT);
  assert.ok(html.includes('artifact_hash_input'),
    'drift.html must explain that lifecycle blocks bind into artifact_hash_input');
  assert.ok(html.includes('Rekor') || html.includes('rekor'),
    'drift.html must explain the downstream Rekor signature breakage on tamper');
});

test('22. /drift documents both the SupersessionBlock and DriftReport JSON shapes', () => {
  const html = read(DRIFT);
  assert.ok(html.includes('SupersessionBlock'),
    'drift.html must show the SupersessionBlock JSON shape');
  assert.ok(html.includes('DriftReport'),
    'drift.html must show the DriftReport JSON shape');
  for (const field of ['predecessor_artifact_hash', 'supersession_date',
    'baseline_snapshot', 'current_snapshot']) {
    assert.ok(html.includes(field),
      `drift.html manifest blocks must show field "${field}"`);
  }
});
