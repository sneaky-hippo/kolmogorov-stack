// Wave 168 — Q+11 RS-1 spec rewrite reconciliation. Locks in the v2.1
// guarantees from the Wave 144 plan + this wave's reconciliation pass:
// every §7.X subsection is grounded in a shipping wave; every K-score axis
// in §6 points at an implementation-confirmed mechanism; no "wave forthcoming"
// marker remains outside the provenance note's quoted historical reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SPEC_PATH = path.join(REPO, 'public', 'spec', 'rs-1.html');
const SPEC = fs.readFileSync(SPEC_PATH, 'utf8');

test('1. spec stamp is v2.1 (Q+11 reconciliation)', () => {
  assert.match(SPEC, /<h1>RS-1 v2\.1:/);
  assert.match(SPEC, /<p class="stamp">v2\.1 \. 2026-05-17 \. supersedes v2\.0/);
});

test('2. provenance note explains the v2.1 reconciliation', () => {
  assert.match(SPEC, /Provenance note \(v2\.1 reconciliation\)/);
  assert.match(SPEC, /Q\+11 reconciliation track from the Wave 144 plan/);
  assert.match(SPEC, /every numbered subsection in §7 is now grounded in a shipping wave/);
});

test('3. no stale "wave forthcoming" markers outside the provenance note', () => {
  // The only allowed occurrence of "wave forthcoming" is the verbatim quoted
  // historical reference inside the provenance note explaining what v2.0 said.
  const lines = SPEC.split('\n');
  const occurrences = lines
    .map((line, idx) => ({ line, idx: idx + 1 }))
    .filter(({ line }) => /wave forthcoming|forthcoming wave/i.test(line));
  // Allow only the provenance note line (single quoted historical reference).
  const offending = occurrences.filter(({ line }) =>
    !/Provenance note \(v2\.1 reconciliation\)/.test(line));
  assert.equal(offending.length, 0,
    `stale "forthcoming" markers outside provenance note:\n${offending.map(o => `  L${o.idx}: ${o.line.trim().slice(0, 200)}`).join('\n')}`);
});

test('4. §7.1 PHI redactor + §7.2 cross-vendor distillation now stamped with implementing waves', () => {
  assert.match(SPEC, /<h3>7\.1 PHI\/PII redactor \(Q\+3a, wave 157\)<\/h3>/);
  assert.match(SPEC, /<h3>7\.2 Cross-vendor distillation \(Q\+3b, wave 158\)<\/h3>/);
});

test('5. K-score axis R (real-world independence) cites wave 164 + §7.12', () => {
  // Pulls the R bullet line and asserts it names wave 164 + cross-references §7.12.
  const m = SPEC.match(/<li><b>R \. Real-world independence<\/b>[^<]*(?:<[^<]+>[^<]*)*<\/li>/);
  assert.ok(m, 'R-axis bullet must exist');
  assert.match(m[0], /wave 164/);
  assert.match(m[0], /§7\.12|&sect;7\.12/);
});

test('6. K-score axis Z (drift) cites wave 167 + §7.15', () => {
  const m = SPEC.match(/<li><b>Z \. Drift<\/b>[^<]*(?:<[^<]+>[^<]*)*<\/li>/);
  assert.ok(m, 'Z-axis bullet must exist');
  assert.match(m[0], /wave 167/);
  assert.match(m[0], /§7\.15|&sect;7\.15/);
});

