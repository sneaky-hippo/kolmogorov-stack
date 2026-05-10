"""
Recipe — show your AI agent how once, run forever.

The Skills layer of Kolmogorov Stack. A thin Python client over the Recipe HTTP API.

Quick use::

    from recipe import RecipeClient

    c = RecipeClient(api_key="ks_...")

    r = c.synthesize(
        name="is-spam",
        positives=[
            {"input": "WIN A FREE iPhone", "expected": True},
            {"input": "CLICK HERE FOR $1000", "expected": True},
            {"input": "meeting at 3pm", "expected": False},
            {"input": "lunch?", "expected": False},
        ],
        output_spec={"type": "boolean"},
    )

    out = c.run(recipe_id=r["concept_id"], input="BUY CRYPTO NOW")
    print(out["output"])  # → True

Drop-in replacements for repeat LLM-as-judge calls (no API key required)::

    from recipe import recipe

    recipe.is_spam("WIN free Bitcoin")           # → True
    recipe.classify_intent("how do I cancel")    # → "support"
    recipe.sentiment("this product changed my life")
"""

from .client import RecipeClient, RecipeError
from . import shortcuts as recipe

__version__ = "0.1.0"
__all__ = ["RecipeClient", "RecipeError", "recipe"]
