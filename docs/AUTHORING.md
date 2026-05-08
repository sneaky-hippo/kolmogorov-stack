# Authoring a .kolm — for humans and AI agents

This doc is the complete spec for writing a `.kolm` artifact from scratch.
It exists so any operator — clinical informatics lead, a fraud analyst,
an embedded engineer, a Claude or GPT agent acting on behalf of one of
the above — can spin up an end-to-end functioning local application
without learning the build harness.

The minimum viable artifact is a **JSON spec** plus the kolm CLI. There is
no SaaS dependency, no account required, no build server.

## In one minute

```bash
npm i -g @kolmogorov/kolm        # or: npx @kolmogorov/kolm@latest <verb>

# 1. Scaffold a starter spec from a template
kolm new my-redactor --from redactor

# 2. Build the signed .kolm
kolm compile --spec my-redactor.spec.json --out my-redactor.kolm

# 3. Run it locally
kolm run my-redactor.kolm '{"text":"call 555-123-4567 today"}'
# -> { "redacted": "call [PHONE] today", "hits": [{ "name": "PHONE", "count": 1 }] }

# 4. Serve it as an MCP tool so Claude / Cursor / OpenMCP can call it
kolm serve --mcp
```

That is the full loop. The four steps work offline. The signed artifact
verifies byte-for-byte across machines that share the same secret.

## The spec

The spec is a JSON object passed to `kolm compile --spec <file|->`.

```jsonc
{
  "job_id": "job_my_redactor_v1",          // required, /^job_[a-z0-9_-]+$/i
  "task":   "redact PII from clinic notes", // required, free text
  "base_model": "none",                    // optional; "none" for pure-recipe
  "recipes": [                             // required, ≥1 entry
    {
      "id":     "rcp_main_v1",             // required, /^rcp_.+$/i recommended
      "name":   "identifier redactor",     // required, human-readable
      "source": "function generate(input, lib) { /* ... */ }", // required
      "tags":   ["redaction","pii"],       // optional
      "schema": {                          // optional documentation
        "input":  { "text": "string" },
        "output": { "redacted": "string", "hits": "array" }
      }
    }
  ],
  "pack":  { /* see "Packs" below */ },    // optional, embeds in lora.bin slot
  "index": { /* see "Indexes" below */ },  // optional, embeds in index.sqlite-vec slot
  "evals": {                               // optional but strongly recommended
    "spec":     "rs-1-evals",
    "n":        2,
    "cases": [
      {
        "id":       "phone_case",
        "input":    { "text": "call 555-123-4567" },
        "expected": { "redacted": "call [PHONE]", "hits": [{ "name": "PHONE", "count": 1 }] },
        "params":   null                   // optional per-case tenant params
      }
    ],
    "coverage": 1.0
  },
  "training_stats": {                      // optional; affects K-score
    "pass_rate_positive": 1.0,
    "latency_p50_us": 60
  }
}
```

### Field rules

- `job_id` must be unique per artifact and slug-shaped. The CLI will refuse `Job-1` (uppercase, dot-prefix, etc.).
- Every recipe must compile under `compileJs` (the `node:vm`-based sandbox). Syntax errors are caught at compile time, not run time.
- Every recipe is a pure function `function generate(input, lib) { return output; }`. No `async`, no `setTimeout`, no `fetch`, no `require`. The runtime patches every egress channel anyway.
- `evals.cases[].expected` is compared with structural deep-equal (cross-realm safe). Match exactly what your recipe returns.

## The recipe sandbox

Inside `function generate(input, lib) { ... }` the only things you can read are:
- `input` — whatever the caller passed
- `lib.patterns` — built-in regex primitives: `email`, `phone`, `url`, `ipv4`, `date`
- `lib.parseFloatSafe(x)` — number coercion that returns `NaN` for garbage
- `lib.pack` — the JSON object you put in `spec.pack` (or `null`)
- `lib.index` — the JSON object you put in `spec.index` (or `null`)
- `lib.params` — per-call tenant runtime params (or `null`) — see "Tenant params" below

You cannot import modules. You cannot reach the file system, network, env,
or process. Recipes have a **hard 1000ms timeout** and a 1MiB input cap.
A recipe that exceeds either yields a structured `KOLM_E_RECIPE_TIMEOUT` /
`KOLM_E_INPUT_TOO_LARGE` error to the caller.

## Packs (the `lora.bin` slot)

A pack is artifact-bound configuration. Use it for static rules, lookup
tables, default categories, fixed regex patterns. The pack lives in the
`lora.bin` slot of the zip, encoded as `KOLMPACK\x01` + a 4-byte length +
UTF-8 JSON.

