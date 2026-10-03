"""Parity: dashboard figures computed in Python must equal worker/agent/analyse.ts on the same data."""
import json
from pathlib import Path

import pytest

from tereflow_oracle import dashboard as dash

FIX = json.loads((Path(__file__).parent / "fixtures" / "ts_dashboard_parity.json").read_text())
EXP = FIX["expected"]


@pytest.fixture(scope="module")
def got():
    prows = [(f["flow"], f["year"], f["code"], f["desc"], "HS6", f["value"]) for f in FIX["facts"]]
    prts = [(f["flow"], f["year"], f["iso3"], f["value"]) for f in FIX["partnerFacts"]]
    return dash.build_dashboard("GHA", prows, prts, this_year=FIX["thisYear"])


def close(a, b):
    if a is None or b is None:
        return a is None and b is None
    return a == pytest.approx(b, rel=1e-9, abs=1e-9)


def same_items(g, e):
    assert len(g) == len(e) and len(e) > 0
    for x, y in zip(g, e):
        for k in ("rank", "code", "name"):
            assert x[k] == y[k]
        for k in ("value_usd", "share_pct", "cagr_3y", "yoy_pct"):
            assert close(x[k], y[k]), (k, x[k], y[k])


def test_overview(got):
    o, e = got["overview"], EXP["overview"]
    for k in ("year", "export_usd", "import_usd", "balance_usd", "total_trade_usd", "export_yoy_pct",
              "import_yoy_pct", "export_concentration", "coverage_note"):
        assert (close(o[k], e[k]) if isinstance(e[k], (int, float)) or e[k] is None else o[k] == e[k]), k
    # DIFF: the D1 count includes the reporter trading with itself, which its own partner ranking excludes.\n    assert o["partner_count"] == e["partner_count"] - 1\n    # DIFF: the D1 count also counted every 2-digit chapter row as a "product"; Oracle counts product lines only.\n    chapters = {f["code"][:2] for f in FIX["facts"] if f["year"] == o["year"]}\n    assert o["product_count"] + len(chapters) == e["product_count"]\n    assert set(o["export_chapter_shares"]) == set(e["export_chapter_shares"])
    for k, v in e["export_chapter_shares"].items():
        assert close(o["export_chapter_shares"][k], v)

def test_trend(got):
    assert len(got["trend"]) == len(EXP["trend"]) == 4
    for g, e in zip(got["trend"], EXP["trend"]):
        assert g["year"] == e["year"] and close(g["export_usd"], e["export_usd"]) and close(g["import_usd"], e["import_usd"])

def test_ranked_products(got):
    same_items(got["top_exports"], EXP["top_exports"])
    same_items(got["top_imports"], EXP["top_imports"])

def test_ranked_partners_exclude_self(got):
    same_items(got["partners_export"], EXP["partners_export"])
    same_items(got["partners_import"], EXP["partners_import"])
    assert "GHA" not in {p["code"] for p in got["partners_export"]}


