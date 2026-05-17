// Wave 173 — Refresh of /research/* + /healthcare/* surfaces to cite the
// W164-W167 receipt-chain extensions. Each assertion ties one piece of
// rendered prose to a frozen RS-1 section number (§7.12 R-axis, §7.13
// tenant shadow, §7.14 third-party auditor, §7.15 drift + supersession)
// so the surfaces cannot drift from the spec they are meant to document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

const read = (p) => fs.readFileSync(p, 'utf8');

const HC_ARCH = path.join(PUBLIC, 'healthcare', 'architecture.html');
const HC_ASSESS = path.join(PUBLIC, 'healthcare', 'assessment.html');
const R_RECEIPT = path.join(PUBLIC, 'research', 'receipt-chains.html');
const R_PROV = path.join(PUBLIC, 'research', 'provenance-data-generation.html');
const R_DRIFT = path.join(PUBLIC, 'research', 'eval-set-drift.html');
const SW = path.join(PUBLIC, 'sw.js');

test('1. healthcare/architecture.html exists and is non-trivial', () => {
  assert.ok(fs.existsSync(HC_ARCH), `architecture.html missing at ${HC_ARCH}`);
  assert.ok(fs.statSync(HC_ARCH).size > 8192, 'architecture.html too small');
});

test('2. healthcare/architecture.html cites all four W164-W167 receipt-chain extensions', () => {
  const html = read(HC_ARCH);
  for (const wave of ['Wave 164', 'Wave 165', 'Wave 166', 'Wave 167']) {
    assert.ok(html.includes(wave), `architecture.html must cite ${wave}`);
  }
  for (const section of ['7.12', '7.13', '7.14', '7.15']) {
    assert.ok(html.includes(`&sect;${section}`) || html.includes(`§${section}`),
      `architecture.html must reference RS-1 §${section}`);
  }
});

test('3. healthcare/architecture.html names each W164-W167 mechanism', () => {
  const html = read(HC_ARCH).toLowerCase();
  for (const concept of ['external', 'adversarial', 'shadow corpus', 'auditor', 'drift', 'supersession']) {
    assert.ok(html.includes(concept),
      `architecture.html must name "${concept}"`);
  }
});

test('4. healthcare/assessment.html PHI verdict path cites W164 R-axis + W165 shadow + W166 auditor + W167 drift', () => {
  const html = read(HC_ASSESS);
  assert.ok(html.includes('Wave 165'), 'assessment.html must cite W165 tenant shadow corpus');
  assert.ok(html.includes('Wave 164'), 'assessment.html must cite W164 R-axis');
  assert.ok(html.includes('Wave 166'), 'assessment.html must cite W166 third-party auditor');
  assert.ok(html.includes('Wave 167'), 'assessment.html must cite W167 drift detection');
  assert.ok(html.includes('kolm drift detect'),
    'assessment.html must surface the kolm drift detect CLI');
});

test('5. healthcare/assessment.html links to the /drift lifecycle surface', () => {
  const html = read(HC_ASSESS);
  assert.ok(html.includes('href="/drift"'),
    'assessment.html PHI path must cross-link to /drift');
});

test('6. research/receipt-chains.html announces the W164-W167 chain extensions', () => {
  const html = read(R_RECEIPT);
  assert.ok(html.includes('Waves 164-167'),
    'receipt-chains.html must announce the W164-W167 extension paragraph');
  for (const section of ['7.12', '7.13', '7.14', '7.15']) {
    assert.ok(html.includes(`&sect;${section}`) || html.includes(`§${section}`),
      `receipt-chains.html must reference §${section}`);
  }
});

test('7. research/receipt-chains.html explains backward compatibility', () => {
  const html = read(R_RECEIPT);
  assert.ok(html.includes('still verify') || html.includes('still valid'),
    'receipt-chains.html must explain old receipts still verify');
  assert.ok(html.includes('optional'),
    'receipt-chains.html must name the new blocks as optional');
});

test('8. research/receipt-chains.html cross-links /drift + /spec/rs-1', () => {
  const html = read(R_RECEIPT);
  assert.ok(html.includes('href="/drift"'),
    'receipt-chains.html W164-167 paragraph must link to /drift');
  assert.ok(html.includes('href="/spec/rs-1"'),
    'receipt-chains.html W164-167 paragraph must link to /spec/rs-1');
});

test('9. research/provenance-data-generation.html surfaces the five-column K-score schema', () => {
  const html = read(R_PROV);
  for (const k of ['K_seed', 'K_templated', 'K_external', 'K_adversarial', 'K_shadow']) {
    assert.ok(html.includes(k),
      `provenance-data-generation.html must report K-score column "${k}"`);
  }
});

