#!/usr/bin/env python3
"""
kolm tune step — runs one SFT epoch (or N) on captured (input, output) pairs.

Called by src/tune.js. Reads captures.jsonl, fine-tunes the previous
revision's adapter (or skeleton init if v0), writes a new adapter checkpoint
to --out-dir, and emits a single JSON line on stdout with run stats.

Airgap mode (--airgap or KOLM_AIRGAP=1):
  - sets TRANSFORMERS_OFFLINE=1, HF_HUB_OFFLINE=1, HF_DATASETS_OFFLINE=1
  - refuses any base_model that isn't a local path
  - never imports requests/httpx/urllib3

If torch/peft/transformers are not installed, this script exits 64 with
a clean "install kolm-tune dependencies" message so the JS wrapper can
surface it to the user. The skeleton init flow (kolm tune init) does not
require any of these — only `kolm tune step` does.

Usage (from src/tune.js):
  python tune-step.py \
    --tune-dir ~/.kolm/tune/my_redactor \
    --captures ~/.kolm/tune/my_redactor/captures.jsonl \
    --out-dir  ~/.kolm/tune/my_redactor/revisions/v1 \
    --prev v0 \
    --epochs 1 --batch-size 4 --lr 2e-4 \
    [--airgap]
"""

from __future__ import annotations
import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path


