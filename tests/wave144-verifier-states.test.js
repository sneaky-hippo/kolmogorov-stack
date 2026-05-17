// Wave 144 V — Verifier integration for capability / lineage / workflow_ir /
// confidential-compute attestation states. These tests exercise the four
// checks added to src/binder.js#verifyArtifact:
//
//   #8  Capability contract       — re-validates hash + surfaces requirements
//   #9  Lineage block              — re-validates hash + surfaces pointers
//   #10 Workflow IR recompute      — hashIr() must match lineage.workflow_ir_hash
//   #11 Attestation state          — state >= SHAPE_OK, kind matches, etc.
//
// The user redirect for Wave 144 says "Do not let metadata-only features
// satisfy production-ready gate." The tests assert that:
//   - hash drift on capability/lineage produces fail (not warn)
//   - an IR-hash claim with no IR bundled is fail (not warn)
//   - requires_confidential_compute=true without a block is fail
//   - SHAPE_OK is warn (downgraded — only crypto-verified counts)
//   - kind mismatch between capability and confidential_compute is fail

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import archiver from 'archiver';

import { buildAndZip } from '../src/artifact.js';
import { buildBinder } from '../src/binder.js';
import { buildCapability, buildLineage } from '../src/artifact-lineage.js';
import { hashIr } from '../src/workflow-ir.js';
import {
  registerAttestationVerifier,
  clearAttestationVerifier,
  KINDS,
  STATES,
} from '../src/confidential-compute.js';

process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';

const TMP = path.join(os.tmpdir(), 'kolm-wave144-verifier-states-' + crypto.randomBytes(3).toString('hex'));
fs.mkdirSync(TMP, { recursive: true });

function namedCheck(checks, name) {
  return checks.find(c => c.name === name);
}

// Echo recipe — minimal valid rule-class artifact for these tests.
function baseSpec(overrides = {}) {
  return {
    job_id: 'job_v_' + crypto.randomBytes(3).toString('hex'),
    task: 'wave144_verifier_states',
    base_model: 'none',
    recipes: [{
      id: 'rcp', name: 'echo',
      source: 'function generate(i){ return { echo: String(i && i.text || i) }; }',
      source_hash: 'deadbeef', version_id: 1, tags: [],
    }],
    training_stats: { distilled_pairs: 0, pass_rate_positive: 1, latency_p50_us: 50, cost_usd_per_call: 0 },
    evals: { spec: 'rs-1-evals', n: 0, cases: [] },
    outDir: TMP,
    artifact_class: 'rule',
    ...overrides,
  };
}

// Minimal valid IR — one INPUT, one OUTPUT, one edge.
function tinyIr() {
  return {
    spec: 'wir-v1',
    nodes: [
      { id: 'in', kind: 'input', schema: { text: 'string' } },
      { id: 'out', kind: 'output', value: { ref: 'in' } },
    ],
    edges: [{ from: 'in', to: 'out' }],
    seeds: [],
  };
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

// Wave V — when a test tampers a manifest field, the artifact's signature.sig
// and receipt.json must be re-signed with RECIPE_RECEIPT_SECRET or
// loadArtifact's manifest_hash check catches the tamper before the verifier's
// per-block hash check fires. resignManifest does the minimum re-derivation:
// new manifest_hash + new HMAC over the canonical signature payload. We keep
// the rest of the signature fields (artifact_hash, eval_set_hash, judge_id)
// from the original signature — the test is isolating the capability/lineage
// hash check, not the artifact_hash check.
function resignManifest(api) {
  const secret = process.env.RECIPE_RECEIPT_SECRET;
  const manifestText = api.readAsText('manifest.json');
  const newManifestHash = crypto.createHash('sha256').update(Buffer.from(manifestText)).digest('hex');
  const sig = JSON.parse(api.readAsText('signature.sig'));
  sig.manifest_hash = newManifestHash;
  const payload = canonicalJson({
    spec: sig.spec,
    manifest_hash: newManifestHash,
    job_id: sig.job_id,
    artifact_hash: sig.artifact_hash,
    eval_set_hash: sig.eval_set_hash,
    eval_score: sig.eval_score,
    judge_id: sig.judge_id,
  });
  sig.hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  api.updateFile('signature.sig', JSON.stringify(sig, null, 2));
}

// Wave V — manipulate a built .kolm zip in-place. Used to forge the
// "claim without bundle" and "tampered IR" failure cases that buildPayload
// itself refuses to produce. We use archiver (not AdmZip.writeZip) to
// repackage because the original zip was emitted by archiver with CRC data
// descriptors that adm-zip's writer strips — re-encoding via archiver keeps
// loadArtifact's reader happy.
async function rewriteZip(zipPath, mutator) {
  const zip = new AdmZip(zipPath);
  const entries = new Map();
  for (const e of zip.getEntries()) {
    entries.set(e.entryName, e.getData());
  }
  // mutator can update/delete entries via a small surface API.
  const api = {
    readAsText: (name) => entries.has(name) ? entries.get(name).toString('utf8') : null,
    updateFile: (name, buf) => entries.set(name, Buffer.isBuffer(buf) ? buf : Buffer.from(buf)),
    deleteFile: (name) => entries.delete(name),
  };
  await mutator(api);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const z = archiver('zip', { zlib: { level: 9 } });
    z.on('warning', (e) => { if (e.code !== 'ENOENT') reject(e); });
    z.on('error', reject);
    out.on('close', resolve);
    z.pipe(out);
    for (const [name, buf] of entries) {
      z.append(buf, { name });
    }
    z.finalize();
  });
}