Use a pack when:
- The data is the same for every tenant who uses this artifact.
- You want it signed and verifiable end-to-end.
- It is small (under ~100 KiB of JSON).

Recipes read the pack via `lib.pack`.

```jsonc
"pack": {
  "spec": "kolm-pack-1",
  "description": "default identifier patterns",
  "enabled_builtins": ["email","phone","url","ipv4","date"],
  "default_patterns": [
    { "name": "SSN_LIKE", "regex": "\\b\\d{3}-\\d{2}-\\d{4}\\b", "replacement": "[SSN]" }
  ]
}
```

## Indexes (the `index.sqlite-vec` slot)

An index is a lookup table — keyword-to-recipe maps, category trees,
weighted dictionaries — that recipes use to dispatch quickly. It lives in
the `index.sqlite-vec` slot, `KOLMIDX\x01` magic, length-prefixed UTF-8.

Recipes read it via `lib.index`. The retrieval-tier (later release)
replaces this slot with a real sqlite-vec database while keeping the slot
name and the call site stable.

```jsonc
"index": {
  "spec": "kolm-index-1",
  "by_keyword": { "redact": "rcp_redactor_v1", "privacy": "rcp_redactor_v1" },
  "by_recipe":  { "rcp_redactor_v1": ["redact","privacy"] }
}
```

## Tenant params — the run-time customisation door

Tenants extend an artifact at run time without re-signing it. Pass JSON
to `kolm run --params` (inline JSON or `@file.json`) or to MCP `tools/call`
in the `params` argument. Recipes see it as `lib.params`.

Why it matters: a hospital can ship its own MRN regex; a bank can ship
its own routing number list; a SaaS support team can add a new triage
category. Same signed artifact bytes, different vertical-specific
behaviour per tenant.

Tenant params are **never persisted** by the runtime, **never re-signed**
into the artifact, and **never logged** beyond the audit-line preview
(first 200 chars of `JSON.stringify(input)`).

Example:

```bash
kolm run redactor.kolm '{"text":"employee 12-345 logged in"}' \
  --params '{"extra_patterns":[{"name":"EMP_ID","regex":"\\b\\d{2}-\\d{3}\\b","replacement":"[EMP_ID]"}]}'
# -> { "redacted": "employee [EMP_ID] logged in", "hits": [{ "name": "EMP_ID", "count": 1 }] }
```

Or from a file:

```bash
kolm run redactor.kolm '{"text":"..."}' --params @hospital-rules.json
```

## Sensitive-data verticals — what we do and do not promise

The artifact runs locally, never reaches a network, and emits a per-call
audit log entry (`kolm-audit-1`: artifact id, recipe id, input sha256
prefix, latency, timestamp, ok/error). The egress monitor patches `fetch`,
`http`, `https`, `net`, `tls`, `dns` at the process boundary; any attempt
counts as `privacy.runtime_egress_attempts > 0` in the benchmark output.
Targets are zero. If you see one, file a github issue.

What this **does** give you:
- A signed, byte-stable description of the rules your data was processed under.
- A receipt chain (5 HMAC steps) you can re-verify offline from the artifact bytes alone.
- A run that does not phone home, does not write logs to disk, does not retain inputs.

What this does **not** give you (be honest with yourself before shipping):
- Any compliance attestation. HIPAA, PCI-DSS, GDPR, SOX, FedRAMP, SOC 2 — these are organisational programs that audit your end-to-end operating environment, not the artifact format. Running a `.kolm` on a non-compliant host is still non-compliant.
- A guarantee about the recipe's correctness. The recipe is whatever you wrote. Test it. The eval set is the floor of what you should test.
- Anything about the **input** beyond what you control. If your application logs `input` somewhere outside the kolm runtime, that is your responsibility.

## Common patterns

### A redactor for clinic notes

Use the `redactor` template. Edit `pack.default_patterns` to include your
MRN format, your insurance ID format, and your DOB format. Use
`enabled_builtins: ['email','phone']` to keep the built-in primitives
that already match. Test on synthetic data first.

```jsonc
{
  "job_id": "job_clinic_redactor_v1",
  "task":   "redact PHI patterns from outbound clinic notes",
  "recipes": [{ "id":"rcp_redact","name":"clinic redactor", "source": "..." }],
  "pack": {
    "enabled_builtins": ["email","phone","url"],
    "default_patterns": [
      { "name":"MRN",         "regex":"\\bMRN[- ]?\\d{6,}\\b", "replacement":"[MRN]" },
      { "name":"NPI",         "regex":"\\b\\d{10}\\b",         "replacement":"[NPI]" }
    ]
  }
}
```

