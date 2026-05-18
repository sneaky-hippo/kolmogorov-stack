// W237 — Multi-node Tailscale mesh + GKE-scale recipe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function modUrl(rel) {
  return pathToFileURL(path.join(ROOT, rel)).href;
}

const FAKE_NODES = [
  { hostname: 'kolm-coord', addrs: ['100.64.0.1'], os: 'linux',  online: true,  is_self: true },
  { hostname: 'kolm-gpu-1', addrs: ['100.64.0.2'], os: 'linux',  online: true },
  { hostname: 'kolm-gpu-2', addrs: ['100.64.0.3'], os: 'linux',  online: true },
  { hostname: 'kolm-mac',   addrs: ['100.64.0.4'], os: 'darwin', online: true },
  { hostname: 'kolm-old',   addrs: ['100.64.0.5'], os: 'linux',  online: false },
];

test('W237 mesh module exports the public surface', async () => {
  const m = await import(modUrl('src/mesh.js'));
  for (const n of ['MESH_PLAN_SCHEMA_VERSION', 'NODE_ROLES',
                   'discoverNodes', 'clusterPlan', 'validateClusterPlan',
                   'toTailscaleShellScript', 'toK8sManifests', 'manifestsToYaml']) {
    assert.ok(n in m, `missing export ${n}`);
  }
});

test('W237 NODE_ROLES contains coordinator/inference/capture/mentor/auditor', async () => {
  const m = await import(modUrl('src/mesh.js'));
  for (const r of ['coordinator', 'inference', 'capture', 'mentor', 'auditor']) {
    assert.ok(m.NODE_ROLES.includes(r), `missing role ${r}`);
  }
});

test('W237 discoverNodes returns honest error when tailscale missing', async () => {
  const m = await import(modUrl('src/mesh.js'));
  const out = m.discoverNodes({ cmd: 'this-command-does-not-exist-9999' });
  assert.ok(out.error, 'must surface error');
  assert.deepEqual(out.nodes, []);
});

test('W237 clusterPlan throws on missing artifact', async () => {
  const m = await import(modUrl('src/mesh.js'));
  assert.throws(() => m.clusterPlan({ nodes: FAKE_NODES }), /artifact\.name required/);
});

test('W237 clusterPlan throws on no nodes', async () => {
  const m = await import(modUrl('src/mesh.js'));
  assert.throws(() => m.clusterPlan({ artifact: { name: 'x.kolm' }, nodes: [] }), /nodes required/);
});

test('W237 clusterPlan throws when no nodes are online', async () => {
  const m = await import(modUrl('src/mesh.js'));
  const offline = FAKE_NODES.map(n => ({ ...n, online: false }));
  assert.throws(() => m.clusterPlan({ artifact: { name: 'x.kolm' }, nodes: offline }), /no online nodes/);
});

test('W237 clusterPlan assigns coordinator + inference + capture roles', async () => {
  const m = await import(modUrl('src/mesh.js'));
  const plan = m.clusterPlan({
    artifact: { name: 'phi-redactor.kolm', hash: 'sha256-abc' },
    nodes: FAKE_NODES,
    replicas: 3,
  });
  assert.equal(plan.artifact.name, 'phi-redactor.kolm');
  const roles = plan.assignments.map(a => a.role);
  assert.ok(roles.includes('coordinator'));
  assert.equal(roles.filter(r => r === 'inference').length, 3, 'must have 3 inference replicas');
  assert.ok(roles.includes('capture'));
  assert.match(plan.integrity_hash, /^[0-9a-f]{64}$/);
});

test('W237 validateClusterPlan accepts freshly built plan', async () => {
  const m = await import(modUrl('src/mesh.js'));
  const plan = m.clusterPlan({
    artifact: { name: 'phi-redactor.kolm' },
    nodes: FAKE_NODES,
    replicas: 2,
  });
  const r = m.validateClusterPlan(plan);
  assert.equal(r.ok, true, `unexpected: ${JSON.stringify(r.problems)}`);
});