// ─── #8 Capability contract ────────────────────────────────────────────────

test('capability contract: passes when block validates clean', async () => {
  const cap = buildCapability({
    min_vram_gb: 8,
    runtimes: ['llama-cpp', 'mlc-llm'],
    modalities: ['text'],
  });
  const built = await buildAndZip({ ...baseSpec(), capability: cap });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Capability contract');
  assert.ok(c, 'capability check present');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /vram>=8GB/);
  assert.match(c.detail, /runtimes:llama-cpp\|mlc-llm/);
});

test('capability contract: fails when hash has been tampered', async () => {
  const cap = buildCapability({ min_vram_gb: 8, runtimes: ['llama-cpp'] });
  const built = await buildAndZip({ ...baseSpec(), capability: cap });
  // Tamper with the manifest's capability.hash after build by rewriting the zip.
  await rewriteZip(built.outPath, (zip) => {
    const m = JSON.parse(zip.readAsText('manifest.json'));
    m.capability.hash = '0000000000000000';
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(m, null, 2)));
    resignManifest(zip);
  });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Capability contract');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /hash mismatch/);
});

test('capability contract: omitted block means no check (back-compat)', async () => {
  const built = await buildAndZip(baseSpec());
  const r = await buildBinder(built.outPath);
  // Pre-Wave-144 artifacts skip this check entirely.
  assert.equal(namedCheck(r.checks, 'Capability contract'), undefined);
});

// ─── #9 Lineage block ───────────────────────────────────────────────────────

test('lineage block: passes when source=rule_synthesis and hash validates', async () => {
  const lin = buildLineage({
    source: 'rule_synthesis',
    notes: 'wave-144-v-test',
  });
  const built = await buildAndZip({ ...baseSpec(), lineage: lin });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Lineage block');
  assert.ok(c, 'lineage check present');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /source=rule_synthesis/);
});

test('lineage block: fails when hash has been tampered', async () => {
  const lin = buildLineage({ source: 'rule_synthesis' });
  const built = await buildAndZip({ ...baseSpec(), lineage: lin });
  await rewriteZip(built.outPath, (zip) => {
    const m = JSON.parse(zip.readAsText('manifest.json'));
    m.lineage.hash = '0000000000000000';
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(m, null, 2)));
    resignManifest(zip);
  });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Lineage block');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /hash mismatch/);
});

// ─── #10 Workflow IR recompute ──────────────────────────────────────────────

test('workflow IR recompute: passes when bundled IR hashes to lineage.workflow_ir_hash', async () => {
  const ir = tinyIr();
  const irHash = hashIr(ir);
  const traceId = crypto.randomBytes(16).toString('hex'); // hex32
  const lin = buildLineage({
    source: 'workflow_compile',
    workflow_ir_hash: irHash,
    source_trace_ids: [traceId],
  });
  const built = await buildAndZip({ ...baseSpec(), lineage: lin, workflow_ir: ir });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Workflow IR recompute');
  assert.ok(c, 'IR recompute check present');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /IR recompute matches/);
});

