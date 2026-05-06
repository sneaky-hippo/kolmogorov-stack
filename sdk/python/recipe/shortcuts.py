"""Drop-in replacements for repeat LLM-as-judge calls.

Each shortcut routes to ``/v1/public/run`` against a curated public Recipe.
No API key is required.
"""

from __future__ import annotations

from typing import Any, Optional

from .client import RecipeClient

_anon = RecipeClient(api_key=None)


def _run_named(name: str, text: str) -> Any:
    r = _anon.public_run(name=name, input=text)
    return r.get("output") if isinstance(r, dict) else r


def is_spam(text: str) -> bool:
    """Return True for spammy short messages."""
    return bool(_run_named("is-spam", text))


def classify_intent(text: str) -> str:
    """Coarse 3-way: 'support' / 'sales' / 'feedback'."""
    return str(_run_named("classify-intent", text))


def detect_language(text: str) -> str:
    """Coarse: 'english' / 'spanish' / 'french'."""
    return str(_run_named("classify-language", text))


def sentiment(text: str) -> str:
    return str(_run_named("classify-toxicity", text))


def is_question(text: str) -> bool:
    return bool(_run_named("is-question", text))


def classify_toxicity(text: str) -> str:
    return str(_run_named("classify-toxicity", text))


def extract_emails(text: str) -> list:
    out = _run_named("extract-emails", text)
    return list(out) if isinstance(out, list) else []


def classify_issue(text: str) -> str:
    return str(_run_named("classify-issue-type", text))
