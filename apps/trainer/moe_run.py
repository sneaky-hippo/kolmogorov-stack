"""Thin CLI wrapper that emits a bridge-ready MoE manifest.

Why: src/moe-provenance.js (wave 147) prefers manifest-driven input — a dir
containing `manifest.json` with `kolm_moe: true` + per-expert + router sha256
declarations. The Node-side bridge will recompute every hash and fail loud on
drift, so the manifest is an authoritative record of what was composed.

Two modes:

  1. --train (full mode, requires torch + transformers): runs
     apps.trainer.moe.moe_router_trainer over `--train-jsonl`, saves
     router.pt, then writes manifest.json.

  2. --compose (default, no ML deps): takes an already-trained router.pt and
     a set of `--expert name=path` pairs, hashes them all, and writes the
     manifest. Lets us produce bridge-ready output in CI without torch.

The `.kolm` artifact is NOT modified here. `kolm compile --spec ...
--moe-provenance <out-dir>` is what binds the MoE composition into a fresh
signed `.kolm` via the Node-side src/moe-provenance.js bridge.

Manifest schema (mirrors apps/export/run.py's structure):

    {
      "kolm_moe": true,
      "kolm_moe_version": "0.1.0",
      "base_model": "Qwen/Qwen2.5-3B-Instruct",
      "routing_strategy": "top_1" | "top_k",
      "top_k": 1,
      "composed_at": "ISO8601",
      "router": {
        "filename": "router.pt",
        "sha256": "<hex64>",
        "size_bytes": 12345,
        "hidden_size": 2048,
        "router_hidden": 256
      },
      "experts": [
        { "name": "phi_redactor", "filename": "phi.kolm",
          "sha256": "<hex64>", "size_bytes": 67890, "cid": "..." }
      ],
      "training_stats": { "loss_final": ..., "eval_accuracy": ..., ... }?
    }
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

KOLM_MOE_VERSION = "0.1.0"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _hash_dir(root: Path) -> Dict[str, Any]:
    """Canonical recursive hash for directory experts.

    Mirrors src/moe-provenance.js hashDir() (which itself mirrors
    src/export-provenance.js hashDir()): sort by posix-rel-path, join
    `(rel \\0 sha256 \\0 size)` lines with `\\n`, sha256 the result.
    """
    entries: List[Dict[str, Any]] = []
    size_total = 0
    for sub in sorted(root.rglob("*")):
        if not sub.is_file():
            continue
        rel = sub.relative_to(root).as_posix()
        sha = _sha256_file(sub)
        size = sub.stat().st_size
        entries.append({"rel": rel, "sha": sha, "size": size})
        size_total += size
    canon = "\n".join(f"{e['rel']}\0{e['sha']}\0{e['size']}" for e in entries)
    return {
        "sha256": hashlib.sha256(canon.encode("utf-8")).hexdigest(),
        "size_bytes": size_total,
        "file_count": len(entries),
    }


def _hash_path(p: Path) -> Dict[str, Any]:
    if p.is_dir():
        h = _hash_dir(p)
        return {"sha256": h["sha256"], "size_bytes": h["size_bytes"], "is_dir": True, "file_count": h["file_count"]}
    return {"sha256": _sha256_file(p), "size_bytes": p.stat().st_size, "is_dir": False, "file_count": 1}


def _parse_expert_args(pairs: List[str]) -> List[Dict[str, str]]:
    """Parse `--expert name=path/to/file.kolm` pairs."""
    out: List[Dict[str, str]] = []
    for pair in pairs or []:
        if "=" not in pair:
            raise SystemExit(f"--expert must be name=path, got: {pair!r}")
        name, path_ = pair.split("=", 1)
        if not name or not path_:
            raise SystemExit(f"--expert must be name=path with both sides non-empty, got: {pair!r}")
        out.append({"name": name, "path": path_})
    return out


def _compose(
    out_dir: Path,
    base_model: str,
    routing_strategy: str,
    top_k: int,
    router_path: Path,
    experts: List[Dict[str, str]],
    training_stats: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Hash an already-trained router + expert files into out_dir and emit
    manifest.json. Files are COPIED into out_dir so the bridge can bundle
    them directly without chasing absolute paths from the manifest."""
    out_dir.mkdir(parents=True, exist_ok=True)

    # Copy router
    if not router_path.exists():
        raise SystemExit(f"router file not found: {router_path}")
    router_dst = out_dir / router_path.name
    if router_path.resolve() != router_dst.resolve():
        router_dst.write_bytes(router_path.read_bytes())
    router_hash = _hash_path(router_dst)

    # Copy each expert
    expert_blocks: List[Dict[str, Any]] = []
    for e in experts:
        src = Path(e["path"])
        if not src.exists():
            raise SystemExit(f"expert {e['name']!r} file not found: {src}")
        dst = out_dir / src.name
        if src.resolve() != dst.resolve():
            if src.is_dir():
                # shallow copy: walk, mirror
                import shutil
                if dst.exists():
                    shutil.rmtree(dst)
                shutil.copytree(src, dst)
            else:
                dst.write_bytes(src.read_bytes())
        h = _hash_path(dst)
        expert_blocks.append({
            "name": e["name"],
            "filename": src.name,
            "sha256": h["sha256"],
            "size_bytes": h["size_bytes"],
            **({"is_dir": True, "file_count": h["file_count"]} if h["is_dir"] else {}),
        })

    manifest: Dict[str, Any] = {
        "kolm_moe": True,
        "kolm_moe_version": KOLM_MOE_VERSION,
        "base_model": base_model,
        "routing_strategy": routing_strategy,
        "top_k": int(top_k),
        "composed_at": _dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "router": {
            "filename": router_dst.name,
            "sha256": router_hash["sha256"],
            "size_bytes": router_hash["size_bytes"],
        },
        "experts": expert_blocks,
    }
    if training_stats:
        manifest["training_stats"] = training_stats
    return manifest


