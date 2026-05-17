# @kolmogorov/quantize-worker

Wave 195 (Q+5). Isolated kolm quantization worker. Lives in its own package so
the heavy ML deps (bitsandbytes, auto-gptq, optimum, torch, accelerate) NEVER
land in the root kolm install. The root `kolm` CLI invokes this worker only
when the tenant explicitly opts in via `kolm quantize --local-worker`.

## Install

Node side (no torch, no bitsandbytes; just the Node entrypoint):

```
cd workers/quantize
npm install
```

Python side (the heavy lifting; isolated venv, never bleeds into root):

```
cd workers/quantize
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Doctor

Confirm the toolchain is ready before quantizing:

```
node quantize.mjs --doctor
# or via the root CLI:
kolm quantize --local-worker --doctor
```

Exits 0 when python3 + torch + bitsandbytes are all importable; 1 otherwise.

## Supported methods

| method | backend       | notes                                       |
|--------|---------------|---------------------------------------------|
| int4   | bitsandbytes  | 4-bit weight quantization                   |
| int8   | bitsandbytes  | 8-bit weight quantization                   |
| gptq   | auto-gptq     | post-training quantization, calibration set |
| awq    | AutoAWQ       | activation-aware weight quantization        |

## Honest scope

kolm ships the quantization scaffolding (this Node entrypoint, dep detection,
honest manifest emission). The Python heavy lifting (scripts/quantize.py) is
the customer's opt-in: drop in a script that takes `--method --in --out` and
runs the chosen quantizer. The worker handles the absence gracefully: running
the verb today returns a "scaffolding present, python script not yet shipped"
manifest with exit 0 and no crash.

The root `kolm` install has zero torch / bitsandbytes / auto-gptq deps. They
only enter the tree when an operator runs `npm install` + `pip install` inside
`workers/quantize/`. This is the opt-in, isolated-worker pattern shared with
`workers/distill/`.
