import numpy as np

from tereflow_oracle import gravity as g
from tereflow_oracle import intel_extra as ie


def synthetic(seed=1, n_imp=12, n_exp=40, beta_dist=-1.0):
    rng = np.random.default_rng(seed)
    imps = [f"I{i:02d}" for i in range(n_imp)]
    exps = [f"X{j:02d}" for j in range(n_exp)]
    a = rng.normal(0, 0.5, n_imp)
    b = rng.normal(0, 0.8, n_exp)
    geo, rows = {}, []
    for i, m in enumerate(imps):
        for j, x in enumerate(exps):
            d = float(rng.uniform(300, 15000))
            geo[(x, m)] = {"dist": d, "distw": d, "contig": int(rng.random() < 0.1), "comlang": int(rng.random() < 0.2), "colony": 0}
            mu = np.exp(14 + a[i] + b[j] + beta_dist * np.log(d) + 0.5 * geo[(x, m)]["contig"])
            rows.append((m, x, float(rng.poisson(mu / 50.0) * 50.0)))
    return rows, geo


def test_recovers_distance_elasticity():
    rows, geo = synthetic()
    r = g.fit_chapter(rows, geo)
    assert r["ok"] and r["converged"]
    assert abs(r["coefficients"]["ln_distance"]["coef"] - (-1.0)) < 0.15
    assert r["coefficients"]["contiguity"]["coef"] > 0.2


def test_model_beats_no_cost_baseline_out_of_sample():
    rows, geo = synthetic(seed=3)
    r = g.fit_chapter(rows, geo)
    v = r["validation"]
    assert v["model_beats_baseline"] is True
    assert "poisson_deviance" in v["better_than_baseline_on"]


def test_zero_flows_stay_in_and_are_counted():
    rows, geo = synthetic(seed=4)
    rows = [(m, x, 0.0 if (i % 5 == 0) else v) for i, (m, x, v) in enumerate(rows)]
    r = g.fit_chapter(rows, geo)
    assert r["ok"] and r["zero_flows"] > 30


def test_exporter_with_no_trade_is_dropped_not_fatal():
    rows, geo = synthetic(seed=5)
    rows = [(m, x, 0.0 if x == "X00" else v) for m, x, v in rows]
    r = g.fit_chapter(rows, geo)
    assert r["ok"] and r["exporters"] == 39


def test_missing_distance_pairs_are_left_out():
    rows, geo = synthetic(seed=6)
    geo = {k: v for k, v in geo.items() if k[0] != "X01"}
    r = g.fit_chapter(rows, geo)
    assert r["ok"] and r["exporters"] == 39


def test_too_little_data_is_refused_not_guessed():
    r = g.fit_chapter([("I00", "X00", 5.0)], {("X00", "I00"): {"dist": 1000.0, "distw": 1000.0, "contig": 0, "comlang": 0, "colony": 0}})
    assert r["ok"] is False


def test_gaps_are_reported_against_model_and_labelled_estimates():
    rows, geo = synthetic(seed=7)
    r = g.fit_chapter(rows, geo)
    assert r["kind"] == "estimate"
    for lst in r["model_vs_observed"].values():
        for d in lst:
            assert d["observed_over_model"] < 1.0


def test_market_screen_flags_and_limits():
    imp = {}
    for m in ("AAA", "BBB"):
        imp[(m, "SUA", 2022)] = (100.0, 50.0)
        imp[(m, "SUA", 2025)] = (150.0, 60.0)
        imp[(m, "SUB", 2022)] = (10.0, 10.0)
        imp[(m, "SUB", 2025)] = (4.0, 2.0)
    imp[("AAA", "SUC", 2022)] = (1.0, 1.0)
    imp[("AAA", "SUC", 2025)] = (3.0, 2.0)
    out = ie.screen_markets(imp, {"AAA", "BBB"}, 2022, 2025, {"SUC": 2.0, "SUA": 1.5, "SUB": 0.4},
                            {("SUC", "AAA"): {"dist": 2000.0}})
    assert out["limits"] and "screening" in out["kind"]
    a = next(m for m in out["markets"] if m["iso3"] == "AAA")
    cand = {c["iso3"]: c for c in a["candidates"]}
    assert "SUC" in cand and "revealed_advantage" in cand["SUC"]["flags"]
    assert "SUA" not in cand            # already holds a large share here


def test_armington_is_descriptive_and_never_an_elasticity():
    sup_L = {f"S{i}": 100.0 + i for i in range(10)}
    sup_B = {f"S{i}": 90.0 + 2 * i for i in range(10)}
    kg_L = {f"S{i}": 10.0 + i for i in range(10)}
    kg_B = {f"S{i}": 9.0 + i for i in range(10)}
    out = ie.armington_descriptive(sup_L, sup_B, kg_L, kg_B)
    assert out["structural_estimate"] == "unavailable"
    assert "elasticit" in out["note"]
    assert out["rank_corr_unit_value_change_vs_share_change"] is None or -1 <= out["rank_corr_unit_value_change_vs_share_change"] <= 1