### A field extractor for personal banking

Use the `extractor` template. Each rule names a field, a regex, an
optional capture group, and an optional transform (`upper`, `lower`,
`trim`, `number`).

```jsonc
"pack": {
  "default_rules": [
    { "name":"routing_number", "regex":"\\b\\d{9}\\b" },
    { "name":"masked_account", "regex":"\\bxxx-\\d{4}\\b" },
    { "name":"transaction_amount", "regex":"\\$([\\d,]+\\.\\d{2})", "group":1, "transform":"number" }
  ]
}
```

### A classifier for triage

Use the `classifier` template. Each category names keywords; matches are
counted (case-insensitive) and weighted. The top scoring category wins.

```jsonc
"pack": {
  "fallback_label": "general",
  "categories": [
    { "name":"chargeback",   "keywords":["dispute","chargeback","unauthorized"] },
    { "name":"reset",        "keywords":["forgot password","reset","locked out"] }
  ]
}
```

## AI-agent authoring

LLMs are good at writing recipes from a few examples. The minimum prompt
that produces a working `.kolm`:

```
Output a JSON spec for kolm. The spec must:
- have job_id like "job_<slug>_v1"
- have a single recipe whose source is `function generate(input, lib) { ... }`
- include 2+ eval cases with concrete inputs and expected outputs
- not call fetch, require, or any I/O
- not exceed 1000ms or 1MiB
Task: <one-sentence task description>.
Examples: <2-3 input/output pairs>.
```

Pipe the result straight to compile:

```bash
echo "$LLM_OUTPUT" | kolm compile --spec - --out my-task.kolm
```

The CLI runs `validateSpec` (which calls `compileJs` on every recipe
source) before any zip is written. If the LLM produced syntactically
broken JS, you get a structured `KOLM_E_SPEC_INVALID` with the exact
parse error and the recipe id that failed. Iterate.

## Errors you will see

| code | meaning |
|---|---|
| `KOLM_E_SPEC_INVALID` | the spec is missing a field, has the wrong shape, or a recipe will not compile |
| `KOLM_E_INPUT_TOO_LARGE` | the run-time input exceeded the 1MiB cap |
| `KOLM_E_NO_RECIPES` | the artifact has no recipes; should not happen if `validateSpec` passed |
| `KOLM_E_NO_RECIPE_HANDLED` | every recipe in the artifact threw or timed out for the given input |
| `KOLM_E_RECIPE_TIMEOUT` | a recipe exceeded the per-call timeout (default 1000ms) |
| `KOLM_E_SIGNATURE_INVALID` | the manifest HMAC does not match the configured secret — almost always a wrong `RECIPE_RECEIPT_SECRET` |
| `KOLM_E_PACK_DECODE` | `lora.bin` slot has a corrupt KOLMPACK container |
| `KOLM_E_INDEX_DECODE` | `index.sqlite-vec` slot has a corrupt KOLMIDX container |

Every error returned by the CLI carries `code` so callers can branch.

## Receipts and reproducibility

Every artifact ships a 5-step HMAC chain inside `receipt.json`:

```
1. task     -> sha256(canonical task)
2. seeds    -> sha256(canonical training_stats)
3. recipes  -> sha256(canonical recipes_json)
4. evals    -> sha256(canonical evals_json)
5. package  -> sha256(canonical artifact_hash)
```

Each step is sealed with `HMAC-SHA256(secret, canonical_json({step,
input_hash, output_hash}))`. A verifier with the same secret can recompute
the chain offline. The receipt body is also signed (`signature` field).

The signed *content* is byte-stable: same secret + same recipe source +
same evals ⇒ same artifact_hash, same receipt. The zip wrapper bytes are
not byte-stable across rebuilds — `created_at`, `receipt_id` (UUID), and
zip entry mtimes use wall-clock time. For air-gapped audits, capture the
artifact once and verify hashes from the captured bytes.

## Commands referenced here

```
kolm new <name> [--from blank|redactor|extractor|classifier] [--out <file>]
kolm compile --spec <file|-> [--out <file.kolm|dir>]
kolm run <artifact.kolm> '<input-json>' [--params <json|@file>]
kolm eval <artifact.kolm>
kolm bench <artifact.kolm> [--runs <n>] [--target <name>] [--device <name>]
kolm inspect <artifact.kolm>
kolm score <artifact.kolm>
kolm serve --mcp [--http] [--port <n>]
```

Run any of them with `--help` for full options.
