import pytest

from tereflow_oracle import concordance as cc


def test_division_table_is_a_function_and_covers_all_64_industries():
    t = cc.division_table()
    assert len(cc.FIGARO_INDUSTRIES) == 64
    assert set(t.values()) == set(cc.FIGARO_INDUSTRIES)
    assert all(1 <= d <= 99 for d in t)
    # spot checks of the code grammar
    assert t[1] == "A01" and t[10] == t[11] == t[12] == "C10-12"
    assert t[31] == t[32] == "C31_32"
    assert [d for d, c in t.items() if c == "B"] == [5, 6, 7, 8, 9]
    assert t[97] == t[98] == "T" and t[99] == "U" and t[68] == "L"
    assert t[80] == t[81] == t[82] == "N80-82"
    # NACE divisions that do not exist (04, 34, 40, 44, ...) map to nothing
    assert 4 not in t and 40 not in t


def test_industry_divisions_grammar():
    assert cc.industry_divisions("E37-39") == [37, 38, 39]
    assert cc.industry_divisions("J59_60") == [59, 60]
    assert cc.industry_divisions("F") == [41, 42, 43]
    with pytest.raises(ValueError):
        cc.industry_divisions("P3_S14")


def test_division_table_rejects_overlap():
    with pytest.raises(ValueError):
        cc.division_table(["C10-12", "C12"])


def test_parse_hs_cpc_strips_dot_and_keeps_partials():
    text = '"HS 2017","HS partial","CPC Ver. 2.1","CPC partial"\n"0901.11","0","01610","1"\n"8541.40","1","46410","0"\n'
    assert cc.parse_hs_cpc(text) == [("090111", 0, "01610", 1), ("854140", 1, "46410", 0)]


def test_parse_hs22_hs17_skips_headers():
    rows = [("Between", None, None), ("HS2022", " HS2017", "Relationship"), ("854151", "842211", "n:n"), (None, None, None)]
    assert cc.parse_hs22_hs17(rows) == [("854151", "842211", "n:n")]


def test_nace_isic_division_check():
    ok = cc.check_nace_isic_divisions([("01.11", 0, "0111", 0), ("A", 0, "A", 0)])
    assert ok["ok"] and ok["pairs_checked"] == 1
    bad = cc.check_nace_isic_divisions([("33.12", 1, "9512", 1)])
    assert not bad["ok"] and bad["cross_division_pairs"] == [("33.12", "9512")]


def _fixture():
    hs22 = [("111111", "111111", "1:1"),      # unchanged code
            ("222222", "222201", "n:n"),      # HS2022 code split over two HS2017 codes
            ("222222", "222202", "n:n"),
            ("333333", "333333", "1:1")]      # in nomenclature, no CPC pairing
    hs17 = [("111111", 0, "01610", 0),
            ("222201", 1, "34000", 0),
            ("222202", 1, "35000", 1),
            ("444444", 0, "01610", 1),        # HS2017-only code, same CPC as 111111 (many-to-one)
            ("555555", 0, "46000", 0)]
    cpc_isic = [("01610", 0, "0127", 1),
                ("34000", 0, "2011", 0),
                ("35000", 1, "2100", 0),      # pharmaceuticals, division 21
                ("35000", 1, "2023", 0),      # soaps, division 20
                ("46000", 0, "9999", 0)]      # hypothetical: division 99 -> U
    cpc_cpc2 = [("77777", 0, "77770", 0)]
    cpc2_isic = [("77770", 0, "1010", None)]
    return cc.Tables(hs22, hs17, cpc_isic, cpc_cpc2, cpc2_isic)


def test_direct_single_industry_and_partial_flags_kept():
    r = cc.map_hs6("111111", _fixture())
    assert r["category"] == "direct" and r["hs_basis"] == "HS2022"
    assert [i["figaro"] for i in r["industries"]] == ["A01"]
    p = r["industries"][0]["paths"][0]
    assert p["isic_partial"] == 1 and p["hs_cpc_partial"] == 0 and p["route"] == "CPC2.1->ISIC4"
    assert r["industries"][0]["any_partial"] is True
    assert r["weights"] is None


