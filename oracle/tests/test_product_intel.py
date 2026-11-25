import math

from tereflow_oracle import product_intel as pi


def ctx(universe=("AAA", "BBB")):
    return {"base": 2022, "latest": 2025, "universe": set(universe), "excluded_reporters": ["FRA"], "complete_years": {2022, 2023, 2024, 2025},
            "supplier_total": {"XXX": 1000.0, "YYY": 500.0}, "world_total": 10000.0, "year_counts": {2022: 2, 2025: 2}}


def data():
    imp = {
        ("AAA", "XXX", 2022): (100.0, 50.0), ("AAA", "XXX", 2025): (150.0, 60.0),
        ("AAA", "YYY", 2022): (100.0, 50.0), ("AAA", "YYY", 2025): (50.0, 25.0),
        ("BBB", "XXX", 2022): (50.0, 10.0), ("BBB", "XXX", 2025): (40.0, 8.0),
        ("BBB", "S19", 2022): (10.0, 1.0), ("BBB", "S19", 2025): (10.0, 1.0),
    }
    exp = {("XXX", "AAA", 2025): (140.0, 55.0)}
    return imp, exp


def test_totals_growth_and_unit_values():
    imp, exp = data()
    p, ind = pi.build_product("090111", "Coffee", imp, exp, ctx())
    d = p["demand"]
    assert d["base_usd"] == 260.0 and d["value_usd"] == 250.0
    assert math.isclose(d["growth_pct"], 100 * (250 / 260 - 1), abs_tol=0.01)
    assert d["weight_kg"] == 94.0 and d["base_weight_kg"] == 111.0
    assert math.isclose(d["unit_value"], 250 / 94, abs_tol=1e-3)


def test_unattributed_area_is_not_a_supplier():
    imp, exp = data()
    p, _ = pi.build_product("090111", "Coffee", imp, exp, ctx())
    assert {s["iso3"] for s in p["supply"]["suppliers"]} == {"XXX", "YYY"}
    assert p["supply"]["supplier_count"] == 2
    # shares still use the full reported total, unattributed included
    xxx = next(s for s in p["supply"]["suppliers"] if s["iso3"] == "XXX")
    assert math.isclose(xxx["share_pct"], 100 * 190 / 250, abs_tol=0.01)


def test_hhi_over_named_suppliers():
    imp, exp = data()
    p, _ = pi.build_product("090111", "Coffee", imp, exp, ctx())
    sx, sy = 190.0, 50.0
    t = sx + sy
    assert math.isclose(p["supply"]["hhi"], round((sx / t) ** 2 + (sy / t) ** 2, 4), abs_tol=1e-4)


def test_cms_check_is_zero_and_present():
    imp, exp = data()
    p, _ = pi.build_product("090111", "Coffee", imp, exp, ctx())
    xxx = next(c for c in p["competitiveness"] if c["iso3"] == "XXX")
    assert abs(xxx["cms"]["check_gap"]) < 1
    assert xxx["cms"]["x0"] == 150.0 and xxx["cms"]["x1"] == 190.0


def test_rca_uses_stated_terms():
    imp, exp = data()
    p, _ = pi.build_product("090111", "Coffee", imp, exp, ctx())
    xxx = next(c for c in p["competitiveness"] if c["iso3"] == "XXX")
    assert math.isclose(xxx["rca"], round((190 / 1000) / (250 / 10000), 3), abs_tol=1e-3)


def test_mirror_compares_reported_pairs():
    imp, exp = data()
    p, _ = pi.build_product("090111", "Coffee", imp, exp, ctx(("AAA", "BBB", "XXX")))
    assert p["mirror"]["pairs"] == 1
    assert math.isclose(p["mirror"]["imports_over_exports"], round(150 / 140, 3), abs_tol=1e-3)


def test_missing_weight_gives_no_unit_value():
    imp = {("AAA", "XXX", 2022): (100.0, None), ("AAA", "XXX", 2025): (120.0, None)}
    p, ind = pi.build_product("090111", None, imp, {}, ctx(("AAA",)))
    assert p["demand"]["unit_value"] is None
    assert ind["unit_value_change"] is None


def test_small_products_are_not_labelled():
    imp, exp = data()
    p, ind = pi.build_product("090111", "Coffee", imp, exp, ctx())
    cuts = {k: {"low": 0.0, "high": 1.0, "n": 100} for k in pi.BAND_KEYS}
    pi.apply_states(p, ind, cuts)
    assert p["pressure"]["states"] == []
    assert "Too small" in p["pressure"]["note"]


def test_states_come_from_bands_and_heuristic_is_labelled():
    imp, exp = data()
    p, ind = pi.build_product("090111", "Coffee", imp, exp, ctx())
    ind["demand_usd"] = 5_000_000
    ind["supply_qty_growth"], ind["supply_unit_value_change"] = 50.0, -20.0
    cuts = {k: {"low": -1.0, "high": 1.0, "n": 100} for k in pi.BAND_KEYS}
    pi.apply_states(p, ind, cuts)
    by = {s["state"]: s for s in p["pressure"]["states"]}
    assert by["supply_expansion"]["kind"] == "derived"
    assert by["potential_supply_pressure"]["kind"] == "heuristic"


def test_choose_years():
    assert pi.choose_years({2021: 20, 2022: 22, 2023: 22, 2024: 20, 2025: 25}) == (2022, 2025)
    assert pi.choose_years({2021: 3, 2025: 3}) == (None, None)
    assert pi.choose_years({2021: 20, 2025: 1, 2024: 20}) == (2021, 2024)
