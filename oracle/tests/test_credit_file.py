import io
from datetime import date

import pytest
from openpyxl import Workbook

from tereflow_oracle import credit as C
from tereflow_oracle import credit_file as F


def make_wb(source=None, series=None, data=None, extra=None):
    wb = Workbook()
    wb.remove(wb.active)
    s = wb.create_sheet("Source")
    s.append(["field", "value"])
    for k, v in (source if source is not None else [("country_iso3", "KEN"), ("currency", "KES"), ("source_name", "CBK table 5"), ("frequency", "M")]):
        s.append([k, v])
    sr = wb.create_sheet("Series")
    sr.append(["mnemonic", "sector_key", "sector_name", "role", "unit_label", "multiplier_to_millions", "measure_kind", "definition_notes"])
    for r in (series if series is not None else [
            ["K_TOT", "total", "All sectors", "total", "KES Million", None, "stock", "Outstanding private sector credit"],
            ["K_AGR", "agriculture", "Agriculture", "sector", "KES Million", None, "stock", None],
            ["K_MAN", "manufacturing", "Manufacturing", "sector", "KES Million", None, "stock", None]]):
        sr.append(r)
    d = wb.create_sheet("Data")
    for r in (data if data is not None else [["period", "K_TOT", "K_AGR", "K_MAN"], ["2025-01", 100, 40, 60], ["Feb-25", 110, 42, 68], [date(2025, 3, 31), 120, 45, 75], ["2025-04", 121, None, 76]]):
        d.append(r)
    if extra:
        extra(wb)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def parse(buf=None, **kw):
    return F.parse_workbook(buf or make_wb(**kw), "t.xlsx")


def test_good_workbook_loads_every_series_and_never_turns_blank_into_zero():
    fp = parse()
    assert fp.ok, fp.problems
    assert fp.country == "KEN" and fp.currency == "KES" and fp.frequency == "M" and len(fp.series) == 3
    agr = next(s for s in fp.series if s.mnemonic == "K_AGR")
    assert [o.period for o in agr.obs] == ["2025-01", "2025-02", "2025-03", "2025-04"]
    assert agr.obs[3].value is None and agr.obs[3].raw_value is None  # blank stays missing
    assert agr.measure_kind == "stock" and agr.multiplier == 1.0
    tot = next(s for s in fp.series if s.role == "total")
    assert [str(o.value) for o in tot.obs] == ["100", "110", "120", "121"]


def test_period_formats_for_each_frequency():
    assert F.parse_period("Sep-26", "M") == "2026-09" and F.parse_period("2026/9", "M") == "2026-09"
    assert F.parse_period(date(2026, 9, 30), "M") == "2026-09" and F.parse_period(date(2026, 9, 30), "Q") == "2026-Q3"
    assert F.parse_period("2026 Q3", "Q") == "2026-Q3" and F.parse_period("Q1-2026", "Q") == "2026-Q1"
    assert F.parse_period(2025, "A") == "2025" and F.parse_period("2025", "A") == "2025"
    for bad, f in (("2026-13", "M"), ("2026", "M"), ("Sept", "M"), ("2026-Q5", "Q"), ("2026-09", "Q"), (45.5, "M"), ("20x6", "A"), (None, "M")):
        with pytest.raises(ValueError):
            F.parse_period(bad, f)


def test_values():
    assert F.parse_value(None) == (None, None, None) and F.parse_value("  ") == (None, None, None) and F.parse_value("n/a") == (None, None, None)
    raw, v, bad = F.parse_value(0)
    assert v == 0 and raw == "0" and bad is None  # a reported zero is a zero
    assert F.parse_value("1,234")[2] and F.parse_value("abc")[2] and F.parse_value(True)[2] and F.parse_value("NaN")[0] is None


@pytest.mark.parametrize("kw,needle", [
    (dict(source=[("country_iso3", "KE"), ("currency", "KES"), ("source_name", "x"), ("frequency", "M")]), "three capital letters"),
    (dict(source=[("country_iso3", "KEN"), ("currency", "KES"), ("source_name", "x"), ("frequency", "weekly")]), "must be M, Q or A"),
    (dict(source=[("country_iso3", "KEN"), ("currency", "KES"), ("frequency", "M")]), "source_name"),
    (dict(series=[["K_TOT", "total", "All", "total", "KES Million", None, "stock", None], ["K_TOT", "x", "Dup", "sector", "KES Million", None, None, None]]), "appears twice"),
    (dict(series=[["K_A", "agri", "A", "banana", "KES Million", None, None, None]]), "must be total or sector"),
    (dict(series=[["K_A", "agri", "A", "sector", "KES Billion", None, None, None]]), "multiplier_to_millions is required"),
    (dict(series=[["K_A", "agri", "A", "sector", "KES Million", None, "maybe", None]]), "measure_kind"),
    (dict(series=[["K_A", "agri", "A", "total", "KES Million", None, None, None], ["K_B", "b", "B", "total", "KES Million", None, None, None]]), "only one series may have the role total"),
    (dict(data=[["period", "K_TOT", "K_AGR"], ["2025-01", 1, 1]]), "no column for series K_MAN"),
    (dict(data=[["period", "K_TOT", "K_AGR", "K_MAN", "K_ZZZ"], ["2025-01", 1, 1, 1, 1]]), "not a mnemonic"),
    (dict(data=[["month", "K_TOT", "K_AGR", "K_MAN"], ["2025-01", 1, 1, 1]]), "first column must be 'period'"),
    (dict(data=[["period", "K_TOT", "K_AGR", "K_MAN"], ["2025-01", 1, 1, 1], ["2025-01", 2, 2, 2]]), "also appears on row"),
    (dict(data=[["period", "K_TOT", "K_AGR", "K_MAN"], ["2025-01", "1,000", 1, 1]]), "comma"),
    (dict(data=[["period", "K_TOT", "K_AGR", "K_MAN"], ["2025-01", -5, 1, 1]]), "negative"),
    (dict(data=[["period", "K_TOT", "K_AGR", "K_MAN"], ["2099-01", 1, 1, 1]]), "has not ended yet"),
    (dict(data=[["period", "K_TOT", "K_AGR", "K_MAN"], ["2025-01", 1, 1, None], ["2025-02", 1, 1, None]]), "has no values at all"),
])
def test_bad_files_are_refused_whole_with_a_clear_reason(kw, needle):
    fp = parse(**kw)
    assert not fp.ok and any(needle in p for p in fp.problems), fp.problems


