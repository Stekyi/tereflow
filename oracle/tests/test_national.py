"""National-source-first policy and the HMRC provider.

HMRC parsing and paging run offline against a fake HTTP layer. The policy tests run on the real
Oracle database with a fake provider on a throw-away reporter, cleaned up afterwards."""
import pytest

from tereflow_oracle.classify import Availability as A
from tereflow_oracle.comtrade import FetchResult, Row
from tereflow_oracle.config import load_env
from tereflow_oracle.hmrc import Hmrc, HmrcError, cn8, partner_iso3, UNSPECIFIED, NES
from tereflow_oracle.ingest import Ingestor
from tereflow_oracle.national import NationalAvailability
from tests.test_oracle import Fake, rows6, q

load_env()
R = "KIR"


# ---------- HMRC: pure ----------------------------------------------------
def test_partner_codes():
    assert partner_iso3("FR") == "FRA" and partner_iso3("us") == "USA"
    assert partner_iso3("XS") == "SRB" and partner_iso3("DU") == "ARE"
    assert partner_iso3("QV") == NES and partner_iso3("") == NES and partner_iso3(None) == NES


def test_cn8_codes():
    assert cn8("01011010") == "01011010"          # leading zero survives
    assert cn8("01------") == UNSPECIFIED and cn8("25") == UNSPECIFIED and cn8(None) == UNSPECIFIED


class FakeHttp:
    """Serves HMRC's endpoints: two pages of aggregated rows, the lookup tables, and the count."""
    def __init__(self, rows, count=None, v_total=None):
        self.rows, self.count = rows, len(rows) if count is None else count
        self.v_total = sum(r["v"] for r in rows) if v_total is None else v_total
        self.calls = []

    def __call__(self, url, params=None):
        self.calls.append((url, params))
        if url.endswith("/Country"):
            return {"value": [{"CountryId": 1, "CountryCodeAlpha": "FR"}, {"CountryId": 2, "CountryCodeAlpha": "US"},
                              {"CountryId": 959, "CountryCodeAlpha": "QV"}]}
        if url.endswith("/Commodity"):
            return {"value": [{"CommodityId": 1011010, "Cn8Code": "01011010"}, {"CommodityId": 18010000, "Cn8Code": "18010000"},
                              {"CommodityId": 5, "Cn8Code": "05"}]}
        if "page2" in url:
            return {"value": self.rows[2:]}
        apply = (params or {}).get("$apply", "")
        if "$count as n" in apply:
            return {"value": [{"n": self.count}]}
        if "MonthId with max" in apply:
            return {"value": [{"v": self.v_total, "m": 202412}]}
        if "groupby" in apply:
            return {"value": self.rows[:2], "@odata.nextLink": "https://api.uktradeinfo.com/OTS?page2"}
        return {"value": [{"v": self.v_total}]}


ROWS = [
    {"CommodityId": 1011010, "CountryId": 1, "v": 100.0, "w": 10.0},
    {"CommodityId": 1011010, "CountryId": 2, "v": 50.0, "w": None},
    {"CommodityId": 18010000, "CountryId": 959, "v": 20.0, "w": None},
    {"CommodityId": -990, "CountryId": 1, "v": 5.0, "w": None},
    {"CommodityId": 5, "CountryId": 959, "v": 1.0, "w": None},
]


def test_hmrc_pages_converts_and_adds_world_rows():
    h = Hmrc(get=FakeHttp(ROWS), sleep=lambda s: None)
    res = h.fetch(2024, "X", 1.25)
    by = {(r.partner_iso3, r.cmd_code): r for r in res.rows}
    assert by[("FRA", "01011010")].value_usd == 125.0 and by[("FRA", "01011010")].net_weight_kg == 10.0
    assert by[("USA", "01011010")].net_weight_kg is None
    assert by[(NES, "18010000")].value_usd == 25.0
    assert by[("FRA", UNSPECIFIED)].value_usd == 6.25          # negative id
    assert by[(NES, UNSPECIFIED)].value_usd == 1.25            # chapter placeholder
    assert by[("WLD", "01011010")].value_usd == 187.5          # sum across partners
    partner_total = sum(r.value_usd for r in res.rows if r.partner_iso3 != "WLD")
    world_total = sum(r.value_usd for r in res.rows if r.partner_iso3 == "WLD")
    assert abs(partner_total - world_total) < 0.01 and abs(world_total - 176 * 1.25) < 0.01


def test_hmrc_refuses_a_partial_read():
    h = Hmrc(get=FakeHttp(ROWS, count=7), sleep=lambda s: None)
    with pytest.raises(HmrcError, match="partial year"):
        h.fetch(2024, "X", 1.0)


def test_hmrc_empty_year_is_not_available():
    h = Hmrc(get=FakeHttp([], count=0), sleep=lambda s: None)
    assert h.availability(2024, "X") is None


