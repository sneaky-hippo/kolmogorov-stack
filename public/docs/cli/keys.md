# kolm keys

Signing-key rotation lifecycle. Generates Ed25519 keypairs, records rotation
receipts, and emits KMS wrap intents. The receipt-chain verifier (`kolm verify`)
re-checks the active fingerprint against the manifest's signing block.

## Usage

```
kolm keys list                                  list keys + status + KMS target
kolm keys rotate [--kms <target>] [--overlap-days <N>]
kolm keys fingerprint                           print active key short fingerprint
kolm keys export                                emit the rotation manifest as JSON
```

## Flags

- `--kms <target>` one of `local`, `aws-kms`, `gcp-kms`, `azure-kv`,
  `hashicorp-vault`. Default: `local`. Hosted targets emit a wrap intent;
  the customer KMS hook applies the wrapping.
- `--overlap-days <N>` how long the old key stays valid during rotation
  (default: 30 days; spec lock at `DEFAULT_OVERLAP_DAYS`).
- `--json` machine-readable output. Default: human-readable.

## Examples

```
kolm keys list
kolm keys rotate
kolm keys rotate --kms aws-kms --overlap-days 60
kolm keys fingerprint
```

## Honest scope

kolm emits the rotation receipt and writes the new key into KOLM_HOME for
the local target. For hosted KMS targets the customer's KMS hook applies
the wrapping; kolm does not call AWS / GCP / Azure APIs from the CLI.
Verify the wrap landed in your KMS before rotating production traffic.

## See also

- `kolm verify <artifact>.kolm` re-runs the signature checks including the
  active fingerprint binding.
- `/spec/rs-1` (RS-1 v2.1) section 7.13 covers the signing block and key
  rotation field shape.
- `/frozen-eval` for how the eval-set hash is anchored alongside the key
  fingerprint in the receipt chain.
