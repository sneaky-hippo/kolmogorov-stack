"""``recipe`` CLI — installed via ``pip install kolmogorov-recipe``."""

from __future__ import annotations

import json
import sys
from typing import List, Sequence

from .client import RecipeClient, RecipeError

USAGE = """\
recipe — show your AI agent how once, run forever.

Commands:
  recipe run <name-or-id> <input>           run a recipe
  recipe synthesize <examples.json>         synthesize from a JSON file
  recipe search "<query>" [--k=5]           semantic search the registry
  recipe list [--tag <tag>] [--limit N]     list recipes
  recipe get <recipe_id>                    get full recipe metadata
  recipe stats <recipe_id>                  invocation/latency stats
  recipe featured                           list curated public recipes
  recipe compose "<query>" "<input>"        compose top-k matched recipes
  recipe label <recipe_id> <rows.json>      auto-label inline rows
  recipe waitlist <email> "<task>"          reserve a Specialist slot
  recipe specialists                        list your Specialists
  recipe account                            show your tenant + quota
  recipe health                             health check

Env:
  KOLM_API_KEY          bearer token (preferred; also RECIPE_API_KEY, KOLMOGOROV_API_KEY)
  KOLM_BASE_URL         override API base (also RECIPE_BASE_URL); default https://kolm.ai
"""


def _print(out) -> None:
    if isinstance(out, str):
        print(out)
    else:
        print(json.dumps(out, indent=2))


def _kw(args: Sequence[str], key: str, default=None):
    """Pluck `--key value` or `--key=value` out of args (mutates a list copy)."""
    out = list(args)
    full = f"--{key}"
    for i, a in enumerate(out):
        if a == full and i + 1 < len(out):
            return out[i + 1], out[:i] + out[i + 2 :]
        if a.startswith(full + "="):
            return a.split("=", 1)[1], out[:i] + out[i + 1 :]
    return default, out


def main(argv: List[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0

    cmd, rest = argv[0], argv[1:]
    c = RecipeClient()

    try:
        if cmd == "run":
            if len(rest) < 2:
                print("usage: recipe run <name-or-id> <input>", file=sys.stderr)
                return 2
            ref, inp = rest[0], " ".join(rest[1:])
            if ref.startswith("cpt_"):
                _print(c.run(recipe_id=ref, input=inp))
            elif ref.startswith("ver_"):
                _print(c.run(version_id=ref, input=inp))
            else:
                _print(c.public_run(name=ref, input=inp))

        elif cmd == "synthesize":
            if not rest:
                print("usage: recipe synthesize <examples.json>", file=sys.stderr)
                return 2
            with open(rest[0], "r", encoding="utf-8") as f:
                payload = json.load(f)
            _print(c.synthesize(**payload) if isinstance(payload, dict) else c.synthesize(positives=payload))

        elif cmd == "search":
            if not rest:
                print('usage: recipe search "<query>" [--k=5]', file=sys.stderr)
                return 2
            k_val, rest2 = _kw(rest, "k", 5)
            query = " ".join(rest2)
            _print(c.search(query, int(k_val)))

        elif cmd == "list":
            tag, rest2 = _kw(rest, "tag")
            limit, rest2 = _kw(rest2, "limit")
            _print(c.list(tag=tag, limit=int(limit) if limit else None))

        elif cmd == "get":
            _print(c.get(rest[0]))

        elif cmd == "stats":
            _print(c.stats(rest[0]))

        elif cmd == "featured":
            _print(c.featured())

        elif cmd == "compose":
            if len(rest) < 2:
                print('usage: recipe compose "<query>" "<input>"', file=sys.stderr)
                return 2
            _print(c.compose(query=rest[0], input=rest[1]))

        elif cmd == "label":
            if len(rest) < 2:
                print("usage: recipe label <recipe_id> <rows.json>", file=sys.stderr)
                return 2
            with open(rest[1], "r", encoding="utf-8") as f:
                rows = json.load(f)
            _print(c.label_corpus(rest[0], rows=rows))

        elif cmd == "waitlist":
            if len(rest) < 2:
                print('usage: recipe waitlist <email> "<task>"', file=sys.stderr)
                return 2
            _print(c.waitlist_specialist(rest[0], " ".join(rest[1:])))

        elif cmd == "specialists":
            _print(c.list_specialists())

        elif cmd == "account":
            _print(c.account())

        elif cmd == "health":
            _print(c.health())

        else:
            print(f"unknown command: {cmd}\n", file=sys.stderr)
            print(USAGE, file=sys.stderr)
            return 2

        return 0
    except RecipeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