test('workflow IR recompute: buildPayload refuses to build when claim has no IR', async () => {
  // The build-time guard (artifact.js:252) catches this case up-front so a
  // metadata-only claim never reaches the verifier.
  const ir = tinyIr();
  const irHash = hashIr(ir);
  const traceId = crypto.randomBytes(16).toString('hex');
  const lin = buildLineage({
    source: 'workflow_compile',
    workflow_ir_hash: irHash,
    source_trace_ids: [traceId],
  });
  await assert.rejects(
    () => buildAndZip({ ...baseSpec(), lineage: lin /* no workflow_ir */ }),
    /no workflow_ir was supplied/,
  );
});

test('workflow IR recompute: fails at verify time when IR file is missing from a sealed zip', async () => {
  // Force the failure case by building cleanly then stripping workflow_ir.json
  // from the zip after the fact. The verifier must catch this.
  const ir = tinyIr();
  const irHash = hashIr(ir);
  const traceId = crypto.randomBytes(16).toString('hex');
  const lin = buildLineage({
    source: 'workflow_compile',
    workflow_ir_hash: irHash,
    source_trace_ids: [traceId],
  });
  const built = await buildAndZip({ ...baseSpec(), lineage: lin, workflow_ir: ir });
  await rewriteZip(built.outPath, (zip) => zip.deleteFile('workflow_ir.json'));
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Workflow IR recompute');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /workflow_ir\.json is not bundled/);
});

test('workflow IR recompute: fails when bundled IR no longer matches the claimed hash', async () => {
  const ir = tinyIr();
  const irHash = hashIr(ir);
  const traceId = crypto.randomBytes(16).toString('hex');
  const lin = buildLineage({
    source: 'workflow_compile',
    workflow_ir_hash: irHash,
    source_trace_ids: [traceId],
  });
  const built = await buildAndZip({ ...baseSpec(), lineage: lin, workflow_ir: ir });
  // Swap the IR file for a structurally-valid but differently-hashing IR.
  await rewriteZip(built.outPath, (zip) => {
    const swapped = {
      spec: 'wir-v1',
      nodes: [
        { id: 'in', kind: 'input', schema: { other: 'string' } },
        { id: 'tool', kind: 'tool', fn: 'noop', args: {} },
        { id: 'out', kind: 'output', value: { ref: 'tool' } },
      ],
      edges: [{ from: 'in', to: 'tool' }, { from: 'tool', to: 'out' }],
      seeds: [],
    };
    zip.updateFile('workflow_ir.json', Buffer.from(JSON.stringify(swapped, null, 2)));
  });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Workflow IR recompute');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /IR recompute mismatch/);
});

// ─── #11 Attestation state ──────────────────────────────────────────────────
//
// Build a fixture SEV-SNP report that satisfies the SHAPE_OK requirements
// (REPORT_SHAPES[KINDS.SNP].required + types). Hex lengths match the spec.

function fixtureSnpReport() {
  return {
    version: 2,
    guest_svn: 1,
    policy: 'aabbccdd',
    family_id: crypto.randomBytes(16).toString('hex'),       // hex32
    image_id: crypto.randomBytes(16).toString('hex'),        // hex32
    measurement: crypto.randomBytes(48).toString('hex'),     // hex96
    host_data: crypto.randomBytes(32).toString('hex'),       // hex64
    id_key_digest: crypto.randomBytes(48).toString('hex'),   // hex96
    author_key_digest: crypto.randomBytes(48).toString('hex'),
    report_data: crypto.randomBytes(64).toString('hex'),     // hex128
    chip_id: crypto.randomBytes(64).toString('hex'),
    signature: crypto.randomBytes(96).toString('hex'),
  };
}

test('attestation state: fails when capability.requires_cc=true but no block in manifest', async () => {
  // No attestation_report supplied → buildPayload emits an UNVERIFIED block
  // for the verifier to fail on.
  const cap = buildCapability({
    requires_confidential_compute: true,
    attestation: 'snp-report',
  });
  const built = await buildAndZip({ ...baseSpec(), capability: cap });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Attestation state');
  assert.ok(c, 'attestation check present');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /state=unverified/i);
});

