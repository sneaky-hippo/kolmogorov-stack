# RS-1: Recipe Spec, v0.1

RS-1 is the open spec for `.kolm` artifacts and the receipts that bind them
to evals. It is **MIT-licensed** and the canonical schemas live next to
this file in this repo.

| Document | Path | Schema |
| --- | --- | --- |
| Manifest, v0.1 | `/docs/manifest-v0.1.json` | [manifest-v0.1.json](./manifest-v0.1.json) |
| Receipt, v0.1 | `/docs/receipt-v0.1.json` | [receipt-v0.1.json](./receipt-v0.1.json) |

## What RS-1 promises

A `.kolm` artifact is a signed zip. Every artifact ships with a manifest
and at least one receipt. The receipt is what makes a kolm claim
auditable: it binds the **artifact hash**, the **eval-set hash**, the
**eval score**, and the **judge identity** through an HMAC chain. Anyone
with the receipt and a public key can re-verify offline.

Even an attacker with full root access to the runtime cannot forge a
kolm receipt. Tampering breaks the chain at verify time.

## The four tiers

* **Recipe** — `≤100 KB`. Deterministic, code-only. No model required.
* **Adapter** — `10–100 MB`. Recipe + LoRA delta against a kolm base.
* **Specialist** — `100s of MB`. Adapter + a quantized base.
* **Bundle** — `GB-class`. Specialist + a portable index.

## The receipt chain

Each step in the chain hashes the previous step's output. The chain is
anchored at one or more registries (`public_registry`, `arweave`, or
`onchain`). The signature covers the canonical JSON of the receipt body
(minus the signature field) under ed25519.

```
chain = [
  { step: "task",    input_hash: H(spec),    output_hash: H(spec+task) },
  { step: "seeds",   input_hash: H(spec+task), output_hash: H(seeds)   },
  { step: "recipes", input_hash: H(seeds),   output_hash: H(recipes)   },
  { step: "evals",   input_hash: H(recipes), output_hash: H(evals)     },
  { step: "package", input_hash: H(evals),   output_hash: H(artifact)  },
]
```

## Verification

```bash
# anyone, anywhere, offline:
curl -fsSL https://kolm.ai/docs/receipt-v0.1.json > schema.json
curl -fsSL https://kolm.ai/v1/receipts/verify -X POST \
  -H 'content-type: application/json' \
  -d "@receipt.json"
```

The `/v1/receipts/verify` endpoint accepts both the v0 receipt shape
(legacy `rs-1` body with `hmac`) and the v0.1 receipt shape with the
`chain` and `signature` fields. Both validate against the same secret.

## License

MIT. Use it, fork it, extend it. No CLA. The schemas in this directory
are the canonical reference; PRs welcome.