def _train(args: argparse.Namespace, out_dir: Path) -> Dict[str, Any]:
    """Full-mode: invoke apps.trainer.moe.moe_router_trainer and then
    compose. Imported lazily so the --compose path stays torch-free."""
    try:
        from . import moe as _moe
    except Exception as e:  # pragma: no cover - import is the test
        raise SystemExit(f"--train requires apps.trainer.moe importable: {e}")

    experts = _parse_expert_args(args.expert)
    expert_map = {e["name"]: e["path"] for e in experts}

    cfg = _moe.MoEConfig(
        routing=_moe.RoutingMode.from_str(args.routing_strategy),
        k=int(args.top_k),
    )
    session = _moe.moe_router_trainer(
        base_model=args.base_model,
        experts=expert_map,
        train_jsonl=args.train_jsonl,
        out_dir=str(out_dir),
        config=cfg,
        eval_jsonl=args.eval_jsonl,
    )
    stats = session.train()
    # The trainer writes router.pt into out_dir. Re-hash it for the manifest.
    return _compose(
        out_dir=out_dir,
        base_model=args.base_model,
        routing_strategy=args.routing_strategy,
        top_k=int(args.top_k),
        router_path=out_dir / "router.pt",
        experts=experts,
        training_stats=stats,
    )


def main(argv: List[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="apps.trainer.moe_run", description=__doc__)
    p.add_argument("--out", required=True, help="output directory for router + experts + manifest.json")
    p.add_argument("--base-model", required=True, help="base model id (informational; recorded in manifest)")
    p.add_argument("--routing-strategy", default="top_1", choices=["top_1", "top_k"], help="routing mode")
    p.add_argument("--top-k", default=1, type=int, help="experts per input (>=2 for top_k)")
    p.add_argument("--expert", action="append", default=[], help="expert; name=path; repeat for multiple")
    p.add_argument("--router", default=None, help="path to trained router (.pt); required when --compose")
    p.add_argument("--compose", action="store_true", help="hash & manifest existing router+experts (no torch required)")
    p.add_argument("--train", action="store_true", help="invoke apps.trainer.moe to train router (requires torch)")
    p.add_argument("--train-jsonl", default=None, help="training JSONL (--train mode)")
    p.add_argument("--eval-jsonl", default=None, help="optional held-out eval JSONL (--train mode)")
    args = p.parse_args(argv)

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    experts = _parse_expert_args(args.expert)
    if len(experts) < 2:
        print("error: need at least 2 --expert name=path pairs", file=sys.stderr)
        return 2
    if args.routing_strategy == "top_k" and args.top_k < 2:
        print("error: --routing-strategy=top_k requires --top-k >= 2", file=sys.stderr)
        return 2

    if args.train and args.compose:
        print("error: --train and --compose are mutually exclusive", file=sys.stderr)
        return 2
    if not (args.train or args.compose):
        # Default to compose if router is provided, else error.
        if args.router:
            args.compose = True
        else:
            print("error: pass --compose with --router <path>, or --train with --train-jsonl", file=sys.stderr)
            return 2

    try:
        if args.compose:
            if not args.router:
                print("error: --compose requires --router <path>", file=sys.stderr)
                return 2
            manifest = _compose(
                out_dir=out_dir,
                base_model=args.base_model,
                routing_strategy=args.routing_strategy,
                top_k=int(args.top_k),
                router_path=Path(args.router),
                experts=experts,
            )
        else:
            if not args.train_jsonl:
                print("error: --train requires --train-jsonl <path>", file=sys.stderr)
                return 2
            manifest = _train(args, out_dir)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"moe_run failed: {e}", file=sys.stderr)
        return 3

    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({
        "manifest": str(manifest_path),
        "experts": len(manifest["experts"]),
        "routing_strategy": manifest["routing_strategy"],
        "top_k": manifest["top_k"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
