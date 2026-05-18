# kolm inspection verbs

The five read-only CLI verbs you reach for when something is wrong, when a
teammate asks "is it actually working?", or when you need to file a support
ticket. None of them mutate state.

| Verb | Use it when |
|------|-------------|
| `kolm status` | One-line oneliner: am I logged in, what tenant, what base URL |
| `kolm health` | Is the cloud up + how fresh is my key + how many ms is the round trip |
| `kolm metrics` | Aggregate counters for captures / artifacts / jobs in the last 24h |
| `kolm artifacts` | List + show + diff compiled artifacts in your tenant |
| `kolm support-bundle` | Dump env + recent logs + redacted config into a tarball you can attach to a ticket |

## kolm status

```
kolm status                  oneliner: tenant + plan + base
kolm status --json           machine-readable
```

Exits 0 if logged in and the cloud answers, 3 if not logged in, 1 on
network error. Reads only; never mutates config.

## kolm health

```
kolm health                  pings /health and prints the rtt
kolm health --json           {ok, rtt_ms, build_id, sw_cache}
```

The same probe `/value-loop` uses for its live status badge (W312). Useful
to script in CI as a precheck.

## kolm metrics

```
kolm metrics                 24h summary (captures, jobs, artifacts)
kolm metrics --since 1h      window override
kolm metrics --json          machine-readable rollup
```

Aggregates by status (`running` / `done` / `failed`) for jobs and by
namespace for captures. Mirrors the rollup at `/dashboard`.

## kolm artifacts

```
kolm artifacts list                       all artifacts visible to your key
kolm artifacts list --namespace eng       filter by capture namespace
kolm artifacts list --json                machine-readable
kolm artifacts show <hash>                full manifest + receipt chain
kolm artifacts show <hash> --json
kolm artifacts diff <hash-a> <hash-b>     side-by-side manifest diff
```

The `diff` view suppresses noisy fields (signatures, timestamps) and
highlights changes in `recipe_class`, `base_model`, `eval_score`, and
`k_score.composite`. Pair with `kolm verify <hash>` if you need the full
receipt-chain audit.

## kolm support-bundle

```
kolm support-bundle                       writes ./kolm-support-<ts>.tgz
kolm support-bundle --out ~/Desktop       custom directory
kolm support-bundle --redact-extra <re>   add a regex to the redactor
```

Bundles:

- redacted `~/.kolm/config.json` (api_key replaced with its W310 fingerprint)
- last 200 lines of CLI logs from `~/.kolm/logs/`
- output of `kolm status --json` + `kolm health --json` + `kolm metrics --json`
- `kolm doctor --loop --json` if the loop completes within 10s

The redactor strips every value that looks like an API key, JWT, or email
domain before the archive is written. Verify with `tar -tzf` before sending.

## See also

- `/value-loop` and `kolm loop` (W298/W300) - the in-process end-to-end smoke
  the support bundle includes.
- `/dashboard` - the visual analog of `kolm metrics`.
- `kolm verify` - the receipt-chain audit that completes the picture for
  `kolm artifacts show`.
- `/spec/rs-1` - the receipt-chain contract these verbs surface.