test('7. every §7.X subsection from 7.3 through 7.15 carries a wave stamp', () => {
  // Heading shape: <h3>7.N[.M] Title (... wave NNN[, track]) </h3>
  // §7.1 + §7.2 are overviews stamped with W157/W158; §7.3 onward each
  // names its implementing wave directly. Locked here to prevent regressions.
  const headings = [...SPEC.matchAll(/<h3>(7\.[0-9]+(?:\.[0-9]+)?)\s+([^<]+)<\/h3>/g)]
    .map(m => ({ id: m[1], title: m[2].trim() }));
  // At least 15 subsections (7.1 .. 7.15 + a couple .x).
  assert.ok(headings.length >= 15, `expected >= 15 §7.X subsections, got ${headings.length}`);
  const missingWave = headings.filter(h => !/wave\s*\d+/i.test(h.title));
  assert.equal(missingWave.length, 0,
    `subsections without wave stamp:\n${missingWave.map(h => `  ${h.id} ${h.title}`).join('\n')}`);
});

test('8. K-score implication block for cross-vendor distillation cites wave 160', () => {
  // Was "(forthcoming wave 159, Q+3c)" pre-Wave-168; reconciled to wave 160.
  assert.match(SPEC, /K-score implication[^<]*shipped in wave 160[^<]*Q\+3c/);
  assert.doesNotMatch(SPEC, /forthcoming wave 159/);
});

test('9. Sigstore §7.10 reference is stamped, not "forthcoming"', () => {
  // Was "Sigstore (Wave 162, §7.10 forthcoming)" pre-Wave-168.
  assert.doesNotMatch(SPEC, /§7\.10 forthcoming|&sect;7\.10 forthcoming/);
  assert.match(SPEC, /Sigstore \(Wave 162, [§&]/);
});

test('10. canonical sections 1-13 all present and ordered', () => {
  const expected = [
    /<h2>1\. Motivation<\/h2>/,
    /<h2>2\. The four recipe classes<\/h2>/,
    /<h2>3\. The artifact layout<\/h2>/,
    /<h2>4\. Eval independence/,
    /<h2>5\. Receipt chain/,
    /<h2>6\. The K-score<\/h2>/,
    /<h2>7\. Manifest extensions<\/h2>/,
    /<h2>8\. Threat model<\/h2>/,
    /<h2>9\. Reference implementations<\/h2>/,
    /<h2>10\. Adoption path<\/h2>/,
    /<h2>11\. Related work<\/h2>/,
    /<h2>12\. Conclusion<\/h2>/,
    /<h2>13\. Citations<\/h2>/,
  ];
  let lastIdx = 0;
  for (const rx of expected) {
    const m = SPEC.slice(lastIdx).search(rx);
    assert.notEqual(m, -1, `missing or out-of-order section: ${rx}`);
    lastIdx += m + 1;
  }
});

test('11. every wave 157-167 stamp resolves to a real spec subsection', () => {
  // Inverse coverage: confirm the spec actually cites every wave shipped
  // in the Wave 144 production track (157=Q+3a, 158=Q+3b, 160=Q+3c, 161=Q+8,
  // 162=Q+9, 163=P+6, 164=N+3/N+4, 165=N+5, 166=N+7, 167=M+3/M+4).
  const required = [157, 158, 160, 161, 162, 163, 164, 165, 166, 167];
  for (const w of required) {
    const rx = new RegExp(`wave\\s*${w}\\b`, 'i');
    assert.match(SPEC, rx, `RS-1 must cite wave ${w} at least once`);
  }
});

test('12. receipt chain narrative is current (includes supersession + drift_report)', () => {
  // The Wave 167 §7.15 receipt-chain extension is now the canonical chain
  // order. Lock it in here so a future edit that drops a layer fails this test.
  const chain = /spec\s*[→-]+\s*seeds\s*[→-]+\s*split\s*[→-]+\s*train\s*[→-]+\s*recipes\s*[→-]+\s*evals\s*[→-]+\s*external_holdout\s*[→-]+\s*tenant_shadow\s*[→-]+\s*auditor_attestation\s*[→-]+\s*supersession\s*[→-]+\s*drift_report\s*[→-]+\s*export\s*[→-]+\s*signatures\s*[→-]+\s*rekor/;
  assert.match(SPEC, chain, 'canonical receipt chain narrative must include supersession + drift_report');
});
