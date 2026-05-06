"""Python SDK smoke test — runs against a live local server (default http://localhost:3939).

Usage::

    python -m tests.test_sdk
"""

from __future__ import annotations

import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recipe import RecipeClient, RecipeError  # noqa: E402

BASE = os.environ.get("RECIPE_BASE_URL", "http://localhost:3939")
c = RecipeClient(base_url=BASE)

passed = 0
failed = 0


def it(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  PASS  {name}")
        passed += 1
    except Exception as e:
        print(f"  FAIL  {name}: {e}")
        traceback.print_exc()
        failed += 1


print(f"Python SDK test against {BASE}")


def t_health():
    h = c.health()
    assert h["status"] == "ok", h


def t_signup():
    r = c.signup(f"py-sdk-{int(time.time()*1000)}@example.com")
    assert r.get("api_key", "").startswith("ks_"), r
    c.api_key = r["api_key"]


def t_featured():
    f = c.featured()
    assert isinstance(f.get("featured"), list), f


def t_list():
    r = c.list(limit=5)
    assert isinstance(r.get("recipes"), list), r


cid = {"v": None}


def t_synthesize():
    r = c.synthesize(
        name=f"py-sdk-{int(time.time()*1000)}",
        positives=[
            {"input": "YES", "expected": True},
            {"input": "YEAH", "expected": True},
            {"input": "no", "expected": False},
            {"input": "never", "expected": False},
        ],
        output_spec={"type": "boolean"},
    )
    assert "strategy" in r, r
    assert "duration_ms" in r, r
    if r.get("accepted"):
        cid["v"] = r["concept_id"]


def t_run():
    if not cid["v"]:
        print("  SKIP  run() — no concept_id from synthesize")
        return
    r = c.run(recipe_id=cid["v"], input="YES")
    assert "output" in r, r


def t_stats():
    if not cid["v"]:
        print("  SKIP  stats() — no concept_id")
        return
    s = c.stats(cid["v"])
    assert "invocations" in s, s
    assert "latency_us" in s, s


def t_label_corpus():
    if not cid["v"]:
        print("  SKIP  label_corpus() — no concept_id")
        return
    r = c.label_corpus(cid["v"], rows=[{"input": "YES"}, {"input": "no"}])
    assert r["rows_labeled"] == 2, r


def t_search():
    s = c.search("detect spam", k=3)
    assert isinstance(s.get("matches"), list), s


def t_waitlist():
    r = c.waitlist_specialist(f"py-sdk-{int(time.time()*1000)}@x.io", "classify support tickets")
    assert isinstance(r.get("position"), int), r


def t_unknown_recipe():
    raised = False
    try:
        c.run(recipe_id="cpt_nope", input="x")
    except RecipeError:
        raised = True
    assert raised, "expected RecipeError"


def t_specialists():
    r = c.list_specialists()
    assert isinstance(r.get("specialists"), list), r


for name, fn in [
    ("health()", t_health),
    ("signup() mints a key", t_signup),
    ("featured() lists curated recipes", t_featured),
    ("list() returns recipes array", t_list),
    ("synthesize() small boolean", t_synthesize),
    ("run() echoes output", t_run),
    ("stats() returns shape", t_stats),
    ("label_corpus() inline", t_label_corpus),
    ("search() returns matches", t_search),
    ("waitlist_specialist() reserves a slot", t_waitlist),
    ("RecipeError on unknown recipe id", t_unknown_recipe),
    ("list_specialists()", t_specialists),
]:
    it(name, fn)

print(f"\n{passed} pass, {failed} fail")
sys.exit(1 if failed else 0)
