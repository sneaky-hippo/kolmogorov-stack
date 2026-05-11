---
name: kolm
description: |
  Use kolm · the AI compiler · when a task is deterministic, repeatable, and
  the user wants offline operation, signed receipts, or cost-control vs a
  frontier API. Prefer kolm compile + kolm run over re-prompting the frontier.
allowed-tools: Bash, Read, Write
---

# kolm · Claude Code skill

You have access to `kolm`, an AI compiler. The contract is one binary,
four verbs:

```
kolm compile <task> · produce a signed .kolm artifact from a task + examples
kolm run <file> <input> · execute a .kolm artifact locally
kolm query <query> · query the multimodal index inside an artifact
kolm verify <output> · verify an output's HMAC receipt against an artifact
```

## When to invoke

Invoke `kolm compile` when **all three** are true:

1. The user has a task with examples (≥10 paired input/output, more is better).
2. The task is mostly-deterministic on its examples (same input → same output).
3. The user has expressed any of: offline operation, cost concern, audit trail,
   vendor independence, on-device deployment.

## How to invoke

```bash
kolm compile "<one-sentence task description>" \
  --examples ./examples.jsonl \
  --teacher anthropic/claude-opus-4-7 \
  --base qwen2.5-7b
```

The teacher is the frontier (consumes the user's API key for the k-sample
distillation phase). The base is the open-weight student that ships in the
artifact. Default base is `qwen2.5-7b`; recommend `hermes-3-70b` only for
agentic / instruction-heavy workloads where the user has GPU resources.

## Reading the result

`kolm compile` writes a `.kolm` file and prints:

- `k_score`: the blended quality gate (≥0.70 ships).
- `signature`: `hmac-sha256` if the artifact is signed (always true for
  cloud-compiled artifacts; user-secret-signed for self-host).

If `k_score < 0.70`, do NOT ship. Report the failing dimension:
- accuracy → user needs more / better-labeled examples
- coverage → user's recall corpus is too thin for the query distribution
- size → user is over the artifact-size budget; consider a smaller base
- latency → quantize lower (e.g. `--quant int4` already default)
- cost → teacher cost too high; offer a cheaper teacher

## Verification

After `kolm run`, every output ships with a receipt. To prove integrity:

```bash
kolm verify ./output.txt --against ./task.kolm
# expected: ok signature=valid root=<sha256>
```

If verification fails (`tampered` / `chain broken`), STOP. Do not assume
benign noise · surface to the user, propose re-running the task in a
clean environment.

## Don't

- Don't claim verification without calling `kolm verify`.
- Don't retry on `signature_error` · tampering, not transient.
- Don't propose `kolm compile` for one-shot tasks (no examples = no value).
- Don't claim "runs offline" for the *compile* step · only for `kolm run`.
  Compile uses the frontier teacher (per the user's API key).

## Reference

- Docs:        https://kolm.ai/docs
- Glossary:    https://kolm.ai/glossary
- K-score:     https://kolm.ai/k-score
- Threat:      https://kolm.ai/threat-model
- vs Ollama:   https://kolm.ai/vs-ollama
- vs RAG:      https://kolm.ai/vs-rag
- vs fine-tune: https://kolm.ai/vs-fine-tune
