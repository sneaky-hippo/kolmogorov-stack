# kolm mesh

Discover Tailscale-joined kolm nodes, plan a cluster assignment, render
the deployment as either a shell script or Kubernetes manifests, and
validate that a saved cluster plan still matches its integrity hash (W237).

Single-box → cluster without rewriting your CLI vocabulary: every node
in the mesh runs the same `kolm` binary, and `kolm mesh plan` decides
who plays coordinator, inference, capture, mentor, or auditor.

## Usage

```
kolm mesh discover [--cmd tailscale]
kolm mesh plan --artifact <name.kolm> [--replicas N]
kolm mesh deploy <plan.json>                 # POSIX shell over tailscale ssh
kolm mesh k8s   <plan.json> [--namespace kolm] [--image <repo:tag>]
kolm mesh validate <plan.json>
```

## Examples

```
kolm mesh discover                                       # tailscale status as JSON
kolm mesh plan --artifact phi-redactor.kolm --replicas 3
kolm mesh deploy cluster-plan.json                       # tailscale ssh + bash
kolm mesh k8s   cluster-plan.json --namespace kolm-prod  # GKE/EKS YAML stream
kolm mesh validate cluster-plan.json                     # integrity check
```

## Role catalog

`coordinator` (1) - artifact origin, routing
`inference`   (N) - serves the artifact (`--replicas` controls N)
`capture`     (1) - durable capture sink
`mentor`      (0+) - teacher fan-out
`auditor`     (1) - integrity attestations

## See also

- `/foundations/tailscale` for the network-foundation recipe.
- `kolm jobs` / `kolm watch` for cluster-wide job orchestration.
- `kolm verify` to verify any node-local artifact against the mesh manifest.
