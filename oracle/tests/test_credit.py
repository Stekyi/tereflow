import json
from decimal import Decimal

import pytest

from tereflow_oracle import credit as C

BOG = {"databank": "MON", "mnemonic": "GHA_SAC_3", "name_of_series": "Manufacturing", "data_family": "Sectoral Credit Allocation",
       "data_source": "Bank of Ghana", "unit_of_measure": "GHC Million", "frequency": "M", "first_observation": "Nov-98", "notes": "",
       "data": [{"description": "Nov-98", "value": "10.5"}, {"description": "Dec-98", "value": ""}, {"description": "Jan-99", "value": "0"},
                {"description": "Feb-99", "value": "12.25"}]}


def test_period_helpers():
    assert C.bog_periods(["Dec-98", "Jan-99", "Jan-00", "Feb-26"]) == ["1998-12", "1999-01", "2000-01", "2026-02"]
    assert C.period_end("2024-02") == "2024-02-29" and C.period_end("2026-Q2") == "2026-06-30" and C.period_end("2025") == "2025-12-31"
    assert C.prev_period("2026-01") == "2025-12" and C.prev_period("2026-Q1") == "2025-Q4" and C.prev_period("2026") == "2025"
    assert C.imf_period("2001-M12") == "2001-12" and C.imf_period("2001-Q4") == "2001-Q4"
    with pytest.raises(ValueError):
        C.bog_periods(["Jan-99", "Jan-99"])
    with pytest.raises(ValueError):
        C.bog_periods(["Mar-99", "Feb-99"])
    with pytest.raises(ValueError):
        C.imf_period("garbage")


def test_missing_is_not_zero_and_zero_is_kept():
    p = C.parse_bog(BOG, "GHA_SAC_3")
    by = {o.period: o for o in p.obs}
    assert by["1998-12"].value is None and by["1998-12"].raw_value is None  # missing stays missing
    assert by["1999-01"].value == Decimal("0") and by["1999-01"].raw_value == "0"  # a reported zero is a zero
    assert p.missing == 1 and p.meta["unit_label"] == "GHC Million" and p.meta["frequency"] == "M"


def test_malformed_responses_are_refused():
    with pytest.raises(ValueError):
        C.parse_bog({"mnemonic": "X"})
    with pytest.raises(ValueError):
        C.parse_bog({**BOG, "mnemonic": "OTHER"}, "GHA_SAC_3")
    with pytest.raises(ValueError):
        C.parse_bog({**BOG, "data": []})
    with pytest.raises(ValueError):
        C.parse_bog({**BOG, "frequency": "Q"})
    bad = C.parse_bog({**BOG, "data": [{"description": "Jan-99", "value": "abc"}]})
    assert bad.problems  # reported, so the caller refuses the series


IMF_XML = """<?xml version='1.0'?><message:StructureSpecificData xmlns:message="m"><message:DataSet>
<Series COUNTRY="GHA" INDICATOR="ODCORP_A_ACO_PS_ODCS" TYPE_OF_TRANSFORMATION="XDC" FREQUENCY="M" SCALE="6">
<Obs TIME_PERIOD="2001-M12" OBS_VALUE="447173625.8" DERIVATION_TYPE="O"/><Obs TIME_PERIOD="2002-M01" OBS_VALUE="448956099.7"/>
<Obs TIME_PERIOD="2002-M01" OBS_VALUE="448956100"/><Obs TIME_PERIOD="2002-M02"/></Series></message:DataSet></message:StructureSpecificData>"""


def test_imf_series_parse_and_guard():
    p = C.parse_imf_data(IMF_XML, {"COUNTRY": "GHA", "INDICATOR": "ODCORP_A_ACO_PS_ODCS", "FREQUENCY": "M"})
    assert p.duplicates == 1 and p.missing == 1
    d = C.dedupe(p.obs)
    assert [o.period for o in d] == ["2001-12", "2002-01", "2002-02"] and d[1].raw_value == "448956100"  # last duplicate wins
    with pytest.raises(ValueError):
        C.parse_imf_data(IMF_XML, {"COUNTRY": "KEN"})
    with pytest.raises(ValueError):
        C.parse_imf_data(IMF_XML.replace("</Series>", "</Series><Series COUNTRY='GHA' FREQUENCY='M'/>"))
    with pytest.raises(ValueError):
        C.parse_imf_data("<a><b/></a>")


