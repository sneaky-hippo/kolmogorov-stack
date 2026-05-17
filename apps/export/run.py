"""Thin CLI wrapper that runs an exporter and writes a bridge-ready manifest.

Why: src/export-provenance.js (wave 146) prefers manifest-driven input — a
dir containing `manifest.json` with `kolm_export: true` + per-target sha256
declarations. The Node-side bridge will recompute every hash and fail loud
on drift, so the manifest is an authoritative record of what was produced.

Usage:
    python -m apps.export.run \\
        --backend gguf \\
        --artifact ./out/my-model.kolm \\
        --out ./out/export/ \\
        --quantization q4_k_m

The runner:
  1. Calls the registered exporter for --backend with the supplied options.
  2. Walks the output dir (recursively for directory targets like .mlpackage),
     computes sha256 + size for every produced file/dir.
  3. Writes `manifest.json` with `kolm_export: true` so the Node bridge picks
     it up as authoritative.

The artifact `.kolm` is NOT modified here. `kolm compile --spec ...
--export-provenance <out-dir>` is what binds the exporter output into a
fresh signed `.kolm`.
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

from . import get_exporter
from .registry import ExportError

KOLM_EXPORT_VERSION = "0.1.0"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _hash_dir(root: Path) -> Dict[str, Any]:
    """Canonical recursive hash for directory targets.

    Mirrors src/export-provenance.js hashDir(): walk all files, sort by
    posix-style relative path, concatenate (rel \\0 sha256 \\0 size) lines.
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


_DIR_TARGET_SUFFIXES = (".mlpackage", "mlx_model")
_FILE_TARGET_EXTS = {
    ".gguf": "gguf",
    ".onnx": "onnx",
    ".safetensors": "safetensors",
    ".pte": "executorch",
}


def _infer_format(name: str, is_dir: bool) -> str | None:
    lower = name.lower()
    if is_dir:
        if lower.endswith(".mlpackage"):
            return "coreml"
        if lower.endswith("mlx_model"):
            return "mlx"
        if lower == "engine":
            return "tensorrt"
        return None
    for ext, fmt in _FILE_TARGET_EXTS.items():
        if lower.endswith(ext):
            return fmt
    return None


def _scan_targets(out_dir: Path) -> List[Dict[str, Any]]:
    targets: List[Dict[str, Any]] = []
    for child in sorted(out_dir.iterdir()):
        if child.name == "manifest.json":
            continue
        is_dir = child.is_dir()
        fmt = _infer_format(child.name, is_dir)
        if not fmt:
            continue
        if is_dir:
            h = _hash_dir(child)
            targets.append({
                "format": fmt,
                "filename": child.name,
                "sha256": h["sha256"],
                "size_bytes": h["size_bytes"],
                "is_dir": True,
                "file_count": h["file_count"],
            })
        else:
            targets.append({
                "format": fmt,
                "filename": child.name,
                "sha256": _sha256_file(child),
                "size_bytes": child.stat().st_size,
            })
    return targets


def _parse_options(opt_pairs: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for pair in opt_pairs or []:
        if "=" not in pair:
            raise SystemExit(f"--option must be key=value, got: {pair!r}")
        k, v = pair.split("=", 1)
        # Coerce numerics so e.g. context_length=8192 lands as int.
        try:
            out[k] = int(v)
            continue
        except ValueError:
            pass
        try:
            out[k] = float(v)
            continue
        except ValueError:
            pass
        if v.lower() in ("true", "false"):
            out[k] = v.lower() == "true"
            continue
        out[k] = v
    return out


def main(argv: List[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="apps.export.run", description=__doc__)
    p.add_argument("--backend", required=True, help="exporter name (gguf|onnx|coreml|mlx|executorch|tensorrt)")
    p.add_argument("--artifact", required=True, help="path to source .kolm artifact")
    p.add_argument("--out", required=True, help="output directory for export targets + manifest.json")
    p.add_argument("--option", action="append", default=[], help="backend option (key=value); repeat for multiple")
    p.add_argument("--source-artifact-hash", default=None, help="optional sha256 of the source artifact (recorded in manifest)")
    p.add_argument("--dry-run-scan", action="store_true", help="don't call exporter; just scan an existing out dir and emit manifest")
    args = p.parse_args(argv)

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    options = _parse_options(args.option)

    if not args.dry_run_scan:
        try:
            runner = get_exporter(args.backend)
        except ExportError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        try:
            runner(artifact_path=args.artifact, out_dir=str(out_dir), **options)
        except ExportError as e:
            print(f"export failed: {e}", file=sys.stderr)
            return 3
        except Exception as e:  # noqa: BLE001 — exporter-side surprises shouldn't crash run.py
            print(f"export error: {e}", file=sys.stderr)
            return 3

    targets = _scan_targets(out_dir)
    if not targets:
        print(f"error: no recognized export targets in {out_dir}", file=sys.stderr)
        return 4

    source_hash = args.source_artifact_hash
    if not source_hash:
        artifact_path = Path(args.artifact)
        if artifact_path.exists() and artifact_path.is_file():
            source_hash = _sha256_file(artifact_path)

    manifest: Dict[str, Any] = {
        "kolm_export": True,
        "kolm_export_version": KOLM_EXPORT_VERSION,
        "backend": args.backend,
        "exported_at": _dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "targets": targets,
    }
    if source_hash:
        manifest["source_artifact_hash"] = source_hash
    if options:
        manifest["options"] = options

    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"manifest": str(manifest_path), "targets": len(targets), "backend": args.backend}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