# ---------- policy against Oracle -----------------------------------------
class FakeProvider:
    iso3, key, currency, fx_bounds = R, "NATIONAL:FAKE", "GBP", (1.0, 1.7)

    def __init__(self, records=3, checksum="c1", local_total=80.0, error=None, none=False):
        self.records, self.checksum, self.local_total, self.error, self.none = records, checksum, local_total, error, none
        self.fetches = 0

    def availability(self, year, flow):
        return None if self.none else NationalAvailability(8, self.records, self.checksum, "m1")

    def total_local(self, year, flow):
        return self.local_total

    def fetch(self, year, flow, rate):
        self.fetches += 1
        if self.error:
            raise HmrcError(self.error)
        return FetchResult([Row("WLD", "09011100", None, 100.0 * rate / 1.25, 7.0, None, None),
                            Row("USA", "09011100", None, 60.0 * rate / 1.25, None, None, None)], 1)


@pytest.fixture
def conn():
    from tereflow_oracle import db
    c = db.connect()

    def wipe():
        cur = c.cursor()
        for t in ("tf_trade_facts", "tf_ingest_state", "tf_comtrade_availability", "tf_product_metrics", "tf_ingest_error"):
            cur.execute(f"DELETE FROM {t} WHERE reporter_iso3=:1", [R])
        cur.execute("DELETE FROM tf_fx_rate WHERE source='NATIONAL:FAKE'")
        c.commit()
    wipe(); yield c; wipe(); c.close()


def run(conn, prov, comtrade=None, **kw):
    return Ingestor(conn, comtrade or Fake(rows=rows6()), providers={R: prov} if prov else {}, **kw).run([R], [2023])


def levels(conn):
    return sorted(q(conn, "SELECT DISTINCT flow, classification_level FROM tf_trade_facts WHERE reporter_iso3=:1", R))


def test_comtrade_first_run_then_national_upgrades_to_hs8(conn):
    # No USD basis yet: Comtrade is used, which creates the basis.
    p = FakeProvider()
    run(conn, p)
    assert p.fetches == 0 and levels(conn) == [("M", "HS6"), ("X", "HS6")]
    # Second run: national source is read and replaces HS6 with HS8.
    s = run(conn, p)
    assert p.fetches == 2 and s.success == 2
    assert levels(conn) == [("M", "HS8"), ("X", "HS8")]
    rate = q(conn, "SELECT usd_per_unit FROM tf_fx_rate WHERE source='NATIONAL:FAKE' AND flow='X'")[0][0]
    assert float(rate) == pytest.approx(1.25)       # Comtrade WLD 100 / local 80
    src = q(conn, "SELECT classification_source FROM tf_ingest_state WHERE reporter_iso3=:1 AND flow='X'", R)
    assert src == [("NATIONAL:FAKE",)]
    # WLD reconciles with the Comtrade total it was converted against.
    assert q(conn, "SELECT value_usd FROM tf_trade_facts WHERE reporter_iso3=:1 AND flow='X' AND partner_iso3='WLD'", R) == [(100,)]


def test_national_rerun_skips_and_change_replaces(conn):
    p = FakeProvider()
    run(conn, p); run(conn, p)
    s = run(conn, p)
    assert s.skipped == 2 and p.fetches == 2
    p.checksum = "c2"
    s = run(conn, p)
    assert s.success == 2 and p.fetches == 4
    assert q(conn, "SELECT COUNT(*) FROM tf_trade_facts WHERE reporter_iso3=:1", R) == [(4,)]


def test_country_without_national_source_uses_comtrade(conn):
    run(conn, None)
    assert levels(conn) == [("M", "HS6"), ("X", "HS6")]


def test_unavailable_national_source_falls_back_to_comtrade(conn):
    run(conn, FakeProvider(none=True))
    assert levels(conn) == [("M", "HS6"), ("X", "HS6")]


def test_national_failure_never_downgrades_stored_hs8(conn):
    p = FakeProvider()
    run(conn, p); run(conn, p)
    assert levels(conn) == [("M", "HS8"), ("X", "HS8")]
    p.checksum, p.error = "c9", "HMRC unreachable"
    s = run(conn, p, force=True)
    assert s.failed == 2
    assert levels(conn) == [("M", "HS8"), ("X", "HS8")]
    assert q(conn, "SELECT status FROM tf_ingest_state WHERE reporter_iso3=:1 AND flow='X'", R) == [("SUCCESS",)]


def test_national_failure_on_first_load_falls_back(conn):
    run(conn, FakeProvider())                      # builds the Comtrade basis
    s = run(conn, FakeProvider(error="boom"))
    assert levels(conn) == [("M", "HS6"), ("X", "HS6")] and s.success == 2


def test_absurd_rate_is_refused(conn):
    run(conn, FakeProvider())
    conn.cursor().execute("DELETE FROM tf_fx_rate WHERE source='NATIONAL:FAKE'"); conn.commit()
    p = FakeProvider(local_total=1.0)              # implies a rate of 100
    run(conn, p)
    assert p.fetches == 0 and levels(conn) == [("M", "HS6"), ("X", "HS6")]
    assert q(conn, "SELECT COUNT(*) FROM tf_fx_rate WHERE source='NATIONAL:FAKE'") == [(0,)]


def test_dry_run_changes_nothing(conn):
    run(conn, FakeProvider())
    before = levels(conn)
    s = run(conn, FakeProvider(), dry_run=True)
    assert levels(conn) == before and len(s.planned) == 2
