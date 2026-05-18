# kolm tail

Stream live capture rows from your kolm cloud over Server-Sent Events.
The CLI mirror of the live-tail strip on `/captures` (W213). Reads from the
same durable capture store (W212) so what you see in `kolm tail` is what is
auditable on the dashboard.

## Usage

```
kolm tail captures [--namespace <name>|*] [--limit N] [--json]
```

`captures` is currently the only sub-verb. `--namespace *` (default) streams
every namespace your key is scoped to; pass an exact namespace name to filter.
`--limit N` exits cleanly after N rows. `--json` emits raw JSONL frames
instead of the default human-readable line format.

## Examples

```
kolm tail captures                                live tail, all namespaces
kolm tail captures --namespace eng                only namespace=eng
kolm tail captures --limit 50                     first 50 rows then exit
kolm tail captures --json | jq '.template_hash'   pipe SSE JSONL into jq
```

## Output format

Default (human-readable):

```
2026-05-18T14:02:11Z [eng] gpt-4o-mini 142ms | summarize this incident report...
```

`--json` (one row per line):

```
{"ts":"...","tenant":"...","corpus_namespace":"eng","model":"...","latency_us":142000,"prompt":"...","response":"..."}
```

## Headers (when the stream opens)

The `event: hello` frame includes:

- `driver` - which capture store backend served the request
  (`vercel_postgres` / `vercel_kv` / `legacy`).
- `durable` - whether the backend survives lambda recycling.
- `subscriber_count` - how many live tails are open for your tenant.

The same metadata is surfaced as response headers (`x-kolm-capture-driver`,
`x-kolm-capture-durable`) on every capture write.

## See also

- `/captures` - the dashboard's live-tail strip + drift-aware durability matrix.
- `kolm distill --from-captures --namespace <n>` to promote captured pairs into
  a recipe (W214). Use `--preview` first to see which mode (recipe vs Specialist
  LoRA) would fire.
- `/spec/rs-1` for the receipt-chain contract that captures feed into.
- `kolm capture` for the request-time capture verb.