def test_missing_sheet_unreadable_file_and_example_guard():
    wb = Workbook()
    wb.active.title = "Source"
    buf = io.BytesIO(); wb.save(buf); buf.seek(0)
    assert any("no sheet named Series" in p for p in F.parse_workbook(buf, "t.xlsx").problems)
    fp = F.parse_workbook(io.BytesIO(b"not an excel file"), "junk.xlsx")
    assert not fp.ok and "cannot be opened" in fp.problems[0]
    fp = parse(source=[("country_iso3", "KEN"), ("currency", "KES"), ("source_name", "EXAMPLE ONLY bank"), ("frequency", "M")])
    assert not fp.ok and any("EXAMPLE" in p for p in fp.problems)


def test_example_sheet_is_ignored_but_filled_in_template_loads():
    def add_example(wb):
        ws = wb.create_sheet("Example"); ws.append(["EXAMPLE ONLY", "do not load"])
    assert parse(extra=add_example).ok


def test_unit_conversion_and_declared_kind():
    fp = parse(series=[["K_TOT", "total", "All", "total", "KES Billion", 1000, "stock", None], ["K_AGR", "agriculture", "A", "sector", "KES Billion", 1000, None, None]],
               data=[["period", "K_TOT", "K_AGR"], ["2025-01", 1, 0.4]])
    assert fp.ok and fp.series[0].multiplier == 1000.0 and fp.series[1].measure_kind == ""


def test_quarterly_and_annual_files():
    q = parse(source=[("country_iso3", "UGA"), ("currency", "UGX"), ("source_name", "BoU"), ("frequency", "quarterly")],
              data=[["period", "K_TOT", "K_AGR", "K_MAN"], ["2025-Q1", 1, 1, 1], ["2025-Q2", 2, 1, 1]])
    assert q.ok and q.frequency == "Q" and q.series[0].obs[1].period == "2025-Q2"
    a = parse(source=[("country_iso3", "UGA"), ("currency", "UGX"), ("source_name", "BoU"), ("frequency", "A")],
              data=[["period", "K_TOT", "K_AGR", "K_MAN"], [2023, 1, 1, 1], [2024, 2, 1, 1]])
    assert a.ok and a.frequency == "A" and [o.period for o in a.series[0].obs] == ["2023", "2024"]


def test_warnings_do_not_refuse_but_say_so():
    fp = parse(series=[["K_TOT", "total", "All", "total", "KES Million", None, None, None], ["K_AGR", "agriculture", "A", "sector", "KES Million", None, None, None]],
               data=[["period", "K_TOT", "K_AGR"]] + [[f"2024-{m:02d}", 100 + m, 10 + m] for m in range(1, 13)])
    assert fp.ok
    text = " ".join(fp.warnings)
    assert "only" in text and "add up to the total" in text and "infer stock or flow" in text


def test_the_same_numbers_go_through_the_same_analysis_as_a_feed():
    """A parsed workbook feeds credit.derive exactly like a live feed: net change, shares only where sectors add up, ranks."""
    tot = [(f"2025-{m:02d}", float(100 + 10 * m)) for m in range(1, 7)]
    agr = [(p, v * 0.4) for p, v in tot]
    man = [(p, v * 0.6) for p, v in tot]
    series = [{"id": "t", "role": "total", "kind": "stock", "freq": "M", "obs": tot}, {"id": "a", "role": "sector", "kind": "stock", "freq": "M", "obs": agr},
              {"id": "m", "role": "sector", "kind": "stock", "freq": "M", "obs": man}]
    d = C.derive(series, {"share_tolerance_pct": 0.5, "jump_pct": {"M": 50}})
    assert round(d["m"][-1]["share_pct"], 6) == 60.0 and d["m"][-1]["rank_stock"] == 1 and d["a"][-1]["rank_stock"] == 2
    assert round(d["a"][-1]["net_change"], 6) == 4.0


def test_template_roundtrip(tmp_path):
    cfg = C.load_config()
    p = F.write_template(tmp_path / "t.xlsx", cfg)
    from openpyxl import load_workbook
    names = [s.title for s in load_workbook(p).worksheets]
    assert names == ["Source", "Series", "Data", "How to fill", "Example"]
    fp = F.parse_workbook(p)
    assert not fp.ok  # empty on purpose: it must be filled in first
    assert all(k in [r[0] for r in load_workbook(p)["Source"].iter_rows(values_only=True)] for k, _ in cfg["file_format"]["source_fields"])
