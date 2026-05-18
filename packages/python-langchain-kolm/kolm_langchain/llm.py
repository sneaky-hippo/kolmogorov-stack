"""KolmLLM — LangChain LLM that bridges to a kolm.ai compiled artifact.

Two transport modes:

1. **subprocess** — spawn ``kolm run <artifact_path> --json`` and write the
   prompt to stdin. The CLI returns a single JSON line on stdout containing
   ``text`` and ``receipt``.
2. **http** — POST ``{prompt}`` to ``{base_url}/v1/run/{artifact}`` with a
   Bearer token. Same response shape.

The class extends ``langchain_core.language_models.llms.LLM`` when langchain
is installed. When it is not, a minimal stand-in is used so the adapter is
unit-testable in isolation.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib import request as _urllib_request
from urllib.error import HTTPError, URLError


try:
    from langchain_core.language_models.llms import LLM as _LangChainLLM
    _HAS_LANGCHAIN = True
except Exception:  # pragma: no cover - exercised only when langchain absent
    _HAS_LANGCHAIN = False

    class _LangChainLLM:  # type: ignore[no-redef]
        """Minimal stand-in matching the LangChain LLM surface we depend on."""

        def __init__(self, **_: Any) -> None:
            pass

        def invoke(self, prompt: str, **kwargs: Any) -> str:
            return self._call(prompt, **kwargs)


KOLM_BIN: str = os.environ.get("KOLM_BIN", "kolm")


@dataclass
class _Result:
    text: str
    receipt: Optional[dict] = field(default_factory=lambda: None)


def _parse_runtime_output(raw: str) -> _Result:
    """Parse a kolm runtime stdout line. JSON preferred, plain text fallback."""
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


class KolmLLM(_LangChainLLM):
    """LangChain LLM backed by a ``.kolm`` artifact.

    Parameters
    ----------
    artifact_path:
        Path to a compiled ``.kolm`` artifact (subprocess mode) or the
        artifact name when ``base_url`` is supplied (HTTP mode).
    base_url:
        Optional kolm server endpoint. When set, calls go over HTTP instead
        of spawning the CLI.
    api_key:
        Bearer token for HTTP mode. Defaults to ``KOLM_API_KEY``.
    bin_path:
        Override the path to the ``kolm`` binary. Defaults to ``KOLM_BIN``.
    timeout_s:
        Per-call subprocess / HTTP timeout in seconds.
    """

    def __init__(
        self,
        artifact_path: Optional[str] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        bin_path: Optional[str] = None,
        timeout_s: float = 30.0,
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

    @property
    def _llm_type(self) -> str:
        return "kolm"

    @property
    def _identifying_params(self) -> dict[str, Any]:
        return {
            "artifact_path": self._artifact_path,
            "base_url": self._base_url,
            "bin": self._bin,
        }

    def _call(
        self,
        prompt: str,
        stop: Optional[list[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> str:
        result = self._run(prompt)
        self.last_receipt = result.receipt
        return result.text

    def invoke_with_receipt(self, prompt: str) -> dict[str, Any]:
        """Return both the text and the receipt chain."""
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
