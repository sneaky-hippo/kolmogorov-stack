// W237 — Multi-node Tailscale mesh + GKE-scale recipe.
//
// Two concerns:
//
//   1. Tailscale mesh: a fleet of devices on the same tailnet, each running
//      kolm. We discover the mesh via `tailscale status --json`, plan which
//      node gets which role (coordinator / inference / capture / mentor) and
//      ship a JSON deployment plan the user can inspect before executing.
//      Deployment uses `tailscale ssh` to run kolm verbs on each node — no
//      bespoke control plane, no agent installed, just SSH over the tailnet.
//
//   2. GKE-scale recipe: the SAME plan transpiles to Kubernetes manifests
//      (Deployments + Services + ConfigMaps). Single box -> tailnet of 4 ->
//      GKE/EKS cluster of N is one continuum of the same JSON plan, not three
//      separate scaling stories.
//
// Honest scope: kolm produces the plan + manifests. We do not maintain the
// cluster, fork a daemon, or attempt to be a service mesh. The plan is the
// contract; tenant owns the runtime (tailnet | kubectl | helm | terraform).

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const MESH_PLAN_SCHEMA_VERSION = '1.0.0';

export const NODE_ROLES = ['coordinator', 'inference', 'capture', 'mentor', 'auditor'];

// Discover Tailscale-mesh nodes. Calls `tailscale status --json` and parses
// the result. Returns [{ hostname, addrs[], os, online, tags[] }, ...] or
// { error } if tailscale is not installed / not logged in.
export function discoverNodes(opts = {}) {
  const cmd = opts.cmd || 'tailscale';
  const r = spawnSync(cmd, ['status', '--json'], { encoding: 'utf8' });
  if (r.error) return { error: `${cmd} not found: ${r.error.message}`, nodes: [] };
  if (r.status !== 0) {
    return { error: `${cmd} status failed (exit ${r.status}): ${(r.stderr || '').trim()}`, nodes: [] };
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout || '{}'); }
  catch (e) { return { error: `parse error: ${e.message}`, nodes: [] }; }
  const peers = Object.values(parsed.Peer || {});
  const self = parsed.Self ? [parsed.Self] : [];
  const all = [...self, ...peers];
  const nodes = all.map(n => ({
    hostname: n.HostName || n.DNSName || 'unknown',
    addrs: n.TailscaleIPs || [],
    os: n.OS || 'unknown',
    online: !!n.Online,
    tags: n.Tags || [],
    is_self: !!n.IsSelf,
  }));
  return { nodes };
}

// Build a deployment plan. Inputs:
//   - artifact: { name, hash, recipe_classes } — the .kolm to ship
//   - nodes:    [{ hostname, addrs, ... }] — output of discoverNodes() or hand-supplied
//   - opts:     { replicas, mentor_node, capture_node }
//
// Output: { schema_version, plan_id, artifact, assignments: [{node, role, port}], ... }
export function clusterPlan({ artifact, nodes, replicas = 2, mentor_node = null, capture_node = null } = {}) {
  if (!artifact || !artifact.name) throw new Error('clusterPlan: artifact.name required');
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('clusterPlan: nodes required');
  const online = nodes.filter(n => n.online !== false);
  if (online.length === 0) throw new Error('clusterPlan: no online nodes');
  const plan_id = 'plan_' + crypto.randomBytes(6).toString('hex');
  const assignments = [];
  // Coordinator: first online node.
  assignments.push({ node: online[0].hostname, role: 'coordinator', port: 7470 });
  // Inference replicas: round-robin across remaining online nodes (or all if 1 node).
  const inferencePool = online.length > 1 ? online.slice(1) : online;
  for (let i = 0; i < replicas; i++) {
    const n = inferencePool[i % inferencePool.length];
    assignments.push({ node: n.hostname, role: 'inference', port: 7480 + i });
  }
  // Capture: dedicated node if provided, else coordinator co-located.
  const cap = capture_node ? online.find(n => n.hostname === capture_node) : online[0];
  if (cap) assignments.push({ node: cap.hostname, role: 'capture', port: 7490 });
  // Mentor: optional dedicated node for teacher-model serving.
  if (mentor_node) {
    const m = online.find(n => n.hostname === mentor_node);
    if (m) assignments.push({ node: m.hostname, role: 'mentor', port: 7495 });
  }
  const body = {
    schema_version: MESH_PLAN_SCHEMA_VERSION,
    plan_id,
    created_at: new Date().toISOString(),
    artifact: { name: artifact.name, hash: artifact.hash || null, recipe_classes: artifact.recipe_classes || [] },
    node_count: online.length,
    replicas,
    assignments,
    network: 'tailnet',
  };
  const canonical = JSON.stringify(body);
  const integrity_hash = crypto.createHash('sha256').update(canonical).digest('hex');
  return { ...body, integrity_hash };
}

// Validate a cluster plan. Returns { ok, problems }.
export function validateClusterPlan(plan) {
  const problems = [];
  if (!plan || typeof plan !== 'object') return { ok: false, problems: ['not_object'] };
  if (plan.schema_version !== MESH_PLAN_SCHEMA_VERSION) problems.push('bad_schema_version');
  if (!plan.plan_id || typeof plan.plan_id !== 'string') problems.push('missing_plan_id');
  if (!plan.artifact || !plan.artifact.name) problems.push('missing_artifact_name');
  if (!Array.isArray(plan.assignments) || plan.assignments.length === 0) problems.push('missing_assignments');
  if (Array.isArray(plan.assignments)) {
    for (const a of plan.assignments) {
      if (!NODE_ROLES.includes(a.role)) problems.push('bad_role:' + a.role);
      if (!a.node) problems.push('assignment_missing_node');
      if (typeof a.port !== 'number' || a.port < 1024 || a.port > 65535) problems.push('bad_port:' + a.port);
    }
    if (!plan.assignments.some(a => a.role === 'coordinator')) problems.push('missing_coordinator');
  }
  if (typeof plan.integrity_hash !== 'string' || !/^[0-9a-f]{64}$/.test(plan.integrity_hash)) {
    problems.push('bad_integrity_hash');
  } else {
    const { integrity_hash, ...rest } = plan;
    const expected = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    if (expected !== integrity_hash) problems.push('hash_mismatch');
  }
  return { ok: problems.length === 0, problems };
}

