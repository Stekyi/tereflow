"""The Comtrade client under the real 100,000-row response cap, with a fake HTTP session."""
import pytest

from tereflow_oracle import comtrade
from tereflow_oracle.comtrade import API_CAP, Comtrade, ComtradeError


class Resp:
    def __init__(self, data):
        self.status_code, self.ok, self.headers, self._d = 200, True, {}, data
    def json(self):
        return {"data": self._d, "error": ""}


class Session:
    """Serves one row per (partner, product) and truncates at `cap` like Comtrade does."""
    def __init__(self, per_partner=1, cap=API_CAP, products=("010121",)):
        self.per, self.cap, self.products, self.calls = per_partner, cap, products, []
    def get(self, url, params, headers, timeout):
        self.calls.append(params)
        partners = [int(p) for p in str(params["partnerCode"]).split(",")]
        data = [{"partnerCode": p, "cmdCode": c, "cmdDesc": "x", "primaryValue": 1.0, "customsCode": "C00", "motCode": 0,
                 "partner2Code": 0, "mosCode": 0, "netWgt": None, "qty": None}
                for p in partners for c in [f"{i:06d}" for i in range(10000, 10000 + self.per)]]
        return Resp(data[: self.cap])


def client(sess):
    return Comtrade(api_key="k", pace_s=0, session=sess, sleep=lambda s: None)


def test_every_partner_is_asked_for_once_when_nothing_is_truncated():
    s = Session(per_partner=2)
    res = client(s).fetch_hs6(826, 2024, "X", {})
    asked = [p for c in s.calls for p in str(c["partnerCode"]).split(",")]
    assert "0" in asked and len(asked) == len(set(asked)) == len(comtrade.PARTNERS) + 1
    assert not res.truncated and len(res.rows) == 2 * len(set(comtrade.PARTNER_ISO3.values())) + 2

def test_a_response_at_the_cap_is_split_and_nothing_is_lost(monkeypatch):
    monkeypatch.setattr(comtrade, "API_CAP", 30)
    s = Session(per_partner=3, cap=30)            # 20 partners x 3 rows = 60 > 30: must split
    res = client(s).fetch_hs6(826, 2024, "X", {})
    got = {(r.partner_iso3, r.cmd_code) for r in res.rows}
    expected = {(comtrade.PARTNER_ISO3[p], f"{i:06d}") for p in comtrade.PARTNERS for i in range(10000, 10003)}
    assert expected <= got and not res.truncated
    assert any("," in str(c["partnerCode"]) for c in s.calls) and len(s.calls) > len(comtrade.PARTNERS) // 20 + 1

def test_one_partner_alone_at_the_cap_is_reported_truncated_not_stored_as_complete(monkeypatch):
    monkeypatch.setattr(comtrade, "API_CAP", 50)
    s = Session(per_partner=50, cap=50)           # every single partner fills the cap
    res = client(s).fetch_hs6(826, 2024, "X", {})
    assert res.truncated

def test_unmapped_partner_uses_the_reference_iso_code():
    code = next(c for c, iso in comtrade.PARTNER_ISO3.items() if not iso.isalpha() or iso.startswith("_"))
    rows = Comtrade._to_result([{"partnerCode": code, "cmdCode": "010121", "primaryValue": 5.0}], {}, 0, False).rows
    assert rows and rows[0].partner_iso3 == comtrade.PARTNER_ISO3[code]

def test_tariffline_announced_but_empty_costs_one_request():
    class Empty(Session):
        def get(self, url, params, headers, timeout):
            self.calls.append(params); return Resp([])
    s = Empty()
    res = client(s).fetch_tariffline(826, 2024, "X", {})
    assert res.rows == [] and len(s.calls) == 1


def test_partner_codes_that_share_a_country_are_summed_not_overwritten():
    data = [{"partnerCode": 842, "cmdCode": "010121", "primaryValue": 5.0, "netWgt": 2.0},
            {"partnerCode": 840, "cmdCode": "010121", "primaryValue": 7.0, "netWgt": None}]
    rows = Comtrade._to_result(data, {}, 0, False).rows
    assert len(rows) == 1 and rows[0].partner_iso3 == "USA" and rows[0].value_usd == 12.0 and rows[0].net_weight_kg == 2.0

def test_an_unreported_value_stays_unreported_when_merged():
    data = [{"partnerCode": 842, "cmdCode": "010121", "primaryValue": None}, {"partnerCode": 840, "cmdCode": "010121", "primaryValue": None}]
    assert Comtrade._to_result(data, {}, 0, False).rows[0].value_usd is None
