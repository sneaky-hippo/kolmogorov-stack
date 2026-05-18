# kolm.ai self-hosted compile server (W264)

Same compile pipeline as `kolm.ai`, runnable in your VPC, behind a firewall, or fully air-gapped. The `.kolm` artifact this server produces is byte-identical to the cloud version because it calls the unmodified `src/compile.js` orchestrator the cloud uses.

## Install (air-gap, no internet)

These steps assume a host already running Node 20+ that pulled this repo via a sneakernet copy or internal mirror. The server adds no new npm dependencies beyond what the root `package.json` already pulls.

```
git clone https://your.internal.mirror/kolm.git
cd kolm
npm ci --omit=dev
export KOLM_SHARED_SECRET="$(openssl rand -hex 32)"
export KOLM_OFFLINE=1
export KOLM_ARTIFACT_DIR=/data/artifacts
mkdir -p $KOLM_ARTIFACT_DIR
node workers/compile-server/server.mjs
```

The server boots on `0.0.0.0:8080`. If `KOLM_SHARED_SECRET` is not set the process refuses to start (exit code 2) so you cannot accidentally leave it open.

## Install (Docker)

```
docker build -f workers/compile-server/Dockerfile -t kolm-compile:w264 .
docker run --rm -p 8080:8080 \
  -e KOLM_SHARED_SECRET=$(openssl rand -hex 32) \
  -e KOLM_OFFLINE=1 \
  -v $(pwd)/data/artifacts:/data/artifacts \
  kolm-compile:w264
```

## Install (docker-compose)

```
export KOLM_SHARED_SECRET=$(openssl rand -hex 32)
docker compose -f workers/compile-server/docker-compose.yml up -d
```

The compose file declares a `kolm-artifacts` named volume so the artifacts survive container restarts.

## Install (Helm, single-node cluster)

```
kubectl create namespace kolm
kubectl -n kolm create secret generic kolm-compile-secret \
  --from-literal=shared-secret=$(openssl rand -hex 32)
helm -n kolm install kolm-compile workers/compile-server/helm
kubectl -n kolm port-forward svc/kolm-compile 8080:8080
```

For air-gapped clusters, point `image.repository` at your internal registry and pre-pull `node:20-alpine` plus the resulting `kolm-compile:w264` image.

## Auth

Every endpoint except `GET /v1/health` requires the header:

```
x-kolm-shared-secret: $KOLM_SHARED_SECRET
```

The comparison is constant time. Missing or wrong secret returns `401`.

## API

| Verb | Path | Description |
| --- | --- | --- |
| GET  | `/v1/health` | `{ ok, mode, version, offline, secret_configured }` |
| POST | `/v1/compile` | Start a compile job, returns `{ job_id, status, poll }` |
| GET  | `/v1/compile/:id` | Job status, includes `manifest`, `k_score`, `artifact_url` |
| GET  | `/v1/compile/:id/.kolm` | Stream the signed artifact bytes |

Pass `?sync=1` to `POST /v1/compile` to await completion before responding (useful for shell scripts).

## No-egress verification

The server itself never initiates outbound traffic while `KOLM_OFFLINE=1` is set. The `deploy_hook` field on `POST /v1/compile` is rejected with a `400`. To prove this end to end during an audit, run a packet capture across one compile job and grep for any non-loopback traffic.

Linux (tcpdump):

```
sudo tcpdump -i any -nn -w /tmp/kolm-compile.pcap not host 127.0.0.1 and not host ::1 &
TCPDUMP_PID=$!
curl -X POST http://localhost:8080/v1/compile?sync=1 \
  -H "x-kolm-shared-secret: $KOLM_SHARED_SECRET" \
  -H "content-type: application/json" \
  -d '{"task":"redact PII from text","examples":[]}'
sudo kill $TCPDUMP_PID
sudo tcpdump -nn -r /tmp/kolm-compile.pcap | wc -l
# Expected: 0
```

macOS (pfctl + tcpdump):

```
sudo tcpdump -i any0 -nn -w /tmp/kolm-compile.pcap not host 127.0.0.1 and not host ::1 &
TCPDUMP_PID=$!
curl -X POST http://localhost:8080/v1/compile?sync=1 \
  -H "x-kolm-shared-secret: $KOLM_SHARED_SECRET" \
  -H "content-type: application/json" \
  -d '{"task":"summarize email","examples":[]}'
sudo kill $TCPDUMP_PID
sudo tcpdump -nn -r /tmp/kolm-compile.pcap | wc -l
```

For belt-and-suspenders deployment, put the pod behind a `NetworkPolicy` that denies egress, or run the container with `--network none` after the first compile has produced a base artifact you want to keep iterating on.

## Byte-identical to cloud

`POST /v1/compile` on this server calls the same `createJob` and `runJob` exports from `src/compile.js` that `kolm.ai` calls. The signing chain, manifest fields, K-score formula, and `.kolm` zip layout are all identical. To verify, compile the same `(task, examples)` pair against both endpoints and compare:

```
sha256sum cloud.kolm self-hosted.kolm
```

If both compiles ran with the same `KOLM_RECEIPT_SECRET` and the same base model the two hashes match.

## Environment

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KOLM_SHARED_SECRET` | yes | (none) | Shared auth secret. Server refuses to start if missing. |
| `KOLM_OFFLINE`       | no  | `0`    | Set to `1` to reject any handler that would touch the network. |
| `KOLM_ARTIFACT_DIR`  | no  | `/data/artifacts` | Directory where signed `.kolm` files are written. |
| `KOLM_TENANT_ID`     | no  | `self-hosted` | Tenant label embedded in the compile job records. |
| `PORT`               | no  | `8080` | TCP port to listen on. |
| `HOST`               | no  | `0.0.0.0` | Bind address. |

## Out of scope

- No user, team, or billing surfaces. The server is single-tenant by design; access control is the shared secret plus your network policy.
- No web console. Use `curl`, the `kolm` CLI, or your own UI.
- The cloud orchestrator's optional deploy-hook fan-out is rejected in `KOLM_OFFLINE=1` mode. If you want push-on-completion behavior, run the server with `KOLM_OFFLINE=0` and supply an https `deploy_hook` per request, or poll `/v1/compile/:id` from your CI.
