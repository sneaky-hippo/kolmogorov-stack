"""example.py — minimal runnable example.

Prereq: a compiled artifact such as phi-redactor.kolm and the ``kolm`` CLI on
PATH. Run with:  python example.py
"""

from __future__ import annotations

import os
import sys

from kolm_langchain import KolmLLM


def main() -> int:
    artifact = os.environ.get("KOLM_ARTIFACT", "./phi-redactor.kolm")
    llm = KolmLLM(artifact_path=artifact)
    prompt = "Redact this note: Patient John Doe, DOB 1980-01-01, MRN 1234567."
    try:
        out = llm.invoke_with_receipt(prompt)
    except Exception as e:  # noqa: BLE001
        print(f"example failed: {e}", file=sys.stderr)
        return 1
    print("output:", out["text"])
    if out["receipt"]:
        print("cid:", out["receipt"].get("cid"))
        print("k_score:", out["receipt"].get("k_score"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
