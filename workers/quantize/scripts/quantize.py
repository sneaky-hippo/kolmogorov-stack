#!/usr/bin/env python3
"""
kolm quantize worker — real implementation.

Closes W336 P2: pre-this-file workers/quantize/quantize.mjs honestly returned
``api_status: 'not_yet_wired'`` because the python heavy lift was missing.
This file is that heavy lift.

Methods:
  int4  — bitsandbytes 4-bit (NF4) weight-only quantization
  int8  — bitsandbytes 8-bit (LLM.int8) weight-only quantization
  gptq  — AutoGPTQ post-training quantization (4-bit, group_size=128)
  awq   — AutoAWQ activation-aware weight quantization (4-bit, group_size=128)

CLI contract (matches workers/quantize/quantize.mjs spawn):
  python3 quantize.py --method=int4 --in=<model_dir> --out=<out_dir>

--in must be a HuggingFace-format directory with config.json + tokenizer files
+ weights (safetensors preferred). --out is created if missing; the quantized
model is saved there in HF format. A receipt manifest is written to
<out>/quantize-receipt.json with method, source hash, dtype, device, sha256
of each output shard, finished_at, and tool versions for reproducibility.

Exit codes:
  0  quantized OK; receipt written
  2  --method invalid OR required python deps missing for the method
  3  --in path missing or unreadable
  4  quantization itself raised (model_load / compute / save)

The script keeps imports lazy per-method so e.g. a customer with only
bitsandbytes installed can do int4/int8 without needing auto-gptq/autoawq.
"""

import argparse
import hashlib
import json
import os
import sys
import time
import traceback
from pathlib import Path


def parse_args():
    p = argparse.ArgumentParser(prog="kolm-quantize", add_help=True)
    p.add_argument("--method", required=True, choices=["int4", "int8", "gptq", "awq"])
    p.add_argument("--in", dest="src", required=True, help="HF model directory")
    p.add_argument("--out", dest="dst", required=True, help="output directory")
    p.add_argument("--calib", default=None,
                   help="(gptq/awq only) JSONL file of {text: ...} calibration rows; "
                        "defaults to a small built-in pile sample if omitted")
    p.add_argument("--group-size", type=int, default=128,
                   help="(gptq/awq only) per-group quant resolution")
    p.add_argument("--bits", type=int, default=4,
                   help="(gptq/awq only) quant bit width")
    p.add_argument("--device", default="auto",
                   help="device map for load (auto/cuda/cpu/mps); int4/int8 "
                        "require CUDA for compute, gptq/awq prefer CUDA")
    return p.parse_args()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def hash_input_tree(root):
    """Stable sha256 of the input model directory (sorted relpath:sha lines)."""
    parts = []
    for dirpath, _, files in os.walk(root):
        for fn in sorted(files):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            try:
                parts.append(f"{rel}:{sha256_file(full)}")
            except OSError:
                continue
    parts.sort()
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def hash_output_tree(root):
    out = {}
    for dirpath, _, files in os.walk(root):
        for fn in sorted(files):
            if fn == "quantize-receipt.json":
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            out[rel] = sha256_file(full)
    return out


def fail(code, msg, extra=None):
    payload = {"ok": False, "reason": msg}
    if extra:
        payload.update(extra)
    sys.stderr.write(json.dumps(payload) + "\n")
    sys.exit(code)


def run_int_bnb(method, src, dst, device):
    """int4/int8 via bitsandbytes — load with quantization config, save sharded."""
    try:
        import torch  # noqa: F401
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    except ImportError as e:
        fail(2, f"missing python deps for bnb {method}: {e}",
             {"install": "pip install torch transformers bitsandbytes accelerate"})

    if method == "int4":
        bnb = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype="bfloat16",
        )
    else:
        bnb = BitsAndBytesConfig(load_in_8bit=True)

    tok = AutoTokenizer.from_pretrained(src, trust_remote_code=False)
    model = AutoModelForCausalLM.from_pretrained(
        src,
        quantization_config=bnb,
        device_map=device if device != "auto" else "auto",
        trust_remote_code=False,
        low_cpu_mem_usage=True,
    )
    tok.save_pretrained(dst)
    model.save_pretrained(dst, safe_serialization=True)
    return {
        "lib": "bitsandbytes",
        "lib_version": _ver("bitsandbytes"),
        "torch_version": _ver("torch"),
        "transformers_version": _ver("transformers"),
        "scheme": "nf4+double" if method == "int4" else "llm.int8",
    }


