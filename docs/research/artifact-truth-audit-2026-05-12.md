# Artifact Truth Audit

Date: 2026-05-12

Backlog target: RB-001, "What exactly is inside a current `.kolm` produced from a clean compile?"

## Evidence Collected

- Generated a fresh local artifact through `compileSpec` and `buildAndZip` with an explicit `RECIPE_RECEIPT_SECRET`.
- Inspected the generated zip entries and decoded `manifest.json`, `model.gguf`, `receipt.json`, `lora.bin`, and `index.sqlite-vec`.
- Re-ran the checked fixture artifacts under `tests/artifact-end-to-end.test.js`.
- Inventoried every `test/fixtures/*.kolm` artifact.

The row-level inventory is `artifact-fixture-inventory-2026-05-12.csv`.

## Current Artifact Contents

The generated artifact contains exactly these zip members:

| Member | Current Meaning |
| --- | --- |
| `manifest.json` | Artifact metadata, recipe count, eval hash, hashes, tier, runtime, K-score. |
| `model.gguf` | JSON pointer record, not GGUF weights. The generated sample says `runtime: cloud` and notes that weights are resolved later. |
| `recipes.json` | Deterministic JS recipe source pack. |
| `lora.bin` | Optional `KOLMPACK` behavior-pack container. This is not LoRA weights in v0.1. |
| `index.sqlite-vec` | Optional `KOLMIDX` JSON lookup container. This is not a sqlite-vec database in v0.1. |
| `evals.json` | Embedded eval cases. |
| `signature.sig` | Legacy HMAC signature envelope. |
| `receipt.json` | HMAC receipt body with 5 chain steps and zero anchors. |

## Generated Sample Result

Generated sample:

- path: `C:\Users\user\AppData\Local\Temp\kolm-artifact-truth-fEGz1l\artifact-truth.kolm`
- sha256: `0c74666863657f273def9388e3236ddc78214b483591e70b73d99895bb688bf6`
- zip bytes: `3689`
- tier: `recipe`
- runtime: `cloud`
- base model: `none`
- recipes: `1`
- eval cases: `2`
- decoded pack keys: `categories`
- decoded index keys: `lookup`
- receipt algorithm: `hmac-sha256`
- receipt chain steps: `5`
- receipt anchors: `0`
- eval result: `2/2`
- run result: `{ "label": "billing", "score": 3 }`

## Fixture Result

The escalated artifact test passed:

- command: `node --test tests\artifact-end-to-end.test.js`
- result: `23` tests passed, `0` failed
- coverage from that test: fixture load/signature, inspect, eval pass, benchmark zero egress, tenant params, audit callback, input cap, and tamper rejection

The same command first failed inside the sandbox with `spawn EPERM`; rerunning outside the sandbox was required because Node's test runner spawns child processes.

## Product Truth

Current `.kolm` artifacts are credible recipe-tier artifacts:

- signed zip bundles,
- executable recipes,
- embedded evals,
- HMAC receipts,
- artifact-local run/eval/bench support,
- optional behavior pack and lookup-index slots,
- zero-egress benchmark checks in the fixture test.

They are not yet:

- self-contained model-weight bundles,
- native phone artifacts,
- LoRA adapter artifacts,
- sqlite-vec retrieval databases,
- public-key verifiable receipts,
- transparency-log anchored receipts,
- proof of HIPAA/EU AI/SOC 2 readiness.

## New Defect Found

`buildAndZip` computes a second-pass K-score, writes a zip, then mutates `finalPayload.manifest.k_score` again after reading the final on-disk size. That final mutation is returned to the caller but is not repackaged into `manifest.json`.

Observed effect:

- generated sample: zip bytes `3689`, manifest K-score `size_bytes` `3591`, delta `98`
- fixtures: zip bytes exceed manifest K-score `size_bytes` by `64` to `68` bytes

The artifact tests pass because they assert K-score presence and successful behavior, not equality between final zip size and manifest K-score size.

Impact: the K-score size axis in the signed manifest can be stale by a small number of bytes. It does not invalidate the signature under current tests, but it weakens "recompute K-score exactly from artifact" claims and should be fixed before benchmark or conformance copy relies on exact size accounting.

## Recommended Follow-Up

1. Fix `buildAndZip` so the manifest inside the final zip contains the final K-score, or compute K-score from the final artifact at inspection/eval time.
2. Add a test that asserts `fs.statSync(artifact).size === manifest.k_score.size_bytes` or explicitly documents why the manifest stores the probe size.
3. Rename public copy around `lora.bin` and `index.sqlite-vec` so buyers understand these are v0.1 behavior/index containers, not LoRA weights or sqlite-vec databases.
4. Add `artifact-fixture-inventory-2026-05-12.csv` checks to future artifact release gates.