test('10. research/provenance-data-generation.html ties each new K-axis to its wave', () => {
  const html = read(R_PROV);
  assert.ok(html.includes('Wave 164'), 'provenance must cite W164 for external/adversarial');
  assert.ok(html.includes('Wave 165'), 'provenance must cite W165 for shadow');
  assert.ok(html.includes('Wave 167'), 'provenance must cite W167 for drift recomputation');
});

test('11. research/eval-set-drift.html hero retitled as SHIPPED (not v0.2 roadmap)', () => {
  const html = read(R_DRIFT);
  assert.ok(html.includes('SHIPPED wave 167') || html.includes('shipped wave 167'),
    'eval-set-drift.html hero pill must declare SHIPPED wave 167 status');
});

test('12. research/eval-set-drift.html surfaces the three drift status values', () => {
  const html = read(R_DRIFT);
  for (const status of ['within', 'drift', 'breach']) {
    assert.ok(html.includes(status),
      `eval-set-drift.html must surface drift status "${status}"`);
  }
});

test('13. research/eval-set-drift.html enumerates all six DEFAULT_TOLERANCES axes', () => {
  const html = read(R_DRIFT);
  for (const axis of ['eval_score', 'k_score.composite', 'external_holdout_hash',
    'tenant_shadow_corpus_hash', 'artifact_hash']) {
    assert.ok(html.includes(axis),
      `eval-set-drift.html must name tolerance axis "${axis}"`);
  }
  // k_score.<axis> is escaped on the page as either &lt;axis&gt; or rendered literally
  assert.ok(html.includes('k_score.&lt;axis&gt;') || html.includes('k_score.<axis>') ||
    html.includes('k_score.accuracy'),
    'eval-set-drift.html must surface the per-K-axis tolerance');
});

test('14. research/eval-set-drift.html enumerates the six SUPERSESSION_REASONS', () => {
  const html = read(R_DRIFT);
  for (const reason of ['drift_detected', 'scheduled_rebuild', 'security_patch',
    'recipe_revision', 'policy_change', 'tenant_request']) {
    assert.ok(html.includes(reason),
      `eval-set-drift.html must name supersession reason "${reason}"`);
  }
});

test('15. research/eval-set-drift.html surfaces drift CLI verbs', () => {
  const html = read(R_DRIFT);
  for (const cmd of ['kolm drift detect', 'kolm drift cron', 'kolm compile --supersession-of']) {
    assert.ok(html.includes(cmd),
      `eval-set-drift.html must surface CLI verb "${cmd}"`);
  }
});

test('16. research/eval-set-drift.html cites verifier checks #23 + #24', () => {
  const html = read(R_DRIFT);
  assert.ok(html.includes('#23') && html.includes('#24'),
    'eval-set-drift.html must reference verifier checks #23 (supersession) + #24 (drift report)');
});

test('17. research/eval-set-drift.html cross-links /drift', () => {
  const html = read(R_DRIFT);
  assert.ok(html.includes('href="/drift"'),
    'eval-set-drift.html detector section must cross-link /drift');
});

test('18. research/eval-set-drift.html surfaces the drift-report-v1 + drift-snapshot-v1 spec versions', () => {
  const html = read(R_DRIFT);
  assert.ok(html.includes('drift-report-v1'),
    'eval-set-drift.html must reference drift-report-v1 spec');
  assert.ok(html.includes('drift-snapshot-v1'),
    'eval-set-drift.html must reference drift-snapshot-v1 spec');
});

test('19. sw.js CACHE bumped to wave173 or later slug', () => {
  const sw = read(SW);
  const m = sw.match(/const CACHE = 'kolm-v7-\d{4}-\d{2}-\d{2}-wave(\d+)-/);
  assert.ok(m, 'sw.js must declare a kolm-v7-YYYY-MM-DD-wave<N>- CACHE constant');
  assert.ok(Number(m[1]) >= 173,
    `sw.js CACHE wave segment must be >= 173 (saw wave${m[1]})`);
});

test('20. All 5 refreshed surfaces still declare their canonical URLs', () => {
  for (const [p, expected] of [
    [HC_ARCH, '/healthcare/architecture'],
    [HC_ASSESS, '/healthcare/assessment'],
    [R_RECEIPT, '/research/receipt-chains'],
    [R_PROV, '/research/provenance-data-generation'],
    [R_DRIFT, '/research/eval-set-drift'],
  ]) {
    const html = read(p);
    assert.ok(html.includes(`href="https://kolm.ai${expected}"`),
      `${path.basename(p)} must declare canonical https://kolm.ai${expected}`);
  }
});