// Map a node-role to the kolm verb the runtime will exec.
function roleCommand(role, artifactName, port) {
  switch (role) {
    case 'coordinator': return `kolm coord serve --port ${port}`;
    case 'inference':   return `kolm serve ${artifactName} --port ${port}`;
    case 'capture':     return `kolm capture serve --port ${port}`;
    case 'mentor':      return `kolm mentor serve --port ${port}`;
    case 'auditor':     return `kolm auditor serve --port ${port}`;
    default:            return `# unknown role: ${role}`;
  }
}

// Emit a shell script the user can run to deploy via `tailscale ssh`.
// We do NOT execute — we emit. The user reviews and runs.
export function toTailscaleShellScript(plan) {
  const lines = [
    '#!/usr/bin/env bash',
    '# kolm mesh deploy script — auto-generated. Review before running.',
    `# plan_id: ${plan.plan_id}`,
    `# integrity_hash: ${plan.integrity_hash}`,
    'set -euo pipefail',
    '',
  ];
  for (const a of plan.assignments) {
    lines.push(`# ${a.role} on ${a.node}:${a.port}`);
    lines.push(`tailscale ssh ${a.node} -- '${roleCommand(a.role, plan.artifact.name, a.port)}' &`);
  }
  lines.push('wait');
  return lines.join('\n') + '\n';
}

// Emit Kubernetes manifests for the plan. One Deployment + Service per role.
// Tenant runs `kubectl apply -f` (or pipes into helm/argo). We emit YAML-lite
// to avoid a dep; the user can pipe through `yq` for strict formatting.
export function toK8sManifests(plan, opts = {}) {
  const namespace = opts.namespace || 'kolm';
  const image = opts.image || 'kolm/kolm:latest';
  const manifests = [];
  // ConfigMap for the artifact reference (real artifact comes from a PVC or init container).
  manifests.push({
    apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { name: `kolm-${plan.plan_id}-artifact`, namespace },
    data: {
      'artifact.name': plan.artifact.name,
      'artifact.hash': plan.artifact.hash || '',
      'plan.id':       plan.plan_id,
      'plan.hash':     plan.integrity_hash,
    },
  });
  // Group assignments by role to emit one Deployment per role.
  const byRole = {};
  for (const a of plan.assignments) {
    if (!byRole[a.role]) byRole[a.role] = [];
    byRole[a.role].push(a);
  }
  for (const [role, list] of Object.entries(byRole)) {
    const port = list[0].port;
    const replicas = list.length;
    manifests.push({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: `kolm-${role}`, namespace, labels: { app: 'kolm', role, 'plan-id': plan.plan_id } },
      spec: {
        replicas,
        selector: { matchLabels: { app: 'kolm', role } },
        template: {
          metadata: { labels: { app: 'kolm', role } },
          spec: {
            containers: [{
              name: 'kolm',
              image,
              args: roleCommand(role, plan.artifact.name, port).split(' ').slice(1),
              ports: [{ containerPort: port, name: role }],
              envFrom: [{ configMapRef: { name: `kolm-${plan.plan_id}-artifact` } }],
            }],
          },
        },
      },
    });
    manifests.push({
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: `kolm-${role}`, namespace, labels: { app: 'kolm', role } },
      spec: {
        selector: { app: 'kolm', role },
        ports: [{ port, targetPort: port, name: role }],
        type: role === 'coordinator' ? 'LoadBalancer' : 'ClusterIP',
      },
    });
  }
  return manifests;
}

// Serialize manifests to YAML-lite (no dep). Multi-document stream separated
// by `---`. Deterministic key order so `git diff` is useful.
export function manifestsToYaml(manifests) {
  const docs = [];
  const write = (val, indent) => {
    if (val === null || val === undefined) return 'null';
    if (typeof val === 'string') return JSON.stringify(val);
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      const pad = '  '.repeat(indent);
      return '\n' + val.map(v => {
        if (typeof v === 'object' && v !== null) {
          const inner = Object.keys(v).map(k => `${pad}  ${k}: ${write(v[k], indent + 2)}`).join('\n');
          return `${pad}- \n${inner}`.replace(`${pad}- \n${pad}  `, `${pad}- `);
        }
        return `${pad}- ${write(v, indent + 1)}`;
      }).join('\n');
    }
    if (typeof val === 'object') {
      const pad = '  '.repeat(indent);
      const lines = Object.keys(val).map(k => `${pad}${k}: ${write(val[k], indent + 1)}`);
      return '\n' + lines.join('\n');
    }
    return JSON.stringify(val);
  };
  for (const m of manifests) {
    const top = Object.keys(m).map(k => `${k}: ${write(m[k], 1)}`).join('\n');
    docs.push(top);
  }
  return '---\n' + docs.join('\n---\n') + '\n';
}

export default {
  MESH_PLAN_SCHEMA_VERSION,
  NODE_ROLES,
  discoverNodes,
  clusterPlan,
  validateClusterPlan,
  toTailscaleShellScript,
  toK8sManifests,
  manifestsToYaml,
};
