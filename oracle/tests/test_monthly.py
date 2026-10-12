"""HMRC monthly fetch: month parsing, HS6 roll-up, USD conversion, and refusal of a short read.
Runs offline against a fake HTTP layer."""
import pytest

from tereflow_oracle.hmrc import Hmrc, HmrcError


class FakeMonthly:
    def __init__(self, rows, annual):
        self.rows, self.annual = rows, annual

    def __call__(self, url, params=None):
        if url.endswith("/Country"):
            return {"value": [{"CountryId": 1, "CountryCodeAlpha": "FR"}]}
        if url.endswith("/Commodity"):
            return {"value": [{"CommodityId": 101, "Cn8Code": "01011010"}, {"CommodityId": 102, "Cn8Code": "01011090"},
                              {"CommodityId": 180, "Cn8Code": "18010000"}, {"CommodityId": 5, "Cn8Code": "05"}]}
        apply = (params or {}).get("$apply", "")
        if "MonthId" in apply and "groupby" in apply:
            return {"value": self.rows}
        return {"value": [{"v": self.annual}]}


ROWS = [
    {"CommodityId": 101, "MonthId": 202401, "v": 100.0, "w": 10.0},
    {"CommodityId": 102, "MonthId": 202401, "v": 50.0, "w": 5.0},     # same HS6 as 101, same month: summed
    {"CommodityId": 101, "MonthId": 202402, "v": 40.0, "w": None},
    {"CommodityId": 180, "MonthId": 202412, "v": 10.0, "w": 2.0},
    {"CommodityId": -990, "MonthId": 202401, "v": 5.0, "w": None},    # unspecified: never stored as a product
    {"CommodityId": 5, "MonthId": 202403, "v": 1.0, "w": None},       # chapter placeholder: not a product either
]
TOTAL = sum(r["v"] for r in ROWS)


def test_monthly_rolls_up_to_hs6_and_converts():
    h = Hmrc(get=FakeMonthly(ROWS, TOTAL), sleep=lambda s: None)
    out = h.fetch_monthly(2024, "X", 1.25)
    assert out[("010110", 1)] == (187.5, 15.0)          # (100 + 50) * 1.25, 10 + 5 kg
    assert out[("010110", 2)] == (50.0, None)            # no weight reported stays None, not 0
    assert out[("180100", 12)] == (12.5, 2.0)
    assert set(k[1] for k in out) == {1, 2, 12}
    assert all(code.isdigit() and len(code) == 6 for code, _m in out)


def test_monthly_refuses_a_short_read():
    h = Hmrc(get=FakeMonthly(ROWS[:3], TOTAL), sleep=lambda s: None)
    with pytest.raises(HmrcError, match="refusing to store"):
        h.fetch_monthly(2024, "X", 1.0)


def test_monthly_refuses_when_the_annual_total_is_missing():
    h = Hmrc(get=FakeMonthly(ROWS, 0), sleep=lambda s: None)
    with pytest.raises(HmrcError):
        h.fetch_monthly(2024, "X", 1.0)


def test_monthly_ignores_out_of_range_months():
    rows = ROWS + [{"CommodityId": 101, "MonthId": 202400, "v": 0.0, "w": None},
                   {"CommodityId": 101, "MonthId": 202413, "v": 0.0, "w": None}]
    h = Hmrc(get=FakeMonthly(rows, TOTAL), sleep=lambda s: None)
    out = h.fetch_monthly(2024, "X", 1.0)
    assert all(1 <= m <= 12 for _c, m in out)
