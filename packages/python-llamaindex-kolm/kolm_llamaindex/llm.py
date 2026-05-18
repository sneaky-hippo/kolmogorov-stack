"""KolmLLM — LlamaIndex LLM that bridges to a kolm.ai compiled artifact.

Subprocess + HTTP transport. Mirrors ``kolm-langchain``. Surfaces the receipt
chain on ``self.last_receipt`` after every call.

The class extends ``llama_index.core.llms.LLM`` when installed; otherwise it
falls back to a minimal stand-in so the package can be imported and tested
without LlamaIndex.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional
from urllib import request as _urllib_request
from urllib.error import HTTPError, URLError


try:
    from llama_index.core.llms import LLM as _LlamaIndexLLM
    _HAS_LLAMAINDEX = True
except Exception:  # pragma: no cover
    _HAS_LLAMAINDEX = False

    class _LlamaIndexLLM:  # type: ignore[no-redef]
        """Stand-in matching the LlamaIndex LLM surface this adapter exposes."""

        def __init__(self, **_: Any) -> None:
            pass


KOLM_BIN: str = os.environ.get("KOLM_BIN", "kolm")


@dataclass
class _Result:
    text: str
    receipt: Optional[dict] = field(default_factory=lambda: None)


def _parse_runtime_output(raw: str) -> _Result:
    trimmed = (raw or "").strip()
    if not trimmed:
        return _Result(text="", receipt=None)
    if trimmed.startswith("{"):
        try:
            obj = json.loads(trimmed)
            text = obj.get("text") if isinstance(obj.get("text"), str) else obj.get("output", "")
            return _Result(text=text or "", receipt=obj.get("receipt") or obj.get("audit"))
        except json.JSONDecodeError:
            pass
    return _Result(text=trimmed, receipt=None)


class KolmLLM(_LlamaIndexLLM):
    """LlamaIndex LLM backed by a ``.kolm`` artifact.

    Parameters
    ----------
    artifact_path:
        Path to a compiled ``.kolm`` artifact (subprocess mode) or the
        artifact name when ``base_url`` is supplied (HTTP mode).
    base_url:
        Optional kolm server endpoint. When set, calls go over HTTP.
    api_key:
        Bearer token for HTTP mode. Defaults to ``KOLM_API_KEY``.
    bin_path:
        Path to the ``kolm`` binary. Defaults to ``KOLM_BIN``.
    timeout_s:
        Per-call timeout in seconds.
    """

    def __init__(
        self,
        artifact_path: Optional[str] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        bin_path: Optional[str] = None,
        timeout_s: float = 30.0,
        context_window: int = 4096,
        **kwargs: Any,
    ) -> None:
        if not artifact_path and not base_url:
            raise ValueError(
                "KolmLLM: either artifact_path (subprocess) or base_url (HTTP) is required"
            )
        super().__init__(**kwargs)
        self._artifact_path: Optional[str] = artifact_path
        self._base_url: Optional[str] = base_url
        self._api_key: Optional[str] = api_key or os.environ.get("KOLM_API_KEY")
        self._bin: str = bin_path or KOLM_BIN
        self._timeout_s: float = float(timeout_s)
        self.last_receipt: Optional[dict] = None
        self.metadata = {
            "model_name": "kolm-artifact",
            "context_window": int(context_window),
            "is_chat_model": False,
        }

    # LlamaIndex LLM contract: completion entry point.
    def complete(self, prompt: str, **kwargs: Any) -> dict[str, Any]:
        result = self._run(prompt)
        self.last_receipt = result.receipt
        return {
            "text": result.text,
            "raw": {"receipt": result.receipt} if result.receipt else None,
        }

    # LlamaIndex LLM contract: chat entry point.
    def chat(self, messages: Iterable[Any], **kwargs: Any) -> dict[str, Any]:
        parts: list[str] = []
        for m in messages:
            role = getattr(m, "role", None) or (m.get("role") if isinstance(m, dict) else "user")
            content = getattr(m, "content", None) or (m.get("content") if isinstance(m, dict) else str(m))
            parts.append(f"{str(role).upper()}: {content}")
        prompt = "\n\n".join(parts)
        result = self._run(prompt)
        self.last_receipt = result.receipt
        return {
            "message": {"role": "assistant", "content": result.text},
            "raw": {"receipt": result.receipt} if result.receipt else None,
        }

    def invoke_with_receipt(self, prompt: str) -> dict[str, Any]:
        result = self._run(prompt)
        self.last_receipt = result.receipt
        return {"text": result.text, "receipt": result.receipt}

    def _run(self, prompt: str) -> _Result:
        if self._base_url:
            return self._call_http(prompt)
        return self._call_subprocess(prompt)

    def _call_subprocess(self, prompt: str) -> _Result:
        assert self._artifact_path, "artifact_path required for subprocess mode"
        try:
            proc = subprocess.run(
                [self._bin, "run", self._artifact_path, "--json"],
                input=prompt,
                capture_output=True,
                text=True,
                timeout=self._timeout_s,
                check=False,
            )
        except FileNotFoundError as e:
            raise RuntimeError(f"kolm binary not found at {self._bin!r}") from e
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"kolm run timeout after {self._timeout_s}s") from e
        if proc.returncode != 0:
            stderr = (proc.stderr or "").strip()
            raise RuntimeError(f"kolm run exited {proc.returncode}: {stderr}")
        return _parse_runtime_output(proc.stdout)

    def _call_http(self, prompt: str) -> _Result:
        assert self._base_url, "base_url required for HTTP mode"
        artifact = self._artifact_path or "default"
        url = f"{self._base_url.rstrip('/')}/v1/run/{artifact}"
        payload = json.dumps({"prompt": prompt}).encode("utf-8")
        headers = {"content-type": "application/json"}
        if self._api_key:
            headers["authorization"] = f"Bearer {self._api_key}"
        req = _urllib_request.Request(url, data=payload, headers=headers, method="POST")
        try:
            with _urllib_request.urlopen(req, timeout=self._timeout_s) as resp:
                body = resp.read().decode("utf-8")
        except HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:200] if hasattr(e, "read") else ""
            raise RuntimeError(f"kolm http {e.code}: {detail}") from e
        except URLError as e:
            raise RuntimeError(f"kolm http error: {e.reason}") from e
        try:
            obj = json.loads(body)
        except json.JSONDecodeError:
            return _Result(text=body, receipt=None)
        text = obj.get("text") if isinstance(obj.get("text"), str) else obj.get("output", "")
        return _Result(text=text or "", receipt=obj.get("receipt") or obj.get("audit"))