def fail(msg, code=1):
    sys.stdout.write(json.dumps({"ok": False, "error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def load_captures(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def to_prompt(row):
    """Render one capture row as a single instruction-style training example."""
    inp = row.get("input")
    out = row.get("output")
    if isinstance(inp, (dict, list)):
        inp = json.dumps(inp, ensure_ascii=False)
    if isinstance(out, (dict, list)):
        out = json.dumps(out, ensure_ascii=False)
    return {
        "instruction": "Apply the kolm recipe to the input. Return JSON only.",
        "input": str(inp),
        "output": str(out),
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--tune-dir", required=True)
    p.add_argument("--captures", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--prev", default="v0")
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--airgap", action="store_true")
    p.add_argument("--max-seq-len", type=int, default=1024)
    args = p.parse_args()

    if args.airgap or os.environ.get("KOLM_AIRGAP") == "1":
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_DATASETS_OFFLINE"] = "1"
        os.environ["HF_HUB_OFFLINE"] = "1"

    # Read tune-config to know the base model and adapter dims.
    cfg_path = Path(args.tune_dir) / "tune-config.json"
    if not cfg_path.exists():
        fail("tune-config.json missing at " + str(cfg_path))
    cfg = json.loads(cfg_path.read_text())
    base_model = cfg.get("base_model")
    if not base_model:
        fail("tune-config.base_model missing")

    if args.airgap or os.environ.get("KOLM_AIRGAP") == "1":
        # Airgap: refuse remote model ids. Must be a local absolute path that exists.
        if "://" in base_model or not Path(base_model).expanduser().exists():
            fail(
                "airgap: base_model must be a local path that exists. got: "
                + base_model
                + ". download the weights ahead of time and point --base-model at the local dir."
            )

    captures = load_captures(args.captures)
    if not captures:
        fail("no captures to train on (captures.jsonl empty)")

    started_at = time.time()

    # Try to load torch/peft. If unavailable, exit with a clean install message.
    try:
        import torch  # noqa: F401
    except ImportError:
        fail(
            "torch not installed. install kolm-tune deps:\n"
            "  pip install 'torch>=2.2' 'transformers>=4.42' 'peft>=0.11' 'datasets>=2.18' 'accelerate>=0.30' 'trl>=0.9'",
            code=64,
        )
    try:
        from transformers import (
            AutoTokenizer, AutoModelForCausalLM, TrainingArguments,
        )
        from peft import LoraConfig, get_peft_model, PeftModel
        from datasets import Dataset
    except ImportError as e:
        fail(
            f"missing dep: {e}. install: pip install 'transformers>=4.42' 'peft>=0.11' 'datasets>=2.18' 'accelerate>=0.30' 'trl>=0.9'",
            code=64,
        )

    try:
        from trl import SFTTrainer, SFTConfig
        has_trl = True
    except ImportError:
        has_trl = False

    # Build dataset.
    ex = [to_prompt(r) for r in captures]
    def render(r):
        return {"text": f"### Instruction:\n{r['instruction']}\n\n### Input:\n{r['input']}\n\n### Response:\n{r['output']}"}
    ds = Dataset.from_list([render(r) for r in ex])

    # Load tokenizer + base model.
    tok = AutoTokenizer.from_pretrained(base_model, use_fast=True, trust_remote_code=False)
    if tok.pad_token_id is None:
        tok.pad_token_id = tok.eos_token_id

    # Resolve previous adapter (PeftModel.from_pretrained on prev's adapter_config.json).
    prev_dir = Path(args.tune_dir) / "revisions" / args.prev
    has_prev_adapter = prev_dir.exists() and (prev_dir / "adapter_config.json").exists() and (prev_dir / "adapter_model.safetensors").exists()

    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        torch_dtype="auto",
        trust_remote_code=False,
        device_map="auto",
    )

    if has_prev_adapter:
        model = PeftModel.from_pretrained(model, str(prev_dir), is_trainable=True)
    else:
        # First real step: turn the skeleton into a trainable adapter.
        lora_cfg = LoraConfig(
            r=cfg.get("rank", 8),
            lora_alpha=cfg.get("alpha", 16),
            target_modules=cfg.get("target_modules") or ["q_proj", "k_proj", "v_proj", "o_proj"],
            lora_dropout=cfg.get("dropout", 0.05),
            bias="none",
            task_type="CAUSAL_LM",
        )
        model = get_peft_model(model, lora_cfg)

    Path(args.out_dir).mkdir(parents=True, exist_ok=True)

    if has_trl:
        sft_cfg = SFTConfig(
            output_dir=args.out_dir,
            num_train_epochs=args.epochs,
            per_device_train_batch_size=args.batch_size,
            learning_rate=args.lr,
            logging_steps=10,
            save_strategy="no",
            report_to=[],
            max_seq_length=args.max_seq_len,
            dataset_text_field="text",
            packing=False,
        )
        trainer = SFTTrainer(model=model, args=sft_cfg, train_dataset=ds)
        trainer.train()
    else:
        # Vanilla loop (no trl). Tokenize and use a plain Trainer.
        def tokfn(b):
            t = tok(b["text"], truncation=True, max_length=args.max_seq_len, padding="max_length")
            t["labels"] = t["input_ids"].copy() if hasattr(t["input_ids"], "copy") else list(t["input_ids"])
            return t
        ds_tok = ds.map(tokfn, batched=True, remove_columns=["text"])
        from transformers import Trainer
        targs = TrainingArguments(
            output_dir=args.out_dir,
            num_train_epochs=args.epochs,
            per_device_train_batch_size=args.batch_size,
            learning_rate=args.lr,
            logging_steps=10,
            save_strategy="no",
            report_to=[],
        )
        trainer = Trainer(model=model, args=targs, train_dataset=ds_tok)
        trainer.train()

    model.save_pretrained(args.out_dir)
    tok.save_pretrained(args.out_dir)

    elapsed = time.time() - started_at

    # Quick sanity: how many trainable params did we touch?
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())

    emit({
        "ok": True,
        "revision_dir": args.out_dir,
        "captures_trained_on": len(captures),
        "epochs": args.epochs,
        "trainable_params": trainable,
        "total_params": total,
        "elapsed_sec": round(elapsed, 2),
        "airgap": bool(args.airgap or os.environ.get("KOLM_AIRGAP") == "1"),
        "trl": has_trl,
        "base_model": base_model,
    })


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        sys.stderr.write(traceback.format_exc())
        fail("trainer crashed: " + traceback.format_exc().splitlines()[-1])
