# Receipt Verification Truth

Date: 2026-05-12

Backlog target: RB-003, "Can a receipt be verified offline from a clean machine without secrets?"

Short answer: current production-shaped receipts are HMAC-verifiable, but not independently public-verifiable. A verifier needs the same `RECIPE_RECEIPT_SECRET` or access to a server that has it.

## What Was Tested

1. Built a v0.1 artifact receipt using `buildPayload` with an explicit `RECIPE_RECEIPT_SECRET`.
2. Posted that receipt to `/v1/receipts/verify` on a local `server.js` app with the same secret.
3. Recomputed the v0.1 receipt chain and body signature with the correct secret and with a wrong secret.
4. Inspected code paths for legacy API run receipts, artifact receipts, local artifact run results, and readiness behavior.

The row-level matrix is `receipt-verification-matrix-2026-05-12.csv`.

## Smoke Result

Local endpoint verification:

- route: `POST /v1/receipts/verify`
- status: `200`
- response: `verified: true`
- receipt algorithm: `hmac-sha256`
- chain steps: `5`
- anchors: `0`
- public-key fields present: none

Standalone key check:

- correct secret verifies: `true`
- wrong secret verifies: `false`
- public verifier material present: `false`

## Receipt Modes In Code

| Surface | Shape | Current Verification |
| --- | --- | --- |
| Artifact `receipt.json` | `kolm_version: 0.1`, `chain[]`, `signature_alg: hmac-sha256`, `signature` | `/v1/receipts/verify` recomputes every chain HMAC and the body HMAC with `RECEIPT_SECRET`. |
| Artifact `signature.sig` | Legacy HMAC envelope over manifest/artifact hashes | `loadArtifact` calls `verifyManifestSignature`, which recomputes HMAC with the active secret. |
| API `/v1/run` receipt | Legacy `rs-1` receipt with `hmac` | `/v1/receipts/verify` recomputes HMAC with `RECEIPT_SECRET`. |
| Local `runArtifact` return | `rs-1-run` with artifact/job/recipe metadata | No HMAC/signature is attached to the per-call local run receipt. |
| Drive-by verifier | `{ artifact_hash, signature }` | Verifies a hex HMAC over `artifact_hash` with `RECEIPT_SECRET`. |

## Product Truth

Safe wording:

- "Receipts are HMAC-verifiable by the issuing runtime or holders of the shared receipt secret."
- "Artifact receipts contain a 5-step HMAC chain and a signed receipt body."
- "Fixture artifacts use a public test secret so anyone can reproduce the demo verification path."

Unsafe wording for the current implementation:

- "Anyone can independently verify receipts offline."
- "Public registry anchoring proves the run."
- "On-chain receipts."
- "Public-key signed receipts."
- "No trust in the issuer is required."

## Gaps

1. No Ed25519/public-key receipt mode is implemented.
2. `receipt.json.anchors` is always empty in observed artifacts.
3. `signed_by` is a string namespace, not a resolvable public key identity.
4. Local `runArtifact` returns an unsigned `rs-1-run` metadata object, so it should not be described as a cryptographic per-run proof.
5. `/v1/spec` mentions public-key or shared-HMAC modes, but the code and tests only prove shared-HMAC mode.

## Recommended Follow-Up

1. Add `signature_alg: ed25519` receipt support with public key IDs and test vectors.
2. Add a CLI verifier that can validate fixture receipts using either a supplied shared secret or a public key.
3. Decide whether artifact-local runs should produce signed local receipts, and if so where the local signing key lives.
4. Keep HMAC mode as explicit symmetric mode in docs, API schemas, and claim gates.
5. Add a deploy smoke that confirms `/v1/receipts/verify` is available only when receipt readiness passes.
