"""example.py — minimal runnable example.

Prereq: a compiled artifact and the ``kolm`` CLI on PATH.
Run with:  python example.py
"""

from __future__ import annotations

import os
import sys

from kolm_llamaindex import KolmLLM


def main() -> int:
    artifact = os.environ.get("KOLM_ARTIFACT", "./phi-redactor.kolm")
    llm = KolmLLM(artifact_path=artifact)
    try:
        r = llm.complete("Redact: Patient Jane Roe, MRN 9876543.")
    except Exception as e:  # noqa: BLE001
        print(f"example failed: {e}", file=sys.stderr)
        return 1
    print("output:", r["text"])
    if r.get("raw") and r["raw"].get("receipt"):
        receipt = r["raw"]["receipt"]
        print("cid:", receipt.get("cid"))
        print("k_score:", receipt.get("k_score"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
