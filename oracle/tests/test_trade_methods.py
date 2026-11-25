import math

import pytest

from tereflow_oracle import trade_methods as tm


def close(a, b, tol=1e-9):
    return a is not None and math.isclose(a, b, abs_tol=tol)


def test_pct_change_and_guards():
    assert close(tm.pct_change(100, 150), 50.0)
    assert close(tm.pct_change(200, 100), -50.0)
    assert tm.pct_change(0, 10) is None
    assert tm.pct_change(None, 10) is None
    assert tm.pct_change(10, None) is None
    assert tm.pct_change(-5, 10) is None
    assert close(tm.pct_change(10, 0), -100.0)


def test_cagr():
    assert close(tm.cagr_pct(100, 121, 2), 10.0, 1e-9)
    assert tm.cagr_pct(0, 5, 2) is None
    assert tm.cagr_pct(100, 110, 0) is None


def test_shares_ignore_missing_and_negative():
    s = tm.shares({"a": 50, "b": 30, "c": 20, "d": None, "e": -4})
    assert close(s["a"], 50.0) and close(s["b"], 30.0) and close(s["c"], 20.0)
    assert "d" not in s and "e" not in s
    assert tm.shares({}) == {}
    assert tm.shares({"a": 0}) == {}


def test_hhi_hand_checked():
    assert close(tm.hhi({"a": 50, "b": 30, "c": 20}), 0.25 + 0.09 + 0.04)
    assert close(tm.hhi({"a": 10}), 1.0)
    assert close(tm.hhi({"a": 1, "b": 1, "c": 1, "d": 1}), 0.25)
    assert tm.hhi({}) is None


def test_unit_value():
    assert close(tm.unit_value(1000, 250), 4.0)
    assert tm.unit_value(1000, 0) is None
    assert tm.unit_value(1000, None) is None
    assert tm.unit_value(-1, 5) is None


def test_balassa():
    # exporter sends 10% of its exports as p, the world sends 5% as p: RCA = 2
    assert close(tm.balassa_rca(10, 100, 50, 1000), 2.0)
    assert tm.balassa_rca(10, 0, 50, 1000) is None
    assert tm.balassa_rca(10, 100, 0, 1000) is None


def test_rank_ties_share_lower_rank():
    assert tm.rank_of({"a": 5, "b": 5, "c": 1, "d": None}) == {"a": 1, "b": 1, "c": 3}


def test_cms_hand_checked_example():
    out = tm.cms({"A": (100, 130, 1000, 1200), "B": (50, 40, 500, 450)})
    assert out["ok"]
    assert close(out["r_pct"], 10.0)
    assert close(out["growth"], 15.0)
    assert close(out["distribution"], 0.0)
    assert close(out["competitiveness"], 5.0)
    assert close(out["new_markets"], 0.0)
    assert close(out["total_change"], 20.0)
    assert close(out["check_gap"], 0.0)


def test_cms_components_sum_with_new_and_lost_markets():
    cells = {
        "A": (100, 130, 1000, 1200),
        "B": (50, 0, 500, 450),      # lost market
        "C": (0, 10, 200, 300),      # new market
        "D": (20, 25, 80, 70),
    }
    out = tm.cms(cells)
    assert out["ok"]
    parts = out["growth"] + out["distribution"] + out["competitiveness"] + out["new_markets"]
    assert close(parts, out["total_change"], 1e-9)
    assert close(out["check_gap"], 0.0, 1e-9)
    assert close(out["new_markets"], 10.0)


def test_cms_excludes_markets_without_a_base_total():
    out = tm.cms({"A": (100, 130, 1000, 1200), "Z": (10, 20, None, 50), "Y": (5, 5, 0, 10)})
    assert out["ok"]
    assert sorted(out["excluded"]) == ["Y", "Z"]
    assert close(out["check_gap"], 0.0)
    assert close(out["x0"], 100.0)


def test_cms_no_usable_market():
    out = tm.cms({"Z": (10, 20, None, 50)})
    assert out["ok"] is False


@pytest.mark.parametrize("seed", range(5))
def test_cms_always_adds_up(seed):
    import random
    rnd = random.Random(seed)
    cells = {}
    for i in range(12):
        w0 = rnd.uniform(10, 1000)
        w1 = w0 * rnd.uniform(0.4, 1.9)
        x0 = rnd.choice([0, rnd.uniform(1, w0 * 0.3)])
        x1 = rnd.choice([0, rnd.uniform(1, w1 * 0.3)])
        cells[f"m{i}"] = (x0, x1, w0, w1)
    out = tm.cms(cells)
    assert out["ok"]
    assert abs(out["check_gap"]) < 1e-6


def test_bands_come_from_the_data():
    vals = list(range(1, 101))
    cuts = tm.bands(vals)
    assert cuts["n"] == 100
    assert tm.band_state(95, cuts) == "high"
    assert tm.band_state(50, cuts) == "mid"
    assert tm.band_state(3, cuts) == "low"
    assert tm.band_state(None, cuts) is None


def test_bands_refuse_tiny_samples():
    cuts = tm.bands([1, 2, 3])
    assert cuts["low"] is None
    assert tm.band_state(2, cuts) is None