def test_imf_discovery_and_codelist():
    d = C.parse_imf_discovery(IMF_XML)
    assert d[0]["INDICATOR"] == "ODCORP_A_ACO_PS_ODCS" and d[0]["FREQUENCY"] == "M"
    cl = C.parse_imf_codelist("""<S xmlns:str="s" xmlns:com="c"><str:Code id="X"><com:Name xml:lang="en">Assets, Claims (ODCS)</com:Name><com:Description xml:lang="en">A stock.</com:Description></str:Code></S>""")
    assert cl["X"]["name"].startswith("Assets") and cl["X"]["description"] == "A stock."
    assert C.pick_frequency({"A", "Q"}) == "Q" and C.pick_frequency({"M", "A"}) == "M" and C.pick_frequency(set()) is None


def test_diff_is_idempotent_and_detects_revisions():
    inc = [C.Obs("2026-01", "x", "10.0", Decimal("10")), C.Obs("2026-02", "x", "11", Decimal("11"))]
    new, rev, same = C.diff_obs({}, inc)
    assert len(new) == 2 and not rev and same == 0
    ex = {"2026-01": "10", "2026-02": "11"}  # same numbers written differently
    new, rev, same = C.diff_obs(ex, inc)
    assert not new and not rev and same == 2  # re-running changes nothing
    new, rev, same = C.diff_obs({"2026-01": "10", "2026-02": "11.5"}, inc)
    assert len(rev) == 1 and rev[0][1] == "11.5" and same == 1
    new, rev, same = C.diff_obs({"2026-01": None}, [C.Obs("2026-01", "x", "0", Decimal("0"))])
    assert len(rev) == 1  # missing becoming a real zero is a revision, not silently equal


def mk(sid, role, vals, kind="stock", start="2025-01"):
    obs, p = [], start
    for v in vals:
        obs.append((p, v))
        y, m = int(p[:4]), int(p[5:7])
        p = f"{y + (m == 12)}-{(m % 12) + 1:02d}"
    return {"id": sid, "role": role, "kind": kind, "freq": "M", "obs": obs, "sector_key": sid, "sector_name": sid.upper(), "kind_basis": "inferred"}


TH = {"share_tolerance_pct": 0.5, "jump_pct": {"M": 50}}


def test_net_change_percent_and_labels():
    d = C.derive([mk("a", "sector", [100, 110, 99]), mk("t", "total", [100, 110, 99])], TH)["a"]
    assert d[0]["net_change"] is None  # nothing before the first observation
    assert d[1]["net_change"] == 10 and round(d[1]["pct_change"], 6) == 10.0
    assert d[2]["net_change"] == -11 and d[2]["pct_change"] < 0
    # unverified series never get a net change
    d2 = C.derive([mk("u", "sector", [1, 2, 3], kind="unverified")], TH)["u"]
    assert all(r["net_change"] is None for r in d2)


def test_gap_means_no_change_across_it():
    s = mk("g", "sector", [10, 12])
    s["obs"] = [("2025-01", 10.0), ("2025-03", 12.0)]  # February missing
    d = C.derive([s], TH)["g"]
    assert d[1]["net_change"] is None and "missing" in d[1]["flag"]  # not computed across the gap, and not treated as zero


def test_zero_previous_stock_and_jump_flags():
    d = C.derive([mk("z", "sector", [0, 5, 100])], TH)["z"]
    assert d[1]["pct_change"] is None and d[1]["net_change"] == 5 and "zero" in d[1]["flag"]
    assert d[2]["pct_change"] == 1900.0 and d[2]["flag"].startswith("jump")


