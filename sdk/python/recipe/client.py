"""Recipe HTTP client. Zero runtime dependencies (stdlib only)."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Union

DEFAULT_BASE = "https://kolmogorov-stack-production.up.railway.app"
USER_AGENT = "kolmogorov-recipe-py/0.1.0"


class RecipeError(Exception):
    """Raised when the Recipe API returns a non-2xx response."""

    def __init__(self, status: int, body: Any, message: str = ""):
        self.status = status
        self.body = body
        super().__init__(message or f"recipe error {status}: {body}")


def _build_url(base: str, path: str, params: Optional[Mapping[str, Any]] = None) -> str:
    base = base.rstrip("/")
    if not path.startswith("/"):
        path = "/" + path
    if params:
        clean = {k: v for k, v in params.items() if v is not None}
        if clean:
            return f"{base}{path}?{urllib.parse.urlencode(clean)}"
    return f"{base}{path}"


class RecipeClient:
    """Synchronous HTTP client for the Recipe API.

    Args:
        api_key: bearer token (e.g. "ks_..."). If omitted, falls back to
            ``RECIPE_API_KEY`` then ``KOLMOGOROV_API_KEY`` env vars.
        base_url: API base URL. Defaults to the hosted service.
        timeout: per-request timeout in seconds. Default 60.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 60.0,
    ) -> None:
        self.api_key = (
            api_key
            or os.environ.get("RECIPE_API_KEY")
            or os.environ.get("KOLMOGOROV_API_KEY")
        )
        self.base_url = (base_url or os.environ.get("RECIPE_BASE_URL") or DEFAULT_BASE).rstrip("/")
        self.timeout = timeout

    # ------------------------------------------------------------------
    # Low-level
    # ------------------------------------------------------------------
    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Any] = None,
        params: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        url = _build_url(self.base_url, path, params)
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method.upper())
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", USER_AGENT)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.api_key:
            req.add_header("Authorization", f"Bearer {self.api_key}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = resp.read()
                if not payload:
                    return {}
                return json.loads(payload.decode("utf-8"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = raw
            msg = parsed.get("error") if isinstance(parsed, dict) else str(parsed)
            raise RecipeError(e.code, parsed, msg or f"http {e.code}") from None
        except urllib.error.URLError as e:
            raise RecipeError(0, None, f"network error: {e.reason}") from None

    # ------------------------------------------------------------------
    # Core: synthesize / run / verify
    # ------------------------------------------------------------------
    def synthesize(
        self,
        positives: Sequence[Mapping[str, Any]],
        *,
        name: Optional[str] = None,
        output_spec: Optional[Mapping[str, Any]] = None,
        description: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
        visibility: Optional[str] = None,
        **extra: Any,
    ) -> Dict[str, Any]:
        """Synthesize a recipe from 4-8 positive examples.

        Returns the synthesis response (`concept_id`, `version_id`, `strategy`, ...).
        """
        body: Dict[str, Any] = {"positives": list(positives)}
        if name:
            body["name"] = name
        if output_spec:
            body["output_spec"] = dict(output_spec)
        if description:
            body["description"] = description
        if tags:
            body["tags"] = list(tags)
        if visibility:
            body["visibility"] = visibility
        body.update(extra)
        return self._request("POST", "/v1/synthesize", body)

    def synthesize_batch(self, recipes: Iterable[Mapping[str, Any]]) -> Dict[str, Any]:
        return self._request("POST", "/v1/synthesize/batch", {"recipes": list(recipes)})

    def verify(
        self, source: str, examples: Sequence[Mapping[str, Any]]
    ) -> Dict[str, Any]:
        return self._request("POST", "/v1/verify", {"source": source, "examples": list(examples)})

    def run(
        self,
        *,
        recipe_id: Optional[str] = None,
        concept_id: Optional[str] = None,
        version_id: Optional[str] = None,
        input: Any = None,
        use_cache: bool = True,
    ) -> Dict[str, Any]:
        cid = recipe_id or concept_id
        if not cid and not version_id:
            raise ValueError("recipe_id or version_id is required")
        body: Dict[str, Any] = {"input": input, "use_cache": use_cache}
        if version_id:
            body["version_id"] = version_id
        elif cid:
            body["concept_id"] = cid
        return self._request("POST", "/v1/run", body)

    # ------------------------------------------------------------------
    # Registry
    # ------------------------------------------------------------------
    def list(
        self,
        *,
        tag: Optional[str] = None,
        q: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        return self._request(
            "GET", "/v1/recipes", params={"tag": tag, "q": q, "limit": limit}
        )

    def get(self, recipe_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/recipes/{recipe_id}")

    def stats(self, recipe_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/recipes/{recipe_id}/stats")

    def search(self, query: str, k: int = 5) -> Dict[str, Any]:
        return self._request("POST", "/v1/search", {"query": query, "k": k})

    def compose(
        self,
        *,
        query: str,
        input: Any,
        k: int = 3,
        strategy: str = "attention",
    ) -> Dict[str, Any]:
        return self._request(
            "POST",
            "/v1/compose",
            {"query": query, "input": input, "k": k, "strategy": strategy},
        )

    # ------------------------------------------------------------------
    # Auto-labeling + Specialists (Day 30-180+)
    # ------------------------------------------------------------------
    def label_corpus(
        self,
        recipe_id: str,
        *,
        rows: Optional[Sequence[Mapping[str, Any]]] = None,
        hf_dataset: Optional[str] = None,
        url: Optional[str] = None,
        max_rows: Optional[int] = None,
        output_format: Optional[str] = None,
    ) -> Dict[str, Any]:
        if rows is not None:
            corpus: Dict[str, Any] = {"type": "inline", "rows": list(rows)}
        elif hf_dataset:
            corpus = {"type": "huggingface", "name": hf_dataset}
        elif url:
            corpus = {"type": "url", "url": url}
        else:
            raise ValueError("provide rows, hf_dataset, or url")
        body: Dict[str, Any] = {"corpus": corpus}
        if max_rows is not None:
            body["max_rows"] = max_rows
        if output_format:
            body["output_format"] = output_format
        return self._request("POST", f"/v1/recipes/{recipe_id}/label-corpus", body)

    def job(self, job_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/jobs/{job_id}")

    def waitlist_specialist(self, email: str, task: str) -> Dict[str, Any]:
        return self._request("POST", "/v1/specialists/waitlist", {"email": email, "task": task})

    def train_specialist(
        self,
        *,
        name: str,
        recipe_id: str,
        base_model: Optional[str] = None,
        rank: Optional[int] = None,
        **extra: Any,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"name": name, "recipe_id": recipe_id}
        if base_model:
            body["base_model"] = base_model
        if rank is not None:
            body["rank"] = rank
        body.update(extra)
        return self._request("POST", "/v1/specialists/train", body)

    def list_specialists(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/specialists")

    def get_specialist(self, specialist_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/specialists/{specialist_id}")

    def run_specialist(self, specialist_id: str, input: Any) -> Dict[str, Any]:
        return self._request(
            "POST", f"/v1/specialists/{specialist_id}/run", {"input": input}
        )

    # ------------------------------------------------------------------
    # Public registry
    # ------------------------------------------------------------------
    def featured(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/public/featured")

    def public_concepts(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/public/concepts")

    def public_run(
        self, *, name: Optional[str] = None, recipe_id: Optional[str] = None, input: Any = None
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"input": input}
        if name:
            body["name"] = name
        if recipe_id:
            body["recipe_id"] = recipe_id
        return self._request("POST", "/v1/public/run", body)

    # ------------------------------------------------------------------
    # Account
    # ------------------------------------------------------------------
    def account(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/account")

    def rotate_key(self) -> Dict[str, Any]:
        return self._request("POST", "/v1/account/rotate-key")

    def signup(self, email: str, name: Optional[str] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {"email": email}
        if name:
            body["name"] = name
        return self._request("POST", "/v1/signup", body)

    def health(self) -> Dict[str, Any]:
        return self._request("GET", "/health")
