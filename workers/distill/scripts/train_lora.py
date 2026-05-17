#!/usr/bin/env python3
# workers/distill/scripts/train_lora.py
#
# LoRA fine-tune skeleton for the kolm distillation worker. Reads the
# training-pairs.jsonl produced by distill.mjs and fine-tunes a small
# open-weight base via PEFT/transformers/peft.
#
# This file intentionally fails fast and loud when torch/transformers/peft
# are missing — distill.mjs only invokes it after `--doctor` confirms the
# stack is present. The user-facing CLI never imports this file.
#
# Wave K (1216) will extend this with the quantization + GGUF/ONNX export
# step. Wave L (1217) will reuse the resulting student weights to emit a
# WASM target. This file is the shared training entry for both.

import argparse
import json
import sys
import os


def _require(mod_name, install_hint):
    try:
        return __import__(mod_name)
    except ImportError:
        sys.stderr.write(f"[train_lora] missing dependency '{mod_name}'.\n")
        sys.stderr.write(f"             install hint: {install_hint}\n")
        sys.exit(3)


def main():
    p = argparse.ArgumentParser(description="kolm distillation LoRA fine-tune")
    p.add_argument("--pairs", required=True, help="training-pairs.jsonl from distill.mjs")
    p.add_argument("--out", required=True, help="output directory for the student adapter")
    p.add_argument("--student-base", default="Qwen/Qwen2.5-0.5B", help="HF base model id")
    p.add_argument("--lora-rank", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--max-length", type=int, default=512)
    args = p.parse_args()

    # Hard dependency check — give the operator a single-line install hint
    # instead of a Python traceback.
    torch = _require("torch", "pip install torch")
    transformers = _require("transformers", "pip install transformers")
    peft = _require("peft", "pip install peft")
    datasets_mod = _require("datasets", "pip install datasets")
    _require("accelerate", "pip install accelerate")

    from transformers import (AutoModelForCausalLM, AutoTokenizer,
                              TrainingArguments, Trainer,
                              DataCollatorForLanguageModeling)
    from peft import LoraConfig, get_peft_model, TaskType
    from datasets import Dataset

    if not os.path.exists(args.pairs):
        sys.stderr.write(f"[train_lora] pairs file not found: {args.pairs}\n")
        sys.exit(4)

    os.makedirs(args.out, exist_ok=True)

    # Read JSONL pairs.
    rows = []
    with open(args.pairs, "r", encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                obj = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if "input" not in obj or "teacher_output" not in obj:
                continue
            rows.append(obj)
    print(f"[train_lora] {len(rows)} training pairs loaded from {args.pairs}")
    if not rows:
        sys.stderr.write("[train_lora] no usable pairs; aborting.\n")
        sys.exit(5)

    tok = AutoTokenizer.from_pretrained(args.student_base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    def to_example(row):
        prompt = str(row["input"])
        completion = str(row["teacher_output"])
        # Simple instruction format. Real workloads will want a model-
        # specific template; this is the floor.
        text = f"<|user|>\n{prompt}\n<|assistant|>\n{completion}{tok.eos_token}"
        enc = tok(text, truncation=True, max_length=args.max_length, padding="max_length")
        enc["labels"] = enc["input_ids"].copy()
        return enc

    ds = Dataset.from_list(rows).map(to_example, remove_columns=Dataset.from_list(rows).column_names)

    base = AutoModelForCausalLM.from_pretrained(
        args.student_base,
        torch_dtype=torch.float16,
        device_map="auto",
    )

    lora_cfg = LoraConfig(
        r=args.lora_rank,
        lora_alpha=args.lora_alpha,
        task_type=TaskType.CAUSAL_LM,
        bias="none",
        lora_dropout=0.05,
    )
    model = get_peft_model(base, lora_cfg)
    model.print_trainable_parameters()

    training = TrainingArguments(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        learning_rate=args.lr,
        save_strategy="epoch",
        logging_steps=10,
        report_to=[],
        fp16=True,
    )

    trainer = Trainer(
        model=model,
        args=training,
        train_dataset=ds,
        data_collator=DataCollatorForLanguageModeling(tok, mlm=False),
    )

    trainer.train()
    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)

    with open(os.path.join(args.out, "training-summary.json"), "w", encoding="utf-8") as f:
        json.dump({
            "student_base": args.student_base,
            "lora_rank": args.lora_rank,
            "lora_alpha": args.lora_alpha,
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "lr": args.lr,
            "max_length": args.max_length,
            "pairs": len(rows),
        }, f, indent=2)

    print(f"[train_lora] done. adapter at {args.out}")


if __name__ == "__main__":
    main()
