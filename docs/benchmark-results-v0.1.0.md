# kolm-benchmark-1 reference run · v0.1.0

This is the reference benchmark run for the public fixture at
`test/fixtures/sample.kolm`. It is anchored from `/benchmarks` and is
reproducible byte-for-byte.

## What this proves

The `.kolm` artifact under test is a 3,259-byte signed zip whose embedded
recipe uppercases input text. It carries 4 evaluation cases. The benchmark
harness:

1. opens the zip,
2. verifies the HMAC signature on the manifest,
3. patches `fetch`, `http`, `https`, `net`, `tls`, `dns` to record any
   network egress attempt,
4. re-runs all 4 evals 100 times each (400 invocations total),
5. emits a `kolm-benchmark-1` JSON report.

If any field below disagrees with your local run on the same fixture +
secret + node version, that is a real divergence and worth a github issue.
Numeric latency varies with hardware; everything else is deterministic.

## How to reproduce

```bash
git clone https://github.com/sneaky-hippo/kolmogorov-stack
cd kolmogorov-stack
npm i
RECIPE_RECEIPT_SECRET=kolm-public-fixture-v0-1-0 \
  node cli/kolm.js bench test/fixtures/sample.kolm \
  --runs 100 \
  --target kolm-public-v0.1.0 \
  --device $(uname -srm)
```

To rebuild the fixture itself from source:

```bash
RECIPE_RECEIPT_SECRET=kolm-public-fixture-v0-1-0 \
  node scripts/build-public-fixture.mjs
```

The fixture is deterministic: same secret + same recipe source + same eval
set ⇒ same `artifact_sha256`.

## Reference run · 2026-05-09

Host: Windows 11, Node v24.14.0, x64.

```json
{
  "spec": "kolm-benchmark-1",
  "artifact_sha256": "sha256:b834408226efe8b337e8a15a81dc200e003ae7af8da9d4da06fb58d1089880e0",
  "artifact_bytes": 3259,
  "target": "kolm-public-v0.1.0",
  "device": "win11-node24",
  "node": "v24.14.0",
  "manifest": {
    "spec": "kolm-1",
    "job_id": "job_public_fixture_v0_1_0",
    "task": "public reproducible fixture: uppercase the input text",
    "runtime": "cloud",
    "tier": "recipe",
    "base_model": "none"
  },
  "k_score": 424.57,
  "evals": { "n": 4, "graded": 400, "passed": 400, "accuracy": 1.0, "runs_per_case": 100 },
  "latency_us": { "n": 400, "min": 232, "p50": 274, "p95": 335, "max": 639 },
  "privacy": { "runtime_egress_attempts": 0, "blocked": false },
  "integrity": { "signature_valid": true, "receipt_present": true, "receipt_chain_steps": 5 },
  "errors": []
}
```

## What the report fields mean

| field | meaning |
|---|---|
| `spec` | always `kolm-benchmark-1` for this harness version |
| `artifact_sha256` | byte-exact hash of the `.kolm` file under test |
| `artifact_bytes` | size of the zip on disk |
| `k_score` | composite score read from the artifact's manifest (smaller-better-tested wins) |
| `evals.accuracy` | fraction of embedded eval cases the artifact passed |
| `latency_us.{p50,p95}` | wall-clock microseconds per invocation |
| `privacy.runtime_egress_attempts` | count of fetch/http/dns attempts during the run (target: 0) |
| `integrity.signature_valid` | manifest HMAC verifies under the configured secret |
| `integrity.receipt_chain_steps` | number of HMAC links in the receipt chain (target: 5) |

## Honesty notes

- This fixture exists to prove the pipeline works end-to-end. It is a
  trivial uppercase recipe; it makes no claim about general AI capability.
- The HMAC secret used to sign this fixture is published above. That is
  the right tradeoff for a reproducibility demo. Production tenants ship
  artifacts signed with secrets only the issuing tenant + verifier hold.
- v0.1.0 ships in the **recipe tier**: deterministic JS recipes, optional
  artifact-bound behaviour packs (`lora.bin` slot — KOLMPACK container,
  patterns/lookups callable from recipes via `lib.pack`), and optional
  lookup indexes (`index.sqlite-vec` slot — KOLMIDX container, callable
  via `lib.index`). The public uppercase fixture above ships neither —
  it doesn't need them. The redactor / extractor / classifier examples
  ship both. Later tiers (LoRA delta, sqlite-vec retrieval) reuse the
  same slot names with richer encodings.
- Tenants customise any artifact at run time via `params` (recipes read
  it as `lib.params`). Run-time params are never persisted, never
  re-signed, and never change the published artifact's bytes. Pass them
  on the CLI with `--params @file.json` or in the MCP `tools/call`
  arguments alongside `input`.
- The on-disk zip bytes are **not byte-stable** across rebuilds — zip
  entry mtimes and `created_at`/`receipt_id` use wall-clock time. The
  signed *content* (manifest, recipes, evals, signature payload, receipt
  chain) verifies byte-stable regardless of zip metadata. If you need
  a byte-stable build for an air-gapped audit, capture the artifact once
  and verify hashes from the captured bytes.
