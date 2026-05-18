"""kolm-llamaindex — LlamaIndex adapter for kolm.ai compiled artifacts.

Drop a ``.kolm`` artifact into any LlamaIndex agent in 3 lines.

Public surface:

    from kolm_llamaindex import KolmLLM
    llm = KolmLLM(artifact_path="./phi-redactor.kolm")
    text = llm.complete("Redact this note ...")
"""

from .llm import KolmLLM

__version__ = "0.1.0"
__all__ = ["KolmLLM"]