def test_shares_only_when_sectors_add_up():
    series = [mk("a", "sector", [60, 60]), mk("b", "sector", [40, 30]), mk("t", "total", [100, 100])]
    d = C.derive(series, TH)
    assert d["a"][0]["share_pct"] == 60.0 and d["b"][0]["share_pct"] == 40.0
    assert d["a"][1]["share_pct"] is None and d["b"][1]["share_pct"] is None  # 90 vs 100: incomplete, so no share is claimed


def test_ranks_use_the_same_period():
    series = [mk("a", "sector", [10, 30]), mk("b", "sector", [20, 25]), mk("c", "sector", [5, 6])]
    d = C.derive(series, TH)
    last = {k: v[-1] for k, v in d.items()}
    assert (last["a"]["rank_stock"], last["b"]["rank_stock"], last["c"]["rank_stock"]) == (1, 2, 3)
    assert last["a"]["rank_change"] == 1 and last["b"]["rank_change"] == 2 and last["c"]["rank_change"] == 3
    assert last["a"]["rank_pct"] == 1  # 200% beats 25% and 20%


def test_common_period_and_summary_total_validity():
    a = mk("a", "sector", [10, 12, 14])
    b = mk("b", "sector", [20, 22])  # one period behind
    t = mk("t", "total", [30, 34, 36])
    assert C.common_period([a, b, t]) == "2025-02"
    series = [a, b, t]
    d = C.derive(series, TH)
    s = C.build_summary("GHA", {"source_key": "BOG", "source_name": "n", "unit": "GHS million"}, series, d, TH, "now")
    assert s["common_period"] == "2025-02" and s["total"]["valid"] is True and s["total"]["stock"] == 34
    by = {r["series_id"]: r for r in s["sectors"]}
    assert by["a"]["at_common_period"] and by["b"]["period"] == "2025-02" and by["a"]["latest_own_period"] == "2025-03"
    # an incomplete set never produces a complete total
    t2 = mk("t", "total", [30, 40, 36])
    d2 = C.derive([a, b, t2], TH)
    s2 = C.build_summary("GHA", {"source_key": "BOG", "source_name": "n", "unit": "u"}, [a, b, t2], d2, TH, "now")
    assert s2["total"]["valid"] is False and "history" not in s2["total"]


def test_zero_run_after_history():
    vals = [float(i + 1) for i in range(30)] + [0.0] * 5
    s = mk("c", "sector", vals)
    z = C.zero_run_flag(s["obs"])
    assert z and z["zeros"] == 5 and z["before"] == 30
    assert C.zero_run_flag(mk("c", "sector", [0.0] * 40)["obs"]) is None  # never non-zero: not a drop to zero


def test_stock_classification_is_labelled_inference():
    smooth = [100.0 * (1.02 ** i) for i in range(60)]
    kind, note = C.classify_stock(C.stock_evidence(smooth))
    assert kind == "stock" and "Inferred" in note and "confirm with the source" in note
    noisy = [1.0, 50.0, 2.0, 80.0] * 15
    assert C.classify_stock(C.stock_evidence(noisy))[0] == "unverified"
    assert C.classify_stock(C.stock_evidence([1.0] * 5))[0] == "unverified"
    add = C.additivity([("p%d" % i, 10.0) for i in range(30)], [[("p%d" % i, 4.0) for i in range(30)], [("p%d" % i, 6.0) for i in range(30)]])
    assert add["pct_ok"] == 100.0 and C.classify_family("stock", add)[0] == "stock"
    assert C.classify_family("unverified", add)[0] == "unverified"


def test_config_is_consistent():
    cfg = C.load_config()
    keys = {s["sector_key"] for s in cfg["bog"]["series"] if s["role"] != "total"} | {i["sector_key"] for i in cfg["imf"]["indicators"] if i["role"] != "total"}
    assert {m["sector_key"] for m in cfg["sector_map"]} == keys
    assert len({s["mnemonic"] for s in cfg["bog"]["series"]}) == len(cfg["bog"]["series"])
    assert sum(1 for s in cfg["bog"]["series"] if s["role"] == "total") == 1
    for m in cfg["sector_map"]:
        assert (m["trade_scope"] == "hs") == bool(m["hs_prefixes"]) or m["trade_scope"] in ("exports", "imports", "none")
