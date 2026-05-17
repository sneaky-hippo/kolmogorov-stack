"""Thin CLI wrapper that emits a bridge-ready KOLMIDX2/KOLMPCK2 pretokenize
bundle.

Why: src/pretokenize-provenance.js (wave 148) consumes a directory containing
a `manifest.json` (with `kolm_pretokenize: true`), `tokens.idx`, and
`tokens.pack`. The Node bridge recomputes every hash from disk and refuses any
manifest that does not carry the marker. This script writes those three files.

Two modes:

  1. --build (default): reads a seeds-style JSONL where each row has at least
     `input` (and optionally `output`), tokenises every `input` with the named
     tokenizer, and packs the result into `tokens.idx` + `tokens.pack`.
     Requires `transformers` (or `tokenizers`) only when --tokenizer-family
     != 'identity'. For CI without ML deps, use --tokenizer-family=identity
     (treats each whitespace-split word as a token id via stable hash).

  2. --compose: takes already-prepared tokens.idx + tokens.pack (e.g. produced
     by an offline pipeline) and just writes the manifest by hashing the two
     files. Lets a tenant ship pretokenize bundles from their own infra
     without re-running this script.

Binary formats (little-endian, mmap-friendly):

  tokens.idx:
    [ 0:8 ]   magic   = b"KOLMIDX2"
    [ 8:12]   version = u32 (1)
    [12:16]   seq_count = u32
    [16:20]   vocab_size = u32
    [20:24]   reserved = u32 (0)
    then `seq_count` records of 48 bytes each (sorted by input_hash):
      [+0 : +32]  input_hash  = sha256(input_text) raw bytes
      [+32: +40]  pack_offset = u64 (byte offset into tokens.pack PAYLOAD)
      [+40: +44]  token_count = u32
      [+44: +48]  reserved = u32 (0)

  tokens.pack:
    [ 0:8 ]   magic   = b"KOLMPCK2"
    [ 8:12]   version = u32 (1)
    [12:16]   vocab_size = u32
    [16:24]   reserved = u64 (0)
    PAYLOAD starts at byte 24:
      concatenated u32-LE token_ids; pack_offset values in tokens.idx are
      byte offsets RELATIVE to the start of PAYLOAD, so token i of record r
      lives at PAYLOAD[record_r.pack_offset + i*4 : ... + 4].

Why two files instead of one self-contained blob: mmap of the .idx alone lets
a verifier (or runtime) binary-search by input_hash without paging in any
token bytes; mmap of the .pack alone lets a runtime stream tokens without
parsing the index. Both files live in the artifact's extra_files, so the
zip's seek table makes them addressable without extracting.

Manifest schema (mirrors apps/trainer/moe_run.py and apps/export/run.py):

    {
      "kolm_pretokenize": true,
      "kolm_pretokenize_version": "0.1.0",
      "tokenizer_id": "Qwen/Qwen2.5-3B-Instruct",
      "tokenizer_family": "bpe" | "sentencepiece" | "tiktoken" | "identity",
      "vocab_size": 152064,
      "seq_count": 25,
      "source": "seeds.jsonl",
      "source_input_count": 25,
      "encoded_at": "ISO8601",
      "idx_file":  { "filename": "tokens.idx",  "sha256": "<hex64>", "size_bytes": ... },
      "pack_file": { "filename": "tokens.pack", "sha256": "<hex64>", "size_bytes": ... },
      "stats": { "total_tokens": ..., "avg_tokens_per_seq": ...,
                 "min_tokens": ..., "max_tokens": ...,
                 "p50_tokens": ..., "p95_tokens": ... }
    }
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import struct
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

KOLM_PRETOKENIZE_VERSION = "0.1.0"
IDX_MAGIC = b"KOLMIDX2"
PACK_MAGIC = b"KOLMPCK2"
BINARY_VERSION = 1
IDX_HEADER_SIZE = 24
PACK_HEADER_SIZE = 24
IDX_RECORD_SIZE = 48


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_bytes(buf: bytes) -> bytes:
    return hashlib.sha256(buf).digest()


def _identity_tokenize(text: str) -> List[int]:
    """Deterministic, dependency-free tokeniser for CI.

    Splits on whitespace, hashes each token to a u32 in [1, 65535] so all
    token ids fit a 16-bit "vocab" for easy round-trip testing. NOT a real
    tokeniser; only meaningful for cold-start latency tests where token
    identity does not matter.
    """
    ids: List[int] = []
    for word in text.split():
        h = hashlib.sha256(word.encode("utf-8")).digest()
        ids.append(1 + (int.from_bytes(h[:2], "little") % 65535))
    return ids


def _real_tokenize(text: str, tokenizer) -> List[int]:
    out = tokenizer.encode(text, add_special_tokens=False)
    if not isinstance(out, list):
        out = list(out)
    return [int(t) for t in out]


def _load_tokenizer(tokenizer_id: str, family: str):
    if family == "identity":
        return None
    if family in ("bpe", "sentencepiece", "tiktoken"):
        try:
            from transformers import AutoTokenizer
        except Exception as exc:
            raise SystemExit(
                f"--tokenizer-family={family} requires `pip install transformers`. "
                f"For dependency-free CI use --tokenizer-family=identity. ({exc})"
            )
        return AutoTokenizer.from_pretrained(tokenizer_id, trust_remote_code=True)
    raise SystemExit(f"unknown --tokenizer-family={family!r}")


def _percentile(values: List[int], pct: float) -> int:
    if not values:
        return 0
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round(pct / 100.0 * (len(s) - 1)))))
    return int(s[k])


def _build_bundle(
    rows: Iterable[Dict[str, Any]],
    tokenizer_id: str,
    family: str,
    out_dir: Path,
) -> Tuple[Dict[str, Any], int]:
    tokenizer = _load_tokenizer(tokenizer_id, family)
    if family == "identity":
        vocab_size = 65536
    else:
        vocab_size = int(getattr(tokenizer, "vocab_size", 0) or len(tokenizer.get_vocab()))

    records: List[Tuple[bytes, int, int]] = []
    pack_payload = bytearray()
    token_counts: List[int] = []
    source_input_count = 0

    for row in rows:
        if "input" not in row:
            continue
        source_input_count += 1
        text = str(row["input"])
        ids = _identity_tokenize(text) if family == "identity" else _real_tokenize(text, tokenizer)
        input_hash = _sha256_bytes(text.encode("utf-8"))
        pack_offset = len(pack_payload)
        for tid in ids:
            pack_payload.extend(struct.pack("<I", int(tid) & 0xFFFFFFFF))
        token_counts.append(len(ids))
        records.append((input_hash, pack_offset, len(ids)))

    records.sort(key=lambda r: r[0])
    seq_count = len(records)

    idx_buf = bytearray()
    idx_buf.extend(IDX_MAGIC)
    idx_buf.extend(struct.pack("<IIII", BINARY_VERSION, seq_count, vocab_size, 0))
    for input_hash, pack_offset, token_count in records:
        idx_buf.extend(input_hash)
        idx_buf.extend(struct.pack("<QII", pack_offset, token_count, 0))

    pack_buf = bytearray()
    pack_buf.extend(PACK_MAGIC)
    pack_buf.extend(struct.pack("<IIQ", BINARY_VERSION, vocab_size, 0))
    pack_buf.extend(pack_payload)

    out_dir.mkdir(parents=True, exist_ok=True)
    idx_path = out_dir / "tokens.idx"
    pack_path = out_dir / "tokens.pack"
    idx_path.write_bytes(bytes(idx_buf))
    pack_path.write_bytes(bytes(pack_buf))

    total_tokens = sum(token_counts)
    stats = {
        "total_tokens": total_tokens,
        "avg_tokens_per_seq": (total_tokens / seq_count) if seq_count else 0.0,
        "min_tokens": min(token_counts) if token_counts else 0,
        "max_tokens": max(token_counts) if token_counts else 0,
        "p50_tokens": _percentile(token_counts, 50),
        "p95_tokens": _percentile(token_counts, 95),
    }

    manifest: Dict[str, Any] = {
        "kolm_pretokenize": True,
        "kolm_pretokenize_version": KOLM_PRETOKENIZE_VERSION,
        "tokenizer_id": tokenizer_id,
        "tokenizer_family": family,
        "vocab_size": vocab_size,
        "seq_count": seq_count,
        "source_input_count": source_input_count,
        "encoded_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "idx_file": {
            "filename": "tokens.idx",
            "sha256": _sha256_file(idx_path),
            "size_bytes": idx_path.stat().st_size,
        },
        "pack_file": {
            "filename": "tokens.pack",
            "sha256": _sha256_file(pack_path),
            "size_bytes": pack_path.stat().st_size,
        },
        "stats": stats,
    }
    return manifest, seq_count


def _compose_manifest(
    idx_path: Path,
    pack_path: Path,
    tokenizer_id: str,
    family: str,
    seq_count_hint: int,
    vocab_size_hint: int,
) -> Dict[str, Any]:
    if not idx_path.exists():
        raise SystemExit(f"--idx {idx_path}: not found")
    if not pack_path.exists():
        raise SystemExit(f"--pack {pack_path}: not found")
    idx_header = idx_path.read_bytes()[:IDX_HEADER_SIZE]
    if idx_header[:8] != IDX_MAGIC:
        raise SystemExit(f"{idx_path}: bad magic (expected {IDX_MAGIC!r})")
    _ver, seq_count, vocab_size, _rsv = struct.unpack("<IIII", idx_header[8:24])
    if seq_count_hint and seq_count_hint != seq_count:
        raise SystemExit(f"seq_count mismatch: --seq-count={seq_count_hint} but tokens.idx says {seq_count}")
    if vocab_size_hint and vocab_size_hint != vocab_size:
        raise SystemExit(f"vocab_size mismatch: --vocab-size={vocab_size_hint} but tokens.idx says {vocab_size}")
    return {
        "kolm_pretokenize": True,
        "kolm_pretokenize_version": KOLM_PRETOKENIZE_VERSION,
        "tokenizer_id": tokenizer_id,
        "tokenizer_family": family,
        "vocab_size": vocab_size,
        "seq_count": seq_count,
        "source_input_count": seq_count,
        "encoded_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "idx_file": {
            "filename": idx_path.name,
            "sha256": _sha256_file(idx_path),
            "size_bytes": idx_path.stat().st_size,
        },
        "pack_file": {
            "filename": pack_path.name,
            "sha256": _sha256_file(pack_path),
            "size_bytes": pack_path.stat().st_size,
        },
        "stats": None,
    }


def main(argv: List[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="emit a KOLMIDX2/KOLMPCK2 pretokenize bundle for kolm")
    p.add_argument("--out", required=True, help="output directory")
    p.add_argument("--tokenizer-id", required=True, help='tokenizer identifier (e.g. "Qwen/Qwen2.5-3B-Instruct")')
    p.add_argument("--tokenizer-family", default="identity",
                   choices=["identity", "bpe", "sentencepiece", "tiktoken"],
                   help="identity = dependency-free CI tokeniser")
    sub = p.add_mutually_exclusive_group(required=True)
    sub.add_argument("--build", metavar="SEEDS_JSONL", help="path to seeds-style JSONL to tokenise")
    sub.add_argument("--compose", action="store_true",
                     help="hash existing --idx / --pack files into a manifest (no tokenisation)")
    p.add_argument("--idx", help="(--compose) path to tokens.idx")
    p.add_argument("--pack", help="(--compose) path to tokens.pack")
    p.add_argument("--seq-count", type=int, default=0, help="(--compose) optional seq_count assertion")
    p.add_argument("--vocab-size", type=int, default=0, help="(--compose) optional vocab_size assertion")
    args = p.parse_args(argv)

    out_dir = Path(args.out).resolve()
    if args.build:
        seeds_path = Path(args.build).resolve()
        if not seeds_path.exists():
            print(f"error: --build {seeds_path}: not found", file=sys.stderr)
            return 2
        rows: List[Dict[str, Any]] = []
        with seeds_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
        manifest, seq_count = _build_bundle(rows, args.tokenizer_id, args.tokenizer_family, out_dir)
        manifest["source"] = str(seeds_path.name)
    else:
        if not args.idx or not args.pack:
            print("error: --compose requires --idx and --pack", file=sys.stderr)
            return 2
        manifest = _compose_manifest(
            Path(args.idx).resolve(),
            Path(args.pack).resolve(),
            args.tokenizer_id,
            args.tokenizer_family,
            args.seq_count,
            args.vocab_size,
        )
        seq_count = manifest["seq_count"]
        out_dir.mkdir(parents=True, exist_ok=True)
        if Path(args.idx).resolve().parent != out_dir:
            (out_dir / "tokens.idx").write_bytes(Path(args.idx).resolve().read_bytes())
            manifest["idx_file"]["filename"] = "tokens.idx"
        if Path(args.pack).resolve().parent != out_dir:
            (out_dir / "tokens.pack").write_bytes(Path(args.pack).resolve().read_bytes())
            manifest["pack_file"]["filename"] = "tokens.pack"

    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps({"ok": True, "out": str(out_dir), "seq_count": seq_count,
                      "tokenizer_id": args.tokenizer_id, "manifest": str(manifest_path)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