test('attestation state: fails when capability.attestation kind differs from block kind', async () => {
  // Build with capability claiming snp-report, then swap the manifest's
  // confidential_compute.kind to a different value to simulate a malformed
  // build. The verifier must catch the divergence.
  const cap = buildCapability({
    requires_confidential_compute: true,
    attestation: 'snp-report',
  });
  const report = fixtureSnpReport();
  const built = await buildAndZip({
    ...baseSpec(),
    capability: cap,
    attestation_report: report,
  });
  await rewriteZip(built.outPath, (zip) => {
    const m = JSON.parse(zip.readAsText('manifest.json'));
    m.confidential_compute.kind = 'pccs';
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(m, null, 2)));
    // Also remove the bundled report so the verifier doesn't re-verify and
    // overwrite our forged kind drift.
    zip.deleteFile('attestation_report.json');
    resignManifest(zip);
  });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Attestation state');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /kind mismatch/i);
});

test('attestation state: warns when shape-only (SHAPE_OK) with no registered verifier', async () => {
  clearAttestationVerifier(KINDS.SNP); // ensure no verifier registered
  const cap = buildCapability({
    requires_confidential_compute: true,
    attestation: 'snp-report',
  });
  const report = fixtureSnpReport();
  const built = await buildAndZip({
    ...baseSpec(),
    capability: cap,
    attestation_report: report,
  });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Attestation state');
  assert.equal(c.status, 'warn', c.detail);
  assert.match(c.detail, /shape-only/);
});

test('attestation state: passes when registered verifier returns cryptographically_verified', async () => {
  registerAttestationVerifier(KINDS.SNP, async (_report) => ({
    ok: true,
    verifier: 'wave144_test_stub',
    trust_root: 'amd_test_ca',
    not_after: '2099-01-01T00:00:00Z',
    cert_chain_length: 3,
  }));
  try {
    const cap = buildCapability({
      requires_confidential_compute: true,
      attestation: 'snp-report',
    });
    const report = fixtureSnpReport();
    const built = await buildAndZip({
      ...baseSpec(),
      capability: cap,
      attestation_report: report,
    });
    const r = await buildBinder(built.outPath);
    const c = namedCheck(r.checks, 'Attestation state');
    assert.equal(c.status, 'pass', c.detail);
    assert.match(c.detail, /cryptographically verified/);
    assert.match(c.detail, /verifier=wave144_test_stub/);
    assert.match(c.detail, /root=amd_test_ca/);
  } finally {
    clearAttestationVerifier(KINDS.SNP);
  }
});

test('attestation state: fails when REJECTED (shape check failed)', async () => {
  // Build with a malformed report — verifyAttestation returns state=REJECTED.
  const cap = buildCapability({
    requires_confidential_compute: true,
    attestation: 'snp-report',
  });
  const bogus = { version: 2 /* missing required fields */ };
  const built = await buildAndZip({
    ...baseSpec(),
    capability: cap,
    attestation_report: bogus,
  });
  const r = await buildBinder(built.outPath);
  const c = namedCheck(r.checks, 'Attestation state');
  assert.equal(c.status, 'fail', c.detail);
  assert.match(c.detail, /state=rejected/i);
});

test('attestation state: skipped entirely when capability does not require cc', async () => {
  // requires_confidential_compute is omitted → no attestation check fires.
  const cap = buildCapability({ min_vram_gb: 8 });
  const built = await buildAndZip({ ...baseSpec(), capability: cap });
  const r = await buildBinder(built.outPath);
  assert.equal(namedCheck(r.checks, 'Attestation state'), undefined);
});

test('STATES export shape matches manifest values', () => {
  // Guardrail: if the constants drift the verifier comparisons would silently
  // mis-classify states. Lock them.
  assert.equal(STATES.UNVERIFIED, 'unverified');
  assert.equal(STATES.SHAPE_OK, 'shape_ok');
  assert.equal(STATES.CRYPTOGRAPHICALLY_VERIFIED, 'cryptographically_verified');
  assert.equal(STATES.REJECTED, 'rejected');
});
