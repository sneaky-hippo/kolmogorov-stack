# kolm quantize

Run a local worker to quantize a model checkpoint to int4 / int8 / GPTQ / AWQ.
The CLI is a thin shell over `workers/quantize/quantize.mjs`; the worker
calls a Python virtual environment for the heavy lifting.

## Usage

```
kolm quantize --local-worker [--method <m>] [--in <dir>] [--out <dir>] [--json]
kolm quantize --local-worker --doctor
```

## Flags

- `--local-worker` required flag. Today the verb only runs against the local
  worker; the bare verb prints scaffolding instructions.
- `--method <m>` one of `int4`, `int8`, `gptq`, `awq`. Default: `int4`.
- `--in <dir>` source model checkpoint directory.
- `--out <dir>` destination directory for quantized weights.
- `--doctor` probe the local worker environment and report what is missing.
- `--json` machine-readable output.

## Examples

```
kolm quantize --local-worker --doctor
kolm quantize --local-worker --method int4 --in ./qwen2.5-7b --out ./qwen2.5-7b-int4
kolm quantize --local-worker --method gptq --in ./llama-3.1-8b --out ./llama-3.1-8b-gptq
```

## Honest scope

The CLI verb invokes the local worker; the worker is a Node + Python bridge
under `workers/quantize/`. Install it once:

```
cd workers/quantize && npm install
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Without the worker the verb prints a scaffolding message and exits cleanly.
Verify the output before ship: round-trip the quantized weights through
`kolm compile` and re-check the K-score gate; quantization can move A by
multiple points.

## See also

- `kolm compile --spec <file>` to wrap the quantized weights in a signed
  `.kolm` artifact.
- `kolm verify <artifact>.kolm` to confirm the receipt chain.
- `/spec/rs-1` for the manifest fields that record the quantization method
  and the source-checkpoint hash.