test('W237 validateClusterPlan catches tampering', async () => {
  const m = await import(modUrl('src/mesh.js'));
  const plan = m.clusterPlan({ artifact: { name: 'x.kolm' }, nodes: FAKE_NODES });
  const bad = { ...plan, replicas: 99 };
  const r = m.validateClusterPlan(bad);
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('hash_mismatch'));
});

test('W237 toTailscaleShellScript emits a bash script per assignment', async () => {
  const m = await import(modUrl('src/mesh.js'));
  const plan = m.clusterPlan({ artifact: { name: 'phi-redactor.kolm' }, nodes: FAKE_NODES, replicas: 2 });
  const script = m.toTailscaleShellScript(plan);
  assert.ok(script.startsWith('#!/usr/bin/env bash'));
  assert.ok(script.includes('tailscale ssh'));
  for (const a of plan.assignments) {
    assert.ok(script.includes(a.node), `script missing node ${a.node}`);
    assert.ok(script.includes(`:${a.port}`) || script.includes(`port ${a.port}`),
      `script missing port for ${a.role}`);
  }
});

test('W237 toK8sManifests emits one Deployment + Service per role plus ConfigMap', async () => {
  const m = await import(modUrl('src/mesh.js'));
  const plan = m.clusterPlan({ artifact: { name: 'phi-redactor.kolm', hash: 'sha256-xyz' }, nodes: FAKE_NODES, replicas: 2 });
  const manifests = m.toK8sManifests(plan, { namespace: 'kolm-test', image: 'my/kolm:1.0' });
  const kinds = manifests.map(m => m.kind);
  assert.ok(kinds.includes('ConfigMap'));
  assert.ok(kinds.includes('Deployment'));
  assert.ok(kinds.includes('Service'));
  // All resources land in the chosen namespace.
  for (const m of manifests) assert.equal(m.metadata.namespace, 'kolm-test');
  // Coordinator Service is LoadBalancer for external traffic.
  const coordSvc = manifests.find(m => m.kind === 'Service' && m.metadata.name === 'kolm-coordinator');
  assert.equal(coordSvc.spec.type, 'LoadBalancer');
});

test('W237 manifestsToYaml emits multi-document YAML stream', async () => {
  const m = await import(modUrl('src/mesh.js'));
  const plan = m.clusterPlan({ artifact: { name: 'x.kolm' }, nodes: FAKE_NODES });
  const manifests = m.toK8sManifests(plan);
  const yaml = m.manifestsToYaml(manifests);
  assert.ok(yaml.startsWith('---'));
  assert.ok(yaml.includes('apiVersion:'));
  assert.ok(yaml.includes('kind:'));
  // Separator between documents.
  const docSep = yaml.match(/\n---\n/g);
  assert.ok(docSep && docSep.length >= manifests.length - 1, 'must separate documents');
});

test('W237 CLI wires mesh verb + 5 subcommands + HELP block', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
  assert.ok(src.includes("case 'mesh':"), 'dispatch missing case mesh');
  assert.ok(src.includes('async function cmdMesh'), 'cmdMesh not defined');
  for (const sub of ["'discover'", "'plan'", "'deploy'", "'k8s'", "'validate'"]) {
    assert.ok(src.includes(sub), `cmdMesh must handle ${sub}`);
  }
  assert.ok(src.includes('mesh:'), 'HELP must include mesh block');
});

test('W237 COMPLETION_VERBS and COMPLETION_SUBS include mesh', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/kolm.js'), 'utf8');
  const cidx = src.indexOf('COMPLETION_VERBS');
  const tail = src.slice(cidx, cidx + 2000);
  assert.ok(tail.includes("'mesh'"), 'COMPLETION_VERBS missing mesh');
  assert.ok(src.includes("mesh:    ['discover'"), 'COMPLETION_SUBS missing mesh subverbs');
});