def run_gptq(src, dst, calib, bits, group_size, device):
    """GPTQ via auto-gptq."""
    try:
        import torch  # noqa: F401
        from transformers import AutoTokenizer
        from auto_gptq import AutoGPTQForCausalLM, BaseQuantizeConfig
    except ImportError as e:
        fail(2, f"missing python deps for gptq: {e}",
             {"install": "pip install torch transformers auto-gptq optimum accelerate"})

    tok = AutoTokenizer.from_pretrained(src, trust_remote_code=False)
    cfg = BaseQuantizeConfig(bits=bits, group_size=group_size, desc_act=False)
    model = AutoGPTQForCausalLM.from_pretrained(
        src,
        quantize_config=cfg,
        trust_remote_code=False,
        low_cpu_mem_usage=True,
    )
    calib_rows = _load_calib(calib, tok)
    model.quantize(calib_rows)
    tok.save_pretrained(dst)
    model.save_quantized(dst, use_safetensors=True)
    return {
        "lib": "auto-gptq",
        "lib_version": _ver("auto_gptq"),
        "torch_version": _ver("torch"),
        "transformers_version": _ver("transformers"),
        "bits": bits,
        "group_size": group_size,
        "calib_rows": len(calib_rows),
    }


def run_awq(src, dst, calib, bits, group_size, device):
    """AWQ via autoawq."""
    try:
        import torch  # noqa: F401
        from transformers import AutoTokenizer
        from awq import AutoAWQForCausalLM
    except ImportError as e:
        fail(2, f"missing python deps for awq: {e}",
             {"install": "pip install torch transformers autoawq accelerate"})

    tok = AutoTokenizer.from_pretrained(src, trust_remote_code=False)
    model = AutoAWQForCausalLM.from_pretrained(src, low_cpu_mem_usage=True, trust_remote_code=False)
    quant_config = {"zero_point": True, "q_group_size": group_size, "w_bit": bits, "version": "GEMM"}
    calib_rows = _load_calib(calib, tok, as_str=True)
    model.quantize(tok, quant_config=quant_config, calib_data=calib_rows)
    tok.save_pretrained(dst)
    model.save_quantized(dst)
    return {
        "lib": "autoawq",
        "lib_version": _ver("awq"),
        "torch_version": _ver("torch"),
        "transformers_version": _ver("transformers"),
        "bits": bits,
        "group_size": group_size,
        "calib_rows": len(calib_rows),
    }


def _load_calib(path, tokenizer, as_str=False, max_rows=128, max_len=512):
    """Load calibration text. If path missing, fall back to a tiny built-in set."""
    rows = []
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    text = obj.get("text") or obj.get("prompt") or ""
                    if text:
                        rows.append(text)
                except json.JSONDecodeError:
                    rows.append(line)
                if len(rows) >= max_rows:
                    break
    if not rows:
        rows = _FALLBACK_CALIB[:max_rows]
    if as_str:
        return rows
    enc = [tokenizer(r, return_tensors="pt", truncation=True, max_length=max_len) for r in rows]
    return enc


def _ver(modname):
    try:
        mod = __import__(modname)
        return getattr(mod, "__version__", "unknown")
    except Exception:
        return "missing"