def test_hs_revision_gap_one_to_many_industries():
    r = cc.map_hs6("222222", _fixture())
    assert r["category"] == "derived_multiple"
    assert r["hs17"] == ["222201", "222202"] and r["hs2022_hs2017_relationship"] == ["n:n"]
    assert [i["figaro"] for i in r["industries"]] == ["C20", "C21"]
    assert r["industries"][0]["isic4"] == ["2011", "2023"] and r["industries"][1]["isic4"] == ["2100"]
    assert any("one to one" in c for c in r["caveats"])
    assert any("unweighted" in c for c in r["caveats"])
    # no shares invented anywhere
    assert all("share" not in i and "weight" not in i for i in r["industries"])


def test_same_division_two_isic_classes_is_still_direct():
    r = cc.map_hs6("666666", cc.Tables([], [("666666", 0, "35000", 0)], [("35000", 1, "2021", 0), ("35000", 1, "2023", 0)]))
    assert r["category"] == "direct" and r["industries"][0]["isic4"] == ["2021", "2023"]


def test_hs2017_only_code_and_many_to_one():
    t = _fixture()
    r = cc.map_hs6("444444", t)
    assert r["hs_basis"] == "HS2017 only" and r["category"] == "direct"
    a = cc.map_hs6("111111", t)
    assert r["industries"][0]["figaro"] == a["industries"][0]["figaro"] == "A01"
    assert any("not in HS2022" in c for c in r["caveats"])


def test_unresolved_is_never_force_fitted():
    t = _fixture()
    r = cc.map_hs6("333333", t)
    assert r["category"] == "unresolved" and r["industries"] == []
    assert r["unresolved_reason"].startswith("no CPC/ISIC pairing in the UN tables")
    r2 = cc.map_hs6("111112", t)  # neighbour of a known code
    assert r2["category"] == "unresolved" and r2["hs_basis"] is None


def test_two_hop_fallback_when_direct_table_lacks_cpc():
    t = cc.Tables([], [("777777", 0, "77777", 0)], [], [("77777", 0, "77770", 1)], [("77770", 0, "1010", None)])
    r = cc.map_hs6("777777", t)
    assert r["category"] == "direct" and r["industries"][0]["figaro"] == "C10-12"
    p = r["industries"][0]["paths"][0]
    assert p["route"] == "CPC2.1->CPC2->ISIC4" and p["cpc2"] == "77770" and p["cpc2_partial"] == 1


def test_division_without_industry_goes_to_unplaced():
    t = cc.Tables([], [("888888", 0, "88888", 0)], [("88888", 0, "4011", 0)])  # division 40 does not exist in NACE
    r = cc.map_hs6("888888", t)
    assert r["category"] == "unresolved" and len(r["unplaced_paths"]) == 1
    assert r["unresolved_reason"] == "ISIC division reached has no FIGARO industry"


def test_waste_scrap_na_is_unresolved_with_reason():
    t = cc.Tables([], [("740400", 0, "39361", 0)], [("39361", 0, "n/a", 0)])
    r = cc.map_hs6("740400", t)
    assert r["category"] == "unresolved" and "n/a" in r["unresolved_reason"]


@pytest.mark.skipif(not (cc.CACHE / "hs17_cpc21.csv").exists(), reason="UN tables not cached")
def test_real_tables_coffee_and_cocoa():
    p, _ = cc.load_tables(log=lambda *a: None)
    t = cc.Tables(p["UN_HS22_HS17"], p["UN_HS17_CPC21"], p["UN_CPC21_ISIC4"], p["UN_CPC21_CPC2"], p["UN_CPC2_ISIC4"])
    coffee = cc.map_hs6("090111", t)
    assert coffee["category"] == "direct"
    assert coffee["industries"][0]["figaro"] == "A01" and coffee["industries"][0]["cpc21"] == ["01610"]
    cocoa = cc.map_hs6("180100", t)
    assert cocoa["industries"][0]["figaro"] == "A01" and cocoa["industries"][0]["cpc21"] == ["01640"]
