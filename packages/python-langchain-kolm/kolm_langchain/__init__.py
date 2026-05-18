"""kolm-langchain — LangChain adapter for kolm.ai compiled artifacts.

Drop a ``.kolm`` artifact into any LangChain agent in 3 lines.

Public surface:

    from kolm_langchain import KolmLLM
    llm = KolmLLM(artifact_path="./phi-redactor.kolm")
    text = llm.invoke("Redact this note ...")
"""

from .llm import KolmLLM

__version__ = "0.1.0"
__all__ = ["KolmLLM"]
