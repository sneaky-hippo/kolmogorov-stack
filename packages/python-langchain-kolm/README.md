# kolm-langchain

First-party LangChain adapter for kolm.ai compiled artifacts. Drop a `.kolm` into any LangChain agent in 3 lines.

## Install

```bash
pip install kolm-langchain langchain langchain-core
```

## Usage (3 lines)

```python
from kolm_langchain import KolmLLM
llm = KolmLLM(artifact_path="./phi-redactor.kolm")
text = llm.invoke("Redact: My SSN is 123-45-6789.")
```

The `.kolm` artifact runs as a local subprocess via the `kolm` CLI. Zero outbound calls. The receipt chain is preserved on `llm.last_receipt` after every call.

## HTTP mode

```python
llm = KolmLLM(
    base_url="https://kolm.example.internal",
    artifact_path="phi-redactor",
    api_key=os.environ["KOLM_API_KEY"],
)
```

## Receipt chain

```python
out = llm.invoke_with_receipt(prompt)
print(out["receipt"]["cid"], out["receipt"]["k_score"])
```

## Python support

Python 3.10+. `langchain-core` is an optional install — the adapter degrades to a stand-in base class when it is absent so the package can be imported and tested without LangChain.