# Small built-in calibration set — generic prose so the quantizer has something
# to learn activation scales from when the caller didn't pass --calib.
_FALLBACK_CALIB = [
    "The quick brown fox jumps over the lazy dog near the riverbank.",
    "In a quiet town nestled between two mountains, the residents kept a tradition alive.",
    "Scientists at the laboratory analyzed the unusual readings for several hours.",
    "The recipe called for fresh herbs, olive oil, garlic, and a pinch of salt.",
    "A long history of cooperation between the two cities shaped their shared culture.",
    "Algorithms in modern compilers translate high-level code into efficient machine instructions.",
    "Spring rains brought new life to the gardens, and the flowers bloomed in vibrant colors.",
    "The mountain trail wound through dense forest before opening onto a clear alpine meadow.",
    "Software engineers wrote tests, reviewed each other's code, and deployed updates incrementally.",
    "Children gathered around the storyteller, listening intently to the ancient legend.",
    "Researchers published their findings in a peer-reviewed journal after months of analysis.",
    "The orchestra rehearsed long into the evening, perfecting every nuance of the symphony.",
    "Farmers monitored the weather forecasts and adjusted their irrigation schedules accordingly.",
    "The library's reading room offered a quiet space for students preparing for their exams.",
    "Engineers designed the bridge to withstand high winds and seasonal flooding.",
    "Mathematicians explored the properties of prime numbers across vast computational ranges.",
    "Photographers captured the city skyline at sunrise, the light painting every window gold.",
    "Pediatricians follow evidence-based guidelines when caring for infants and young children.",
    "Marine biologists tracked migration patterns across thousands of kilometers of open ocean.",
    "Urban planners considered traffic flow, green space, and housing density when drafting proposals.",
    "Volunteers worked through the weekend to clean up the riverbank after the heavy storm.",
    "Translators preserved the rhythm and meaning of the original poem in the new language.",
    "Astronomers detected faint signals from distant galaxies billions of light-years away.",
    "Carpenters measured twice and cut once, an old rule that still saved time and material.",
    "Editors carefully checked each chapter for clarity, consistency, and factual accuracy.",
    "Civil rights attorneys argued the case before the appellate court for over an hour.",
    "Chefs at the small restaurant prepared everything in-house, including the bread and pasta.",
    "Hikers reached the summit just before dawn and watched the sun rise over the valley.",
    "Climate models incorporate ocean currents, atmospheric chemistry, and ice sheet dynamics.",
    "Cybersecurity teams patched the critical vulnerability within hours of the disclosure.",
    "Pianists rehearse scales daily to maintain finger strength and timing precision.",
    "Linguists studied the dialect's vowel shifts across three generations of speakers.",
]


def main():
    args = parse_args()
    src = Path(args.src).resolve()
    dst = Path(args.dst).resolve()
    if not src.exists() or not src.is_dir():
        fail(3, f"--in path missing or not a directory: {src}")
    if not (src / "config.json").exists():
        fail(3, f"--in does not look like a HF model dir (no config.json): {src}")

    dst.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    src_hash = hash_input_tree(str(src))

    try:
        if args.method in ("int4", "int8"):
            tool_info = run_int_bnb(args.method, str(src), str(dst), args.device)
        elif args.method == "gptq":
            tool_info = run_gptq(str(src), str(dst), args.calib, args.bits, args.group_size, args.device)
        elif args.method == "awq":
            tool_info = run_awq(str(src), str(dst), args.calib, args.bits, args.group_size, args.device)
        else:
            fail(2, f"unknown method: {args.method}")
    except SystemExit:
        raise
    except Exception as e:
        sys.stderr.write(traceback.format_exc())
        fail(4, f"quantization raised: {e.__class__.__name__}: {e}")

    out_hashes = hash_output_tree(str(dst))
    receipt = {
        "ok": True,
        "method": args.method,
        "in": str(src),
        "out": str(dst),
        "input_tree_sha256": src_hash,
        "output_files_sha256": out_hashes,
        "duration_sec": round(time.time() - t0, 3),
        "device": args.device,
        "python_version": sys.version.split()[0],
        "tool": tool_info,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(dst / "quantize-receipt.json", "w", encoding="utf-8") as f:
        json.dump(receipt, f, indent=2, sort_keys=True)
    sys.stdout.write(json.dumps({"ok": True, "receipt": str(dst / "quantize-receipt.json")}) + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
